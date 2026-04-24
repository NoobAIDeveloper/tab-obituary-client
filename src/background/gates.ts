import { openDb } from '../storage/db.js';
import { getBlocklistedDomains, getPrivacy } from '../storage/settings-store.js';

// Short TTL because privacy toggles and blocklist edits need to take effect
// quickly, but the SW shouldn't re-read the DB on every tab event.
const CACHE_TTL_MS = 5_000;

let cachedPausedAt = 0;
let cachedPaused = false;
let cachedBlocklistAt = 0;
let cachedBlocklist = new Set<string>();

async function isPaused(): Promise<boolean> {
  const now = Date.now();
  if (now - cachedPausedAt < CACHE_TTL_MS) return cachedPaused;
  try {
    const db = await openDb();
    const privacy = await getPrivacy(db);
    cachedPaused = privacy?.trackingPaused ?? false;
    cachedPausedAt = now;
  } catch {
    cachedPaused = false;
  }
  return cachedPaused;
}

async function isBlocklisted(domain: string | undefined): Promise<boolean> {
  if (!domain) return false;
  const now = Date.now();
  if (now - cachedBlocklistAt >= CACHE_TTL_MS) {
    try {
      const db = await openDb();
      cachedBlocklist = await getBlocklistedDomains(db);
      cachedBlocklistAt = now;
    } catch {
      cachedBlocklist = new Set();
    }
  }
  return cachedBlocklist.has(domain);
}

export async function shouldWriteEvent(domain?: string): Promise<boolean> {
  if (await isPaused()) return false;
  if (await isBlocklisted(domain)) return false;
  return true;
}

export function invalidateGateCaches(): void {
  cachedPausedAt = 0;
  cachedBlocklistAt = 0;
}
