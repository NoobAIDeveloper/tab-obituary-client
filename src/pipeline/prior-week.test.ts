/**
 * Tests for `toPriorWeekSummary` — the projector from a stored `WeeklySummary`
 * (rich `ReportSections` shape) into the compact wire `PriorWeekSummary`.
 *
 * Contract highlights this file locks in:
 *   - Drops `exampleDomains` from themes.
 *   - Drops `visits` and `line` from obsessions.
 *   - Collapses rabbit-hole narratives to their `label` strings.
 *   - Empty arrays remain empty arrays (never undefined).
 *   - Pure: does not mutate the input `WeeklySummary`.
 *   - Runs `priorWeekSummarySchema.parse` at the return boundary, so a
 *     malformed source surfaces here rather than as a backend 400.
 */
import type { ReportSections } from '@tabob/shared';
import { SCHEMA_VERSION, priorWeekSummarySchema } from '@tabob/shared';
import { describe, expect, it } from 'vitest';
import type { WeeklySummary } from '../storage/db.js';
import { toPriorWeekSummary } from './prior-week.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSections(overrides: Partial<ReportSections> = {}): ReportSections {
  return {
    subject: 'Your week in tabs.',
    preheader: 'Heavy on ML reading.',
    rabbitHoles: [],
    themes: [],
    obsessions: [],
    ghostTabs: [],
    wow: [],
    tabsStillAlive: [],
    generatedWith: 'cloud',
    ...overrides,
  };
}

function makeSummary(overrides: Partial<WeeklySummary> = {}): WeeklySummary {
  return {
    weekStart: '2026-04-09',
    generatedAt: Date.UTC(2026, 3, 16, 12, 0, 0),
    schemaVersion: SCHEMA_VERSION,
    sections: makeSections(),
    ...overrides,
  };
}

// A realistic mix: one cloud-labelled rabbit hole (LLM subject fragment) and
// one deterministic-labelled one ("{N}-URL session on {topDomain}").
function richSections(): ReportSections {
  return makeSections({
    themes: [
      { label: 'machine learning', share: 0.42, exampleDomains: ['arxiv.org', 'huggingface.co'] },
      { label: 'typescript tooling', share: 0.23, exampleDomains: ['github.com', 'npmjs.com'] },
      { label: 'home office', share: 0.1, exampleDomains: ['ikea.com'] },
    ],
    obsessions: [
      { domain: 'github.com', activeMs: 3_600_000, visits: 42, line: 'You visited github.com 42 times.' },
      { domain: 'news.ycombinator.com', activeMs: 900_000, visits: 18, line: 'HN, as usual.' },
    ],
    rabbitHoles: [
      {
        sessionId: 's1',
        label: 'rust async runtimes',
        paragraph: 'A long paragraph about tokio vs async-std.',
        quotableDetail: 'tokio ships 3x more releases than async-std',
        startLocal: '2026-04-10T09:00',
        endLocal: '2026-04-10T11:00',
        activeMs: 7_200_000,
        tabCount: 14,
      },
      {
        sessionId: 's2',
        label: '12-URL session on stackoverflow.com',
        paragraph: 'Deterministic-branch fallback paragraph.',
        quotableDetail: 'Twelve unique URLs, one domain.',
        startLocal: '2026-04-11T14:00',
        endLocal: '2026-04-11T15:30',
        activeMs: 5_400_000,
        tabCount: 12,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('toPriorWeekSummary — happy path', () => {
  it('projects a rich WeeklySummary into the exact PriorWeekSummary shape', () => {
    const summary = makeSummary({ weekStart: '2026-04-09', sections: richSections() });
    const out = toPriorWeekSummary(summary);

    expect(out).toEqual({
      weekStart: '2026-04-09',
      themes: [
        { label: 'machine learning', share: 0.42 },
        { label: 'typescript tooling', share: 0.23 },
        { label: 'home office', share: 0.1 },
      ],
      obsessions: [
        { domain: 'github.com', activeMs: 3_600_000 },
        { domain: 'news.ycombinator.com', activeMs: 900_000 },
      ],
      rabbitHoleLabels: ['rust async runtimes', '12-URL session on stackoverflow.com'],
    });
  });

  it('passes priorWeekSummarySchema validation on the returned value', () => {
    const summary = makeSummary({ weekStart: '2026-04-09', sections: richSections() });
    const out = toPriorWeekSummary(summary);
    // If .parse at return boundary didn't run, this is still our double-check.
    expect(() => priorWeekSummarySchema.parse(out)).not.toThrow();
  });

  it('weekStart is passed through verbatim', () => {
    const summary = makeSummary({ weekStart: '2025-12-29' });
    expect(toPriorWeekSummary(summary).weekStart).toBe('2025-12-29');
  });
});

// ---------------------------------------------------------------------------
// Shape stripping — the whole point of the projector.
// ---------------------------------------------------------------------------

describe('toPriorWeekSummary — strips fields that the backend doesn’t need', () => {
  it('strips `exampleDomains` from themes even when populated', () => {
    const summary = makeSummary({
      sections: makeSections({
        themes: [
          { label: 'a', share: 0.5, exampleDomains: ['one.com', 'two.com', 'three.com'] },
          { label: 'b', share: 0.25, exampleDomains: ['four.com'] },
        ],
      }),
    });

    const out = toPriorWeekSummary(summary);
    for (const theme of out.themes) {
      expect(Object.keys(theme).sort()).toEqual(['label', 'share']);
    }
  });

  it('strips `visits` and `line` from obsessions — leaves exactly {domain, activeMs}', () => {
    const summary = makeSummary({
      sections: makeSections({
        obsessions: [
          { domain: 'x.com', activeMs: 111, visits: 9, line: 'whatever' },
          { domain: 'y.com', activeMs: 222, visits: 1, line: 'short' },
        ],
      }),
    });

    const out = toPriorWeekSummary(summary);
    for (const obs of out.obsessions) {
      expect(Object.keys(obs).sort()).toEqual(['activeMs', 'domain']);
    }
  });

  it('collapses rabbitHoles → labels, dropping every other narrative field', () => {
    const summary = makeSummary({
      sections: makeSections({
        rabbitHoles: [
          {
            sessionId: 's1',
            label: 'rabbit A',
            paragraph: 'P',
            quotableDetail: 'Q',
            startLocal: 'SL',
            endLocal: 'EL',
            activeMs: 1,
            tabCount: 2,
          },
        ],
      }),
    });
    const out = toPriorWeekSummary(summary);
    expect(out.rabbitHoleLabels).toEqual(['rabbit A']);
  });

  it('preserves rabbit-hole insertion order in the output labels', () => {
    const summary = makeSummary({
      sections: makeSections({
        rabbitHoles: [
          { sessionId: 's1', label: 'first', paragraph: 'p', quotableDetail: 'q', startLocal: 'a', endLocal: 'b', activeMs: 1, tabCount: 1 },
          { sessionId: 's2', label: 'second', paragraph: 'p', quotableDetail: 'q', startLocal: 'a', endLocal: 'b', activeMs: 1, tabCount: 1 },
          { sessionId: 's3', label: 'third', paragraph: 'p', quotableDetail: 'q', startLocal: 'a', endLocal: 'b', activeMs: 1, tabCount: 1 },
        ],
      }),
    });
    expect(toPriorWeekSummary(summary).rabbitHoleLabels).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('toPriorWeekSummary — edge cases', () => {
  it('empty sections → empty arrays (never undefined)', () => {
    const out = toPriorWeekSummary(makeSummary());
    expect(out.themes).toEqual([]);
    expect(out.obsessions).toEqual([]);
    expect(out.rabbitHoleLabels).toEqual([]);
    expect(Array.isArray(out.themes)).toBe(true);
    expect(Array.isArray(out.obsessions)).toBe(true);
    expect(Array.isArray(out.rabbitHoleLabels)).toBe(true);
  });

  it('preserves an empty-string rabbit-hole label (schema is z.string(), not .min(1))', () => {
    const summary = makeSummary({
      sections: makeSections({
        rabbitHoles: [
          { sessionId: 's1', label: '', paragraph: 'p', quotableDetail: 'q', startLocal: 'a', endLocal: 'b', activeMs: 1, tabCount: 1 },
          { sessionId: 's2', label: 'non-empty', paragraph: 'p', quotableDetail: 'q', startLocal: 'a', endLocal: 'b', activeMs: 1, tabCount: 1 },
        ],
      }),
    });
    const out = toPriorWeekSummary(summary);
    expect(out.rabbitHoleLabels).toEqual(['', 'non-empty']);
  });

  it('preserves the top-level generatedWith/subject/preheader off the input (they are not projected)', () => {
    // Smoke-check: no keys beyond the schema make it into the output.
    const summary = makeSummary({ sections: richSections() });
    const out = toPriorWeekSummary(summary);
    expect(Object.keys(out).sort()).toEqual([
      'obsessions',
      'rabbitHoleLabels',
      'themes',
      'weekStart',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Schema drift safety — .parse() at the boundary.
// ---------------------------------------------------------------------------

describe('toPriorWeekSummary — schema validation at the return boundary', () => {
  // Note: the wire `priorWeekSummarySchema` is intentionally looser than the
  // input `themeSchema` (no min/max on `share`, no min(1) on label, etc.) —
  // the projector's `.parse` only fences against *structural* drift (wrong
  // types, missing fields), not against value-range violations that the
  // source schema already caught. These tests lock in the actual fence.

  it('throws when weekStart is not a string', () => {
    const summary = makeSummary({
      weekStart: 12345 as unknown as string,
    });
    expect(() => toPriorWeekSummary(summary)).toThrow();
  });

  it('throws when a source theme has a non-number share', () => {
    const summary = makeSummary({
      sections: makeSections({
        themes: [
          {
            label: 'broken',
            share: 'nope' as unknown as number,
            exampleDomains: [],
          },
        ],
      }),
    });
    expect(() => toPriorWeekSummary(summary)).toThrow();
  });

  it('throws when a source obsession has a non-string domain', () => {
    const summary = makeSummary({
      sections: makeSections({
        obsessions: [
          {
            domain: 42 as unknown as string,
            activeMs: 1,
            visits: 1,
            line: 'x',
          },
        ],
      }),
    });
    expect(() => toPriorWeekSummary(summary)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('toPriorWeekSummary — purity', () => {
  it('does not mutate the input WeeklySummary', () => {
    const summary = makeSummary({ sections: richSections() });
    const snapshot = structuredClone(summary);
    toPriorWeekSummary(summary);
    expect(summary).toEqual(snapshot);
  });

  it('is idempotent-ish: two calls yield structurally-equal outputs', () => {
    const summary = makeSummary({ sections: richSections() });
    const a = toPriorWeekSummary(summary);
    const b = toPriorWeekSummary(summary);
    expect(a).toEqual(b);
  });

  it('does not return aliased arrays from the input (mutating output is safe)', () => {
    const summary = makeSummary({ sections: richSections() });
    const out = toPriorWeekSummary(summary);
    expect(out.themes).not.toBe(summary.sections.themes);
    expect(out.obsessions).not.toBe(summary.sections.obsessions);
    expect(out.rabbitHoleLabels).not.toBe(summary.sections.rabbitHoles);
  });
});
