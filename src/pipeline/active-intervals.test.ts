import type { TabEvent } from '@tabob/shared';
import { INPUT_ATTENTION_WINDOW_MS, SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { computeActiveIntervals } from './active-intervals.js';

const BASE = 1_700_000_000_000;
const ATTN = INPUT_ATTENTION_WINDOW_MS; // 60_000

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

describe('computeActiveIntervals', () => {
  it('returns [] for empty input', () => {
    expect(computeActiveIntervals([])).toEqual([]);
  });

  it('single contiguous interval → one entry', () => {
    const end = BASE + 10 * 60_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const ivs = computeActiveIntervals(events);
    expect(ivs).toHaveLength(1);
    expect(ivs[0]).toEqual({ start: BASE, end, tabId: 10 });
  });

  it('tab switch mid-stream → two entries with different tabIds', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Switch to tab 11 after 20s.
      ev({ type: 'activate', ts: BASE + 20_000, tabId: 11, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
      ev({ type: 'deactivate', ts: BASE + 50_000, tabId: 11, windowId: 1 }),
    ];
    const ivs = computeActiveIntervals(events);
    expect(ivs).toHaveLength(2);
    expect(ivs[0]).toEqual({ start: BASE, end: BASE + 20_000, tabId: 10 });
    expect(ivs[1]).toEqual({ start: BASE + 20_000, end: BASE + 50_000, tabId: 11 });
  });

  it('attention-expiry gap produces two separate intervals on the same tab', () => {
    // Tick at BASE keeps attention to BASE+60s. No ticks until BASE+5min → attention lapses at
    // BASE+60s, segment closes there. Next tick at BASE+5min reopens attention.
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'input_tick', ts: BASE + 5 * 60_000 }),
      ev({ type: 'deactivate', ts: BASE + 6 * 60_000, tabId: 10, windowId: 1 }),
    ];
    const ivs = computeActiveIntervals(events);
    expect(ivs).toHaveLength(2);
    expect(ivs[0]).toEqual({ start: BASE, end: BASE + ATTN, tabId: 10 });
    // Second segment opens at the reviving tick, closes at deactivate.
    expect(ivs[1]).toEqual({
      start: BASE + 5 * 60_000,
      end: BASE + 6 * 60_000,
      tabId: 10,
    });
  });

  it('zero-duration segments (open and close at same ts) are dropped', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE, tabId: 10, windowId: 1 }),
    ];
    expect(computeActiveIntervals(events)).toEqual([]);
  });

  it('intervals sort ascending by start (out-of-order input OK)', () => {
    const end = BASE + 30 * 60_000;
    const sorted: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ...tickStream(BASE, end),
      ev({ type: 'deactivate', ts: end, tabId: 10, windowId: 1 }),
    ];
    const shuffled = [...sorted].reverse();
    const a = computeActiveIntervals(sorted);
    const b = computeActiveIntervals(shuffled);
    expect(b).toEqual(a);
    // Ascending by start.
    for (let i = 1; i < b.length; i++) {
      expect(b[i]!.start).toBeGreaterThanOrEqual(b[i - 1]!.start);
    }
  });

  it('does not mutate input array', () => {
    const events: TabEvent[] = [
      ev({ type: 'deactivate', ts: BASE + 10_000, tabId: 10, windowId: 1 }),
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
    ];
    const snapshot = events.map((e) => e.ts);
    computeActiveIntervals(events);
    expect(events.map((e) => e.ts)).toEqual(snapshot);
  });
});
