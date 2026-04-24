// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import {
  act,
  cleanup,
  fireEvent,
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
import { type RouteProps, RouterProvider, useRouter } from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { ROUTES } from './index.js';

/**
 * Full integration test for the onboarding preview route (9.3). Seeds IDB,
 * stubs fetch, stubs chrome.history, and asserts:
 *   - auto-start on mount → loading → ready
 *   - Try-again on error re-fires the fetch
 *   - Back navigates to the previous step
 *   - Continue → home
 *   - ConfirmationBanner is not rendered on preview
 *   - Route unmount mid-fetch: no console errors
 */

const UUID = '11111111-1111-4111-8111-111111111111';

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}
function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

function makeChrome(tokenSeed?: string | undefined): unknown {
  const store: Record<string, unknown> = {};
  if (tokenSeed !== undefined) store['clientToken'] = tokenSeed;
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(patch)) store[k] = v;
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
    history: {
      search: vi.fn().mockResolvedValue([]),
      getVisits: vi.fn().mockResolvedValue([]),
    },
  };
}

const VALID_SECTIONS = {
  subject: 'Preview subject',
  preheader: '',
  rabbitHoles: [],
  themes: [],
  obsessions: [],
  ghostTabs: [],
  wow: [],
  tabsStillAlive: [],
  generatedWith: 'deterministic' as const,
};

function okResponse(subject = 'Your preview', body = 'hello body'): Response {
  return new Response(
    JSON.stringify({
      sections: { ...VALID_SECTIONS, subject },
      emailHtml: `<!doctype html><html><body>${body}</body></html>`,
      emailText: body,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function seedUser(): Promise<void> {
  const db = await openDb();
  await setUser(db, {
    uuid: UUID,
    emailConfirmed: false,
    timezone: 'UTC',
    plan: 'free',
    createdAt: 0,
  });
  db.close();
}

function sentinelRoutes(
  focus: RouteName,
): Record<RouteName, (typeof ROUTES)[RouteName]> {
  const result = { ...ROUTES };
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    if (name === focus) continue;
    result[name] = function Sentinel(_props: RouteProps): VNode {
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

let saved: ChromeHandle;
beforeEach(() => {
  saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setChrome(makeChrome());
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
  setBackendBaseUrl('https://api.test.example');
});
afterEach(() => {
  cleanup();
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
  setBackendBaseUrl(null);
  vi.unstubAllGlobals();
});

describe('PreviewRoute — auto-start + ready', () => {
  it('mounts, auto-fires preview, renders the iframe with srcDoc on success', async () => {
    await seedUser();
    const fetchSpy = vi.fn().mockResolvedValue(okResponse('Your lovely subject', 'Generated body'));
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = render(<RouterProvider initial="preview" routes={ROUTES} />);
    await waitFor(() => {
      expect(screen.getByText(/Subject: Your lovely subject/)).not.toBeNull();
    });
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('srcdoc')).toContain('Generated body');
    // The network call must have fired for /generate-report.
    const call = fetchSpy.mock.calls.find((args) => {
      const [url] = args as [string];
      return typeof url === 'string' && url.includes('/generate-report');
    });
    expect(call).toBeDefined();
  });

  it('shows loading UI before fetch resolves (pause the fetch mock to observe)', async () => {
    await seedUser();
    // Hang the fetch so we can assert on the loading copy.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (): Promise<Response> =>
          new Promise<Response>(() => {
            // never resolves
          }),
      ),
    );
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    expect(screen.getByText(/Writing your preview/i)).not.toBeNull();
  });
});

describe('PreviewRoute — error + Try again', () => {
  it('500 (twice) renders the server_error copy + Try again; clicking Try again re-fires fetch', async () => {
    await seedUser();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    await waitFor(() => {
      expect(screen.getByText(/Our server hit a snag/i)).not.toBeNull();
    });
    const firstCount = fetchSpy.mock.calls.length;
    const btn = screen.getByRole('button', { name: /try again/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(firstCount);
    });
    // Second try resolves ok, so the ready branch eventually renders.
    await waitFor(() => {
      expect(screen.getByText(/Subject:/)).not.toBeNull();
    });
  });

  it('429 with Retry-After renders "wait Xs" copy', async () => {
    await seedUser();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('', {
          status: 429,
          headers: { 'Retry-After': '12' },
        }),
      ),
    );
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    await waitFor(() => {
      expect(screen.getByText(/Please wait 12s/)).not.toBeNull();
    });
  });
});

describe('PreviewRoute — navigation', () => {
  it('Continue button navigates to home', async () => {
    await seedUser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    render(<RouterProvider initial="preview" routes={sentinelRoutes('preview')} />);
    // Wait for ready before clicking Continue (Continue is always present).
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-home')).not.toBeNull();
    });
  });

  it('Back from preview (after arriving from timezone) goes to timezone', async () => {
    await seedUser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    render(<RouterProvider initial="timezone" routes={ROUTES} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        "A taste of what's coming",
      );
    });
    const back = screen.getByRole('button', { name: /^back$/i });
    await act(async () => {
      fireEvent.click(back);
    });
    // We're back on the timezone screen (change button + Continue exist there).
    expect(screen.getByTestId('tz-detected')).not.toBeNull();
  });
});

describe('PreviewRoute — chrome surface', () => {
  it('does NOT render ConfirmationBanner (it is not placed here by design)', async () => {
    await seedUser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const { container } = render(<RouterProvider initial="preview" routes={ROUTES} />);
    await waitFor(() => {
      expect(screen.getByText(/Subject:/)).not.toBeNull();
    });
    // ConfirmationBanner renders role="status" with class 'confirmation-banner'.
    expect(container.querySelector('.confirmation-banner')).toBeNull();
  });

  it('unmounting mid-fetch does not log a console.error (AbortController fires)', async () => {
    await seedUser();
    // Install a hanging fetch that rejects on abort.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit): Promise<Response> =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
            });
          }),
      ),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<RouterProvider initial="preview" routes={ROUTES} />);
    // Let mount effect kick off the preview.
    await waitFor(() => {
      expect(screen.getByText(/Writing your preview/i)).not.toBeNull();
    });
    unmount();
    await new Promise((r) => setTimeout(r, 30));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
