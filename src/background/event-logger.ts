import type { TabEvent } from '@tabob/shared';
import { canonicalDomain } from '../lib/url-normalize.js';
import { openDb } from '../storage/db.js';
import { type AppendableEvent, appendEvent } from '../storage/events-store.js';
import { invalidateGateCaches, shouldWriteEvent } from './gates.js';

const lastActiveByWindow = new Map<number, number>();

function extractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const d = canonicalDomain(url);
  return d ?? undefined;
}

function baseEvent(type: TabEvent['type']): Pick<AppendableEvent, 'type' | 'ts' | 'tzOffsetMin'> {
  return { type, ts: Date.now(), tzOffsetMin: new Date().getTimezoneOffset() };
}

async function write(event: AppendableEvent): Promise<void> {
  if (!(await shouldWriteEvent(event.domain))) return;
  const db = await openDb();
  await appendEvent(db, event);
}

function onTabCreated(tab: chrome.tabs.Tab): void {
  const event: AppendableEvent = {
    ...baseEvent('open'),
    ...(typeof tab.id === 'number' ? { tabId: tab.id } : {}),
    ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(extractDomain(tab.url) ? { domain: extractDomain(tab.url) as string } : {}),
  };
  void write(event);
}

function onTabRemoved(tabId: number, info: chrome.tabs.OnRemovedInfo): void {
  void write({ ...baseEvent('close'), tabId, windowId: info.windowId });
}

function onTabActivated(info: chrome.tabs.OnActivatedInfo): void {
  const prev = lastActiveByWindow.get(info.windowId);
  if (prev !== undefined && prev !== info.tabId) {
    void write({ ...baseEvent('deactivate'), tabId: prev, windowId: info.windowId });
  }
  lastActiveByWindow.set(info.windowId, info.tabId);
  void write({ ...baseEvent('activate'), tabId: info.tabId, windowId: info.windowId });
}

function onTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
): void {
  if (!changeInfo.url) return; // title-only updates are ignored on purpose
  const domain = extractDomain(changeInfo.url);
  void write({
    ...baseEvent('navigate'),
    tabId,
    ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
    url: changeInfo.url,
    ...(tab.title ? { title: tab.title } : {}),
    ...(domain ? { domain } : {}),
  });
}

function onWindowFocusChanged(windowId: number): void {
  const focused = windowId !== chrome.windows.WINDOW_ID_NONE;
  void write({ ...baseEvent('window_focus'), windowId, windowFocused: focused });
  if (!focused) {
    for (const [winId, tabId] of lastActiveByWindow) {
      void write({ ...baseEvent('deactivate'), tabId, windowId: winId });
    }
  }
}

export function registerEventLogger(): void {
  chrome.tabs.onCreated.addListener(onTabCreated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.windows.onFocusChanged.addListener(onWindowFocusChanged);

  chrome.storage.onChanged.addListener(() => {
    invalidateGateCaches();
  });

  console.log('[tab-obituary] event-logger registered');
}
