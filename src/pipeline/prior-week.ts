/**
 * Project a stored `WeeklySummary` into the `PriorWeekSummary` wire shape.
 *
 * This lives in `pipeline/` because it's a payload-layer concern: the
 * backend consumes `priorWeekSummary` alongside everything else
 * `buildReportPayload` emits, so keeping the projection next to the
 * payload assembly makes the dependency graph obvious.
 *
 * Why `.parse` at the return boundary? It's cheap (a few arrays) and it
 * surfaces schema drift — e.g. a future `priorWeekSummarySchema` field
 * bump — at the call site here rather than as a backend 400.
 */
import type { PriorWeekSummary } from '@tabob/shared';
import { priorWeekSummarySchema } from '@tabob/shared';
import type { WeeklySummary } from '../storage/db.js';

export function toPriorWeekSummary(summary: WeeklySummary): PriorWeekSummary {
  const { sections } = summary;

  // Strip `exampleDomains` — the LLM prompt doesn't need per-theme exemplars
  // for continuity framing; the label + share alone anchors W-o-W reasoning.
  const themes = sections.themes.map((t) => ({
    label: t.label,
    share: t.share,
  }));

  // Drop `visits` and `line` — obsession continuity is time-based.
  const obsessions = sections.obsessions.map((o) => ({
    domain: o.domain,
    activeMs: o.activeMs,
  }));

  // Rabbit-hole labels are display strings (cloud: LLM subject fragments;
  // deterministic: "{N}-URL session on {topDomain}"). We pass them through
  // verbatim; they're hints for the LLM prompt, not semantic keys.
  const rabbitHoleLabels = sections.rabbitHoles.map((r) => r.label);

  return priorWeekSummarySchema.parse({
    weekStart: summary.weekStart,
    themes,
    obsessions,
    rabbitHoleLabels,
  });
}
