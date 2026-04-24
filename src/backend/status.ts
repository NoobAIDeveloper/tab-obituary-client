/**
 * Email-confirmation reconciliation helper.
 *
 * The extension learns that the user clicked the magic link via `GET /export`:
 * that's the only authed route that returns the full user record today, and
 * the record carries `emailConfirmed: boolean`. We avoid polling — the popup
 * calls `fetchEmailConfirmationStatus()` once on mount (and again on a user-
 * driven "I confirmed" click), and flips local IDB state if the server says
 * confirmation has happened.
 *
 * Shape: we return a small discriminated result (`{confirmed}` vs `{error}`)
 * rather than a full `ApiResult` because callers here don't care about retry
 * metadata — they care "did it flip yet, or do I show the user an error?".
 * `no_token` is surfaced so the caller can distinguish "user hasn't subscribed
 * yet, don't show the banner" from real network failure.
 */

import { exportAccount, type CallOptions } from './client.js';

export interface EmailConfirmationStatus {
  loading: boolean;
  confirmed: boolean;
  error?: string;
}

export type EmailConfirmationResult =
  | { confirmed: boolean }
  | { error: string };

/**
 * Reads the user's `emailConfirmed` flag from the backend via `/export`.
 *
 * Returns `{confirmed: boolean}` on success, `{error: <ApiErrorCode>}` on
 * any failure (including `no_token`). The caller is responsible for
 * interpreting `no_token` — typically: "user hasn't subscribed yet; don't
 * render the confirmation UI".
 */
export async function fetchEmailConfirmationStatus(
  options: CallOptions = {},
): Promise<EmailConfirmationResult> {
  const result = await exportAccount(options);
  if (!result.ok) {
    return { error: result.error };
  }

  // `/export` returns `{schemaVersion, exportedAt, user}`. `exportResultSchema`
  // in `client.ts` codifies `user.emailConfirmed: boolean` (with passthrough
  // on everything else), so the zod parse already rejected bodies without a
  // valid boolean — we can read it directly without a manual re-narrow.
  return { confirmed: result.data.user.emailConfirmed };
}
