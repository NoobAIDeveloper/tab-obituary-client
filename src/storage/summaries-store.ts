/**
 * CRUD over the `weekly_summaries` object store.
 *
 * Rows are the per-week `ReportSections` snapshot we get back from
 * `/generate-report` on a successful send. The weekly-alarm handler reads the latest row to build priorWeekSummary.
 */
import type { IDBPDatabase } from 'idb';
import type { TabObituaryDB, WeeklySummary } from './db.js';

export async function putWeeklySummary(
  db: IDBPDatabase<TabObituaryDB>,
  summary: WeeklySummary,
): Promise<void> {
  await db.put('weekly_summaries', summary);
}

export async function getWeeklySummary(
  db: IDBPDatabase<TabObituaryDB>,
  weekStart: string,
): Promise<WeeklySummary | undefined> {
  return db.get('weekly_summaries', weekStart);
}

export async function getAllWeeklySummaries(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<WeeklySummary[]> {
  return db.getAll('weekly_summaries');
}

/**
 * Most-recent-first by `weekStart` (ISO date → lexical sort = chronological
 * for a fixed YYYY-MM-DD format). Returns `undefined` when the store is empty.
 * 10.2 will use this to populate `priorWeekSummary`.
 */
export async function getLatestWeeklySummary(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<WeeklySummary | undefined> {
  const all = await db.getAll('weekly_summaries');
  if (all.length === 0) return undefined;
  let latest = all[0] as WeeklySummary;
  for (let i = 1; i < all.length; i += 1) {
    const row = all[i] as WeeklySummary;
    if (row.weekStart > latest.weekStart) latest = row;
  }
  return latest;
}
