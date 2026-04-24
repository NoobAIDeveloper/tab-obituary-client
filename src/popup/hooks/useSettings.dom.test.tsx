// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import type { VNode } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../storage/db.js';
import {
  getPrivacy,
  getSchedule,
  getUser,
  setPrivacy,
  setSchedule,
  setUser,
} from '../../storage/settings-store.js';
import { type SettingsApi, useSettings } from './useSettings.js';

// Replace the indexedDB factory per-test so each test gets an isolated
// in-memory store without needing deleteDatabase (which hangs waiting for
// open connections the hook holds).
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
});
afterEach(() => {
  cleanup();
});

interface Capture {
  current: SettingsApi | null;
}

function Harness(props: { capture: Capture }): VNode {
  const api = useSettings();
  // Write the latest api into the capture ref on every render so tests can
  // reach it after awaiting loading=false.
  props.capture.current = api;
  // Expose loading via a data-testid so tests can waitFor it deterministically.
  return (
    <div>
      <span data-testid="loading">{String(api.loading)}</span>
      <span data-testid="user-tz">{api.user?.timezone ?? ''}</span>
      <span data-testid="privacy-opt">{String(api.privacy?.trackingOptIn ?? '')}</span>
      <span data-testid="schedule-pre">{String(api.schedule?.preReportSent ?? '')}</span>
    </div>
  );
}

async function awaitLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
}

describe('useSettings — initial load', () => {
  it('starts in a loading state and resolves to undefined rows on empty DB', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    expect(cap.current).not.toBeNull();
    const api = cap.current as SettingsApi;
    expect(api.loading).toBe(false);
    expect(api.user).toBeUndefined();
    expect(api.privacy).toBeUndefined();
    expect(api.schedule).toBeUndefined();
  });

  it('hydrates from existing rows', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '11111111-1111-4111-8111-111111111111',
      emailConfirmed: true,
      timezone: 'Europe/London',
      plan: 'free',
      createdAt: 1,
    });
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: true,
      trackingPaused: false,
      installedAt: 2,
    });
    await setSchedule(db, { preReportSent: true });
    db.close();

    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    await waitFor(() => {
      expect(screen.getByTestId('user-tz').textContent).toBe('Europe/London');
    });
    const api = cap.current as SettingsApi;
    expect(api.user?.timezone).toBe('Europe/London');
    expect(api.privacy?.trackingOptIn).toBe(true);
    expect(api.schedule?.preReportSent).toBe(true);
  });
});

describe('useSettings — default synthesis on undefined rows', () => {
  it('updateUser synthesizes defaults when user row is absent', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;
    expect(api.user).toBeUndefined();

    await act(async () => {
      await api.updateUser({ email: 'hello@example.com' });
    });

    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.email).toBe('hello@example.com');
    expect(user?.plan).toBe('free');
    expect(user?.emailConfirmed).toBe(false);
    expect(user?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('updatePrivacy with an empty patch synthesizes defaults', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    await act(async () => {
      await api.updatePrivacy({});
    });

    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.trackingOptIn).toBe(false);
    expect(privacy?.cloudAiOptIn).toBe(false);
    expect(privacy?.trackingPaused).toBe(false);
    expect(typeof privacy?.installedAt).toBe('number');
  });

  it('updateSchedule synthesizes defaults', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    await act(async () => {
      await api.updateSchedule({ preReportSent: true });
    });

    const db = await openDb();
    const schedule = await getSchedule(db);
    db.close();
    expect(schedule?.preReportSent).toBe(true);
  });
});

describe('useSettings — concurrent writes serialize per-key', () => {
  it('two back-to-back updatePrivacy calls both land (the read-modify-write race is closed)', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    // Both calls are kicked off before either awaits. If the hook didn't
    // serialize, both would read the same (undefined) row, synthesize a
    // default, and only the second write's data would survive — the first
    // patch's trackingOptIn=true would be lost.
    await act(async () => {
      const p1 = api.updatePrivacy({ trackingOptIn: true });
      const p2 = api.updatePrivacy({ cloudAiOptIn: true });
      await Promise.all([p1, p2]);
    });

    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.trackingOptIn).toBe(true);
    expect(privacy?.cloudAiOptIn).toBe(true);
  });
});

describe('useSettings — validation rejects malformed patches', () => {
  it('throws (does not persist) on invalid email shape', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    let threw = false;
    await act(async () => {
      try {
        await api.updateUser({ email: 'not-a-valid-email' });
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(true);

    const db = await openDb();
    const user = await getUser(db);
    db.close();
    // Nothing should have been persisted because the whole merged row was rejected.
    expect(user).toBeUndefined();
  });

  it('throws on cast-escape invalid trackingPaused and does NOT mutate stored row', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    // Seed a known-good privacy row first so we can verify it stays untouched.
    await act(async () => {
      await api.updatePrivacy({ trackingOptIn: true });
    });
    const dbBefore = await openDb();
    const before = await getPrivacy(dbBefore);
    dbBefore.close();
    expect(before?.trackingOptIn).toBe(true);

    let threw = false;
    await act(async () => {
      try {
        await api.updatePrivacy({ trackingPaused: 'nope' as unknown as boolean });
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(true);

    const dbAfter = await openDb();
    const after = await getPrivacy(dbAfter);
    dbAfter.close();
    // Row is unchanged from the last valid state.
    expect(after).toEqual(before);
  });
});

describe('useSettings — default synthesis, additional coverage', () => {
  it('updatePrivacy({}) does not overwrite installedAt on subsequent calls (preserves original)', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    await act(async () => {
      await api.updatePrivacy({});
    });
    const db1 = await openDb();
    const first = await getPrivacy(db1);
    db1.close();
    const firstInstalledAt = first?.installedAt ?? 0;
    expect(firstInstalledAt).toBeGreaterThan(0);

    // Wait at least 2ms so Date.now() would differ if the code erroneously
    // re-synthesized defaults instead of merging the existing row.
    await new Promise((r) => setTimeout(r, 3));

    await act(async () => {
      await api.updatePrivacy({ trackingOptIn: true });
    });
    const db2 = await openDb();
    const second = await getPrivacy(db2);
    db2.close();
    expect(second?.installedAt).toBe(firstInstalledAt);
    expect(second?.trackingOptIn).toBe(true);
  });

  it('updateUser({}) synthesizes defaults with a generated uuid, free plan, detected timezone, emailConfirmed:false', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    await act(async () => {
      await api.updateUser({});
    });
    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user).toBeDefined();
    expect(user?.plan).toBe('free');
    expect(user?.emailConfirmed).toBe(false);
    expect(typeof user?.timezone).toBe('string');
    expect((user?.timezone ?? '').length).toBeGreaterThan(0);
    expect(user?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof user?.createdAt).toBe('number');
  });

  it('updateSchedule({}) synthesizes defaults with preReportSent:false when absent', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    await act(async () => {
      await api.updateSchedule({});
    });
    const db = await openDb();
    const sch = await getSchedule(db);
    db.close();
    expect(sch?.preReportSent).toBe(false);
  });
});

describe('useSettings — concurrency', () => {
  it('three concurrent updateUser calls merge all three patches (read-modify-write race is closed)', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    await act(async () => {
      const p1 = api.updateUser({ email: 'a@x.co' });
      const p2 = api.updateUser({ emailConfirmed: true });
      const p3 = api.updateUser({ plan: 'paid' });
      await Promise.all([p1, p2, p3]);
    });

    const db = await openDb();
    const user = await getUser(db);
    db.close();
    // If the hook didn't serialize, the first two writes would likely be lost
    // because each later call would read memRef before the earlier write
    // mutated it. Expect all three patches to have merged.
    expect(user?.email).toBe('a@x.co');
    expect(user?.emailConfirmed).toBe(true);
    expect(user?.plan).toBe('paid');
  });

  it('user and privacy update chains do not serialize across keys (both complete independently)', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    // Fire both before either awaits. Both should land correctly.
    await act(async () => {
      const u = api.updateUser({ email: 'x@y.co' });
      const p = api.updatePrivacy({ cloudAiOptIn: true });
      await Promise.all([u, p]);
    });

    const db = await openDb();
    const user = await getUser(db);
    const privacy = await getPrivacy(db);
    db.close();
    expect(user?.email).toBe('x@y.co');
    expect(privacy?.cloudAiOptIn).toBe(true);
  });

  it('a rejected update does not poison the chain — the next updateUser still succeeds', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitLoaded();
    const api = cap.current as SettingsApi;

    // 1) failed write (invalid email) — should throw and not persist.
    await act(async () => {
      await api.updateUser({ email: 'bad' }).catch(() => undefined);
    });

    // 2) subsequent valid write must still land (the chain swallowed the error
    // via .catch(() => undefined) before the next task).
    await act(async () => {
      await api.updateUser({ email: 'good@example.com' });
    });

    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.email).toBe('good@example.com');
  });
});

describe('useSettings — IDB open failure', () => {
  it('initial load resolves loading:false with undefined rows (does not throw) when openDb rejects', async () => {
    // Break the IDB factory so that openDB's internal open() call rejects.
    // Easiest reliable way in this env: clobber indexedDB with a factory whose
    // `open` throws synchronously. `openDb` will surface the failure and the
    // hook's try/catch should swallow it.
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
      const api = cap.current as SettingsApi;
      expect(api.loading).toBe(false);
      expect(api.user).toBeUndefined();
      expect(api.privacy).toBeUndefined();
      expect(api.schedule).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('updateX after an initial-load failure rejects (ensureDb re-throws)', async () => {
    // Same broken-factory setup, but now we verify the documented behavior of
    // a post-load update call: ensureDb tries openDb again, which throws, and
    // the enqueued task rejects. We want to assert *some* defined behavior
    // rather than silently swallowing; this captures it.
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
      const api = cap.current as SettingsApi;

      let rejected = false;
      await act(async () => {
        try {
          await api.updateUser({ email: 'a@b.co' });
        } catch {
          rejected = true;
        }
      });
      expect(rejected).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('useSettings — unmount safety', () => {
  it('unmounting during the initial load does not throw', async () => {
    const cap: Capture = { current: null };
    const { unmount } = render(<Harness capture={cap} />);
    // Immediately unmount before the load resolves.
    unmount();
    // Give the microtask queue time to flush the load callback; if the cleanup
    // path is broken we'd see a "setState after unmount" error from Preact.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
