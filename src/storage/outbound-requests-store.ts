import { SCHEMA_VERSION } from '@tabob/shared';
import type { IDBPDatabase } from 'idb';
import type { OutboundRequestRecord, TabObituaryDB } from './db.js';

export type { OutboundRequestRecord } from './db.js';

/**
 * Appends an outbound-request metadata record. Best-effort: any IDB error is
 * swallowed so that logger callers never affect the primary fetch result.
 *
 * Never call this from a path where the caller depends on the write
 * succeeding — by design this function has no return signal for failure.
 */
export async function logOutboundRequest(
  db: IDBPDatabase<TabObituaryDB>,
  record: Omit<OutboundRequestRecord, 'id' | 'schemaVersion'>,
): Promise<void> {
  try {
    const row: OutboundRequestRecord = {
      ...record,
      schemaVersion: SCHEMA_VERSION,
    };
    await db.add('outbound_requests', row as OutboundRequestRecord & { id: number });
  } catch {
    // Swallow: logging is best-effort and must never surface to the caller.
  }
}

/**
 * Returns every outbound-request record, sorted by `ts` ascending (oldest
 * first) so the export bundle reads chronologically.
 */
export async function getAllOutboundRequests(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<OutboundRequestRecord[]> {
  const rows = await db.getAll('outbound_requests');
  return rows.slice().sort((a, b) => a.ts - b.ts);
}

/** Clears the outbound_requests store. Used by the delete-cascade path. */
export async function clearOutboundRequests(db: IDBPDatabase<TabObituaryDB>): Promise<void> {
  await db.clear('outbound_requests');
}
