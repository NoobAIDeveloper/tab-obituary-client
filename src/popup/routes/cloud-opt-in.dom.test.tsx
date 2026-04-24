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
import { openDb } from '../../storage/db.js';
import { getPrivacy } from '../../storage/settings-store.js';
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

let savedChrome: ChromeHandle;

beforeEach(() => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setChrome(makeStorage({ clientToken: 'tok' }).chrome);
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

function clickCloud(): void {
  fireEvent.click(
    screen.getByRole('button', { name: /compose in the cloud/i }),
  );
}
function clickDevice(): void {
  fireEvent.click(
    screen.getByRole('button', { name: /compose on my device/i }),
  );
}

// ---------------------------------------------------------------------------
// Call-order tests
// ---------------------------------------------------------------------------

describe('cloud-opt-in — local write happens BEFORE server call', () => {
  it('IDB write records cloudAiOptIn before fetch fires (cloud=true)', async () => {
    // Strategy: hold the /settings fetch pending via a manual promise. At
    // the moment /settings is invoked, read IDB — cloudAiOptIn should
    // already be written. Other calls (/export from the ConfirmationBanner)
    // get a schema-valid response so they don't pollute the trace.
    let resolveSettings: (res: Response) => void = () => undefined;
    const settingsPromise = new Promise<Response>((resolve) => {
      resolveSettings = resolve;
    });
    let idbAtSettingsCall: boolean | undefined;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/export')) {
        return jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: false },
        });
      }
      // /settings branch
      const db = await openDb();
      const privacy = await getPrivacy(db);
      db.close();
      idbAtSettingsCall = privacy?.cloudAiOptIn;
      return settingsPromise;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickCloud();
    await waitFor(() => {
      expect(idbAtSettingsCall).toBe(true);
    });
    // Release settings with an ok body.
    resolveSettings(jsonResponse(200, { status: 'ok' }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
  });

  it('IDB write records cloudAiOptIn=false before fetch fires (cloud=false)', async () => {
    let resolveSettings: (res: Response) => void = () => undefined;
    const settingsPromise = new Promise<Response>((resolve) => {
      resolveSettings = resolve;
    });
    let idbAtSettingsCall: boolean | undefined;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/export')) {
        return jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: false },
        });
      }
      const db = await openDb();
      const privacy = await getPrivacy(db);
      db.close();
      idbAtSettingsCall = privacy?.cloudAiOptIn;
      return settingsPromise;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickDevice();
    await waitFor(() => {
      expect(idbAtSettingsCall).toBe(false);
    });
    resolveSettings(jsonResponse(200, { status: 'ok' }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Happy-path: server ok → advance, local saved
// ---------------------------------------------------------------------------

describe('cloud-opt-in — server ok', () => {
  it('cloud=true: local privacy.cloudAiOptIn=true, route advances', async () => {
    // Use mockImplementation so each call returns a fresh Response; a Response
    // body can only be consumed once, and the ConfirmationBanner rendered on
    // this route makes its own fetch to /export on mount. Route distinct
    // responses per path so both /export and /settings get schema-valid bodies.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/export')) {
          return jsonResponse(200, {
            schemaVersion: 1,
            exportedAt: 1,
            user: { emailConfirmed: false },
          });
        }
        return jsonResponse(200, { status: 'ok' });
      }),
    );
    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickCloud();
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(true);
  });

  it('cloud=false: local privacy.cloudAiOptIn=false, route advances', async () => {
    // Use mockImplementation so each call returns a fresh Response; a Response
    // body can only be consumed once, and the ConfirmationBanner rendered on
    // this route makes its own fetch to /export on mount. Route distinct
    // responses per path so both /export and /settings get schema-valid bodies.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/export')) {
          return jsonResponse(200, {
            schemaVersion: 1,
            exportedAt: 1,
            user: { emailConfirmed: false },
          });
        }
        return jsonResponse(200, { status: 'ok' });
      }),
    );
    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickDevice();
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// no_token: silent advance
// ---------------------------------------------------------------------------

describe('cloud-opt-in — no clientToken present', () => {
  it('no_token → advances silently without user-visible error, local write preserved', async () => {
    // Remove the clientToken from storage so updateSettings short-circuits
    // with no_token.
    setChrome(makeStorage().chrome);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickCloud();
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    // No fetch — short-circuited.
    expect(fetchMock).not.toHaveBeenCalled();
    // No "sync later" note, no error.
    expect(screen.queryByText(/sync this setting later/i)).toBeNull();
    expect(document.querySelector('.error')).toBeNull();
    // Local write preserved.
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(true);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Server errors: local write preserved, note shown briefly, advance anyway
// ---------------------------------------------------------------------------

describe('cloud-opt-in — server errors do not roll back local write', () => {
  it('rate_limited: local write preserved, route advances', async () => {
    // Per-call implementation so the /export call from ConfirmationBanner
    // doesn't consume the same Response the /settings call needs.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/export')) {
          return jsonResponse(200, {
            schemaVersion: 1,
            exportedAt: 1,
            user: { emailConfirmed: false },
          });
        }
        return textResponse(429, '', { 'Retry-After': '10' });
      }),
    );
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickCloud();
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(true);
    warnSpy.mockRestore();
  });

  it('network_error: local write preserved, route advances', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/export')) {
          return jsonResponse(200, {
            schemaVersion: 1,
            exportedAt: 1,
            user: { emailConfirmed: false },
          });
        }
        throw new TypeError('offline');
      }),
    );
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickDevice();
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(false);
    warnSpy.mockRestore();
  });

  it('unknown 4xx falls through to the default warn branch; local write preserved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/export')) {
          return jsonResponse(200, {
            schemaVersion: 1,
            exportedAt: 1,
            user: { emailConfirmed: false },
          });
        }
        return jsonResponse(418, { reason: 'teapot' });
      }),
    );
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    render(
      <RouterProvider
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickCloud();
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(true);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Unmount safety
// ---------------------------------------------------------------------------

describe('cloud-opt-in — unmount safety', () => {
  it('unmounting during an in-flight /settings call does not log React warnings', async () => {
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
        initial="cloud-opt-in"
        routes={sentinelRoutes('cloud-opt-in')}
      />,
    );
    clickCloud();
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
