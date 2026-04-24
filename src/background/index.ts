import { resumeDeleteCascadeIfPending } from '../storage/delete-cascade.js';
import { parseExtensionMessage } from '../lib/messages.js';
import {
  WEEKLY_ALARM_NAME,
  WEEKLY_ALARM_PERIOD_MINUTES,
  nextSunday9amLocal,
} from '../lib/schedule.js';
import { registerAttentionTracker } from './attention-tracker.js';
import { registerEventLogger } from './event-logger.js';
import { invalidateGateCaches } from './gates.js';
import { weeklyAlarmListener } from './weekly-report.js';

registerEventLogger();
registerAttentionTracker();

// The options page runs in its own frame and cannot share the service
// worker's in-memory gate caches. When it mutates privacy/blocklist it
// pings us with `gates:invalidate` so the SW re-reads on the next event.
// All inbound messages go through `parseExtensionMessage` so unknown shapes
// silently drop rather than throw from a raw cast.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const parsed = parseExtensionMessage(message);
  if (parsed?.type === 'gates:invalidate') {
    invalidateGateCaches();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function ensureWeeklyAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(WEEKLY_ALARM_NAME);
  if (existing) return;
  const when = nextSunday9amLocal();
  await chrome.alarms.create(WEEKLY_ALARM_NAME, {
    when,
    periodInMinutes: WEEKLY_ALARM_PERIOD_MINUTES,
  });
  console.log('[tab-obituary] weekly alarm scheduled for', new Date(when).toString());
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[tab-obituary] onInstalled:', details.reason);
  await ensureWeeklyAlarm();
  // Fire-and-forget — a pending cascade (extension updated mid-delete)
  // finishes quietly in the background; if the user is offline the UI
  // retry path will pick it up.
  resumeDeleteCascadeIfPending().catch((err) => {
    console.error('[tab-obituary] delete-cascade resume failed', err);
  });
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[tab-obituary] onStartup');
  await ensureWeeklyAlarm();
  resumeDeleteCascadeIfPending().catch((err) => {
    console.error('[tab-obituary] delete-cascade resume failed', err);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  weeklyAlarmListener(alarm);
});

console.log('[tab-obituary] service worker loaded');
