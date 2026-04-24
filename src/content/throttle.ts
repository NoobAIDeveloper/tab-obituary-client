// Leading-edge throttle factory. Extracted into its own module so it can be
// unit-tested without loading the side-effectful input-beacon entry point
// (which calls window.addEventListener at module load).
export function makeThrottle(
  intervalMs: number,
  now: () => number = Date.now,
): (cb: () => void) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (cb) => {
    const t = now();
    if (t - last >= intervalMs) {
      last = t;
      cb();
    }
  };
}
