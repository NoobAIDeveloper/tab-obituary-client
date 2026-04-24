import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetOutboundLoggerForTest } from '../lib/outbound-logger.js';
import { DB_NAME, DB_VERSION, openDb } from './db.js';

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// Reset the logger's cached DB handle so a prior test file's open connection
// doesn't block indexedDB.deleteDatabase(DB_NAME).
beforeEach(async () => {
  await __resetOutboundLoggerForTest();
});
afterEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
});

describe('openDb upgrade', () => {
  it('creates all seven object stores on fresh open', async () => {
    const db = await openDb();
    const names = Array.from(db.objectStoreNames).sort();
    expect(names).toEqual(
      [
        'blocklist',
        'events',
        'jobs',
        'outbound_requests',
        'sessions',
        'settings',
        'weekly_summaries',
      ].sort(),
    );
    db.close();
  });

  it('creates the expected indexes on the events store', async () => {
    const db = await openDb();
    const tx = db.transaction('events', 'readonly');
    const names = Array.from(tx.store.indexNames).sort();
    expect(names).toEqual(['by_domain', 'by_tab', 'by_ts', 'by_type_ts'].sort());
    db.close();
  });

  it('creates the by_week_start index on sessions and by_status on jobs', async () => {
    const db = await openDb();
    const sessions = db.transaction('sessions', 'readonly').store;
    expect(Array.from(sessions.indexNames)).toContain('by_week_start');
    const jobs = db.transaction('jobs', 'readonly').store;
    expect(Array.from(jobs.indexNames)).toContain('by_status');
    db.close();
  });

  it('creates by_ts / by_path / by_status indexes on outbound_requests', async () => {
    const db = await openDb();
    const store = db.transaction('outbound_requests', 'readonly').store;
    expect(Array.from(store.indexNames).sort()).toEqual(['by_path', 'by_status', 'by_ts'].sort());
    db.close();
  });

  it('outbound_requests indexes are queryable (by_ts, by_path, by_status)', async () => {
    const db = await openDb();
    // Seed a couple of rows with distinct values in each indexed field.
    await db.add('outbound_requests', {
      ts: 10,
      method: 'POST',
      path: '/subscribe',
      status: 500,
      requestBodyHash: 'a'.repeat(64),
      authenticated: false,
      schemaVersion: 1,
    } as unknown as Parameters<typeof db.add>[1]);
    await db.add('outbound_requests', {
      ts: 20,
      method: 'GET',
      path: '/export',
      status: 200,
      requestBodyHash: null,
      authenticated: true,
      schemaVersion: 1,
    } as unknown as Parameters<typeof db.add>[1]);

    // by_ts → returns in ts order
    const byTs = await db.getAllFromIndex('outbound_requests', 'by_ts');
    expect(byTs.map((r) => r.ts)).toEqual([10, 20]);

    // by_path → queryable with an equality bound
    const subscribeRows = await db.getAllFromIndex(
      'outbound_requests',
      'by_path',
      '/subscribe',
    );
    expect(subscribeRows).toHaveLength(1);
    expect(subscribeRows[0]?.method).toBe('POST');

    // by_status → queryable with an equality bound
    const statusRows = await db.getAllFromIndex(
      'outbound_requests',
      'by_status',
      500,
    );
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]?.path).toBe('/subscribe');
    db.close();
  });

  it('fresh v2 install does not double-run v1 object-store creation', async () => {
    // A clean open at DB_VERSION=2 should produce a single set of stores
    // (no IDB exception about duplicate store names inside a single upgrade).
    const db = await openDb();
    const names = Array.from(db.objectStoreNames).sort();
    // Exactly 7 stores — one "events", not two.
    expect(names.filter((n) => n === 'events')).toHaveLength(1);
    expect(names.filter((n) => n === 'outbound_requests')).toHaveLength(1);
    db.close();
  });

  it('v1 → v2 migration adds outbound_requests without dropping existing stores or data', async () => {
    // Open the DB at v1 with just the original stores, seed one row, close,
    // then re-open at current DB_VERSION and confirm existing data survives
    // and `outbound_requests` is newly present.
    const { openDB } = await import('idb');
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const events = db.createObjectStore('events', {
          keyPath: 'id',
          autoIncrement: true,
        });
        events.createIndex('by_ts', 'ts');
        events.createIndex('by_tab', 'tabId');
        events.createIndex('by_type_ts', ['type', 'ts']);
        events.createIndex('by_domain', 'domain');
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by_week_start', 'weekStart');
        db.createObjectStore('weekly_summaries', { keyPath: 'weekStart' });
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('blocklist', { keyPath: 'domain' });
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('by_status', 'status');
      },
    });
    await v1.add('events', {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'preserved.example',
      schemaVersion: 1,
      // biome-ignore lint/suspicious/noExplicitAny: raw v1 write
    } as any);
    v1.close();

    const v2 = await openDb();
    expect(DB_VERSION).toBeGreaterThanOrEqual(2);
    expect(Array.from(v2.objectStoreNames)).toContain('outbound_requests');
    const events = await v2.getAll('events');
    expect(events).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: TabEvent union covered in types
    expect((events[0] as any).domain).toBe('preserved.example');
    expect(await v2.count('outbound_requests')).toBe(0);
    v2.close();
  });
});
