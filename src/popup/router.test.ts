import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_ORDER,
  ROUTE_NAMES,
  isOnboardingRoute,
  nextOnboardingRoute,
  onboardingStepIndex,
  prevOnboardingRoute,
  readPersistedRoute,
  writePersistedRoute,
} from './router.js';

describe('ROUTE_NAMES', () => {
  it('contains exactly the seven known routes', () => {
    expect(ROUTE_NAMES).toEqual([
      'welcome',
      'tracking-opt-in',
      'email-capture',
      'cloud-opt-in',
      'timezone',
      'preview',
      'home',
    ]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(ROUTE_NAMES).size).toBe(ROUTE_NAMES.length);
  });
});

describe('ONBOARDING_ORDER', () => {
  it('has exactly five steps', () => {
    expect(ONBOARDING_ORDER).toHaveLength(5);
  });

  it('is welcome → tracking-opt-in → email-capture → cloud-opt-in → timezone', () => {
    expect(ONBOARDING_ORDER).toEqual([
      'welcome',
      'tracking-opt-in',
      'email-capture',
      'cloud-opt-in',
      'timezone',
    ]);
  });

  it('does not include preview or home', () => {
    expect(ONBOARDING_ORDER).not.toContain('preview');
    expect(ONBOARDING_ORDER).not.toContain('home');
  });
});

describe('isOnboardingRoute', () => {
  it('returns true for every onboarding route', () => {
    for (const r of ONBOARDING_ORDER) {
      expect(isOnboardingRoute(r)).toBe(true);
    }
  });

  it('returns false for preview and home', () => {
    expect(isOnboardingRoute('preview')).toBe(false);
    expect(isOnboardingRoute('home')).toBe(false);
  });
});

describe('onboardingStepIndex', () => {
  it('returns 0-based index for each onboarding route', () => {
    expect(onboardingStepIndex('welcome')).toBe(0);
    expect(onboardingStepIndex('tracking-opt-in')).toBe(1);
    expect(onboardingStepIndex('email-capture')).toBe(2);
    expect(onboardingStepIndex('cloud-opt-in')).toBe(3);
    expect(onboardingStepIndex('timezone')).toBe(4);
  });

  it('returns null for preview and home', () => {
    expect(onboardingStepIndex('preview')).toBeNull();
    expect(onboardingStepIndex('home')).toBeNull();
  });
});

describe('nextOnboardingRoute', () => {
  it('steps through the whole onboarding sequence', () => {
    expect(nextOnboardingRoute('welcome')).toBe('tracking-opt-in');
    expect(nextOnboardingRoute('tracking-opt-in')).toBe('email-capture');
    expect(nextOnboardingRoute('email-capture')).toBe('cloud-opt-in');
    expect(nextOnboardingRoute('cloud-opt-in')).toBe('timezone');
  });

  it('returns null for timezone (last onboarding step; bridging is the route component job)', () => {
    expect(nextOnboardingRoute('timezone')).toBeNull();
  });

  it('returns null for preview', () => {
    expect(nextOnboardingRoute('preview')).toBeNull();
  });

  it('returns null for home', () => {
    expect(nextOnboardingRoute('home')).toBeNull();
  });
});

describe('prevOnboardingRoute', () => {
  it('walks backwards through the sequence', () => {
    expect(prevOnboardingRoute('timezone')).toBe('cloud-opt-in');
    expect(prevOnboardingRoute('cloud-opt-in')).toBe('email-capture');
    expect(prevOnboardingRoute('email-capture')).toBe('tracking-opt-in');
    expect(prevOnboardingRoute('tracking-opt-in')).toBe('welcome');
  });

  it('returns null at welcome (first step)', () => {
    expect(prevOnboardingRoute('welcome')).toBeNull();
  });

  it('returns null for preview', () => {
    expect(prevOnboardingRoute('preview')).toBeNull();
  });

  it('returns null for home', () => {
    expect(prevOnboardingRoute('home')).toBeNull();
  });
});

// --- Persistence ---------------------------------------------------------

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: we need to actually remove the binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

describe('readPersistedRoute', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('resolves null when chrome is undefined', async () => {
    await expect(readPersistedRoute()).resolves.toBeNull();
  });

  it('resolves null when chrome.storage.local is missing', async () => {
    setChrome({ storage: {} });
    await expect(readPersistedRoute()).resolves.toBeNull();
  });

  it('resolves null when storage.local.get rejects', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockRejectedValue(new Error('boom')),
          set: vi.fn(),
        },
      },
    });
    await expect(readPersistedRoute()).resolves.toBeNull();
  });

  it.each([
    ['garbage string', 'garbage'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['object', {}],
    ['boolean', true],
    ['array', ['welcome']],
  ] as const)('resolves null when stored value is a %s', async (_label, value) => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ 'popup:route': value }),
          set: vi.fn(),
        },
      },
    });
    await expect(readPersistedRoute()).resolves.toBeNull();
  });

  it('resolves null when the stored key is missing entirely', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn(),
        },
      },
    });
    await expect(readPersistedRoute()).resolves.toBeNull();
  });

  it.each([
    'welcome',
    'tracking-opt-in',
    'email-capture',
    'cloud-opt-in',
    'timezone',
    'preview',
    'home',
  ])('resolves stored value %s', async (route) => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ 'popup:route': route }),
          set: vi.fn(),
        },
      },
    });
    await expect(readPersistedRoute()).resolves.toBe(route);
  });

  it('requests the popup:route key specifically', async () => {
    const get = vi.fn().mockResolvedValue({ 'popup:route': 'home' });
    setChrome({ storage: { local: { get, set: vi.fn() } } });
    await readPersistedRoute();
    expect(get).toHaveBeenCalledWith('popup:route');
  });
});

describe('writePersistedRoute', () => {
  let saved: ChromeHandle;

  beforeEach(() => {
    saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
    deleteChrome();
  });

  afterEach(() => {
    if (saved === undefined) deleteChrome();
    else setChrome(saved);
  });

  it('is a no-op when chrome is undefined', async () => {
    await expect(writePersistedRoute('home')).resolves.toBeUndefined();
  });

  it('is a no-op when chrome.storage.local is missing', async () => {
    setChrome({ storage: {} });
    await expect(writePersistedRoute('home')).resolves.toBeUndefined();
  });

  it('writes { "popup:route": route } via storage.local.set', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    setChrome({ storage: { local: { get: vi.fn(), set } } });
    await writePersistedRoute('preview');
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ 'popup:route': 'preview' });
  });

  it('does not throw when storage.local.set rejects', async () => {
    const set = vi.fn().mockRejectedValue(new Error('quota'));
    setChrome({ storage: { local: { get: vi.fn(), set } } });
    await expect(writePersistedRoute('home')).resolves.toBeUndefined();
  });
});
