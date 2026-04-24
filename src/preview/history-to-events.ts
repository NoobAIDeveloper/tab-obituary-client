import type { TabEvent } from '@tabob/shared';
import { INPUT_TICK_THROTTLE_MS, SCHEMA_VERSION } from '@tabob/shared';
import { canonicalDomain } from '../lib/url-normalize.js';

/**
 * # Preview-only event synthesiser
 *
 * The live weekly report is built from captured `TabEvent`s — real focus,
 * real idle transitions, real input-ticks. On day zero the IDB event store
 * is empty, so the onboarding preview has to conjure a plausible stream
 * from `chrome.history`.
 *
 * `chrome.history` gives us per-URL visits (`VisitItem.visitTime`) but
 * nothing about dwell. We assume every visit got `dwellPerVisitMs`
 * (default 60s) of active time, then synthesise the minimal event set the
 * `active-intervals` reducer needs to emit one interval per visit:
 *
 *   - one global `window_focus(windowId=1, windowFocused=true)` and
 *     `idle_state(active)` at the start of the window, to establish the
 *     "focused & attentive" steady state;
 *   - per visit: `open` → `activate` → a chain of `input_tick`s spaced
 *     every `INPUT_TICK_THROTTLE_MS` (keeps the 60s attention window
 *     open) → `deactivate` → `close`;
 *   - each visit gets its own synthetic `tabId` so overlapping visits on
 *     different URLs do not stomp each other in the reducer's
 *     `activeTabByWindow` map.
 *
 * Caveats (document inline — a test agent will re-read this):
 *   - Active-time here is an estimate, not a measurement. A visit with
 *     `visitCount: 1` and a real dwell of 2h still gets 60s of modelled
 *     active time. This matches the "preview is an approximation"
 *     promise in PRD §8.2.
 *   - Visits before `windowStartMs` or at/after `windowEndMs` are
 *     dropped; the `buildReportPayload` filter is inclusive-exclusive
 *     so we mirror that here.
 *   - Events whose synthesized tail (`visitTime + dwellPerVisitMs`)
 *     would exceed `windowEndMs` are clamped into the window. The
 *     active-intervals reducer closes the tail segment at min(attention
 *     expiry, last event ts), so a clamped deactivate/close still yields
 *     a valid interval.
 *   - Blocklisted canonical domains are dropped before event
 *     synthesis — the downstream `buildReportPayload` blocklist filter
 *     would drop them anyway, but filtering up-front keeps the synthetic
 *     stream small and predictable.
 *
 * Live weekly reports DO NOT use this path; see
 * `packages/extension/src/pipeline/build-payload.ts`.
 */

/** Shared synthetic window for all synthesised events. */
const SYNTH_WINDOW_ID = 1;

/**
 * Documented default dwell assumption per history visit. See caveats above.
 * 60s matches `INPUT_ATTENTION_WINDOW_MS` so the tail interval closes cleanly.
 */
export const DEFAULT_PREVIEW_DWELL_MS = 60_000;

export interface HistoryToEventsInput {
  items: chrome.history.HistoryItem[];
  /** Map keyed by `HistoryItem.url` → visits from `chrome.history.getVisits`. */
  visitsByUrl: Map<string, chrome.history.VisitItem[]>;
  /** Lower bound (inclusive), epoch ms — usually now - 24h. Visits before this are dropped. */
  windowStartMs: number;
  /** Upper bound (exclusive), epoch ms — usually now. */
  windowEndMs: number;
  /** Estimated active-ms per visit. Defaults to {@link DEFAULT_PREVIEW_DWELL_MS}. */
  dwellPerVisitMs?: number;
  /** Canonical eTLD+1 domains to exclude (matches the live blocklist contract). */
  blocklist?: Set<string>;
}

interface NormalisedVisit {
  url: string;
  title: string;
  ts: number;
}

/**
 * Produce a synthesised `TabEvent[]` approximating a real capture stream
 * for the preview pipeline. Pure: no `chrome.*` access, no wall-clock reads.
 */
export function historyToEvents(input: HistoryToEventsInput): TabEvent[] {
  const {
    items,
    visitsByUrl,
    windowStartMs,
    windowEndMs,
    dwellPerVisitMs = DEFAULT_PREVIEW_DWELL_MS,
    blocklist,
  } = input;

  if (windowEndMs <= windowStartMs) return [];
  if (dwellPerVisitMs <= 0) return [];

  const normBlock = normaliseBlocklist(blocklist);

  // 1. Flatten items+visits into per-visit rows filtered by window + blocklist.
  const rows: NormalisedVisit[] = [];
  for (const item of items) {
    const url = item.url;
    if (typeof url !== 'string' || url.length === 0) continue;

    // Canonical-domain blocklist match. canonicalDomain() lowercases + strips
    // www, matching how buildReportPayload's filterEvents canonicalises.
    const canon = canonicalDomain(url);
    if (canon !== null && normBlock.has(canon)) continue;

    const visits = visitsByUrl.get(url);
    if (!visits || visits.length === 0) continue;

    const title = typeof item.title === 'string' ? item.title : '';

    for (const v of visits) {
      const ts = typeof v.visitTime === 'number' ? v.visitTime : NaN;
      if (!Number.isFinite(ts)) continue;
      if (ts < windowStartMs) continue;
      if (ts >= windowEndMs) continue;
      rows.push({ url, title, ts });
    }
  }

  if (rows.length === 0) return [];

  // 2. Sort visits ascending by ts; assign a stable synthetic tabId per visit.
  rows.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.url < b.url ? -1 : 1));

  const out: TabEvent[] = [];

  // 3. One-shot steady-state primers at (or just before) the earliest visit.
  //    We place them at windowStartMs so they precede every synthesised visit.
  //    The reducer only cares about ts ordering, not about whether the primer
  //    equals the first visit's ts — sorted stable sort keeps primers first.
  out.push(
    makeEvent({
      type: 'window_focus',
      ts: windowStartMs,
      windowId: SYNTH_WINDOW_ID,
      windowFocused: true,
    }),
  );
  out.push(
    makeEvent({
      type: 'idle_state',
      ts: windowStartMs,
      idleState: 'active',
    }),
  );

  // 4. Per-visit events. Each visit gets its own synthetic tabId so
  //    overlapping visits don't collide on `activeTabByWindow`.
  let nextTabId = 1;
  for (const row of rows) {
    const tabId = nextTabId++;

    // Clamp the tail into the window. We keep the open/activate at ts and
    // push the deactivate/close to endTs; if the modelled dwell runs past
    // windowEndMs, clamp so every emitted ts stays < windowEndMs. Using
    // (windowEndMs - 1) guarantees inclusion under the [start, end) filter
    // the pipeline applies.
    const desiredEndTs = row.ts + dwellPerVisitMs;
    const endTs =
      desiredEndTs >= windowEndMs ? Math.max(row.ts, windowEndMs - 1) : desiredEndTs;

    out.push(
      makeEvent({
        type: 'open',
        ts: row.ts,
        tabId,
        windowId: SYNTH_WINDOW_ID,
        url: row.url,
        title: row.title,
      }),
    );
    out.push(
      makeEvent({
        type: 'activate',
        ts: row.ts,
        tabId,
        windowId: SYNTH_WINDOW_ID,
      }),
    );

    // Fill input_ticks every INPUT_TICK_THROTTLE_MS (5s) between ts and endTs
    // inclusive. The reducer needs a tick to establish attention (first tick
    // unlocks accrual) and needs subsequent ticks inside the 60s attention
    // window to keep the segment open. We always emit at least one tick at
    // `row.ts` so attention is established immediately.
    let tickTs = row.ts;
    out.push(makeEvent({ type: 'input_tick', ts: tickTs }));
    while (tickTs + INPUT_TICK_THROTTLE_MS < endTs) {
      tickTs += INPUT_TICK_THROTTLE_MS;
      out.push(makeEvent({ type: 'input_tick', ts: tickTs }));
    }

    out.push(
      makeEvent({
        type: 'deactivate',
        ts: endTs,
        tabId,
        windowId: SYNTH_WINDOW_ID,
      }),
    );
    out.push(
      makeEvent({
        type: 'close',
        ts: endTs,
        tabId,
        windowId: SYNTH_WINDOW_ID,
      }),
    );
  }

  // 5. Final sort — within-visit events are already in order but we re-sort
  //    for global ascending ts, as the contract promises. Stable enough with
  //    a secondary tabId tiebreak to keep per-tab sub-ordering deterministic.
  out.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const ta = a.tabId ?? -1;
    const tb = b.tabId ?? -1;
    return ta - tb;
  });

  return out;
}

// ---------------------------------------------------------------------------
// helpers

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

/**
 * Shared constructor so every synthesised event carries the right
 * `schemaVersion` without `makeEvent` from `@tabob/shared` (which accepts
 * Omit<TabEvent, 'schemaVersion'> and forces an object-spread round-trip).
 */
function makeEvent(partial: Omit<TabEvent, 'schemaVersion' | 'tzOffsetMin'>): TabEvent {
  return {
    ...partial,
    schemaVersion: SCHEMA_VERSION,
    // Pipeline doesn't consume tzOffsetMin for preview math, but the schema
    // requires it. 0 is fine — preview timing is approximated regardless.
    tzOffsetMin: 0,
  };
}
