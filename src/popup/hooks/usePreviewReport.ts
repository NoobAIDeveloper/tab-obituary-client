/**
 * Drive the onboarding preview report: history → pipeline → /generate-report → iframe HTML.
 *
 * ## State machine
 *
 *   idle ──start()──▶ loading(history) ──▶ loading(network) ──▶ ready
 *                                                          └──▶ error
 *   error ──start()──▶ loading(history) …
 *   (any) ──cancel()──▶ idle     (aborts fetch + pipeline awaits)
 *   unmount           ──▶ cancel()
 *
 * We deliberately keep auto-start OUT of the hook — the route decides when to
 * call `start()`. This keeps the hook trivially unit-testable (no "was it
 * mounted yet?" plumbing in the test).
 *
 * ## Auth
 *
 * Preview is meant for freshly-subscribed users who already have a
 * `clientToken`. We attempt `{authenticated: true}` when a token exists so
 * the server can choose cloud vs. deterministic based on `cloudAiOptIn`. If
 * no token is present (anomalous — user skipped subscribe somehow), we fall
 * back to `{authenticated: false}`, which forces the server into anonymous
 * deterministic mode and is rate-limited per-IP.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  type ApiErrorCode,
  generateReport,
  getClientToken,
} from '../../backend/index.js';
import { openDb } from '../../storage/db.js';
import { getBlocklistedDomains } from '../../storage/settings-store.js';
import { buildPreviewPayload } from '../../preview/build-preview-payload.js';
import { useSettings } from './useSettings.js';

export type PreviewLoadingPhase = 'history' | 'network';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; phase: PreviewLoadingPhase }
  | { status: 'ready'; html: string; text: string; subject: string }
  | { status: 'error'; code: ApiErrorCode | 'settings_missing'; retryAfter?: number };

export interface UsePreviewReportResult {
  state: PreviewState;
  start: () => void;
  cancel: () => void;
}

export function usePreviewReport(): UsePreviewReportResult {
  const settings = useSettings();
  const [state, setState] = useState<PreviewState>({ status: 'idle' });

  // Track the in-flight controller so unmount or cancel() can abort it.
  const abortRef = useRef<AbortController | null>(null);
  // Guard against setState after unmount — the hook owns a couple of awaits.
  const mountedRef = useRef(true);
  // If the consumer calls start() before settings.user has loaded, we
  // latch `pendingStart` and kick off the run as soon as settings arrive.
  // Without this, callers have to coordinate with settings.loading themselves.
  const pendingStartRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Keep a live ref to settings.user so the callback below can read the
  // freshest values without being re-created each render.
  const userRef = useRef(settings.user);
  userRef.current = settings.user;

  const kickoff = useCallback((): void => {
    const user = userRef.current;
    if (!user) return;

    // Abort any previous attempt before starting a new one. Replaces
    // whatever state was previously set.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState({ status: 'loading', phase: 'history' });

    void runPreview(
      {
        uuid: user.uuid,
        timezone: user.timezone,
        // Plan is 'free' for day-zero users. UserSettings already defaults to
        // 'free', so fall back defensively for anyone whose record is pre-migration.
        plan: user.plan ?? 'free',
        signal: ctrl.signal,
      },
      (next) => {
        if (ctrl.signal.aborted) return;
        if (!mountedRef.current) return;
        setState(next);
      },
    );
  }, []);

  const start = useCallback((): void => {
    if (userRef.current) {
      pendingStartRef.current = false;
      kickoff();
      return;
    }
    // Settings not loaded yet — latch and let the effect below fire when
    // the user row materialises. Show a loading state so the route doesn't
    // flash an "error" badge while we wait on IDB.
    pendingStartRef.current = true;
    setState({ status: 'loading', phase: 'history' });
  }, [kickoff]);

  // Drain the pending-start latch as soon as settings.user is available.
  // Re-running this effect on every settings.user identity change is cheap
  // because we gate on `pendingStartRef.current` — which `start()` flips off
  // after the first successful kickoff.
  useEffect(() => {
    if (!pendingStartRef.current) return;
    if (!settings.user) return;
    pendingStartRef.current = false;
    kickoff();
  }, [settings.user, kickoff]);

  const cancel = useCallback((): void => {
    pendingStartRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    if (mountedRef.current) {
      setState({ status: 'idle' });
    }
  }, []);

  return { state, start, cancel };
}

// ---------------------------------------------------------------------------
// Internals — pulled out so the hook body stays about wiring, not business.

interface RunInput {
  uuid: string;
  timezone: string;
  plan: import('@tabob/shared').Plan;
  signal: AbortSignal;
}

async function runPreview(
  input: RunInput,
  emit: (next: PreviewState) => void,
): Promise<void> {
  // Step 1 — gather blocklist + run pipeline.
  let blocklist: Set<string>;
  try {
    const db = await openDb();
    if (input.signal.aborted) return;
    blocklist = await getBlocklistedDomains(db);
  } catch {
    // If IDB is unavailable we still attempt the preview with no blocklist.
    blocklist = new Set();
  }
  if (input.signal.aborted) return;

  let payload;
  try {
    payload = await buildPreviewPayload({
      uuid: input.uuid,
      timezone: input.timezone,
      plan: input.plan,
      blocklist,
      signal: input.signal,
    });
  } catch (err) {
    if (isAbortError(err)) return;
    // The pipeline doesn't raise user-facing errors; if something inside
    // did (e.g. IDB/crypto in a synth path), surface as an 'unknown' error.
    emit({ status: 'error', code: 'unknown' });
    return;
  }
  if (input.signal.aborted) return;

  // Step 2 — network.
  emit({ status: 'loading', phase: 'network' });

  // Decide auth mode: prefer authenticated when a token exists. A missing
  // token should NOT short-circuit the preview — fall back to anonymous
  // deterministic mode (server requires `payload.preview: true`, which we set).
  const token = await getClientToken();
  if (input.signal.aborted) return;
  const authenticated = token !== null && token.length > 0;

  const result = await generateReport(payload, {
    authenticated,
    signal: input.signal,
  });

  if (input.signal.aborted) return;

  if (result.ok) {
    emit({
      status: 'ready',
      html: result.data.emailHtml,
      text: result.data.emailText,
      subject: result.data.sections.subject,
    });
    return;
  }

  // Error mapping. `aborted` stays silent — the caller moved on.
  if (result.error === 'aborted') return;

  const errState: PreviewState = { status: 'error', code: result.error };
  if (result.retryAfter !== undefined) errState.retryAfter = result.retryAfter;
  emit(errState);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}
