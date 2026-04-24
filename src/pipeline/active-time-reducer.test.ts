import type { TabEvent } from '@tabob/shared';
import { INPUT_ATTENTION_WINDOW_MS, SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { activeTimePerTab, computeActiveTime } from './active-time-reducer.js';

const BASE = 1_700_000_000_000;
const ATTN = INPUT_ATTENTION_WINDOW_MS; // 60_000

function ev(partial: Partial<TabEvent> & { type: TabEvent['type']; ts: number }): TabEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    tzOffsetMin: 0,
    ...partial,
  };
}

describe('computeActiveTime', () => {
  it('empty input returns zero', () => {
    expect(computeActiveTime([])).toEqual({ perTab: new Map(), totalActiveMs: 0 });
  });

  it('30s of attention on a single activated+focused tab credits 30_000 ms', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 30_000, tabId: 10, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    expect(result.perTab.get(10)).toBe(30_000);
    expect(result.totalActiveMs).toBe(30_000);
  });

  it('idle during an active period reduces the count', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'idle_state', ts: BASE + 10_000, idleState: 'idle' }),
      ev({ type: 'idle_state', ts: BASE + 25_000, idleState: 'active' }),
      // Another input tick is required because the prior one is still within 60s,
      // but idle→active alone should resume accrual.
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 10, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    // Accrued [0,10s) and [25s, 40s) = 10s + 15s = 25s.
    expect(result.perTab.get(10)).toBe(25_000);
  });

  it('a tab activated while its window is unfocused accrues zero', () => {
    const events: TabEvent[] = [
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 60_000, tabId: 10, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    expect(result.perTab.get(10)).toBeUndefined();
    expect(result.totalActiveMs).toBe(0);
  });

  it('activeTimePerTab returns the same map as computeActiveTime', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 5_000, tabId: 10, windowId: 1 }),
    ];
    expect(activeTimePerTab(events).get(10)).toBe(5_000);
  });

  it('attention window expires 60s after the last input_tick', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 90 * 60_000, tabId: 10, windowId: 1 }),
    ];
    // Attention expires at BASE + 60_000. Only that first 60s accrues.
    expect(computeActiveTime(events).perTab.get(10)).toBe(60_000);
  });
});

describe('window_focus semantics', () => {
  it('windowFocused:false on an already-unfocused window is a no-op', () => {
    const events: TabEvent[] = [
      // Window 1 focused, tab 10 active, input flowing.
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Spurious blur of window 2 (not focused) shouldn't disturb anything.
      ev({ type: 'window_focus', ts: BASE + 10_000, windowId: 2, windowFocused: false }),
      ev({ type: 'deactivate', ts: BASE + 30_000, tabId: 10, windowId: 1 }),
    ];
    // Full [0, 30s) still accrues.
    expect(computeActiveTime(events).perTab.get(10)).toBe(30_000);
  });

  it('windowFocused:false on the focused window clears focus and stops accrual', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'window_focus', ts: BASE + 15_000, windowId: 1, windowFocused: false }),
      // No more accrual; deactivate well before attention window.
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 10, windowId: 1 }),
    ];
    // Only [0, 15s) credited.
    expect(computeActiveTime(events).perTab.get(10)).toBe(15_000);
  });

  it('window_focus with windowId -1 (WINDOW_ID_NONE) clears focus mid-accrual', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // OS defocused all windows.
      ev({ type: 'window_focus', ts: BASE + 20_000, windowId: -1 }),
      ev({ type: 'deactivate', ts: BASE + 50_000, tabId: 10, windowId: 1 }),
    ];
    // [0, 20s) = 20_000ms credited; after -1, nothing focused.
    expect(computeActiveTime(events).perTab.get(10)).toBe(20_000);
  });

  it('focus transfers from window A to window B: prior window accrual stops, new window resumes', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      // Tab 20 activated in window 2 ahead of time (not yet focused, no accrual).
      ev({ type: 'activate', ts: BASE, tabId: 20, windowId: 2 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Focus switches to window 2 at t+15s.
      ev({ type: 'window_focus', ts: BASE + 15_000, windowId: 2, windowFocused: true }),
      // More input to keep attention alive.
      ev({ type: 'input_tick', ts: BASE + 20_000 }),
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 20, windowId: 2 }),
    ];
    const result = computeActiveTime(events);
    // Tab 10: [0, 15s) = 15_000 ms.
    expect(result.perTab.get(10)).toBe(15_000);
    // Tab 20: [15s, 40s) = 25_000 ms (still within attention window from tick at 20s: 20+60=80 > 40).
    expect(result.perTab.get(20)).toBe(25_000);
    expect(result.totalActiveMs).toBe(40_000);
  });

  it('switch from (winA tab 10) to (winB tab 20) closes tab 10 segment and opens tab 20', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'activate', ts: BASE, tabId: 20, windowId: 2 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Switch to window 2 at t+10s.
      ev({ type: 'window_focus', ts: BASE + 10_000, windowId: 2, windowFocused: true }),
      ev({ type: 'deactivate', ts: BASE + 25_000, tabId: 20, windowId: 2 }),
    ];
    const result = computeActiveTime(events);
    // Tab 10: [0, 10s) = 10_000; tab 20: [10s, 25s) = 15_000.
    expect(result.perTab.get(10)).toBe(10_000);
    expect(result.perTab.get(20)).toBe(15_000);
  });
});

describe('deactivate / close semantics', () => {
  it('deactivate with mismatched tabId is stale and does NOT clear the active tab', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Stale deactivate for tab 77 in window 1 — tab 10 should keep accruing.
      ev({ type: 'deactivate', ts: BASE + 20_000, tabId: 77, windowId: 1 }),
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 10, windowId: 1 }),
    ];
    // Tab 10 accrues uninterrupted: [0, 40s) = 40_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(40_000);
    // Stale tab 77 never activated so no entry.
    expect(computeActiveTime(events).perTab.get(77)).toBeUndefined();
  });

  it('deactivate with no tabId field treats as "clear current"', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Deactivate without tabId — clears whatever tab is active in window 1.
      ev({ type: 'deactivate', ts: BASE + 20_000, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
    ];
    // Only [0, 20s) = 20_000 ms credited to tab 10.
    expect(computeActiveTime(events).perTab.get(10)).toBe(20_000);
  });

  it("close of non-active tab is a no-op (doesn't disturb accrual)", () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Close tab 99 which was never active.
      ev({ type: 'close', ts: BASE + 15_000, tabId: 99 }),
      ev({ type: 'deactivate', ts: BASE + 30_000, tabId: 10, windowId: 1 }),
    ];
    // Tab 10 uninterrupted: [0, 30s) = 30_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(30_000);
  });

  it('close of the currently-active tab implicitly deactivates it and stops accrual', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // User closes the active tab at t+18s.
      ev({ type: 'close', ts: BASE + 18_000, tabId: 10 }),
      // More input, but no active tab in the focused window anymore.
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
    ];
    // Only [0, 18s) = 18_000 credited.
    expect(computeActiveTime(events).perTab.get(10)).toBe(18_000);
  });

  it('close event with no tabId is a no-op', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'close', ts: BASE + 10_000 }), // no tabId — ignored
      ev({ type: 'deactivate', ts: BASE + 20_000, tabId: 10, windowId: 1 }),
    ];
    // Tab 10 uninterrupted: [0, 20s) = 20_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(20_000);
  });
});

describe('activate sequences', () => {
  it('back-to-back activates: first tab accrues until second activate, then second tab', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Switch tabs within the same window (no explicit deactivate).
      ev({ type: 'activate', ts: BASE + 12_000, tabId: 11, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE + 20_000 }),
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 11, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    // Tab 10: [0, 12s) = 12_000.
    expect(result.perTab.get(10)).toBe(12_000);
    // Tab 11: [12s, 40s) = 28_000.
    expect(result.perTab.get(11)).toBe(28_000);
    expect(result.totalActiveMs).toBe(40_000);
  });

  it('activate with missing tabId or windowId is a no-op', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'input_tick', ts: BASE }),
      // Malformed activates — should not crash or change state.
      ev({ type: 'activate', ts: BASE + 1_000, tabId: 10 }), // missing windowId
      ev({ type: 'activate', ts: BASE + 2_000, windowId: 1 }), // missing tabId
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
    ];
    const result = computeActiveTime(events);
    expect(result.perTab.size).toBe(0);
    expect(result.totalActiveMs).toBe(0);
  });
});

describe('idle semantics', () => {
  it('idle_state: locked is treated the same as idle (idle = idleState !== "active")', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'idle_state', ts: BASE + 10_000, idleState: 'locked' }),
      ev({ type: 'idle_state', ts: BASE + 30_000, idleState: 'active' }),
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 10, windowId: 1 }),
    ];
    // [0, 10s) = 10_000 (pre-lock); [30s, 40s) = 10_000 (post-resume, input from BASE still within 60s).
    // Total 20_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(20_000);
  });

  it('idle → active transition resumes accrual only if input window still valid', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'idle_state', ts: BASE + 5_000, idleState: 'idle' }),
      // Come back "active" long after the input window has elapsed (last tick at BASE, window ends at BASE+60s).
      ev({ type: 'idle_state', ts: BASE + 120_000, idleState: 'active' }),
      ev({ type: 'deactivate', ts: BASE + 150_000, tabId: 10, windowId: 1 }),
    ];
    // [0, 5s) credited. After resume, lastInputTs still BASE but lastInputTs + 60_000 < 120s → lapsed → no accrual.
    expect(computeActiveTime(events).perTab.get(10)).toBe(5_000);
  });

  it('idle_state with no idleState field is a no-op', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'idle_state', ts: BASE + 10_000 }), // malformed, ignored
      ev({ type: 'deactivate', ts: BASE + 30_000, tabId: 10, windowId: 1 }),
    ];
    // Uninterrupted: [0, 30s) = 30_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(30_000);
  });

  it('multiple idle flips within a single accrual window', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'idle_state', ts: BASE + 5_000, idleState: 'idle' }),
      ev({ type: 'idle_state', ts: BASE + 10_000, idleState: 'active' }),
      ev({ type: 'idle_state', ts: BASE + 20_000, idleState: 'idle' }),
      ev({ type: 'idle_state', ts: BASE + 30_000, idleState: 'active' }),
      ev({ type: 'deactivate', ts: BASE + 50_000, tabId: 10, windowId: 1 }),
    ];
    // Accrued spans: [0,5s) + [10s,20s) + [30s,50s) = 5 + 10 + 20 = 35s.
    expect(computeActiveTime(events).perTab.get(10)).toBe(35_000);
  });
});

describe('input_tick / attention window', () => {
  it('gap between input ticks longer than 60s pauses accrual 60s after last tick, resumes on next tick', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // No ticks for 3 minutes; attention expires at BASE+60_000.
      ev({ type: 'input_tick', ts: BASE + 180_000 }),
      ev({ type: 'deactivate', ts: BASE + 200_000, tabId: 10, windowId: 1 }),
    ];
    // Segment 1: [0, 60s) = 60_000; Segment 2: [180s, 200s) = 20_000 → total 80_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(80_000);
  });

  it('input_tick exactly at the 60s boundary is treated as LAPSED (strict > in code)', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Exactly at boundary: lastInputTs + ATTN === ev.ts → strict > fails → wasAttentive = false,
      // so code treats as a fresh tick after lapse → resyncs at this ts.
      ev({ type: 'input_tick', ts: BASE + ATTN }),
      ev({ type: 'deactivate', ts: BASE + ATTN + 30_000, tabId: 10, windowId: 1 }),
    ];
    // First segment: [0, 60s) closes at attention expiry = BASE+60s (processAttentionExpiry fires on the boundary tick).
    // Actually: expiry = BASE + 60_000; processAttentionExpiry(untilTs=BASE+60_000) checks expiry < untilTs → false → no early close.
    // Then input_tick handler: wasAttentive is (BASE + 60_000 > BASE + 60_000) → false → resync at BASE+60_000 (same tab, no-op).
    // Segment stays open; at deactivate (BASE+90s), attention expiry now = (BASE+60_000)+60_000 = BASE+120s → still fine.
    // Full [0, 90s) credited = 90_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(90_000);
  });

  it('attention expiration mid-stream (no event at the expiry moment) still closes segment at expiry', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // No events for a long time; then an idle event far later. Attention expires at BASE+60s.
      ev({ type: 'idle_state', ts: BASE + 300_000, idleState: 'idle' }),
    ];
    // Segment closes at expiry BASE+60s. Subsequent events can't revive without a fresh tick.
    expect(computeActiveTime(events).perTab.get(10)).toBe(60_000);
  });

  it('input_tick before any activate/window_focus does not accrue (no crash)', () => {
    const events: TabEvent[] = [
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'input_tick', ts: BASE + 5_000 }),
      // Never any window_focus or activate.
    ];
    const result = computeActiveTime(events);
    expect(result.perTab.size).toBe(0);
    expect(result.totalActiveMs).toBe(0);
  });

  it('input_tick while idle does not accrue', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'idle_state', ts: BASE, idleState: 'idle' }),
      ev({ type: 'input_tick', ts: BASE + 5_000 }),
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
      ev({ type: 'idle_state', ts: BASE + 40_000, idleState: 'active' }),
      ev({ type: 'deactivate', ts: BASE + 50_000, tabId: 10, windowId: 1 }),
    ];
    // Idle from 0 to 40s. After becoming active at 40s, lastInputTs = 30s, 30+60=90 > 40 → still attentive.
    // Accrual [40s, 50s) = 10_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(10_000);
  });
});

describe('end-of-stream accrual', () => {
  it('last event is an input_tick: segment ends at lastEventTs (NOT extended 60s further)', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
    ];
    // Segment is [0, 30s) because tail is bounded at lastEventTs, not lastInputTs+60s.
    expect(computeActiveTime(events).perTab.get(10)).toBe(30_000);
  });

  it('last event is deactivate after attention expiry: segment ends at expiry, NOT lastEventTs', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Attention expires at BASE+60s; deactivate happens at BASE+5min.
      ev({ type: 'deactivate', ts: BASE + 300_000, tabId: 10, windowId: 1 }),
    ];
    // Accrual closed at expiry = 60_000 ms.
    expect(computeActiveTime(events).perTab.get(10)).toBe(60_000);
  });

  it('last event mid-segment: tail closes at lastEventTs when attention still valid', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE + 5_000 }),
      // Stream ends with a non-accrual-state event mid-attention.
      ev({ type: 'navigate', ts: BASE + 20_000, tabId: 10, url: 'https://x.test' }),
    ];
    // Segment starts at BASE+5s (first tick), ends at lastEventTs BASE+20s = 15_000 ms.
    expect(computeActiveTime(events).perTab.get(10)).toBe(15_000);
  });
});

describe('tie breaking at equal ts', () => {
  it('simultaneous activate + input_tick + window_focus at equal ts — order in input determines state', () => {
    // Order A: window_focus first, activate second, input_tick third. Should accrue from this ts.
    const eventsA: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 10_000, tabId: 10, windowId: 1 }),
    ];
    expect(computeActiveTime(eventsA).perTab.get(10)).toBe(10_000);

    // Order B: same events, input_tick first (before focus/activate). Resync on tick finds nothing to accrue.
    // Then focus and activate happen at same ts — resync opens segment at BASE.
    const eventsB: TabEvent[] = [
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'deactivate', ts: BASE + 10_000, tabId: 10, windowId: 1 }),
    ];
    expect(computeActiveTime(eventsB).perTab.get(10)).toBe(10_000);
  });

  it('stable sort preserves input order among equal-ts events', () => {
    // activate 10 then activate 11 at same ts → last-in-order wins (tab 11).
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'activate', ts: BASE + 1_000, tabId: 10, windowId: 1 }),
      ev({ type: 'activate', ts: BASE + 1_000, tabId: 11, windowId: 1 }),
      ev({ type: 'deactivate', ts: BASE + 10_000, tabId: 11, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    // Tab 10 has zero-width segment (opened and instantly replaced at same ts).
    expect(result.perTab.get(10)).toBeUndefined();
    // Tab 11: [1s, 10s) = 9_000.
    expect(result.perTab.get(11)).toBe(9_000);
  });
});

describe('multi-window / multi-tab independence', () => {
  it('multiple tabs across multiple windows interleaved — perTab counts independent', () => {
    const events: TabEvent[] = [
      // Window 1 focused, tab 10 active.
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      // Window 2 has tab 20 active (unfocused so far).
      ev({ type: 'activate', ts: BASE, tabId: 20, windowId: 2 }),
      ev({ type: 'input_tick', ts: BASE }),
      // After 10s, switch tabs within window 1: 10 → 11.
      ev({ type: 'activate', ts: BASE + 10_000, tabId: 11, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE + 20_000 }),
      // After 30s total, focus to window 2 (tab 20 active there).
      ev({ type: 'window_focus', ts: BASE + 30_000, windowId: 2, windowFocused: true }),
      ev({ type: 'input_tick', ts: BASE + 40_000 }),
      // After 50s total, switch back to window 1 (where tab 11 is still active).
      ev({ type: 'window_focus', ts: BASE + 50_000, windowId: 1, windowFocused: true }),
      ev({ type: 'input_tick', ts: BASE + 60_000 }),
      ev({ type: 'deactivate', ts: BASE + 75_000, tabId: 11, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    // Tab 10: [0, 10s) = 10_000.
    expect(result.perTab.get(10)).toBe(10_000);
    // Tab 11: [10s, 30s) + [50s, 75s) = 20_000 + 25_000 = 45_000.
    expect(result.perTab.get(11)).toBe(45_000);
    // Tab 20: [30s, 50s) = 20_000.
    expect(result.perTab.get(20)).toBe(20_000);
    expect(result.totalActiveMs).toBe(75_000);
  });

  it('activity in unfocused window does not leak into the focused tab', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Simultaneous activity in window 2 (not focused).
      ev({ type: 'activate', ts: BASE + 5_000, tabId: 20, windowId: 2 }),
      ev({ type: 'deactivate', ts: BASE + 8_000, tabId: 20, windowId: 2 }),
      ev({ type: 'deactivate', ts: BASE + 30_000, tabId: 10, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    expect(result.perTab.get(10)).toBe(30_000);
    expect(result.perTab.get(20)).toBeUndefined();
  });
});

describe('input ordering and sanity', () => {
  it('events out-of-order in the input array produce same result as pre-sorted', () => {
    const sorted: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'input_tick', ts: BASE + 20_000 }),
      ev({ type: 'deactivate', ts: BASE + 45_000, tabId: 10, windowId: 1 }),
    ];
    const shuffled: TabEvent[] = [sorted[4]!, sorted[0]!, sorted[3]!, sorted[2]!, sorted[1]!];
    const a = computeActiveTime(sorted);
    const b = computeActiveTime(shuffled);
    expect(b.perTab.get(10)).toBe(a.perTab.get(10));
    expect(b.totalActiveMs).toBe(a.totalActiveMs);
  });

  it('totalActiveMs always equals sum of perTab.values()', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'activate', ts: BASE, tabId: 20, windowId: 2 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'activate', ts: BASE + 15_000, tabId: 11, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE + 30_000 }),
      ev({ type: 'window_focus', ts: BASE + 40_000, windowId: 2, windowFocused: true }),
      ev({ type: 'input_tick', ts: BASE + 60_000 }),
      ev({ type: 'deactivate', ts: BASE + 80_000, tabId: 20, windowId: 2 }),
    ];
    const result = computeActiveTime(events);
    let sum = 0;
    for (const ms of result.perTab.values()) sum += ms;
    expect(result.totalActiveMs).toBe(sum);
  });

  it('does not mutate the input array', () => {
    const events: TabEvent[] = [
      ev({ type: 'deactivate', ts: BASE + 10_000, tabId: 10, windowId: 1 }),
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
    ];
    const snapshot = events.map((e) => e.ts);
    computeActiveTime(events);
    expect(events.map((e) => e.ts)).toEqual(snapshot);
  });
});

describe('single-event-in-isolation and other minimal inputs', () => {
  it.each([
    ['open', ev({ type: 'open', ts: BASE, tabId: 10, windowId: 1 })],
    ['navigate', ev({ type: 'navigate', ts: BASE, tabId: 10, url: 'https://x.test' })],
    ['close', ev({ type: 'close', ts: BASE, tabId: 10 })],
    ['activate', ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 })],
    ['deactivate', ev({ type: 'deactivate', ts: BASE, tabId: 10, windowId: 1 })],
    ['input_tick', ev({ type: 'input_tick', ts: BASE })],
    ['idle_state', ev({ type: 'idle_state', ts: BASE, idleState: 'active' })],
    ['window_focus', ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true })],
  ])('single %s event in isolation does not crash and accrues zero', (_label, event) => {
    const result = computeActiveTime([event]);
    expect(result.perTab.size).toBe(0);
    expect(result.totalActiveMs).toBe(0);
  });
});

describe('long-duration and DST-style windows', () => {
  it('handles a 25-hour "fall-back" DST day — timestamps are UNIX ms and monotonic', () => {
    // Simulate a day that happens to be 25 hours long in wall-clock terms.
    // The reducer only sees UNIX ms, so this should just work.
    const DAY_25H_MS = 25 * 3_600_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
    ];
    // Generate an input_tick every 30s for the full 25h so attention never lapses.
    for (let t = 0; t <= DAY_25H_MS; t += 30_000) {
      events.push(ev({ type: 'input_tick', ts: BASE + t }));
    }
    events.push(ev({ type: 'deactivate', ts: BASE + DAY_25H_MS, tabId: 10, windowId: 1 }));
    const result = computeActiveTime(events);
    // Full 25h accrued to tab 10.
    expect(result.perTab.get(10)).toBe(DAY_25H_MS);
  });

  it('handles a 23-hour "spring-forward" DST day', () => {
    const DAY_23H_MS = 23 * 3_600_000;
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
    ];
    for (let t = 0; t <= DAY_23H_MS; t += 30_000) {
      events.push(ev({ type: 'input_tick', ts: BASE + t }));
    }
    events.push(ev({ type: 'deactivate', ts: BASE + DAY_23H_MS, tabId: 10, windowId: 1 }));
    expect(computeActiveTime(events).perTab.get(10)).toBe(DAY_23H_MS);
  });
});

describe('pathological and robustness scenarios', () => {
  it('zero-duration segments (start and end at same ts) contribute nothing', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Immediately deactivate at the same ts.
      ev({ type: 'deactivate', ts: BASE, tabId: 10, windowId: 1 }),
    ];
    const result = computeActiveTime(events);
    expect(result.perTab.get(10)).toBeUndefined();
    expect(result.totalActiveMs).toBe(0);
  });

  it('many short accrual segments sum correctly', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
    ];
    // 10 idle/active flips of 1s apart, spanning [0, 30s].
    for (let i = 1; i <= 30; i++) {
      events.push(
        ev({
          type: 'idle_state',
          ts: BASE + i * 1_000,
          idleState: i % 2 === 1 ? 'idle' : 'active',
        }),
      );
    }
    events.push(ev({ type: 'deactivate', ts: BASE + 31_000, tabId: 10, windowId: 1 }));
    // Active spans: [0,1) + [2,3) + [4,5) + ... + [30,31) = 16 one-second spans = 16_000 ms.
    // Counting even-i transitions (idle→active at i=2,4,...,30 = 15 flips to active; each active span = 1s until next odd).
    // Actually: at i=1 go idle (was active from 0), at i=2 go active, ..., at i=30 go active, then deactivate at 31.
    // Active spans: [0,1) i=0 to i=1 = 1s; [2,3), [4,5), ..., [28,29) (pairs 2-3,4-5,...,28-29 → 14 spans); [30,31) = 1s.
    // Total active: 1 + 14 + 1 = 16 seconds = 16_000 ms.
    expect(computeActiveTime(events).perTab.get(10)).toBe(16_000);
  });

  it('window_focus without windowId is a no-op', () => {
    const events: TabEvent[] = [
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      // Malformed window_focus — should not set any focus.
      ev({ type: 'window_focus', ts: BASE + 5_000, windowFocused: true }),
      ev({ type: 'deactivate', ts: BASE + 30_000, tabId: 10, windowId: 1 }),
    ];
    expect(computeActiveTime(events).perTab.get(10)).toBeUndefined();
  });

  it('deactivate without windowId is a no-op', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'deactivate', ts: BASE + 20_000, tabId: 10 }), // missing windowId — ignored
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 10, windowId: 1 }),
    ];
    // Uninterrupted: [0, 40s) = 40_000.
    expect(computeActiveTime(events).perTab.get(10)).toBe(40_000);
  });

  it('navigate and open events do not alter accrual state', () => {
    const events: TabEvent[] = [
      ev({ type: 'window_focus', ts: BASE, windowId: 1, windowFocused: true }),
      ev({ type: 'open', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'activate', ts: BASE, tabId: 10, windowId: 1 }),
      ev({ type: 'input_tick', ts: BASE }),
      ev({ type: 'navigate', ts: BASE + 10_000, tabId: 10, url: 'https://y.test' }),
      ev({ type: 'navigate', ts: BASE + 20_000, tabId: 10, url: 'https://z.test' }),
      ev({ type: 'deactivate', ts: BASE + 40_000, tabId: 10, windowId: 1 }),
    ];
    expect(computeActiveTime(events).perTab.get(10)).toBe(40_000);
  });
});
