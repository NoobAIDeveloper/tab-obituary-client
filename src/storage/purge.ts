import type { ExportBundle } from '@tabob/shared';
import { SCHEMA_VERSION } from '@tabob/shared';
import type { IDBPDatabase } from 'idb';
import { invalidateGateCaches } from '../background/gates.js';
import { canonicalDomain, isValidBlocklistDomain } from '../lib/url-normalize.js';
import type { StoredBlocklistEntry, TabObituaryDB } from './db.js';
import { purgeEventsForDomain } from './events-store.js';
import { getAllOutboundRequests } from './outbound-requests-store.js';

// Settings are intentionally preserved by deleteAllData so the popup doesn't
// regress through onboarding after a "delete my browsing history" action.
// The nuclear path that also wipes settings lives in deleteEverythingIncludingSettings.
type StoreName =
  | 'events'
  | 'sessions'
  | 'weekly_summaries'
  | 'settings'
  | 'blocklist'
  | 'jobs'
  | 'outbound_requests';

const STORES_WITHOUT_SETTINGS = [
  'events',
  'sessions',
  'weekly_summaries',
  'blocklist',
  'jobs',
  'outbound_requests',
] as const satisfies readonly StoreName[];

const ALL_STORES = [
  'events',
  'sessions',
  'weekly_summaries',
  'settings',
  'blocklist',
  'jobs',
  'outbound_requests',
] as const satisfies readonly StoreName[];

async function clearStores(
  db: IDBPDatabase<TabObituaryDB>,
  stores: readonly StoreName[],
): Promise<void> {
  const tuple = [...stores] as [StoreName, ...StoreName[]];
  const tx = db.transaction(tuple, 'readwrite');
  for (const name of stores) {
    await tx.objectStore(name).clear();
  }
  await tx.done;
}

export async function deleteAllData(db: IDBPDatabase<TabObituaryDB>): Promise<void> {
  await clearStores(db, STORES_WITHOUT_SETTINGS);
  invalidateGateCaches();
}

export async function deleteEverythingIncludingSettings(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<void> {
  await clearStores(db, ALL_STORES);
  invalidateGateCaches();
}

export async function exportAllData(db: IDBPDatabase<TabObituaryDB>): Promise<ExportBundle> {
  const [events, sessions, weeklySummaries, blocklist, settingsRows, outboundRequests] =
    await Promise.all([
      db.getAll('events'),
      db.getAll('sessions'),
      db.getAll('weekly_summaries'),
      db.getAll('blocklist'),
      db.getAll('settings'),
      getAllOutboundRequests(db),
    ]);

  const settings: ExportBundle['settings'] = {};
  for (const row of settingsRows) {
    if (row.key === 'user') settings.user = row.value;
    else if (row.key === 'privacy') settings.privacy = row.value;
    else if (row.key === 'schedule') settings.schedule = row.value;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    events,
    sessions,
    weeklySummaries,
    settings,
    blocklist,
    outboundRequests,
  };
}

// Users routinely type "example.com" in the options page without a scheme,
// which tldts.getDomain can't parse on its own. Retry with an https:// prefix
// so a bare eTLD+1 string still canonicalises. The result still has to pass
// `isValidBlocklistDomain` — scheme-only inputs like `https://` produce junk
// (e.g. "https") that we reject at the call site.
function canonicalizeDomainInput(domainInput: string): string | null {
  const trimmed = domainInput.trim();
  if (trimmed.length === 0) return null;

  const direct = canonicalDomain(trimmed);
  if (direct) return direct;

  return canonicalDomain(`https://${trimmed}`);
}

export async function addBlocklistedDomain(
  db: IDBPDatabase<TabObituaryDB>,
  domainInput: string,
): Promise<{ domain: string; purgedEvents: number }> {
  if (domainInput.trim().length === 0) {
    throw new Error('Domain must not be empty');
  }
  const domain = canonicalizeDomainInput(domainInput);
  if (!isValidBlocklistDomain(domain)) {
    throw new Error('invalid domain');
  }

  // Idempotent: `put` upserts, preserving the original addedAt if we wanted
  // to, but the spec says adding the same domain twice should be a no-op on
  // insert. We read first and only insert when absent.
  const existing = await db.get('blocklist', domain);
  if (!existing) {
    const row: StoredBlocklistEntry = {
      domain,
      addedAt: Date.now(),
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    };
    await db.put('blocklist', row);
  }

  // `events.domain` is canonicalised at ingest by `canonicalDomain`, so the
  // `by_domain` index handles new writes. The second cursor pass is a
  // belt-and-braces sweep for pre-fix rows (or events written with only a
  // `url` field) whose stored domain is a subdomain or missing — catching
  // `m.example.com` / `www.example.com` when the user blocklists `example.com`.
  const indexPurged = await purgeEventsForDomain(db, domain);
  const fallbackPurged = await purgeEventsByCanonicalUrl(db, domain);
  invalidateGateCaches();
  return { domain, purgedEvents: indexPurged + fallbackPurged };
}

async function purgeEventsByCanonicalUrl(
  db: IDBPDatabase<TabObituaryDB>,
  canonical: string,
): Promise<number> {
  const tx = db.transaction('events', 'readwrite');
  let count = 0;
  for await (const cursor of tx.store.iterate()) {
    const ev = cursor.value;
    const fromUrl = ev.url ? canonicalDomain(ev.url) : null;
    const fromDomain = ev.domain ? (canonicalDomain(ev.domain) ?? ev.domain) : null;
    if (fromUrl === canonical || fromDomain === canonical) {
      await cursor.delete();
      count += 1;
    }
  }
  await tx.done;
  return count;
}

export async function removeBlocklistedDomain(
  db: IDBPDatabase<TabObituaryDB>,
  domain: string,
): Promise<void> {
  await db.delete('blocklist', domain);
  invalidateGateCaches();
}

export async function listBlocklistedDomains(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<StoredBlocklistEntry[]> {
  const all = await db.getAll('blocklist');
  // Newest first for display in the options UI.
  return all.sort((a, b) => b.addedAt - a.addedAt);
}
