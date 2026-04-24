/**
 * Typed HTTP client for the Tab Obituary Cloudflare Worker backend.
 *
 * ## Shape
 *
 * Every method returns `ApiResult<T>`, a discriminated union of `{ok:true,
 * data:T}` | `{ok:false, status, error, retryAfter?}`. We chose this over
 * typed error classes because:
 *   - consumers always need to branch on success vs. error anyway;
 *   - `instanceof` plumbing is awkward across bundler boundaries;
 *   - the popup/options UIs will map error codes to user-facing copy via a
 *     simple switch, which reads cleaner off a tagged union.
 *
 * Response bodies are validated with zod at the boundary (`.safeParse`):
 * the backend and extension drift independently and an invalid response is
 * a much more useful signal than a `TypeError: cannot read property` three
 * frames deep inside a UI component.
 *
 * ## Auth
 *
 * The `clientToken` is minted by `POST /subscribe`, persisted in
 * `chrome.storage.local` via `token-store.ts`, and attached as
 * `Authorization: Bearer <token>` on authenticated calls. Unauthenticated
 * calls made through an authed method (no token stored) return
 * `ok:false, status:401, error:'no_token'` WITHOUT hitting the network —
 * the server is authoritative for "is this token valid" but it is not
 * authoritative for "do I have any token at all".
 *
 * We do NOT auto-clear the token on a 401 response. KV replication can
 * produce ~60s of stale reads post-rotation, and auto-wipe would force an
 * unnecessary re-auth. The caller decides the policy (e.g. prompt on
 * repeated 401s).
 *
 * ## Retry
 *
 * 5xx gets exactly one automatic retry with ~500ms backoff. One retry is
 * enough to mask an isolated transient and cheap enough that it doesn't
 * hide a real outage. Network errors (status 0) are NOT retried — offline
 * is a user-visible state and the UI handles it explicitly.
 *
 * 4xx (including 429) is never retried. 429 surfaces the `Retry-After`
 * header to the caller so a cool-down UI can be rendered.
 *
 * ## Cancellation
 *
 * Each method accepts `{signal?: AbortSignal}`. We wire it straight through
 * to `fetch`. An aborted request resolves as `{ok:false, status:0,
 * error:'aborted'}` so consumers can distinguish "user navigated away" from
 * "network dead."
 *
 * ## Observability
 *
 * Every fetch attempt (including each leg of a 5xx retry) is logged to the
 * `outbound_requests` IDB store via `lib/outbound-logger.ts`. The export
 * bundle surfaces these rows so users can audit every backend call the
 * extension has made. The logger stores metadata only — method, pathname,
 * status, duration, error code, a SHA-256 hash of the request body — never
 * the body, the response, the token, or query strings. The logger is
 * best-effort and its failures never affect the primary fetch result.
 */

import {
  type ReportPayload,
  type ReportResponse,
  reportResponseSchema,
} from '@tabob/shared';
import { z } from 'zod';
import { recordOutboundCall } from '../lib/outbound-logger.js';
import { sleepOrAbort } from '../lib/sleep.js';
import { getBackendBaseUrl } from './config.js';
import { getClientToken } from './token-store.js';

// ---------------------------------------------------------------------------
// Public result / error types
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'unauthorized'
  | 'no_token'
  | 'rate_limited'
  | 'bad_request'
  | 'conflict'
  | 'server_error'
  | 'network_error'
  | 'aborted'
  | 'invalid_response'
  | 'email_send_failed'
  | 'unknown';

export interface ApiError {
  ok: false;
  /** HTTP status, or 0 for network/abort. */
  status: number;
  error: ApiErrorCode;
  /** For 429: seconds until the caller may retry (from `Retry-After`). */
  retryAfter?: number;
  /** Optional server-provided machine-readable reason (e.g. 'invalid_json'). */
  reason?: string;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export type ApiResult<T> = ApiOk<T> | ApiError;

export interface CallOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------
//
// Hand-written to match the handlers under `packages/backend/src/routes/`.
// We deliberately do NOT import from `packages/backend/*` — the backend is
// a black-box HTTP API to this module — so any drift between the two is
// caught by the zod parse at the boundary.

const subscribeAlreadySchema = z.object({
  status: z.literal('already_subscribed'),
  uuid: z.string(),
});

const subscribeLinkResentSchema = z.object({
  status: z.literal('link_resent'),
  uuid: z.string(),
  clientToken: z.string(),
});

const subscribeFreshSchema = z.object({
  status: z.literal('subscribed'),
  uuid: z.string(),
  clientToken: z.string(),
});

const subscribeSuccessSchema = z.union([
  subscribeAlreadySchema,
  subscribeLinkResentSchema,
  subscribeFreshSchema,
]);

export type SubscribeResult = z.infer<typeof subscribeSuccessSchema>;

const unsubscribeResultSchema = z.object({
  status: z.literal('unsubscribed'),
});
export type UnsubscribeResult = z.infer<typeof unsubscribeResultSchema>;

const deleteAccountResultSchema = z.object({
  status: z.union([z.literal('deleted'), z.literal('already_deleted')]),
});
export type DeleteAccountResult = z.infer<typeof deleteAccountResultSchema>;

// `/export` returns an opaque-ish user blob plus metadata. The shape is
// authoritative on the server and likely to grow; we pass it through
// loosely here (object + schemaVersion) rather than tying the client to
// every UserRecord field. We codify only the one field consumers actually
// read (`emailConfirmed`) and `passthrough` the rest so backend drift in
// other fields doesn't break the parse.
const exportResultSchema = z
  .object({
    schemaVersion: z.number().int(),
    exportedAt: z.number().int(),
    user: z.object({ emailConfirmed: z.boolean() }).passthrough(),
  })
  .passthrough();
export type ExportResult = z.infer<typeof exportResultSchema>;

const settingsOkSchema = z.object({
  status: z.literal('ok'),
  emailChangePending: z.boolean().optional(),
  emailSendFailed: z.boolean().optional(),
});
export type SettingsResult = z.infer<typeof settingsOkSchema>;

export interface SettingsPatch {
  email?: string;
  cloudAiOptIn?: boolean;
  timezone?: string;
}

export interface GenerateReportOptions extends CallOptions {
  /**
   * `true` → attach Bearer token (authenticated call, 10/hour per token).
   * `false` → no Authorization header (anonymous preview, 3/hour per IP).
   *
   * The caller is responsible for setting `payload.preview` consistently.
   * Anonymous callers who forget `payload.preview: true` will get a 401
   * from the server — we do NOT patch the payload here.
   */
  authenticated: boolean;
}

// ---------------------------------------------------------------------------
// Internal: one HTTP call with parse + error mapping
// ---------------------------------------------------------------------------

interface RequestSpec<T> {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** If true, attach the Bearer token; 401 without a token short-circuits. */
  authenticated: boolean;
  /**
   * If true and `authenticated` is true, a missing token returns 401
   * (no_token) synthetically. If false, the call proceeds without auth.
   * Separate knob from `authenticated` so `/generate-report` can opt to
   * send unauthenticated even though the route technically accepts auth.
   */
  schema: z.ZodType<T>;
  signal?: AbortSignal | undefined;
}

const SERVER_ERROR_RETRY_DELAY_MS = 500;

async function doFetch<T>(spec: RequestSpec<T>): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let authHeaderAttached = false;
  if (spec.authenticated) {
    const token = await getClientToken();
    if (token === null || token.length === 0) {
      return {
        ok: false,
        status: 401,
        error: 'no_token',
      };
    }
    headers['Authorization'] = `Bearer ${token}`;
    authHeaderAttached = true;
  }

  const url = `${getBackendBaseUrl()}${spec.path}`;
  const init: RequestInit = {
    method: spec.method,
    headers,
  };
  if (spec.body !== undefined) {
    init.body = JSON.stringify(spec.body);
  }
  if (spec.signal !== undefined) {
    init.signal = spec.signal;
  }

  const firstAttempt = await singleFetch(url, init, spec.schema, {
    method: spec.method,
    path: spec.path,
    authenticated: authHeaderAttached,
    body: spec.body,
  });
  if (firstAttempt.ok) return firstAttempt;

  // Retry exactly once on 5xx. Abort and network errors do NOT retry —
  // they reflect user/device state, not transient server load.
  const shouldRetry = firstAttempt.status >= 500 && firstAttempt.status < 600;
  if (!shouldRetry) return firstAttempt;

  // Short sleep respectful of the caller's abort signal.
  const aborted = await sleepOrAbort(SERVER_ERROR_RETRY_DELAY_MS, spec.signal);
  if (aborted) {
    return { ok: false, status: 0, error: 'aborted' };
  }

  return singleFetch(url, init, spec.schema, {
    method: spec.method,
    path: spec.path,
    authenticated: authHeaderAttached,
    body: spec.body,
  });
}

interface SingleFetchMeta {
  method: 'GET' | 'POST';
  path: string;
  authenticated: boolean;
  body: unknown | undefined;
}

async function singleFetch<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  meta: SingleFetchMeta,
): Promise<ApiResult<T>> {
  const startTs = Date.now();
  const inner = await singleFetchInner(url, init, schema);
  // `endTs` is undefined only when no response was ever received (network or
  // abort, signalled by inner.receivedResponse === false).
  const endTs = inner.receivedResponse ? Date.now() : undefined;

  const loggedStatus = inner.httpStatus;
  const loggedErrorCode = inner.result.ok ? undefined : inner.result.error;

  // Fire-and-forget the log write. Awaiting would both (a) delay the fetch
  // caller for an IDB roundtrip that doesn't affect their result, and
  // (b) couple primary fetch latency to IDB availability. Belt-and-braces
  // try/catch on top of the logger's own swallow: the logger must NEVER
  // affect the primary fetch result.
  try {
    void recordOutboundCall({
      method: meta.method,
      path: meta.path,
      authenticated: meta.authenticated,
      requestBody: meta.body,
      startTs,
      endTs,
      status: loggedStatus,
      errorCode: loggedErrorCode,
    }).catch(() => {
      // Swallow — logger already swallows internally, this is defense in depth.
    });
  } catch {
    // Ignore — primary result must still return.
  }

  return inner.result;
}

interface SingleFetchInner<T> {
  result: ApiResult<T>;
  /** HTTP status actually received from the server; 0 when no response. */
  httpStatus: number;
  /** False on network error / abort; true once `fetch` resolved. */
  receivedResponse: boolean;
}

async function singleFetchInner<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<SingleFetchInner<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (isAbortError(err)) {
      return {
        result: { ok: false, status: 0, error: 'aborted' },
        httpStatus: 0,
        receivedResponse: false,
      };
    }
    return {
      result: { ok: false, status: 0, error: 'network_error' },
      httpStatus: 0,
      receivedResponse: false,
    };
  }

  const status = response.status;

  if (status === 401) {
    const reason = await readReasonOrError(response);
    const result: ApiError = { ok: false, status: 401, error: 'unauthorized' };
    if (reason !== undefined) result.reason = reason;
    return { result, httpStatus: status, receivedResponse: true };
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
    const result: ApiError = { ok: false, status: 429, error: 'rate_limited' };
    if (retryAfter !== undefined) result.retryAfter = retryAfter;
    return { result, httpStatus: status, receivedResponse: true };
  }

  if (status === 409) {
    const reason = await readReasonOrError(response);
    const result: ApiError = { ok: false, status: 409, error: 'conflict' };
    if (reason !== undefined) result.reason = reason;
    return { result, httpStatus: status, receivedResponse: true };
  }

  if (status === 400) {
    const reason = await readReasonOrError(response);
    const result: ApiError = { ok: false, status: 400, error: 'bad_request' };
    if (reason !== undefined) result.reason = reason;
    return { result, httpStatus: status, receivedResponse: true };
  }

  if (status === 502) {
    // `/subscribe` uses 502 for `email_send_failed`. Surface as a distinct
    // code so the onboarding UI can render a "we couldn't send your
    // email, try again" branch without a generic 5xx retry spinner.
    const errorField = await readReasonOrError(response);
    if (errorField === 'email_send_failed') {
      return {
        result: { ok: false, status: 502, error: 'email_send_failed' },
        httpStatus: status,
        receivedResponse: true,
      };
    }
    return {
      result: { ok: false, status, error: 'server_error' },
      httpStatus: status,
      receivedResponse: true,
    };
  }

  if (status >= 500) {
    return {
      result: { ok: false, status, error: 'server_error' },
      httpStatus: status,
      receivedResponse: true,
    };
  }

  if (status >= 400) {
    const reason = await readReasonOrError(response);
    const result: ApiError = { ok: false, status, error: 'unknown' };
    if (reason !== undefined) result.reason = reason;
    return { result, httpStatus: status, receivedResponse: true };
  }

  // 2xx path: parse JSON and validate.
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      result: { ok: false, status, error: 'invalid_response' },
      httpStatus: status,
      receivedResponse: true,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: { ok: false, status, error: 'invalid_response' },
      httpStatus: status,
      receivedResponse: true,
    };
  }
  return {
    result: { ok: true, data: parsed.data },
    httpStatus: status,
    receivedResponse: true,
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  // RFC 7231 allows either delta-seconds OR an HTTP-date. The Worker only
  // emits delta-seconds; we still guard against a date string by parsing
  // as Date and computing the remainder.
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && String(asInt) === trimmed && asInt >= 0) {
    return asInt;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = Math.ceil((asDate - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

async function readReasonOrError(res: Response): Promise<string | undefined> {
  // Best-effort read: error bodies may not be JSON, may be empty, or may
  // be consumed already. Any failure collapses to `undefined`.
  //
  // The backend uses `reason` on well-typed validation failures (`/subscribe`,
  // `/generate-report`) and `error` on coarser outcomes (`email_send_failed`
  // at 502). Falling back from `reason` → `error` covers both shapes from a
  // single call site; no 502 body currently carries an unrelated `reason`
  // field that would shadow the `error` marker.
  try {
    const cloned = res.clone();
    const text = await cloned.text();
    if (text === '') return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const reason = obj['reason'];
      if (typeof reason === 'string') return reason;
      const err = obj['error'];
      if (typeof err === 'string') return err;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * POST /subscribe — first-touch onboarding.
 *
 * Unauthenticated; rate-limited to 10/hour per IP. Returns a discriminated
 * body describing whether the user is new (`subscribed`, 201), an
 * unconfirmed existing user who got a re-sent magic link (`link_resent`,
 * 200, includes `clientToken`), or a fully-active user (`already_subscribed`,
 * 200, NO `clientToken`). The caller (9.2 onboarding) is responsible for
 * persisting `clientToken` via `setClientToken` when present.
 */
export function subscribe(
  email: string,
  options: CallOptions = {},
): Promise<ApiResult<SubscribeResult>> {
  return doFetch({
    method: 'POST',
    path: '/subscribe',
    body: { email },
    authenticated: false,
    schema: subscribeSuccessSchema,
    signal: options.signal,
  });
}

/**
 * POST /unsubscribe — authed. Flips `user.unsubscribed = true`. Idempotent.
 */
export function unsubscribe(
  options: CallOptions = {},
): Promise<ApiResult<UnsubscribeResult>> {
  return doFetch({
    method: 'POST',
    path: '/unsubscribe',
    authenticated: true,
    schema: unsubscribeResultSchema,
    signal: options.signal,
  });
}

/**
 * POST /delete-account — authed. Hard-deletes the server-side user record.
 * The caller should clear local state (IDB, clientToken) after a successful
 * response.
 */
export function deleteAccount(
  options: CallOptions = {},
): Promise<ApiResult<DeleteAccountResult>> {
  return doFetch({
    method: 'POST',
    path: '/delete-account',
    authenticated: true,
    schema: deleteAccountResultSchema,
    signal: options.signal,
  });
}

/**
 * GET /export — authed. Returns the backend's slice of the user bundle.
 * The extension's full export is assembled client-side from IDB; this is
 * the server-held complement.
 */
export function exportAccount(
  options: CallOptions = {},
): Promise<ApiResult<ExportResult>> {
  return doFetch({
    method: 'GET',
    path: '/export',
    authenticated: true,
    schema: exportResultSchema,
    signal: options.signal,
  });
}

/**
 * POST /settings — authed. Patch-style update. The backend rejects an
 * empty patch with 400, so we refuse empty patches on the client too —
 * a dev-time guard against accidentally calling `updateSettings({})`.
 */
export function updateSettings(
  patch: SettingsPatch,
  options: CallOptions = {},
): Promise<ApiResult<SettingsResult>> {
  const body: Record<string, string | boolean> = {};
  if (patch.email !== undefined) body['email'] = patch.email;
  if (patch.cloudAiOptIn !== undefined) body['cloudAiOptIn'] = patch.cloudAiOptIn;
  if (patch.timezone !== undefined) body['timezone'] = patch.timezone;

  if (Object.keys(body).length === 0) {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: 'bad_request',
      reason: 'empty_patch',
    });
  }

  return doFetch({
    method: 'POST',
    path: '/settings',
    body,
    authenticated: true,
    schema: settingsOkSchema,
    signal: options.signal,
  });
}

/**
 * POST /generate-report — dual modality.
 *
 * - `authenticated: true` → Bearer token attached, 10/hour per token.
 *   Branches server-side on `user.cloudAiOptIn`.
 * - `authenticated: false` → no Authorization header, 3/hour per IP.
 *   Always runs the deterministic pipeline on the server. The payload
 *   MUST have `preview: true` or the server returns 401.
 *
 * The `preview` field on the payload is separate from `authenticated` and
 * the client does not sync them for you — the popup preview path sends
 * both (unauth + preview:true), the weekly-alarm path sends neither.
 */
export function generateReport(
  payload: ReportPayload,
  options: GenerateReportOptions,
): Promise<ApiResult<ReportResponse>> {
  return doFetch({
    method: 'POST',
    path: '/generate-report',
    body: payload,
    authenticated: options.authenticated,
    schema: reportResponseSchema,
    signal: options.signal,
  });
}
