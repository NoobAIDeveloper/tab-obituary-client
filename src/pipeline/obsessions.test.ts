import type { TabEvent } from '@tabob/shared';
import { OBSESSIONS_TOP_N, SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { computeObsessions } from './obsessions.js';

const BASE = 1_700_000_000_000;

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return { schemaVersion: SCHEMA_VERSION, tzOffsetMin: 0, ...partial };
}

function tickStream(from: number, to: number): TabEvent[] {
  const out: TabEvent[] = [];
  for (let t = from; t <= to; t += 30_000) out.push(ev({ type: 'input_tick', ts: t }));
  return out;
}

describe('computeObsessions', () => {
  it('empty input returns []', () => {
    expect(computeObsessions([])).toEqual([]);
  });

  it('groups by canonical domain and sums activeMs + visits', () => {
    // Two URLs under news.ycombinator.com collapse into one obsession; example.com is separate.
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://news.ycombinator.com/a',
        title: 'A',
      }),
      ...tickStream(BASE, BASE + 30_000),
      ev({
        type: 'navigate',
        ts: BASE + 30_000,
        tabId: 10,
        url: 'https://news.ycombinator.com/b',
        title: 'B',
      }),
      ...tickStream(BASE + 30_000, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
      // An extra background visit that shouldn't collapse:
      ev({
        type: 'navigate',
        ts: end + 1,
        tabId: 11,
        url: 'https://example.com/',
        title: 'Ex',
      }),
    ];

    const out = computeObsessions(events);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const hn = out.find((o) => o.domain === 'ycombinator.com');
    expect(hn).toBeDefined();
    expect(hn!.visits).toBe(2); // two nav events under the domain
    expect(hn!.activeMs).toBe(60_000); // full minute focused
  });

  it('top 10 only when 11 distinct domains are present (boundary)', () => {
    // 11 distinct registrable domains, each with one background visit.
    const tlds = ['com', 'org', 'net', 'io', 'co', 'dev', 'app', 'ai', 'gg', 'xyz', 'me'];
    const events: TabEvent[] = tlds.map((tld, i) =>
      ev({
        type: 'navigate',
        ts: BASE + i,
        tabId: 100 + i,
        url: `https://site${i}.${tld}/`,
        title: `T${i}`,
      }),
    );
    const out = computeObsessions(events);
    expect(out).toHaveLength(OBSESSIONS_TOP_N); // 10
  });

  // ---------- Aggregation across multiple URLs under one domain ----------

  it('sums activeMs and visits across 3 URLs under the same domain', () => {
    // Three distinct URLs under example.com, each focused for 30s. Result: one obsession with
    // 90_000 ms activeMs and 3 visits.
    const url1Start = BASE;
    const url2Start = BASE + 30_000;
    const url3Start = BASE + 60_000;
    const end = BASE + 90_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: url1Start, tabId: 10, url: 'https://a.example.com/', title: 'A' }),
      ...tickStream(url1Start, end),
      ev({ type: 'navigate', ts: url2Start, tabId: 10, url: 'https://b.example.com/', title: 'B' }),
      ev({ type: 'navigate', ts: url3Start, tabId: 10, url: 'https://c.example.com/', title: 'C' }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeObsessions(events);
    const ex = out.find((o) => o.domain === 'example.com')!;
    expect(ex.activeMs).toBe(90_000);
    expect(ex.visits).toBe(3);
  });

  // ---------- Tie-breakers ----------

  it('tie on activeMs: sort by visits desc', () => {
    // Two background-only navigates (zero activeMs). Domain "a.com" gets 2 visits, "b.com"
    // gets 1 visit. Expected order: a.com, b.com.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.com/x', title: 'X' }),
      ev({ type: 'navigate', ts: BASE + 1, tabId: 11, url: 'https://a.com/y', title: 'Y' }),
      ev({ type: 'navigate', ts: BASE + 2, tabId: 12, url: 'https://b.com/', title: 'B' }),
    ];
    const out = computeObsessions(events);
    expect(out.map((o) => o.domain)).toEqual(['a.com', 'b.com']);
  });

  it('tie on activeMs AND visits: sort by domain lex asc', () => {
    // Three domains each with exactly 1 background visit (zero activeMs, one visit). Sort
    // should be lexical ascending: a.com, b.com, c.com.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 12, url: 'https://c.com/', title: 'C' }),
      ev({ type: 'navigate', ts: BASE + 1, tabId: 10, url: 'https://a.com/', title: 'A' }),
      ev({ type: 'navigate', ts: BASE + 2, tabId: 11, url: 'https://b.com/', title: 'B' }),
    ];
    const out = computeObsessions(events);
    expect(out.map((o) => o.domain)).toEqual(['a.com', 'b.com', 'c.com']);
  });

  // ---------- Subdomain collapse ----------

  it('collapses subdomains: a.example.org + b.example.org + example.org → one obsession', () => {
    // Three distinct URLs under different subdomains of example.org, each with a background
    // navigate. Should collapse to one "example.org" obsession with 3 visits.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example.org/', title: 'A' }),
      ev({
        type: 'navigate',
        ts: BASE + 1,
        tabId: 11,
        url: 'https://b.example.org/',
        title: 'B',
      }),
      ev({ type: 'navigate', ts: BASE + 2, tabId: 12, url: 'https://example.org/', title: 'Root' }),
    ];
    const out = computeObsessions(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('example.org');
    expect(out[0]!.visits).toBe(3);
  });

  // ---------- Null canonical exclusion ----------

  it('excludes URLs with null canonical domain (about:, file:)', () => {
    // about:blank and file:// both yield null canonical → "" sentinel → dropped.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'about:blank', title: 'About' }),
      ev({ type: 'navigate', ts: BASE + 1, tabId: 11, url: 'file:///etc/hosts', title: 'Hosts' }),
      ev({
        type: 'navigate',
        ts: BASE + 2,
        tabId: 12,
        url: 'https://real.example.com/',
        title: 'Real',
      }),
    ];
    const out = computeObsessions(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('example.com');
  });

  // ---------- Visit counting semantics ----------

  it('visits count only navigate/open events, not input_tick or activate', () => {
    // A tab is activated and ticked many times, but only one navigate carrying a url. visits
    // should be 1 regardless.
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/', title: 'E' }),
      ...tickStream(BASE, end), // many input_ticks — not visits
      ev({ type: 'activate', ts: BASE + 10_000, tabId: 10, windowId: 1 }), // not a visit
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeObsessions(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.visits).toBe(1);
  });

  it('visits counts across all tabs (multi-tab navigation to same domain)', () => {
    // Four background navigates on four tabs all under example.com. visits=4.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example.com/', title: 'A' }),
      ev({
        type: 'navigate',
        ts: BASE + 1,
        tabId: 11,
        url: 'https://b.example.com/',
        title: 'B',
      }),
      ev({
        type: 'navigate',
        ts: BASE + 2,
        tabId: 12,
        url: 'https://c.example.com/',
        title: 'C',
      }),
      ev({
        type: 'navigate',
        ts: BASE + 3,
        tabId: 13,
        url: 'https://d.example.com/',
        title: 'D',
      }),
    ];
    const out = computeObsessions(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.visits).toBe(4);
    expect(out[0]!.activeMs).toBe(0);
  });

  // ---------- Zero-activeMs probe ----------

  it('domain visited but never focused still appears with activeMs=0', () => {
    // Probe per the test plan: computeObsessions should include domains with zero activeMs
    // provided they have at least one visit. Document this behavior.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://silent.example/', title: 'S' }),
    ];
    const out = computeObsessions(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('silent.example');
    expect(out[0]!.activeMs).toBe(0);
    expect(out[0]!.visits).toBe(1);
  });

  // ---------- Length cap ----------

  it('never exceeds OBSESSIONS_TOP_N entries', () => {
    // 25 distinct domains, all tied on zero activeMs + 1 visit. Output capped at 10.
    const events: TabEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(
        ev({
          type: 'navigate',
          ts: BASE + i,
          tabId: 100 + i,
          url: `https://d${i}-unique.com/`,
          title: `T${i}`,
        }),
      );
    }
    const out = computeObsessions(events);
    expect(out).toHaveLength(OBSESSIONS_TOP_N);
  });

  // ---------- Sort: activeMs desc is primary ----------

  it('sorts by activeMs desc primary, then visits desc, then domain asc', () => {
    // Four setups crafted to exercise all three sort keys:
    //   a.com: 60_000 ms, 1 visit  → rank 1 (highest activeMs)
    //   b.com: 30_000 ms, 5 visits → rank 2
    //   c.com:      0 ms, 2 visits → rank 3 (more visits than d,e)
    //   d.com:      0 ms, 1 visit  → rank 4 (tied with e on visits; lex 'd' < 'e')
    //   e.com:      0 ms, 1 visit  → rank 5
    const end1 = BASE + 60_000;
    const end2 = end1 + 30_000;
    const events: TabEvent[] = [
      // a.com: 60s focus
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.com/', title: 'A' }),
      ...tickStream(BASE, end1),
      ev({ type: 'deactivate', ts: end1, tabId: 10, windowId: 1 }),
      // b.com: 30s focus, 5 visits total (1 focused navigate + 4 background)
      ev({ type: 'window_focus', ts: end1 + 1, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: end1 + 1, tabId: 11, windowId: 1 }),
      ev({ type: 'navigate', ts: end1 + 1, tabId: 11, url: 'https://b.com/x', title: 'B' }),
      ...tickStream(end1 + 1, end2),
      ev({ type: 'navigate', ts: end2, tabId: 12, url: 'https://b.com/a', title: 'B2' }),
      ev({ type: 'navigate', ts: end2 + 1, tabId: 13, url: 'https://b.com/c', title: 'B3' }),
      ev({ type: 'navigate', ts: end2 + 2, tabId: 14, url: 'https://b.com/d', title: 'B4' }),
      ev({ type: 'navigate', ts: end2 + 3, tabId: 15, url: 'https://b.com/e', title: 'B5' }),
      ev({ type: 'deactivate', ts: end2, tabId: 11, windowId: 1 }),
      // c.com: 0s focus, 2 visits
      ev({ type: 'navigate', ts: end2 + 10, tabId: 20, url: 'https://c.com/a', title: 'C1' }),
      ev({ type: 'navigate', ts: end2 + 11, tabId: 21, url: 'https://c.com/b', title: 'C2' }),
      // d.com: 0s focus, 1 visit
      ev({ type: 'navigate', ts: end2 + 12, tabId: 22, url: 'https://d.com/', title: 'D' }),
      // e.com: 0s focus, 1 visit
      ev({ type: 'navigate', ts: end2 + 13, tabId: 23, url: 'https://e.com/', title: 'E' }),
    ];
    const out = computeObsessions(events);
    expect(out.map((o) => o.domain)).toEqual(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']);
  });
});
