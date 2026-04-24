/**
 * Thin promise wrapper around `chrome.history.search` / `chrome.history.getVisits`.
 *
 * In MV3 these methods return a `Promise` when called without a callback, but
 * some test environments stub them as callback-style. We defensively detect
 * the return value: if it's a thenable, await it; otherwise fall back to a
 * callback bridge.
 *
 * When `chrome.history` is undefined (e.g. jsdom test env with no stub),
 * every method resolves to an empty array. The downstream pipeline handles
 * empty inputs cleanly — the preview will just render a minimal report.
 */

export interface HistoryClient {
  search(q: chrome.history.HistoryQuery): Promise<chrome.history.HistoryItem[]>;
  getVisits(details: chrome.history.UrlDetails): Promise<chrome.history.VisitItem[]>;
}

function hasChromeHistory(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.history === 'object' &&
    chrome.history !== null &&
    typeof chrome.history.search === 'function' &&
    typeof chrome.history.getVisits === 'function'
  );
}

function isPromiseLike<T>(v: unknown): v is PromiseLike<T> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

/**
 * Build the default `HistoryClient` backed by `chrome.history.*`.
 *
 * Returns an always-empty client when the API is unavailable. We deliberately
 * do NOT throw — a missing API in a test environment should degrade to an
 * empty preview, not a runtime error.
 */
export function createDefaultHistoryClient(): HistoryClient {
  if (!hasChromeHistory()) {
    return {
      search: () => Promise.resolve([]),
      getVisits: () => Promise.resolve([]),
    };
  }

  return {
    search(q) {
      // chrome.history.search accepts either (q, cb) or (q) returning a Promise.
      // Call without callback first; if the return is a Promise, await it.
      // Otherwise, fall back to callback form.
      try {
        const maybe = chrome.history.search(q) as unknown;
        if (isPromiseLike<chrome.history.HistoryItem[]>(maybe)) {
          return Promise.resolve(maybe);
        }
      } catch {
        // fall through to callback form
      }
      return new Promise<chrome.history.HistoryItem[]>((resolve) => {
        try {
          chrome.history.search(q, (items) => resolve(items ?? []));
        } catch {
          resolve([]);
        }
      });
    },
    getVisits(details) {
      try {
        const maybe = chrome.history.getVisits(details) as unknown;
        if (isPromiseLike<chrome.history.VisitItem[]>(maybe)) {
          return Promise.resolve(maybe);
        }
      } catch {
        // fall through to callback form
      }
      return new Promise<chrome.history.VisitItem[]>((resolve) => {
        try {
          chrome.history.getVisits(details, (visits) => resolve(visits ?? []));
        } catch {
          resolve([]);
        }
      });
    },
  };
}
