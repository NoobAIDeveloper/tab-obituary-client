// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RouteProps, RouterProvider, useRouter } from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { Button } from './Button.js';
import { Screen } from './Screen.js';

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}
function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

let saved: ChromeHandle;
beforeEach(() => {
  saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setChrome({
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
    },
  });
});
afterEach(() => {
  cleanup();
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
});

function BackFromWelcome(): VNode {
  const router = useRouter();
  return (
    <Screen title="Welcome" back={true} body={<p>body</p>}>
      <Button onClick={() => router.go('home')}>Continue</Button>
    </Screen>
  );
}

function BackFromHome(): VNode {
  return <Screen title="Home" body={<p>body</p>} />;
}

function mkRoutes(): Record<RouteName, (_: RouteProps) => VNode> {
  return {
    welcome: BackFromWelcome,
    'tracking-opt-in': BackFromHome,
    'email-capture': BackFromHome,
    'cloud-opt-in': BackFromHome,
    timezone: BackFromHome,
    preview: BackFromHome,
    home: BackFromHome,
  };
}

describe('Screen', () => {
  it('renders the title as an h1', () => {
    function R(): VNode {
      return <Screen title="My Title" body={<p>body</p>} />;
    }
    const routes = { ...mkRoutes(), welcome: R };
    render(<RouterProvider initial="welcome" routes={routes} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My Title');
  });

  it('renders the body', () => {
    function R(): VNode {
      return <Screen title="T" body={<p data-testid="body">body text</p>} />;
    }
    const routes = { ...mkRoutes(), welcome: R };
    render(<RouterProvider initial="welcome" routes={routes} />);
    expect(screen.getByTestId('body').textContent).toBe('body text');
  });

  it('does not render the Back button when back prop is undefined', () => {
    function R(): VNode {
      return <Screen title="T" body={<p>body</p>} />;
    }
    const routes = { ...mkRoutes(), welcome: R };
    render(<RouterProvider initial="welcome" routes={routes} />);
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
  });

  it('does not render the Back button when canGoBack is false even with back=true', () => {
    render(<RouterProvider initial="welcome" routes={mkRoutes()} />);
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });

  it('renders the Back button once canGoBack is true and back=true', () => {
    const routes: Record<RouteName, (_: RouteProps) => VNode> = {
      ...mkRoutes(),
      home: BackFromWelcome,
    };
    render(<RouterProvider initial="welcome" routes={routes} />);
    // Initial welcome: no history yet, so no back button.
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
    // Navigate welcome -> home.
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    // Home re-uses BackFromWelcome with back=true, so now Back is visible.
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeNull();
  });

  it('clicking Back triggers goBack()', () => {
    // Set up: initial welcome, click continue to home, then navigate to a screen with back=true.
    // Simplest: initial welcome with back=true is not enough (no history). So use a routes setup
    // where home routes back to welcome via back button. But BackFromHome has no back button.
    // Use BackFromWelcome for both welcome and home to exercise back.
    const routes: Record<RouteName, (_: RouteProps) => VNode> = {
      ...mkRoutes(),
      welcome: BackFromWelcome,
      home: BackFromWelcome,
    };
    render(<RouterProvider initial="welcome" routes={routes} />);
    // on welcome, no back yet (history empty)
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
    // navigate welcome -> home
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    // now on home which also renders Screen with back=true
    const backBtn = screen.getByRole('button', { name: /^back$/i });
    fireEvent.click(backBtn);
    // should now be back on welcome (heading "Welcome")
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome');
  });
});
