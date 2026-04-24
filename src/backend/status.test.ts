import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, makeChromeStorageMock } from '../test-helpers/chrome-storage-mock.js';
import { setBackendBaseUrl } from './config.js';
import { fetchEmailConfirmationStatus } from './status.js';

// ---------------------------------------------------------------------------
// Harness — mirrors client.test.ts
// ---------------------------------------------------------------------------

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: removing the binding entirely
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

const BASE = 'https://api.test.example';

let savedChrome: ChromeHandle;

beforeEach(() => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  deleteChrome();
  setBackendBaseUrl(BASE);
});

afterEach(() => {
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
  setBackendBaseUrl(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe('fetchEmailConfirmationStatus — success paths', () => {
  it('returns {confirmed: true} when /export says emailConfirmed:true', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1_700_000_000,
          user: {
            uuid: 'u-1',
            email: 'a@b.co',
            emailConfirmed: true,
          },
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ confirmed: true });
  });

  it('returns {confirmed: false} when /export says emailConfirmed:false', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1_700_000_000,
          user: {
            uuid: 'u-1',
            email: 'a@b.co',
            emailConfirmed: false,
          },
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ confirmed: false });
  });

  it('GETs /export with Authorization bearer header', async () => {
    const storage = makeStorage({ clientToken: 'tok-abc' });
    setChrome(storage.chrome);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        schemaVersion: 1,
        exportedAt: 1,
        user: { emailConfirmed: true },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchEmailConfirmationStatus();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/export`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-abc');
  });
});

// ---------------------------------------------------------------------------
// Defensive reads — lock in the invalid_response branch
// ---------------------------------------------------------------------------

describe('fetchEmailConfirmationStatus — defensive response parsing', () => {
  it('returns {error:"invalid_response"} when user.emailConfirmed is missing', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { uuid: 'u-1' }, // no emailConfirmed
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'invalid_response' });
  });

  it('returns {error:"invalid_response"} when user is null', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: null,
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'invalid_response' });
  });

  it('returns {error:"invalid_response"} when user is a string', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: 'not-an-object',
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'invalid_response' });
  });

  it('returns {error:"invalid_response"} when emailConfirmed is a string, not a boolean', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: 'true' },
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'invalid_response' });
  });

  it('returns {error:"invalid_response"} when emailConfirmed is null', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: null },
        }),
      ),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'invalid_response' });
  });
});

// ---------------------------------------------------------------------------
// Error code propagation
// ---------------------------------------------------------------------------

describe('fetchEmailConfirmationStatus — error propagation', () => {
  it('returns {error:"no_token"} when no clientToken is stored (no fetch call)', async () => {
    // no chrome → getClientToken() yields null → client short-circuits.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns {error:"unauthorized"} when server returns 401', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'unauthorized' });
  });

  it('returns {error:"network_error"} when fetch throws', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'network_error' });
  });

  it('returns {error:"rate_limited"} when server returns 429', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse(429, '', { 'Retry-After': '42' })),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'rate_limited' });
  });

  it('returns {error:"aborted"} when fetch rejects with AbortError', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const err = new Error('aborted');
    err.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

    const controller = new AbortController();
    controller.abort();
    const result = await fetchEmailConfirmationStatus({
      signal: controller.signal,
    });

    expect(result).toEqual({ error: 'aborted' });
  });

  it('returns {error:"invalid_response"} when response body is malformed JSON', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse(200, 'not json{')),
    );

    const result = await fetchEmailConfirmationStatus();

    expect(result).toEqual({ error: 'invalid_response' });
  });
});

// ---------------------------------------------------------------------------
// Signal propagation
// ---------------------------------------------------------------------------

describe('fetchEmailConfirmationStatus — AbortSignal', () => {
  it('passes the provided signal through to fetch', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        schemaVersion: 1,
        exportedAt: 1,
        user: { emailConfirmed: true },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    await fetchEmailConfirmationStatus({ signal: controller.signal });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('aborting before the call resolves lets the call start, then the fetch AbortError surfaces as {error:"aborted"}', async () => {
    // The status helper delegates to exportAccount which relies on fetch's
    // native AbortSignal handling. When the signal is already aborted at
    // call time, the real `fetch` rejects with AbortError synchronously;
    // we simulate that behavior.
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) => {
      // mirror real fetch: if the passed signal is already aborted, throw.
      if (init.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve(
        jsonResponse(200, {
          schemaVersion: 1,
          exportedAt: 1,
          user: { emailConfirmed: true },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();
    const result = await fetchEmailConfirmationStatus({
      signal: controller.signal,
    });

    // fetch IS called — the client does not short-circuit on pre-aborted
    // signals; it relies on the network layer to reject. Lock that in.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ error: 'aborted' });
  });
});
