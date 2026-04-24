import 'fake-indexeddb/auto';
import type { PrivacySettings, ScheduleSettings, UserSettings } from '@tabob/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_NAME, openDb } from './db.js';
import {
  getPrivacy,
  getSchedule,
  getUser,
  setPrivacy,
  setSchedule,
  setUser,
} from './settings-store.js';

async function wipe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await wipe();
});

describe('settings-store', () => {
  it('round-trips user settings', async () => {
    const db = await openDb();
    expect(await getUser(db)).toBeUndefined();
    const user: UserSettings = {
      uuid: '11111111-1111-4111-8111-111111111111',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    };
    await setUser(db, user);
    expect(await getUser(db)).toEqual(user);
    db.close();
  });

  it('round-trips privacy settings', async () => {
    const db = await openDb();
    const privacy: PrivacySettings = {
      trackingOptIn: true,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 1_700_000_000_000,
    };
    await setPrivacy(db, privacy);
    const loaded = await getPrivacy(db);
    expect(loaded).toEqual(privacy);
    db.close();
  });

  it('round-trips schedule settings and updates on subsequent set', async () => {
    const db = await openDb();
    const schedule: ScheduleSettings = { preReportSent: false };
    await setSchedule(db, schedule);
    expect(await getSchedule(db)).toEqual(schedule);
    const updated: ScheduleSettings = {
      preReportSent: true,
      lastReportAt: 1_700_000_000_000,
    };
    await setSchedule(db, updated);
    expect(await getSchedule(db)).toEqual(updated);
    db.close();
  });
});
