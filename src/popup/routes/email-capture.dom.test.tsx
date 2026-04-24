// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import type { ComponentType, VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendBaseUrl } from '../../backend/config.js';
import { getClientToken } from '../../backend/token-store.js';
import { openDb } from '../../storage/db.js';
import { getUser } from '../../storage/settings-store.js';
import {
  jsonResponse,
  makeChromeStorageMock,
} from '../../test-helpers/chrome-storage-mock.js';
import {
  type RouteProps,
  RouterProvider,
  useRouter,
} from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { ROUTES } from './index.js';

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

const makeStorage = makeChromeStorageMock;

function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers });
}

function sentinelRoutes(
  focus: RouteName,
): Record<RouteName, ComponentType<RouteProps>> {
  const result = { ...ROUTES };
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    if (name === focus) continue;
    result[name] = function Sentinel(): VNode {
      const router = useRouter();
      return (
        <div data-testid={`sentinel-${name}`}>
          {name}::{router.route}
        </div>
      );
    };
  }
  return result;
}

const BASE = 'https://api.test.example';
const VALID_UUID = '22222222-2222-4222-8222-222222222222';

let savedChrome: ChromeHandle;

beforeEach(() => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  // Default chrome with empty storage; individual tests override.
  setChrome(makeStorage().chrome);
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    new FDBFactory();
  setBackendBaseUrl(BASE);
});

afterEach(() => {
  cleanup();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
  setBackendBaseUrl(null);
  vi.unstubAllGlobals();
});

function typeEmail(email: string): void {
  const input = screen.getByPlaceholderText(
    'you@example.com',
  ) as HTMLInputElement;
  fireEvent.input(input, { target: { value: email } });
}

function clickContinue(): void {
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe('email-capture — successful subscribe (201 subscribed)', () => {
  it('persists clientToken, overwrites uuid with the server uuid, flips emailConfirmed:false, and advances to cloud-opt-in', async () => {
    const storage = makeStorage();
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: VALID_UUID,
          clientToken: 'ct-abc',
        }),
      ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('me@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });

    // clientToken written to chrome.storage.local via setClientToken. Post-11.2a
    // the on-disk value is an encrypted envelope (`{v:1, iv, ct}`) rather than
    // the plaintext — assert the shape, then round-trip through getClientToken.
    expect(storage.set).toHaveBeenCalled();
    const tokenWrite = storage.set.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)['clientToken'] !== undefined,
    );
    expect(tokenWrite).toBeDefined();
    const persisted = (tokenWrite?.[0] as Record<string, unknown>)[
      'clientToken'
    ];
    expect(persisted).toMatchObject({ v: 1 });
    expect(persisted).not.toBe('ct-abc');
    await expect(getClientToken()).resolves.toBe('ct-abc');

    // IDB user row carries the server uuid + emailConfirmed:false.
    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.uuid).toBe(VALID_UUID);
    expect(user?.email).toBe('me@example.com');
    expect(user?.emailConfirmed).toBe(false);
  });
});

describe('email-capture — 200 link_resent (existing user, re-sent magic link)', () => {
  it('same effect as 201 subscribed — token persisted, uuid adopted, advances', async () => {
    const storage = makeStorage();
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: 'link_resent',
          uuid: VALID_UUID,
          clientToken: 'ct-resent',
        }),
      ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('existing@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });
    const tokenWrite = storage.set.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)['clientToken'] !== undefined,
    );
    const persisted = (tokenWrite?.[0] as Record<string, unknown>)[
      'clientToken'
    ];
    expect(persisted).toMatchObject({ v: 1 });
    expect(persisted).not.toBe('ct-resent');
    await expect(getClientToken()).resolves.toBe('ct-resent');

    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.uuid).toBe(VALID_UUID);
    expect(user?.email).toBe('existing@example.com');
  });
});

describe('email-capture — 200 already_subscribed (no clientToken)', () => {
  it('does NOT overwrite the existing clientToken in storage and still advances', async () => {
    // Pre-seed a prior token so the test can observe it is untouched.
    const storage = makeStorage({ clientToken: 'prior-tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: 'already_subscribed',
          uuid: VALID_UUID,
        }),
      ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('active@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });

    // No clientToken write should have happened (already_subscribed has no
    // token field on the response).
    const tokenWrite = storage.set.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)['clientToken'] !== undefined,
    );
    expect(tokenWrite).toBeUndefined();
    // Prior token is intact.
    expect(storage.data['clientToken']).toBe('prior-tok');

    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.uuid).toBe(VALID_UUID);
    expect(user?.email).toBe('active@example.com');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('email-capture — error paths do NOT advance', () => {
  it('rate_limited with Retry-After:42 → shows "Please wait 42s" and stays', async () => {
    const storage = makeStorage();
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(textResponse(429, '', { 'Retry-After': '42' })),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('rate@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByText(/42s/)).not.toBeNull();
    });
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
    // No token written.
    const tokenWrite = storage.set.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)['clientToken'] !== undefined,
    );
    expect(tokenWrite).toBeUndefined();
  });

  it('email_send_failed (502) → friendly "couldn\'t send" copy, no advance', async () => {
    // Note: client retries 5xx once; both retries return the same body to
    // land on the email_send_failed branch.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(502, { error: 'email_send_failed' }),
        ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('fail@example.com');
    clickContinue();

    await waitFor(() => {
      expect(
        screen.getByText(/couldn't send your confirmation email/i),
      ).not.toBeNull();
    });
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
  });

  it('bad_request (400) → generic "wasn\'t accepted" copy, no advance', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: 'bad_request', reason: 'invalid_json' }),
        ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('bad@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByText(/wasn't accepted/i)).not.toBeNull();
    });
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
  });

  it('network_error → "couldn\'t reach the server" copy, no advance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('offline@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByText(/couldn't reach the server/i)).not.toBeNull();
    });
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
  });

  it('409 conflict falls through to the default branch with a generic copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(409, { error: 'conflict', reason: 'email_change_pending' }),
        ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('conflict@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByText(/went wrong/i)).not.toBeNull();
    });
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Abort / unmount safety
// ---------------------------------------------------------------------------

describe('email-capture — unmount cancels in-flight subscribe', () => {
  it('unmounting during pending fetch does not log React "setState after unmount" warnings', async () => {
    const storage = makeStorage();
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );

    const { unmount } = render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('abort@example.com');
    clickContinue();

    // Wait briefly for fetch to be in flight.
    await new Promise((r) => setTimeout(r, 20));

    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    unmount();
    await new Promise((r) => setTimeout(r, 40));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Call ordering — lock in the sequence subscribe → setClientToken → updateUser
// ---------------------------------------------------------------------------

describe('email-capture — call ordering lock-in', () => {
  it('setClientToken runs before settings.updateUser on the success path', async () => {
    // We observe ordering by instrumenting chrome.storage.local.set: the
    // clientToken write (from setClientToken) must land before the IDB row
    // with emailConfirmed:false is written by updateUser. We assert by
    // sampling a `fake-indexeddb` read inside the set callback: before the
    // first token-write call, there is no user row with email.
    const storage = makeStorage();
    setChrome(storage.chrome);

    let userRowAtTokenSet: unknown = 'not-captured';
    storage.set.mockImplementation(async (patch: Record<string, unknown>) => {
      if (patch['clientToken'] !== undefined && userRowAtTokenSet === 'not-captured') {
        const db = await openDb();
        userRowAtTokenSet = await getUser(db);
        db.close();
      }
      for (const [k, v] of Object.entries(patch)) storage.data[k] = v;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: VALID_UUID,
          clientToken: 'ct-order',
        }),
      ),
    );

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    typeEmail('order@example.com');
    clickContinue();

    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });

    // At the moment setClientToken wrote the token, the user row had not yet
    // been updated to carry `email: 'order@example.com'`. Depending on prior
    // state it may be undefined (no row yet) or an older row — key invariant
    // is it does NOT carry the new email.
    if (
      userRowAtTokenSet !== undefined &&
      userRowAtTokenSet !== null &&
      typeof userRowAtTokenSet === 'object'
    ) {
      expect(
        (userRowAtTokenSet as { email?: string }).email,
      ).not.toBe('order@example.com');
    }

    // After the whole flow, the IDB row carries the new email.
    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.email).toBe('order@example.com');
  });
});

// ---------------------------------------------------------------------------
// Enter keybind also submits
// ---------------------------------------------------------------------------

describe('email-capture — Enter submits', () => {
  it('pressing Enter fires the same subscribe path as clicking Continue', async () => {
    setChrome(makeStorage().chrome);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        status: 'subscribed',
        uuid: VALID_UUID,
        clientToken: 'ct',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <RouterProvider
        initial="email-capture"
        routes={sentinelRoutes('email-capture')}
      />,
    );
    const input = screen.getByPlaceholderText(
      'you@example.com',
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'enter2@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
