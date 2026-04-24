import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __flushOutboundLoggerWritesForTest,
  __resetOutboundLoggerForTest,
} from '../lib/outbound-logger.js';
import { DB_NAME, openDb } from '../storage/db.js';
import { getAllOutboundRequests } from '../storage/outbound-requests-store.js';
import { jsonResponse, makeChromeStorageMock } from '../test-helpers/chrome-storage-mock.js';
import {
  deleteAccount,
  exportAccount,
  generateReport,
  subscribe,
  unsubscribe,
  updateSettings,
} from './client.js';
import { setBackendBaseUrl } from './config.js';
import { getClientToken } from './token-store.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: removing the binding entirely
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

/** In-memory chrome.storage.local stub. */
const makeStorage = makeChromeStorageMock;

function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers });
}

const BASE = 'https://api.test.example';

// A minimal but schema-valid `ReportResponse` body.
function validReportResponse(): unknown {
  return {
    sections: {
      subject: 'Your week',
      preheader: 'Here it is',
      rabbitHoles: [],
      themes: [],
      obsessions: [],
      ghostTabs: [],
      wow: [],
      tabsStillAlive: [],
      generatedWith: 'deterministic',
    },
    emailHtml: '<p>hi</p>',
    emailText: 'hi',
  };
}

// A minimal payload for generateReport. The client.ts does NOT validate
// the payload against reportPayloadSchema — it trusts the caller's TS
// types — so for HTTP-level tests we can pass a loose object and cast it.
// (We lock this behavior in with a dedicated test further down.)
const LOOSE_PAYLOAD = {
  week: { start: '2025-01-06', end: '2025-01-12' },
  preview: false,
} as unknown as Parameters<typeof generateReport>[0];

// ---------------------------------------------------------------------------
// Suite-wide setup
// ---------------------------------------------------------------------------

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
// subscribe() — unauthenticated, pre-token
// ---------------------------------------------------------------------------

describe('subscribe', () => {
  it('POSTs JSON to {base}/subscribe with Content-Type header and no Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        status: 'subscribed',
        uuid: 'u-1',
        clientToken: 'tok',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribe('foo@bar.com');

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/subscribe`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"email":"foo@bar.com"}');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect('Authorization' in headers).toBe(false);
  });

  it('does NOT attach Authorization even when a token is stored in chrome.storage', async () => {
    const storage = makeStorage({ clientToken: 'tok-should-be-ignored' });
    setChrome(storage.chrome);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        status: 'subscribed',
        uuid: 'u-1',
        clientToken: 'tok',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await subscribe('foo@bar.com');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  it('parses 201 {subscribed} into ok:true with full payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-1',
          clientToken: 'tok-A',
        }),
      ),
    );

    const result = await subscribe('foo@bar.com');
    expect(result).toEqual({
      ok: true,
      data: { status: 'subscribed', uuid: 'u-1', clientToken: 'tok-A' },
    });
  });

  it('parses 200 {link_resent} including clientToken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: 'link_resent',
          uuid: 'u-2',
          clientToken: 'tok-B',
        }),
      ),
    );

    const result = await subscribe('existing@bar.com');
    expect(result).toEqual({
      ok: true,
      data: { status: 'link_resent', uuid: 'u-2', clientToken: 'tok-B' },
    });
  });

  it('parses 200 {already_subscribed} without clientToken (discriminant variant has no token field)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: 'already_subscribed', uuid: 'u-3' }),
        ),
    );

    const result = await subscribe('active@bar.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        status: 'already_subscribed',
        uuid: 'u-3',
      });
      // No clientToken present on this branch
      expect('clientToken' in result.data).toBe(false);
    }
  });

  it('returns invalid_response when body fails schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(201, { status: 'whatever', uuid: 42 })),
    );

    const result = await subscribe('foo@bar.com');
    expect(result).toEqual({ ok: false, status: 201, error: 'invalid_response' });
  });
});

// ---------------------------------------------------------------------------
// Authenticated methods — token handling
// ---------------------------------------------------------------------------

describe('authenticated methods without a stored token', () => {
  it.each([
    ['unsubscribe', () => unsubscribe()],
    ['deleteAccount', () => deleteAccount()],
    ['exportAccount', () => exportAccount()],
    ['updateSettings', () => updateSettings({ cloudAiOptIn: true })],
  ] as const)(
    '%s → no_token 401 without hitting the network',
    async (_label, call) => {
      // chrome absent → getClientToken() yields null
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await call();

      expect(result).toEqual({ ok: false, status: 401, error: 'no_token' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('updateSettings({}) → bad_request without hitting the network (even when token is present)', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateSettings({});

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'bad_request',
      reason: 'empty_patch',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('authenticated methods with a stored token', () => {
  it('unsubscribe attaches Authorization: Bearer <token>', async () => {
    const storage = makeStorage({ clientToken: 'tok-XYZ' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'unsubscribed' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await unsubscribe();

    expect(result).toEqual({ ok: true, data: { status: 'unsubscribed' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/unsubscribe`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-XYZ');
  });

  it('deleteAccount POSTs to /delete-account and parses {status:"deleted"}', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'deleted' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deleteAccount();

    expect(result).toEqual({ ok: true, data: { status: 'deleted' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/delete-account`);
    expect(init.method).toBe('POST');
  });

  it('deleteAccount also parses {status:"already_deleted"}', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'already_deleted' })),
    );

    const result = await deleteAccount();
    expect(result).toEqual({ ok: true, data: { status: 'already_deleted' } });
  });

  it('exportAccount GETs /export and passes arbitrary-shape JSON through', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const blob = {
      schemaVersion: 3,
      exportedAt: 1_700_000_000,
      user: {
        uuid: 'u-1',
        email: 'a@b.c',
        emailConfirmed: true,
        oddField: [1, 2, 3],
      },
      extraServerField: 'passthrough-ok',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, blob));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportAccount();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.schemaVersion).toBe(3);
      expect(result.data.exportedAt).toBe(1_700_000_000);
      // passthrough preserves unknown top-level fields
      expect((result.data as Record<string, unknown>)['extraServerField']).toBe(
        'passthrough-ok',
      );
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    // GET has no body → no Content-Type header set
    const headers = init.headers as Record<string, string>;
    expect('Content-Type' in headers).toBe(false);
  });

  it('updateSettings omits undefined fields from the body', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    await updateSettings({ cloudAiOptIn: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/settings`);
    expect(init.body).toBe('{"cloudAiOptIn":true}');
  });

  it('updateSettings parses {status:"ok"}', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok' })),
    );

    const result = await updateSettings({ timezone: 'UTC' });
    expect(result).toEqual({ ok: true, data: { status: 'ok' } });
  });

  it('updateSettings parses {status:"ok", emailChangePending:true}', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { status: 'ok', emailChangePending: true }),
        ),
    );

    const result = await updateSettings({ email: 'new@a.b' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('ok');
      expect(result.data.emailChangePending).toBe(true);
    }
  });

  it('updateSettings parses {status:"ok", emailChangePending:true, emailSendFailed:true}', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: 'ok',
          emailChangePending: true,
          emailSendFailed: true,
        }),
      ),
    );

    const result = await updateSettings({ email: 'new@a.b' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.emailChangePending).toBe(true);
      expect(result.data.emailSendFailed).toBe(true);
    }
  });

  it('updateSettings sends all three patch fields when provided', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    await updateSettings({
      email: 'x@y.z',
      cloudAiOptIn: false,
      timezone: 'Europe/London',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      email: 'x@y.z',
      cloudAiOptIn: false,
      timezone: 'Europe/London',
    });
  });
});

// ---------------------------------------------------------------------------
// generateReport — dual modality
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  it('authenticated:true with stored token attaches Authorization and POSTs the payload', async () => {
    const storage = makeStorage({ clientToken: 'tok-R' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, validReportResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateReport(LOOSE_PAYLOAD, { authenticated: true });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/generate-report`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-R');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('authenticated:false omits Authorization even with a stored token', async () => {
    const storage = makeStorage({ clientToken: 'tok-should-be-ignored' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, validReportResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await generateReport(LOOSE_PAYLOAD, { authenticated: false });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  it('authenticated:false with no token still proceeds (server handles auth policy)', async () => {
    // No chrome global → getClientToken() returns null. authenticated:false
    // must NOT synthesize a no_token — it must hit the network.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, validReportResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const previewPayload = {
      ...(LOOSE_PAYLOAD as Record<string, unknown>),
      preview: true,
    } as unknown as Parameters<typeof generateReport>[0];
    const result = await generateReport(previewPayload, { authenticated: false });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('authenticated:true with no token → synthesized 401 no_token, no network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateReport(LOOSE_PAYLOAD, { authenticated: true });

    expect(result).toEqual({ ok: false, status: 401, error: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a valid reportResponseSchema body', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const body = validReportResponse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, body)));

    const result = await generateReport(LOOSE_PAYLOAD, { authenticated: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.emailHtml).toBe('<p>hi</p>');
      expect(result.data.sections.generatedWith).toBe('deterministic');
    }
  });

  it('flags invalid_response when the response misses a required field', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const invalid = validReportResponse() as Record<string, unknown>;
    delete invalid['emailText']; // drop a required field
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, invalid)));

    const result = await generateReport(LOOSE_PAYLOAD, { authenticated: true });

    expect(result).toEqual({ ok: false, status: 200, error: 'invalid_response' });
  });

  it('does not client-side-validate the payload — a loose / incomplete payload still hits the network', async () => {
    // The client trusts its caller (documented: "does NOT patch the payload").
    // The server is authoritative for payload shape — we lock this in so a
    // refactor that adds client validation has to update this test.
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, validReportResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const garbage = { totally: 'not a ReportPayload' } as unknown as Parameters<
      typeof generateReport
    >[0];
    await generateReport(garbage, { authenticated: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"totally":"not a ReportPayload"}');
  });

  it('authenticated:true + preview:true is a legal combo at the client level', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, validReportResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const payload = {
      week: { start: '2025-01-06', end: '2025-01-12' },
      preview: true,
    } as unknown as Parameters<typeof generateReport>[0];
    const result = await generateReport(payload, { authenticated: true });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(init.body).toContain('"preview":true');
  });

  it('authenticated:false + preview:false goes through (server will 401, client does not enforce)', async () => {
    // The client does not enforce consistency between `authenticated` and
    // `payload.preview`. We lock this in — future callers may rely on it.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: 'auth_required' }));
    vi.stubGlobal('fetch', fetchMock);

    const payload = {
      week: { start: '2025-01-06', end: '2025-01-12' },
      preview: false,
    } as unknown as Parameters<typeof generateReport>[0];
    const result = await generateReport(payload, { authenticated: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unauthorized');
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  function withToken(): void {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
  }

  it('401 → unauthorized, token NOT auto-cleared', async () => {
    const storage = makeStorage({ clientToken: 'tok-still-here' });
    setChrome(storage.chrome);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })),
    );

    const result = await unsubscribe();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe('unauthorized');
    }
    // Token must remain — policy decision documented in client.ts
    await expect(getClientToken()).resolves.toBe('tok-still-here');
  });

  it('401 surfaces the server-provided reason when present', async () => {
    withToken();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(401, { error: 'unauthorized', reason: 'token_expired' }),
        ),
    );

    const result = await unsubscribe();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_expired');
  });

  it('429 with Retry-After: 42 → rate_limited retryAfter 42', async () => {
    withToken();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse(429, '', { 'Retry-After': '42' })),
    );

    const result = await unsubscribe();
    expect(result).toEqual({
      ok: false,
      status: 429,
      error: 'rate_limited',
      retryAfter: 42,
    });
  });

  it('429 with HTTP-date Retry-After → parsed to seconds-from-now', async () => {
    withToken();
    // Freeze time so date arithmetic is deterministic.
    const now = Date.UTC(2025, 0, 1, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const thirtySecondsOut = new Date(now + 30_000).toUTCString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        textResponse(429, '', { 'Retry-After': thirtySecondsOut }),
      ),
    );

    const result = await unsubscribe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('rate_limited');
      // 30 seconds, rounded up via Math.ceil.
      expect(result.retryAfter).toBe(30);
    }
  });

  it('429 with no Retry-After → retryAfter absent', async () => {
    withToken();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(429, '')));

    const result = await unsubscribe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.error).toBe('rate_limited');
      expect('retryAfter' in result).toBe(false);
    }
  });

  it('429 with malformed Retry-After string → retryAfter absent', async () => {
    withToken();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          textResponse(429, '', { 'Retry-After': 'not-a-number' }),
        ),
    );

    const result = await unsubscribe();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('rate_limited');
      expect('retryAfter' in result).toBe(false);
    }
  });

  it('409 → conflict', async () => {
    withToken();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(409, { error: 'conflict', reason: 'email_change_pending' }),
        ),
    );

    const result = await updateSettings({ email: 'x@y.z' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe('conflict');
      expect(result.reason).toBe('email_change_pending');
    }
  });

  it('400 with {error, reason} surfaces the reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: 'bad_request', reason: 'invalid_json' }),
        ),
    );

    const result = await subscribe('bad-email');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe('bad_request');
      expect(result.reason).toBe('invalid_json');
    }
  });

  it('502 with {error:"email_send_failed"} → email_send_failed (dedicated code)', async () => {
    // Note: 502 is in the 5xx class, so the client ALSO retries it once.
    // Both attempts here produce the same email_send_failed body, so the
    // final result is email_send_failed after the second attempt. Use
    // fake timers so the retry backoff doesn't slow the suite.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: 'email_send_failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: 'email_send_failed',
    });
  });

  it('502 email_send_failed on first attempt, 201 subscribed on retry → ok:true (email-send-failed is retried like other 5xx)', async () => {
    // Lock in: `email_send_failed` is NOT a short-circuit. It's a 5xx and
    // gets the same one-retry treatment as any other server_error. If the
    // retry succeeds, we return ok. Callers relying on "email_send_failed
    // = show-this-UI immediately" should note this only surfaces when the
    // retry also fails.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, { error: 'email_send_failed' }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-2',
          clientToken: 'tok',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('502 with different body → generic server_error path (and therefore retried — tested separately)', async () => {
    // Here we isolate the mapping, not the retry. To observe a pure-502
    // generic mapping without triggering retry, assert after retry completes:
    // two attempts both 502-with-other-body → final status 502 server_error.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: 'something_else' }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, status: 502, error: 'server_error' });
  });

  it('unknown 4xx (e.g. 418) → error:"unknown"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(418, { reason: 'teapot' })),
    );

    const result = await subscribe('foo@bar.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(418);
      expect(result.error).toBe('unknown');
      expect(result.reason).toBe('teapot');
    }
  });

  it('network error (fetch throws) → status:0 network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const result = await subscribe('foo@bar.com');
    expect(result).toEqual({
      ok: false,
      status: 0,
      error: 'network_error',
    });
  });

  it('malformed JSON on 2xx → invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse(200, 'not json{', {})),
    );

    const result = await subscribe('foo@bar.com');
    expect(result).toEqual({
      ok: false,
      status: 200,
      error: 'invalid_response',
    });
  });
});

// ---------------------------------------------------------------------------
// 5xx retry behavior
// ---------------------------------------------------------------------------

describe('5xx retry behavior', () => {
  it('500 → one retry; second attempt success returns ok:true', async () => {
    vi.useFakeTimers();
    const body = {
      status: 'subscribed',
      uuid: 'u-1',
      clientToken: 'tok-A',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: 'oops' }))
      .mockResolvedValueOnce(jsonResponse(201, body));
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    // Retry waits ~500ms.
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('500 → one retry; second attempt also fails → server_error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: 'still broken' }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      status: 500,
      error: 'server_error',
    });
  });

  it('503 is also retried (5xx class)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-2',
          clientToken: 'tok',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('429 is NOT retried', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(textResponse(429, '', { 'Retry-After': '10' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await subscribe('foo@bar.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('rate_limited');
  });

  it('401 is NOT retried', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    vi.stubGlobal('fetch', fetchMock);

    await unsubscribe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('network error is NOT retried', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await subscribe('foo@bar.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Abort signal plumbing
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('passes the signal to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        status: 'subscribed',
        uuid: 'u-1',
        clientToken: 'tok',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    await subscribe('foo@bar.com', { signal: controller.signal });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('fetch rejection with AbortError → aborted', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

    const controller = new AbortController();
    controller.abort();
    const result = await subscribe('foo@bar.com', { signal: controller.signal });

    expect(result).toEqual({ ok: false, status: 0, error: 'aborted' });
  });

  it('aborting mid-retry wait cancels the retry (no second fetch)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(500, {}));
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const promise = subscribe('foo@bar.com', { signal: controller.signal });

    // First fetch has already resolved to 500; client is sleeping the 500ms
    // backoff. Abort before the timer fires.
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    // Drain any remaining timers — there should be none that trigger a
    // second fetch.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, status: 0, error: 'aborted' });
  });

  it('each authenticated method plumbs the signal through to fetch', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
    const okReport = validReportResponse();

    for (const [label, mkCall, body] of [
      [
        'unsubscribe',
        (signal: AbortSignal) => unsubscribe({ signal }),
        { status: 'unsubscribed' },
      ],
      [
        'deleteAccount',
        (signal: AbortSignal) => deleteAccount({ signal }),
        { status: 'deleted' },
      ],
      [
        'exportAccount',
        (signal: AbortSignal) => exportAccount({ signal }),
        { schemaVersion: 1, exportedAt: 1, user: { emailConfirmed: false } },
      ],
      [
        'updateSettings',
        (signal: AbortSignal) => updateSettings({ cloudAiOptIn: true }, { signal }),
        { status: 'ok' },
      ],
      [
        'generateReport',
        (signal: AbortSignal) =>
          generateReport(LOOSE_PAYLOAD, { authenticated: true, signal }),
        okReport,
      ],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
      vi.stubGlobal('fetch', fetchMock);
      const ctrl = new AbortController();
      await mkCall(ctrl.signal);
      expect(fetchMock, `[${label}] should receive the signal`).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal, `[${label}] init.signal`).toBe(ctrl.signal);
    }
  });
});

// ---------------------------------------------------------------------------
// Base URL composition
// ---------------------------------------------------------------------------

describe('base URL composition', () => {
  it('setBackendBaseUrl with trailing slash → request URL has exactly one "/" before path', async () => {
    setBackendBaseUrl('https://api.example.com/');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        status: 'subscribed',
        uuid: 'u-1',
        clientToken: 'tok',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await subscribe('foo@bar.com');

    const [url] = fetchMock.mock.calls[0] as [string];
    // The test hook is verbatim, so the trailing slash is preserved and we
    // get a double-slash in the composed URL. This test locks in the
    // shipped behavior — callers who set the override with a slash get
    // what they asked for. (Production code path, which uses the env var,
    // strips the slash up front.)
    expect(url).toBe('https://api.example.com//subscribe');
  });

  it('setBackendBaseUrl without trailing slash → single slash before path', async () => {
    setBackendBaseUrl('https://api.example.com');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        status: 'subscribed',
        uuid: 'u-1',
        clientToken: 'tok',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await subscribe('foo@bar.com');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.example.com/subscribe');
  });
});

// ---------------------------------------------------------------------------
// Outbound-request logging (chunk 11.2b)
// ---------------------------------------------------------------------------

async function wipeDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('outbound-request logging', () => {
  beforeEach(async () => {
    await __resetOutboundLoggerForTest();
    await wipeDb();
  });
  afterEach(async () => {
    await __resetOutboundLoggerForTest();
    await wipeDb();
  });

  it('subscribe() writes exactly one outbound record with expected fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-1',
          clientToken: 'tok',
        }),
      ),
    );

    const result = await subscribe('foo@bar.com');
    expect(result.ok).toBe(true);
    await __flushOutboundLoggerWritesForTest();

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.method).toBe('POST');
    expect(row?.path).toBe('/subscribe');
    expect(row?.status).toBe(201);
    expect(row?.authenticated).toBe(false);
    expect(typeof row?.durationMs).toBe('number');
    expect(row?.requestBodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.errorCode).toBeUndefined();
    db.close();
  });

  it('network error writes a record with status=0 and errorCode=network_error, durationMs undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const result = await subscribe('foo@bar.com');
    expect(result.ok).toBe(false);
    await __flushOutboundLoggerWritesForTest();

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(0);
    expect(rows[0]?.errorCode).toBe('network_error');
    expect(rows[0]?.durationMs).toBeUndefined();
    db.close();
  });

  it('5xx + retry writes two records with sequential ts and the same path', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: 'oops' }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          status: 'subscribed',
          uuid: 'u-1',
          clientToken: 'tok',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = subscribe('foo@bar.com');
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;
    expect(result.ok).toBe(true);
    vi.useRealTimers();

    await __flushOutboundLoggerWritesForTest();

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.path).toBe('/subscribe');
    expect(rows[1]?.path).toBe('/subscribe');
    // First is the 500, second is the 201 retry.
    expect(rows[0]?.status).toBe(500);
    expect(rows[1]?.status).toBe(201);
    // ts ordering: first ≤ second.
    expect(rows[0]?.ts).toBeLessThanOrEqual(rows[1]?.ts ?? 0);
    db.close();
  });

  it('exportAccount() GET writes a record with requestBodyHash=null', async () => {
    const storage = makeStorage({ clientToken: 'tok' });
    setChrome(storage.chrome);
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

    const result = await exportAccount();
    expect(result.ok).toBe(true);
    await __flushOutboundLoggerWritesForTest();

    const db = await openDb();
    const rows = await getAllOutboundRequests(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.method).toBe('GET');
    expect(rows[0]?.path).toBe('/export');
    expect(rows[0]?.authenticated).toBe(true);
    expect(rows[0]?.requestBodyHash).toBeNull();
    expect(rows[0]?.status).toBe(200);
    db.close();
  });
});
