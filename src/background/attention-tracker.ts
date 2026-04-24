import type { IdleState, TabEvent } from '@tabob/shared';
import { INPUT_ATTENTION_WINDOW_MS } from '@tabob/shared';
import { parseExtensionMessage } from '../lib/messages.js';
import { canonicalDomain } from '../lib/url-normalize.js';
import { openDb } from '../storage/db.js';
import { type AppendableEvent, appendEvent } from '../storage/events-store.js';
import { shouldWriteEvent } from './gates.js';

function extractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const d = canonicalDomain(url);
  return d ?? undefined;
}

function baseEvent(type: TabEvent['type']): Pick<AppendableEvent, 'type' | 'ts' | 'tzOffsetMin'> {
  return { type, ts: Date.now(), tzOffsetMin: new Date().getTimezoneOffset() };
}

async function writeIfAllowed(event: AppendableEvent): Promise<void> {
  if (!(await shouldWriteEvent(event.domain))) return;
  const db = await openDb();
  await appendEvent(db, event);
}

function onRuntimeMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (res?: unknown) => void,
): boolean {
  const msg = parseExtensionMessage(raw);
  if (!msg) return false;
  if (msg.type === 'input_tick') {
    const tab = sender.tab;
    const url = tab?.url;
    const domain = extractDomain(url);
    const event: AppendableEvent = {
      ...baseEvent('input_tick'),
      ts: msg.ts,
      ...(typeof tab?.id === 'number' ? { tabId: tab.id } : {}),
      ...(typeof tab?.windowId === 'number' ? { windowId: tab.windowId } : {}),
      ...(url ? { url } : {}),
      ...(domain ? { domain } : {}),
    };
    void writeIfAllowed(event);
  }
  // We don't send a response; return false so Chrome doesn't keep the channel open.
  sendResponse();
  return false;
}

function onIdleStateChanged(newState: `${chrome.idle.IdleState}`): void {
  // chrome.idle's enum literals ('active' | 'idle' | 'locked') match our IdleState exactly.
  const idleState = newState as IdleState;
  void writeIfAllowed({ ...baseEvent('idle_state'), idleState });
}

let detectionIntervalSet = false;
function ensureDetectionInterval(): void {
  if (detectionIntervalSet) return;
  detectionIntervalSet = true;
  // Align the OS-level idle threshold with our attention window so an
  // `idle_state` transition roughly coincides with the tail of inactivity
  // that input_tick windows already capture.
  const seconds = Math.max(15, Math.floor(INPUT_ATTENTION_WINDOW_MS / 1000));
  try {
    chrome.idle.setDetectionInterval(seconds);
  } catch {
    // noop — API can throw if called in a context without the permission during tests
  }
}

export function registerAttentionTracker(): void {
  ensureDetectionInterval();
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.idle.onStateChanged.addListener(onIdleStateChanged);
  console.log('[tab-obituary] attention-tracker registered');
}
