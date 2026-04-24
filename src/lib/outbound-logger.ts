/**
 * Outbound-request logger.
 *
 * Records one metadata row per backend HTTP call into IDB so the client-side
 * export bundle can surface every network call the extension has ever made.
 *
 * Privacy policy (enforced at the call site in `backend/client.ts`):
 *   - Never logs request or response bodies.
 *   - Never logs the bearer token, or even the hash of it.
 *   - Never logs query-string contents — only the URL pathname is stored.
 *   - Request bodies are SHA-256 hashed (not stored) so duplicate/replay
 *     detection is possible without retaining payload content.
 *
 * The logger is best-effort: every failure path (IDB open, IDB add, crypto
 * unavailable, digest failure) is swallowed and must never affect the primary
 * fetch result. Callers in `client.ts` also wrap the call in a belt-and-
 * braces try/catch as defense in depth.
 */

import type { IDBPDatabase } from 'idb';
import { type TabObituaryDB, openDb } from '../storage/db.js';
import { logOutboundRequest } from '../storage/outbound-requests-store.js';

let cachedDbPromise: Promise<IDBPDatabase<TabObituaryDB>> | null = null;

/**
 * Tracks the most-recent in-flight `recordOutboundCall` so callers can flush
 * pending writes for deterministic assertions. Updated on every call. Only
 * used by the test-only `__flushOutboundLoggerWritesForTest` helper; no
 * production code path reads this.
 */
let lastInFlight: Promise<void> = Promise.resolve();

async function getDb(): Promise<IDBPDatabase<TabObituaryDB> | null> {
  if (cachedDbPromise === null) {
    cachedDbPromise = openDb();
  }
  try {
    return await cachedDbPromise;
  } catch {
    // Reset so a future call may retry (e.g. after a transient upgrade
    // blocker clears). Return null so the logger silently no-ops.
    cachedDbPromise = null;
    return null;
  }
}

/**
 * Hex-encode a byte array in lowercase.
 */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * SHA-256 of the JSON-stringified body, lowercase hex.
 * Returns the literal string `'hash_unavailable'` if crypto.subtle is absent
 * or the digest throws — distinct from `null` (which means "no body"), so
 * export consumers can tell "we had a body but couldn't hash it" from "GET".
 */
async function hashBody(body: unknown): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) return 'hash_unavailable';
    const serialized = JSON.stringify(body);
    const encoded = new TextEncoder().encode(serialized);
    const digest = await subtle.digest('SHA-256', encoded);
    return toHex(new Uint8Array(digest));
  } catch {
    return 'hash_unavailable';
  }
}

export interface RecordOutboundCallArgs {
  method: 'GET' | 'POST';
  path: string;
  authenticated: boolean;
  /** Raw body before JSON.stringify. Pass `undefined` for GETs or bodyless POSTs. */
  requestBody: unknown | undefined;
  startTs: number;
  /** `undefined` when no response was ever received (network error, abort). */
  endTs: number | undefined;
  /** HTTP status, or 0 for network/abort. */
  status: number;
  /** ApiErrorCode string when not ok; undefined on success. */
  errorCode: string | undefined;
}

/**
 * Record one outbound HTTP call. Never throws.
 */
export function recordOutboundCall(args: RecordOutboundCallArgs): Promise<void> {
  const promise = (async () => {
    try {
      const db = await getDb();
      if (db === null) return;

      const requestBodyHash =
        args.requestBody === undefined ? null : await hashBody(args.requestBody);

      const record: Parameters<typeof logOutboundRequest>[1] = {
        ts: args.startTs,
        method: args.method,
        path: args.path,
        status: args.status,
        requestBodyHash,
        authenticated: args.authenticated,
      };
      if (args.endTs !== undefined) {
        record.durationMs = Math.max(0, args.endTs - args.startTs);
      }
      if (args.errorCode !== undefined) {
        record.errorCode = args.errorCode;
      }

      await logOutboundRequest(db, record);
    } catch {
      // Belt and braces — logOutboundRequest already swallows, but if anything
      // at this level throws (e.g. hashing on a value JSON.stringify chokes on)
      // we must never bubble it to the fetch caller.
    }
  })();
  lastInFlight = promise;
  return promise;
}

/**
 * Test-only: returns a promise that resolves once the most-recent
 * `recordOutboundCall` has finished its IDB write. Use this after calling
 * an instrumented fetch to make the deferred write observable.
 */
export function __flushOutboundLoggerWritesForTest(): Promise<void> {
  return lastInFlight;
}

/**
 * Test-only: clears the module-level cached db promise so each test starts
 * from a clean slate. Returns a promise that resolves once any open
 * connection has been closed so callers can `await` it before calling
 * `indexedDB.deleteDatabase(...)` in teardown without blocking.
 * Intentionally not re-exported from `backend/index.ts`.
 */
export function __resetOutboundLoggerForTest(): Promise<void> {
  const pending = cachedDbPromise;
  cachedDbPromise = null;
  if (pending === null) return Promise.resolve();
  return pending
    .then((db) => {
      try {
        db.close();
      } catch {
        // ignore
      }
    })
    .catch(() => {
      // ignore — either the cached open itself failed, or close threw
    });
}
