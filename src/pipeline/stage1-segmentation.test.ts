import type { TabEvent } from '@tabob/shared';
import { SCHEMA_VERSION, SESSION_GAP_MS, SESSION_MIN_ACTIVE_MS } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { segmentSessions } from './stage1-segmentation.js';

const BASE = 1_700_000_000_000;
const WEEK_START = '2026-04-20';

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    tzOffsetMin: 0,
    ...partial,
  };
}

// A helper that dense-packs input_tick every 30s over [from, to] to keep attention alive.
function tickStream(from: number, to: number): TabEvent[] {
  const out: TabEvent[] = [];
  for (let t = from; t <= to; t += 30_000) out.push(ev({ type: 'input_tick', ts: t }));
  return out;
}

// Build a "focused active block" running from `from` to `to` on tabId in windowId,
// optionally attributed to `url`. Does NOT emit deactivate at the tail (caller can add).
function activeBlock(
  from: number,
  to: number,
  tabId: number,
  windowId: number,
  url?: string,
  title?: string,
): TabEvent[] {
  const out: TabEvent[] = [
    ev({ type: 'window_focus', ts: from, windowId, windowFocused: true }),
    ev({ type: 'activate', ts: from, tabId, windowId }),
  ];
  if (url !== undefined) {
    out.push(ev({ type: 'navigate', ts: from, tabId, url, title: title ?? '' }));
  }
  out.push(...tickStream(from, to));
  return out;
}

describe('segmentSessions', () => {
  it('returns [] for empty input', () => {
    expect(segmentSessions([], { weekStart: WEEK_START })).toEqual([]);
  });

  it('builds one session for 20 minutes of continuous active time (happy path)', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/a', title: 'A' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];

    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.weekStart).toBe(WEEK_START);
    expect(s.status).toBe('segmented');
    expect(s.startTs).toBe(BASE);
    expect(s.endTs).toBe(end);
    expect(s.activeMs).toBe(20 * 60_000);
    expect(s.distinctUrls).toBe(1);
    expect(s.distinctDomains).toBe(1);
    expect(s.topDomain).toBe('example.com');
    expect(s.urls[0]).toEqual({
      url: 'https://example.com/a',
      title: 'A',
      domain: 'example.com',
      activeMs: 20 * 60_000,
      openTs: BASE,
    });
    expect(s.id.startsWith(`sess_${BASE}_`)).toBe(true);
  });

  it('drops a session whose active time is under 15 minutes', () => {
    const end = BASE + 10 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/', title: '' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    expect(segmentSessions(events, { weekStart: WEEK_START })).toEqual([]);
  });

  it('splits on a >=45-minute inactivity gap (boundary: exactly 45 min is a split)', () => {
    // Session 1: BASE..BASE+20min (20min active). Then a dead gap. Session 2 begins at
    // (end of S1 interval) + 45min exactly and runs for 20min more. Gap of exactly
    // SESSION_GAP_MS must split.
    const s1Start = BASE;
    const s1End = s1Start + 20 * 60_000;
    const s2Start = s1End + SESSION_GAP_MS; // exactly 45 min gap
    const s2End = s2Start + 20 * 60_000;

    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: s1Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: s1Start, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: s1Start, tabId: 10, url: 'https://a.test/', title: 'A' }),
      ...tickStream(s1Start, s1End),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      // long idle gap (no focus/input)
      // Session 2 — re-focus & fresh ticks.
      ev({ type: 'window_focus', ts: s2Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: s2Start, tabId: 11, windowId: 1 }),
      ev({ type: 'navigate', ts: s2Start, tabId: 11, url: 'https://b.test/', title: 'B' }),
      ...tickStream(s2Start, s2End),
      ev({ type: 'deactivate', ts: s2End, tabId: 11, windowId: 1 }),
    ];

    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.activeMs).toBeGreaterThanOrEqual(SESSION_MIN_ACTIVE_MS);
    expect(sessions[1]!.activeMs).toBeGreaterThanOrEqual(SESSION_MIN_ACTIVE_MS);
    expect(sessions[0]!.topDomain).toBe('a.test');
    expect(sessions[1]!.topDomain).toBe('b.test');
    // Chronological order.
    expect(sessions[0]!.startTs).toBeLessThan(sessions[1]!.startTs);
  });

  it('treats a session with active time but no navigate/open as urls=[]', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.urls).toEqual([]);
    expect(s.distinctUrls).toBe(0);
    expect(s.distinctDomains).toBe(0);
    expect(s.topDomain).toBeUndefined();
    expect(s.activeMs).toBe(20 * 60_000);
  });

  it('does not mutate input events', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ...tickStream(BASE, end),
    ];
    const snapshot = events.map((e) => e.ts);
    segmentSessions(events, { weekStart: WEEK_START });
    expect(events.map((e) => e.ts)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Gap boundary & splitting

describe('gap boundary semantics', () => {
  it('44m59s gap stays as ONE session (< SESSION_GAP_MS threshold)', () => {
    // Two 20-min active blocks separated by a gap of 44m59s. Sub-threshold: one merged session.
    // Close each block with an explicit deactivate so its interval ends cleanly at block end
    // (otherwise the segment would dangle for up to ATTN after the last tick).
    const s1Start = BASE;
    const s1End = s1Start + 20 * 60_000;
    const gapMs = SESSION_GAP_MS - 1_000; // 44m59s
    const s2Start = s1End + gapMs;
    const s2End = s2Start + 20 * 60_000;

    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: s1Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: s1Start, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: s1Start, tabId: 10, url: 'https://a.test/', title: 'A' }),
      ...tickStream(s1Start, s1End),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      // Gap — no focus, no input.
      ev({ type: 'window_focus', ts: s2Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: s2Start, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: s2Start, tabId: 10, url: 'https://b.test/', title: 'B' }),
      ...tickStream(s2Start, s2End),
      ev({ type: 'deactivate', ts: s2End, tabId: 10, windowId: 1 }),
    ];

    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    // Active = 20min + 20min = 40min. (Gap doesn't contribute.)
    expect(s.activeMs).toBe(40 * 60_000);
    expect(s.startTs).toBe(s1Start);
    // endTs is the tail of the LAST active interval within the group.
    expect(s.endTs).toBe(s2End);
  });

  it('back-to-back sessions with real activity on both sides of a 45-min gap', () => {
    const s1Start = BASE;
    const s1End = s1Start + 30 * 60_000;
    const s2Start = s1End + SESSION_GAP_MS;
    const s2End = s2Start + 25 * 60_000;

    const events: TabEvent[] = [
      ...activeBlock(s1Start, s1End, 10, 1, 'https://s1.test/', 'S1'),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      ...activeBlock(s2Start, s2End, 20, 1, 'https://s2.test/', 'S2'),
      ev({ type: 'deactivate', ts: s2End, tabId: 20, windowId: 1 }),
    ];

    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.activeMs).toBe(30 * 60_000);
    expect(sessions[1]!.activeMs).toBe(25 * 60_000);
    expect(sessions[0]!.topDomain).toBe('s1.test');
    expect(sessions[1]!.topDomain).toBe('s2.test');
  });

  it('single long session — 3 hours continuous, one Session returned', () => {
    const end = BASE + 3 * 3_600_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://long.test/', title: 'L' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeMs).toBe(3 * 3_600_000);
    expect(sessions[0]!.startTs).toBe(BASE);
    expect(sessions[0]!.endTs).toBe(end);
  });

  it('interval gap of exactly 45 minutes splits even when both halves tiny (proves >= comparison)', () => {
    // First interval: [BASE, BASE+16min), 16 min active → kept.
    // Second interval: [BASE+16min+45min, BASE+16min+45min+16min) — gap EXACTLY 45 min.
    const s1Start = BASE;
    const s1End = s1Start + 16 * 60_000;
    const s2Start = s1End + SESSION_GAP_MS;
    const s2End = s2Start + 16 * 60_000;

    const events: TabEvent[] = [
      ...activeBlock(s1Start, s1End, 10, 1, 'https://x.test/', 'X'),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      ...activeBlock(s2Start, s2End, 10, 1, 'https://y.test/', 'Y'),
      ev({ type: 'deactivate', ts: s2End, tabId: 10, windowId: 1 }),
    ];

    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.topDomain).toBe('x.test');
    expect(sessions[1]!.topDomain).toBe('y.test');
  });
});

// ---------------------------------------------------------------------------
// Drop boundaries

describe('minimum-active drop boundary', () => {
  it('14m59s session is dropped (< 15 min)', () => {
    const end = BASE + 14 * 60_000 + 59_000; // 14:59
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: '' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    expect(segmentSessions(events, { weekStart: WEEK_START })).toEqual([]);
  });

  it('exactly 15m00s session is KEPT (>= threshold)', () => {
    const end = BASE + 15 * 60_000; // exactly 15 min
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: '' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeMs).toBe(15 * 60_000);
  });

  it('zero-active events → []', () => {
    // Lots of events, but no input_tick/focus combo → no intervals.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/' }),
      ev({ type: 'navigate', ts: BASE + 1_000, tabId: 10, url: 'https://y.test/' }),
      ev({ type: 'close', ts: BASE + 2_000, tabId: 10 }),
    ];
    expect(segmentSessions(events, { weekStart: WEEK_START })).toEqual([]);
  });

  it('a 10-min block + a 10-min block separated by >45-min gap drops BOTH sessions', () => {
    const s1End = BASE + 10 * 60_000;
    const s2Start = s1End + SESSION_GAP_MS;
    const s2End = s2Start + 10 * 60_000;
    const events: TabEvent[] = [
      ...activeBlock(BASE, s1End, 10, 1, 'https://a.test/', 'A'),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      ...activeBlock(s2Start, s2End, 11, 1, 'https://b.test/', 'B'),
      ev({ type: 'deactivate', ts: s2End, tabId: 11, windowId: 1 }),
    ];
    expect(segmentSessions(events, { weekStart: WEEK_START })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Domain extraction

describe('domain extraction (safeDomain)', () => {
  it('strips a single leading "www." but NOT deeper subdomains like "m."', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://www.example.com/x', title: '' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls[0]!.domain).toBe('example.com');
    expect(s.topDomain).toBe('example.com');
  });

  it('"m.example.com" does NOT collapse to "example.com"', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://m.example.com/x', title: '' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls[0]!.domain).toBe('m.example.com');
    expect(s.topDomain).toBe('m.example.com');
  });

  it('userinfo + uppercase host → lowercased, no userinfo', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://User:Pass@EXAMPLE.COM/x',
        title: '',
      }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls[0]!.domain).toBe('example.com');
  });

  it('unparseable URL ("javascript:void(0)") → activeMs counted but URL entry skipped', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      // Note: `new URL('javascript:void(0)')` actually parses (hostname is empty string).
      // Use a genuinely invalid URL instead — an empty string absolute parse throws.
      // But per the spec, `about:blank` is flagged as "unparseable" for our purposes; it DOES
      // parse as `new URL()` (hostname=''), so safeDomain returns '' — the code checks for
      // `null` not falsiness, so empty hostname is actually kept. We pick a *truly* unparseable
      // URL by throwing URL(): a bare token with no scheme.
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'not a url at all', title: 'NU' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.activeMs).toBe(20 * 60_000);
    expect(s.urls).toEqual([]);
    expect(s.distinctUrls).toBe(0);
    expect(s.distinctDomains).toBe(0);
    expect('topDomain' in s).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL attribution

describe('URL attribution', () => {
  it('pre-window navigate does NOT appear in urls (but activeMs still counted)', () => {
    // Tab navigated 10 min before the window starts; remains the active tab through the window.
    // Active window: gap of 50 min (> SESSION_GAP_MS) so the pre-window interval is its own
    // dead zone. Build so there's a prior tiny dead-only set of events, then a real session.
    const preNav = BASE - 10 * 60_000;
    const sStart = BASE;
    const sEnd = sStart + 20 * 60_000;
    const events: TabEvent[] = [
      // Pre-window events — no input or focus, so no active intervals contributed.
      ev({ type: 'navigate', ts: preNav, tabId: 10, url: 'https://pre.test/', title: 'Pre' }),
      // Session proper.
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ...tickStream(sStart, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.activeMs).toBe(20 * 60_000);
    // The pre-window navigate is skipped: no URL appears.
    expect(s.urls).toEqual([]);
    expect(s.distinctUrls).toBe(0);
    expect(s.startTs).toBe(sStart);
  });

  it('URL re-navigated mid-session — openTs stays at first occurrence', () => {
    // Tab navigates to X at sStart, then re-navigates to SAME URL X 10 min later.
    const sStart = BASE;
    const reNav = BASE + 10 * 60_000;
    const sEnd = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://x.test/', title: 'Xorig' }),
      ...tickStream(sStart, sEnd),
      // Re-navigate to same URL mid-session. Title omitted to check title preservation.
      ev({ type: 'navigate', ts: reNav, tabId: 10, url: 'https://x.test/' }),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls).toHaveLength(1);
    expect(s.urls[0]!.openTs).toBe(sStart);
    // Title is preserved across same-URL re-navigate when new event has no title.
    expect(s.urls[0]!.title).toBe('Xorig');
  });

  it('title updated later via a fresh navigate to the same URL — latest non-empty title wins', () => {
    const sStart = BASE;
    const mid = BASE + 10 * 60_000;
    const sEnd = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://x.test/', title: 'Old' }),
      ...tickStream(sStart, sEnd),
      ev({ type: 'navigate', ts: mid, tabId: 10, url: 'https://x.test/', title: 'New' }),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls).toHaveLength(1);
    expect(s.urls[0]!.title).toBe('New');
    expect(s.urls[0]!.openTs).toBe(sStart);
  });

  it('title-only navigate (url absent) updates existing tracked tab title, no new entry', () => {
    const sStart = BASE;
    const mid = BASE + 10 * 60_000;
    const sEnd = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://x.test/', title: 'Initial' }),
      ...tickStream(sStart, sEnd),
      // Title-only "navigate" (late title arrival, no URL). Should update title, not entry count.
      ev({ type: 'navigate', ts: mid, tabId: 10, title: 'Updated' }),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls).toHaveLength(1);
    expect(s.urls[0]!.url).toBe('https://x.test/');
    expect(s.urls[0]!.title).toBe('Updated');
  });

  it('title-only navigate BEFORE any URL navigate on that tab does NOT create an entry', () => {
    const sStart = BASE;
    const sEnd = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      // Title arrives first — should NOT synthesize a URL entry.
      ev({ type: 'navigate', ts: sStart, tabId: 10, title: 'Orphan' }),
      ...tickStream(sStart, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls).toEqual([]);
    expect(s.distinctUrls).toBe(0);
  });

  it('two tabs visit the SAME URL → merged into a single urls[] entry, activeMs summed', () => {
    // Two tabs each accrue 10 min on the same URL; they're serially focused (non-overlapping).
    const t1Start = BASE;
    const t1End = BASE + 10 * 60_000;
    const t2Start = t1End; // back-to-back
    const t2End = t2Start + 10 * 60_000;

    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: t1Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: t1Start, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: t1Start, tabId: 10, url: 'https://shared.test/', title: 'S' }),
      ...tickStream(t1Start, t1End),
      // Switch to tab 20, same URL.
      ev({ type: 'activate', ts: t2Start, tabId: 20, windowId: 1 }),
      ev({ type: 'navigate', ts: t2Start, tabId: 20, url: 'https://shared.test/', title: 'S' }),
      ...tickStream(t2Start, t2End),
      ev({ type: 'deactivate', ts: t2End, tabId: 20, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.urls).toHaveLength(1);
    expect(s.urls[0]!.activeMs).toBe(20 * 60_000);
    // openTs pinned to the earliest firstSeenTs across both tabs.
    expect(s.urls[0]!.openTs).toBe(t1Start);
    expect(s.distinctUrls).toBe(1);
  });

  it('urls array sorted ascending by openTs (strict openTs ordering)', () => {
    // Three URLs at three distinct openTs values → ascending openTs ordering is exercised
    // independently of lex tie-break. Each URL is opened on its own tab so that each gets
    // its own interval segment (segmentation splits on tab switches).
    const sStart = BASE;
    const sEnd = BASE + 30 * 60_000;
    const midA = sStart + 10 * 60_000;
    const midB = sStart + 20 * 60_000;
    const events: TabEvent[] = [
      // Tab 10 at sStart: z.test/last (lexically largest, opens FIRST).
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://z.test/last', title: '' }),
      ...tickStream(sStart, midA),
      // Tab 20 at midA: a.test/early (lex smallest, opens SECOND).
      ev({ type: 'activate', ts: midA, tabId: 20, windowId: 1 }),
      ev({ type: 'navigate', ts: midA, tabId: 20, url: 'https://a.test/early', title: '' }),
      ...tickStream(midA, midB),
      // Tab 30 at midB: m.test/middle (opens THIRD).
      ev({ type: 'activate', ts: midB, tabId: 30, windowId: 1 }),
      ev({ type: 'navigate', ts: midB, tabId: 30, url: 'https://m.test/middle', title: '' }),
      ...tickStream(midB, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 30, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    // Pure openTs ordering: z (sStart) → a (midA) → m (midB). Lex order on URL string is
    // intentionally anti-correlated with openTs so we prove openTs — not URL — is primary.
    expect(s.urls.map((u) => u.url)).toEqual([
      'https://z.test/last',
      'https://a.test/early',
      'https://m.test/middle',
    ]);
  });

  it('urls array lexical tie-break when two URLs have identical openTs', () => {
    // Two tabs, same openTs (both navigate at sStart), different URL strings. Each must
    // produce its own urls[] entry; tie-break is lexical on URL string.
    const sStart = BASE;
    const mid = sStart + 10 * 60_000;
    const sEnd = sStart + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      // Tab 10 activated + navigate to z.test at sStart.
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://z.test/', title: '' }),
      // Also at sStart: navigate for tab 20 to a.test (tab not yet activated — state is
      // stored in tabUrl map regardless of accrual).
      ev({ type: 'navigate', ts: sStart, tabId: 20, url: 'https://a.test/', title: '' }),
      // Accrue on tab 10 for first half.
      ...tickStream(sStart, mid),
      // Switch to tab 20 for second half. At switch time, tab 20's URL state (a.test) was
      // already stamped at sStart, so its openTs stays at sStart.
      ev({ type: 'activate', ts: mid, tabId: 20, windowId: 1 }),
      ...tickStream(mid, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 20, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    // Both entries share openTs=sStart → lexical tie-break: a.test < z.test.
    const urls = s.urls;
    expect(urls).toHaveLength(2);
    expect(urls[0]!.openTs).toBe(sStart);
    expect(urls[1]!.openTs).toBe(sStart);
    expect(urls[0]!.url).toBe('https://a.test/');
    expect(urls[1]!.url).toBe('https://z.test/');
  });

  it('overlapping URL sets across multiple sessions: each session has INDEPENDENT openTs', () => {
    // Session 1 at BASE opens URL X. Gap > 45 min. Session 2 opens SAME URL X again.
    // Each session's urls[0].openTs should be that session's local first-seen.
    const s1Start = BASE;
    const s1End = s1Start + 20 * 60_000;
    const s2Start = s1End + SESSION_GAP_MS + 60_000; // > 45 min gap
    const s2End = s2Start + 20 * 60_000;
    const url = 'https://repeat.test/';

    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: s1Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: s1Start, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: s1Start, tabId: 10, url, title: '' }),
      ...tickStream(s1Start, s1End),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      // Session 2.
      ev({ type: 'window_focus', ts: s2Start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: s2Start, tabId: 11, windowId: 1 }),
      ev({ type: 'navigate', ts: s2Start, tabId: 11, url, title: '' }),
      ...tickStream(s2Start, s2End),
      ev({ type: 'deactivate', ts: s2End, tabId: 11, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.urls[0]!.openTs).toBe(s1Start);
    expect(sessions[1]!.urls[0]!.openTs).toBe(s2Start);
    // Each session sees the URL as "new" independently.
  });
});

// ---------------------------------------------------------------------------
// topDomain

describe('topDomain selection', () => {
  it('lexically smaller domain wins on activeMs tie', () => {
    // Two URLs, each exactly 10 min active. Lex: "apple.test" < "zebra.test".
    const sStart = BASE;
    const mid = BASE + 10 * 60_000;
    const sEnd = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://zebra.test/', title: '' }),
      ...tickStream(sStart, mid),
      // Switch to a different domain at mid.
      ev({ type: 'activate', ts: mid, tabId: 20, windowId: 1 }),
      ev({ type: 'navigate', ts: mid, tabId: 20, url: 'https://apple.test/', title: '' }),
      ...tickStream(mid, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 20, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    // Each should have ~10min. Lex tie-break → "apple.test" wins.
    expect(s.topDomain).toBe('apple.test');
    expect(s.distinctDomains).toBe(2);
  });

  it('topDomain absent from session object (not undefined property) when no URLs captured', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      // Note: no navigate → no URLs.
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    // With exactOptionalPropertyTypes: the key must be absent, not undefined.
    expect('topDomain' in s).toBe(false);
    expect(s.topDomain).toBeUndefined();
  });

  it("single URL dominates — topDomain is that URL's domain", () => {
    const sStart = BASE;
    const sEnd = BASE + 30 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://boss.test/x', title: '' }),
      ...tickStream(sStart, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.topDomain).toBe('boss.test');
  });

  it('multiple URLs within same domain sum together toward topDomain', () => {
    // Two URLs on the SAME domain — 10 min each = 20 min on "combo.test";
    // One URL on another domain — 5 min. combo.test wins.
    const sStart = BASE;
    const t1 = BASE + 10 * 60_000;
    const t2 = BASE + 20 * 60_000;
    const sEnd = BASE + 25 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: sStart, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: sStart, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: sStart, tabId: 10, url: 'https://combo.test/a', title: '' }),
      ...tickStream(sStart, t1),
      ev({ type: 'navigate', ts: t1, tabId: 10, url: 'https://combo.test/b', title: '' }),
      ...tickStream(t1, t2),
      ev({ type: 'navigate', ts: t2, tabId: 10, url: 'https://solo.test/', title: '' }),
      ...tickStream(t2, sEnd),
      ev({ type: 'deactivate', ts: sEnd, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.topDomain).toBe('combo.test');
    expect(s.distinctDomains).toBe(2);
    expect(s.distinctUrls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Session metadata

describe('session metadata', () => {
  it('weekStart stamped on every returned session', () => {
    const s1End = BASE + 20 * 60_000;
    const s2Start = s1End + SESSION_GAP_MS;
    const s2End = s2Start + 20 * 60_000;
    const events: TabEvent[] = [
      ...activeBlock(BASE, s1End, 10, 1, 'https://a.test/'),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      ...activeBlock(s2Start, s2End, 11, 1, 'https://b.test/'),
      ev({ type: 'deactivate', ts: s2End, tabId: 11, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: '2099-12-31' });
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.weekStart).toBe('2099-12-31');
      expect(s.status).toBe('segmented');
      expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });

  it('endTs equals LAST interval end, not last event ts', () => {
    // Active interval ends at BASE+20min (last tick also at BASE+20min → segment closes at
    // lastEventTs, which is the deactivate at BASE+20min). Then a navigate arrives at
    // BASE+25min (still within the same session since no gap ≥ 45 min yet — but the interval
    // itself already ended). endTs must be interval end (BASE+20min), NOT the later navigate.
    const iEnd = BASE + 20 * 60_000;
    const strayNav = BASE + 25 * 60_000; // well after interval ended
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, iEnd),
      ev({ type: 'deactivate', ts: iEnd, tabId: 10, windowId: 1 }),
      // A late navigate event — background tab navigate happens but no focus or input.
      ev({ type: 'navigate', ts: strayNav, tabId: 10, url: 'https://tail.test/', title: 'T' }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.endTs).toBe(iEnd);
    // The stray nav did NOT extend the session.
    // Active time is full 20 min.
    expect(s.activeMs).toBe(20 * 60_000);
    // The tail.test URL never falls inside [startTs, endTs], so it must NOT appear.
    expect(s.urls.every((u) => u.url !== 'https://tail.test/')).toBe(true);
  });

  it('id is deterministic: same events + weekStart → same id', () => {
    const end = BASE + 20 * 60_000;
    const events1: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    // Rebuild identical events from scratch — must produce identical id.
    const events2: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const id1 = segmentSessions(events1, { weekStart: WEEK_START })[0]!.id;
    const id2 = segmentSessions(events2, { weekStart: WEEK_START })[0]!.id;
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^sess_\d+_[0-9a-f]{8}$/);
  });

  it('id changes when an event type changes at the same ts', () => {
    // Swap one navigate for an activate at the same ts — hash input differs → different id.
    const end = BASE + 20 * 60_000;
    const eventsA: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    // Variant B: add an extra activate at the same ts as the navigate → different type string
    // in the hash → different id.
    const eventsB: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      // Keep the navigate but add a second activate at same ts for tab 99.
      ev({ type: 'activate', ts: BASE, tabId: 99, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const idA = segmentSessions(eventsA, { weekStart: WEEK_START })[0]!.id;
    const idB = segmentSessions(eventsB, { weekStart: WEEK_START })[0]!.id;
    expect(idA).not.toBe(idB);
  });

  it('id changes when a tabId changes at the same ts (type preserved)', () => {
    const end = BASE + 20 * 60_000;
    const eventsA: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const eventsB: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 7, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 7, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 7, windowId: 1 }),
    ];
    const idA = segmentSessions(eventsA, { weekStart: WEEK_START })[0]!.id;
    const idB = segmentSessions(eventsB, { weekStart: WEEK_START })[0]!.id;
    expect(idA).not.toBe(idB);
  });

  it('id hash format is 8 lowercase hex chars', () => {
    const end = BASE + 20 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const s = segmentSessions(events, { weekStart: WEEK_START })[0]!;
    expect(s.id).toMatch(/^sess_\d+_[0-9a-f]{8}$/);
    const hash = s.id.split('_')[2]!;
    expect(hash).toHaveLength(8);
    expect(hash).toBe(hash.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Sorting, robustness

describe('input ordering and robustness', () => {
  it('events provided out of order produce identical session shape (modulo id)', () => {
    // Shuffling events of all DISTINCT ts values must produce identical result including id
    // (stable sort on ts is total-order when ts values are unique).
    const end = BASE + 20 * 60_000;
    const sorted: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE + 1, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE + 2, tabId: 10, url: 'https://x.test/', title: 'X' }),
      ...tickStream(BASE + 3, end - 1),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const shuffled = [...sorted].reverse();
    const sA = segmentSessions(sorted, { weekStart: WEEK_START });
    const sB = segmentSessions(shuffled, { weekStart: WEEK_START });
    expect(sB).toHaveLength(sA.length);
    // With all-distinct ts values, sort is deterministic → id matches.
    expect(sB[0]!.id).toBe(sA[0]!.id);
    expect(sB[0]!.activeMs).toBe(sA[0]!.activeMs);
    expect(sB[0]!.urls).toEqual(sA[0]!.urls);
    expect(sB[0]!.startTs).toBe(sA[0]!.startTs);
    expect(sB[0]!.endTs).toBe(sA[0]!.endTs);
  });

  it('DST fall-back: a 50-minute gap inside a "25-hour day" is handled purely by ms arithmetic', () => {
    // Two sessions separated by a 50-min gap — the "25-hour day" framing is just wall-clock
    // fiction; segmenter only sees ms. With a gap > 45 min, we MUST get 2 sessions.
    const DAY_25H_MS = 25 * 3_600_000;
    const s1Start = BASE;
    const s1End = s1Start + 20 * 60_000;
    // Put session 2 somewhere well inside the "25-hour day" with a 50 min gap.
    const s2Start = s1End + SESSION_GAP_MS + 5 * 60_000; // 50-min gap > 45-min threshold
    const s2End = s2Start + 20 * 60_000;
    expect(s2End).toBeLessThan(BASE + DAY_25H_MS); // sanity
    const events: TabEvent[] = [
      ...activeBlock(s1Start, s1End, 10, 1, 'https://dst1.test/'),
      ev({ type: 'deactivate', ts: s1End, tabId: 10, windowId: 1 }),
      ...activeBlock(s2Start, s2End, 20, 1, 'https://dst2.test/'),
      ev({ type: 'deactivate', ts: s2End, tabId: 20, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.activeMs).toBe(20 * 60_000);
    expect(sessions[1]!.activeMs).toBe(20 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline smoke: one synthetic day → drop + keep + keep

describe('pipeline composition smoke', () => {
  it('one synthetic day with three sessions: one dropped (<15m), two kept', () => {
    // Session A: BASE .. BASE+10min — only 10min active → DROPPED.
    // Gap of 50 min.
    // Session B: BASE+60min .. BASE+80min — 20min → KEPT.
    // Gap of 60 min.
    // Session C: BASE+140min .. BASE+170min — 30min → KEPT.
    const A_end = BASE + 10 * 60_000;
    const B_start = BASE + 60 * 60_000;
    const B_end = B_start + 20 * 60_000;
    const C_start = B_end + 60 * 60_000;
    const C_end = C_start + 30 * 60_000;

    const events: TabEvent[] = [
      // A (to be dropped)
      ...activeBlock(BASE, A_end, 10, 1, 'https://drop.test/'),
      ev({ type: 'deactivate', ts: A_end, tabId: 10, windowId: 1 }),
      // B (kept)
      ...activeBlock(B_start, B_end, 20, 1, 'https://bravo.test/', 'Bravo'),
      ev({ type: 'deactivate', ts: B_end, tabId: 20, windowId: 1 }),
      // C (kept) — visit two URLs on two domains.
      ev({ type: 'window_focus', ts: C_start, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: C_start, tabId: 30, windowId: 1 }),
      ev({ type: 'navigate', ts: C_start, tabId: 30, url: 'https://charlie.test/a', title: 'CA' }),
      ...tickStream(C_start, C_start + 15 * 60_000),
      ev({ type: 'activate', ts: C_start + 15 * 60_000, tabId: 31, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: C_start + 15 * 60_000,
        tabId: 31,
        url: 'https://delta.test/b',
        title: 'DB',
      }),
      ...tickStream(C_start + 15 * 60_000, C_end),
      ev({ type: 'deactivate', ts: C_end, tabId: 31, windowId: 1 }),
    ];
    const sessions = segmentSessions(events, { weekStart: WEEK_START });
    expect(sessions).toHaveLength(2);

    const [b, c] = sessions;
    expect(b!.activeMs).toBe(20 * 60_000);
    expect(b!.topDomain).toBe('bravo.test');
    expect(b!.urls).toHaveLength(1);
    expect(b!.status).toBe('segmented');

    expect(c!.activeMs).toBe(30 * 60_000);
    expect(c!.distinctUrls).toBe(2);
    expect(c!.distinctDomains).toBe(2);
    // charlie.test and delta.test each ~15min active. Lex tie-break → charlie.test wins.
    expect(c!.topDomain).toBe('charlie.test');
    expect(c!.urls.map((u) => u.url)).toEqual(['https://charlie.test/a', 'https://delta.test/b']);
    expect(c!.status).toBe('segmented');

    // Sessions in chronological order, correct weekStart everywhere.
    expect(b!.startTs).toBeLessThan(c!.startTs);
    for (const s of sessions) expect(s.weekStart).toBe(WEEK_START);
  });
});
