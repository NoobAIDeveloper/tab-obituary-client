import { vi } from 'vitest';

type ChromeStorageFn = ReturnType<typeof vi.fn>;

export interface ChromeStorageMock {
  chrome: {
    storage: {
      local: {
        get: ChromeStorageFn;
        set: ChromeStorageFn;
        remove: ChromeStorageFn;
      };
    };
  };
  data: Record<string, unknown>;
  get: ChromeStorageFn;
  set: ChromeStorageFn;
  remove: ChromeStorageFn;
}

export function makeChromeStorageMock(seed: Record<string, unknown> = {}): ChromeStorageMock {
  const data: Record<string, unknown> = { ...seed };
  const get = vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {}));
  const set = vi.fn(async (patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) data[k] = v;
  });
  const remove = vi.fn(async (key: string) => {
    delete data[key];
  });
  return {
    data,
    get,
    set,
    remove,
    chrome: { storage: { local: { get, set, remove } } },
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
