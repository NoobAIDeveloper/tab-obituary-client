import type { TabEvent } from '@tabob/shared';
import { canonicalDomain } from '../lib/url-normalize.js';
import { computeActiveIntervals } from './active-intervals.js';

/**
 * Per-URL activity rollup across the entire input event stream (no session windowing).
 *
 * This is the shared feedstock for obsessions / domain-title pairs: a chronological walk over
 * every tab's URL lifecycle, attributing focused active-time to whichever URL each tab was on
 * at the time, and counting visits as navigate|open events carrying that exact URL string.
 */
export interface UrlActivity {
  /** The exact URL string (not normalized). */
  url: string;
  /** Most recent non-empty title observed for this URL, chronologically. */
  title: string;
  /**
   * Canonical eTLD+1 (see `canonicalDomain`). Empty string `""` is a SENTINEL for URLs whose
   * domain couldn't be extracted (e.g. `about:blank`, `javascript:`, malformed URLs). These
   * entries are still returned here — callers that need a valid domain must filter them out.
   */
  domain: string;
  /** Total focused active time (ms) attributed to this URL across the whole stream. */
  activeMs: number;
  /** Earliest ts at which ANY tab first navigated to this URL in the stream. */
  firstSeenTs: number;
  /**
   * Count of `navigate|open` events whose `url` matches this URL string exactly, across all
   * tabs, over the whole stream. Independent of `activeMs`: a URL navigated to but never
   * actively viewed still has `visits >= 1`.
   */
  visits: number;
}

interface TabUrlState {
  url: string;
  title: string;
  // firstSeenTs here is the per-tab *current-URL* first-seen — not the stream-wide one.
  // Stream-wide firstSeenTs is tracked separately in `urlFirstSeen`.
  firstSeenTs: number;
}

interface UrlAccumulator {
  url: string;
  domain: string;
  activeMs: number;
  firstSeenTs: number;
  title: string;
  visits: number;
}

/**
 * Compute per-URL activity over the entire event stream.
 *
 * Pure: does not mutate `events`, does not touch `chrome.*` or wall-clock time.
 *
 * Algorithm:
 *   1. Sort a copy of events by ts.
 *   2. Derive active-time intervals via `computeActiveIntervals`.
 *   3. Maintain per-tab current URL by walking events; on navigate|open with a url, set the
 *      tab's URL. Same-URL re-navigate preserves firstSeenTs. Title-only events update title.
 *   4. For each interval, walk mid-interval events for the active tab and sub-slice the
 *      interval when the active tab's URL string changes.
 *   5. Merge across the stream: summed activeMs, earliest firstSeenTs (stream-wide), most
 *      recent non-empty title, and a visits count that's INDEPENDENT of activeMs.
 *   6. Unknown / un-parseable domains use `""` as the domain sentinel (caller filters).
 *
 * Returned list is unordered; callers sort as needed. Not truncated.
 */
export function computeUrlActivity(events: TabEvent[]): UrlActivity[] {
  if (events.length === 0) return [];

  const sortedEvents = [...events].sort((a, b) => a.ts - b.ts);
  const intervals = computeActiveIntervals(sortedEvents);

  // Stream-wide first-seen ts per URL string. Pinned to the earliest navigate|open with a
  // matching url, regardless of which tab. Never decreases.
  const urlFirstSeen = new Map<string, number>();
  // Stream-wide visit count per URL string (navigate|open events with that exact url).
  const urlVisits = new Map<string, number>();

  // Per-tab current URL state. Rebuilt as we walk events; used during interval attribution.
  const tabUrl = new Map<number, TabUrlState>();

  // Per-URL active-time + metadata accumulator.
  const urlAcc = new Map<string, UrlAccumulator>();

  const applyNavOrOpen = (ev: TabEvent): { changedUrl: boolean; tabId: number | undefined } => {
    if (ev.type !== 'open' && ev.type !== 'navigate') {
      return { changedUrl: false, tabId: undefined };
    }
    if (ev.tabId === undefined) return { changedUrl: false, tabId: undefined };
    const prev = tabUrl.get(ev.tabId);

    if (ev.url) {
      // Record stream-wide first-seen and visit count for this URL.
      const existingFirstSeen = urlFirstSeen.get(ev.url);
      if (existingFirstSeen === undefined || ev.ts < existingFirstSeen) {
        urlFirstSeen.set(ev.url, ev.ts);
      }
      urlVisits.set(ev.url, (urlVisits.get(ev.url) ?? 0) + 1);

      const isNewUrl = !prev || prev.url !== ev.url;
      const firstSeenTs = isNewUrl ? ev.ts : prev!.firstSeenTs;
      tabUrl.set(ev.tabId, {
        url: ev.url,
        title: ev.title ?? (isNewUrl ? '' : prev!.title),
        firstSeenTs,
      });
      return { changedUrl: isNewUrl, tabId: ev.tabId };
    }

    if (ev.title) {
      // Title-only update. Apply only if we already have a URL tracked for this tab.
      if (prev) {
        tabUrl.set(ev.tabId, { ...prev, title: ev.title });
      }
    }
    return { changedUrl: false, tabId: ev.tabId };
  };

  const attributeSlice = (
    sliceStart: number,
    sliceEnd: number,
    urlState: TabUrlState | undefined,
  ): void => {
    if (!urlState) return;
    const dur = sliceEnd - sliceStart;
    if (dur <= 0) return;
    const domain = canonicalDomain(urlState.url) ?? '';
    const existing = urlAcc.get(urlState.url);
    if (existing) {
      existing.activeMs += dur;
      // Most-recent non-empty title wins (chronological walk).
      if (urlState.title) existing.title = urlState.title;
      // `firstSeenTs` in the accumulator mirrors the stream-wide value; it's reconciled on
      // output but we keep the min here too for consistency if future callers read it mid-walk.
      if (urlState.firstSeenTs < existing.firstSeenTs) existing.firstSeenTs = urlState.firstSeenTs;
    } else {
      urlAcc.set(urlState.url, {
        url: urlState.url,
        domain,
        activeMs: dur,
        firstSeenTs: urlState.firstSeenTs,
        title: urlState.title,
        visits: 0, // reconciled from urlVisits on output
      });
    }
  };

  // If there are no intervals at all, we still want to visit every navigate|open event so
  // that `visits`, `firstSeenTs`, and title-only bookkeeping are complete — attribution will
  // just credit zero activeMs. We do the event walk with an interval cursor.
  let eventIdx = 0;

  const advanceUpTo = (cutoff: number): void => {
    while (eventIdx < sortedEvents.length) {
      const ev = sortedEvents[eventIdx]!;
      if (ev.ts > cutoff) return;
      applyNavOrOpen(ev);
      eventIdx++;
    }
  };

  for (const iv of intervals) {
    // Apply all events with ts <= iv.start so activate/navigate exactly at iv.start land in
    // tabUrl before we attribute. (Titles-only with no prior URL drop harmlessly.)
    advanceUpTo(iv.start);

    let sliceStart = iv.start;
    while (eventIdx < sortedEvents.length) {
      const ev = sortedEvents[eventIdx]!;
      if (ev.ts >= iv.end) break;
      if (ev.ts <= iv.start) {
        // Defensive: advanceUpTo should have consumed these.
        eventIdx++;
        continue;
      }

      const before = tabUrl.get(iv.tabId);
      const result = applyNavOrOpen(ev);
      eventIdx++;

      if (result.tabId !== iv.tabId) continue;

      if (result.changedUrl) {
        attributeSlice(sliceStart, ev.ts, before);
        sliceStart = ev.ts;
      } else if (ev.title) {
        const after = tabUrl.get(iv.tabId);
        if (after) {
          const entry = urlAcc.get(after.url);
          if (entry) entry.title = ev.title;
        }
      }
    }

    attributeSlice(sliceStart, iv.end, tabUrl.get(iv.tabId));
  }

  // Drain the remainder of the event stream so visits / firstSeenTs for post-last-interval
  // navigates are counted.
  while (eventIdx < sortedEvents.length) {
    applyNavOrOpen(sortedEvents[eventIdx]!);
    eventIdx++;
  }

  // Reconcile: urlFirstSeen + urlVisits take precedence over per-accumulator values, and
  // every URL with a nav/open event (even if never focus-attributed) gets an entry.
  const result: UrlActivity[] = [];
  const seenUrls = new Set<string>();

  for (const acc of urlAcc.values()) {
    const firstSeenTs = urlFirstSeen.get(acc.url) ?? acc.firstSeenTs;
    result.push({
      url: acc.url,
      title: acc.title,
      domain: acc.domain,
      activeMs: acc.activeMs,
      firstSeenTs,
      visits: urlVisits.get(acc.url) ?? 0,
    });
    seenUrls.add(acc.url);
  }

  // Include URLs that had nav/open events but never accrued focus attribution.
  for (const [url, firstSeenTs] of urlFirstSeen) {
    if (seenUrls.has(url)) continue;
    // Recover a title for this URL if any tab still has it current. Walk tabUrl once; cheap.
    let title = '';
    for (const state of tabUrl.values()) {
      if (state.url === url && state.title) {
        title = state.title;
        break;
      }
    }
    result.push({
      url,
      title,
      domain: canonicalDomain(url) ?? '',
      activeMs: 0,
      firstSeenTs,
      visits: urlVisits.get(url) ?? 0,
    });
  }

  return result;
}
