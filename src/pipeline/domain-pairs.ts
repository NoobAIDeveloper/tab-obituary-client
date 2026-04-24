import type { PayloadDomainTitle, TabEvent } from '@tabob/shared';
import { DOMAIN_TITLE_PAIRS_TOP_N } from '@tabob/shared';
import { computeUrlActivity } from './url-activity.js';

/**
 * Gather unique (canonical-domain, title) pairs summed by active time, for feeding theme
 * extraction. Same domain with different titles = separate records; same title across
 * different domains = separate records.
 *
 * Filters applied:
 *   - URL entries with empty-string domain sentinel are dropped.
 *   - URL entries with empty title are dropped (useless for theme text).
 *
 * Sort: activeMs desc, domain ascending, title ascending.
 * Top `DOMAIN_TITLE_PAIRS_TOP_N` (50) returned.
 *
 * Pure: no mutation of input, no `chrome.*`, no wall-clock.
 */
export function gatherDomainTitlePairs(events: TabEvent[]): PayloadDomainTitle[] {
  const urlActivities = computeUrlActivity(events);

  // Key by `${domain}\x1f${title}` — \x1f (unit separator) is a safe delimiter that won't
  // collide with real URL content.
  const byPair = new Map<string, PayloadDomainTitle>();
  for (const entry of urlActivities) {
    if (entry.domain === '') continue;
    if (!entry.title) continue;
    const key = `${entry.domain}\x1f${entry.title}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.activeMs += entry.activeMs;
    } else {
      byPair.set(key, { domain: entry.domain, title: entry.title, activeMs: entry.activeMs });
    }
  }

  const rows = [...byPair.values()];
  rows.sort((a, b) => {
    if (b.activeMs !== a.activeMs) return b.activeMs - a.activeMs;
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });

  return rows.slice(0, DOMAIN_TITLE_PAIRS_TOP_N);
}
