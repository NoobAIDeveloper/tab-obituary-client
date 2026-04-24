import type { TabEvent } from '@tabob/shared';
import { DOMAIN_TITLE_PAIRS_TOP_N, SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { gatherDomainTitlePairs } from './domain-pairs.js';

const BASE = 1_700_000_000_000;

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return { schemaVersion: SCHEMA_VERSION, tzOffsetMin: 0, ...partial };
}

function tickStream(from: number, to: number): TabEvent[] {
  const out: TabEvent[] = [];
  for (let t = from; t <= to; t += 30_000) out.push(ev({ type: 'input_tick', ts: t }));
  return out;
}

describe('gatherDomainTitlePairs', () => {
  it('empty input returns []', () => {
    expect(gatherDomainTitlePairs([])).toEqual([]);
  });

  it('happy path: emits (domain, title, activeMs) for a focused URL', () => {
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://news.ycombinator.com/item?id=1',
        title: 'Cool Post',
      }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      domain: 'ycombinator.com',
      title: 'Cool Post',
      activeMs: 60_000,
    });
  });

  it('drops entries with empty title (boundary)', () => {
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      // Navigate with NO title — should be dropped.
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://quiet.example.com/' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
      // And one with a title that should survive.
      ev({ type: 'window_focus', ts: end + 1, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: end + 1, tabId: 11, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: end + 1,
        tabId: 11,
        url: 'https://loud.example.com/',
        title: 'Loud',
      }),
      ...tickStream(end + 1, end + 60_001),
      ev({ type: 'deactivate', ts: end + 60_001, tabId: 11, windowId: 1 }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out.every((r) => r.title !== '')).toBe(true);
    expect(out.find((r) => r.domain === 'example.com' && r.title === 'Loud')).toBeDefined();
    // Ensure "quiet" with empty title didn't leak in.
    expect(out.find((r) => r.title === '')).toBeUndefined();
  });

  // ---------- Pair variation ----------

  it('single (domain, title) pair emits exactly one row', () => {
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://solo.example/', title: 'Solo' }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ domain: 'solo.example', title: 'Solo', activeMs: 0 });
  });

  it('same domain + two different titles → two separate rows', () => {
    // Two distinct URLs on example.com with DIFFERENT titles — two rows.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/a', title: 'Alpha' }),
      ev({
        type: 'navigate',
        ts: BASE + 1,
        tabId: 11,
        url: 'https://example.com/b',
        title: 'Beta',
      }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(2);
    const titles = out.map((r) => r.title).sort();
    expect(titles).toEqual(['Alpha', 'Beta']);
  });

  it('same title + two different domains → two separate rows', () => {
    // Same title "Home" on two different domains — two rows.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://foo.com/', title: 'Home' }),
      ev({ type: 'navigate', ts: BASE + 1, tabId: 11, url: 'https://bar.com/', title: 'Home' }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.domain).sort()).toEqual(['bar.com', 'foo.com']);
    expect(out.every((r) => r.title === 'Home')).toBe(true);
  });

  // ---------- Empty-domain rows dropped ----------

  it('drops rows with empty-domain (null canonical) like about:/javascript:', () => {
    // about:blank yields null canonical and is dropped even though it has a title.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'about:blank', title: 'Blank' }),
      ev({
        type: 'navigate',
        ts: BASE + 1,
        tabId: 11,
        url: 'https://real.example/',
        title: 'Real',
      }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('real.example');
  });

  // ---------- Sort/tie-break ----------

  it('sorts by activeMs desc, then domain asc, then title asc', () => {
    // Craft rows with engineered tie scenarios. Using multiple focus intervals to get distinct
    // activeMs values per URL.
    //   - (x.com, Hi):    60_000 ms
    //   - (x.com, Zz):    30_000 ms
    //   - (a.com, Mid):        0 ms (background only)
    //   - (b.com, Mid):        0 ms (background only) — tie on 0 + domain 'a' < 'b'
    //   - (c.com, Aaa):        0 ms (background only) — title 'Aaa' vs 'Bbb' below
    //   - (c.com, Bbb):        0 ms (background only)
    const end1 = BASE + 60_000;
    const end2 = end1 + 30_000;
    const events: TabEvent[] = [
      // (x.com, Hi) focused 60s
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.com/hi', title: 'Hi' }),
      ...tickStream(BASE, end1),
      ev({ type: 'deactivate', ts: end1, tabId: 10, windowId: 1 }),
      // (x.com, Zz) focused 30s
      ev({ type: 'window_focus', ts: end1 + 1, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: end1 + 1, tabId: 11, windowId: 1 }),
      ev({ type: 'navigate', ts: end1 + 1, tabId: 11, url: 'https://x.com/zz', title: 'Zz' }),
      ...tickStream(end1 + 1, end2),
      ev({ type: 'deactivate', ts: end2, tabId: 11, windowId: 1 }),
      // Zero-activeMs background navigates, all tied on 0 ms
      ev({
        type: 'navigate',
        ts: end2 + 10,
        tabId: 20,
        url: 'https://a.com/',
        title: 'Mid',
      }),
      ev({
        type: 'navigate',
        ts: end2 + 11,
        tabId: 21,
        url: 'https://b.com/',
        title: 'Mid',
      }),
      ev({
        type: 'navigate',
        ts: end2 + 12,
        tabId: 22,
        url: 'https://c.com/bbb',
        title: 'Bbb',
      }),
      ev({
        type: 'navigate',
        ts: end2 + 13,
        tabId: 23,
        url: 'https://c.com/aaa',
        title: 'Aaa',
      }),
    ];
    const out = gatherDomainTitlePairs(events);
    // Primary (activeMs desc): x.com Hi (60000), x.com Zz (30000), then all four 0-ms rows.
    // Within zero block: domain asc (a, b, c, c), title asc within c.
    expect(out.map((r) => `${r.domain}|${r.title}`)).toEqual([
      'x.com|Hi',
      'x.com|Zz',
      'a.com|Mid',
      'b.com|Mid',
      'c.com|Aaa',
      'c.com|Bbb',
    ]);
  });

  // ---------- Top-N cap ----------

  it('51 pairs → top 50 returned (the least-recent tie-broken pair drops)', () => {
    // 51 distinct (domain, title) pairs all with 0 activeMs (1 background visit each). Top 50
    // capped by the module.
    const events: TabEvent[] = [];
    for (let i = 0; i < 51; i++) {
      events.push(
        ev({
          type: 'navigate',
          ts: BASE + i,
          tabId: 100 + i,
          url: `https://d${i.toString().padStart(2, '0')}.example/`,
          title: `T${i.toString().padStart(2, '0')}`,
        }),
      );
    }
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(DOMAIN_TITLE_PAIRS_TOP_N);
  });

  // ---------- Title chronology: final non-empty title wins ----------

  it('URL with title "A" then "B" emits only (domain, B) — final title wins', () => {
    // Same URL navigated twice. url-activity collapses to the final non-empty title. So only
    // ONE pair should appear, with title "B".
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://example.com/item',
        title: 'A',
      }),
      ev({
        type: 'navigate',
        ts: BASE + 1000,
        tabId: 10,
        url: 'https://example.com/item',
        title: 'B',
      }),
    ];
    const out = gatherDomainTitlePairs(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('B');
    expect(out[0]!.domain).toBe('example.com');
  });

  // ---------- Aggregation ----------

  it('two different URLs on example.com with same title "Home" → ONE row with summed activeMs', () => {
    // Two distinct URLs under example.com, each focused for 30s, both titled "Home". Should
    // collapse to ONE (example.com, Home) row with activeMs = 60_000.
    const urlAStart = BASE;
    const urlBStart = BASE + 30_000;
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: urlAStart,
        tabId: 10,
        url: 'https://example.com/a',
        title: 'Home',
      }),
      ...tickStream(BASE, end),
      ev({
        type: 'navigate',
        ts: urlBStart,
        tabId: 10,
        url: 'https://example.com/b',
        title: 'Home',
      }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = gatherDomainTitlePairs(events);
    // Two different URL rows in url-activity, but they merge by (domain, title) here.
    const homeRows = out.filter((r) => r.domain === 'example.com' && r.title === 'Home');
    expect(homeRows).toHaveLength(1);
    expect(homeRows[0]!.activeMs).toBe(60_000);
  });
});
