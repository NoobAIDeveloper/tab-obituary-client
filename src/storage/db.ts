import type {
  BlocklistEntry,
  PrivacySettings,
  ReportSections,
  ScheduleSettings,
  Session,
  TabEvent,
  UserSettings,
} from '@tabob/shared';
import type { SCHEMA_VERSION } from '@tabob/shared';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

export const DB_NAME = 'tab-obituary';
// v2 adds the `outbound_requests` store. Per-row `schemaVersion`
// is distinct from this IDB migration version — DB_VERSION governs schema
// shape (stores/indexes), SCHEMA_VERSION governs row-level data invariants.
export const DB_VERSION = 2;

export type SettingsKey = 'user' | 'privacy' | 'schedule';
export type SettingsValueByKey = {
  user: UserSettings;
  privacy: PrivacySettings;
  schedule: ScheduleSettings;
};

export type SettingsRow = {
  [K in SettingsKey]: {
    key: K;
    value: SettingsValueByKey[K];
    schemaVersion: typeof SCHEMA_VERSION;
  };
}[SettingsKey];

export type WeeklySummary = {
  weekStart: string;
  sections: ReportSections;
  generatedAt: number;
  schemaVersion: typeof SCHEMA_VERSION;
};

export type Job = {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  payload?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: typeof SCHEMA_VERSION;
};

export type StoredBlocklistEntry = BlocklistEntry & {
  schemaVersion: typeof SCHEMA_VERSION;
};

export type OutboundRequestRecord = {
  id?: number;
  ts: number;
  method: 'GET' | 'POST';
  path: string;
  status: number;
  durationMs?: number;
  errorCode?: string;
  requestBodyHash: string | null;
  authenticated: boolean;
  schemaVersion: typeof SCHEMA_VERSION;
};

export interface TabObituaryDB extends DBSchema {
  events: {
    key: number;
    value: TabEvent & { id: number };
    indexes: {
      by_ts: number;
      by_tab: number;
      by_type_ts: [TabEvent['type'], number];
      by_domain: string;
    };
  };
  sessions: {
    key: string;
    value: Session;
    indexes: {
      by_week_start: string;
    };
  };
  weekly_summaries: {
    key: string;
    value: WeeklySummary;
  };
  settings: {
    key: SettingsKey;
    value: SettingsRow;
  };
  blocklist: {
    key: string;
    value: StoredBlocklistEntry;
  };
  jobs: {
    key: string;
    value: Job;
    indexes: {
      by_status: Job['status'];
    };
  };
  outbound_requests: {
    key: number;
    value: OutboundRequestRecord & { id: number };
    indexes: {
      by_ts: number;
      by_path: string;
      by_status: number;
    };
  };
}

export function openDb(): Promise<IDBPDatabase<TabObituaryDB>> {
  return openDB<TabObituaryDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Switch on oldVersion so future v3/v4 branches slot in without rewriting.
      if (oldVersion < 1) {
        const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        events.createIndex('by_ts', 'ts');
        events.createIndex('by_tab', 'tabId');
        events.createIndex('by_type_ts', ['type', 'ts']);
        events.createIndex('by_domain', 'domain');

        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by_week_start', 'weekStart');

        db.createObjectStore('weekly_summaries', { keyPath: 'weekStart' });
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('blocklist', { keyPath: 'domain' });

        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('by_status', 'status');
      }

      if (oldVersion < 2) {
        const outbound = db.createObjectStore('outbound_requests', {
          keyPath: 'id',
          autoIncrement: true,
        });
        outbound.createIndex('by_ts', 'ts');
        outbound.createIndex('by_path', 'path');
        outbound.createIndex('by_status', 'status');
      }
    },
  });
}
