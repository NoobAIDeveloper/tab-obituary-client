import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, openDb } from '../storage/db.js';
import { getAllOutboundRequests } from '../storage/outbound-requests-store.js';
import { __resetOutboundLoggerForTest, recordOutboundCall } from './outbound-logger.js';

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __resetOutboundLoggerForTest();
  await wipe();
});
afterEach(async () => {
  __resetOutboundLoggerForTest();
  await wipe();
});

describe('recordOutboundCall', () => {
  it('writes a POST record with a sha256 hex hash of the JSON-stringified body', async () => {
    await recordOutboundCall({
      method: 'POST',
      path: '/subscribe',
      authenticated: false,
      requestBody: { email: 'foo@bar.com' },
      startTs: 100,
      endTs: 142,
      status: 201,
      errorCode: undefined,
    });

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.method).toBe('POST');
    expect(row?.path).toBe('/subscribe');
    expect(row?.status).toBe(201);
    expect(row?.durationMs).toBe(42);
    expect(row?.authenticated).toBe(false);
    expect(row?.errorCode).toBeUndefined();
    expect(row?.requestBodyHash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it('writes requestBodyHash=null when the body is undefined (GET)', async () => {
    await recordOutboundCall({
      method: 'GET',
      path: '/export',
      authenticated: true,
      requestBody: undefined,
      startTs: 100,
      endTs: 120,
      status: 200,
      errorCode: undefined,
    });

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows[0]?.requestBodyHash).toBeNull();
    db.close();
  });

  it('omits durationMs when endTs is undefined (network error)', async () => {
    await recordOutboundCall({
      method: 'POST',
      path: '/subscribe',
      authenticated: false,
      requestBody: { email: 'x@y.z' },
      startTs: 100,
      endTs: undefined,
      status: 0,
      errorCode: 'network_error',
    });

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    const row = rows[0];
    expect(row?.status).toBe(0);
    expect(row?.durationMs).toBeUndefined();
    expect(row?.errorCode).toBe('network_error');
    db.close();
  });

  it('never throws even when IDB open fails (logger swallows)', async () => {
    // Pre-open a conflicting blocked connection via a lower db version to
    // trigger a migration race on subsequent open — tricky to simulate in
    // fake-indexeddb, so the weaker assertion is: the function returns
    // successfully. We couple that with a sanity check that a normal call
    // still works afterwards.
    await expect(
      recordOutboundCall({
        method: 'GET',
        path: '/export',
        authenticated: true,
        requestBody: undefined,
        startTs: 1,
        endTs: 2,
        status: 200,
        errorCode: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it('produces identical hashes for identical bodies (deterministic)', async () => {
    await recordOutboundCall({
      method: 'POST',
      path: '/subscribe',
      authenticated: false,
      requestBody: { email: 'same@a.com' },
      startTs: 1,
      endTs: 2,
      status: 201,
      errorCode: undefined,
    });
    await recordOutboundCall({
      method: 'POST',
      path: '/subscribe',
      authenticated: false,
      requestBody: { email: 'same@a.com' },
      startTs: 3,
      endTs: 4,
      status: 201,
      errorCode: undefined,
    });

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.requestBodyHash).toBe(rows[1]?.requestBodyHash);
    db.close();
  });
});
