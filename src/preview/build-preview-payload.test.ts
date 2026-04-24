import { reportPayloadSchema } from '@tabob/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPreviewPayload,
  type HistoryClient,
} from './build-preview-payload.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const TIMEZONE = 'America/New_York';
// 2026-04-22T12:00:00Z
const NOW_MS = Date.UTC(2026, 3, 22, 12, 0, 0, 0);
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface HistoryClientMock extends HistoryClient {
  search: ReturnType<typeof vi.fn>;
  getVisits: ReturnType<typeof vi.fn>;
}

function makeEmptyHistoryClient(): HistoryClientMock {
  return {
    search: vi.fn().mockResolvedValue([]),
    getVisits: vi.fn().mockResolvedValue([]),
  };
}

function itemShape(url: string): chrome.history.HistoryItem {
  return { url, title: url };
}

function visitShape(ts: number): chrome.history.VisitItem {
  return {
    id: `v-${ts}`,
    visitId: ts,
    visitTime: ts,
    referringVisitId: 0,
    transition: 'link' as chrome.history.TransitionType,
  };
}

beforeEach(() => {
  // Default now to a fixed value in some tests via fake timers; individual
  // tests override per-case.
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildPreviewPayload — defaults and wiring', () => {
  it('default now = Date.now(); search called with [now - 24h, now) and maxResults 500', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
    const client = makeEmptyHistoryClient();
    await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
    });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith({
      text: '',
      startTime: NOW_MS - WINDOW_MS,
      endTime: NOW_MS,
      maxResults: 500,
    });
  });

  it('explicit now + windowMs override the defaults', async () => {
    const client = makeEmptyHistoryClient();
    await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
      windowMs: 60_000,
    });
    expect(client.search).toHaveBeenCalledWith({
      text: '',
      startTime: NOW_MS - 60_000,
      endTime: NOW_MS,
      maxResults: 500,
    });
  });

  it('calls getVisits once per HistoryItem (non-blocklisted)', async () => {
    const urls = [
      'https://a.test/1',
      'https://b.test/2',
      'https://c.test/3',
    ];
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue(urls.map(itemShape)),
      getVisits: vi.fn().mockResolvedValue([visitShape(NOW_MS - 60_000)]),
    };
    await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });
    expect(client.getVisits).toHaveBeenCalledTimes(3);
    const calls = client.getVisits.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(urls.map((url) => ({ url })));
  });

  it('skips blocklisted domains entirely — no getVisits roundtrip', async () => {
    const good = 'https://example.com/page';
    const bad = 'https://www.youtube.com/watch?v=xyz';
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue([itemShape(good), itemShape(bad)]),
      getVisits: vi.fn().mockResolvedValue([visitShape(NOW_MS - 60_000)]),
    };
    await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(['youtube.com']),
      historyClient: client,
      now: NOW_MS,
    });
    expect(client.getVisits).toHaveBeenCalledTimes(1);
    expect(client.getVisits).toHaveBeenCalledWith({ url: good });
  });
});

describe('buildPreviewPayload — payload contract', () => {
  it('result parses with reportPayloadSchema', async () => {
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue([itemShape('https://example.com/a')]),
      getVisits: vi.fn().mockResolvedValue([visitShape(NOW_MS - 60_000)]),
    };
    const payload = await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });
    expect(() => reportPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.preview).toBe(true);
  });

  it('user.uuid / timezone / plan pass through from input', async () => {
    const client = makeEmptyHistoryClient();
    const payload = await buildPreviewPayload({
      uuid: UUID,
      timezone: 'Europe/London',
      plan: 'paid',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });
    expect(payload.user.uuid).toBe(UUID);
    expect(payload.user.timezone).toBe('Europe/London');
    expect(payload.user.plan).toBe('paid');
  });

  it('empty history produces a valid payload (empty sessions/obsessions/etc.)', async () => {
    const client = makeEmptyHistoryClient();
    const payload = await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });
    expect(() => reportPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.candidateSessions).toEqual([]);
    expect(payload.obsessions).toEqual([]);
    expect(payload.tabsStillAlive).toEqual([]);
    expect(payload.totals.events).toBe(0);
  });
});

describe('buildPreviewPayload — concurrency cap', () => {
  it('getVisits runs at most 4 calls in flight at once (concurrency cap = 4)', async () => {
    // Install a deferred getVisits whose resolution we can observe. We count
    // the current in-flight calls and watch the peak.
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const getVisits = vi.fn(async (): Promise<chrome.history.VisitItem[]> => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve();
        });
      });
      return [];
    });

    const urls = Array.from({ length: 10 }, (_, i) => `https://a${i}.test/`);
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue(urls.map(itemShape)),
      getVisits: getVisits as unknown as HistoryClientMock['getVisits'],
    };

    const pending = buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });

    // Let workers start.
    await new Promise((r) => setTimeout(r, 5));
    expect(peak).toBeLessThanOrEqual(4);
    // We should have exactly 4 workers started (pool size = min(4, 10)).
    expect(peak).toBe(4);
    // Drain all pending calls one-by-one, allowing more work to be picked up.
    while (releases.length > 0) {
      const next = releases.shift();
      if (next) next();
      // Let microtasks run so the worker can grab the next URL.
      await new Promise((r) => setTimeout(r, 1));
    }
    await pending;
    expect(peak).toBeLessThanOrEqual(4);
    expect(getVisits).toHaveBeenCalledTimes(urls.length);
  });

  it('fewer URLs than the cap → pool size equals URL count', async () => {
    let peak = 0;
    let inFlight = 0;
    const releases: Array<() => void> = [];
    const getVisits = vi.fn(async (): Promise<chrome.history.VisitItem[]> => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve();
        });
      });
      return [];
    });

    const urls = ['https://a.test/', 'https://b.test/'];
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue(urls.map(itemShape)),
      getVisits: getVisits as unknown as HistoryClientMock['getVisits'],
    };

    const pending = buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(peak).toBe(2);
    while (releases.length > 0) {
      const next = releases.shift();
      if (next) next();
      await new Promise((r) => setTimeout(r, 1));
    }
    await pending;
  });
});

describe('buildPreviewPayload — AbortSignal', () => {
  it('aborting before the call throws AbortError without calling search', async () => {
    const client = makeEmptyHistoryClient();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      buildPreviewPayload({
        uuid: UUID,
        timezone: TIMEZONE,
        plan: 'free',
        blocklist: new Set(),
        historyClient: client,
        now: NOW_MS,
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('aborting mid-flight (during getVisits) throws AbortError', async () => {
    const ctrl = new AbortController();
    const getVisits = vi.fn(async (): Promise<chrome.history.VisitItem[]> => {
      // Allow the outer caller to abort before this resolves.
      ctrl.abort();
      return [];
    });
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue([itemShape('https://a.test/')]),
      getVisits: getVisits as unknown as HistoryClientMock['getVisits'],
    };
    await expect(
      buildPreviewPayload({
        uuid: UUID,
        timezone: TIMEZONE,
        plan: 'free',
        blocklist: new Set(),
        historyClient: client,
        now: NOW_MS,
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('getVisits throwing a non-abort error is swallowed (preview keeps going, visits=[])', async () => {
    const getVisits = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad read'))
      .mockResolvedValue([visitShape(NOW_MS - 60_000)]);
    const urls = ['https://a.test/', 'https://b.test/'];
    const client: HistoryClientMock = {
      search: vi.fn().mockResolvedValue(urls.map(itemShape)),
      getVisits: getVisits as unknown as HistoryClientMock['getVisits'],
    };
    const payload = await buildPreviewPayload({
      uuid: UUID,
      timezone: TIMEZONE,
      plan: 'free',
      blocklist: new Set(),
      historyClient: client,
      now: NOW_MS,
    });
    // Payload still valid; the bad-read URL just contributed no visits.
    expect(() => reportPayloadSchema.parse(payload)).not.toThrow();
  });
});
