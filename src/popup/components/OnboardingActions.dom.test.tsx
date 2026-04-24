// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { ComponentType, VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RouteProps, RouterProvider, useRouter } from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { Button } from './Button.js';
import { OnboardingActions } from './OnboardingActions.js';

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;
function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}
function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

let savedChrome: ChromeHandle;
beforeEach(() => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setChrome({
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
    },
  });
});
afterEach(() => {
  cleanup();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
});

function makeRoutes(
  overrides: Partial<Record<RouteName, ComponentType<RouteProps>>>,
): Record<RouteName, ComponentType<RouteProps>> {
  const passthrough = (label: string): ComponentType<RouteProps> =>
    function Stub(): VNode {
      return <div data-testid={`sentinel-${label}`}>{label}</div>;
    };
  return {
    welcome: overrides.welcome ?? passthrough('welcome'),
    'tracking-opt-in': overrides['tracking-opt-in'] ?? passthrough('tracking-opt-in'),
    'email-capture': overrides['email-capture'] ?? passthrough('email-capture'),
    'cloud-opt-in': overrides['cloud-opt-in'] ?? passthrough('cloud-opt-in'),
    timezone: overrides.timezone ?? passthrough('timezone'),
    preview: overrides.preview ?? passthrough('preview'),
    home: overrides.home ?? passthrough('home'),
  };
}

describe('OnboardingActions — pure behavior', () => {
  it('renders no Back on welcome (no history, no onboarding prev)', () => {
    const routes = makeRoutes({
      welcome: () => (
        <OnboardingActions current="welcome">
          <Button>Continue</Button>
        </OnboardingActions>
      ),
    });
    render(<RouterProvider initial="welcome" routes={routes} />);
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeNull();
  });

  it('renders Back on a mid-flow route with no history (falls back to onboarding prev)', () => {
    const routes = makeRoutes({
      'email-capture': () => (
        <OnboardingActions current="email-capture">
          <Button>Continue</Button>
        </OnboardingActions>
      ),
    });
    render(<RouterProvider initial="email-capture" routes={routes} />);
    expect(screen.getByRole('button', { name: /^back$/i })).not.toBeNull();
  });

  it('Back with non-empty history calls goBack (not go(prev))', () => {
    // Navigate once to build history, then confirm Back pops history.
    function Step(props: { current: RouteName }): VNode {
      const router = useRouter();
      return (
        <div>
          <button type="button" onClick={() => router.go('email-capture')}>
            go email
          </button>
          <OnboardingActions current={props.current}>
            <Button>Continue</Button>
          </OnboardingActions>
        </div>
      );
    }
    const routes = makeRoutes({
      welcome: () => <Step current="welcome" />,
      'email-capture': () => <Step current="email-capture" />,
    });
    render(<RouterProvider initial="welcome" routes={routes} />);
    fireEvent.click(screen.getByRole('button', { name: /go email/i }));
    // Now we're on email-capture with history=[welcome]. Back must go to welcome.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    // Back on welcome, the "go email" button is visible and Back is gone.
    expect(screen.getByRole('button', { name: /go email/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });

  it('Back with empty history calls go(prev) — lands on onboarding predecessor', () => {
    const routes = makeRoutes({
      timezone: () => (
        <OnboardingActions current="timezone">
          <Button>Continue</Button>
        </OnboardingActions>
      ),
    });
    render(<RouterProvider initial="timezone" routes={routes} />);
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
  });

  it('renders its children alongside Back', () => {
    const routes = makeRoutes({
      'tracking-opt-in': () => (
        <OnboardingActions current="tracking-opt-in">
          <span data-testid="child-marker">children here</span>
        </OnboardingActions>
      ),
    });
    render(<RouterProvider initial="tracking-opt-in" routes={routes} />);
    expect(screen.getByTestId('child-marker')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^back$/i })).not.toBeNull();
  });
});
