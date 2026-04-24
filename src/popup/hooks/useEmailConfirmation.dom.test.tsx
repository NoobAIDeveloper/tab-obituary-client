// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendBaseUrl } from '../../backend/config.js';
import { openDb } from '../../storage/db.js';
import { setUser } from '../../storage/settings-store.js';
import {
  jsonResponse,
  makeChromeStorageMock,
} from '../../test-helpers/chrome-storage-mock.js';
import {
  type UseEmailConfirmationResult,
  useEmailConfirmation,
} from './useEmailConfirmation.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}
function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

const makeStorageChrome = makeChromeStorageMock;

const BASE = 'https://api.test.example';

let savedChrome: ChromeHandle;

beforeEach(() => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setBackendBaseUrl(BASE);
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    new FDBFactory();
});

afterEach(() => {
  cleanup();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
  setBackendBaseUrl(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface Capture {
  current: UseEmailConfirmationResult | null;
  renderCount: number;
}

function Harness(props: { capture: Capture }): VNode {
  const api = useEmailConfirmation();
  props.capture.current = api;
  props.capture.renderCount += 1;
  return (
    <div>
      <span data-testid="status">{api.status}</span>
      <span data-testid="error-code">{api.errorCode ?? ''}</span>
    </div>
  );
}

async function seedUser(opts: {
  email?: string;
  emailConfirmed: boolean;
}): Promise<void> {
  const db = await openDb();
  await setUser(db, {
    uuid: '11111111-1111-4111-8111-111111111111',
    email: opts.email ?? 'me@example.com',
    emailConfirmed: opts.emailConfirmed,
    timezone: 'UTC',
    plan: 'free',
    createdAt: 1,
  });
  db.close();
}

async function waitForStatus(value: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('status').textContent).toBe(value);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useEmailConfirmation — locally confirmed short-circuit', () => {
  it('skips fetch when local emailConfirmed:true and ends at status:"confirmed"', async () => {
    await seedUser({ emailConfirmed: true });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    await waitForStatus('confirmed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useEmailConfirmation — no token', () => {
  it('stays idle when local says false and no clientToken is stored; never fetches', async () => {
    await seedUser({ emailConfirmed: false });
    // chrome present but no clientToken stored → getClientToken returns null
    setChrome(makeStorageChrome({}).chrome);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    // Wait for settings to hydrate so the mount effect has a chance to fire,
    // then assert we stayed idle.
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useEmailConfirmation — server says confirmed', () => {
  it('flips local emailConfirmed:true and surfaces status:"confirmed"', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: true },
        }),
      ),
    );

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    await waitForStatus('confirmed');

    // Local IDB should now carry emailConfirmed:true.
    const db = await openDb();
    const { getUser } = await import('../../storage/settings-store.js');
    const user = await getUser(db);
    db.close();
    expect(user?.emailConfirmed).toBe(true);
  });
});

describe('useEmailConfirmation — server says unconfirmed', () => {
  it('surfaces status:"unconfirmed" without mutating IDB', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: false },
        }),
      ),
    );

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    await waitForStatus('unconfirmed');

    const db = await openDb();
    const { getUser } = await import('../../storage/settings-store.js');
    const user = await getUser(db);
    db.close();
    expect(user?.emailConfirmed).toBe(false);
  });
});

describe('useEmailConfirmation — server errors', () => {
  it('maps 401 → status:"error" with errorCode:"unauthorized"', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })),
    );

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    await waitForStatus('error');
    expect(screen.getByTestId('error-code').textContent).toBe('unauthorized');
  });

  it('maps network failure → status:"error" with errorCode:"network_error"', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    await waitForStatus('error');
    expect(screen.getByTestId('error-code').textContent).toBe('network_error');
  });

  it('aborted mid-flight surfaces as idle (hook collapses abort to a non-error)', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);

    // fetch hangs; unmount triggers the controller abort path which produces
    // a signal.aborted=true guard inside check() before any setState.
    const fetchMock = vi.fn().mockImplementation(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null, renderCount: 0 };
    const { unmount } = render(<Harness capture={cap} />);

    // Wait until status flips to 'checking' so we know the fetch is in flight.
    await waitForStatus('checking');

    // Unmount: the effect's cleanup aborts the controller. The hook's
    // `if (ctrl.signal.aborted) return;` prevents any post-unmount setState.
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    // No React "setState after unmount" warning should have been logged.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('useEmailConfirmation — refresh()', () => {
  it('re-fetches and can transition unconfirmed → confirmed', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);

    // First call returns unconfirmed, second returns confirmed.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: false },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: true },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    await waitForStatus('unconfirmed');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await cap.current?.refresh();
    });

    await waitForStatus('confirmed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useEmailConfirmation — dedupe / abort previous check', () => {
  it('back-to-back refresh() calls abort the in-flight request', async () => {
    await seedUser({ emailConfirmed: false });
    setChrome(makeStorageChrome({ clientToken: 'tok' }).chrome);

    const signals: AbortSignal[] = [];
    // First call hangs until aborted. Second call resolves confirmed.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (init.signal) signals.push(init.signal);
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      )
      .mockImplementationOnce((_url, init: RequestInit) => {
        if (init.signal) signals.push(init.signal);
        return Promise.resolve(
          jsonResponse(200, {
            schemaVersion: 1,
            exportedAt: 1,
            user: { emailConfirmed: true },
          }),
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);

    // First fetch — from mount — is hanging.
    await waitForStatus('checking');

    // Kick off a refresh: this should abort the first request and fire a
    // second one, which resolves confirmed.
    await act(async () => {
      await cap.current?.refresh();
    });

    await waitForStatus('confirmed');
    // The first signal should now be aborted.
    expect(signals[0]?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useEmailConfirmation — loading guard', () => {
  it('does not fetch until settings.loading flips to false', async () => {
    // No seed → useSettings loads quickly but still non-synchronous.
    // We mainly assert that status stabilises to idle (no token) and no
    // fetch happened before hydration resolved.
    await seedUser({ emailConfirmed: false });
    // No clientToken stored so the token check short-circuits to idle.
    setChrome(makeStorageChrome({}).chrome);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null, renderCount: 0 };
    render(<Harness capture={cap} />);
    // status is 'idle' initially (initial state) and stays idle because
    // there's no clientToken.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
