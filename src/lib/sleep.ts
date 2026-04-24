/**
 * Abortable sleep used by retry loops in `backend/client.ts` and
 * `storage/delete-cascade.ts`.
 *
 * Returns `true` if the signal aborted during the wait, `false` otherwise.
 * Checking the return value lets the caller short-circuit its retry loop
 * without re-inspecting the signal.
 *
 * The `signal` parameter is optional: one caller in `delete-cascade.ts` runs
 * without a signal in some paths and relies on the plain timeout.
 */
export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
