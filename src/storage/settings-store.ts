import type { PrivacySettings, ScheduleSettings, UserSettings } from '@tabob/shared';
import { SCHEMA_VERSION } from '@tabob/shared';
import type { IDBPDatabase } from 'idb';
import type { SettingsKey, SettingsRow, SettingsValueByKey, TabObituaryDB } from './db.js';

async function getSetting<K extends SettingsKey>(
  db: IDBPDatabase<TabObituaryDB>,
  key: K,
): Promise<SettingsValueByKey[K] | undefined> {
  const row = await db.get('settings', key);
  if (!row) return undefined;
  return row.value as SettingsValueByKey[K];
}

async function setSetting<K extends SettingsKey>(
  db: IDBPDatabase<TabObituaryDB>,
  key: K,
  value: SettingsValueByKey[K],
): Promise<void> {
  const row = { key, value, schemaVersion: SCHEMA_VERSION } as SettingsRow;
  await db.put('settings', row);
}

export function getUser(db: IDBPDatabase<TabObituaryDB>): Promise<UserSettings | undefined> {
  return getSetting(db, 'user');
}

export function setUser(db: IDBPDatabase<TabObituaryDB>, value: UserSettings): Promise<void> {
  return setSetting(db, 'user', value);
}

export function getPrivacy(db: IDBPDatabase<TabObituaryDB>): Promise<PrivacySettings | undefined> {
  return getSetting(db, 'privacy');
}

export function setPrivacy(db: IDBPDatabase<TabObituaryDB>, value: PrivacySettings): Promise<void> {
  return setSetting(db, 'privacy', value);
}

export function getSchedule(
  db: IDBPDatabase<TabObituaryDB>,
): Promise<ScheduleSettings | undefined> {
  return getSetting(db, 'schedule');
}

export function setSchedule(
  db: IDBPDatabase<TabObituaryDB>,
  value: ScheduleSettings,
): Promise<void> {
  return setSetting(db, 'schedule', value);
}

export async function getBlocklistedDomains(db: IDBPDatabase<TabObituaryDB>): Promise<Set<string>> {
  const entries = await db.getAll('blocklist');
  return new Set(entries.map((e) => e.domain));
}
