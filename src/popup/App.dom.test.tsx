// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

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
  deleteChrome();
});
afterEach(() => {
  cleanup();
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
});

describe('App shell', () => {
  it('renders a loading shell (not null) before the persisted route resolves', () => {
    // A never-resolving get keeps us in the "loading" branch indefinitely.
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockImplementation(() => new Promise(() => {})),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const { container } = render(<App />);
    expect(container.firstChild).not.toBeNull();
    // The loading shell should still show the title heading.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Tab Obituary');
    // No Continue button yet — we haven't mounted a real route.
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
  });

  it('falls back to welcome when readPersistedRoute returns null', async () => {
    // chrome undefined → readPersistedRoute resolves null → fallback is welcome.
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /continue/i })).not.toBeNull();
    });
    // Welcome body text.
    expect(screen.getByText(/A chronicle of your curiosity/)).not.toBeNull();
  });

  it('uses the resolved route when readPersistedRoute returns a valid route', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ 'popup:route': 'home' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    render(<App />);
    await waitFor(() => {
      // Home body text distinguishes from welcome.
      expect(screen.getByText(/Next report:/)).not.toBeNull();
    });
    // Home route has no Continue button.
    expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
  });

  it('falls back to welcome when the persisted value is garbage', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ 'popup:route': 'not-a-real-route' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/A chronicle of your curiosity/)).not.toBeNull();
    });
  });

  it('uses preview when persisted route is preview', async () => {
    setChrome({
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ 'popup:route': 'preview' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        "A taste of what's coming",
      );
    });
  });
});
