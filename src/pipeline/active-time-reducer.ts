import type { TabEvent } from '@tabob/shared';
import { computeActiveIntervals } from './active-intervals.js';

export interface ActiveTimeResult {
  perTab: Map<number, number>;
  totalActiveMs: number;
}

/**
 * Compute per-tab active time totals from an event stream.
 *
 * Implemented as a thin sum over `computeActiveIntervals` — see that module for the state
 * machine. This function's public contract (shape of `ActiveTimeResult`, behaviour on edge
 * cases) is fully covered by `active-time-reducer.test.ts` and MUST NOT change.
 */
export function computeActiveTime(events: TabEvent[]): ActiveTimeResult {
  const perTab = new Map<number, number>();
  const intervals = computeActiveIntervals(events);
  let totalActiveMs = 0;
  for (const { start, end, tabId } of intervals) {
    const delta = end - start;
    if (delta <= 0) continue;
    perTab.set(tabId, (perTab.get(tabId) ?? 0) + delta);
    totalActiveMs += delta;
  }
  return { perTab, totalActiveMs };
}

export function activeTimePerTab(events: TabEvent[]): Map<number, number> {
  return computeActiveTime(events).perTab;
}
