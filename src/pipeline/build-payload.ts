import type {
  PayloadCandidateSession,
  PayloadDomainTitle,
  PayloadGhostTab,
  PayloadObsession,
  PayloadTabAlive,
  PayloadUrl,
  Plan,
  PriorWeekSummary,
  RabbitHoleCandidate,
  ReportPayload,
  TabEvent,
} from '@tabob/shared';
import {
  LATE_NIGHT_END_HOUR,
  LATE_NIGHT_START_HOUR,
  SCHEMA_VERSION,
  TABS_STILL_ALIVE_MIN_AGE_DAYS,
} from '@tabob/shared';
import { canonicalDomain } from '../lib/url-normalize.js';
import { activeTimePerTab } from './active-time-reducer.js';
import { gatherDomainTitlePairs } from './domain-pairs.js';
import { computeGhostTabs } from './ghost-tabs.js';
import { computeObsessions } from './obsessions.js';
import { segmentSessions } from './stage1-segmentation.js';
import { filterCandidates } from './stage2-candidates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LATE_NIGHT_SAMPLE_STEP_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Public input contract for the top-level payload builder. All inputs are pure data —
 * no `chrome.*` access, no wall-clock reads inside this module.
 */
export interface BuildReportPayloadInput {
  /** Any TabEvents from the user's store; this function filters by week + blocklist. */
  events: TabEvent[];
  /** ISO date string, e.g. "2026-04-20". Stamped onto sessions; NOT used for bounds math. */
  weekStart: string;
  /** ISO date string, e.g. "2026-04-27". Stamped onto the payload's `week.end`. */
  weekEnd: string;
  /** Epoch ms — left bound, inclusive. */
  weekStartMs: number;
  /** Epoch ms — right bound, exclusive. */
  weekEndMs: number;
  /** UUIDv4 from user settings. */
  uuid: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Billing plan. */
  plan: Plan;
  /** Canonical domains to exclude. We lowercase + strip-www on match input too. */
  blocklist: Set<string>;
  /** True for onboarding preview; false for real weekly report. */
  preview: boolean;
  /** Epoch ms — used only for `ageDays` computation on `tabsStillAlive`. */
  now: number;
  /** Optional prior-week summary for continuity; spread conditionally. */
  priorWeekSummary?: PriorWeekSummary;
}

/**
 * Orchestrates chunks 4.1–4.4 and packs their outputs into the wire contract
 * (`ReportPayload`). Applies week-bound + blocklist filters once up-front so every
 * downstream helper sees the same filtered event stream.
 *
 * Returns an object that passes `reportPayloadSchema.parse`. Pure: no side effects,
 * no mutation of input events or blocklist.
 */
export function buildReportPayload(input: BuildReportPayloadInput): ReportPayload {
  const {
    events,
    weekStart,
    weekEnd,
    weekStartMs,
    weekEndMs,
    uuid,
    timezone,
    plan,
    blocklist,
    preview,
    now,
    priorWeekSummary,
  } = input;

  // TODO: richer tab-alive tracking for tabs opened before this week. Currently scopes
  // everything — including `tabsStillAlive` — to events within [weekStartMs, weekEndMs).
  const filteredEvents = filterEvents(events, weekStartMs, weekEndMs, blocklist);

  // ---- core pipeline
  const sessions = segmentSessions(filteredEvents, { weekStart });
  const candidates = filterCandidates(sessions);
  const obsessions: PayloadObsession[] = computeObsessions(filteredEvents);
  const ghostTabCandidates: PayloadGhostTab[] = computeGhostTabs(filteredEvents);
  const domainTitlePairs: PayloadDomainTitle[] = gatherDomainTitlePairs(filteredEvents);
  const tabsStillAlive = computeTabsStillAlive(filteredEvents, now);

  const candidateSessions = candidates.map((c) => candidateToPayload(c, timezone));

  // ---- totals
  const perTab = activeTimePerTab(filteredEvents);
  let totalActiveMs = 0;
  for (const ms of perTab.values()) totalActiveMs += ms;

  const base: Omit<ReportPayload, 'priorWeekSummary'> = {
    user: { uuid, timezone, plan, schemaVersion: SCHEMA_VERSION },
    week: { start: weekStart, end: weekEnd },
    preview,
    candidateSessions,
    obsessions,
    ghostTabCandidates,
    domainTitlePairs,
    tabsStillAlive,
    totals: { activeMs: totalActiveMs, events: filteredEvents.length },
  };

  // exactOptionalPropertyTypes: only attach the key when we actually have a summary.
  return priorWeekSummary !== undefined ? { ...base, priorWeekSummary } : base;
}

// ---------------------------------------------------------------------------
// Filtering

/**
 * Drop events outside `[weekStartMs, weekEndMs)` and events whose URL/domain resolves
 * to a blocklisted canonical domain. Events without a URL or domain (pure `input_tick`,
 * `idle_state`, `window_focus`) pass through — they carry no attributable content.
 */
function filterEvents(
  events: TabEvent[],
  weekStartMs: number,
  weekEndMs: number,
  blocklist: Set<string>,
): TabEvent[] {
  // Normalize the blocklist once so match uses the same canonical form as event URLs.
  const normBlock = normalizeBlocklist(blocklist);
  const out: TabEvent[] = [];
  for (const ev of events) {
    if (ev.ts < weekStartMs) continue;
    if (ev.ts >= weekEndMs) continue;

    // Prefer canonicalDomain(url) when we have a URL — matches how downstream
    // helpers bucket events. Fall back to ev.domain (stripped of leading www.).
    let domainForMatch: string | null = null;
    if (ev.url) {
      domainForMatch = canonicalDomain(ev.url);
    }
    if (domainForMatch === null && ev.domain) {
      domainForMatch = stripWww(ev.domain.toLowerCase());
    }

    if (domainForMatch !== null && normBlock.has(domainForMatch)) continue;
    out.push(ev);
  }
  return out;
}

function normalizeBlocklist(blocklist: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const entry of blocklist) {
    if (!entry) continue;
    out.add(stripWww(entry.toLowerCase()));
  }
  return out;
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

// ---------------------------------------------------------------------------
// Candidate -> PayloadCandidateSession

function candidateToPayload(
  candidate: RabbitHoleCandidate,
  timezone: string,
): PayloadCandidateSession {
  // Strip the `domain` field — PayloadUrl does not carry it.
  const urls: PayloadUrl[] = candidate.urls.map((u) => ({
    url: u.url,
    title: u.title,
    activeMs: u.activeMs,
    openTs: u.openTs,
  }));

  const topDomains = computeTopDomains(candidate.urls);

  return {
    id: candidate.id,
    start: new Date(candidate.startTs).toISOString(),
    end: new Date(candidate.endTs).toISOString(),
    activeMs: candidate.activeMs,
    urls,
    topDomains,
    lateNight: isLateNight(candidate.startTs, candidate.endTs, timezone),
  };
}

/**
 * Top 5 canonical domains by activeMs (desc), lex tie-break. Skips URLs whose canonical
 * domain is null. Returns just the domain strings.
 */
function computeTopDomains(sessionUrls: RabbitHoleCandidate['urls']): string[] {
  const totals = new Map<string, number>();
  for (const u of sessionUrls) {
    const canon = canonicalDomain(u.url);
    if (canon === null) continue;
    totals.set(canon, (totals.get(canon) ?? 0) + u.activeMs);
  }
  const rows = [...totals.entries()];
  rows.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return rows.slice(0, 5).map(([d]) => d);
}

// ---------------------------------------------------------------------------
// Late-night detection

/**
 * True if any sampled instant in `[startTs, endTs]` lands in the late-night window
 * `[LATE_NIGHT_START_HOUR, LATE_NIGHT_END_HOUR)` (local time in `timezone`). The
 * window wraps midnight — hours 21,22,23,0,1 qualify by default.
 *
 * Samples every 30 minutes plus the endpoints. Cheap enough for weekly workloads
 * (sessions cap at a handful of hours).
 */
function isLateNight(startTs: number, endTs: number, timezone: string): boolean {
  if (endTs < startTs) return false;

  if (hourInLateNight(localHour(startTs, timezone))) return true;
  if (hourInLateNight(localHour(endTs, timezone))) return true;

  for (let t = startTs + LATE_NIGHT_SAMPLE_STEP_MS; t < endTs; t += LATE_NIGHT_SAMPLE_STEP_MS) {
    if (hourInLateNight(localHour(t, timezone))) return true;
  }
  return false;
}

function hourInLateNight(hour: number): boolean {
  // Wrap-around window: [21..23] ∪ [0..1]. Configurable via shared constants.
  if (LATE_NIGHT_START_HOUR <= LATE_NIGHT_END_HOUR) {
    return hour >= LATE_NIGHT_START_HOUR && hour < LATE_NIGHT_END_HOUR;
  }
  return hour >= LATE_NIGHT_START_HOUR || hour < LATE_NIGHT_END_HOUR;
}

function localHour(ts: number, timezone: string): number {
  // `hour12: false` + `hour: '2-digit'` yields "00".."23" in the target zone.
  // Fall back to UTC hour if the zone is unrecognised (browsers throw RangeError).
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(ts));
    const hourPart = parts.find((p) => p.type === 'hour');
    if (!hourPart) return new Date(ts).getUTCHours();
    // Intl can return "24" at midnight on some engines (Chrome < 80-era); coerce.
    const n = Number.parseInt(hourPart.value, 10);
    if (!Number.isFinite(n)) return new Date(ts).getUTCHours();
    return n === 24 ? 0 : n;
  } catch {
    return new Date(ts).getUTCHours();
  }
}

// ---------------------------------------------------------------------------
// tabsStillAlive

interface AliveTabState {
  openTs: number; // earliest event ts for this tab within the window
  firstOpenTs: number | undefined; // ts of first `open` event; preferred over firstEventTs
  url: string | undefined; // last non-empty url from navigate/open
  title: string;
  closed: boolean;
}

/**
 * A tab is "alive" if we saw an `open` for it in the filtered stream and NEVER a
 * matching `close`. activate/deactivate don't count. Tabs without any URL-bearing
 * event are skipped (we can't represent them). Tabs opened before the week window
 * are invisible here — see TODO in `buildReportPayload`.
 */
function computeTabsStillAlive(events: TabEvent[], now: number): PayloadTabAlive[] {
  const byTab = new Map<number, AliveTabState>();
  // Walk in ts order so "first open" / "last URL" are deterministic.
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  for (const ev of sorted) {
    if (ev.tabId === undefined) continue;

    let state = byTab.get(ev.tabId);
    if (!state) {
      state = {
        openTs: ev.ts,
        firstOpenTs: undefined,
        url: undefined,
        title: '',
        closed: false,
      };
      byTab.set(ev.tabId, state);
    }
    // openTs tracks the earliest observed ts; `sorted` guarantees it's already set on init.

    if (ev.type === 'open') {
      if (state.firstOpenTs === undefined) state.firstOpenTs = ev.ts;
      if (ev.url) {
        state.url = ev.url;
        state.title = ev.title ?? state.title;
      }
    } else if (ev.type === 'navigate') {
      if (ev.url) {
        state.url = ev.url;
        state.title = ev.title ?? state.title;
      }
    } else if (ev.type === 'close') {
      state.closed = true;
    }
  }

  const out: PayloadTabAlive[] = [];
  for (const [, state] of byTab) {
    if (state.closed) continue;
    if (state.firstOpenTs === undefined) continue; // no `open` event — not "alive" by spec
    if (!state.url) continue; // can't represent without a URL

    const openTs = state.firstOpenTs;
    const ageDays = Math.floor((now - openTs) / DAY_MS);
    if (ageDays < TABS_STILL_ALIVE_MIN_AGE_DAYS) continue;

    out.push({
      url: state.url,
      title: state.title,
      openTs,
      ageDays,
    });
  }

  // Oldest first. Backend applies `MIN_TABS_STILL_ALIVE` render gate; no cap here.
  out.sort((a, b) => {
    if (a.openTs !== b.openTs) return a.openTs - b.openTs;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  return out;
}
