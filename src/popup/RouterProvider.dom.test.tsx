// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RouteProps, RouterProvider, useRouter } from './RouterProvider.js';
import type { RouteName } from './router.js';

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove the binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

function makeRoute(label: string, opts?: { onMount?: () => void }): (_: RouteProps) => VNode {
  return function RouteComp(): VNode {
    const router = useRouter();
    opts?.onMount?.();
    return (
      <div>
        <span data-testid="label">{label}</span>
        <span data-testid="current">{router.route}</span>
        <span data-testid="can-back">{String(router.canGoBack)}</span>
        <button type="button" data-testid="go-welcome" onClick={() => router.go('welcome')}>
          go welcome
        </button>
        <button
          type="button"
          data-testid="go-tracking"
          onClick={() => router.go('tracking-opt-in')}
        >
          go tracking
        </button>
        <button type="button" data-testid="go-home" onClick={() => router.go('home')}>
          go home
        </button>
        <button type="button" data-testid="go-same" onClick={() => router.go(router.route)}>
          go same
        </button>
        <button type="button" data-testid="back" onClick={() => router.goBack()}>
          back
        </button>
      </div>
    );
  };
}

function makeRoutes(
  overrides: Partial<Record<RouteName, (_: RouteProps) => VNode>> = {},
): Record<RouteName, (_: RouteProps) => VNode> {
  return {
    welcome: overrides.welcome ?? makeRoute('welcome-screen'),
    'tracking-opt-in': overrides['tracking-opt-in'] ?? makeRoute('tracking-screen'),
    'email-capture': overrides['email-capture'] ?? makeRoute('email-screen'),
    'cloud-opt-in': overrides['cloud-opt-in'] ?? makeRoute('cloud-screen'),
    timezone: overrides.timezone ?? makeRoute('timezone-screen'),
    preview: overrides.preview ?? makeRoute('preview-screen'),
    home: overrides.home ?? makeRoute('home-screen'),
  };
}

let savedChrome: ChromeHandle;
let setSpy: ReturnType<typeof vi.fn>;
let getSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  savedChrome = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setSpy = vi.fn().mockResolvedValue(undefined);
  getSpy = vi.fn().mockResolvedValue({});
  setChrome({ storage: { local: { get: getSpy, set: setSpy } } });
});

afterEach(() => {
  cleanup();
  if (savedChrome === undefined) deleteChrome();
  else setChrome(savedChrome);
});

describe('useRouter outside provider', () => {
  it('throws a clear error when used outside a RouterProvider', () => {
    function Orphan(): VNode {
      useRouter();
      return <div />;
    }
    // Suppress the Preact error-boundary console noise that happens during the throw path.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Orphan />)).toThrow(/RouterProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('RouterProvider rendering', () => {
  it('renders the initial route', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    expect(screen.getByTestId('label').textContent).toBe('welcome-screen');
    expect(screen.getByTestId('current').textContent).toBe('welcome');
  });

  it('renders a different initial route when configured so', () => {
    render(<RouterProvider initial="home" routes={makeRoutes()} />);
    expect(screen.getByTestId('label').textContent).toBe('home-screen');
  });

  it('canGoBack is false initially', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    expect(screen.getByTestId('can-back').textContent).toBe('false');
  });
});

describe('go()', () => {
  it('switches the rendered route', async () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-tracking'));
    expect(screen.getByTestId('label').textContent).toBe('tracking-screen');
    expect(screen.getByTestId('current').textContent).toBe('tracking-opt-in');
  });

  it('calls writePersistedRoute with the target route', async () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-home'));
    // writePersistedRoute fires asynchronously (void-awaited in the callback).
    await Promise.resolve();
    await Promise.resolve();
    expect(setSpy).toHaveBeenCalledWith({ 'popup:route': 'home' });
  });

  it('flips canGoBack to true after one navigation', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-tracking'));
    expect(screen.getByTestId('can-back').textContent).toBe('true');
  });

  it('accumulates history across consecutive calls', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-tracking'));
    fireEvent.click(screen.getByTestId('go-home'));
    expect(screen.getByTestId('current').textContent).toBe('home');
    // history length is now 2 (welcome, tracking-opt-in)
    fireEvent.click(screen.getByTestId('back'));
    expect(screen.getByTestId('current').textContent).toBe('tracking-opt-in');
    fireEvent.click(screen.getByTestId('back'));
    expect(screen.getByTestId('current').textContent).toBe('welcome');
    expect(screen.getByTestId('can-back').textContent).toBe('false');
  });

  it('pushes the current route onto history even when go(sameRoute) is called (judgment call)', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-same'));
    // Observed behavior: goBack now returns us to the same route, which means
    // canGoBack is true. This may be user-visible as a harmless back tap no-op,
    // but it also means each redundant tap of Continue inflates the history.
    expect(screen.getByTestId('can-back').textContent).toBe('true');
  });

  it('still persists when go(sameRoute) is called (judgment call)', async () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-same'));
    await Promise.resolve();
    await Promise.resolve();
    expect(setSpy).toHaveBeenCalledWith({ 'popup:route': 'welcome' });
  });
});

describe('goBack()', () => {
  it('pops the last entry and renders the previous route', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-tracking'));
    fireEvent.click(screen.getByTestId('back'));
    expect(screen.getByTestId('current').textContent).toBe('welcome');
  });

  it('does not call writePersistedRoute when going back', async () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-tracking'));
    await Promise.resolve();
    await Promise.resolve();
    setSpy.mockClear();
    fireEvent.click(screen.getByTestId('back'));
    await Promise.resolve();
    await Promise.resolve();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when history is empty', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    expect(() => fireEvent.click(screen.getByTestId('back'))).not.toThrow();
    expect(screen.getByTestId('current').textContent).toBe('welcome');
    expect(screen.getByTestId('can-back').textContent).toBe('false');
  });

  it('canGoBack is false once history is exhausted', () => {
    render(<RouterProvider initial="welcome" routes={makeRoutes()} />);
    fireEvent.click(screen.getByTestId('go-tracking'));
    expect(screen.getByTestId('can-back').textContent).toBe('true');
    fireEvent.click(screen.getByTestId('back'));
    expect(screen.getByTestId('can-back').textContent).toBe('false');
  });
});
