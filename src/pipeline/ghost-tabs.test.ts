import type { TabEvent } from '@tabob/shared';
import { GHOST_TAB_CANDIDATES_TOP_N, GHOST_TAB_MAX_ACTIVE_MS, SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { computeGhostTabs } from './ghost-tabs.js';

const BASE = 1_700_000_000_000;

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return { schemaVersion: SCHEMA_VERSION, tzOffsetMin: 0, ...partial };
}

describe('computeGhostTabs', () => {
  it('returns [] for empty input', () => {
    expect(computeGhostTabs([])).toEqual([]);
  });

  it('happy path: an opened-but-never-focused tab with a URL is a ghost (activeMs=0)', () => {
    const events: TabEvent[] = [
      ev({
        type: 'open',
        ts: BASE,
        tabId: 42,
        url: 'https://some.site.example/long-read',
        title: 'Long Read',
      }),
      ev({ type: 'close', ts: BASE + 3_600_000, tabId: 42 }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      url: 'https://some.site.example/long-read',
      title: 'Long Read',
      openTs: BASE,
      activeMs: 0,
    });
  });

  it('tab with exactly GHOST_TAB_MAX_ACTIVE_MS of active time is NOT a ghost (strict <)', () => {
    // Build a stream where tab 10 accrues exactly 10_000 ms, and tab 11 accrues 0 ms. Only
    // tab 11 should come back as a ghost.
    const end = BASE + GHOST_TAB_MAX_ACTIVE_MS; // exactly 10s after BASE
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://focused.example.com/',
        title: 'Focused',
      }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
      // Background tab: opened, never focused.
      ev({
        type: 'open',
        ts: BASE + 1,
        tabId: 11,
        url: 'https://ghost.example.com/',
        title: 'Ghost',
      }),
    ];
    const out = computeGhostTabs(events);
    const urls = out.map((r) => r.url);
    expect(urls).toContain('https://ghost.example.com/');
    expect(urls).not.toContain('https://focused.example.com/');
  });

  // ---------- Boundary tests on GHOST_TAB_MAX_ACTIVE_MS ----------

  it('tab with 9_999 ms active time IS a ghost (strict <)', () => {
    // Accrue 9_999 ms by starting focus at BASE and deactivating at BASE + 9_999 ms. One
    // input_tick right at BASE keeps the attention window open for that whole span.
    const end = BASE + 9_999;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://barely.example/',
        title: 'Barely',
      }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://barely.example/');
    expect(out[0]!.activeMs).toBe(9_999);
  });

  it('tab with 5s active, single navigate: ghost with correct url/title/openTs/activeMs', () => {
    // 5s focus on example.com — below the 10s ghost threshold.
    const end = BASE + 5_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 42, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 42, url: 'https://spooky.example/', title: 'Boo' }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: end, tabId: 42, windowId: 1 }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      url: 'https://spooky.example/',
      title: 'Boo',
      openTs: BASE,
      activeMs: 5_000,
    });
  });

  // ---------- URL attribution: LAST non-empty nav/open wins ----------

  it('tab with multiple navigates: url/title = LAST nav/open with non-empty url', () => {
    // Tab 10 navigates to A, then B, then C. Ghost should report C.
    const events: TabEvent[] = [
      ev({ type: 'open', ts: BASE, tabId: 10, url: 'https://a.example/', title: 'A' }),
      ev({ type: 'navigate', ts: BASE + 1000, tabId: 10, url: 'https://b.example/', title: 'B' }),
      ev({ type: 'navigate', ts: BASE + 2000, tabId: 10, url: 'https://c.example/', title: 'C' }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://c.example/');
    expect(out[0]!.title).toBe('C');
    expect(out[0]!.openTs).toBe(BASE); // first event is open at BASE
  });

  // ---------- Skip cases ----------

  it('tab with nav events but no url field is SKIPPED', () => {
    // A navigate without a url field shouldn't qualify this tab as a ghost.
    const events: TabEvent[] = [
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE + 1, tabId: 10, title: 'No URL' }),
      ev({ type: 'close', ts: BASE + 1000, tabId: 10 }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toEqual([]);
  });

  it('tab discovered only via activate/close (no nav/open with url) is SKIPPED', () => {
    // Tab 10 is activated and closed but never navigated. Can't represent without a URL.
    const events: TabEvent[] = [
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'deactivate', ts: BASE + 500, tabId: 10, windowId: 1 }),
      ev({ type: 'close', ts: BASE + 1000, tabId: 10 }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toEqual([]);
  });

  // ---------- Sort / tie-break ----------

  it('two tabs with equal openTs sorted by url lex ascending', () => {
    // Both tabs opened at the exact same ts — sort tie-break is url asc.
    const events: TabEvent[] = [
      ev({ type: 'open', ts: BASE, tabId: 10, url: 'https://z.example/', title: 'Z' }),
      ev({ type: 'open', ts: BASE, tabId: 11, url: 'https://a.example/', title: 'A' }),
      ev({ type: 'open', ts: BASE, tabId: 12, url: 'https://m.example/', title: 'M' }),
    ];
    const out = computeGhostTabs(events);
    expect(out.map((r) => r.url)).toEqual([
      'https://a.example/',
      'https://m.example/',
      'https://z.example/',
    ]);
  });

  it('primary sort is openTs desc (most recent first)', () => {
    // Three tabs opened at different times — most recent should come first.
    const events: TabEvent[] = [
      ev({ type: 'open', ts: BASE, tabId: 10, url: 'https://oldest.example/', title: 'old' }),
      ev({
        type: 'open',
        ts: BASE + 1000,
        tabId: 11,
        url: 'https://middle.example/',
        title: 'mid',
      }),
      ev({
        type: 'open',
        ts: BASE + 2000,
        tabId: 12,
        url: 'https://newest.example/',
        title: 'new',
      }),
    ];
    const out = computeGhostTabs(events);
    expect(out.map((r) => r.url)).toEqual([
      'https://newest.example/',
      'https://middle.example/',
      'https://oldest.example/',
    ]);
  });

  // ---------- Top-N cap ----------

  it('21 ghost tabs → top 20 returned; the 21st (earliest openTs) is dropped', () => {
    // Create 21 ghost tabs at distinct openTs values. Sort is openTs desc, so the
    // earliest-opened one should be the one dropped.
    const events: TabEvent[] = [];
    for (let i = 0; i < 21; i++) {
      events.push(
        ev({
          type: 'open',
          ts: BASE + i * 1000,
          tabId: 100 + i,
          url: `https://tab${i.toString().padStart(2, '0')}.example/`,
          title: `T${i}`,
        }),
      );
    }
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(GHOST_TAB_CANDIDATES_TOP_N);
    // The one we expect dropped has openTs = BASE (i=0), url = https://tab00.example/
    expect(out.find((r) => r.url === 'https://tab00.example/')).toBeUndefined();
    // The most recent opens should all be present.
    expect(out.find((r) => r.url === 'https://tab20.example/')).toBeDefined();
  });

  // ---------- openTs from first event of ANY type ----------

  it('openTs uses the first event of ANY type for that tab (activate before nav)', () => {
    // Tab 10 has an activate at BASE, then a navigate at BASE+5000. openTs should be BASE.
    const events: TabEvent[] = [
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE + 5000,
        tabId: 10,
        url: 'https://late.example/',
        title: 'Late',
      }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.openTs).toBe(BASE);
    expect(out[0]!.url).toBe('https://late.example/');
  });

  it('openTs can be a close event if it is the first event carrying that tabId', () => {
    // Weird but allowed: close with tabId 10 appears BEFORE any nav/open because the open
    // happened before event capture started. openTs should be the close ts, but there's no
    // url-bearing event — so the tab must be SKIPPED. (Per module contract.)
    const events: TabEvent[] = [
      ev({ type: 'close', ts: BASE, tabId: 10 }),
      ev({
        type: 'open',
        ts: BASE + 1000,
        tabId: 11,
        url: 'https://real.example/',
        title: 'Real',
      }),
    ];
    const out = computeGhostTabs(events);
    // Only tab 11 should appear; tab 10 skipped for lack of url.
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://real.example/');
  });

  // ---------- Tab closure + still-a-ghost ----------

  it('closed tab still surfaces as ghost when accumulated activeMs < 10s', () => {
    // Tab opens, focuses for 3s, then closes. Should still be a ghost (3_000 < 10_000).
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'open', ts: BASE, tabId: 10, url: 'https://brief.example/', title: 'Brief' }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'close', ts: BASE + 3_000, tabId: 10 }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://brief.example/');
    expect(out[0]!.activeMs).toBe(3_000);
  });

  // ---------- Multiple ghosts from mixed discovery paths ----------

  it('mixes focused-but-under-10s tab with opened-but-never-focused tab', () => {
    // Tab 10 focused 4s. Tab 11 opened only.
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'open', ts: BASE, tabId: 10, url: 'https://focused.example/', title: 'F' }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 4_000, tabId: 10, windowId: 1 }),
      ev({
        type: 'open',
        ts: BASE + 5_000,
        tabId: 11,
        url: 'https://never.example/',
        title: 'N',
      }),
    ];
    const out = computeGhostTabs(events);
    expect(out).toHaveLength(2);
    // openTs desc — tab 11 opened at BASE+5000, tab 10 opened at BASE.
    expect(out[0]!.url).toBe('https://never.example/');
    expect(out[1]!.url).toBe('https://focused.example/');
    expect(out[0]!.activeMs).toBe(0);
    expect(out[1]!.activeMs).toBe(4_000);
  });
});
