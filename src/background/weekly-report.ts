/**
 * Weekly-alarm handler — the service-worker entry point that turns a weekly
 * `chrome.alarms` fire into a full report: gather events → build payload →
 * POST /generate-report → cache sections for next week's W-o-W baseline.
 *
 * Why no retries? The alarm repeats with `periodInMinutes: ONE_WEEK_MINUTES`.
 * A transient backend failure during a weekly send isn't worth custom retry
 * machinery — Chrome's alarm will fire again next week. For genuinely fatal
 * conditions (no token, no email, unsubscribed), the user has to take action
 * in the extension UI anyway. The one belt-and-braces check we do keep is an
 * idempotency gate against the same alarm firing twice in one week.
 */
import { SCHEMA_VERSION } from '@tabob/shared';
import { generateReport } from '../backend/client.js';
import { getClientToken } from '../backend/token-store.js';
import { WEEKLY_ALARM_NAME } from '../lib/schedule.js';
import { buildReportPayload } from '../pipeline/build-payload.js';
import { toPriorWeekSummary } from '../pipeline/prior-week.js';
import { openDb } from '../storage/db.js';
import { getEventsInRange } from '../storage/events-store.js';
import {
  getBlocklistedDomains,
  getPrivacy,
  getUser,
} from '../storage/settings-store.js';
import {
  getLatestWeeklySummary,
  getWeeklySummary,
  putWeeklySummary,
} from '../storage/summaries-store.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isoDate(ms: number): string {
  // YYYY-MM-DD in UTC. Stable across the fleet; not localised (the report
  // surface uses the user's timezone only for session framing, not for
  // week-window bounds).
  return new Date(ms).toISOString().slice(0, 10);
}

export interface HandleWeeklyAlarmArgs {
  now?: number;
}

export async function handleWeeklyAlarm(args: HandleWeeklyAlarmArgs = {}): Promise<void> {
  const now = args.now ?? Date.now();
  const weekEndMs = now;
  const weekStartMs = now - WEEK_MS;
  const weekStart = isoDate(weekStartMs);
  const weekEnd = isoDate(weekEndMs);

  const token = await getClientToken();
  if (token === null || token.length === 0) {
    console.log('[tab-obituary] weekly-report: no client token; skipping');
    return;
  }

  // Scope the IDB handle so every exit path closes it. Leaking the handle
  // pins the database open against blocked deleteDatabase() calls (tests) and
  // prevents schema upgrades from running in the service worker (prod).
  const db = await openDb();
  try {
    const user = await getUser(db);
    if (!user || user.email === undefined || user.email.length === 0) {
      console.log('[tab-obituary] weekly-report: no user email; skipping');
      return;
    }
    if (user.emailConfirmed !== true) {
      console.log('[tab-obituary] weekly-report: email not confirmed; skipping');
      return;
    }

    // Idempotency: if we already wrote a summary for this week, the alarm is
    // firing a second time (e.g. Chrome wake-up catch-up after being closed).
    // Bail — we already sent for this week.
    const existing = await getWeeklySummary(db, weekStart);
    if (existing !== undefined) {
      console.log('[tab-obituary] weekly-report: summary already exists for', weekStart);
      return;
    }

    // Privacy read is load-bearing only for the uuid/timezone/plan lookup that
    // lives on `user`; privacy itself is server-side-enforced via cloudAiOptIn,
    // and the build-payload call doesn't take it. We still read it so missing
    // privacy surfaces as a visible log, not a silent field-undefined at the
    // pipeline boundary.
    const privacy = await getPrivacy(db);
    if (!privacy) {
      console.log('[tab-obituary] weekly-report: privacy settings missing; skipping');
      return;
    }

    const events = await getEventsInRange(db, weekStartMs, weekEndMs);
    const blocklist = await getBlocklistedDomains(db);

    // W-o-W continuity: project the most recent stored summary into the wire
    // shape. The duplicate-summary guard above already bailed if a row for
    // `weekStart` exists, so `latest.weekStart` is strictly older here — but
    // we still gate on inequality in case the guard is ever refactored.
    //
    // Defensive try/catch: the projector runs `priorWeekSummarySchema.parse`
    // at its return boundary, so a structurally-malformed stored summary
    // (e.g. cached under an older schemaVersion, on-disk corruption) would
    // otherwise kill the whole weekly send. Prior-week context is a
    // nice-to-have — never let it block the primary payload.
    const latest = await getLatestWeeklySummary(db);
    let priorWeekSummary: ReturnType<typeof toPriorWeekSummary> | undefined;
    if (latest !== undefined && latest.weekStart !== weekStart) {
      try {
        priorWeekSummary = toPriorWeekSummary(latest);
      } catch (err: unknown) {
        console.warn(
          '[tab-obituary] weekly-report: prior-week projection failed; sending without it',
          err,
        );
        priorWeekSummary = undefined;
      }
    }

    const payload = buildReportPayload({
      events,
      weekStart,
      weekEnd,
      weekStartMs,
      weekEndMs,
      uuid: user.uuid,
      timezone: user.timezone,
      plan: user.plan,
      blocklist,
      preview: false,
      now,
      // exactOptionalPropertyTypes: spread the key only when we have a value.
      ...(priorWeekSummary !== undefined ? { priorWeekSummary } : {}),
    });

    const result = await generateReport(payload, { authenticated: true });
    if (!result.ok) {
      if (result.error === 'rate_limited') {
        console.warn('[tab-obituary] weekly-report failed', result.error);
      } else {
        console.error('[tab-obituary] weekly-report failed', result.error);
      }
      return;
    }

    await putWeeklySummary(db, {
      weekStart,
      sections: result.data.sections,
      generatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    });
    console.log('[tab-obituary] weekly-report sent + cached for', weekStart);
  } finally {
    db.close();
  }
}

/**
 * Wrap `handleWeeklyAlarm` in a fires-and-forgets listener. Chrome's
 * `onAlarm` dispatches synchronously and does not await returned promises,
 * so we intentionally return void after kicking off the work. Any thrown
 * error is swallowed here — nothing should escape into the runtime.
 */
export function weeklyAlarmListener(alarm: chrome.alarms.Alarm): void {
  if (alarm.name !== WEEKLY_ALARM_NAME) return;
  console.log('[tab-obituary] weekly alarm fired at', new Date().toISOString());
  handleWeeklyAlarm().catch((err: unknown) => {
    console.error('[tab-obituary] weekly-report threw', err);
  });
}
