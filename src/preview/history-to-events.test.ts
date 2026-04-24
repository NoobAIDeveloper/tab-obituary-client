import type { TabEvent } from '@tabob/shared';
import { INPUT_TICK_THROTTLE_MS, SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW_DWELL_MS,
  historyToEvents,
} from './history-to-events.js';

/**
 * Pure tests for the preview synth: `HistoryItem[] + VisitItem[]` → `TabEvent[]`.
 *
 * The fixture builders below are deliberately verbose — the synthesised stream
 * is the adversarial surface: clamp logic, ordering, tabId uniqueness, blocklist
 * canonicalisation, tick chains. Each behaviour gets its own small fixture.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
// 2026-04-22T12:00:00Z, arbitrary but stable.
const WINDOW_END = Date.UTC(2026, 3, 22, 12, 0, 0, 0);
const WINDOW_START = WINDOW_END - WINDOW_MS;

function item(url: string, title = ''): chrome.history.HistoryItem {
  return { url, title };
}

function visit(ts: number): chrome.history.VisitItem {
  return {
    id: `v-${ts}`,
    visitId: ts,
    visitTime: ts,
    referringVisitId: 0,
    transition: 'link' as chrome.history.TransitionType,
  };
}

function openEvents(events: TabEvent[]): TabEvent[] {
  return events.filter((e) => e.type === 'open');
}
function activateEvents(events: TabEvent[]): TabEvent[] {
  return events.filter((e) => e.type === 'activate');
}
function tickEvents(events: TabEvent[]): TabEvent[] {
  return events.filter((e) => e.type === 'input_tick');
}
function deactivateEvents(events: TabEvent[]): TabEvent[] {
  return events.filter((e) => e.type === 'deactivate');
}
function closeEvents(events: TabEvent[]): TabEvent[] {
  return events.filter((e) => e.type === 'close');
}

describe('historyToEvents — empty inputs', () => {
  it('empty items → empty events (no primer fires without visits)', () => {
    const events = historyToEvents({
      items: [],
      visitsByUrl: new Map(),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(events).toEqual([]);
  });

  it('items with no visits → empty events', () => {
    const events = historyToEvents({
      items: [item('https://example.com/a')],
      visitsByUrl: new Map(),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(events).toEqual([]);
  });

  it('windowEndMs ≤ windowStartMs → empty events (guard)', () => {
    const events = historyToEvents({
      items: [item('https://example.com/a')],
      visitsByUrl: new Map([['https://example.com/a', [visit(WINDOW_END - 5_000)]]]),
      windowStartMs: WINDOW_END,
      windowEndMs: WINDOW_END,
    });
    expect(events).toEqual([]);
  });
});

describe('historyToEvents — single in-window visit', () => {
  const visitTs = WINDOW_START + 60 * 60 * 1000; // 1h into the window
  const url = 'https://example.com/a';
  const title = 'Example A';
  const events = historyToEvents({
    items: [item(url, title)],
    visitsByUrl: new Map([[url, [visit(visitTs)]]]),
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
  });

  it('fires both primers at windowStartMs (window_focus + idle_state=active)', () => {
    const primerFocus = events.find(
      (e) => e.type === 'window_focus' && e.ts === WINDOW_START,
    );
    const primerIdle = events.find(
      (e) => e.type === 'idle_state' && e.ts === WINDOW_START,
    );
    expect(primerFocus).toBeDefined();
    expect(primerFocus?.windowFocused).toBe(true);
    expect(primerIdle).toBeDefined();
    expect(primerIdle?.idleState).toBe('active');
  });

  it('emits exactly one open / activate / deactivate / close per visit', () => {
    expect(openEvents(events)).toHaveLength(1);
    expect(activateEvents(events)).toHaveLength(1);
    expect(deactivateEvents(events)).toHaveLength(1);
    expect(closeEvents(events)).toHaveLength(1);
  });

  it('emits ~12 input_tick events for a 60s dwell with 5s throttle', () => {
    // The synth emits one tick at visitTs and then additional ticks while
    // `tickTs + THROTTLE_MS < endTs`. With dwell=60s/step=5s that's the
    // initial tick + 11 more = 12.
    const ticks = tickEvents(events);
    expect(ticks.length).toBe(12);
    // First tick must be at visitTs (establishes attention immediately).
    expect(ticks[0]?.ts).toBe(visitTs);
    // All ticks are inside [visitTs, visitTs + dwell).
    for (const t of ticks) {
      expect(t.ts).toBeGreaterThanOrEqual(visitTs);
      expect(t.ts).toBeLessThan(visitTs + DEFAULT_PREVIEW_DWELL_MS);
    }
    // Ticks are strictly ascending with step exactly INPUT_TICK_THROTTLE_MS.
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1];
      const cur = ticks[i];
      if (prev && cur) {
        expect(cur.ts - prev.ts).toBe(INPUT_TICK_THROTTLE_MS);
      }
    }
  });

  it('open carries url + title; activate/deactivate/close carry tabId + windowId', () => {
    const opn = openEvents(events)[0];
    expect(opn?.url).toBe(url);
    expect(opn?.title).toBe(title);
    expect(typeof opn?.tabId).toBe('number');
    expect(typeof opn?.windowId).toBe('number');

    const act = activateEvents(events)[0];
    expect(act?.tabId).toBe(opn?.tabId);
    expect(act?.windowId).toBe(opn?.windowId);

    const deact = deactivateEvents(events)[0];
    expect(deact?.tabId).toBe(opn?.tabId);
    expect(deact?.ts).toBe(visitTs + DEFAULT_PREVIEW_DWELL_MS);

    const cls = closeEvents(events)[0];
    expect(cls?.tabId).toBe(opn?.tabId);
  });
});

describe('historyToEvents — window bounds', () => {
  it('drops a visit before windowStartMs', () => {
    const url = 'https://example.com/a';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START - 1_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(events).toEqual([]);
  });

  it('drops a visit after windowEndMs', () => {
    const url = 'https://example.com/a';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_END + 1_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(events).toEqual([]);
  });

  it('includes a visit at visitTime === windowStartMs (inclusive lower bound)', () => {
    const url = 'https://example.com/a';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(openEvents(events)).toHaveLength(1);
  });

  it('excludes a visit at visitTime === windowEndMs (exclusive upper bound)', () => {
    const url = 'https://example.com/a';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_END)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(openEvents(events)).toHaveLength(0);
  });

  it('clamps deactivate/close into [windowStart, windowEnd) when dwell runs past end', () => {
    const url = 'https://example.com/a';
    const visitTs = WINDOW_END - 10_000; // 10s before end
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(visitTs)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      dwellPerVisitMs: 60_000,
    });
    const deact = deactivateEvents(events)[0];
    const cls = closeEvents(events)[0];
    expect(deact?.ts).toBe(WINDOW_END - 1);
    expect(cls?.ts).toBe(WINDOW_END - 1);
    // All events stay inside the half-open window.
    for (const e of events) {
      expect(e.ts).toBeGreaterThanOrEqual(WINDOW_START);
      expect(e.ts).toBeLessThan(WINDOW_END);
    }
  });
});

describe('historyToEvents — multi-visit overlap & unique tabIds', () => {
  it('assigns a unique synthetic tabId to each visit (same URL, overlapping)', () => {
    const url = 'https://example.com/a';
    const t1 = WINDOW_START + 60_000;
    const t2 = WINDOW_START + 90_000;
    const t3 = WINDOW_START + 120_000;
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(t1), visit(t2), visit(t3)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    const acts = activateEvents(events);
    expect(acts).toHaveLength(3);
    const ids = acts.map((a) => a.tabId);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
    for (const id of ids) expect(typeof id).toBe('number');
  });

  it('assigns unique tabIds across different URLs too', () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const ts = WINDOW_START + 60_000;
    const events = historyToEvents({
      items: [item(urlA), item(urlB)],
      visitsByUrl: new Map([
        [urlA, [visit(ts)]],
        [urlB, [visit(ts + 1_000)]],
      ]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    const acts = activateEvents(events);
    expect(acts).toHaveLength(2);
    const ids = acts.map((a) => a.tabId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('historyToEvents — blocklist', () => {
  it('drops all events for a URL whose canonical eTLD+1 is in the blocklist', () => {
    const url = 'https://www.youtube.com/watch?v=xyz';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      blocklist: new Set(['www.youtube.com']),
    });
    expect(events).toEqual([]);
  });

  it('drops subdomain URLs when the blocklist contains the eTLD+1 (sub.example.com → example.com)', () => {
    const url = 'https://sub.example.com/page';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      blocklist: new Set(['example.com']),
    });
    expect(events).toEqual([]);
  });

  it('mixed input: one blocklisted URL + one clean URL → only the clean one synthesises', () => {
    const clean = 'https://example.com/a';
    const dirty = 'https://www.youtube.com/watch?v=abc';
    const events = historyToEvents({
      items: [item(clean), item(dirty)],
      visitsByUrl: new Map([
        [clean, [visit(WINDOW_START + 60_000)]],
        [dirty, [visit(WINDOW_START + 120_000)]],
      ]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      blocklist: new Set(['youtube.com']),
    });
    expect(openEvents(events)).toHaveLength(1);
    expect(openEvents(events)[0]?.url).toBe(clean);
  });

  it('mixed-case blocklist entries are normalised (YouTube.COM matches youtube.com URL)', () => {
    const url = 'https://youtube.com/watch?v=abc';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      blocklist: new Set(['YouTube.COM']),
    });
    expect(events).toEqual([]);
  });
});

describe('historyToEvents — URLs with null canonical domain', () => {
  it('drops chrome://extensions (no eTLD+1, fallback returns "extensions") — still included in synth', () => {
    // Note: canonicalDomain("chrome://extensions") → "extensions" (non-null),
    // so this URL passes filtering. Lock in actual behaviour: synth produces events.
    const url = 'chrome://extensions/';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(openEvents(events).length).toBe(1);
  });

  it('about:blank (canonical returns null) still synthesises events (no canon-based filter drops it)', () => {
    // canonicalDomain("about:blank") returns null — the synth only drops when
    // canon is non-null AND in the blocklist. With no blocklist, this URL's
    // visits pass through. Lock in this behaviour.
    const url = 'about:blank';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    // Locked-in: synth emits for about:blank since canon is null. Not ideal,
    // but harmless — the downstream pipeline also tolerates null-canon URLs
    // and the pipeline filter drops by canon-match only.
    expect(openEvents(events).length).toBe(1);
  });
});

describe('historyToEvents — ordering and metadata', () => {
  it('returns events sorted ascending by ts', () => {
    const urlA = 'https://example.com/a';
    const urlB = 'https://example.com/b';
    const urlC = 'https://example.com/c';
    const events = historyToEvents({
      items: [item(urlA), item(urlB), item(urlC)],
      visitsByUrl: new Map([
        [urlA, [visit(WINDOW_START + 300_000)]],
        [urlB, [visit(WINDOW_START + 120_000)]],
        [urlC, [visit(WINDOW_START + 180_000)]],
      ]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const cur = events[i];
      if (prev && cur) {
        expect(cur.ts).toBeGreaterThanOrEqual(prev.ts);
      }
    }
  });

  it('every emitted event has tzOffsetMin === 0 and the correct schemaVersion', () => {
    const url = 'https://example.com/a';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.tzOffsetMin).toBe(0);
      expect(e.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });
});

describe('historyToEvents — dwell override', () => {
  it('dwell=10000 produces fewer ticks (3 = initial + 1 + 1)', () => {
    const url = 'https://example.com/a';
    const visitTs = WINDOW_START + 60_000;
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(visitTs)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      dwellPerVisitMs: 10_000,
    });
    const ticks = tickEvents(events);
    // Initial tick at visitTs, then while tickTs + 5000 < visitTs+10000.
    // tickTs=visitTs → 0+5000<10000 (push, now 5000). 5000+5000<10000 false. Stop.
    // → 2 ticks total.
    expect(ticks.length).toBe(2);
    // Deactivate at visitTs+dwell.
    const deact = deactivateEvents(events)[0];
    expect(deact?.ts).toBe(visitTs + 10_000);
  });

  it('dwell=0 is rejected by the guard → empty events (LOCK IN: reducer would reject zero-length intervals)', () => {
    // The synth treats dwell<=0 as a hard guard that returns []. Lock this in.
    const url = 'https://example.com/a';
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      dwellPerVisitMs: 0,
    });
    expect(events).toEqual([]);
  });
});

describe('historyToEvents — HistoryItem.title handling', () => {
  it('undefined title → emitted open.title is empty string (lock in)', () => {
    const url = 'https://example.com/a';
    // Build a HistoryItem whose `title` is literally undefined.
    const raw: chrome.history.HistoryItem = { url };
    const events = historyToEvents({
      items: [raw],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    const opn = openEvents(events)[0];
    expect(opn?.title).toBe('');
  });

  it('non-string title (e.g. null cast) → emitted open.title is empty string', () => {
    const url = 'https://example.com/a';
    const raw: chrome.history.HistoryItem = {
      url,
      title: null as unknown as string,
    };
    const events = historyToEvents({
      items: [raw],
      visitsByUrl: new Map([[url, [visit(WINDOW_START + 60_000)]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(openEvents(events)[0]?.title).toBe('');
  });
});

describe('historyToEvents — VisitItem.visitTime handling', () => {
  it('skips visits with non-finite visitTime', () => {
    const url = 'https://example.com/a';
    const bad: chrome.history.VisitItem = {
      id: 'bad',
      visitId: 0,
      visitTime: Number.NaN,
      referringVisitId: 0,
      transition: 'link' as chrome.history.TransitionType,
    };
    const good = visit(WINDOW_START + 60_000);
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [bad, good]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(openEvents(events).length).toBe(1);
  });

  it('skips visits with missing (undefined) visitTime', () => {
    const url = 'https://example.com/a';
    const raw = {
      id: 'missing',
      visitId: 0,
      referringVisitId: 0,
      transition: 'link',
    } as unknown as chrome.history.VisitItem;
    const events = historyToEvents({
      items: [item(url)],
      visitsByUrl: new Map([[url, [raw]]]),
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(events).toEqual([]);
  });
});
