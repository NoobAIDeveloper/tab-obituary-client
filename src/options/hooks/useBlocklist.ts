import type { IDBPDatabase } from 'idb';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { StoredBlocklistEntry, TabObituaryDB } from '../../storage/db.js';
import { openDb } from '../../storage/db.js';
import {
  addBlocklistedDomain,
  listBlocklistedDomains,
  removeBlocklistedDomain,
} from '../../storage/purge.js';

export interface BlocklistApi {
  loading: boolean;
  entries: StoredBlocklistEntry[];
  add: (domainInput: string) => Promise<{ domain: string; purgedEvents: number }>;
  remove: (domain: string) => Promise<void>;
}

export function useBlocklist(): BlocklistApi {
  const dbRef = useRef<IDBPDatabase<TabObituaryDB> | null>(null);
  // Per-hook write chain so back-to-back add()/remove() calls don't race on
  // the underlying IDB cursor; listBlocklistedDomains always reads the
  // freshest state after each mutation.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<StoredBlocklistEntry[]>([]);

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
        const list = await listBlocklistedDomains(db);
        if (cancelled) return;
        setEntries(list);
        setLoading(false);
      } catch (err) {
        console.warn('useBlocklist: initial load failed', err);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const api = useMemo<BlocklistApi>(() => {
    async function ensureDb(): Promise<IDBPDatabase<TabObituaryDB>> {
      if (dbRef.current) return dbRef.current;
      const db = await openDb();
      dbRef.current = db;
      return db;
    }

    function enqueue<T>(task: () => Promise<T>): Promise<T> {
      // Prior chain errors must not poison future work (same pattern as useSettings).
      const guarded = chainRef.current.catch(() => undefined).then(task);
      chainRef.current = guarded.then(
        () => undefined,
        () => undefined,
      );
      return guarded;
    }

    const add = (domainInput: string): Promise<{ domain: string; purgedEvents: number }> =>
      enqueue(async () => {
        const db = await ensureDb();
        const result = await addBlocklistedDomain(db, domainInput);
        const list = await listBlocklistedDomains(db);
        setEntries(list);
        return result;
      });

    const remove = (domain: string): Promise<void> =>
      enqueue(async () => {
        const db = await ensureDb();
        await removeBlocklistedDomain(db, domain);
        const list = await listBlocklistedDomains(db);
        setEntries(list);
      });

    return { loading, entries, add, remove };
  }, [loading, entries]);

  return api;
}
