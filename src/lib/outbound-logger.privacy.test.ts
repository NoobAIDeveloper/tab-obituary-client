/**
 * Privacy invariants for the outbound-request logger.
 *
 * The logger MUST record only metadata about outbound backend calls.
 * This suite is the release-blocker safety net: every scenario here
 * stringifies the stored row and greps for sensitive shapes to ensure no
 * regression silently starts leaking bodies, tokens, query strings, or
 * full URLs.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteAccount,
  exportAccount,
  generateReport,
  subscribe,
  unsubscribe,
  updateSettings,
} from '../backend/client.js';
import { setBackendBaseUrl } from '../backend/config.js';
import { DB_NAME, openDb } from '../storage/db.js';
import { getAllOutboundRequests } from '../storage/outbound-requests-store.js';
import { jsonResponse, makeChromeStorageMock } from '../test-helpers/chrome-storage-mock.js';
import {
  __flushOutboundLoggerWritesForTest,
  __resetOutboundLoggerForTest,
  recordOutboundCall,
} from './outbound-logger.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: removing the binding entirely
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

const makeStorage = makeChromeStorageMock;

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function readRows(): Promise<ReturnType<typeof JSON.parse>[]> {
  const db = await openDb();
  const rows = await getAllOutboundRequests(db);
  db.close();
  return rows;
}

const BASE = 'https://api.test.example';
let savedChrome: ChromeHandle;

beforeEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  deleteChrome();
  setBackendBaseUrl(BASE);
});

afterEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
  setBackendBaseUrl(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Anything that looks remotely email-y or URL-y — used to forbid the literal
// from appearing anywhere in the serialized record.
function assertNoSensitiveShapes(serialized: string): void {
  expect(serialized).not.toContain('@');
  expect(serialized).not.toContain('https://');
  expect(serialized).not.toContain('http://');
  expect(serialized).not.toContain('Bearer');
  expect(serialized).not.toMatch(/\?.+=/);
}

describe('privacy invariants — subscribe', () => {
  it('does not persist the email address anywhere in the record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-1',
          clientToken: 'tok',
        }),
      ),
    );

    await subscribe('bharat@example.com');
    await __flushOutboundLoggerWritesForTest();

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('bharat@example.com');
    expect(serialized).not.toContain('bharat');
    expect(serialized).not.toContain('example.com');
    assertNoSensitiveShapes(serialized);
  });

  it('records a requestBodyHash that is exactly 64 lowercase hex chars (no leak of raw body)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-1',
          clientToken: 'tok',
        }),
      ),
    );

    await subscribe('foo@bar.com');
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    expect(row.requestBodyHash).toMatch(/^[0-9a-f]{64}$/);
    // The hash must not be the email or any substring thereof.
    expect(row.requestBodyHash).not.toContain('foo');
    expect(row.requestBodyHash).not.toContain('@');
  });

  it('path field never contains query params or scheme even with scrutiny', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-1',
          clientToken: 'tok',
        }),
      ),
    );

    await subscribe('a@b.co');
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    expect(row.path).toBe('/subscribe');
    expect(row.path).not.toContain('?');
    expect(row.path).not.toContain('https://');
    expect(row.path).not.toContain(BASE);
  });
});

describe('privacy invariants — authenticated calls', () => {
  it('Authorization header bearer token never appears in the stored record', async () => {
    const storage = makeStorage({ clientToken: 'sekrit-token-XYZ-98765' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'unsubscribed' })),
    );

    await unsubscribe();
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('sekrit-token-XYZ-98765');
    expect(serialized).not.toContain('Bearer');
    expect(row.authenticated).toBe(true);
  });

  it('secret-ish body key names (authorization, cookie) are NOT surfaced as separate fields', async () => {
    // generateReport with a payload containing keys that look like secrets.
    // The hash is the only footprint; no top-level `authorization` / `cookie`
    // should appear on the stored row.
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          sections: {
            subject: 'x',
            preheader: 'x',
            rabbitHoles: [],
            themes: [],
            obsessions: [],
            ghostTabs: [],
            wow: [],
            tabsStillAlive: [],
            generatedWith: 'deterministic',
          },
          emailHtml: '<p>x</p>',
          emailText: 'x',
        }),
      ),
    );

    const payload = {
      authorization: 'Bearer very-secret',
      cookie: 'session=abcd1234',
      nested: { password: 'hunter2' },
      week: { start: '2025-01-06', end: '2025-01-12' },
      preview: true,
    } as unknown as Parameters<typeof generateReport>[0];

    await generateReport(payload, { authenticated: true });
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('Bearer very-secret');
    expect(serialized).not.toContain('very-secret');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('session=abcd1234');
    expect(serialized).not.toContain('abcd1234');
    // Only the top-level expected fields exist on the record.
    const keys = Object.keys(row).sort();
    expect(keys).toEqual(
      [
        'id',
        'ts',
        'method',
        'path',
        'status',
        'durationMs',
        'requestBodyHash',
        'authenticated',
        'schemaVersion',
      ].sort(),
    );
  });

  it('a generateReport payload containing user email is NOT persisted as email', async () => {
    // Even if payload carries identifiable user fields in nested structures,
    // the logger must record only a hash and not a readable copy.
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          sections: {
            subject: 'x',
            preheader: 'x',
            rabbitHoles: [],
            themes: [],
            obsessions: [],
            ghostTabs: [],
            wow: [],
            tabsStillAlive: [],
            generatedWith: 'deterministic',
          },
          emailHtml: '<p>x</p>',
          emailText: 'x',
        }),
      ),
    );

    const payload = {
      user: { email: 'leaky@user.com', uuid: 'u-1' },
      week: { start: '2025-01-06', end: '2025-01-12' },
      preview: false,
    } as unknown as Parameters<typeof generateReport>[0];
    await generateReport(payload, { authenticated: true });
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('leaky@user.com');
    expect(serialized).not.toContain('@');
  });
});

describe('privacy invariants — uniform guarantees', () => {
  it.each([
    {
      label: 'subscribe',
      call: () => subscribe('foo@bar.com'),
      chrome: undefined,
      body: { status: 'subscribed', uuid: 'u', clientToken: 'tok' },
      status: 201,
    },
    {
      label: 'unsubscribe',
      call: () => unsubscribe(),
      chrome: () => makeStorage({ clientToken: 'tok' }).chrome,
      body: { status: 'unsubscribed' },
      status: 200,
    },
    {
      label: 'deleteAccount',
      call: () => deleteAccount(),
      chrome: () => makeStorage({ clientToken: 'tok' }).chrome,
      body: { status: 'deleted' },
      status: 200,
    },
    {
      label: 'exportAccount',
      call: () => exportAccount(),
      chrome: () => makeStorage({ clientToken: 'tok' }).chrome,
      body: { schemaVersion: 1, exportedAt: 1, user: {} },
      status: 200,
    },
    {
      label: 'updateSettings',
      call: () => updateSettings({ email: 'new@e.co' }),
      chrome: () => makeStorage({ clientToken: 'tok' }).chrome,
      body: { status: 'ok' },
      status: 200,
    },
  ])('$label → row contains no sensitive shapes', async ({ call, chrome, body, status }) => {
    if (chrome) setChrome(chrome());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, body)));
    await call();
    await __flushOutboundLoggerWritesForTest();

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const serialized = JSON.stringify(row);
    assertNoSensitiveShapes(serialized);
    // path never holds the full URL
    expect(row.path.startsWith('/')).toBe(true);
    expect(row.path).not.toContain(BASE);
    // requestBodyHash is either null or a 64-hex string
    if (row.requestBodyHash !== null) {
      expect(row.requestBodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('privacy invariants — recordOutboundCall directly', () => {
  it('a body that is itself a string of the bearer token is hashed, not stored raw', async () => {
    await recordOutboundCall({
      method: 'POST',
      path: '/subscribe',
      authenticated: false,
      // Adversarial: caller passes a string that looks like a bearer token.
      requestBody: 'Bearer absolutely-top-secret-token',
      startTs: 1,
      endTs: 2,
      status: 201,
      errorCode: undefined,
    });
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('absolutely-top-secret-token');
    expect(serialized).not.toContain('Bearer');
    expect(row.requestBodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a body whose JSON.stringify throws (circular) yields hash_unavailable without error', async () => {
    type Circular = { self?: Circular };
    const circ: Circular = {};
    circ.self = circ;
    await expect(
      recordOutboundCall({
        method: 'POST',
        path: '/subscribe',
        authenticated: false,
        requestBody: circ,
        startTs: 1,
        endTs: 2,
        status: 201,
        errorCode: undefined,
      }),
    ).resolves.toBeUndefined();
    await __flushOutboundLoggerWritesForTest();

    const [row] = await readRows();
    expect(row.requestBodyHash).toBe('hash_unavailable');
  });

  it('stores hash_unavailable when crypto.subtle is absent', async () => {
    const origCrypto = globalThis.crypto;
    // Remove subtle entirely.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: origCrypto.getRandomValues.bind(origCrypto) },
    });
    try {
      await recordOutboundCall({
        method: 'POST',
        path: '/subscribe',
        authenticated: false,
        requestBody: { email: 'foo@bar.com' },
        startTs: 1,
        endTs: 2,
        status: 201,
        errorCode: undefined,
      });
      await __flushOutboundLoggerWritesForTest();
      const [row] = await readRows();
      expect(row.requestBodyHash).toBe('hash_unavailable');
      // Sanity: not the empty string, not null, and not the raw body.
      expect(row.requestBodyHash).not.toBe('');
      expect(row.requestBodyHash).not.toBeNull();
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('foo@bar.com');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: origCrypto,
      });
    }
  });

  it('stores hash_unavailable when crypto.subtle.digest throws', async () => {
    const origCrypto = globalThis.crypto;
    const throwingSubtle = new Proxy(origCrypto.subtle, {
      get(target, p) {
        if (p === 'digest') {
          return (): Promise<ArrayBuffer> => {
            throw new Error('digest nope');
          };
        }
        return Reflect.get(target, p);
      },
    });
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: new Proxy(origCrypto, {
        get(t, p) {
          if (p === 'subtle') return throwingSubtle;
          return Reflect.get(t, p);
        },
      }),
    });
    try {
      await recordOutboundCall({
        method: 'POST',
        path: '/subscribe',
        authenticated: false,
        requestBody: { x: 1 },
        startTs: 1,
        endTs: 2,
        status: 201,
        errorCode: undefined,
      });
      await __flushOutboundLoggerWritesForTest();
      const [row] = await readRows();
      expect(row.requestBodyHash).toBe('hash_unavailable');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: origCrypto,
      });
    }
  });
});
