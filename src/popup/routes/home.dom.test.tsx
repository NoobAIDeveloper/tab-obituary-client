// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RouteProps, RouterProvider } from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { HomeBody, HomeRoute } from './home.js';

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

function mountHome(getAlarm?: () => Promise<chrome.alarms.Alarm | undefined>): void {
  const route: Record<RouteName, (_: RouteProps) => VNode> = {
    welcome: () => <div />,
    'tracking-opt-in': () => <div />,
    'email-capture': () => <div />,
    'cloud-opt-in': () => <div />,
    timezone: () => <div />,
    preview: () => <div />,
    home: () => (getAlarm ? <HomeBody getAlarm={getAlarm} /> : <HomeRoute />),
  };
  render(<RouterProvider initial="home" routes={route} />);
}

describe('HomeRoute', () => {
  it('renders "not scheduled" when chrome.alarms is absent', async () => {
    mountHome();
    await waitFor(() => {
      expect(screen.getByText(/Next report:\s*not scheduled/)).not.toBeNull();
    });
  });

  it('renders "not scheduled" when chrome.alarms.get resolves to null', async () => {
    setChrome({
      alarms: {
        get: vi.fn().mockResolvedValue(null),
      },
    });
    mountHome();
    await waitFor(() => {
      expect(screen.getByText(/Next report:\s*not scheduled/)).not.toBeNull();
    });
  });

  it('renders the scheduledTime as a locale string when the alarm exists', async () => {
    const when = new Date('2026-05-10T09:00:00Z');
    const alarm = {
      name: 'tab-obituary-weekly-report',
      scheduledTime: when.getTime(),
      periodInMinutes: 10080,
    } satisfies chrome.alarms.Alarm;
    mountHome(async () => alarm);
    await waitFor(() => {
      const line = screen.getByText(/Next report:/).textContent ?? '';
      expect(line).toContain(when.toLocaleString());
    });
  });

  it('renders "checking…" initially when an injected getAlarm is pending', () => {
    // Never-resolving getter keeps the state in "checking…".
    mountHome(() => new Promise<chrome.alarms.Alarm | undefined>(() => {}));
    expect(screen.getByText(/Next report:\s*checking…/)).not.toBeNull();
  });

  it('renders "not scheduled" when the default getAlarm throws under the hood', async () => {
    // chrome.alarms.get that throws synchronously should resolve to "not scheduled".
    setChrome({
      alarms: {
        get: vi.fn().mockImplementation(() => {
          throw new Error('boom');
        }),
      },
    });
    mountHome();
    await waitFor(() => {
      expect(screen.getByText(/Next report:\s*not scheduled/)).not.toBeNull();
    });
  });

  it('Settings button calls chrome.runtime.openOptionsPage when available', async () => {
    const openOptionsPage = vi.fn();
    setChrome({
      runtime: { openOptionsPage },
      alarms: { get: vi.fn().mockResolvedValue(null) },
    });
    mountHome();
    const button = await screen.findByText('Settings');
    fireEvent.click(button);
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('Settings button no-ops when chrome.runtime.openOptionsPage is absent', () => {
    // No chrome global; click must not throw.
    mountHome();
    const button = screen.getByText('Settings');
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});
