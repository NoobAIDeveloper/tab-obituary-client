/**
 * Idempotent, resumable account-delete cascade.
 *
 * The user-facing "Delete my account" flow spans three independent surfaces:
 *
 *   1. `backend` — `POST /delete-account` (removes the server-side user
 *      record, email pointer, and bearer token)
 *   2. `local_storage` — wipe `clientToken` and the AES-GCM envelope key
 *      from `chrome.storage.local`
 *   3. `idb` — nuke every IDB store via `deleteEverythingIncludingSettings`
 *
 * MV3 service workers can be terminated at any moment (alarms, memory
 * pressure, browser shutdown). If that happens mid-cascade we must NOT
 * leave the user in a half-deleted state on next startup, and we must NOT
 * re-run steps that already succeeded (re-issuing `deleteAccount()` after
 * the token was cleared would 401, and re-wiping IDB after a fresh
 * install would be pointless but harmless).
 *
 * Progress is persisted under `__deleteCascade` in `chrome.storage.local`:
 *   - After each step succeeds we rewrite the record with that step
 *     appended to `completed`.
 *   - On transient failure we rewrite with `lastError` populated so the
 *     UI (and the next resume attempt) can report the last known state.
 *   - On final success we delete the record — no record means "nothing
 *     in flight."
 *
 * The caller owns the IDB handle. The cascade does not close it because
 * whether to reopen after the wipe is a UI concern.
 */

import type { IDBPDatabase } from 'idb';
import { deleteAccount } from '../backend/client.js';
import type { ApiError } from '../backend/client.js';
import {
  CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY,
  clearClientToken,
} from '../backend/token-store.js';
import type { TabObituaryDB } from './db.js';
import { hasChromeStorage } from '../lib/chrome-env.js';
import { sleepOrAbort } from '../lib/sleep.js';
import { deleteEverythingIncludingSettings } from './purge.js';

// ---------------------------------------------------------------------------
// Progress record
// ---------------------------------------------------------------------------

export type CascadeStep = 'backend' | 'local_storage' | 'idb';

export const DELETE_CASCADE_STEPS: readonly CascadeStep[] = [
  'backend',
  'local_storage',
  'idb',
] as const;

const PROGRESS_STORAGE_KEY = '__deleteCascade';

export interface CascadeProgress {
  startedAt: number;
  /** Ordered list of steps that have succeeded. */
  completed: readonly CascadeStep[];
  lastError?: { step: CascadeStep; error: string; at: number };
}

export type DeleteCascadeResult =
  | { status: 'completed' }
  | { status: 'failed'; step: CascadeStep; error: string };

// ---------------------------------------------------------------------------
// Chrome-storage helpers (forgiving in non-extension contexts)
// ---------------------------------------------------------------------------

async function loadProgress(): Promise<CascadeProgress | null> {
  if (!hasChromeStorage()) return null;
  try {
    const out = await chrome.storage.local.get(PROGRESS_STORAGE_KEY);
    const raw = out[PROGRESS_STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const startedAt = obj['startedAt'];
    const completed = obj['completed'];
    if (typeof startedAt !== 'number') return null;
    if (!Array.isArray(completed)) return null;
    const filtered: CascadeStep[] = [];
    for (const value of completed) {
      if (
        value === 'backend' ||
        value === 'local_storage' ||
        value === 'idb'
      ) {
        filtered.push(value);
      }
    }
    const progress: CascadeProgress = {
      startedAt,
      completed: filtered,
    };
    const lastErrorRaw = obj['lastError'];
    if (lastErrorRaw && typeof lastErrorRaw === 'object') {
      const le = lastErrorRaw as Record<string, unknown>;
      if (
        (le['step'] === 'backend' ||
          le['step'] === 'local_storage' ||
          le['step'] === 'idb') &&
        typeof le['error'] === 'string' &&
        typeof le['at'] === 'number'
      ) {
        progress.lastError = {
          step: le['step'],
          error: le['error'],
          at: le['at'],
        };
      }
    }
    return progress;
  } catch {
    return null;
  }
}

async function saveProgress(progress: CascadeProgress): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({ [PROGRESS_STORAGE_KEY]: progress });
  } catch {
    // Best-effort — a missed write just means we might re-run a step on
    // resume. All three steps are idempotent by design.
  }
}

async function clearProgress(): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.remove(PROGRESS_STORAGE_KEY);
  } catch {
    // Ignored — a stale record at worst causes a resume no-op next time.
  }
}

// ---------------------------------------------------------------------------
// Retry tuning
// ---------------------------------------------------------------------------

const BACKEND_RATE_LIMIT_MAX_ATTEMPTS = 3;
const BACKEND_SERVER_ERROR_MAX_ATTEMPTS = 2;
const BACKEND_SERVER_ERROR_BACKOFF_MS = 500;
const LOCAL_STORAGE_MAX_ATTEMPTS = 2;
const RATE_LIMIT_CAP_MS = 60_000;

// ---------------------------------------------------------------------------
// Step 1: backend delete
// ---------------------------------------------------------------------------

type StepOutcome =
  | { ok: true }
  | { ok: false; error: string; aborted?: boolean };

async function runBackendStep(
  signal: AbortSignal | undefined,
): Promise<StepOutcome> {
  let rateLimitAttempts = 0;
  let serverErrorAttempts = 0;

  // Bounded retry loop. Each class of error has its own budget; any
  // non-retryable response short-circuits.
  for (;;) {
    if (signal?.aborted) {
      return { ok: false, error: 'aborted', aborted: true };
    }

    const result = await deleteAccount(
      signal !== undefined ? { signal } : {},
    );

    if (result.ok) {
      // `deleted` and `already_deleted` both satisfy the invariant: the
      // server no longer has a record for this token. Done.
      return { ok: true };
    }

    const err: ApiError = result;

    if (err.status === 401) {
      // Either there's no token to send (`no_token`) or the server says
      // the token is invalid (`unauthorized`). Either way the server has
      // nothing to delete for us and local cleanup is still desired —
      // treat as step done.
      return { ok: true };
    }

    if (err.status === 0 && err.error === 'aborted') {
      return { ok: false, error: 'aborted', aborted: true };
    }

    if (err.status === 0 && err.error === 'network_error') {
      // Offline — user should retry when they're back online. Don't burn
      // the UX on exponential backoff inside the cascade.
      return { ok: false, error: 'network_error' };
    }

    if (err.status === 429) {
      rateLimitAttempts += 1;
      if (rateLimitAttempts >= BACKEND_RATE_LIMIT_MAX_ATTEMPTS) {
        return { ok: false, error: 'rate_limited' };
      }
      const seconds = err.retryAfter ?? 1;
      const waitMs = Math.min(seconds * 1000, RATE_LIMIT_CAP_MS);
      const aborted = await sleepOrAbort(waitMs, signal);
      if (aborted) return { ok: false, error: 'aborted', aborted: true };
      continue;
    }

    if (err.status >= 500 && err.status < 600) {
      serverErrorAttempts += 1;
      if (serverErrorAttempts >= BACKEND_SERVER_ERROR_MAX_ATTEMPTS) {
        return { ok: false, error: 'server_error' };
      }
      const aborted = await sleepOrAbort(
        BACKEND_SERVER_ERROR_BACKOFF_MS,
        signal,
      );
      if (aborted) return { ok: false, error: 'aborted', aborted: true };
      continue;
    }

    // Any other 4xx is a bug (bad request, conflict, etc.) — don't pretend
    // the step succeeded.
    return { ok: false, error: err.error };
  }
}

// ---------------------------------------------------------------------------
// Step 2: local storage wipe
// ---------------------------------------------------------------------------

async function runLocalStorageStep(): Promise<StepOutcome> {
  // `clearClientToken` is already best-effort. The only thing that can
  // actually throw here is `chrome.storage.local.remove` for the crypto
  // key. We try twice then give up and surface the error so the UI can
  // prompt the user to retry.
  await clearClientToken();

  if (!hasChromeStorage()) {
    // Preview / test contexts without a chrome stub — nothing to wipe.
    return { ok: true };
  }

  let attempt = 0;
  for (;;) {
    try {
      await chrome.storage.local.remove(CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY);
      return { ok: true };
    } catch (err) {
      attempt += 1;
      if (attempt >= LOCAL_STORAGE_MAX_ATTEMPTS) {
        const message =
          err instanceof Error ? err.message : 'local_storage_error';
        return { ok: false, error: message };
      }
      // Tiny synchronous-ish yield — we don't want to busy-loop but the
      // chrome.storage API is typically transient-fail and a single retry
      // clears most cases.
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: IDB wipe
// ---------------------------------------------------------------------------

async function runIdbStep(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<StepOutcome> {
  try {
    await deleteEverythingIncludingSettings(db);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'idb_error';
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildProgress(
  startedAt: number,
  completed: readonly CascadeStep[],
  lastError?: CascadeProgress['lastError'],
): CascadeProgress {
  // exactOptionalPropertyTypes: only include `lastError` when defined.
  return lastError === undefined
    ? { startedAt, completed }
    : { startedAt, completed, lastError };
}

function hasStep(
  completed: readonly CascadeStep[],
  step: CascadeStep,
): boolean {
  for (const c of completed) {
    if (c === step) return true;
  }
  return false;
}

/**
 * Start a new cascade or resume an in-progress one. Idempotent:
 *   - A completed cascade (3 steps done) resolves `{status:'completed'}`
 *     and clears the stale record.
 *   - A no-record start path runs all three steps fresh.
 *   - A partial record picks up where the previous run left off.
 *
 * Aborting via `options.signal` leaves the progress record intact so the
 * cascade can be resumed later; only the synchronous return value reports
 * the abort.
 */
export async function runDeleteCascade(
  db: IDBPDatabase<TabObituaryDB>,
  options: { signal?: AbortSignal } = {},
): Promise<DeleteCascadeResult> {
  const signal = options.signal;
  const existing = await loadProgress();
  const startedAt = existing?.startedAt ?? Date.now();
  let completed: readonly CascadeStep[] = existing?.completed ?? [];

  // Early exit: prior run completed all three steps but the clear record
  // write was lost (SW killed between the last step and the clear). Treat
  // as completed and clean up.
  if (completed.length >= DELETE_CASCADE_STEPS.length) {
    await clearProgress();
    return { status: 'completed' };
  }

  // ---- Step 1: backend ---------------------------------------------------
  if (!hasStep(completed, 'backend')) {
    const outcome = await runBackendStep(signal);
    if (!outcome.ok) {
      const now = Date.now();
      await saveProgress(
        buildProgress(startedAt, completed, {
          step: 'backend',
          error: outcome.error,
          at: now,
        }),
      );
      return { status: 'failed', step: 'backend', error: outcome.error };
    }
    completed = [...completed, 'backend'];
    await saveProgress(buildProgress(startedAt, completed));
  }

  // ---- Step 2: local_storage --------------------------------------------
  if (!hasStep(completed, 'local_storage')) {
    const outcome = await runLocalStorageStep();
    if (!outcome.ok) {
      const now = Date.now();
      await saveProgress(
        buildProgress(startedAt, completed, {
          step: 'local_storage',
          error: outcome.error,
          at: now,
        }),
      );
      return {
        status: 'failed',
        step: 'local_storage',
        error: outcome.error,
      };
    }
    completed = [...completed, 'local_storage'];
    await saveProgress(buildProgress(startedAt, completed));
  }

  // ---- Step 3: idb ------------------------------------------------------
  if (!hasStep(completed, 'idb')) {
    const outcome = await runIdbStep(db);
    if (!outcome.ok) {
      const now = Date.now();
      await saveProgress(
        buildProgress(startedAt, completed, {
          step: 'idb',
          error: outcome.error,
          at: now,
        }),
      );
      return { status: 'failed', step: 'idb', error: outcome.error };
    }
    completed = [...completed, 'idb'];
    // Note: do NOT persist the all-steps-done record — just drop it.
    // If we wrote it and then the `clearProgress` call crashed, the next
    // `runDeleteCascade` would hit the length-check above and still clean
    // up, so either order is safe.
  }

  await clearProgress();
  return { status: 'completed' };
}

/**
 * Called from the SW startup path. If a cascade is in progress, try to
 * finish it; otherwise no-op. Best-effort — this is a defense-in-depth
 * hook, not the primary resume trigger (the UI "try again" button is).
 *
 * The caller is the SW which does NOT have a DB handle to spare, so we
 * open our own and close it afterwards. If step 3 succeeded the handle
 * points to a wiped database — closing it is still valid.
 */
export async function resumeDeleteCascadeIfPending(): Promise<void> {
  try {
    const existing = await loadProgress();
    if (existing === null) return;
    if (existing.completed.length >= DELETE_CASCADE_STEPS.length) {
      // Defensive clean-up — something persisted the all-done record.
      await clearProgress();
      return;
    }
    // Lazy import to avoid pulling `openDb` into non-extension contexts
    // that call into this module's sibling exports via re-export.
    const { openDb } = await import('./db.js');
    const db = await openDb();
    try {
      await runDeleteCascade(db);
    } finally {
      try {
        db.close();
      } catch {
        // Already closed or torn down — ignore.
      }
    }
  } catch (err) {
    // Swallow: the user can retry from the options page.
    console.warn('[delete-cascade] resume failed', err);
  }
}

// ---------------------------------------------------------------------------
// Test helper — deliberately NOT re-exported from any barrel.
// ---------------------------------------------------------------------------

export async function __getCascadeProgressForTest(): Promise<CascadeProgress | null> {
  return loadProgress();
}

export async function __setCascadeProgressForTest(
  progress: CascadeProgress | null,
): Promise<void> {
  if (progress === null) {
    await clearProgress();
    return;
  }
  await saveProgress(progress);
}

export const __DELETE_CASCADE_PROGRESS_KEY_FOR_TEST = PROGRESS_STORAGE_KEY;
