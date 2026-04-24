import type { PriorWeekSummary, TabEvent } from '@tabob/shared';
import { SCHEMA_VERSION, reportPayloadSchema } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { buildReportPayload } from './build-payload.js';

const WEEK_START = '2026-04-20';
const WEEK_END = '2026-04-27';
// 2026-04-20T00:00:00Z .. 2026-04-27T00:00:00Z (UTC)
const WEEK_START_MS = Date.UTC(2026, 3, 20, 0, 0, 0, 0);
const WEEK_END_MS = Date.UTC(2026, 3, 27, 0, 0, 0, 0);
const NOW_MS = Date.UTC(2026, 3, 27, 12, 0, 0, 0); // a bit after week end
const UUID = '11111111-1111-4111-8111-111111111111';

const DAY_MS = 24 * 60 * 60 * 1000;

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    tzOffsetMin: 0,
    ...partial,
  };
}

function tickStream(from: number, to: number): TabEvent[] {
  const out: TabEvent[] = [];
  for (let t = from; t <= to; t += 30_000) out.push(ev({ type: 'input_tick', ts: t }));
  return out;
}

/**
 * Produce a realistic ~50-event week snippet that yields at least one candidate
 * session and non-empty obsessions/pairs. Uses `baseTs` as session start.
 */
function candidateWeekEvents(baseTs: number): TabEvent[] {
  const events: TabEvent[] = [];
  // 35 minutes of active time, hopping between 4 canonical domains (6 URLs).
  events.push(ev({ type: 'window_focus', ts: baseTs, windowId: 1, windowFocused: true }));
  events.push(ev({ type: 'activate', ts: baseTs, tabId: 10, windowId: 1 }));
  events.push(
    ev({ type: 'open', ts: baseTs, tabId: 10, url: 'https://en.wikipedia.org/wiki/A', title: 'A' }),
  );
  events.push(...tickStream(baseTs, baseTs + 5 * 60_000));
  events.push(
    ev({
      type: 'navigate',
      ts: baseTs + 5 * 60_000,
      tabId: 10,
      url: 'https://en.wikipedia.org/wiki/B',
      title: 'B',
    }),
  );
  events.push(...tickStream(baseTs + 5 * 60_000, baseTs + 9 * 60_000));
  events.push(
    ev({
      type: 'navigate',
      ts: baseTs + 9 * 60_000,
      tabId: 10,
      url: 'https://news.ycombinator.com/item?id=1',
      title: 'HN',
    }),
  );
  events.push(...tickStream(baseTs + 9 * 60_000, baseTs + 19 * 60_000));
  events.push(
    ev({
      type: 'navigate',
      ts: baseTs + 19 * 60_000,
      tabId: 10,
      url: 'https://m.bbc.co.uk/news/x',
      title: 'BBC',
    }),
  );
  events.push(...tickStream(baseTs + 19 * 60_000, baseTs + 25 * 60_000));
  events.push(
    ev({
      type: 'navigate',
      ts: baseTs + 25 * 60_000,
      tabId: 10,
      url: 'https://www.theguardian.com/tech',
      title: 'Guardian',
    }),
  );
  events.push(...tickStream(baseTs + 25 * 60_000, baseTs + 30 * 60_000));
  events.push(
    ev({
      type: 'navigate',
      ts: baseTs + 30 * 60_000,
      tabId: 10,
      url: 'https://news.ycombinator.com/item?id=2',
      title: 'HN2',
    }),
  );
  events.push(...tickStream(baseTs + 30 * 60_000, baseTs + 35 * 60_000));
  events.push(ev({ type: 'deactivate', ts: baseTs + 35 * 60_000, tabId: 10, windowId: 1 }));
  return events;
}

/**
 * Helper for readable fixtures: a minimal in-week event list. Returns events exactly
 * as provided, but wrapped with default SCHEMA_VERSION / tzOffsetMin metadata.
 */
function makeWeekEvents(
  partials: Array<Partial<TabEvent> & { type: TabEvent['type']; ts: number }>,
): TabEvent[] {
  return partials.map((p) => ev(p));
}

/** Default input with sensible defaults; callers override any field. */
function defaultInput(overrides: Partial<Parameters<typeof buildReportPayload>[0]> = {}) {
  return {
    events: [],
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    weekStartMs: WEEK_START_MS,
    weekEndMs: WEEK_END_MS,
    uuid: UUID,
    timezone: 'UTC',
    plan: 'free' as const,
    blocklist: new Set<string>(),
    preview: false,
    now: NOW_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('buildReportPayload', () => {
  it('happy path: synthetic week produces a payload that passes reportPayloadSchema', () => {
    const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000; // noon Monday UTC
    const events = candidateWeekEvents(baseTs);
    expect(events.length).toBeGreaterThan(40);

    const result = buildReportPayload(defaultInput({ events }));

    const parsed = reportPayloadSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
    expect(result.obsessions.length).toBeGreaterThan(0);
    expect(result.domainTitlePairs.length).toBeGreaterThan(0);
    expect(result.user).toEqual({
      uuid: UUID,
      timezone: 'UTC',
      plan: 'free',
      schemaVersion: SCHEMA_VERSION,
    });
    expect(result.week).toEqual({ start: WEEK_START, end: WEEK_END });
    // `priorWeekSummary` omitted when not provided (exactOptionalPropertyTypes).
    expect('priorWeekSummary' in result).toBe(false);
    // topDomains is plural and present on candidate sessions.
    expect(Array.isArray(result.candidateSessions[0]!.topDomains)).toBe(true);
    // urls on the payload candidate session carry no `domain` field.
    expect(result.candidateSessions[0]!.urls[0]).not.toHaveProperty('domain');
  });

  it('filters events outside the week bounds (inclusive start, exclusive end)', () => {
    const inside = WEEK_START_MS + 60_000;
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: WEEK_START_MS - 1,
        tabId: 1,
        url: 'https://outside-left.com/',
        title: 'before',
      }),
      ev({
        type: 'navigate',
        ts: WEEK_END_MS,
        tabId: 2,
        url: 'https://outside-right.com/',
        title: 'at-end',
      }),
      ev({
        type: 'navigate',
        ts: WEEK_START_MS,
        tabId: 3,
        url: 'https://inside-left.com/',
        title: 'at-start',
      }),
      ev({
        type: 'navigate',
        ts: WEEK_END_MS - 1,
        tabId: 4,
        url: 'https://inside-right.com/',
        title: 'just-before-end',
      }),
      ev({ type: 'input_tick', ts: inside }),
    ];

    const result = buildReportPayload(defaultInput({ events, preview: true }));
    // 3 events survive the window filter (2 at boundary edges + 1 tick inside).
    expect(result.totals.events).toBe(3);
    const seenDomains = result.domainTitlePairs.map((p) => p.domain);
    expect(seenDomains).not.toContain('outside-left.com');
    expect(seenDomains).not.toContain('outside-right.com');
  });

  it('blocklist filter drops events for a banned domain', () => {
    const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: baseTs, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: baseTs, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: baseTs, tabId: 10, url: 'https://evil.com/x', title: 'Evil' }),
      ...tickStream(baseTs, baseTs + 60_000),
      ev({
        type: 'navigate',
        ts: baseTs + 60_000,
        tabId: 10,
        url: 'https://good.com/y',
        title: 'Good',
      }),
      ...tickStream(baseTs + 60_000, baseTs + 120_000),
    ];

    const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));

    const obsessionDomains = result.obsessions.map((o) => o.domain);
    expect(obsessionDomains).not.toContain('evil.com');
    const pairDomains = result.domainTitlePairs.map((p) => p.domain);
    expect(pairDomains).not.toContain('evil.com');
  });

  it('lateNight: true when a candidate session spans 22:00–23:30 local', () => {
    // Pick a Tuesday inside the UTC week at 22:00 UTC with timezone 'UTC'.
    const baseTs = Date.UTC(2026, 3, 21, 22, 0, 0, 0);
    const events = candidateWeekEvents(baseTs);

    const result = buildReportPayload(defaultInput({ events }));

    expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
    expect(result.candidateSessions[0]!.lateNight).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Wire-contract validity & orchestration
  // -------------------------------------------------------------------------

  describe('wire-contract validity', () => {
    it('empty input produces a payload that passes reportPayloadSchema', () => {
      const result = buildReportPayload(defaultInput({ events: [] }));
      const parsed = reportPayloadSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      expect(result.candidateSessions).toEqual([]);
      expect(result.obsessions).toEqual([]);
      expect(result.domainTitlePairs).toEqual([]);
      expect(result.ghostTabCandidates).toEqual([]);
      expect(result.tabsStillAlive).toEqual([]);
      expect(result.totals).toEqual({ activeMs: 0, events: 0 });
    });

    it('schemaVersion is literal 1', () => {
      const result = buildReportPayload(defaultInput());
      expect(result.user.schemaVersion).toBe(1);
      expect(result.user.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('uuid carried verbatim; week strings carried verbatim', () => {
      const customUuid = '22222222-2222-4222-8222-222222222222';
      const result = buildReportPayload(
        defaultInput({ uuid: customUuid, weekStart: '2030-01-01', weekEnd: '2030-01-08' }),
      );
      expect(result.user.uuid).toBe(customUuid);
      expect(result.week.start).toBe('2030-01-01');
      expect(result.week.end).toBe('2030-01-08');
    });

    it('preview: true is carried through', () => {
      const result = buildReportPayload(defaultInput({ preview: true }));
      expect(result.preview).toBe(true);
    });

    it('preview: false is carried through', () => {
      const result = buildReportPayload(defaultInput({ preview: false }));
      expect(result.preview).toBe(false);
    });

    it('passes schema with candidateSessions AND priorWeekSummary', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const prior: PriorWeekSummary = {
        weekStart: '2026-04-13',
        themes: [{ label: 'AI research', share: 0.5 }],
        obsessions: [{ domain: 'news.ycombinator.com', activeMs: 3_600_000 }],
        rabbitHoleLabels: ['A long HN adventure'],
      };
      const result = buildReportPayload(
        defaultInput({ events: candidateWeekEvents(baseTs), priorWeekSummary: prior }),
      );
      const parsed = reportPayloadSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      expect(result.priorWeekSummary).toEqual(prior);
      expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
    });

    it('passes schema with no candidateSessions and no priorWeekSummary', () => {
      // Short, sub-threshold events: no candidate sessions will be produced.
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const events = makeWeekEvents([
        { type: 'window_focus', ts: baseTs, windowId: 1, windowFocused: true },
        { type: 'activate', ts: baseTs, tabId: 1, windowId: 1 },
        { type: 'open', ts: baseTs, tabId: 1, url: 'https://a.com/', title: 'A' },
        { type: 'input_tick', ts: baseTs },
        { type: 'input_tick', ts: baseTs + 1000 },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      const parsed = reportPayloadSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      expect(result.candidateSessions).toEqual([]);
      expect('priorWeekSummary' in result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Week-bound filtering
  // -------------------------------------------------------------------------

  describe('week-bound filtering', () => {
    it('event at exactly weekStartMs is KEPT', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: WEEK_START_MS, tabId: 1, url: 'https://keepme.com/', title: 'K' },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.totals.events).toBe(1);
      expect(result.domainTitlePairs.map((p) => p.domain)).toContain('keepme.com');
    });

    it('event at exactly weekEndMs - 1 is KEPT', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: WEEK_END_MS - 1, tabId: 1, url: 'https://keepme.com/', title: 'K' },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.totals.events).toBe(1);
    });

    it('event at exactly weekEndMs is DROPPED (exclusive right)', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: WEEK_END_MS, tabId: 1, url: 'https://drop.com/', title: 'D' },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.totals.events).toBe(0);
      expect(result.domainTitlePairs).toEqual([]);
    });

    it('event at weekStartMs - 1 is DROPPED (left is strict <)', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: WEEK_START_MS - 1, tabId: 1, url: 'https://drop.com/', title: 'D' },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.totals.events).toBe(0);
    });

    it('multi-day events clustered near both boundaries survive correctly', () => {
      const events = makeWeekEvents([
        // just outside left
        {
          type: 'navigate',
          ts: WEEK_START_MS - 1000,
          tabId: 1,
          url: 'https://drop-l.com/',
          title: 'L',
        },
        // just inside left
        {
          type: 'navigate',
          ts: WEEK_START_MS + 1000,
          tabId: 2,
          url: 'https://keep-l.com/',
          title: 'L2',
        },
        // just inside right
        {
          type: 'navigate',
          ts: WEEK_END_MS - 1000,
          tabId: 3,
          url: 'https://keep-r.com/',
          title: 'R',
        },
        // just outside right
        {
          type: 'navigate',
          ts: WEEK_END_MS + 1000,
          tabId: 4,
          url: 'https://drop-r.com/',
          title: 'R2',
        },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.totals.events).toBe(2);
      const domains = result.domainTitlePairs.map((p) => p.domain);
      expect(domains).toEqual(expect.arrayContaining(['keep-l.com', 'keep-r.com']));
      expect(domains).not.toContain('drop-l.com');
      expect(domains).not.toContain('drop-r.com');
    });

    it('all events outside the week → empty result with zeroed totals', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: WEEK_START_MS - 100, tabId: 1, url: 'https://a.com/' },
        { type: 'navigate', ts: WEEK_END_MS + 100, tabId: 2, url: 'https://b.com/' },
        { type: 'input_tick', ts: WEEK_END_MS },
      ]);
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.totals).toEqual({ activeMs: 0, events: 0 });
      expect(result.candidateSessions).toEqual([]);
      expect(result.obsessions).toEqual([]);
      expect(result.ghostTabCandidates).toEqual([]);
      expect(result.domainTitlePairs).toEqual([]);
      expect(result.tabsStillAlive).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Blocklist semantics
  // -------------------------------------------------------------------------

  describe('blocklist semantics', () => {
    const baseTs = WEEK_START_MS + 60_000;

    it('drops plain, www, AND subdomain variants (canonical eTLD+1 match)', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: baseTs, tabId: 1, url: 'https://evil.com/x', title: 'plain' },
        { type: 'navigate', ts: baseTs + 1, tabId: 2, url: 'https://www.evil.com/y', title: 'www' },
        { type: 'navigate', ts: baseTs + 2, tabId: 3, url: 'https://sub.evil.com/z', title: 'sub' },
        { type: 'navigate', ts: baseTs + 3, tabId: 4, url: 'https://good.com/q', title: 'good' },
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));
      expect(result.totals.events).toBe(1);
      const domains = result.domainTitlePairs.map((p) => p.domain);
      expect(domains).toEqual(['good.com']);
    });

    it('blocklist entry with a www. prefix normalises and still matches', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: baseTs, tabId: 1, url: 'https://evil.com/x', title: 'e' },
        { type: 'navigate', ts: baseTs + 1, tabId: 2, url: 'https://good.com/y', title: 'g' },
      ]);
      const result = buildReportPayload(
        defaultInput({ events, blocklist: new Set(['www.evil.com']) }),
      );
      const domains = result.domainTitlePairs.map((p) => p.domain);
      expect(domains).toEqual(['good.com']);
    });

    it('blocklist is case-insensitive (Evil.COM matches evil.com)', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: baseTs, tabId: 1, url: 'https://evil.com/x', title: 'e' },
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['Evil.COM']) }));
      expect(result.totals.events).toBe(0);
      expect(result.domainTitlePairs).toEqual([]);
    });

    it('event with `domain` field set and no `url` is matched via stripped-www domain', () => {
      const events = makeWeekEvents([
        // No `url` — code path uses `ev.domain` with www.-strip.
        { type: 'navigate', ts: baseTs, tabId: 1, domain: 'www.evil.com', title: 'e' },
        { type: 'navigate', ts: baseTs + 1, tabId: 2, domain: 'good.com', title: 'g' },
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));
      // Only the "good.com" navigate survives. (No url means it won't show up in
      // domainTitlePairs, but totals.events should reflect the filter.)
      expect(result.totals.events).toBe(1);
    });

    it('substring-only match (foo.evilcorp.com with blocklist evil.com) is NOT dropped', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: baseTs, tabId: 1, url: 'https://foo.evilcorp.com/', title: 'ec' },
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));
      expect(result.totals.events).toBe(1);
      expect(result.domainTitlePairs.map((p) => p.domain)).toEqual(['evilcorp.com']);
    });

    it('input_tick / idle_state / window_focus (no url, no domain) always pass through', () => {
      const events = makeWeekEvents([
        { type: 'input_tick', ts: baseTs },
        { type: 'idle_state', ts: baseTs + 100, idleState: 'idle' },
        { type: 'window_focus', ts: baseTs + 200, windowId: 1, windowFocused: true },
      ]);
      const result = buildReportPayload(
        defaultInput({ events, blocklist: new Set(['evil.com', 'x.com']) }),
      );
      expect(result.totals.events).toBe(3);
    });

    it('empty blocklist filters nothing', () => {
      const events = makeWeekEvents([
        { type: 'navigate', ts: baseTs, tabId: 1, url: 'https://evil.com/', title: 'e' },
        { type: 'navigate', ts: baseTs + 1, tabId: 2, url: 'https://good.com/', title: 'g' },
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set() }));
      expect(result.totals.events).toBe(2);
    });

    it('blocklisted URL inside an otherwise-candidate session is filtered from that session', () => {
      // Build a rabbit-hole session. One of the URLs is blocklisted; its activity should
      // vanish from the session's `urls` and `topDomains`.
      const baseTs2 = WEEK_START_MS + 14 * 60 * 60 * 1000;
      const events: TabEvent[] = [
        ev({ type: 'window_focus', ts: baseTs2, windowId: 1, windowFocused: true }),
        ev({ type: 'activate', ts: baseTs2, tabId: 10, windowId: 1 }),
        ev({ type: 'open', ts: baseTs2, tabId: 10, url: 'https://a.com/1', title: 'A1' }),
        ...tickStream(baseTs2, baseTs2 + 7 * 60_000),
        ev({
          type: 'navigate',
          ts: baseTs2 + 7 * 60_000,
          tabId: 10,
          url: 'https://evil.com/hidden',
          title: 'EVIL',
        }),
        ...tickStream(baseTs2 + 7 * 60_000, baseTs2 + 14 * 60_000),
        ev({
          type: 'navigate',
          ts: baseTs2 + 14 * 60_000,
          tabId: 10,
          url: 'https://b.com/1',
          title: 'B1',
        }),
        ...tickStream(baseTs2 + 14 * 60_000, baseTs2 + 21 * 60_000),
        ev({
          type: 'navigate',
          ts: baseTs2 + 21 * 60_000,
          tabId: 10,
          url: 'https://c.com/1',
          title: 'C1',
        }),
        ...tickStream(baseTs2 + 21 * 60_000, baseTs2 + 28 * 60_000),
        ev({
          type: 'navigate',
          ts: baseTs2 + 28 * 60_000,
          tabId: 10,
          url: 'https://d.com/1',
          title: 'D1',
        }),
        ...tickStream(baseTs2 + 28 * 60_000, baseTs2 + 35 * 60_000),
        ev({
          type: 'navigate',
          ts: baseTs2 + 35 * 60_000,
          tabId: 10,
          url: 'https://e.com/1',
          title: 'E1',
        }),
        ...tickStream(baseTs2 + 35 * 60_000, baseTs2 + 42 * 60_000),
      ];
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));
      // Session survives; evil.com must not appear anywhere downstream.
      for (const session of result.candidateSessions) {
        expect(session.topDomains).not.toContain('evil.com');
        for (const u of session.urls) {
          expect(u.url).not.toContain('evil.com');
        }
      }
      expect(result.obsessions.map((o) => o.domain)).not.toContain('evil.com');
      expect(result.domainTitlePairs.map((p) => p.domain)).not.toContain('evil.com');
      expect(result.ghostTabCandidates.map((g) => g.url)).not.toContain(
        expect.stringContaining('evil.com'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // lateNight detection
  // -------------------------------------------------------------------------

  describe('lateNight detection', () => {
    // Build a candidate-eligible event list around a given baseTs.
    const sessionAt = (baseTs: number) => candidateWeekEvents(baseTs);

    it('14:00–15:00 UTC with tz=UTC → lateNight false', () => {
      const baseTs = Date.UTC(2026, 3, 21, 14, 0, 0, 0);
      const result = buildReportPayload(defaultInput({ events: sessionAt(baseTs) }));
      expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
      expect(result.candidateSessions[0]!.lateNight).toBe(false);
    });

    it('22:00–23:30 UTC with tz=UTC → lateNight true', () => {
      const baseTs = Date.UTC(2026, 3, 21, 22, 0, 0, 0);
      const result = buildReportPayload(defaultInput({ events: sessionAt(baseTs) }));
      expect(result.candidateSessions[0]!.lateNight).toBe(true);
    });

    it('01:00–01:30 UTC with tz=UTC → lateNight true (before 2am)', () => {
      const baseTs = Date.UTC(2026, 3, 22, 1, 0, 0, 0);
      const result = buildReportPayload(defaultInput({ events: sessionAt(baseTs) }));
      expect(result.candidateSessions[0]!.lateNight).toBe(true);
    });

    it('a session starting exactly at 21:00 UTC is late-night (start inclusive)', () => {
      // Use a session starting exactly at 21:00 UTC. The endpoint sample at 21:00 qualifies.
      const baseTs = Date.UTC(2026, 3, 21, 21, 0, 0, 0);
      const result = buildReportPayload(defaultInput({ events: sessionAt(baseTs) }));
      expect(result.candidateSessions[0]!.lateNight).toBe(true);
    });

    it('a session entirely at 02:00 UTC onward (02:00–02:35) is NOT late-night', () => {
      // Window is [21,2) — 2 is exclusive. Session spans 02:00–02:35.
      // We need the session to actually be at 02:00–02:35 UTC; the candidateWeekEvents
      // helper spans 35 minutes starting at baseTs.
      const baseTs = Date.UTC(2026, 3, 22, 2, 0, 0, 0);
      const result = buildReportPayload(defaultInput({ events: sessionAt(baseTs) }));
      expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
      expect(result.candidateSessions[0]!.lateNight).toBe(false);
    });

    it('same UTC instant in America/New_York is 18:00 → lateNight false', () => {
      // 22:00 UTC == 18:00 America/New_York (EDT, UTC-4 in April).
      const baseTs = Date.UTC(2026, 3, 21, 22, 0, 0, 0);
      const result = buildReportPayload(
        defaultInput({ events: sessionAt(baseTs), timezone: 'America/New_York' }),
      );
      expect(result.candidateSessions[0]!.lateNight).toBe(false);
    });

    it('same UTC instant in UTC is 22:00 → lateNight true (confirms tz awareness)', () => {
      const baseTs = Date.UTC(2026, 3, 21, 22, 0, 0, 0);
      const result = buildReportPayload(
        defaultInput({ events: sessionAt(baseTs), timezone: 'UTC' }),
      );
      expect(result.candidateSessions[0]!.lateNight).toBe(true);
    });

    it('unrecognised timezone falls back to UTC hour and does not throw', () => {
      const baseTs = Date.UTC(2026, 3, 21, 22, 0, 0, 0);
      expect(() =>
        buildReportPayload(
          defaultInput({ events: sessionAt(baseTs), timezone: 'Not/A_Real_Zone' }),
        ),
      ).not.toThrow();
      const result = buildReportPayload(
        defaultInput({ events: sessionAt(baseTs), timezone: 'Not/A_Real_Zone' }),
      );
      // UTC fallback @ 22:00 UTC → late-night true.
      expect(result.candidateSessions[0]!.lateNight).toBe(true);
    });

    it('session crossing a DST spring-forward boundary in America/New_York does not crash', () => {
      // DST starts 2026-03-08 for the US. The canonical week here is April, but we can still
      // verify a DST-era session does not throw. Use a session at 06:30 UTC (02:30 EDT).
      const dstBase = Date.UTC(2026, 3, 22, 6, 30, 0, 0);
      expect(() =>
        buildReportPayload(
          defaultInput({ events: sessionAt(dstBase), timezone: 'America/New_York' }),
        ),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // tabsStillAlive
  // -------------------------------------------------------------------------

  describe('tabsStillAlive', () => {
    it('tab opened in-week, no close, age >= 3 days → included', () => {
      const openTs = WEEK_START_MS + 60_000; // early in week
      const nowTs = openTs + 3 * DAY_MS + 1; // age 3 days + 1ms (floor = 3)
      const events = makeWeekEvents([
        { type: 'open', ts: openTs, tabId: 42, url: 'https://alive.com/', title: 'Alive' },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toEqual([
        { url: 'https://alive.com/', title: 'Alive', openTs, ageDays: 3 },
      ]);
    });

    it('tab opened in-week, no close, age exactly 2 days → NOT included', () => {
      const openTs = WEEK_START_MS + 60_000;
      const nowTs = openTs + 2 * DAY_MS;
      const events = makeWeekEvents([
        { type: 'open', ts: openTs, tabId: 42, url: 'https://alive.com/', title: 'Alive' },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toEqual([]);
    });

    it('tab opened and closed in-week → NOT included', () => {
      const openTs = WEEK_START_MS + 60_000;
      const nowTs = openTs + 10 * DAY_MS;
      const events = makeWeekEvents([
        { type: 'open', ts: openTs, tabId: 42, url: 'https://closed.com/', title: 'Closed' },
        { type: 'close', ts: openTs + 60_000, tabId: 42 },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toEqual([]);
    });

    it('tab opened in-week but no URL ever attached → SKIPPED', () => {
      const openTs = WEEK_START_MS + 60_000;
      const nowTs = openTs + 10 * DAY_MS;
      // `open` event has no url, no subsequent navigate with url.
      const events = makeWeekEvents([
        { type: 'open', ts: openTs, tabId: 42 }, // no url
        { type: 'navigate', ts: openTs + 1000, tabId: 42 }, // also no url
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toEqual([]);
    });

    it('tab with ONLY activate events (no `open`) → NOT in tabsStillAlive', () => {
      const ts = WEEK_START_MS + 60_000;
      const nowTs = ts + 10 * DAY_MS;
      const events = makeWeekEvents([
        { type: 'activate', ts, tabId: 99, windowId: 1 },
        { type: 'navigate', ts: ts + 1000, tabId: 99, url: 'https://x.com/', title: 'X' },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toEqual([]);
    });

    it('sort order: oldest openTs first', () => {
      const baseOpenA = WEEK_START_MS + 1 * 60 * 60 * 1000;
      const baseOpenB = WEEK_START_MS + 2 * 60 * 60 * 1000;
      const baseOpenC = WEEK_START_MS + 3 * 60 * 60 * 1000;
      const nowTs = WEEK_END_MS + 5 * DAY_MS;
      const events = makeWeekEvents([
        { type: 'open', ts: baseOpenC, tabId: 3, url: 'https://c.com/', title: 'C' },
        { type: 'open', ts: baseOpenA, tabId: 1, url: 'https://a.com/', title: 'A' },
        { type: 'open', ts: baseOpenB, tabId: 2, url: 'https://b.com/', title: 'B' },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive.map((t) => t.url)).toEqual([
        'https://a.com/',
        'https://b.com/',
        'https://c.com/',
      ]);
    });

    it('ageDays floors: now - openTs = 3*DAY_MS - 1 → ageDays = 2 → dropped', () => {
      const openTs = WEEK_START_MS + 1000;
      const nowTs = openTs + 3 * DAY_MS - 1; // one ms short of 3 full days
      const events = makeWeekEvents([
        { type: 'open', ts: openTs, tabId: 7, url: 'https://near.com/', title: 'Near' },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toEqual([]);
    });

    it('openTs = FIRST open event, even when earlier activate/navigate exist', () => {
      // A tab has activate and navigate first (no open), then receives an `open` later.
      // tabsStillAlive must use the FIRST `open` ts for ageDays, not the first observed event.
      const activateTs = WEEK_START_MS + 60_000;
      const openTs = activateTs + 10 * 60_000;
      const nowTs = openTs + 4 * DAY_MS;
      const events = makeWeekEvents([
        { type: 'activate', ts: activateTs, tabId: 8, windowId: 1 },
        {
          type: 'navigate',
          ts: activateTs + 1000,
          tabId: 8,
          url: 'https://pre.com/',
          title: 'Pre',
        },
        { type: 'open', ts: openTs, tabId: 8, url: 'https://real.com/', title: 'Real' },
      ]);
      const result = buildReportPayload(defaultInput({ events, now: nowTs }));
      expect(result.tabsStillAlive).toHaveLength(1);
      // ageDays is based on openTs (first `open` event), not the activate ts.
      expect(result.tabsStillAlive[0]!.openTs).toBe(openTs);
      // (nowTs - openTs) = 4 days exactly → ageDays = 4.
      expect(result.tabsStillAlive[0]!.ageDays).toBe(4);
      // URL comes from the latest nav/open with a URL.
      expect(result.tabsStillAlive[0]!.url).toBe('https://real.com/');
    });
  });

  // -------------------------------------------------------------------------
  // Candidate → PayloadCandidateSession conversion
  // -------------------------------------------------------------------------

  describe('candidateToPayload conversion', () => {
    it('urls[] entries have no `domain` field', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const result = buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs) }));
      expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
      for (const session of result.candidateSessions) {
        for (const url of session.urls) {
          expect(url).not.toHaveProperty('domain');
          // Keys should be exactly the 4 documented ones.
          expect(Object.keys(url).sort()).toEqual(['activeMs', 'openTs', 'title', 'url']);
        }
      }
    });

    it('start and end are parseable ISO strings', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const result = buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs) }));
      const session = result.candidateSessions[0]!;
      expect(() => new Date(session.start)).not.toThrow();
      expect(() => new Date(session.end)).not.toThrow();
      expect(Number.isFinite(new Date(session.start).getTime())).toBe(true);
      expect(Number.isFinite(new Date(session.end).getTime())).toBe(true);
      // ISO 8601 Z-suffix.
      expect(session.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(session.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('topDomains length is at most 5', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const result = buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs) }));
      for (const s of result.candidateSessions) {
        expect(s.topDomains.length).toBeLessThanOrEqual(5);
      }
    });

    it('topDomains: cap at 5, sorted by summed activeMs desc, lex tie-break', () => {
      // Craft a session with 6 distinct canonical domains that each hold a URL. Since
      // activeMs is accumulated from the active-intervals state machine, we give each a
      // different amount of time by having the tab stay on each one for different counts
      // of minutes. All URLs live on tabId=10 with navigate events between them.
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const events: TabEvent[] = [
        ev({ type: 'window_focus', ts: baseTs, windowId: 1, windowFocused: true }),
        ev({ type: 'activate', ts: baseTs, tabId: 10, windowId: 1 }),
        ev({ type: 'open', ts: baseTs, tabId: 10, url: 'https://aaa.com/1', title: 'A' }),
      ];
      // Durations in minutes: aaa=8, bbb=7, ccc=6, ddd=5, eee=4, fff=3.
      // After sort desc: aaa, bbb, ccc, ddd, eee (top 5). fff dropped.
      const steps: Array<[string, number]> = [
        ['https://aaa.com/1', 8],
        ['https://bbb.com/1', 7],
        ['https://ccc.com/1', 6],
        ['https://ddd.com/1', 5],
        ['https://eee.com/1', 4],
        ['https://fff.com/1', 3],
      ];
      let cursor = baseTs;
      for (let i = 0; i < steps.length; i++) {
        const [url, mins] = steps[i]!;
        if (i > 0) {
          events.push(ev({ type: 'navigate', ts: cursor, tabId: 10, url, title: url }));
        }
        events.push(...tickStream(cursor, cursor + mins * 60_000));
        cursor += mins * 60_000;
      }
      const result = buildReportPayload(defaultInput({ events }));
      expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
      const top = result.candidateSessions[0]!.topDomains;
      // Exactly 5 entries, fff.com dropped.
      expect(top).toEqual(['aaa.com', 'bbb.com', 'ccc.com', 'ddd.com', 'eee.com']);
    });

    it('topDomains lex tiebreak when two domains have equal activeMs', () => {
      // Build a session with two canonical domains that receive identical active time.
      // Include 3 more domains to satisfy the candidate gate (>=5 distinct URLs total,
      // >=30 min total active). Total: 8+8+7+6+5 = 34 min.
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const events: TabEvent[] = [
        ev({ type: 'window_focus', ts: baseTs, windowId: 1, windowFocused: true }),
        ev({ type: 'activate', ts: baseTs, tabId: 10, windowId: 1 }),
        ev({ type: 'open', ts: baseTs, tabId: 10, url: 'https://zebra.com/', title: 'Z' }),
      ];
      let cursor = baseTs;
      // zebra.com: 8 minutes
      events.push(...tickStream(cursor, cursor + 8 * 60_000));
      cursor += 8 * 60_000;
      // aardvark.com: 8 minutes (tied with zebra)
      events.push(
        ev({ type: 'navigate', ts: cursor, tabId: 10, url: 'https://aardvark.com/', title: 'A' }),
      );
      events.push(...tickStream(cursor, cursor + 8 * 60_000));
      cursor += 8 * 60_000;
      // c.com: 7 minutes
      events.push(
        ev({ type: 'navigate', ts: cursor, tabId: 10, url: 'https://c.com/', title: 'C' }),
      );
      events.push(...tickStream(cursor, cursor + 7 * 60_000));
      cursor += 7 * 60_000;
      // d.com: 6 minutes
      events.push(
        ev({ type: 'navigate', ts: cursor, tabId: 10, url: 'https://d.com/', title: 'D' }),
      );
      events.push(...tickStream(cursor, cursor + 6 * 60_000));
      cursor += 6 * 60_000;
      // e.com: 5 minutes
      events.push(
        ev({ type: 'navigate', ts: cursor, tabId: 10, url: 'https://e.com/', title: 'E' }),
      );
      events.push(...tickStream(cursor, cursor + 5 * 60_000));
      cursor += 5 * 60_000;

      const result = buildReportPayload(defaultInput({ events }));
      expect(result.candidateSessions.length).toBeGreaterThanOrEqual(1);
      const top = result.candidateSessions[0]!.topDomains;
      // aardvark should precede zebra on lex tiebreak (both tied on activeMs).
      expect(top.indexOf('aardvark.com')).toBeLessThan(top.indexOf('zebra.com'));
    });

    it('candidate id is preserved from the session id', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const result = buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs) }));
      const session = result.candidateSessions[0]!;
      expect(session.id).toMatch(/^sess_\d+_[0-9a-f]{8}$/);
    });

    it('candidate activeMs is preserved (not recomputed)', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const result = buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs) }));
      const session = result.candidateSessions[0]!;
      // Sum of per-URL activeMs should match candidate activeMs (it's the same intervals).
      const urlSum = session.urls.reduce((acc, u) => acc + u.activeMs, 0);
      expect(session.activeMs).toBe(urlSum);
    });
  });

  // -------------------------------------------------------------------------
  // Totals
  // -------------------------------------------------------------------------

  describe('totals', () => {
    it('totals.events reflects post-filter count (blocklist + window)', () => {
      const baseTs = WEEK_START_MS + 60_000;
      const events = makeWeekEvents([
        // outside window — dropped
        { type: 'input_tick', ts: WEEK_START_MS - 1 },
        // inside window, non-blocklisted — kept
        { type: 'navigate', ts: baseTs, tabId: 1, url: 'https://good.com/', title: 'G' },
        // blocklisted — dropped
        { type: 'navigate', ts: baseTs + 1, tabId: 2, url: 'https://evil.com/', title: 'E' },
        // inside window, no url/domain — kept
        { type: 'input_tick', ts: baseTs + 2 },
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));
      expect(result.totals.events).toBe(2);
    });

    it('totals.activeMs == sum of activeTimePerTab over filtered events', () => {
      // Construct a tight fixture: focus on tab 10 for ~35 minutes.
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const events = candidateWeekEvents(baseTs);
      const result = buildReportPayload(defaultInput({ events }));
      // All activity is on tab 10 inside the week with no blocklist — totals should be > 0.
      expect(result.totals.activeMs).toBeGreaterThan(0);
      // Sum of candidate session activeMs never exceeds payload totals.
      const candSum = result.candidateSessions.reduce((acc, s) => acc + s.activeMs, 0);
      expect(candSum).toBeLessThanOrEqual(result.totals.activeMs);
    });

    it('empty-week totals equal {activeMs: 0, events: 0}', () => {
      const result = buildReportPayload(defaultInput({ events: [] }));
      expect(result.totals).toEqual({ activeMs: 0, events: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // priorWeekSummary
  // -------------------------------------------------------------------------

  describe('priorWeekSummary', () => {
    it('passed through verbatim when provided', () => {
      const prior: PriorWeekSummary = {
        weekStart: '2026-04-13',
        themes: [{ label: 'Cooking', share: 0.42 }],
        obsessions: [{ domain: 'seriouseats.com', activeMs: 1_234_567 }],
        rabbitHoleLabels: ['Braising 101'],
      };
      const result = buildReportPayload(defaultInput({ priorWeekSummary: prior }));
      expect(result.priorWeekSummary).toEqual(prior);
    });

    it('key is ABSENT (not undefined) when not provided', () => {
      const result = buildReportPayload(defaultInput());
      // Neither `in` nor `hasOwnProperty` should see it.
      expect('priorWeekSummary' in result).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, 'priorWeekSummary')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Orchestration consistency
  // -------------------------------------------------------------------------

  describe('orchestration consistency', () => {
    it('a blocklisted URL is absent from obsessions, ghost tabs, pairs, AND candidateSessions', () => {
      const baseTs = WEEK_START_MS + 13 * 60 * 60 * 1000;
      const events = makeWeekEvents([
        { type: 'window_focus', ts: baseTs, windowId: 1, windowFocused: true },
        { type: 'activate', ts: baseTs, tabId: 10, windowId: 1 },
        { type: 'open', ts: baseTs, tabId: 10, url: 'https://evil.com/a', title: 'EA' },
        { type: 'input_tick', ts: baseTs },
        // Also open a never-focused ghost tab for evil.com on another tab.
        {
          type: 'open',
          ts: baseTs + 100,
          tabId: 11,
          url: 'https://evil.com/ghost',
          title: 'Ghost',
        },
        // Activity on good.com
        { type: 'navigate', ts: baseTs + 1000, tabId: 10, url: 'https://good.com/x', title: 'GX' },
        ...tickStream(baseTs + 1000, baseTs + 60_000),
      ]);
      const result = buildReportPayload(defaultInput({ events, blocklist: new Set(['evil.com']) }));
      expect(result.obsessions.map((o) => o.domain)).not.toContain('evil.com');
      expect(result.ghostTabCandidates.some((g) => g.url.includes('evil.com'))).toBe(false);
      expect(result.domainTitlePairs.map((p) => p.domain)).not.toContain('evil.com');
      for (const s of result.candidateSessions) {
        expect(s.topDomains).not.toContain('evil.com');
        expect(s.urls.some((u) => u.url.includes('evil.com'))).toBe(false);
      }
    });

    it('sum of candidateSessions.activeMs is <= payload totals.activeMs', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const result = buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs) }));
      const candSum = result.candidateSessions.reduce((acc, s) => acc + s.activeMs, 0);
      expect(candSum).toBeLessThanOrEqual(result.totals.activeMs);
    });
  });

  // -------------------------------------------------------------------------
  // Input immutability
  // -------------------------------------------------------------------------

  describe('input immutability', () => {
    it('does not mutate the input events array (frozen input survives)', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const events = Object.freeze(candidateWeekEvents(baseTs)) as TabEvent[];
      expect(() => buildReportPayload(defaultInput({ events }))).not.toThrow();
    });

    it('does not mutate the blocklist Set (frozen Set survives)', () => {
      const baseTs = WEEK_START_MS + 12 * 60 * 60 * 1000;
      const blocklist = new Set(['evil.com']);
      Object.freeze(blocklist);
      expect(() =>
        buildReportPayload(defaultInput({ events: candidateWeekEvents(baseTs), blocklist })),
      ).not.toThrow();
      // And the set still contains its original entry.
      expect(blocklist.has('evil.com')).toBe(true);
      expect(blocklist.size).toBe(1);
    });
  });
});
