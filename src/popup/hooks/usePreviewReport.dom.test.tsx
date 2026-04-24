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
  type PreviewState,
  type UsePreviewReportResult,
  usePreviewReport,
} from './usePreviewReport.js';

/**
 * Hook-level tests for usePreviewReport. Covers:
 *   - idle → loading → ready happy path
 *   - 5xx retry-then-fall-through → error
 *   - rate-limit with Retry-After
 *   - invalid_response on malformed JSON
 *   - pending-start latch (start() before settings.user loads)
 *   - auth mode fallback (no clientToken → unauthenticated call)
 *   - cancel() during loading aborts fetch
 *   - double start() aborts the previous in-flight run
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

/**
 * Build a chrome stub with a storage.local backed by an in-memory map and a
 * `history` surface that returns no items by default. The token map seeds
 * `clientToken` when provided.
 */
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

function okResponse(overrides: Partial<typeof VALID_SECTIONS> = {}): Response {
  return new Response(
    JSON.stringify({
      sections: { ...VALID_SECTIONS, ...overrides },
      emailHtml: '<!doctype html><html><body>hi</body></html>',
      emailText: 'hi',
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

interface Capture {
  current: UsePreviewReportResult | null;
}

function Harness(props: { capture: Capture }): VNode {
  const api = usePreviewReport();
  props.capture.current = api;
  return <div data-testid="status">{api.state.status}</div>;
}

async function awaitStatus(expected: PreviewState['status']): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('status').textContent).toBe(expected);
  });
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

describe('usePreviewReport — initial state', () => {
  it('starts in {status: "idle"}', async () => {
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    // Give useSettings one microtask to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(cap.current?.state.status).toBe('idle');
  });
});

describe('usePreviewReport — happy path', () => {
  it('start() with seeded user + ok fetch → loading → ready with html/text/subject', async () => {
    await seedUser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ subject: 'Hello' })));
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    await act(async () => {
      cap.current?.start();
    });
    await awaitStatus('ready');
    const st = cap.current?.state;
    if (st?.status !== 'ready') throw new Error('expected ready');
    expect(st.html).toContain('hi');
    expect(st.text).toBe('hi');
    expect(st.subject).toBe('Hello');
  });
});

describe('usePreviewReport — errors', () => {
  it('500 on both attempts → state error with code server_error', async () => {
    await seedUser();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response('', { status: 500 })),
    );
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    await act(async () => {
      cap.current?.start();
    });
    await awaitStatus('error');
    const st = cap.current?.state;
    if (st?.status !== 'error') throw new Error('expected error');
    expect(st.code).toBe('server_error');
  });

  it('429 with Retry-After → state error with code rate_limited + retryAfter seconds', async () => {
    await seedUser();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
        ),
    );
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    await act(async () => {
      cap.current?.start();
    });
    await awaitStatus('error');
    const st = cap.current?.state;
    if (st?.status !== 'error') throw new Error('expected error');
    expect(st.code).toBe('rate_limited');
    expect(st.retryAfter).toBe(7);
  });

  it('malformed JSON on a 200 response → error with code invalid_response', async () => {
    await seedUser();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{not json', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    await act(async () => {
      cap.current?.start();
    });
    await awaitStatus('error');
    const st = cap.current?.state;
    if (st?.status !== 'error') throw new Error('expected error');
    expect(st.code).toBe('invalid_response');
  });
});

describe('usePreviewReport — pending-start latch', () => {
  it('start() called before settings loads still fires once settings materialise', async () => {
    // Install a very slow IDB factory so the initial useSettings load is
    // deferred. Seed the user row in the underlying IDB ahead of time.
    await seedUser();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    // Call start() immediately, before waiting for useSettings's loading to
    // flip. The hook should latch pendingStartRef and fire kickoff when the
    // user row lands.
    act(() => {
      cap.current?.start();
    });
    // The hook optimistically transitions to loading to avoid a flash.
    expect(cap.current?.state.status === 'loading' || cap.current?.state.status === 'idle').toBe(
      true,
    );
    await awaitStatus('ready');
  });
});

describe('usePreviewReport — auth mode', () => {
  it('no clientToken in chrome.storage.local → sends fetch WITHOUT Authorization header', async () => {
    await seedUser();
    // Default chrome stub has no token.
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    await act(async () => {
      cap.current?.start();
    });
    await awaitStatus('ready');
    // Inspect the fetch call headers.
    const call = fetchSpy.mock.calls.find((args) => {
      const [url] = args as [string];
      return typeof url === 'string' && url.includes('/generate-report');
    });
    expect(call).toBeDefined();
    if (!call) return;
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('clientToken present → sends Authorization: Bearer <token>', async () => {
    await seedUser();
    setChrome(makeChrome('tok-abc'));
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    await act(async () => {
      cap.current?.start();
    });
    await awaitStatus('ready');
    const call = fetchSpy.mock.calls.find((args) => {
      const [url] = args as [string];
      return typeof url === 'string' && url.includes('/generate-report');
    });
    expect(call).toBeDefined();
    if (!call) return;
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-abc');
  });
});

describe('usePreviewReport — cancel / abort', () => {
  it('cancel() during loading returns state to idle and aborts fetch signal', async () => {
    await seedUser();
    // Install a fetch that observes the signal and hangs until aborted.
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        if (init?.signal) {
          return new Promise<Response>((_resolve, reject) => {
            if (init.signal?.aborted) {
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
              return;
            }
            init.signal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
            });
          });
        }
        return okResponse();
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    act(() => {
      cap.current?.start();
    });
    await awaitStatus('loading');
    act(() => {
      cap.current?.cancel();
    });
    await awaitStatus('idle');
  });

  it('calling start() twice in a row: second run lands ready (first is aborted or superseded)', async () => {
    await seedUser();
    const seenSignals: AbortSignal[] = [];
    let callIdx = 0;
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const sig = init?.signal;
        if (sig) seenSignals.push(sig);
        const i = callIdx++;
        if (i === 0) {
          // First call: hang until its signal aborts, then reject.
          return new Promise<Response>((_resolve, reject) => {
            sig?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
            });
          });
        }
        // Later calls: succeed.
        return okResponse();
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null };
    render(<Harness capture={cap} />);
    await awaitStatus('idle');
    act(() => {
      cap.current?.start();
    });
    await awaitStatus('loading');
    // Wait until the first fetch has actually started — otherwise the second
    // start() can abort before fetch is reached.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await act(async () => {
      cap.current?.start();
    });
    // The first signal should now be aborted (the second start replaced it).
    expect(seenSignals[0]?.aborted).toBe(true);
    await awaitStatus('ready');
  });

  it('unmount during loading does not log an error (no setState-after-unmount)', async () => {
    await seedUser();
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const cap: Capture = { current: null };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<Harness capture={cap} />);
    await awaitStatus('idle');
    act(() => {
      cap.current?.start();
    });
    await awaitStatus('loading');
    unmount();
    // Give the microtask queue time to flush the abort + any downstream state.
    await new Promise((r) => setTimeout(r, 20));
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
