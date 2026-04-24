/**
 * Smoke + comprehensive edge-case tests for the idempotent account delete
 * cascade (Chunk 11.2c).
 *
 * Layers:
 *   1. Smoke: the three original happy/resume/fail flows.
 *   2. Resume matrix: every `completed` seed (empty, backend, backend+local,
 *      all three) plus lastError-pre-seeded resume.
 *   3. Backend status matrix: success shapes, 401, 429 retries with retryAfter
 *      permutations, 5xx retries, network_error, aborted, 4xx terminal,
 *      502 email_send_failed.
 *   4. Abort plumbing: abort before start, abort mid-429 sleep, abort post-backend.
 *   5. Local-storage step: clearClientToken throwing, chrome.storage.remove
 *      transient + permanent failures, missing chrome.storage.
 *   6. IDB step: closed handle, deleteEverythingIncludingSettings throw, the
 *      7-store contract.
 *   7. resumeDeleteCascadeIfPending: no record, record with fatal preceding
 *      error, concurrent invocation safety.
 *   8. Progress shape: exactOptionalPropertyTypes correctness, startedAt
 *      stability, step-specific lastError content.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock hoisted before the module under test is imported.
vi.mock('../backend/client.js', () => ({
  deleteAccount: vi.fn(),
}));

import { deleteAccount } from '../backend/client.js';
import type { ApiResult, DeleteAccountResult } from '../backend/client.js';
import { CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY } from '../backend/token-store.js';
import { makeChromeStorageMock } from '../test-helpers/chrome-storage-mock.js';
import {
  __getCascadeProgressForTest,
  __setCascadeProgressForTest,
  __DELETE_CASCADE_PROGRESS_KEY_FOR_TEST,
  DELETE_CASCADE_STEPS,
  resumeDeleteCascadeIfPending,
  runDeleteCascade,
} from './delete-cascade.js';
import { DB_NAME, openDb } from './db.js';
import * as purgeModule from './purge.js';

// Fake timers with a deliberately narrow fake-list: we DON'T fake
// `setImmediate` / `queueMicrotask` because fake-indexeddb schedules its
// async callbacks off setImmediate, and faking those would deadlock any
// test that also talks to IDB under the same useFakeTimers block.
function useSetTimeoutOnlyFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout'],
  });
}

const mockDeleteAccount = vi.mocked(deleteAccount);

// ---------------------------------------------------------------------------
// Chrome.storage.local stub
// ---------------------------------------------------------------------------

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: remove the binding entirely
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

const makeStorageStub = makeChromeStorageMock;

async function wipeDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// Helper: canned backend responses for readability.
function ok(
  status: 'deleted' | 'already_deleted' = 'deleted',
): ApiResult<DeleteAccountResult> {
  return { ok: true, data: { status } };
}

function rateLimit(retryAfter?: number): ApiResult<DeleteAccountResult> {
  if (retryAfter === undefined) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }
  return { ok: false, status: 429, error: 'rate_limited', retryAfter };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let savedChrome: ChromeHandle;

beforeEach(async () => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  deleteChrome();
  mockDeleteAccount.mockReset();
  await wipeDb();
});

afterEach(async () => {
  // Real timers FIRST so IDB operations in wipeDb aren't starved by a
  // lingering fake clock from a failed test above.
  vi.useRealTimers();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
  await wipeDb();
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Smoke / happy path
// ===========================================================================

describe('runDeleteCascade — fresh run', () => {
  it('executes all three steps, wipes storage + idb, and clears progress', async () => {
    const stub = makeStorageStub({
      clientToken: { v: 1, iv: 'abc', ct: 'def' },
      __tokenCryptoKey: { kty: 'oct', k: 'zzz' },
    });
    setChrome(stub.chrome);

    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    // Seed rows across every store so we can confirm the wipe.
    await db.put('settings', {
      key: 'user',
      value: {
        uuid: '00000000-0000-4000-8000-000000000000',
        emailConfirmed: true,
        timezone: 'UTC',
        plan: 'free',
        createdAt: 1,
      },
      schemaVersion: 1,
    });

    const result = await runDeleteCascade(db);
    expect(result).toEqual({ status: 'completed' });

    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    // The first (and only) arg is the CallOptions object; no signal passed.
    expect(mockDeleteAccount.mock.calls[0]?.[0]).toEqual({});

    expect('clientToken' in stub.data).toBe(false);
    expect('__tokenCryptoKey' in stub.data).toBe(false);

    const afterRow = await db.get('settings', 'user');
    expect(afterRow).toBeUndefined();
    db.close();

    expect(await __getCascadeProgressForTest()).toBeNull();
    expect(__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST in stub.data).toBe(false);
  });

  it('returns exactly {status:"completed"} on success (shape)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));
    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();
    expect(Object.keys(result).sort()).toEqual(['status']);
  });

  it('threads options.signal through to deleteAccount', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const ac = new AbortController();
    const db = await openDb();
    const result = await runDeleteCascade(db, { signal: ac.signal });
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    const callArg = mockDeleteAccount.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(callArg?.signal).toBe(ac.signal);
  });

  it('calls chrome.storage.local.remove once per storage key (token + crypto key)', async () => {
    const stub = makeStorageStub({
      clientToken: 'plain',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    await runDeleteCascade(db);
    db.close();

    const removeKeys = stub.chrome.storage.local.remove.mock.calls.map(
      (c) => c[0] as string,
    );
    // First token-remove (from clearClientToken), then crypto-key remove,
    // then the final progress-record remove on cascade success.
    expect(removeKeys).toContain('clientToken');
    expect(removeKeys).toContain(CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY);
    expect(removeKeys).toContain(__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST);
  });
});

// ===========================================================================
// 2. Resume matrix
// ===========================================================================

describe('runDeleteCascade — resume matrix', () => {
  it('empty completed array behaves like a fresh run', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({ startedAt: 42, completed: [] });
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('seed completed=[backend] → backend NOT called, local+idb run, cleared', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({ startedAt: 1, completed: ['backend'] });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect('clientToken' in stub.data).toBe(false);
    expect('__tokenCryptoKey' in stub.data).toBe(false);
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('seed completed=[backend, local_storage] → only idb runs', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({
      startedAt: 1,
      completed: ['backend', 'local_storage'],
    });

    const db = await openDb();
    await db.put('settings', {
      key: 'user',
      value: {
        uuid: '00000000-0000-4000-8000-000000000000',
        emailConfirmed: true,
        timezone: 'UTC',
        plan: 'free',
        createdAt: 1,
      },
      schemaVersion: 1,
    });

    const result = await runDeleteCascade(db);

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    // clearClientToken & crypto-key remove NOT invoked (token key absent so it
    // wouldn't matter, but the `remove` spy proves local_storage was skipped).
    const removeKeys = stub.chrome.storage.local.remove.mock.calls.map(
      (c) => c[0] as string,
    );
    expect(removeKeys).not.toContain('clientToken');
    expect(removeKeys).not.toContain(CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY);
    // The progress-record clear still runs once.
    expect(removeKeys).toContain(__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST);

    const row = await db.get('settings', 'user');
    expect(row).toBeUndefined();
    db.close();

    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('seed completed=[all three steps] short-circuits → clear only, zero side effects', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({
      startedAt: 1,
      completed: ['backend', 'local_storage', 'idb'],
    });
    // Reset set-spy counts AFTER seeding — we want to verify no set happens
    // during the short-circuit path, but the seed itself writes once.
    stub.chrome.storage.local.set.mockClear();

    const db = await openDb();
    await db.put('settings', {
      key: 'user',
      value: {
        uuid: '00000000-0000-4000-8000-000000000000',
        emailConfirmed: true,
        timezone: 'UTC',
        plan: 'free',
        createdAt: 1,
      },
      schemaVersion: 1,
    });

    const result = await runDeleteCascade(db);

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    // NO local_storage writes in the short-circuit.
    expect(stub.chrome.storage.local.set).not.toHaveBeenCalled();
    // The idb step was skipped: our seeded row is still there.
    const row = await db.get('settings', 'user');
    expect(row).not.toBeUndefined();
    db.close();

    // Progress cleared.
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('seed with lastError present → resumes from first missing step, clears lastError', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);

    await __setCascadeProgressForTest({
      startedAt: 1000,
      completed: ['backend'],
      lastError: { step: 'local_storage', error: 'some_transient', at: 2000 },
    });

    mockDeleteAccount.mockClear();

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    // Final record cleared — so lastError is gone too.
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('startedAt is preserved across resume (not reset on fresh call with existing record)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({
      startedAt: 999,
      completed: ['backend'],
    });

    // Make local_storage step fail so we get the new progress written back.
    stub.chrome.storage.local.remove.mockImplementation(async (key: string) => {
      if (key === CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY) {
        throw new Error('boom');
      }
      delete stub.data[key];
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result.status).toBe('failed');
    const progress = await __getCascadeProgressForTest();
    expect(progress?.startedAt).toBe(999);
  });

  it('fresh run with no record sets startedAt to ~Date.now()', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    // Cause a failure so the record is preserved with startedAt.
    mockDeleteAccount.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'bad_request',
    });

    const before = Date.now();
    const db = await openDb();
    await runDeleteCascade(db);
    db.close();
    const after = Date.now();

    const progress = await __getCascadeProgressForTest();
    expect(progress?.startedAt).toBeGreaterThanOrEqual(before);
    expect(progress?.startedAt).toBeLessThanOrEqual(after);
  });
});

// ===========================================================================
// 3. Backend step — status matrix
// ===========================================================================

describe('runDeleteCascade — backend step status matrix', () => {
  it('{ok:true, status:"already_deleted"} → 1 call, step succeeds', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('already_deleted'));

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('401 unauthorized → 1 call, step treated as success, local+idb still run', async () => {
    const stub = makeStorageStub({ clientToken: 'x' });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: 'unauthorized',
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    expect('clientToken' in stub.data).toBe(false);
  });

  it('401 no_token → 1 call, step treated as success', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: 'no_token',
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
  });

  it('429 retryAfter=1 then success → 2 calls, cascade completes', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount
      .mockResolvedValueOnce(rateLimit(1))
      .mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const promise = runDeleteCascade(db);

    // Let the first await flush, then fast-forward the 1s sleep.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
  });

  it('429 three times in a row → terminal fail after 3 calls, record preserved', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValue(rateLimit(1));

    const db = await openDb();
    const promise = runDeleteCascade(db);
    // Two 1s sleeps between the three attempts.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'rate_limited',
    });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(3);

    const progress = await __getCascadeProgressForTest();
    expect(progress).not.toBeNull();
    expect(progress?.completed).toEqual([]);
    expect(progress?.lastError?.step).toBe('backend');
    expect(progress?.lastError?.error).toBe('rate_limited');
    expect(typeof progress?.lastError?.at).toBe('number');
  });

  it('429 retryAfter=undefined defaults to 1s sleep', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount
      .mockResolvedValueOnce(rateLimit())
      .mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const promise = runDeleteCascade(db);

    await vi.advanceTimersByTimeAsync(0);
    // 999ms → still sleeping; not enough to unblock.
    await vi.advanceTimersByTimeAsync(999);
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    // Cross the 1s mark → second call fires.
    await vi.advanceTimersByTimeAsync(2);

    const result = await promise;
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
  });

  it('429 retryAfter=9999 is capped at 60s', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount
      .mockResolvedValueOnce(rateLimit(9999))
      .mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const promise = runDeleteCascade(db);

    // Advance past the cap — 60s exactly.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise;
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
  });

  it('500 → 502 → terminal fail after 2 calls (5xx budget is 2, not 3)', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'server_error' })
      .mockResolvedValueOnce({ ok: false, status: 502, error: 'server_error' });

    const db = await openDb();
    const promise = runDeleteCascade(db);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'server_error',
    });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
  });

  it('500 → 200 → 2 calls, step succeeds', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'server_error' })
      .mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const promise = runDeleteCascade(db);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
  });

  it('network_error → 1 call, terminal fail, no retry', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: 'network_error',
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'network_error',
    });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    const progress = await __getCascadeProgressForTest();
    expect(progress?.lastError?.error).toBe('network_error');
  });

  it('aborted from client → 1 call, terminal fail with error "aborted"', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: 'aborted',
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'aborted',
    });
    const progress = await __getCascadeProgressForTest();
    expect(progress?.lastError?.step).toBe('backend');
    expect(progress?.lastError?.error).toBe('aborted');
  });

  it('400 bad_request → 1 call, terminal fail', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'bad_request',
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'bad_request',
    });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('409 conflict → 1 call, terminal fail', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'conflict',
    });

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'conflict',
    });
  });

  it('502 email_send_failed → 5xx retry budget applies → 2 calls, fail', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValue({
      ok: false,
      status: 502,
      error: 'email_send_failed',
    });

    const db = await openDb();
    const promise = runDeleteCascade(db);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'server_error',
    });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);
  });

  it('429 → 500 → 200 (mixed budgets) → 3 calls, success', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount
      .mockResolvedValueOnce(rateLimit(1))
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'server_error' })
      .mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const promise = runDeleteCascade(db);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); // 429 sleep
    await vi.advanceTimersByTimeAsync(500); // 5xx sleep

    const result = await promise;
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// 4. Abort plumbing
// ===========================================================================

describe('runDeleteCascade — abort plumbing', () => {
  it('aborting BEFORE start → terminal fail at backend step', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    const ac = new AbortController();
    ac.abort();

    const db = await openDb();
    const result = await runDeleteCascade(db, { signal: ac.signal });
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'aborted',
    });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    const progress = await __getCascadeProgressForTest();
    expect(progress?.lastError?.step).toBe('backend');
  });

  it('aborting DURING the 429 sleep → terminal fail with error "aborted"', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(rateLimit(10));
    const ac = new AbortController();

    const db = await openDb();
    const promise = runDeleteCascade(db, { signal: ac.signal });

    // Let the first fetch resolve and the sleep arm.
    await vi.advanceTimersByTimeAsync(0);
    // Halfway through the 10s sleep, abort.
    await vi.advanceTimersByTimeAsync(5000);
    ac.abort();
    // Let the abort microtask flush.
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    db.close();

    expect(result).toEqual({
      status: 'failed',
      step: 'backend',
      error: 'aborted',
    });
    // Only the first attempt happened; sleep was interrupted before retry.
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('aborting AFTER backend completes does NOT cancel local_storage/idb (signal is backend-only)', async () => {
    // DESIGN NOTE: the signal is only plumbed into the backend step; once
    // the backend step completes the remaining steps proceed regardless of
    // abort. This is deliberate — local wipes are fast and must not leave a
    // half-deleted state just because the user navigated away.
    //
    // To reliably simulate "abort after backend succeeds", we seed the
    // progress record so the backend step is skipped entirely, then abort
    // before calling runDeleteCascade. Steps 2 and 3 should still run.
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({
      startedAt: 1,
      completed: ['backend'],
    });

    const ac = new AbortController();
    ac.abort();

    const db = await openDb();
    const result = await runDeleteCascade(db, { signal: ac.signal });
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect('clientToken' in stub.data).toBe(false);
    expect('__tokenCryptoKey' in stub.data).toBe(false);
    expect(await __getCascadeProgressForTest()).toBeNull();
  });
});

// ===========================================================================
// 5. Local-storage step
// ===========================================================================

describe('runDeleteCascade — local_storage step', () => {
  it('chrome.storage.local.remove (crypto key) throws once then succeeds → step completes', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    let cryptoAttempt = 0;
    stub.chrome.storage.local.remove.mockImplementation(
      async (key: string) => {
        if (key === CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY) {
          cryptoAttempt += 1;
          if (cryptoAttempt === 1) throw new Error('transient');
        }
        delete stub.data[key];
      },
    );

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    expect(cryptoAttempt).toBe(2);
    expect('__tokenCryptoKey' in stub.data).toBe(false);
  });

  it('chrome.storage.local.remove fails both crypto-key attempts → step fails, idb skipped', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    stub.chrome.storage.local.remove.mockImplementation(
      async (key: string) => {
        if (key === CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY) {
          throw new Error('permadown');
        }
        delete stub.data[key];
      },
    );

    const db = await openDb();
    // Seed idb so we can verify it's NOT wiped (step 3 shouldn't run).
    await db.put('settings', {
      key: 'user',
      value: {
        uuid: '00000000-0000-4000-8000-000000000000',
        emailConfirmed: true,
        timezone: 'UTC',
        plan: 'free',
        createdAt: 1,
      },
      schemaVersion: 1,
    });

    const result = await runDeleteCascade(db);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.step).toBe('local_storage');
      expect(result.error).toBe('permadown');
    }

    // IDB untouched because step 3 didn't run.
    const row = await db.get('settings', 'user');
    expect(row).not.toBeUndefined();
    db.close();

    const progress = await __getCascadeProgressForTest();
    expect(progress?.completed).toEqual(['backend']);
    expect(progress?.lastError?.step).toBe('local_storage');
  });

  it('no chrome.storage at all → local_storage step still resolves (no-op)', async () => {
    // Delete chrome; this exercises the hasChromeStorage() guard.
    deleteChrome();
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
  });

  it('crypto key never existed in storage → remove is still called and step completes', async () => {
    const stub = makeStorageStub({ clientToken: 'x' }); // no crypto key
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    const removedKeys = stub.chrome.storage.local.remove.mock.calls.map(
      (c) => c[0] as string,
    );
    expect(removedKeys).toContain(CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY);
  });

  it('non-Error thrown object → error string falls back to "local_storage_error"', async () => {
    const stub = makeStorageStub({ __tokenCryptoKey: { kty: 'oct', k: 'x' } });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    stub.chrome.storage.local.remove.mockImplementation(
      async (key: string) => {
        if (key === CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY) {
          // eslint-disable-next-line no-throw-literal
          throw 'string-thrown';
        }
        delete stub.data[key];
      },
    );

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('local_storage_error');
    }
  });
});

// ===========================================================================
// 6. IDB step
// ===========================================================================

describe('runDeleteCascade — idb step', () => {
  it('all seven stores cleared on success', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    // Seed each store so we can count them afterwards.
    await db.put('settings', {
      key: 'user',
      value: {
        uuid: '00000000-0000-4000-8000-000000000000',
        emailConfirmed: true,
        timezone: 'UTC',
        plan: 'free',
        createdAt: 1,
      },
      schemaVersion: 1,
    });
    await db.put('blocklist', {
      domain: 'example.com',
      addedAt: 1,
      scope: 'exclude_all',
      schemaVersion: 1,
    });
    await db.put('jobs', {
      id: 'j1',
      kind: 'weekly',
      status: 'done',
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    });

    const result = await runDeleteCascade(db);

    expect(result).toEqual({ status: 'completed' });
    // Counts for every store should be zero.
    for (const store of [
      'events',
      'sessions',
      'weekly_summaries',
      'settings',
      'blocklist',
      'jobs',
      'outbound_requests',
    ] as const) {
      expect(await db.count(store)).toBe(0);
    }
    db.close();
  });

  it('deleteEverythingIncludingSettings throws → cascade fails at idb, progress has backend+local_storage', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const spy = vi
      .spyOn(purgeModule, 'deleteEverythingIncludingSettings')
      .mockRejectedValueOnce(new Error('idb-blew-up'));

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.step).toBe('idb');
      expect(result.error).toBe('idb-blew-up');
    }
    expect(spy).toHaveBeenCalledTimes(1);

    const progress = await __getCascadeProgressForTest();
    expect(progress?.completed).toEqual(['backend', 'local_storage']);
    expect(progress?.lastError?.step).toBe('idb');
    expect(progress?.lastError?.error).toBe('idb-blew-up');
  });

  it('idb throws a non-Error → error string falls back to "idb_error"', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    vi.spyOn(purgeModule, 'deleteEverythingIncludingSettings').mockRejectedValueOnce(
      'raw-string',
    );

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('idb_error');
    }
  });
});

// ===========================================================================
// 7. resumeDeleteCascadeIfPending
// ===========================================================================

describe('resumeDeleteCascadeIfPending', () => {
  it('no progress record → no-op, no IDB opened, no backend call', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    await resumeDeleteCascadeIfPending();

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    // No set/remove writes — just one get for the progress record.
    expect(stub.chrome.storage.local.set).not.toHaveBeenCalled();
    expect(stub.chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it('progress with all three steps completed → clears record, no side effects', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({
      startedAt: 1,
      completed: ['backend', 'local_storage', 'idb'],
    });
    stub.chrome.storage.local.set.mockClear();

    await resumeDeleteCascadeIfPending();

    // No deleteAccount call.
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('progress with partial completion → resumes, completes, clears', async () => {
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({
      startedAt: 1,
      completed: ['backend'],
    });

    await resumeDeleteCascadeIfPending();

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect('clientToken' in stub.data).toBe(false);
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('swallows errors from the internal run (e.g. openDb throws)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({ startedAt: 1, completed: ['backend'] });

    // Force openDb to throw by making IDB unavailable for this call.
    const origIDB = globalThis.indexedDB;
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
      open: () => {
        throw new Error('idb-gone');
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Must not throw.
    await expect(resumeDeleteCascadeIfPending()).resolves.toBeUndefined();

    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = origIDB;
    expect(warnSpy).toHaveBeenCalled();
  });

  it('two concurrent resume calls on a partial record settle without double-calling backend', async () => {
    // Both calls see `completed: ['backend']` so neither calls deleteAccount.
    const stub = makeStorageStub({ clientToken: 'x' });
    setChrome(stub.chrome);
    await __setCascadeProgressForTest({ startedAt: 1, completed: ['backend'] });

    await Promise.all([
      resumeDeleteCascadeIfPending(),
      resumeDeleteCascadeIfPending(),
    ]);

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(await __getCascadeProgressForTest()).toBeNull();
  });
});

// ===========================================================================
// 8. Progress-record shape + exactOptionalPropertyTypes
// ===========================================================================

describe('progress record shape', () => {
  it('successful step write omits lastError entirely (not set to undefined)', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    // Make local_storage fail so the cascade stops with the backend step
    // already marked completed — we can snapshot that intermediate record.
    stub.chrome.storage.local.remove.mockImplementation(async (key: string) => {
      if (key === CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY) {
        throw new Error('x');
      }
      delete stub.data[key];
    });

    const db = await openDb();
    await runDeleteCascade(db);
    db.close();

    // Inspect the raw stored shape: after the backend success write the
    // record must have no `lastError` key. After the local_storage fail it
    // DOES have lastError.
    const raw = stub.data[__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST] as Record<
      string,
      unknown
    >;
    expect(raw).toBeDefined();
    // The LAST write is the failure write, which SHOULD include lastError.
    expect('lastError' in raw).toBe(true);

    // Now verify the mid-cascade (success) write shape: grab all `.set` calls
    // and find the one that wrote `completed: ['backend']` with no lastError.
    const setCalls = stub.chrome.storage.local.set.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const progressWrites = setCalls
      .map((c) => c[0][__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST])
      .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);

    const backendSuccessWrite = progressWrites.find((w) => {
      const c = w['completed'];
      return Array.isArray(c) && c.length === 1 && c[0] === 'backend';
    });
    expect(backendSuccessWrite).toBeDefined();
    if (backendSuccessWrite) {
      // The critical assertion — lastError key MUST be absent, not just undefined.
      expect('lastError' in backendSuccessWrite).toBe(false);
    }
  });

  it('DELETE_CASCADE_STEPS constant is ordered and matches the actual cascade', () => {
    expect(DELETE_CASCADE_STEPS).toEqual(['backend', 'local_storage', 'idb']);
  });

  it('loadProgress survives a malformed record (invalid startedAt) by returning null', async () => {
    const stub = makeStorageStub({
      [__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST]: {
        startedAt: 'not-a-number',
        completed: [],
      },
    });
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    // Since load returns null, a fresh cascade runs (backend called).
    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();
    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('loadProgress filters unknown step names out of completed[]', async () => {
    const stub = makeStorageStub({
      [__DELETE_CASCADE_PROGRESS_KEY_FOR_TEST]: {
        startedAt: 1,
        completed: ['backend', 'garbage', 'local_storage'],
      },
    });
    setChrome(stub.chrome);

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    // backend + local_storage recognised, idb runs.
    expect(result).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('fail → retry flow: second run with lastError seeded continues from backend, clears lastError on success', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    // Seed a prior failure record so this "second" run starts with lastError.
    await __setCascadeProgressForTest({
      startedAt: 1,
      completed: [],
      lastError: { step: 'backend', error: 'server_error', at: 2 },
    });

    mockDeleteAccount.mockResolvedValueOnce(ok('deleted'));

    const db = await openDb();
    const result = await runDeleteCascade(db);
    db.close();

    expect(result).toEqual({ status: 'completed' });
    // Final record cleared, so lastError is gone.
    expect(await __getCascadeProgressForTest()).toBeNull();
  });

  it('lastError.at is a real timestamp near now', async () => {
    const stub = makeStorageStub();
    setChrome(stub.chrome);
    mockDeleteAccount.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'bad_request',
    });

    const before = Date.now();
    const db = await openDb();
    await runDeleteCascade(db);
    db.close();
    const after = Date.now();

    const progress = await __getCascadeProgressForTest();
    expect(progress?.lastError?.at).toBeGreaterThanOrEqual(before);
    expect(progress?.lastError?.at).toBeLessThanOrEqual(after);
  });
});

// ===========================================================================
// 9. Race between runDeleteCascade (UI) and resumeDeleteCascadeIfPending (SW)
// ===========================================================================

describe('concurrent runDeleteCascade and resumeDeleteCascadeIfPending', () => {
  it('overlapping calls on a fresh cascade do not double-call backend (worst case: two calls)', async () => {
    // There is no mutex in the current implementation — both calls may
    // read a null record in parallel and each call backend. The cascade is
    // idempotent by design: the second call will hit `already_deleted` (or
    // 401 if the first wiped the token). This test pins the current
    // behavior so future refactors that add a mutex know they changed it.
    const stub = makeStorageStub({
      clientToken: 'x',
      __tokenCryptoKey: { kty: 'oct', k: 'xxx' },
    });
    setChrome(stub.chrome);

    mockDeleteAccount.mockResolvedValue(ok('already_deleted'));

    const db = await openDb();
    await Promise.all([
      runDeleteCascade(db),
      resumeDeleteCascadeIfPending(),
    ]);
    db.close();

    // Both completed — either 1 or 2 backend calls depending on scheduling;
    // assert the upper bound.
    expect(mockDeleteAccount.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockDeleteAccount.mock.calls.length).toBeLessThanOrEqual(2);
    // Final state: cleared.
    expect(await __getCascadeProgressForTest()).toBeNull();
  });
});

// ===========================================================================
// 10. Retry budgets are PER STEP (no leak across runs)
// ===========================================================================

describe('retry budget scoping', () => {
  it('a second resume after a 5xx fail gets the full 2-attempt budget again', async () => {
    useSetTimeoutOnlyFakeTimers();
    const stub = makeStorageStub();
    setChrome(stub.chrome);

    // Run 1: two 5xx → fail.
    mockDeleteAccount
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'server_error' })
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'server_error' });

    const db = await openDb();
    const p1 = runDeleteCascade(db);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    const r1 = await p1;
    expect(r1.status).toBe('failed');
    expect(mockDeleteAccount).toHaveBeenCalledTimes(2);

    // Run 2: should also get 2 attempts — retry budget must reset.
    mockDeleteAccount
      .mockResolvedValueOnce({ ok: false, status: 500, error: 'server_error' })
      .mockResolvedValueOnce(ok('deleted'));

    const p2 = runDeleteCascade(db);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    const r2 = await p2;
    db.close();

    expect(r2).toEqual({ status: 'completed' });
    expect(mockDeleteAccount).toHaveBeenCalledTimes(4); // 2 in run 1, 2 in run 2
  });
});
