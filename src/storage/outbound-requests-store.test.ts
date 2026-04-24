import 'fake-indexeddb/auto';
import { SCHEMA_VERSION } from '@tabob/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetOutboundLoggerForTest } from '../lib/outbound-logger.js';
import { DB_NAME, openDb } from './db.js';
import {
  clearOutboundRequests,
  getAllOutboundRequests,
  logOutboundRequest,
} from './outbound-requests-store.js';

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// Reset the logger's cached DB handle even though these tests don't exercise
// the logger — otherwise a prior test file's open connection blocks our wipe.
beforeEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
});
afterEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
});

describe('logOutboundRequest', () => {
  it('stamps SCHEMA_VERSION and assigns an autoincrement id', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/subscribe',
      status: 201,
      durationMs: 42,
      requestBodyHash: 'a'.repeat(64),
      authenticated: false,
    });
    const all = await db.getAll('outbound_requests');
    expect(all).toHaveLength(1);
    expect(all[0]?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof all[0]?.id).toBe('number');
    db.close();
  });

  it('stores durationMs / errorCode as undefined when omitted', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'GET',
      path: '/export',
      status: 0,
      requestBodyHash: null,
      authenticated: true,
      errorCode: 'network_error',
    });
    const [row] = await db.getAll('outbound_requests');
    expect(row?.durationMs).toBeUndefined();
    expect(row?.errorCode).toBe('network_error');
    expect(row?.requestBodyHash).toBeNull();
    db.close();
  });

  it('swallows IDB errors silently (best-effort write)', async () => {
    const db = await openDb();
    db.close();
    // Writing to a closed db — must not throw.
    await expect(
      logOutboundRequest(db, {
        ts: 1,
        method: 'GET',
        path: '/export',
        status: 200,
        requestBodyHash: null,
        authenticated: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('getAllOutboundRequests', () => {
  it('returns rows sorted by ts ascending', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 30,
      method: 'POST',
      path: '/a',
      status: 200,
      requestBodyHash: null,
      authenticated: false,
    });
    await logOutboundRequest(db, {
      ts: 10,
      method: 'POST',
      path: '/b',
      status: 200,
      requestBodyHash: null,
      authenticated: false,
    });
    await logOutboundRequest(db, {
      ts: 20,
      method: 'POST',
      path: '/c',
      status: 200,
      requestBodyHash: null,
      authenticated: false,
    });
    const rows = await getAllOutboundRequests(db);
    expect(rows.map((r) => r.ts)).toEqual([10, 20, 30]);
    db.close();
  });

  it('returns an empty array on a fresh store', async () => {
    const db = await openDb();
    expect(await getAllOutboundRequests(db)).toEqual([]);
    db.close();
  });
});

describe('clearOutboundRequests', () => {
  it('removes every row', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'GET',
      path: '/x',
      status: 200,
      requestBodyHash: null,
      authenticated: true,
    });
    expect(await db.count('outbound_requests')).toBe(1);
    await clearOutboundRequests(db);
    expect(await db.count('outbound_requests')).toBe(0);
    db.close();
  });

  it('subsequent getAllOutboundRequests returns [] after clear', async () => {
    const db = await openDb();
    for (let i = 0; i < 5; i++) {
      await logOutboundRequest(db, {
        ts: i,
        method: 'POST',
        path: '/x',
        status: 200,
        requestBodyHash: null,
        authenticated: false,
      });
    }
    await clearOutboundRequests(db);
    expect(await getAllOutboundRequests(db)).toEqual([]);
    db.close();
  });

  it('no-op on an already-empty store', async () => {
    const db = await openDb();
    await expect(clearOutboundRequests(db)).resolves.toBeUndefined();
    expect(await db.count('outbound_requests')).toBe(0);
    db.close();
  });
});

describe('logOutboundRequest — comprehensive edge cases', () => {
  it('caller-supplied schemaVersion is ignored; logger stamps its own', async () => {
    const db = await openDb();
    // The store function takes Omit<..., 'id' | 'schemaVersion'> so callers
    // cannot even supply schemaVersion via the type system. Verify by casting.
    await logOutboundRequest(db, {
      ts: 1,
      method: 'GET',
      path: '/x',
      status: 200,
      requestBodyHash: null,
      authenticated: true,
      // biome-ignore lint/suspicious/noExplicitAny: adversarial cast
      schemaVersion: 99999 as any,
      // biome-ignore lint/suspicious/noExplicitAny: adversarial cast
    } as any);
    const [row] = await db.getAll('outbound_requests');
    expect(row?.schemaVersion).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('ids autoincrement across successive writes', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/a',
      status: 200,
      requestBodyHash: null,
      authenticated: false,
    });
    await logOutboundRequest(db, {
      ts: 2,
      method: 'POST',
      path: '/b',
      status: 200,
      requestBodyHash: null,
      authenticated: false,
    });
    const rows = await db.getAll('outbound_requests');
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids[0]).toBeLessThan(ids[1] ?? 0);
    db.close();
  });

  it('records a 64-hex requestBodyHash when the caller provides one', async () => {
    const db = await openDb();
    const hex = 'f'.repeat(64);
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/a',
      status: 200,
      requestBodyHash: hex,
      authenticated: false,
    });
    const [row] = await db.getAll('outbound_requests');
    expect(row?.requestBodyHash).toBe(hex);
    db.close();
  });

  it('records the hash_unavailable sentinel as-is', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/a',
      status: 200,
      requestBodyHash: 'hash_unavailable',
      authenticated: false,
    });
    const [row] = await db.getAll('outbound_requests');
    expect(row?.requestBodyHash).toBe('hash_unavailable');
    db.close();
  });
});

describe('getAllOutboundRequests — adversarial', () => {
  it('out-of-order ts writes are still sorted ascending on read', async () => {
    const db = await openDb();
    const timestamps = [100, 5, 10_000, 20, 0];
    for (const ts of timestamps) {
      await logOutboundRequest(db, {
        ts,
        method: 'GET',
        path: '/x',
        status: 200,
        requestBodyHash: null,
        authenticated: true,
      });
    }
    const rows = await getAllOutboundRequests(db);
    expect(rows.map((r) => r.ts)).toEqual([...timestamps].sort((a, b) => a - b));
    db.close();
  });

  it('handles duplicate ts values deterministically (sort is stable on equal keys)', async () => {
    const db = await openDb();
    for (const path of ['/first', '/second', '/third']) {
      await logOutboundRequest(db, {
        ts: 42,
        method: 'POST',
        path,
        status: 200,
        requestBodyHash: null,
        authenticated: false,
      });
    }
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(3);
    // All ts are equal; verify insertion order is preserved by the stable
    // sort (JavaScript Array.prototype.sort is spec-stable as of ES2019).
    expect(rows.map((r) => r.path)).toEqual(['/first', '/second', '/third']);
    db.close();
  });
});
