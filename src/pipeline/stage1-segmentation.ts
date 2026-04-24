import type { Session, SessionUrlEntry, TabEvent } from '@tabob/shared';
import { SCHEMA_VERSION, SESSION_GAP_MS, SESSION_MIN_ACTIVE_MS } from '@tabob/shared';
import { type ActiveInterval, computeActiveIntervals } from './active-intervals.js';

export interface SegmentOptions {
  /** ISO date (Monday local) stamped on every returned session. */
  weekStart: string;
  /** Present only so callers can pin id generation in tests; not currently used. */
  now?: number;
}

/**
 * Stage 1 session segmentation.
 *
 * - Computes active-time intervals from the event stream.
 * - Splits into sessions wherever inter-interval gap is >= SESSION_GAP_MS.
 * - Drops sessions whose total active time is < SESSION_MIN_ACTIVE_MS.
 *
 * Pure: does not mutate `events`, does not touch `chrome.*` or wall-clock time.
 */
export function segmentSessions(events: TabEvent[], opts: SegmentOptions): Session[] {
  const intervals = computeActiveIntervals(events);
  if (intervals.length === 0) return [];

  // Sort a copy of events once; used for URL attribution within each session.
  const sortedEvents = [...events].sort((a, b) => a.ts - b.ts);

  // Group intervals into sessions by gaps >= SESSION_GAP_MS.
  const groups: ActiveInterval[][] = [];
  let current: ActiveInterval[] = [intervals[0]!];
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1]!;
    const cur = intervals[i]!;
    if (cur.start - prev.end >= SESSION_GAP_MS) {
      groups.push(current);
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  groups.push(current);

  const sessions: Session[] = [];
  for (const group of groups) {
    const session = buildSession(group, sortedEvents, opts.weekStart);
    if (session.activeMs < SESSION_MIN_ACTIVE_MS) continue;
    sessions.push(session);
  }
  return sessions;
}

// ---------------------------------------------------------------------------

interface TabUrlState {
  url: string;
  title: string;
  firstSeenTs: number;
}

interface UrlAccumulator {
  url: string;
  domain: string;
  activeMs: number;
  openTs: number;
  title: string;
}

function buildSession(
  group: ActiveInterval[],
  sortedEvents: TabEvent[],
  weekStart: string,
): Session {
  const startTs = group[0]!.start;
  const endTs = group[group.length - 1]!.end;

  // Active time is the sum of interval durations. Intervals are already produced only for the
  // focused+attentive+non-idle state, so they never overlap and don't need clipping.
  let activeMs = 0;
  for (const iv of group) activeMs += iv.end - iv.start;

  // Walk the events in [startTs, endTs] chronologically, maintaining each tab's current URL.
  // Interleave interval attribution: as events are consumed up to (and including) an event at
  // ts <= interval.start, the tab's URL is "fresh" for that interval.
  const tabUrl = new Map<number, TabUrlState>();
  // Remember the ts at which each tab's *current* URL was first seen (for openTs accounting).
  // Using tabUrl.firstSeenTs directly is correct: it resets whenever the URL changes for that tab.
  const urlAcc = new Map<string, UrlAccumulator>();

  // Apply a single navigate/open event to the tabUrl map. Returns whether the event caused
  // the target tab's URL *string* to change (i.e. a true URL-change boundary, as opposed to a
  // same-URL re-navigate or a title-only update). Title-only events (url absent) with no
  // existing tab state are dropped so we don't invent phantom URL entries.
  const applyNavOrOpen = (ev: TabEvent): { changedUrl: boolean; tabId: number | undefined } => {
    if (ev.type !== 'open' && ev.type !== 'navigate')
      return { changedUrl: false, tabId: undefined };
    if (ev.tabId === undefined) return { changedUrl: false, tabId: undefined };
    const prev = tabUrl.get(ev.tabId);
    if (ev.url) {
      const isNewUrl = !prev || prev.url !== ev.url;
      // Pin firstSeenTs to the moment this URL *first* became this tab's URL within the
      // session window — don't reset it on a same-URL "re-navigate".
      const firstSeenTs = isNewUrl ? ev.ts : prev!.firstSeenTs;
      tabUrl.set(ev.tabId, {
        url: ev.url,
        title: ev.title ?? (isNewUrl ? '' : prev!.title),
        firstSeenTs,
      });
      return { changedUrl: isNewUrl, tabId: ev.tabId };
    }
    if (ev.title) {
      // Title-only update (e.g. a later navigate carrying the settled page title). Apply
      // only if we already have a URL tracked for this tab — otherwise drop.
      if (prev) {
        tabUrl.set(ev.tabId, { ...prev, title: ev.title });
      }
    }
    return { changedUrl: false, tabId: ev.tabId };
  };

  let eventIdx = 0;
  // Advance cursor past all events with ts <= cutoff, applying them to tabUrl. Events
  // outside [startTs, endTs] are skipped without applying (left) or halt the walk (right).
  const advanceUpTo = (cutoff: number): void => {
    while (eventIdx < sortedEvents.length) {
      const ev = sortedEvents[eventIdx]!;
      if (ev.ts > cutoff) return;
      if (ev.ts < startTs) {
        eventIdx++;
        continue;
      }
      if (ev.ts > endTs) return;
      applyNavOrOpen(ev);
      eventIdx++;
    }
  };

  // Attribute a [sliceStart, sliceEnd) window to the given URL state. Duration-only
  // (unattributed) slices are already accounted for in `activeMs`, so we just return.
  const attributeSlice = (
    sliceStart: number,
    sliceEnd: number,
    urlState: TabUrlState | undefined,
  ): void => {
    if (!urlState) return;
    const dur = sliceEnd - sliceStart;
    if (dur <= 0) return;
    const domain = safeDomain(urlState.url);
    if (domain === null) return;
    const existing = urlAcc.get(urlState.url);
    if (existing) {
      existing.activeMs += dur;
      if (urlState.firstSeenTs < existing.openTs) existing.openTs = urlState.firstSeenTs;
      // Most-recent non-empty title wins. Slices are attributed chronologically, so a later
      // slice carrying a non-empty title supersedes anything earlier.
      if (urlState.title) existing.title = urlState.title;
    } else {
      urlAcc.set(urlState.url, {
        url: urlState.url,
        domain,
        activeMs: dur,
        openTs: urlState.firstSeenTs,
        title: urlState.title,
      });
    }
  };

  // Per spec: URLs seen BEFORE the session window don't carry in — attribution uses only
  // events within [startTs, endTs]. `advanceUpTo` skips anything < startTs without applying.
  for (const iv of group) {
    // Apply all events with ts <= iv.start (so activate/navigate at exactly iv.start land
    // in tabUrl before we start attributing the interval).
    advanceUpTo(iv.start);

    // Walk mid-interval events (ts in (iv.start, iv.end)) and split into sub-slices
    // whenever the active tab's URL string changes. Title-only / same-URL navigates don't
    // create sub-slices but still update the in-flight title.
    let sliceStart = iv.start;
    while (eventIdx < sortedEvents.length) {
      const ev = sortedEvents[eventIdx]!;
      if (ev.ts >= iv.end) break;
      // ev.ts > iv.start because advanceUpTo already consumed ts <= iv.start. Defensive:
      if (ev.ts <= iv.start) {
        eventIdx++;
        continue;
      }
      if (ev.ts > endTs) break; // outside session window — stop

      const before = tabUrl.get(iv.tabId);
      const result = applyNavOrOpen(ev);
      eventIdx++;

      if (result.tabId !== iv.tabId) continue; // not our active tab — no sub-slice boundary

      if (result.changedUrl) {
        // Close the prior sub-slice with the URL state that was current *before* this event.
        attributeSlice(sliceStart, ev.ts, before);
        sliceStart = ev.ts;
      } else if (ev.title) {
        // Title-only or same-URL-with-new-title: no boundary, but propagate the new title
        // into the existing urlAcc entry for this tab's current URL (if any).
        const after = tabUrl.get(iv.tabId);
        if (after) {
          const entry = urlAcc.get(after.url);
          if (entry) entry.title = ev.title;
        }
      }
    }

    // Final sub-slice: [sliceStart, iv.end) with whatever URL state is current now.
    attributeSlice(sliceStart, iv.end, tabUrl.get(iv.tabId));
  }

  // Drain any remaining events within the window (harmless — state is no longer read).
  advanceUpTo(endTs);

  const urls: SessionUrlEntry[] = [...urlAcc.values()]
    .sort((a, b) => a.openTs - b.openTs || (a.url < b.url ? -1 : 1))
    .map((u) => ({
      url: u.url,
      title: u.title,
      domain: u.domain,
      activeMs: u.activeMs,
      openTs: u.openTs,
    }));

  // Distinct URLs = number of distinct URL strings (urlAcc keys are already unique).
  const distinctUrls = urls.length;

  // Distinct domains + topDomain (highest total activeMs; tie-break lexical).
  const domainTotals = new Map<string, number>();
  for (const u of urls) {
    domainTotals.set(u.domain, (domainTotals.get(u.domain) ?? 0) + u.activeMs);
  }
  const distinctDomains = domainTotals.size;

  let topDomain: string | undefined;
  if (domainTotals.size > 0) {
    let bestDomain = '';
    let bestMs = -1;
    for (const [domain, ms] of domainTotals) {
      if (ms > bestMs || (ms === bestMs && domain < bestDomain)) {
        bestDomain = domain;
        bestMs = ms;
      }
    }
    topDomain = bestDomain;
  }

  // Deterministic id from the events inside the window.
  const windowEvents = sortedEvents.filter((e) => e.ts >= startTs && e.ts <= endTs);
  const id = `sess_${startTs}_${shortHash(windowEvents)}`;

  const base = {
    id,
    weekStart,
    startTs,
    endTs,
    activeMs,
    distinctUrls,
    distinctDomains,
    urls,
    status: 'segmented' as const,
    schemaVersion: SCHEMA_VERSION,
  };
  // exactOptionalPropertyTypes: omit topDomain entirely when undefined.
  return topDomain !== undefined ? { ...base, topDomain } : base;
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Extract a coarse domain from a URL: hostname, lowercased, leading "www." stripped.
 * Returns null for unparseable URLs (so callers can skip attribution).
 *
 * Intentionally crude; true eTLD+1 extraction lives in lib/url-normalize.ts (canonicalDomain).
 */
function safeDomain(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * FNV-1a 32-bit hash of a compact string representation of the events. Stable across runs
 * given the same input order. Returned as an 8-char lowercase hex string.
 */
function shortHash(events: TabEvent[]): string {
  let h = 0x811c9dc5; // FNV offset basis
  const FNV_PRIME = 0x01000193;
  for (const ev of events) {
    const part = `${ev.ts}|${ev.type}|${ev.tabId ?? ''}`;
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      // Math.imul keeps the multiplication in 32-bit signed range.
      h = Math.imul(h, FNV_PRIME);
    }
    // Separator so adjacent events don't run together ambiguously.
    h ^= 0x7c; // '|'
    h = Math.imul(h, FNV_PRIME);
  }
  // Convert to unsigned 32-bit and pad to 8 hex chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}
