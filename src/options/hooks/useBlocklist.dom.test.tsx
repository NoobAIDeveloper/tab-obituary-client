// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../storage/db.js';
import { appendEvent } from '../../storage/events-store.js';
import { type BlocklistApi, useBlocklist } from './useBlocklist.js';

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
});
afterEach(() => {
  cleanup();
});

interface Capture {
  current: BlocklistApi | null;
}

function Harness(props: { capture: Capture }): VNode {
  const api = useBlocklist();
  props.capture.current = api;
  return <span data-testid="loading">{String(api.loading)}</span>;
}

async function awaitLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
}

describe('useBlocklist', () => {
  it('loads an empty list initially and reflects newly added entries', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;
    expect(api.entries).toEqual([]);

    await act(async () => {
      await api.add('example.com');
    });
    const next = cap.current as BlocklistApi;
    expect(next.entries.map((e) => e.domain)).toEqual(['example.com']);
  });

  it('add also purges existing matching events and returns the count', async () => {
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
    db.close();

    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;

    let result: { domain: string; purgedEvents: number } | undefined;
    await act(async () => {
      result = await api.add('example.com');
    });
    expect(result?.domain).toBe('example.com');
    expect(result?.purgedEvents).toBe(2);
  });

  it('remove drops the row and updates the hook state', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;

    await act(async () => {
      await api.add('a.com');
      await api.add('b.com');
    });
    const after = cap.current as BlocklistApi;
    expect(after.entries.map((e) => e.domain).sort()).toEqual(['a.com', 'b.com']);

    await act(async () => {
      await after.remove('a.com');
    });
    const final = cap.current as BlocklistApi;
    expect(final.entries.map((e) => e.domain)).toEqual(['b.com']);
  });

  it('newest entries appear first', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;

    await act(async () => {
      await api.add('oldest.com');
    });
    // Delay enough that the next addedAt differs.
    await new Promise((r) => setTimeout(r, 3));
    await act(async () => {
      await api.add('newer.com');
    });

    const final = cap.current as BlocklistApi;
    expect(final.entries.map((e) => e.domain)).toEqual(['newer.com', 'oldest.com']);
  });

  it('concurrent adds both land (chain serialises the writes)', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;

    await act(async () => {
      const p1 = api.add('one.com');
      const p2 = api.add('two.com');
      await Promise.all([p1, p2]);
    });
    const final = cap.current as BlocklistApi;
    const names = final.entries.map((e) => e.domain).sort();
    expect(names).toEqual(['one.com', 'two.com']);
  });

  it('IDB open failure resolves loading:false with empty entries and does not throw', async () => {
    const broken = {
      open: (): IDBOpenDBRequest => {
        throw new Error('forced open failure');
      },
      deleteDatabase: (): IDBOpenDBRequest => {
        throw new Error('n/a');
      },
      databases: async (): Promise<IDBDatabaseInfo[]> => [],
      cmp: (): number => 0,
    } as unknown as IDBFactory;
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = broken;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cap: Capture = { current: null };
      render(<Harness capture={cap} />);
      await awaitLoaded();
      const api = cap.current as BlocklistApi;
      expect(api.loading).toBe(false);
      expect(api.entries).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('unmount during initial load does not throw', async () => {
    const cap: Capture = { current: null };
    const { unmount } = render(<Harness capture={cap} />);
    unmount();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('concurrent add then remove for the same domain settles to remove', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;

    await act(async () => {
      // Fire-and-forget both; the enqueue chain serialises them.
      const p1 = api.add('race.example');
      const p2 = api.remove('race.example');
      await Promise.all([p1, p2]);
    });
    const final = cap.current as BlocklistApi;
    expect(final.entries.map((e) => e.domain)).not.toContain('race.example');
  });

  it('initial load returns entries newest-first from a pre-seeded store', async () => {
    const db = await openDb();
    await db.put('blocklist', {
      domain: 'oldest.example',
      addedAt: 10,
      scope: 'exclude_all',
      schemaVersion: 1,
    });
    await db.put('blocklist', {
      domain: 'newest.example',
      addedAt: 30,
      scope: 'exclude_all',
      schemaVersion: 1,
    });
    await db.put('blocklist', {
      domain: 'middle.example',
      addedAt: 20,
      scope: 'exclude_all',
      schemaVersion: 1,
    });
    db.close();

    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;
    expect(api.entries.map((e) => e.domain)).toEqual([
      'newest.example',
      'middle.example',
      'oldest.example',
    ]);
  });

  it('add rejects for empty input and leaves the entry list unchanged', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;
    const before = api.entries.slice();
    await act(async () => {
      await expect(api.add('   ')).rejects.toThrow(/empty/i);
    });
    const after = cap.current as BlocklistApi;
    expect(after.entries).toEqual(before);
  });

  it('a failing add leaves the chain usable for the next add (chain error is swallowed)', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as BlocklistApi;
    await act(async () => {
      await expect(api.add('')).rejects.toThrow();
    });
    // Next call must still succeed.
    await act(async () => {
      await api.add('recovery.example');
    });
    expect((cap.current as BlocklistApi).entries.map((e) => e.domain)).toContain(
      'recovery.example',
    );
  });
});
