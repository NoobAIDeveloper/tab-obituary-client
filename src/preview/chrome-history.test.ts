import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultHistoryClient } from './chrome-history.js';

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}
function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

let saved: ChromeHandle;

beforeEach(() => {
  saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
});
afterEach(() => {
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
});

describe('createDefaultHistoryClient — missing chrome surface', () => {
  it('chrome absent → search and getVisits resolve to []', async () => {
    deleteChrome();
    const client = createDefaultHistoryClient();
    await expect(client.search({ text: '' })).resolves.toEqual([]);
    await expect(client.getVisits({ url: 'https://x.test/' })).resolves.toEqual(
      [],
    );
  });

  it('chrome.history absent → resolve to []', async () => {
    setChrome({});
    const client = createDefaultHistoryClient();
    await expect(client.search({ text: '' })).resolves.toEqual([]);
    await expect(client.getVisits({ url: 'https://x.test/' })).resolves.toEqual(
      [],
    );
  });

  it('chrome.history present but search missing → both resolve to []', async () => {
    setChrome({ history: { getVisits: () => Promise.resolve([]) } });
    const client = createDefaultHistoryClient();
    await expect(client.search({ text: '' })).resolves.toEqual([]);
  });
});

describe('createDefaultHistoryClient — promise-returning (MV3) API', () => {
  it('forwards the query object unchanged to chrome.history.search', async () => {
    const items = [{ url: 'https://a.test/', title: 'A' }];
    const search = vi.fn().mockResolvedValue(items);
    setChrome({ history: { search, getVisits: vi.fn().mockResolvedValue([]) } });
    const client = createDefaultHistoryClient();
    const q = { text: '', startTime: 100, endTime: 200, maxResults: 500 };
    const out = await client.search(q);
    expect(search).toHaveBeenCalledWith(q);
    expect(out).toEqual(items);
  });

  it('forwards the url details unchanged to chrome.history.getVisits', async () => {
    const visits = [
      {
        id: 'v',
        visitId: 1,
        visitTime: 100,
        referringVisitId: 0,
        transition: 'link',
      },
    ];
    const getVisits = vi.fn().mockResolvedValue(visits);
    setChrome({ history: { search: vi.fn().mockResolvedValue([]), getVisits } });
    const client = createDefaultHistoryClient();
    const details = { url: 'https://a.test/' };
    const out = await client.getVisits(details);
    expect(getVisits).toHaveBeenCalledWith(details);
    expect(out).toEqual(visits);
  });
});

describe('createDefaultHistoryClient — callback-style (legacy) API', () => {
  it('search: when the native call returns a non-thenable, falls back to callback form', async () => {
    const items = [{ url: 'https://a.test/' }];
    // Two-phase mock: first call (no callback) returns `undefined`; the second call
    // with a callback invokes it synchronously with items.
    const search = vi.fn((q: unknown, cb?: (items: unknown[]) => void) => {
      if (typeof cb === 'function') {
        cb(items);
        return undefined;
      }
      return undefined;
    });
    setChrome({ history: { search, getVisits: vi.fn() } });
    const client = createDefaultHistoryClient();
    const out = await client.search({ text: '' });
    expect(out).toEqual(items);
    // Two calls: first probe (no cb), then callback-style with a function.
    expect(search.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('getVisits: legacy callback path resolves with visits', async () => {
    const visits = [{ id: 'v', visitId: 1, visitTime: 100 }];
    const getVisits = vi.fn((d: unknown, cb?: (v: unknown[]) => void) => {
      if (typeof cb === 'function') cb(visits);
      return undefined;
    });
    setChrome({ history: { search: vi.fn(), getVisits } });
    const client = createDefaultHistoryClient();
    const out = await client.getVisits({ url: 'https://a.test/' });
    expect(out).toEqual(visits);
  });

  it('callback with null items resolves to [] (forgiving of legacy null passthroughs)', async () => {
    const search = vi.fn((q: unknown, cb?: (items: unknown[] | null) => void) => {
      if (typeof cb === 'function') cb(null);
      return undefined;
    });
    setChrome({ history: { search, getVisits: vi.fn() } });
    const client = createDefaultHistoryClient();
    await expect(client.search({ text: '' })).resolves.toEqual([]);
  });
});

describe('createDefaultHistoryClient — throwing native API', () => {
  it('search that throws synchronously → resolves to [] (lock in defensive behaviour)', async () => {
    const search = vi.fn(() => {
      throw new Error('boom');
    });
    setChrome({ history: { search, getVisits: vi.fn() } });
    const client = createDefaultHistoryClient();
    await expect(client.search({ text: '' })).resolves.toEqual([]);
  });

  it('getVisits that throws synchronously → resolves to [] (lock in defensive behaviour)', async () => {
    const getVisits = vi.fn(() => {
      throw new Error('boom');
    });
    setChrome({ history: { search: vi.fn(), getVisits } });
    const client = createDefaultHistoryClient();
    await expect(
      client.getVisits({ url: 'https://x.test/' }),
    ).resolves.toEqual([]);
  });
});
