/**
 * End-to-end tests for the weekly-alarm handler.
 *
 * We drive the real `handleWeeklyAlarm` with fake-indexeddb backing the
 * storage layer, stub `chrome.storage.local` for the token read, and mock the
 * `backend/client.js` surface at the module boundary — that keeps the payload
 * pipeline honest (it runs end-to-end) while isolating the network.
 */
import 'fake-indexeddb/auto';
import type { ReportResponse } from '@tabob/shared';
import { SCHEMA_VERSION } from '@tabob/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock hoisted before the imports that pull from the module boundary.
vi.mock('../backend/client.js', () => ({
  generateReport: vi.fn(),
}));

import { generateReport } from '../backend/client.js';
import { WEEKLY_ALARM_NAME } from '../lib/schedule.js';
import { DB_NAME, openDb } from '../storage/db.js';
import { appendEvent } from '../storage/events-store.js';
import { setPrivacy, setUser } from '../storage/settings-store.js';
import { getAllWeeklySummaries, putWeeklySummary } from '../storage/summaries-store.js';
import { makeChromeStorageMock } from '../test-helpers/chrome-storage-mock.js';
import { handleWeeklyAlarm, weeklyAlarmListener } from './weekly-report.js';

const mockGenerateReport = vi.mocked(generateReport);

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

const makeStorage = makeChromeStorageMock;

async function wipeIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function minimalSections(): ReportResponse['sections'] {
  return {
    subject: 'Your week in tabs.',
    preheader: 'A quiet week.',
    rabbitHoles: [],
    themes: [],
    obsessions: [],
    ghostTabs: [],
    wow: [],
    tabsStillAlive: [],
    generatedWith: 'cloud',
  };
}

function okResponse(overrides: Partial<ReportResponse> = {}): {
  ok: true;
  data: ReportResponse;
} {
  return {
    ok: true,
    data: {
      sections: minimalSections(),
      emailHtml: '<!DOCTYPE html><html></html>',
      emailText: 'hi',
      ...overrides,
    },
  };
}

// A deterministic "now" roughly mid-April 2026 so week bounds are predictable.
// `now = 2026-04-23T12:00:00Z`. weekStart = 2026-04-16, weekEnd = 2026-04-23.
const NOW = Date.UTC(2026, 3, 23, 12, 0, 0);

// Seed a happy state INSIDE the provided db. Caller owns the lifecycle.
async function seedUserAndPrivacy(
  db: Awaited<ReturnType<typeof openDb>>,
  overrides: {
    email?: string;
    emailConfirmed?: boolean;
    timezone?: string;
  } = {},
): Promise<void> {
  await setUser(db, {
    uuid: '00000000-0000-4000-8000-000000000000',
    email: overrides.email ?? 'a@b.co',
    emailConfirmed: overrides.emailConfirmed ?? true,
    timezone: overrides.timezone ?? 'UTC',
    plan: 'free',
    createdAt: 1,
  });
  await setPrivacy(db, {
    trackingOptIn: true,
    cloudAiOptIn: true,
    trackingPaused: false,
    installedAt: 1,
  });
  await appendEvent(db, {
    type: 'navigate',
    ts: NOW - 2 * 24 * 60 * 60 * 1000,
    tzOffsetMin: 0,
    tabId: 1,
    url: 'https://example.com/page',
    domain: 'example.com',
    title: 'Example',
  });
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let savedChrome: ChromeHandle;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  deleteChrome();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  mockGenerateReport.mockReset();
  await wipeIdb();
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errSpy.mockRestore();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleWeeklyAlarm — happy path', () => {
  it('posts to /generate-report and writes the returned sections under the correct weekStart', async () => {
    setChrome(makeStorage({ clientToken: 'tok-A' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
    const [payload, options] = mockGenerateReport.mock.calls[0]!;
    expect(options).toEqual({ authenticated: true });
    expect(payload.preview).toBe(false);
    expect(payload.user.uuid).toBe('00000000-0000-4000-8000-000000000000');
    expect(payload.user.timezone).toBe('UTC');
    expect(payload.week.start).toBe('2026-04-16');
    expect(payload.week.end).toBe('2026-04-23');
    expect(payload.totals).toBeDefined();
    expect(typeof payload.totals.activeMs).toBe('number');
    expect(typeof payload.totals.events).toBe('number');

    const db2 = await openDb();
    const all = await getAllWeeklySummaries(db2);
    expect(all).toHaveLength(1);
    expect(all[0]!.weekStart).toBe('2026-04-16');
    expect(all[0]!.sections).toEqual(minimalSections());
    expect(all[0]!.generatedAt).toBe(NOW);
    expect(all[0]!.schemaVersion).toBe(SCHEMA_VERSION);
    db2.close();
  });

  it('does NOT pass priorWeekSummary in Chunk 10.1', async () => {
    setChrome(makeStorage({ clientToken: 'tok-A' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    const [payload] = mockGenerateReport.mock.calls[0]!;
    // exactOptionalPropertyTypes: the field should be absent, not undefined.
    expect('priorWeekSummary' in payload).toBe(false);
  });

  it('uses injected `now` for week bounds (not wall clock)', async () => {
    setChrome(makeStorage({ clientToken: 'tok-A' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    // Mid-August 2025.
    const altNow = Date.UTC(2025, 7, 15, 12, 0, 0);
    await handleWeeklyAlarm({ now: altNow });

    const [payload] = mockGenerateReport.mock.calls[0]!;
    expect(payload.week.start).toBe('2025-08-08');
    expect(payload.week.end).toBe('2025-08-15');
  });

  it('defaults to Date.now() when `now` is not passed', async () => {
    setChrome(makeStorage({ clientToken: 'tok-A' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    // Stub Date.now only (not setTimeout/setInterval) so fake-indexeddb's
    // internal async plumbing still runs under real timers.
    const originalNow = Date.now;
    Date.now = () => NOW;
    try {
      await handleWeeklyAlarm();
    } finally {
      Date.now = originalNow;
    }

    const [payload] = mockGenerateReport.mock.calls[0]!;
    expect(payload.week.start).toBe('2026-04-16');
    expect(payload.week.end).toBe('2026-04-23');
  });
});

// ---------------------------------------------------------------------------
// Guard clauses
// ---------------------------------------------------------------------------

describe('handleWeeklyAlarm — guards', () => {
  it('no clientToken → no network call, no IDB mutation', async () => {
    // chrome is absent → getClientToken() returns null.
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
    const db2 = await openDb();
    expect(await getAllWeeklySummaries(db2)).toEqual([]);
    db2.close();
  });

  it('empty string clientToken → no network call', async () => {
    setChrome(makeStorage({ clientToken: '' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('no user row → no network call, no write', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    // Deliberately skip setUser.
    await setPrivacy(db, {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 1,
    });
    db.close();
    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
    const db2 = await openDb();
    expect(await getAllWeeklySummaries(db2)).toEqual([]);
    db2.close();
  });

  it('user.email empty → no network call', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db, { email: '' });
    db.close();
    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('emailConfirmed !== true → no network call', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db, { emailConfirmed: false });
    db.close();
    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('existing summary for this weekStart → idempotent short-circuit, no send', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    await putWeeklySummary(db, {
      weekStart: '2026-04-16',
      sections: minimalSections(),
      generatedAt: NOW - 60_000,
      schemaVersion: SCHEMA_VERSION,
    });
    db.close();

    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('privacy row missing → no network call', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await setUser(db, {
      uuid: '00000000-0000-4000-8000-000000000000',
      email: 'a@b.co',
      emailConfirmed: true,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    // Deliberately skip setPrivacy.
    db.close();
    await handleWeeklyAlarm({ now: NOW });
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('handleWeeklyAlarm — error handling', () => {
  async function setupHappyEnv(): Promise<void> {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
  }

  it('rate_limited → warn log, no summary write', async () => {
    await setupHappyEnv();
    mockGenerateReport.mockResolvedValue({
      ok: false,
      status: 429,
      error: 'rate_limited',
    });

    await handleWeeklyAlarm({ now: NOW });

    expect(warnSpy).toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    const db = await openDb();
    expect(await getAllWeeklySummaries(db)).toEqual([]);
    db.close();
  });

  it.each([
    ['network_error', 0],
    ['server_error', 500],
    ['email_send_failed', 502],
    ['aborted', 0],
    ['invalid_response', 200],
    ['unauthorized', 401],
  ] as const)('%s → error log, no summary write', async (error, status) => {
    await setupHappyEnv();
    mockGenerateReport.mockResolvedValue({
      ok: false,
      status,
      error,
    } as never);

    await handleWeeklyAlarm({ now: NOW });

    expect(errSpy).toHaveBeenCalled();
    const db = await openDb();
    expect(await getAllWeeklySummaries(db)).toEqual([]);
    db.close();
  });

  it('does not write a summary for a rate_limited response', async () => {
    await setupHappyEnv();
    mockGenerateReport.mockResolvedValue({
      ok: false,
      status: 429,
      error: 'rate_limited',
    });
    await handleWeeklyAlarm({ now: NOW });
    const db = await openDb();
    expect(await getAllWeeklySummaries(db)).toEqual([]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// weeklyAlarmListener
// ---------------------------------------------------------------------------

describe('weeklyAlarmListener', () => {
  it('only reacts to WEEKLY_ALARM_NAME — ignores other alarm names', () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    weeklyAlarmListener({ name: 'some-other-alarm' } as chrome.alarms.Alarm);
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('kicks off handleWeeklyAlarm when the name matches', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    weeklyAlarmListener({ name: WEEKLY_ALARM_NAME } as chrome.alarms.Alarm);

    // listener is fire-and-forget; drain microtasks and wait a tick.
    await new Promise((r) => setTimeout(r, 50));

    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
  });

  it('swallows thrown errors — nothing escapes to the runtime', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockRejectedValue(new Error('boom'));

    // Must not throw synchronously.
    expect(() =>
      weeklyAlarmListener({ name: WEEKLY_ALARM_NAME } as chrome.alarms.Alarm),
    ).not.toThrow();

    // And nothing escapes async either — the internal `.catch` handles it.
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns void synchronously (does not await)', () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    mockGenerateReport.mockResolvedValue(okResponse());
    const ret = weeklyAlarmListener({ name: WEEKLY_ALARM_NAME } as chrome.alarms.Alarm);
    expect(ret).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chunk 10.2 — prior-week summary wiring
// ---------------------------------------------------------------------------

describe('handleWeeklyAlarm — priorWeekSummary wiring (Chunk 10.2)', () => {
  // Reusable builders — a few variants of the stored-summary shape so each
  // test can reason about what's in IDB without recomputing the whole
  // ReportSections object inline.
  function richSections(): ReportResponse['sections'] {
    return {
      subject: 'Your week in tabs.',
      preheader: 'Heavy on ML reading.',
      rabbitHoles: [
        {
          sessionId: 's1',
          label: 'rust async runtimes',
          paragraph: 'A long paragraph.',
          quotableDetail: 'tokio ships 3x more releases than async-std',
          startLocal: '2026-04-03T09:00',
          endLocal: '2026-04-03T11:00',
          activeMs: 7_200_000,
          tabCount: 14,
        },
        {
          sessionId: 's2',
          label: '12-URL session on stackoverflow.com',
          paragraph: 'deterministic paragraph',
          quotableDetail: 'Twelve unique URLs.',
          startLocal: '2026-04-04T14:00',
          endLocal: '2026-04-04T15:30',
          activeMs: 5_400_000,
          tabCount: 12,
        },
      ],
      themes: [
        { label: 'machine learning', share: 0.42, exampleDomains: ['arxiv.org', 'huggingface.co'] },
        { label: 'typescript tooling', share: 0.23, exampleDomains: ['github.com'] },
      ],
      obsessions: [
        { domain: 'github.com', activeMs: 3_600_000, visits: 42, line: 'line 1' },
        { domain: 'news.ycombinator.com', activeMs: 900_000, visits: 18, line: 'line 2' },
      ],
      ghostTabs: [],
      wow: [],
      tabsStillAlive: [],
      generatedWith: 'cloud',
    };
  }

  it('Week 1: no stored summaries → payload has NO `priorWeekSummary` key', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    const [payload] = mockGenerateReport.mock.calls[0]!;
    // exactOptionalPropertyTypes: the key must be entirely absent, not
    // present-with-undefined.
    expect('priorWeekSummary' in payload).toBe(false);
  });

  it('Week 2+: a stored prior-week summary is projected and attached to the payload', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    const priorSections = richSections();
    await putWeeklySummary(db, {
      weekStart: '2026-04-09', // one week before NOW's 2026-04-16
      sections: priorSections,
      generatedAt: NOW - 7 * 24 * 60 * 60 * 1000,
      schemaVersion: SCHEMA_VERSION,
    });
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    const [payload] = mockGenerateReport.mock.calls[0]!;
    expect('priorWeekSummary' in payload).toBe(true);

    // Validate against the wire schema — the projector's .parse also did
    // this, but asserting here locks the contract end-to-end.
    const { priorWeekSummarySchema } = await import('@tabob/shared');
    const pws = payload.priorWeekSummary;
    expect(() => priorWeekSummarySchema.parse(pws)).not.toThrow();

    // It should be the projection of the STORED sections.
    expect(pws).toEqual({
      weekStart: '2026-04-09',
      themes: [
        { label: 'machine learning', share: 0.42 },
        { label: 'typescript tooling', share: 0.23 },
      ],
      obsessions: [
        { domain: 'github.com', activeMs: 3_600_000 },
        { domain: 'news.ycombinator.com', activeMs: 900_000 },
      ],
      rabbitHoleLabels: ['rust async runtimes', '12-URL session on stackoverflow.com'],
    });
  });

  it('picks the chronologically-latest stored summary when multiple are present (out of insertion order)', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);

    // Insertion order deliberately jumbled; latest by ISO weekStart is 04-05.
    await putWeeklySummary(db, {
      weekStart: '2026-03-22',
      sections: { ...richSections(), subject: 'older' },
      generatedAt: 1,
      schemaVersion: SCHEMA_VERSION,
    });
    await putWeeklySummary(db, {
      weekStart: '2026-04-05',
      sections: { ...richSections(), subject: 'latest' },
      generatedAt: 3,
      schemaVersion: SCHEMA_VERSION,
    });
    await putWeeklySummary(db, {
      weekStart: '2026-03-29',
      sections: { ...richSections(), subject: 'middle' },
      generatedAt: 2,
      schemaVersion: SCHEMA_VERSION,
    });
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    const [payload] = mockGenerateReport.mock.calls[0]!;
    expect(payload.priorWeekSummary).toBeDefined();
    expect(payload.priorWeekSummary?.weekStart).toBe('2026-04-05');
  });

  it('defensive gate: duplicate-summary guard fires BEFORE the prior-week projection', async () => {
    // If the current week already has a stored summary, the early-return in
    // the duplicate guard should win — we must never reach the projector,
    // never call generateReport, and never attach a priorWeekSummary.
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    await putWeeklySummary(db, {
      // NOW = 2026-04-23 → weekStart = 2026-04-16 (same as current).
      weekStart: '2026-04-16',
      sections: richSections(),
      generatedAt: NOW - 60_000,
      schemaVersion: SCHEMA_VERSION,
    });
    db.close();

    await handleWeeklyAlarm({ now: NOW });

    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it('schema drift: a malformed stored summary does NOT kill the weekly send (caught, logged, skipped)', async () => {
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);

    // Inject a structurally-malformed theme (non-number share). The
    // projector's `.parse` will throw; the handler must catch and proceed
    // WITHOUT priorWeekSummary rather than failing the whole send.
    const corrupt = richSections();
    corrupt.themes = [
      {
        label: 'bad',
        share: 'corrupt' as unknown as number,
        exampleDomains: [],
      },
    ];
    await putWeeklySummary(db, {
      weekStart: '2026-04-09',
      sections: corrupt,
      generatedAt: NOW - 7 * 24 * 60 * 60 * 1000,
      schemaVersion: SCHEMA_VERSION,
    });
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    // Send still happened.
    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
    const [payload] = mockGenerateReport.mock.calls[0]!;
    // But no priorWeekSummary on the payload.
    expect('priorWeekSummary' in payload).toBe(false);
    // And a warn log explaining the skip.
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not read `user.unsubscribed` — cached summary is used regardless of subscription state', async () => {
    // Product decision (noted by 10.1 test agent): unsubscribed users can
    // accumulate cached summaries. If they re-subscribe, the stale summary
    // is still used. This test guards against accidentally making the code
    // gate on subscription state — projection must be unconditional on user
    // fields beyond what the duplicate-guard already checks.
    setChrome(makeStorage({ clientToken: 'tok' }).chrome);
    const db = await openDb();
    await seedUserAndPrivacy(db);
    await putWeeklySummary(db, {
      weekStart: '2026-04-09',
      sections: richSections(),
      generatedAt: NOW - 7 * 24 * 60 * 60 * 1000,
      schemaVersion: SCHEMA_VERSION,
    });
    db.close();
    mockGenerateReport.mockResolvedValue(okResponse());

    await handleWeeklyAlarm({ now: NOW });

    const [payload] = mockGenerateReport.mock.calls[0]!;
    // Projection happened regardless of any subscription-state consideration.
    expect(payload.priorWeekSummary).toBeDefined();
    expect(payload.priorWeekSummary?.weekStart).toBe('2026-04-09');
  });
});
