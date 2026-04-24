import type { Plan, ReportPayload } from '@tabob/shared';
import { buildReportPayload } from '../pipeline/build-payload.js';
import { canonicalDomain } from '../lib/url-normalize.js';
import { createDefaultHistoryClient, type HistoryClient } from './chrome-history.js';
import { DEFAULT_PREVIEW_DWELL_MS, historyToEvents } from './history-to-events.js';

/**
 * Preview orchestrator — pulls the last 24h of `chrome.history`, synthesises
 * a `TabEvent[]` stream, and runs the extension-side pipeline to produce a
 * `ReportPayload` marked `preview: true`.
 *
 * ## Why this exists separately from the live-report path
 *
 * The live weekly alarm reads captured events from IDB. The preview runs on
 * day zero — IDB is empty — so we fake the stream from history. See
 * `history-to-events.ts` for the synthesis + its documented limitations.
 *
 * ## Concurrency
 *
 * `chrome.history.getVisits` is one round-trip per URL. With a 500-URL cap
 * from `search({maxResults: 500})` and a hardcoded per-visit pool of 4,
 * worst-case we issue 4 concurrent reads across the extension's history DB —
 * well under anything the browser rate-limits in practice, but capped to
 * avoid a thundering-herd on slow disks.
 */

const DEFAULT_PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEARCH_MAX_RESULTS = 500;
const VISIT_FETCH_CONCURRENCY = 4;

export type { HistoryClient } from './chrome-history.js';

export interface BuildPreviewPayloadInput {
  uuid: string;
  timezone: string;
  plan: Plan;
  blocklist: Set<string>;
  /** Injected for tests. Defaults to the chrome.history promise APIs. */
  historyClient?: HistoryClient;
  /** Epoch ms; defaults to `Date.now()`. */
  now?: number;
  /** Window length in ms; defaults to 24h. */
  windowMs?: number;
  /** Estimated active-ms per visit; defaults to {@link DEFAULT_PREVIEW_DWELL_MS}. */
  dwellPerVisitMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolve all inputs, pull history, synthesise events, and produce the
 * ReportPayload the backend expects on `/generate-report`.
 *
 * Throws a `DOMException` with name 'AbortError' if the signal aborts at any
 * await boundary — matches the fetch/AbortController convention the rest of
 * the extension uses.
 */
export async function buildPreviewPayload(
  input: BuildPreviewPayloadInput,
): Promise<ReportPayload> {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_PREVIEW_WINDOW_MS;
  const dwellPerVisitMs = input.dwellPerVisitMs ?? DEFAULT_PREVIEW_DWELL_MS;
  const historyClient = input.historyClient ?? createDefaultHistoryClient();

  const windowStartMs = now - windowMs;
  const windowEndMs = now;

  throwIfAborted(input.signal);

  // 1. Pull history items in the window.
  const items = await historyClient.search({
    text: '',
    startTime: windowStartMs,
    endTime: windowEndMs,
    maxResults: SEARCH_MAX_RESULTS,
  });
  throwIfAborted(input.signal);

  // 2. Decide which items are worth a getVisits roundtrip. We pre-filter on
  //    canonical-domain blocklist here so we don't burn reads on banned
  //    domains — the downstream filter would drop them anyway.
  const normBlock = normaliseBlocklist(input.blocklist);
  const itemsToFetch: chrome.history.HistoryItem[] = [];
  for (const item of items) {
    if (typeof item.url !== 'string' || item.url.length === 0) continue;
    const canon = canonicalDomain(item.url);
    if (canon !== null && normBlock.has(canon)) continue;
    itemsToFetch.push(item);
  }

  // 3. Fetch visits with a hand-rolled concurrency pool. This is
  //    intentionally ~5 lines of code instead of importing a general-purpose
  //    `promisePool` — the rest of the extension uses plain Promise.all
  //    elsewhere, and adding a dependency just for this path felt like
  //    over-engineering.
  const visitsByUrl = new Map<string, chrome.history.VisitItem[]>();
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < itemsToFetch.length) {
      const i = idx++;
      const item = itemsToFetch[i];
      if (!item || typeof item.url !== 'string') continue;
      throwIfAborted(input.signal);
      try {
        const visits = await historyClient.getVisits({ url: item.url });
        throwIfAborted(input.signal);
        visitsByUrl.set(item.url, visits);
      } catch (err) {
        // An aborted getVisits rethrows AbortError — bubble it.
        if (isAbortError(err)) throw err;
        // Anything else — skip this URL silently; one bad read shouldn't
        // blow up the whole preview.
        visitsByUrl.set(item.url, []);
      }
    }
  }
  const workers: Promise<void>[] = [];
  const poolSize = Math.min(VISIT_FETCH_CONCURRENCY, itemsToFetch.length);
  for (let i = 0; i < poolSize; i++) workers.push(worker());
  await Promise.all(workers);
  throwIfAborted(input.signal);

  // 4. Synthesise events from the collected history.
  const events = historyToEvents({
    items: itemsToFetch,
    visitsByUrl,
    windowStartMs,
    windowEndMs,
    dwellPerVisitMs,
    blocklist: input.blocklist,
  });

  // 5. Hand off to the shared pipeline. `buildReportPayload` expects ISO
  //    `weekStart` / `weekEnd` strings — derive from ms bounds. `priorWeekSummary`
  //    is omitted: first preview has no baseline.
  const weekStart = new Date(windowStartMs).toISOString();
  const weekEnd = new Date(windowEndMs).toISOString();

  return buildReportPayload({
    events,
    weekStart,
    weekEnd,
    weekStartMs: windowStartMs,
    weekEndMs: windowEndMs,
    uuid: input.uuid,
    timezone: input.timezone,
    plan: input.plan,
    blocklist: input.blocklist,
    preview: true,
    now,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // Match fetch's abort behaviour so callers can branch on error.name.
    throw new DOMException('Preview aborted', 'AbortError');
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function normaliseBlocklist(blocklist: Set<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!blocklist) return out;
  for (const entry of blocklist) {
    if (!entry) continue;
    const lower = entry.toLowerCase();
    out.add(lower.startsWith('www.') ? lower.slice(4) : lower);
  }
  return out;
}
