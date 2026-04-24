import type { PayloadGhostTab, TabEvent } from '@tabob/shared';
import { GHOST_TAB_CANDIDATES_TOP_N, GHOST_TAB_MAX_ACTIVE_MS } from '@tabob/shared';
import { activeTimePerTab } from './active-time-reducer.js';

/**
 * Compute "ghost tabs": tabs that were open but barely (or never) focused — strict
 * `activeMs < GHOST_TAB_MAX_ACTIVE_MS` (10 s). A tab with exactly 10 s is NOT a ghost.
 *
 * Discovery:
 *   - `activeTimePerTab` only surfaces tabs that received focus credit, so we ALSO scan the
 *     raw event stream for every `tabId` that ever appears (any event type). A tab opened but
 *     never focused has `activeMs: 0` and IS a ghost (assuming we can find its URL).
 *
 * For each qualifying tab:
 *   - `openTs` = ts of the FIRST event (any type) referencing this tabId.
 *   - `url` + `title` = from the LAST `navigate|open` event for this tab that carried a
 *     non-empty `url` (title defaults to `""` if absent on that event).
 *   - Tabs that never had a URL-bearing nav/open event are SKIPPED (can't represent them).
 *
 * Sort: openTs desc (most recent first), tie → url lex ascending.
 * Top `GHOST_TAB_CANDIDATES_TOP_N` (20) returned.
 *
 * Pure: no mutation of input, no `chrome.*`, no wall-clock.
 */
export function computeGhostTabs(events: TabEvent[]): PayloadGhostTab[] {
  if (events.length === 0) return [];

  const perTabMs = activeTimePerTab(events);

  // Collect every tabId seen in the stream + its first-observed ts. Also track the last
  // URL-bearing nav/open per tab for url/title attribution.
  const firstSeenByTab = new Map<number, number>();
  const lastUrlByTab = new Map<number, { url: string; title: string; ts: number }>();

  // Walk in ts order so "first event" and "last nav/open" are deterministic.
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  for (const ev of sorted) {
    if (ev.tabId === undefined) continue;
    if (!firstSeenByTab.has(ev.tabId)) {
      firstSeenByTab.set(ev.tabId, ev.ts);
    }
    if ((ev.type === 'navigate' || ev.type === 'open') && ev.url) {
      lastUrlByTab.set(ev.tabId, { url: ev.url, title: ev.title ?? '', ts: ev.ts });
    }
  }

  const rows: PayloadGhostTab[] = [];
  for (const [tabId, openTs] of firstSeenByTab) {
    const activeMs = perTabMs.get(tabId) ?? 0;
    if (activeMs >= GHOST_TAB_MAX_ACTIVE_MS) continue; // strict <

    const lastUrl = lastUrlByTab.get(tabId);
    if (!lastUrl) continue; // tab never had a URL — can't represent

    rows.push({
      url: lastUrl.url,
      title: lastUrl.title,
      openTs,
      activeMs,
    });
  }

  rows.sort((a, b) => {
    if (b.openTs !== a.openTs) return b.openTs - a.openTs;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });

  return rows.slice(0, GHOST_TAB_CANDIDATES_TOP_N);
}
