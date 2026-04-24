/**
 * Reconciles local `UserSettings.emailConfirmed` with the server's view.
 *
 * The confirmation link in the magic-link email is followed in a DIFFERENT
 * tab (the Worker renders an HTML confirmation page on `/confirm-email?t=...`).
 * When the user returns to the popup, we need to notice the flip without
 * polling. Strategy:
 *
 *   - On mount: if local says `emailConfirmed: true`, trust it — no network.
 *   - On mount: if local says `false` AND we have a clientToken, hit
 *     `/export` once to see whether the server has flipped the flag.
 *   - If the server says yes, persist locally via `updateUser({emailConfirmed:
 *     true})`. The component tree re-renders through `useSettings` and the
 *     banner disappears.
 *   - `refresh()` lets the UI retry on demand ("I confirmed" button).
 *
 * No polling loop. One check per popup mount + user-driven retries is enough
 * to handle the common case where the user confirms in another tab then
 * clicks back to the popup. Polling would burn quota and battery.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import {
  fetchEmailConfirmationStatus,
  getClientToken,
} from '../../backend/index.js';
import { useSettings } from './useSettings.js';

export type EmailConfirmationUiStatus =
  | 'idle'
  | 'checking'
  | 'confirmed'
  | 'unconfirmed'
  | 'error';

export interface UseEmailConfirmationResult {
  status: EmailConfirmationUiStatus;
  errorCode?: string;
  refresh: () => Promise<void>;
  /**
   * Local email + emailConfirmed flag as observed through this hook's
   * own `useSettings` instance. Exposed so co-located UI (the
   * `ConfirmationBanner`) doesn't need a second `useSettings` call —
   * a second instance would have its own in-memory mirror and would not
   * observe the `emailConfirmed:true` flip this hook performs after the
   * server confirms. Reading through the same hook instance closes that
   * gap.
   */
  user: { email: string | undefined; emailConfirmed: boolean | undefined };
  loading: boolean;
}

export function useEmailConfirmation(): UseEmailConfirmationResult {
  const settings = useSettings();
  const locallyConfirmed = settings.user?.emailConfirmed === true;

  const [status, setStatus] = useState<EmailConfirmationUiStatus>('idle');
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

  // Track the active abort controller so unmount or a fresh refresh call
  // cancels any in-flight network request. AbortController is cheap; we
  // replace it per check instead of reusing.
  const abortRef = useRef<AbortController | null>(null);

  // Keep a ref to `updateUser` so the `check` callback below can remain stable
  // and we don't spin up a new effect on every `useSettings` memo rebuild.
  const updateUserRef = useRef(settings.updateUser);
  updateUserRef.current = settings.updateUser;

  const check = useCallback(async (): Promise<void> => {
    // Gate on token presence — without it, `/export` would just return
    // `no_token` synthetically. Short-circuit to avoid surfacing a confusing
    // error to a user who simply hasn't subscribed yet.
    const token = await getClientToken();
    if (token === null) {
      setStatus('idle');
      setErrorCode(undefined);
      return;
    }

    // Cancel any previous in-flight check before starting a new one.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus('checking');
    setErrorCode(undefined);

    const result = await fetchEmailConfirmationStatus({ signal: ctrl.signal });
    if (ctrl.signal.aborted) return;

    if ('error' in result) {
      // `no_token` means the user hasn't subscribed — leave UI idle rather
      // than showing an error banner. Any other error surfaces as 'error'.
      if (result.error === 'no_token' || result.error === 'aborted') {
        setStatus('idle');
        setErrorCode(undefined);
        return;
      }
      setStatus('error');
      setErrorCode(result.error);
      return;
    }

    if (result.confirmed) {
      // Flip local truth so subsequent popup opens skip the network call.
      // If this write fails we still surface the UI state as confirmed —
      // the server is source of truth and the local write will retry on
      // next mount.
      try {
        await updateUserRef.current({ emailConfirmed: true });
      } catch {
        // best-effort: UI still reflects server truth for this session.
      }
      setStatus('confirmed');
      return;
    }

    setStatus('unconfirmed');
  }, []);

  // Mount effect: if local already says confirmed, short-circuit. Otherwise
  // fire one check. We depend on `locallyConfirmed` so a local flip (done by
  // this same hook) settles into the 'confirmed' branch without re-fetching.
  useEffect(() => {
    if (settings.loading) return;

    if (locallyConfirmed) {
      setStatus('confirmed');
      setErrorCode(undefined);
      return;
    }

    void check();
    return () => {
      abortRef.current?.abort();
    };
    // `check` is stable (empty deps). Re-run when loading flips to false or
    // local confirmation flag changes.
  }, [settings.loading, locallyConfirmed, check]);

  const refresh = useCallback(async (): Promise<void> => {
    await check();
  }, [check]);

  const result: UseEmailConfirmationResult = {
    status,
    refresh,
    user: {
      email: settings.user?.email,
      emailConfirmed: settings.user?.emailConfirmed,
    },
    loading: settings.loading,
  };
  if (errorCode !== undefined) result.errorCode = errorCode;
  return result;
}
