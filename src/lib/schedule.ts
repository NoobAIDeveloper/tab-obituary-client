const ONE_WEEK_MINUTES = 7 * 24 * 60;

export function nextSunday9amLocal(now: Date = new Date()): number {
  const d = new Date(now.getTime());
  const daysUntilSunday = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + daysUntilSunday);
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 7);
  }
  return d.getTime();
}

export const WEEKLY_ALARM_NAME = 'tab-obituary-weekly-report';
export const WEEKLY_ALARM_PERIOD_MINUTES = ONE_WEEK_MINUTES;
