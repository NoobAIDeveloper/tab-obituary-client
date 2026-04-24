import { describe, expect, it } from 'vitest';
import { makeThrottle } from './throttle.js';

describe('makeThrottle', () => {
  it('coalesces rapid calls at t=0 into a single emission', () => {
    const t = 0;
    const throttle = makeThrottle(5000, () => t);
    let count = 0;
    for (let i = 0; i < 10; i++) throttle(() => count++);
    expect(count).toBe(1);
  });

  it('emits again after the interval has elapsed', () => {
    let t = 0;
    const throttle = makeThrottle(5000, () => t);
    let count = 0;
    throttle(() => count++);
    expect(count).toBe(1);
    t = 4999;
    throttle(() => count++);
    expect(count).toBe(1);
    t = 5001;
    throttle(() => count++);
    expect(count).toBe(2);
  });

  it('does not emit again within the interval window', () => {
    let t = 1000;
    const throttle = makeThrottle(200, () => t);
    let count = 0;
    throttle(() => count++);
    t = 1100;
    throttle(() => count++);
    t = 1199;
    throttle(() => count++);
    expect(count).toBe(1);
  });
});
