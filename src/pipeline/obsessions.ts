import type { PayloadObsession, TabEvent } from '@tabob/shared';
import { OBSESSIONS_TOP_N } from '@tabob/shared';
import { computeUrlActivity } from './url-activity.js';

/**
 * Compute the week's "obsessions": canonical domains with the most focused active time, each
 * with a tally of visits (count of navigate|open events to URLs under that domain).
 *
 * - Drops URL entries with an empty-string domain sentinel (see `url-activity.ts`).
 * - Groups by canonical eTLD+1.
 * - Sorts by activeMs desc, visits desc, then domain ascending (lexical tie-break).
 * - Returns at most `OBSESSIONS_TOP_N` (10) entries.
 *
 * Pure: no mutation of input, no `chrome.*`, no wall-clock.
 */
export function computeObsessions(events: TabEvent[]): PayloadObsession[] {
  const urlActivities = computeUrlActivity(events);

  const byDomain = new Map<string, { activeMs: number; visits: number }>();
  for (const entry of urlActivities) {
    if (entry.domain === '') continue; // sentinel: unknown / unparseable domain
    const existing = byDomain.get(entry.domain);
    if (existing) {
      existing.activeMs += entry.activeMs;
      existing.visits += entry.visits;
    } else {
      byDomain.set(entry.domain, { activeMs: entry.activeMs, visits: entry.visits });
    }
  }

  const rows: PayloadObsession[] = [...byDomain.entries()].map(([domain, totals]) => ({
    domain,
    activeMs: totals.activeMs,
    visits: totals.visits,
  }));

  rows.sort((a, b) => {
    if (b.activeMs !== a.activeMs) return b.activeMs - a.activeMs;
    if (b.visits !== a.visits) return b.visits - a.visits;
    return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
  });

  return rows.slice(0, OBSESSIONS_TOP_N);
}
