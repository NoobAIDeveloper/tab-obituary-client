import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_NAME, openDb } from './db.js';
import {
  appendEvent,
  countEvents,
  getEventsForTab,
  getEventsInRange,
  purgeEventsForDomain,
} from './events-store.js';

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await wipe();
});

describe('events-store', () => {
  it('appendEvent assigns an id and round-trips via getEventsInRange', async () => {
    const db = await openDb();
    const id1 = await appendEvent(db, {
      type: 'activate',
      ts: 1_000,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'a.com',
    });
    const id2 = await appendEvent(db, {
      type: 'navigate',
      ts: 2_000,
      tzOffsetMin: 0,
      tabId: 1,
      url: 'https://a.com/x',
      domain: 'a.com',
    });
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(id1);
    const range = await getEventsInRange(db, 500, 1_500);
    expect(range).toHaveLength(1);
    expect(range[0]?.type).toBe('activate');
    const all = await getEventsInRange(db, 0, 10_000);
    expect(all).toHaveLength(2);
    db.close();
  });

  it('getEventsForTab returns only events with the matching tabId', async () => {
    const db = await openDb();
    await appendEvent(db, { type: 'open', ts: 1, tzOffsetMin: 0, tabId: 10 });
    await appendEvent(db, { type: 'open', ts: 2, tzOffsetMin: 0, tabId: 20 });
    await appendEvent(db, { type: 'activate', ts: 3, tzOffsetMin: 0, tabId: 10 });
    const forTen = await getEventsForTab(db, 10);
    expect(forTen).toHaveLength(2);
    const forTwenty = await getEventsForTab(db, 20);
    expect(forTwenty).toHaveLength(1);
    db.close();
  });

  it('purgeEventsForDomain deletes matching events and returns the count', async () => {
    const db = await openDb();
    await appendEvent(db, { type: 'navigate', ts: 1, tzOffsetMin: 0, tabId: 1, domain: 'a.com' });
    await appendEvent(db, { type: 'navigate', ts: 2, tzOffsetMin: 0, tabId: 1, domain: 'a.com' });
    await appendEvent(db, { type: 'navigate', ts: 3, tzOffsetMin: 0, tabId: 2, domain: 'b.com' });
    await appendEvent(db, { type: 'navigate', ts: 4, tzOffsetMin: 0, tabId: 3, domain: 'c.com' });
    await appendEvent(db, { type: 'navigate', ts: 5, tzOffsetMin: 0, tabId: 3, domain: 'c.com' });
    expect(await countEvents(db)).toBe(5);
    const removed = await purgeEventsForDomain(db, 'a.com');
    expect(removed).toBe(2);
    expect(await countEvents(db)).toBe(3);
    db.close();
  });
});
