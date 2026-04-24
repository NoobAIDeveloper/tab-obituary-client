import 'fake-indexeddb/auto';
import type { PrivacySettings } from '@tabob/shared';
import { SCHEMA_VERSION } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import { openDb } from '../storage/db.js';
import { addBlocklistedDomain, deleteAllData, removeBlocklistedDomain } from '../storage/purge.js';
import { setPrivacy } from '../storage/settings-store.js';
import { invalidateGateCaches, shouldWriteEvent } from './gates.js';

// These tests run in the same IndexedDB instance (fake-indexeddb) because the
// gates module keeps its own internal DB connection. We drive all three
// assertions through a single test that manipulates state in sequence to
// avoid cross-test wipe interference with the held connection.

describe('shouldWriteEvent', () => {
  it('gates on pause, blocklist, and lets other traffic through', async () => {
    invalidateGateCaches();

    // 1) Nothing configured → allow.
    expect(await shouldWriteEvent('example.com')).toBe(true);

    // 2) Pause tracking → deny.
    const db = await openDb();
    const paused: PrivacySettings = {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: true,
      installedAt: 1_700_000_000_000,
    };
    await setPrivacy(db, paused);
    invalidateGateCaches();
    expect(await shouldWriteEvent('example.com')).toBe(false);

    // 3) Unpause, add a blocklisted domain → deny only that domain.
    await setPrivacy(db, { ...paused, trackingPaused: false });
    await db.put('blocklist', {
      domain: 'secret.example',
      addedAt: 1,
      scope: 'exclude_all',
      schemaVersion: SCHEMA_VERSION,
    });
    invalidateGateCaches();
    expect(await shouldWriteEvent('secret.example')).toBe(false);
    invalidateGateCaches();
    expect(await shouldWriteEvent('other.example')).toBe(true);

    db.close();
  });

  // Adversarial coverage for chunk 5.3: purge mutators must not bypass the
  // cache, so a stale cached "allow" decision would let blocked events slip
  // through. Each case explicitly does NOT call invalidateGateCaches() — it
  // relies on the mutator to do it.
  it('purge mutators (add/remove/deleteAllData) auto-invalidate the cache', async () => {
    // Reset caches to a clean slate up front; the earlier test left state.
    invalidateGateCaches();
    const db = await openDb();
    await db.clear('blocklist');
    // Pre-warm: nothing is blocked.
    expect(await shouldWriteEvent('auto-invalidate.example')).toBe(true);

    // add — WITHOUT a manual invalidate — must deny the next call.
    await addBlocklistedDomain(db, 'auto-invalidate.example');
    expect(await shouldWriteEvent('auto-invalidate.example')).toBe(false);

    // remove — WITHOUT a manual invalidate — must re-allow.
    await removeBlocklistedDomain(db, 'auto-invalidate.example');
    expect(await shouldWriteEvent('auto-invalidate.example')).toBe(true);

    // deleteAllData — WITHOUT a manual invalidate — must forget a prior block.
    await addBlocklistedDomain(db, 'auto-invalidate.example');
    expect(await shouldWriteEvent('auto-invalidate.example')).toBe(false);
    await deleteAllData(db);
    expect(await shouldWriteEvent('auto-invalidate.example')).toBe(true);

    db.close();
  });
});
