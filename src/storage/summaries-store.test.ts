import 'fake-indexeddb/auto';
import { SCHEMA_VERSION, type ReportSections } from '@tabob/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_NAME, openDb, type WeeklySummary } from './db.js';
import {
  getAllWeeklySummaries,
  getLatestWeeklySummary,
  getWeeklySummary,
  putWeeklySummary,
} from './summaries-store.js';

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

function makeSections(overrides: Partial<ReportSections> = {}): ReportSections {
  return {
    subject: 'Your week',
    preheader: 'Here it is',
    rabbitHoles: [],
    themes: [],
    obsessions: [],
    ghostTabs: [],
    wow: [],
    tabsStillAlive: [],
    generatedWith: 'deterministic',
    ...overrides,
  };
}

function makeSummary(weekStart: string, overrides: Partial<WeeklySummary> = {}): WeeklySummary {
  return {
    weekStart,
    sections: makeSections(),
    generatedAt: 1_000,
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

describe('summaries-store — putWeeklySummary / getWeeklySummary', () => {
  it('put → get round-trips the exact record', async () => {
    const db = await openDb();
    const summary = makeSummary('2026-04-20');
    await putWeeklySummary(db, summary);
    const back = await getWeeklySummary(db, '2026-04-20');
    expect(back).toBeDefined();
    expect(back).toEqual(summary);
    db.close();
  });

  it('get returns undefined for a missing weekStart', async () => {
    const db = await openDb();
    const back = await getWeeklySummary(db, '2026-04-20');
    expect(back).toBeUndefined();
    db.close();
  });

  it('put on an existing weekStart overwrites in place', async () => {
    const db = await openDb();
    const first = makeSummary('2026-04-20', { generatedAt: 1 });
    await putWeeklySummary(db, first);
    const second = makeSummary('2026-04-20', { generatedAt: 2 });
    await putWeeklySummary(db, second);
    const back = await getWeeklySummary(db, '2026-04-20');
    expect(back?.generatedAt).toBe(2);
    // Still a single row for that key.
    const all = await getAllWeeklySummaries(db);
    expect(all).toHaveLength(1);
    db.close();
  });

  it('round-trip preserves nested sections fields', async () => {
    const db = await openDb();
    const sections = makeSections({
      subject: 'Subj',
      preheader: 'Pre',
      rabbitHoles: [
        {
          sessionId: 'rh-1',
          label: 'Late-night keto',
          paragraph: 'You fell down a hole.',
          quotableDetail: 'Fourteen tabs.',
          startLocal: 'Wed 5:00am',
          endLocal: 'Wed 6:00am',
          activeMs: 60_000,
          tabCount: 3,
        },
      ],
      generatedWith: 'cloud',
    });
    await putWeeklySummary(db, makeSummary('2026-04-20', { sections }));
    const back = await getWeeklySummary(db, '2026-04-20');
    expect(back?.sections.generatedWith).toBe('cloud');
    expect(back?.sections.rabbitHoles).toHaveLength(1);
    expect(back?.sections.rabbitHoles[0]?.sessionId).toBe('rh-1');
    db.close();
  });
});

describe('summaries-store — getAllWeeklySummaries', () => {
  it('returns empty array on an empty store', async () => {
    const db = await openDb();
    expect(await getAllWeeklySummaries(db)).toEqual([]);
    db.close();
  });

  it('returns every row (no implicit filter/limit)', async () => {
    const db = await openDb();
    const weeks = ['2026-01-05', '2026-02-09', '2026-04-20'];
    for (const w of weeks) await putWeeklySummary(db, makeSummary(w));
    const all = await getAllWeeklySummaries(db);
    expect(all.map((r) => r.weekStart).sort()).toEqual([...weeks].sort());
    db.close();
  });

  it('is deterministic across calls', async () => {
    const db = await openDb();
    await putWeeklySummary(db, makeSummary('2026-04-06'));
    await putWeeklySummary(db, makeSummary('2026-04-13'));
    const a = await getAllWeeklySummaries(db);
    const b = await getAllWeeklySummaries(db);
    expect(a.map((r) => r.weekStart)).toEqual(b.map((r) => r.weekStart));
    db.close();
  });
});

describe('summaries-store — getLatestWeeklySummary', () => {
  it('returns undefined when the store is empty', async () => {
    const db = await openDb();
    expect(await getLatestWeeklySummary(db)).toBeUndefined();
    db.close();
  });

  it('returns the single row when exactly one exists', async () => {
    const db = await openDb();
    await putWeeklySummary(db, makeSummary('2026-04-20'));
    const latest = await getLatestWeeklySummary(db);
    expect(latest?.weekStart).toBe('2026-04-20');
    db.close();
  });

  it('returns the most-recent weekStart (ISO lex sort = chronological)', async () => {
    const db = await openDb();
    // Intentionally out-of-order inserts.
    await putWeeklySummary(db, makeSummary('2026-04-06'));
    await putWeeklySummary(db, makeSummary('2026-04-20'));
    await putWeeklySummary(db, makeSummary('2026-04-13'));
    const latest = await getLatestWeeklySummary(db);
    expect(latest?.weekStart).toBe('2026-04-20');
    db.close();
  });

  it('handles cross-year boundaries via lex sort', async () => {
    const db = await openDb();
    await putWeeklySummary(db, makeSummary('2025-12-29'));
    await putWeeklySummary(db, makeSummary('2026-01-05'));
    const latest = await getLatestWeeklySummary(db);
    expect(latest?.weekStart).toBe('2026-01-05');
    db.close();
  });

  it('picks the later of two identical prefixes', async () => {
    const db = await openDb();
    await putWeeklySummary(db, makeSummary('2026-04-06'));
    await putWeeklySummary(db, makeSummary('2026-04-07'));
    const latest = await getLatestWeeklySummary(db);
    expect(latest?.weekStart).toBe('2026-04-07');
    db.close();
  });
});
