import type { TabEvent } from '@tabob/shared';
import { INPUT_ATTENTION_WINDOW_MS } from '@tabob/shared';

export interface ActiveInterval {
  start: number;
  end: number;
  tabId: number;
}

interface ReducerState {
  activeTabByWindow: Map<number, number>;
  focusedWindow: number | null;
  idle: boolean;
  lastInputTs: number | null;
}

// chrome.windows.WINDOW_ID_NONE — hardcoded to avoid pulling chrome.* types into a pure module.
const WINDOW_ID_NONE = -1;

/**
 * Walk the event stream and emit the active-time intervals (a tab was focused, not idle, and
 * within the attention window after an input_tick). Intervals are half-open [start, end)
 * with zero-duration segments dropped.
 *
 * The resulting intervals are sorted ascending by start (and end, since they never overlap).
 * This is the single source of truth for active-time math; `computeActiveTime` /
 * `activeTimePerTab` derive totals from it, and the session segmenter uses the raw intervals.
 */
export function computeActiveIntervals(events: TabEvent[]): ActiveInterval[] {
  const intervals: ActiveInterval[] = [];
  if (events.length === 0) return intervals;

  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  const state: ReducerState = {
    activeTabByWindow: new Map(),
    focusedWindow: null,
    idle: false,
    lastInputTs: null,
  };

  let segmentStart: number | null = null;
  let segmentTabId: number | null = null;

  const currentAccruingTab = (): number | null => {
    if (state.focusedWindow === null) return null;
    if (state.idle) return null;
    if (state.lastInputTs === null) return null;
    const tabId = state.activeTabByWindow.get(state.focusedWindow);
    return tabId ?? null;
  };

  const attentionExpiresAt = (): number | null =>
    state.lastInputTs === null ? null : state.lastInputTs + INPUT_ATTENTION_WINDOW_MS;

  const closeSegment = (endTs: number): void => {
    if (segmentStart === null || segmentTabId === null) return;
    if (endTs > segmentStart) {
      intervals.push({ start: segmentStart, end: endTs, tabId: segmentTabId });
    }
    segmentStart = null;
    segmentTabId = null;
  };

  const resync = (ts: number): void => {
    const newTab = currentAccruingTab();
    if (segmentStart !== null && segmentTabId !== null) {
      if (newTab === segmentTabId) return;
      closeSegment(ts);
    }
    if (newTab !== null) {
      segmentStart = ts;
      segmentTabId = newTab;
    }
  };

  const processAttentionExpiry = (untilTs: number): void => {
    const expiry = attentionExpiresAt();
    if (expiry === null) return;
    if (expiry >= untilTs) return;
    closeSegment(expiry);
  };

  for (const ev of sorted) {
    processAttentionExpiry(ev.ts);

    switch (ev.type) {
      case 'activate': {
        if (ev.tabId === undefined || ev.windowId === undefined) break;
        state.activeTabByWindow.set(ev.windowId, ev.tabId);
        resync(ev.ts);
        break;
      }
      case 'deactivate': {
        if (ev.windowId === undefined) break;
        const current = state.activeTabByWindow.get(ev.windowId);
        if (ev.tabId === undefined || current === ev.tabId) {
          state.activeTabByWindow.delete(ev.windowId);
        }
        resync(ev.ts);
        break;
      }
      case 'close': {
        if (ev.tabId === undefined) break;
        for (const [windowId, tabId] of state.activeTabByWindow) {
          if (tabId === ev.tabId) state.activeTabByWindow.delete(windowId);
        }
        resync(ev.ts);
        break;
      }
      case 'window_focus': {
        if (ev.windowId === undefined) break;
        if (ev.windowId === WINDOW_ID_NONE) {
          state.focusedWindow = null;
        } else if (ev.windowFocused === false) {
          if (state.focusedWindow === ev.windowId) state.focusedWindow = null;
        } else {
          state.focusedWindow = ev.windowId;
        }
        resync(ev.ts);
        break;
      }
      case 'idle_state': {
        if (ev.idleState === undefined) break;
        state.idle = ev.idleState !== 'active';
        resync(ev.ts);
        break;
      }
      case 'input_tick': {
        const wasAttentive =
          state.lastInputTs !== null && state.lastInputTs + INPUT_ATTENTION_WINDOW_MS > ev.ts;
        state.lastInputTs = ev.ts;
        if (!wasAttentive) resync(ev.ts);
        break;
      }
      case 'open':
      case 'navigate':
        break;
    }
  }

  // Close the tail segment at min(attention expiry, last event ts).
  if (segmentStart !== null && segmentTabId !== null) {
    const expiry = attentionExpiresAt();
    const lastTs = sorted[sorted.length - 1]!.ts;
    const endTs = expiry !== null && expiry < lastTs ? expiry : lastTs;
    closeSegment(endTs);
  }

  return intervals;
}
