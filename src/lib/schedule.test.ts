import { describe, expect, it } from 'vitest';
import { nextSunday9amLocal } from './schedule.js';

describe('nextSunday9amLocal', () => {
  it('returns the coming Sunday at 09:00 local when called on a weekday', () => {
    const wednesday = new Date('2026-04-22T15:30:00');
    const when = new Date(nextSunday9amLocal(wednesday));
    expect(when.getDay()).toBe(0);
    expect(when.getHours()).toBe(9);
    expect(when.getMinutes()).toBe(0);
  });

  it('advances to next week when called after 9am on a Sunday', () => {
    const sundayAfter9 = new Date('2026-04-19T10:00:00');
    const when = new Date(nextSunday9amLocal(sundayAfter9));
    expect(when.getDay()).toBe(0);
    expect(when.getHours()).toBe(9);
    expect(when.getTime()).toBeGreaterThan(sundayAfter9.getTime());
    expect(when.getDate()).toBe(26);
  });

  it('stays on the same Sunday when called before 9am on Sunday', () => {
    const sundayBefore9 = new Date('2026-04-19T08:30:00');
    const when = new Date(nextSunday9amLocal(sundayBefore9));
    expect(when.getDay()).toBe(0);
    expect(when.getDate()).toBe(19);
    expect(when.getHours()).toBe(9);
  });
});
