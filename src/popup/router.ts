import { hasChromeStorage } from '../lib/chrome-env.js';

export const ROUTE_NAMES = [
  'welcome',
  'tracking-opt-in',
  'email-capture',
  'cloud-opt-in',
  'timezone',
  'preview',
  'home',
] as const;

export type RouteName = (typeof ROUTE_NAMES)[number];

export const ONBOARDING_ORDER: readonly RouteName[] = [
  'welcome',
  'tracking-opt-in',
  'email-capture',
  'cloud-opt-in',
  'timezone',
] as const;

export function isOnboardingRoute(route: RouteName): boolean {
  return (ONBOARDING_ORDER as readonly RouteName[]).includes(route);
}

export function onboardingStepIndex(route: RouteName): number | null {
  const idx = ONBOARDING_ORDER.indexOf(route);
  return idx === -1 ? null : idx;
}

export function nextOnboardingRoute(current: RouteName): RouteName | null {
  const idx = ONBOARDING_ORDER.indexOf(current);
  if (idx === -1) return null;
  const next = ONBOARDING_ORDER[idx + 1];
  return next ?? null;
}

export function prevOnboardingRoute(current: RouteName): RouteName | null {
  const idx = ONBOARDING_ORDER.indexOf(current);
  if (idx <= 0) return null;
  const prev = ONBOARDING_ORDER[idx - 1];
  return prev ?? null;
}

const PERSIST_KEY = 'popup:route';

function isRouteName(value: unknown): value is RouteName {
  return typeof value === 'string' && (ROUTE_NAMES as readonly string[]).includes(value);
}

export async function readPersistedRoute(): Promise<RouteName | null> {
  if (!hasChromeStorage()) return null;
  try {
    const out = await chrome.storage.local.get(PERSIST_KEY);
    const raw = out[PERSIST_KEY];
    return isRouteName(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function writePersistedRoute(r: RouteName): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({ [PERSIST_KEY]: r });
  } catch {
    // best-effort; persistence is an optimization
  }
}
