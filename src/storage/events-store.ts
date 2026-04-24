import type { TabEvent } from '@tabob/shared';
import { SCHEMA_VERSION, tabEventSchema } from '@tabob/shared';
import type { IDBPDatabase } from 'idb';
import type { TabObituaryDB } from './db.js';

export type AppendableEvent = Omit<TabEvent, 'id' | 'schemaVersion'>;

export async function appendEvent(
  db: IDBPDatabase<TabObituaryDB>,
  event: AppendableEvent,
): Promise<number> {
  const record = { ...event, schemaVersion: SCHEMA_VERSION } satisfies Omit<TabEvent, 'id'>;
  // Parse before write — cheap at this volume, and it guards against schema drift.
  tabEventSchema.parse(record);
  const id = await db.add('events', record as TabEvent & { id: number });
  return id as number;
}

export async function getEventsInRange(
  db: IDBPDatabase<TabObituaryDB>,
  fromTs: number,
  toTs: number,
): Promise<TabEvent[]> {
  const range = IDBKeyRange.bound(fromTs, toTs);
  return db.getAllFromIndex('events', 'by_ts', range);
}

export async function getEventsForTab(
  db: IDBPDatabase<TabObituaryDB>,
  tabId: number,
): Promise<TabEvent[]> {
  return db.getAllFromIndex('events', 'by_tab', tabId);
}

export async function purgeEventsForDomain(
  db: IDBPDatabase<TabObituaryDB>,
  domain: string,
): Promise<number> {
  const tx = db.transaction('events', 'readwrite');
  const index = tx.store.index('by_domain');
  let count = 0;
  for await (const cursor of index.iterate(domain)) {
    await cursor.delete();
    count += 1;
  }
  await tx.done;
  return count;
}

export async function countEvents(db: IDBPDatabase<TabObituaryDB>): Promise<number> {
  return db.count('events');
}
