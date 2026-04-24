import type { TabEvent } from '@tabob/shared';
import { SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { computeUrlActivity } from './url-activity.js';

const BASE = 1_700_000_000_000;

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return { schemaVersion: SCHEMA_VERSION, tzOffsetMin: 0, ...partial };
}

function tickStream(from: number, to: number): TabEvent[] {
  const out: TabEvent[] = [];
  for (let t = from; t <= to; t += 30_000) out.push(ev({ type: 'input_tick', ts: t }));
  return out;
}

describe('computeUrlActivity', () => {
  it('empty input returns []', () => {
    expect(computeUrlActivity([])).toEqual([]);
  });

  it('happy path: single focused tab accrues activeMs, firstSeenTs, visits, and domain', () => {
    const end = BASE + 2 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://news.ycombinator.com/',
        title: 'HN',
      }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];

    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    const row = out[0]!;
    expect(row.url).toBe('https://news.ycombinator.com/');
    expect(row.title).toBe('HN');
    expect(row.domain).toBe('ycombinator.com');
    expect(row.activeMs).toBe(2 * 60_000);
    expect(row.firstSeenTs).toBe(BASE);
    expect(row.visits).toBe(1);
  });

  it('includes a URL that was navigated to but never focused (visits=1, activeMs=0)', () => {
    // Tab 10 is never activated/focused — a pure background navigate. Still surfaces.
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://example.com/',
        title: 'Example',
      }),
    ];

    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    const row = out[0]!;
    expect(row.url).toBe('https://example.com/');
    expect(row.domain).toBe('example.com');
    expect(row.activeMs).toBe(0);
    expect(row.visits).toBe(1);
    expect(row.firstSeenTs).toBe(BASE);
  });

  // ---------- Stream-wide firstSeenTs + multi-tab visits ----------

  it('same URL visited twice across two tabs: one entry, visits=2, firstSeenTs = earlier', () => {
    // Tab 10 navigates at BASE, tab 11 navigates to the same URL at BASE + 1000. Visit count
    // should be 2 and firstSeenTs should pin to BASE (earlier).
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://example.com/',
        title: 'Ex',
      }),
      ev({
        type: 'navigate',
        ts: BASE + 1000,
        tabId: 11,
        url: 'https://example.com/',
        title: 'Ex',
      }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.visits).toBe(2);
    expect(out[0]!.firstSeenTs).toBe(BASE);
  });

  it('same URL re-navigated on same tab: visits=2, firstSeenTs preserved', () => {
    // Same tab navigates to the same URL twice. firstSeenTs is stream-wide so it pins to the
    // earliest navigate; visits increments each time.
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://example.com/',
        title: 'Ex',
      }),
      ev({
        type: 'navigate',
        ts: BASE + 5000,
        tabId: 10,
        url: 'https://example.com/',
        title: 'Ex',
      }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.visits).toBe(2);
    expect(out[0]!.firstSeenTs).toBe(BASE);
  });

  // ---------- Title-only updates ----------

  it('title-only navigate updates title but does NOT bump visits', () => {
    // First navigate establishes URL+title, then a title-only navigate (no url field) updates
    // title. visits should only reflect the ONE navigate that carried a url.
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://example.com/',
        title: 'Old',
      }),
      ev({ type: 'navigate', ts: BASE + 1000, tabId: 10, title: 'New' }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('New');
    expect(out[0]!.visits).toBe(1);
  });

  it('title-only on tab without tracked URL is dropped silently', () => {
    // No prior navigate/open on tab 10 — title-only should do nothing. (And since there are no
    // URL entries at all, we get [].)
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, title: 'Ghost Title' }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toEqual([]);
  });

  it('title-only on tracked tab updates urlAcc title during focused interval', () => {
    // While tab 10 is focused on example.com, a title-only navigate updates the title. The
    // updated title should be reflected in the output.
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/', title: 'Old' }),
      ...tickStream(BASE, end),
      // Mid-interval title-only update:
      ev({ type: 'navigate', ts: BASE + 30_000, tabId: 10, title: 'Fresh' }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Fresh');
  });

  // ---------- Mid-interval navigates and sub-slicing ----------

  it('mid-interval navigate on active tab attributes sub-slices to both URLs', () => {
    // Active for [BASE, BASE+60_000). At BASE+20_000 the tab navigates to URL B. So URL A
    // should get 20_000 ms and URL B should get 40_000 ms.
    const navMid = BASE + 20_000;
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example/', title: 'A' }),
      ...tickStream(BASE, end),
      ev({ type: 'navigate', ts: navMid, tabId: 10, url: 'https://b.example/', title: 'B' }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeUrlActivity(events);
    const a = out.find((r) => r.url === 'https://a.example/')!;
    const b = out.find((r) => r.url === 'https://b.example/')!;
    expect(a.activeMs).toBe(20_000);
    expect(b.activeMs).toBe(40_000);
    expect(a.visits).toBe(1);
    expect(b.visits).toBe(1);
  });

  it('mid-interval navigate to SAME URL: no sub-slice split, but title can update', () => {
    // Active tab re-navigates to the same URL with a different title mid-interval. Since the
    // URL didn't change, there's no sub-slice — all activeMs credited to that URL, and the
    // title updates to the new one.
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/', title: 'First' }),
      ...tickStream(BASE, end),
      ev({
        type: 'navigate',
        ts: BASE + 30_000,
        tabId: 10,
        url: 'https://example.com/',
        title: 'Second',
      }),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.activeMs).toBe(60_000);
    expect(out[0]!.title).toBe('Second');
    expect(out[0]!.visits).toBe(2); // two navigate events with url
  });

  it('navigate with no active interval currently open: visits bumps, activeMs=0', () => {
    // No focus/activate/input — nothing to accrue against. A single navigate still yields a
    // row with visits=1 and activeMs=0.
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'https://orphan.example/',
        title: 'Orphan',
      }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.activeMs).toBe(0);
    expect(out[0]!.visits).toBe(1);
  });

  // ---------- Unparseable URLs ----------

  it('unparseable URL is included with domain "" sentinel', () => {
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 10,
        url: 'javascript:void(0)',
        title: 'JS',
      }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('');
    expect(out[0]!.url).toBe('javascript:void(0)');
  });

  it('unparseable URL still gets correct activeMs attribution under focus', () => {
    // javascript:void(0) is focused for a minute — activeMs should accrue even though domain
    // is the "" sentinel.
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'javascript:void(0)', title: 'JS' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('');
    expect(out[0]!.activeMs).toBe(60_000);
  });

  // ---------- Title chronology ----------

  it('final non-empty title wins when title changes mid-stream', () => {
    // Same tab navigates to URL three times. Titles are "A" → "" (empty) → "C". Empty must
    // NOT override a prior non-empty, and the final non-empty title ("C") wins.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://example.com/', title: 'A' }),
      ev({
        type: 'navigate',
        ts: BASE + 1000,
        tabId: 10,
        url: 'https://example.com/',
        title: '',
      }),
      ev({ type: 'navigate', ts: BASE + 2000, tabId: 10, url: 'https://example.com/', title: 'C' }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('C');
    expect(out[0]!.visits).toBe(3);
  });

  // ---------- Post-last-interval drain ----------

  it('post-last-interval navigate still appears with activeMs=0 and visits=1', () => {
    // Focused on URL A for 60s, deactivate, then a stray navigate to URL B after everything
    // closes. B has no interval to attribute to but must still appear via the drain pass.
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example/', title: 'A' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
      ev({
        type: 'navigate',
        ts: end + 10_000,
        tabId: 11,
        url: 'https://post.example/',
        title: 'Post',
      }),
    ];
    const out = computeUrlActivity(events);
    const post = out.find((r) => r.url === 'https://post.example/');
    expect(post).toBeDefined();
    expect(post!.activeMs).toBe(0);
    expect(post!.visits).toBe(1);
    expect(post!.firstSeenTs).toBe(end + 10_000);
  });

  // ---------- Ordering & immutability ----------

  it('out-of-order input produces same result as sorted input', () => {
    const end = BASE + 60_000;
    const sorted: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example/', title: 'A' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    // Deterministically shuffle via reverse.
    const shuffled = [...sorted].reverse();
    const sortedOut = computeUrlActivity(sorted);
    const shuffledOut = computeUrlActivity(shuffled);
    expect(shuffledOut).toEqual(sortedOut);
  });

  it('does not mutate input array', () => {
    const end = BASE + 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example/', title: 'A' }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(events));
    computeUrlActivity(events);
    expect(events).toEqual(snapshot);
  });

  // ---------- Extra coverage: firstSeenTs across tabs when stream-wide earlier wins ----------

  it('stream-wide firstSeenTs picks the earliest ts across all tabs for a URL', () => {
    // Tab 11 hits the URL first at BASE, tab 10 re-hits at BASE+5000. Result: firstSeenTs=BASE.
    const events: TabEvent[] = [
      ev({
        type: 'navigate',
        ts: BASE + 5000,
        tabId: 10,
        url: 'https://shared.example/',
        title: 'X',
      }),
      ev({
        type: 'navigate',
        ts: BASE,
        tabId: 11,
        url: 'https://shared.example/',
        title: 'X',
      }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.firstSeenTs).toBe(BASE);
    expect(out[0]!.visits).toBe(2);
  });

  // ---------- Subdomains preserved as URLs but domain canonicalizes ----------

  it('subdomains stay distinct URLs but share canonical domain', () => {
    // Two distinct URLs (different subdomains) → two rows, each with the same canonical
    // eTLD+1.
    const events: TabEvent[] = [
      ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://a.example.org/', title: 'A' }),
      ev({
        type: 'navigate',
        ts: BASE + 1000,
        tabId: 11,
        url: 'https://b.example.org/',
        title: 'B',
      }),
    ];
    const out = computeUrlActivity(events);
    expect(out).toHaveLength(2);
    for (const row of out) expect(row.domain).toBe('example.org');
  });
});
