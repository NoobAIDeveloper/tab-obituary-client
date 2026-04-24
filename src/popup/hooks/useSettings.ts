import type { PrivacySettings, ScheduleSettings, UserSettings } from '@tabob/shared';
import { privacySettingsSchema, scheduleSettingsSchema, userSettingsSchema } from '@tabob/shared';
import type { IDBPDatabase } from 'idb';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TabObituaryDB } from '../../storage/db.js';
import { openDb } from '../../storage/db.js';
import {
  getPrivacy,
  getSchedule,
  getUser,
  setPrivacy,
  setSchedule,
  setUser,
} from '../../storage/settings-store.js';

export interface SettingsState {
  user: UserSettings | undefined;
  privacy: PrivacySettings | undefined;
  schedule: ScheduleSettings | undefined;
}

export interface SettingsApi extends SettingsState {
  loading: boolean;
  updateUser: (patch: Partial<UserSettings>) => Promise<void>;
  updatePrivacy: (patch: Partial<PrivacySettings>) => Promise<void>;
  updateSchedule: (patch: Partial<ScheduleSettings>) => Promise<void>;
}

function defaultUser(): UserSettings {
  return {
    uuid: crypto.randomUUID(),
    emailConfirmed: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    plan: 'free',
    createdAt: Date.now(),
  };
}

function defaultPrivacy(): PrivacySettings {
  return {
    trackingOptIn: false,
    cloudAiOptIn: false,
    trackingPaused: false,
    installedAt: Date.now(),
  };
}

function defaultSchedule(): ScheduleSettings {
  return { preReportSent: false };
}

export function useSettings(): SettingsApi {
  const dbRef = useRef<IDBPDatabase<TabObituaryDB> | null>(null);
  // Per-row write chain; every updateX(patch) appends to its key's chain so a
  // pending write completes before the next read-modify-write reads the row.
  // Without this, two rapid patches both read the same stale in-memory copy
  // and one of them wins (the read-modify-write race).
  const chainsRef = useRef<{
    user: Promise<void>;
    privacy: Promise<void>;
    schedule: Promise<void>;
  }>({ user: Promise.resolve(), privacy: Promise.resolve(), schedule: Promise.resolve() });

  const [state, setState] = useState<SettingsState & { loading: boolean }>({
    user: undefined,
    privacy: undefined,
    schedule: undefined,
    loading: true,
  });

  // In-memory mirror kept in a ref so the serialised chain can always read the
  // freshest value without waiting for React state to settle.
  const memRef = useRef<SettingsState>({
    user: undefined,
    privacy: undefined,
    schedule: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await openDb();
        if (cancelled) {
          db.close();
          return;
        }
        dbRef.current = db;
        const [user, privacy, schedule] = await Promise.all([
          getUser(db),
          getPrivacy(db),
          getSchedule(db),
        ]);
        if (cancelled) return;
        memRef.current = { user, privacy, schedule };
        setState({ user, privacy, schedule, loading: false });
      } catch (err) {
        // IDB failure on the read path should never surface: keep rows
        // undefined and let the UI fall through to sensible defaults.
        console.warn('useSettings: initial load failed', err);
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const api = useMemo<SettingsApi>(() => {
    async function ensureDb(): Promise<IDBPDatabase<TabObituaryDB>> {
      if (dbRef.current) return dbRef.current;
      const db = await openDb();
      dbRef.current = db;
      return db;
    }

    function enqueueUser(task: () => Promise<void>): Promise<void> {
      const next = chainsRef.current.user.catch(() => undefined).then(task);
      chainsRef.current.user = next;
      return next;
    }
    function enqueuePrivacy(task: () => Promise<void>): Promise<void> {
      const next = chainsRef.current.privacy.catch(() => undefined).then(task);
      chainsRef.current.privacy = next;
      return next;
    }
    function enqueueSchedule(task: () => Promise<void>): Promise<void> {
      const next = chainsRef.current.schedule.catch(() => undefined).then(task);
      chainsRef.current.schedule = next;
      return next;
    }

    const updateUser = (patch: Partial<UserSettings>): Promise<void> =>
      enqueueUser(async () => {
        const db = await ensureDb();
        const current = memRef.current.user ?? defaultUser();
        const merged: UserSettings = { ...current, ...patch };
        // Preserve the optional-field erasure contract: `email: undefined` in a
        // patch must not attach an `email` key when the schema treats it as
        // absent under exactOptionalPropertyTypes.
        const parsed = userSettingsSchema.parse(merged);
        await setUser(db, parsed);
        memRef.current = { ...memRef.current, user: parsed };
        setState((s) => ({ ...s, user: parsed }));
      });

    const updatePrivacy = (patch: Partial<PrivacySettings>): Promise<void> =>
      enqueuePrivacy(async () => {
        const db = await ensureDb();
        const current = memRef.current.privacy ?? defaultPrivacy();
        const merged: PrivacySettings = { ...current, ...patch };
        const parsed = privacySettingsSchema.parse(merged);
        await setPrivacy(db, parsed);
        memRef.current = { ...memRef.current, privacy: parsed };
        setState((s) => ({ ...s, privacy: parsed }));
      });

    const updateSchedule = (patch: Partial<ScheduleSettings>): Promise<void> =>
      enqueueSchedule(async () => {
        const db = await ensureDb();
        const current = memRef.current.schedule ?? defaultSchedule();
        const merged: ScheduleSettings = { ...current, ...patch };
        const parsed = scheduleSettingsSchema.parse(merged);
        await setSchedule(db, parsed);
        memRef.current = { ...memRef.current, schedule: parsed };
        setState((s) => ({ ...s, schedule: parsed }));
      });

    return {
      user: state.user,
      privacy: state.privacy,
      schedule: state.schedule,
      loading: state.loading,
      updateUser,
      updatePrivacy,
      updateSchedule,
    };
    // Rebuilding the API when state changes is fine — the updater closures
    // read from the live refs, not the snapshot.
  }, [state.user, state.privacy, state.schedule, state.loading]);

  return api;
}
