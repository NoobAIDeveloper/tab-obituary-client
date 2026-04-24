import 'fake-indexeddb/auto';
import { SCHEMA_VERSION, exportBundleSchema } from '@tabob/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetOutboundLoggerForTest } from '../lib/outbound-logger.js';
import { DB_NAME, openDb } from './db.js';
import { appendEvent, countEvents } from './events-store.js';
import { logOutboundRequest } from './outbound-requests-store.js';
import {
  addBlocklistedDomain,
  deleteAllData,
  deleteEverythingIncludingSettings,
  exportAllData,
  listBlocklistedDomains,
  removeBlocklistedDomain,
} from './purge.js';
import {
  getPrivacy,
  getSchedule,
  getUser,
  setPrivacy,
  setSchedule,
  setUser,
} from './settings-store.js';

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
});
afterEach(async () => {
  await __resetOutboundLoggerForTest();
  await wipe();
});

describe('deleteAllData', () => {
  it('clears events, sessions, weekly_summaries, blocklist, and jobs but preserves settings', async () => {
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'a.com',
    });
    await db.put('sessions', {
      id: 'sess-1',
      weekStart: '2026-04-13',
      startTs: 1,
      endTs: 2,
      activeMs: 0,
      distinctUrls: 0,
      distinctDomains: 0,
      urls: [],
      status: 'segmented',
      schemaVersion: SCHEMA_VERSION,
    });
    await db.put('weekly_summaries', {
      weekStart: '2026-04-13',
      sections: {
        subject: '',
        preheader: '',
        rabbitHoles: [],
        themes: [],
        obsessions: [],
        ghostTabs: [],
        wow: [],
        tabsStillAlive: [],
        generatedWith: 'deterministic',
      },
      generatedAt: 1,
      schemaVersion: SCHEMA_VERSION,
    });
    await db.put('blocklist', {
      domain: 'x.com',
      addedAt: 1,
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    });
    await db.put('jobs', {
      id: 'j-1',
      kind: 'build-report',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: SCHEMA_VERSION,
    });
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });

    await deleteAllData(db);

    expect(await countEvents(db)).toBe(0);
    expect(await db.count('sessions')).toBe(0);
    expect(await db.count('weekly_summaries')).toBe(0);
    expect(await db.count('blocklist')).toBe(0);
    expect(await db.count('jobs')).toBe(0);
    // Settings preserved on purpose.
    const user = await getUser(db);
    expect(user?.uuid).toBe('00000000-0000-4000-8000-000000000000');
    db.close();
  });

  it('is a no-op on an empty database', async () => {
    const db = await openDb();
    await expect(deleteAllData(db)).resolves.toBeUndefined();
    db.close();
  });
});

describe('deleteEverythingIncludingSettings', () => {
  it('wipes every store including settings', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 2,
    });
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'a.com',
    });

    await deleteEverythingIncludingSettings(db);

    expect(await getUser(db)).toBeUndefined();
    expect(await getPrivacy(db)).toBeUndefined();
    expect(await countEvents(db)).toBe(0);
    db.close();
  });
});

describe('exportAllData', () => {
  it('produces a bundle that validates against exportBundleSchema', async () => {
    const db = await openDb();
    await appendEvent(db, {
      type: 'activate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 2,
    });
    await db.put('blocklist', {
      domain: 'x.com',
      addedAt: 10,
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    });

    const bundle = await exportAllData(db);
    expect(() => exportBundleSchema.parse(bundle)).not.toThrow();
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION);
    expect(bundle.events).toHaveLength(1);
    expect(bundle.blocklist).toHaveLength(1);
    expect(bundle.settings.user?.timezone).toBe('UTC');
    expect(bundle.settings.privacy?.trackingOptIn).toBe(true);
    // schedule was not set — field is optional and should be absent.
    expect(bundle.settings.schedule).toBeUndefined();
    db.close();
  });

  it('round-trips through JSON without loss', async () => {
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    const bundle = await exportAllData(db);
    const parsed = exportBundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.events).toHaveLength(bundle.events.length);
    db.close();
  });

  it('returns empty arrays and empty settings on a fresh database', async () => {
    const db = await openDb();
    const bundle = await exportAllData(db);
    expect(bundle.events).toEqual([]);
    expect(bundle.sessions).toEqual([]);
    expect(bundle.weeklySummaries).toEqual([]);
    expect(bundle.blocklist).toEqual([]);
    expect(bundle.outboundRequests).toEqual([]);
    expect(bundle.settings).toEqual({});
    expect(() => exportBundleSchema.parse(bundle)).not.toThrow();
    db.close();
  });

  it('includes outboundRequests when present, and they validate against the schema', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 123,
      method: 'POST',
      path: '/subscribe',
      status: 201,
      durationMs: 10,
      requestBodyHash: 'a'.repeat(64),
      authenticated: false,
    });
    await logOutboundRequest(db, {
      ts: 456,
      method: 'GET',
      path: '/export',
      status: 0,
      errorCode: 'network_error',
      requestBodyHash: null,
      authenticated: true,
    });
    const bundle = await exportAllData(db);
    expect(bundle.outboundRequests).toHaveLength(2);
    // sorted by ts ascending
    expect(bundle.outboundRequests[0]?.ts).toBe(123);
    expect(bundle.outboundRequests[1]?.ts).toBe(456);
    expect(() => exportBundleSchema.parse(bundle)).not.toThrow();
    db.close();
  });
});

describe('deleteAllData — outbound_requests', () => {
  it('clears outbound_requests', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/subscribe',
      status: 201,
      requestBodyHash: 'x'.repeat(64),
      authenticated: false,
    });
    expect(await db.count('outbound_requests')).toBe(1);
    await deleteAllData(db);
    expect(await db.count('outbound_requests')).toBe(0);
    db.close();
  });
});

describe('deleteEverythingIncludingSettings — outbound_requests', () => {
  it('also clears outbound_requests', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'GET',
      path: '/export',
      status: 200,
      requestBodyHash: null,
      authenticated: true,
    });
    await deleteEverythingIncludingSettings(db);
    expect(await db.count('outbound_requests')).toBe(0);
    db.close();
  });
});

describe('exportAllData — outbound_requests ordering & schema', () => {
  it('sorts outboundRequests ascending by ts across many rows', async () => {
    const db = await openDb();
    const timestamps = [500, 1, 200, 300, 50];
    for (const ts of timestamps) {
      await logOutboundRequest(db, {
        ts,
        method: 'POST',
        path: '/subscribe',
        status: 201,
        durationMs: 1,
        requestBodyHash: 'a'.repeat(64),
        authenticated: false,
      });
    }
    const bundle = await exportAllData(db);
    expect(bundle.outboundRequests.map((r) => r.ts)).toEqual(
      [...timestamps].sort((a, b) => a - b),
    );
    expect(() => exportBundleSchema.parse(bundle)).not.toThrow();
    db.close();
  });

  it('round-trips outboundRequests through JSON preserving order and every field', async () => {
    const db = await openDb();
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/subscribe',
      status: 201,
      durationMs: 42,
      requestBodyHash: 'b'.repeat(64),
      authenticated: false,
    });
    await logOutboundRequest(db, {
      ts: 2,
      method: 'GET',
      path: '/export',
      status: 500,
      errorCode: 'server_error',
      requestBodyHash: null,
      authenticated: true,
    });
    const bundle = await exportAllData(db);
    const rehydrated = exportBundleSchema.parse(
      JSON.parse(JSON.stringify(bundle)),
    );
    expect(rehydrated.outboundRequests).toHaveLength(2);
    expect(rehydrated.outboundRequests[0]?.method).toBe('POST');
    expect(rehydrated.outboundRequests[0]?.requestBodyHash).toBe('b'.repeat(64));
    expect(rehydrated.outboundRequests[1]?.errorCode).toBe('server_error');
    expect(rehydrated.outboundRequests[1]?.requestBodyHash).toBeNull();
    db.close();
  });
});

describe('deleteAllData — outbound_requests preservation', () => {
  it('preserves settings even when clearing outbound_requests', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    await logOutboundRequest(db, {
      ts: 1,
      method: 'POST',
      path: '/subscribe',
      status: 201,
      requestBodyHash: 'a'.repeat(64),
      authenticated: false,
    });
    await deleteAllData(db);
    expect(await db.count('outbound_requests')).toBe(0);
    expect((await getUser(db))?.uuid).toBe('00000000-0000-4000-8000-000000000000');
    db.close();
  });
});

describe('addBlocklistedDomain', () => {
  it('canonicalizes a raw eTLD+1 input and inserts the row', async () => {
    const db = await openDb();
    const { domain, purgedEvents } = await addBlocklistedDomain(db, 'example.com');
    expect(domain).toBe('example.com');
    expect(purgedEvents).toBe(0);
    const row = await db.get('blocklist', 'example.com');
    expect(row?.scope).toBe('exclude_all');
    expect(row?.schemaVersion).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('canonicalizes a full URL down to the eTLD+1', async () => {
    const db = await openDb();
    const { domain } = await addBlocklistedDomain(db, 'https://news.ycombinator.com/item?id=1');
    expect(domain).toBe('ycombinator.com');
    db.close();
  });

  it('canonicalizes a subdomain/www input and strips the www.', async () => {
    const db = await openDb();
    const { domain } = await addBlocklistedDomain(db, 'www.bbc.co.uk');
    expect(domain).toBe('bbc.co.uk');
    db.close();
  });

  it('purges existing matching events and returns the count', async () => {
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await appendEvent(db, {
      type: 'navigate',
      ts: 2,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await appendEvent(db, {
      type: 'navigate',
      ts: 3,
      tzOffsetMin: 0,
      tabId: 2,
      domain: 'other.com',
    });

    const { purgedEvents } = await addBlocklistedDomain(db, 'example.com');
    expect(purgedEvents).toBe(2);
    expect(await countEvents(db)).toBe(1);
    db.close();
  });

  it('is idempotent on repeated adds: row insert is a no-op, original addedAt is preserved', async () => {
    const db = await openDb();
    const first = await addBlocklistedDomain(db, 'example.com');
    const originalRow = await db.get('blocklist', 'example.com');
    const originalAddedAt = originalRow?.addedAt;

    // Wait so Date.now() would drift if the row were re-inserted.
    await new Promise((r) => setTimeout(r, 3));

    // Newly-logged event must still be purged by the second call.
    await appendEvent(db, {
      type: 'navigate',
      ts: 100,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });

    const second = await addBlocklistedDomain(db, 'example.com');
    expect(second.domain).toBe(first.domain);
    expect(second.purgedEvents).toBe(1);
    const afterRow = await db.get('blocklist', 'example.com');
    expect(afterRow?.addedAt).toBe(originalAddedAt);
    db.close();
  });

  it('rejects an empty string input', async () => {
    const db = await openDb();
    await expect(addBlocklistedDomain(db, '')).rejects.toThrow(/empty/i);
    await expect(addBlocklistedDomain(db, '   ')).rejects.toThrow(/empty/i);
    db.close();
  });

  it('accepts bare "Localhost" as the single-label allowlisted host', async () => {
    const db = await openDb();
    const { domain } = await addBlocklistedDomain(db, 'Localhost');
    expect(domain).toBe('localhost');
    db.close();
  });

  it('rejects non-domain free text', async () => {
    // "not a domain" has whitespace — isValidBlocklistDomain rejects it.
    const db = await openDb();
    await expect(addBlocklistedDomain(db, 'not a domain')).rejects.toThrow(/invalid/i);
    expect(await db.count('blocklist')).toBe(0);
    db.close();
  });

  it('rejects a scheme-only "https://" input', async () => {
    // canonicalDomain of https:// -> null; retry with https://https:// -> "https".
    // "https" has no dot and isn't allowlisted, so isValidBlocklistDomain fails.
    const db = await openDb();
    await expect(addBlocklistedDomain(db, 'https://')).rejects.toThrow(/invalid/i);
    expect(await db.count('blocklist')).toBe(0);
    db.close();
  });

  it('rejects a single-label junk input like "foo/bar/baz"', async () => {
    // No public suffix, no dot → isValidBlocklistDomain fails.
    const db = await openDb();
    await expect(addBlocklistedDomain(db, 'foo/bar/baz')).rejects.toThrow(/invalid/i);
    expect(await db.count('blocklist')).toBe(0);
    db.close();
  });
});

describe('removeBlocklistedDomain', () => {
  it('removes the row but does not restore previously-purged events', async () => {
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await addBlocklistedDomain(db, 'example.com');
    expect(await countEvents(db)).toBe(0);

    await removeBlocklistedDomain(db, 'example.com');
    const row = await db.get('blocklist', 'example.com');
    expect(row).toBeUndefined();
    // Events remain purged.
    expect(await countEvents(db)).toBe(0);
    db.close();
  });

  it('is a no-op when the domain is not in the blocklist', async () => {
    const db = await openDb();
    await expect(removeBlocklistedDomain(db, 'never-added.com')).resolves.toBeUndefined();
    db.close();
  });
});

describe('addBlocklistedDomain — adversarial canonicalization', () => {
  it('canonicalizes a URL with mixed case scheme + host to eTLD+1', async () => {
    const db = await openDb();
    const { domain } = await addBlocklistedDomain(db, 'https://WWW.Example.com/foo?bar=baz');
    expect(domain).toBe('example.com');
    const row = await db.get('blocklist', 'example.com');
    expect(row).toBeDefined();
    db.close();
  });

  it('trims leading/trailing whitespace around a bare eTLD+1', async () => {
    const db = await openDb();
    const { domain } = await addBlocklistedDomain(db, '  example.com  ');
    expect(domain).toBe('example.com');
    db.close();
  });

  it('canonicalizes a bare IPv4 with port via the https:// fallback to the host only', async () => {
    // "127.0.0.1:3000" alone fails both the direct tldts path and URL ctor;
    // the code retries with "https://127.0.0.1:3000" whose hostname is "127.0.0.1".
    const db = await openDb();
    const { domain } = await addBlocklistedDomain(db, '127.0.0.1:3000');
    expect(domain).toBe('127.0.0.1');
    db.close();
  });

  it('rejects non-domain free text with spaces', async () => {
    const db = await openDb();
    await expect(addBlocklistedDomain(db, 'not a domain')).rejects.toThrow(/invalid/i);
    expect(await db.count('blocklist')).toBe(0);
    db.close();
  });

  it('rejects a non-URL fallback input that has no dot', async () => {
    const db = await openDb();
    await expect(addBlocklistedDomain(db, 'foo/bar/baz')).rejects.toThrow(/invalid/i);
    expect(await db.count('blocklist')).toBe(0);
    db.close();
  });

  it('is truly idempotent: three repeated adds preserve the original addedAt', async () => {
    const db = await openDb();
    const first = await addBlocklistedDomain(db, 'example.com');
    const originalAddedAt = (await db.get('blocklist', 'example.com'))?.addedAt;
    expect(typeof originalAddedAt).toBe('number');

    await new Promise((r) => setTimeout(r, 3));
    await addBlocklistedDomain(db, 'example.com');
    await new Promise((r) => setTimeout(r, 3));
    await addBlocklistedDomain(db, 'example.com');

    const afterRow = await db.get('blocklist', 'example.com');
    expect(afterRow?.addedAt).toBe(originalAddedAt);
    expect(first.domain).toBe('example.com');
    db.close();
  });

  it('purges events whose stored domain is a subdomain of the blocklisted eTLD+1', async () => {
    // Events written pre-fix (or via a path that stored raw subdomains) must
    // still be purged by the belt-and-braces cursor sweep in addBlocklistedDomain.
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'www.example.com',
    });
    await appendEvent(db, {
      type: 'navigate',
      ts: 2,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await appendEvent(db, {
      type: 'navigate',
      ts: 3,
      tzOffsetMin: 0,
      tabId: 2,
      domain: 'm.example.com',
    });
    // And a url-only event with no `domain` field — should also match via the
    // url-canonicalisation fallback.
    await appendEvent(db, {
      type: 'navigate',
      ts: 4,
      tzOffsetMin: 0,
      tabId: 3,
      url: 'https://news.example.com/x',
    });
    // An unrelated event must survive.
    await appendEvent(db, {
      type: 'navigate',
      ts: 5,
      tzOffsetMin: 0,
      tabId: 4,
      domain: 'other.com',
    });
    const { purgedEvents } = await addBlocklistedDomain(db, 'example.com');
    expect(purgedEvents).toBe(4);
    expect(await countEvents(db)).toBe(1);
    db.close();
  });

  it('purges a large number of events for a single domain without dropping any', async () => {
    const db = await openDb();
    // 1000 sequential fake-indexeddb writes — slow on contended CPUs.
    const BATCH = 1000;
    for (let i = 0; i < BATCH; i++) {
      await appendEvent(db, {
        type: 'navigate',
        ts: i + 1,
        tzOffsetMin: 0,
        tabId: 1,
        domain: 'spam.example',
      });
    }
    // Also seed an unrelated event that MUST survive.
    await appendEvent(db, {
      type: 'navigate',
      ts: 999_999,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'keep.example',
    });
    const { purgedEvents } = await addBlocklistedDomain(db, 'spam.example');
    expect(purgedEvents).toBe(BATCH);
    expect(await countEvents(db)).toBe(1);
    db.close();
  }, 30_000);
});

describe('deleteAllData — adversarial', () => {
  it('preserves all three settings rows (user, privacy, schedule)', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 2,
    });
    await setSchedule(db, { preReportSent: true });

    await deleteAllData(db);

    expect((await getUser(db))?.uuid).toBeDefined();
    expect((await getPrivacy(db))?.trackingOptIn).toBe(true);
    expect((await getSchedule(db))?.preReportSent).toBe(true);
    db.close();
  });
});

describe('deleteEverythingIncludingSettings — adversarial', () => {
  it('leaves all three settings getters returning undefined', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 2,
    });
    await setSchedule(db, { preReportSent: true });

    await deleteEverythingIncludingSettings(db);

    expect(await getUser(db)).toBeUndefined();
    expect(await getPrivacy(db)).toBeUndefined();
    expect(await getSchedule(db)).toBeUndefined();
    db.close();
  });

  it('no-ops cleanly on an empty database', async () => {
    const db = await openDb();
    await expect(deleteEverythingIncludingSettings(db)).resolves.toBeUndefined();
    db.close();
  });
});

describe('exportAllData — adversarial', () => {
  it('exportedAt is within a tight window of Date.now() at call time', async () => {
    const db = await openDb();
    const before = Date.now();
    const bundle = await exportAllData(db);
    const after = Date.now();
    expect(bundle.exportedAt).toBeGreaterThanOrEqual(before);
    expect(bundle.exportedAt).toBeLessThanOrEqual(after);
    db.close();
  });

  it('captures all three settings rows when each is present', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 2,
    });
    await setSchedule(db, { preReportSent: true });
    const bundle = await exportAllData(db);
    expect(bundle.settings.user?.uuid).toBe('00000000-0000-4000-8000-000000000000');
    expect(bundle.settings.privacy?.trackingOptIn).toBe(true);
    expect(bundle.settings.schedule?.preReportSent).toBe(true);
    expect(() => exportBundleSchema.parse(bundle)).not.toThrow();
    db.close();
  });

  it('includes only the settings rows that actually exist (privacy only)', async () => {
    const db = await openDb();
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 2,
    });
    const bundle = await exportAllData(db);
    expect(bundle.settings.privacy).toBeDefined();
    expect(bundle.settings.user).toBeUndefined();
    expect(bundle.settings.schedule).toBeUndefined();
    expect(() => exportBundleSchema.parse(bundle)).not.toThrow();
    db.close();
  });

  it('round-trips a bundle with every EventType variant through JSON + schema', async () => {
    const db = await openDb();
    const types = [
      'open',
      'close',
      'activate',
      'deactivate',
      'navigate',
      'input_tick',
      'idle_state',
      'window_focus',
    ] as const;
    let ts = 1;
    for (const t of types) {
      await appendEvent(db, {
        type: t,
        ts: ts++,
        tzOffsetMin: 0,
        tabId: 1,
        domain: 'example.com',
        ...(t === 'idle_state' ? { idleState: 'active' as const } : {}),
        ...(t === 'window_focus' ? { windowFocused: true } : {}),
      });
    }
    const bundle = await exportAllData(db);
    const parsed = exportBundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.events.map((e) => e.type).sort()).toEqual([...types].sort());
    db.close();
  });
});

describe('removeBlocklistedDomain — adversarial', () => {
  it('previously purged events are not resurrected by remove', async () => {
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await addBlocklistedDomain(db, 'example.com');
    await removeBlocklistedDomain(db, 'example.com');
    // And no ghost rows reappear.
    expect(await countEvents(db)).toBe(0);
    db.close();
  });
});

describe('listBlocklistedDomains', () => {
  it('returns entries in newest-first order', async () => {
    const db = await openDb();
    await db.put('blocklist', {
      domain: 'old.com',
      addedAt: 10,
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    });
    await db.put('blocklist', {
      domain: 'newer.com',
      addedAt: 20,
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    });
    await db.put('blocklist', {
      domain: 'newest.com',
      addedAt: 30,
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    });
    const list = await listBlocklistedDomains(db);
    expect(list.map((e) => e.domain)).toEqual(['newest.com', 'newer.com', 'old.com']);
    db.close();
  });

  it('returns an empty array on an empty store', async () => {
    const db = await openDb();
    expect(await listBlocklistedDomains(db)).toEqual([]);
    db.close();
  });
});
