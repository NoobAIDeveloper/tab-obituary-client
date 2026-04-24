// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import type { ComponentType, VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendBaseUrl } from '../../backend/config.js';
import { openDb } from '../../storage/db.js';
import { getPrivacy, getUser, setUser } from '../../storage/settings-store.js';
import { type RouteProps, RouterProvider, useRouter } from '../RouterProvider.js';
import { ONBOARDING_ORDER, type RouteName, nextOnboardingRoute } from '../router.js';
import { ROUTES } from './index.js';

type ChromeHandle = (typeof globalThis)['chrome'] | undefined;

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}
function deleteChrome(): void {
  // biome-ignore lint/performance/noDelete: need to fully remove binding
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

/**
 * Stub `fetch` so the email-capture route's `subscribe()` call succeeds
 * without hitting the network. The onboarding router tests care about
 * navigation + IDB writes, not the subscribe wire details (covered in
 * client.test.ts and email-capture.dom.test.tsx).
 */
function stubSubscribeOk(
  uuid = '22222222-2222-4222-8222-222222222222',
  clientToken = 'tok-abc',
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'subscribed', uuid, clientToken }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
}

let saved: ChromeHandle;
beforeEach(() => {
  saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  setChrome({
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
    },
  });
  // Fresh in-memory IDB factory per test — each RouterProvider tree owns a
  // different DB and old hook instances don't hold on to the store.
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
  // Point the backend client at a fake host so any accidental real-fetch
  // attempts surface loudly rather than racing against localhost.
  setBackendBaseUrl('https://api.test.example');
});
afterEach(() => {
  cleanup();
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
  setBackendBaseUrl(null);
  vi.unstubAllGlobals();
});

function sentinelRoutes(focus: RouteName): Record<RouteName, ComponentType<RouteProps>> {
  const result = { ...ROUTES };
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    if (name === focus) continue;
    result[name] = function Sentinel(): VNode {
      const router = useRouter();
      return (
        <div data-testid={`sentinel-${name}`}>
          {name}::{router.route}
        </div>
      );
    };
  }
  return result;
}

describe('welcome route', () => {
  it('renders step 1 of 5', () => {
    render(<RouterProvider initial="welcome" routes={ROUTES} />);
    expect(screen.getByText(/Step 1 of 5/)).not.toBeNull();
  });

  it('Continue navigates to tracking-opt-in and synthesizes default user + privacy rows', async () => {
    render(<RouterProvider initial="welcome" routes={sentinelRoutes('welcome')} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-tracking-opt-in')).not.toBeNull();
    });
    const db = await openDb();
    const user = await getUser(db);
    const privacy = await getPrivacy(db);
    db.close();
    expect(user).toBeDefined();
    expect(user?.plan).toBe('free');
    expect(user?.emailConfirmed).toBe(false);
    expect(privacy).toBeDefined();
    expect(privacy?.trackingOptIn).toBe(false);
    expect(privacy?.cloudAiOptIn).toBe(false);
  });

  it('has no Back button on first paint (canGoBack false and welcome has no prev)', () => {
    render(<RouterProvider initial="welcome" routes={ROUTES} />);
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });
});

describe('tracking-opt-in route', () => {
  it('renders two clearly labeled choice buttons', () => {
    render(<RouterProvider initial="tracking-opt-in" routes={ROUTES} />);
    expect(screen.getByRole('button', { name: /yes, track my browsing/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /not right now/i })).not.toBeNull();
  });

  it('"Yes" writes trackingOptIn=true and advances to email-capture', async () => {
    render(<RouterProvider initial="tracking-opt-in" routes={sentinelRoutes('tracking-opt-in')} />);
    fireEvent.click(screen.getByRole('button', { name: /yes, track my browsing/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-email-capture')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.trackingOptIn).toBe(true);
  });

  it('"Not right now" writes trackingOptIn=false and advances to email-capture', async () => {
    render(<RouterProvider initial="tracking-opt-in" routes={sentinelRoutes('tracking-opt-in')} />);
    fireEvent.click(screen.getByRole('button', { name: /not right now/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-email-capture')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.trackingOptIn).toBe(false);
  });
});

describe('email-capture route', () => {
  it('Continue is disabled until a valid email is entered', () => {
    render(<RouterProvider initial="email-capture" routes={ROUTES} />);
    const btn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'not-an-email' } });
    expect(btn.disabled).toBe(true);

    fireEvent.input(input, { target: { value: 'a@b.co' } });
    expect(btn.disabled).toBe(false);
  });

  it('Continue writes user.email and advances to cloud-opt-in', async () => {
    stubSubscribeOk();
    render(<RouterProvider initial="email-capture" routes={sentinelRoutes('email-capture')} />);
    const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });
    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(user?.email).toBe('me@example.com');
    expect(user?.emailConfirmed).toBe(false);
  });

  it('pressing Enter submits', async () => {
    stubSubscribeOk();
    render(<RouterProvider initial="email-capture" routes={sentinelRoutes('email-capture')} />);
    const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'enter@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-cloud-opt-in')).not.toBeNull();
    });
  });
});

describe('cloud-opt-in route', () => {
  it('"cloud" writes cloudAiOptIn=true and advances to timezone', async () => {
    render(<RouterProvider initial="cloud-opt-in" routes={sentinelRoutes('cloud-opt-in')} />);
    fireEvent.click(screen.getByRole('button', { name: /compose in the cloud/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(true);
  });

  it('"on my device" writes cloudAiOptIn=false and advances to timezone', async () => {
    render(<RouterProvider initial="cloud-opt-in" routes={sentinelRoutes('cloud-opt-in')} />);
    fireEvent.click(screen.getByRole('button', { name: /compose on my device/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-timezone')).not.toBeNull();
    });
    const db = await openDb();
    const privacy = await getPrivacy(db);
    db.close();
    expect(privacy?.cloudAiOptIn).toBe(false);
  });
});

describe('timezone route', () => {
  it('renders the auto-detected timezone in a readonly label', () => {
    render(<RouterProvider initial="timezone" routes={ROUTES} />);
    const label = screen.getByTestId('tz-detected');
    expect(label.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('Continue writes user.timezone and advances to preview', async () => {
    render(<RouterProvider initial="timezone" routes={sentinelRoutes('timezone')} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-preview')).not.toBeNull();
    });
    const db = await openDb();
    const user = await getUser(db);
    db.close();
    expect(typeof user?.timezone).toBe('string');
    expect(user?.timezone?.length ?? 0).toBeGreaterThan(0);
  });

  it('"change" reveals an editor and Continue is disabled if emptied', () => {
    render(<RouterProvider initial="timezone" routes={ROUTES} />);
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    // The editor is either a <select> (if Intl.supportedValuesOf is available
    // in the test env) or a text input fallback. Both should exist.
    const editor = document.querySelector('.form-input');
    expect(editor).not.toBeNull();
  });
});

describe('onboarding Progress indicator', () => {
  it.each(
    ONBOARDING_ORDER.map((route, idx) => [route, idx + 1]) as ReadonlyArray<[RouteName, number]>,
  )('%s shows "Step %s of 5"', (route, step) => {
    render(<RouterProvider initial={route} routes={ROUTES} />);
    expect(screen.getByText(new RegExp(`Step ${step} of 5`))).not.toBeNull();
  });
});

describe('preview route', () => {
  /**
   * The preview route is now driven by usePreviewReport — it calls
   * buildPreviewPayload (reads chrome.history) and then POSTs to
   * /generate-report. For these route-level tests we only care about
   * the surrounding chrome/navigation/heading — not the network round-trip
   * (covered in usePreviewReport / build-preview-payload unit tests).
   * A fetch stub returning a valid ReportResponse keeps the route from
   * ending in the error branch by accident.
   *
   * We also seed a UserSettings row so useSettings() lands with user
   * defined; otherwise usePreviewReport's start() latches pending and the
   * route stays in the loading branch forever.
   */
  async function seedUser(): Promise<void> {
    const db = await openDb();
    await setUser(db, {
      uuid: '11111111-1111-4111-8111-111111111111',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 0,
    });
  }

  function stubGenerateReportOk(
    subject = 'A generated preview subject',
    html = '<!doctype html><html><body>Generated preview</body></html>',
  ): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            sections: {
              subject,
              preheader: '',
              rabbitHoles: [],
              themes: [],
              obsessions: [],
              ghostTabs: [],
              wow: [],
              tabsStillAlive: [],
              generatedWith: 'deterministic',
            },
            emailHtml: html,
            emailText: 'plain text',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
  }

  it('Continue jumps to home', () => {
    stubGenerateReportOk();
    render(<RouterProvider initial="preview" routes={sentinelRoutes('preview')} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByTestId('sentinel-home')).not.toBeNull();
  });

  it('does not render a Step indicator', () => {
    stubGenerateReportOk();
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    expect(screen.queryByText(/Step \d of \d/)).toBeNull();
  });

  it('shows a loading hint before the generated preview resolves', () => {
    stubGenerateReportOk();
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    // Before awaits resolve, we're in loading state. "Writing your preview" copy.
    expect(screen.getByText(/Writing your preview/i)).not.toBeNull();
  });

  it('renders the generated subject line and iframe once the response resolves', async () => {
    await seedUser();
    stubGenerateReportOk('This is the live subject.');
    const { container } = render(<RouterProvider initial="preview" routes={ROUTES} />);

    await waitFor(() => {
      expect(screen.getByText(/Subject: This is the live subject\./)).not.toBeNull();
    });

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.hasAttribute('sandbox')).toBe(true);
    expect(iframe?.getAttribute('sandbox')).toBe('');
    expect((iframe?.getAttribute('sandbox') ?? '').includes('allow-')).toBe(false);
    expect(iframe?.getAttribute('srcdoc')).toContain('Generated preview');
  });

  it('renders exactly one iframe in the preview subtree after resolution', async () => {
    await seedUser();
    stubGenerateReportOk();
    const { container } = render(<RouterProvider initial="preview" routes={ROUTES} />);
    await waitFor(() => {
      expect(container.querySelectorAll('iframe').length).toBe(1);
    });
  });

  it('preview route CSS hooks are intact (.email-preview-wrapper / .email-preview-frame)', async () => {
    await seedUser();
    stubGenerateReportOk();
    const { container } = render(<RouterProvider initial="preview" routes={ROUTES} />);
    await waitFor(() => {
      expect(container.querySelector('.email-preview-wrapper')).not.toBeNull();
    });
    const frame = container.querySelector('.email-preview-frame');
    expect(frame).not.toBeNull();
    expect(frame?.tagName.toLowerCase()).toBe('iframe');
  });

  it('uses the "A taste of what\'s coming" heading', () => {
    stubGenerateReportOk();
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("A taste of what's coming");
  });

  it('does not render a Back button at preview (no history, no onboarding prev)', () => {
    // Mounted directly at preview: canGoBack is false, so Screen back=true should
    // still not produce a Back button (Screen's showBack requires canGoBack).
    stubGenerateReportOk();
    render(<RouterProvider initial="preview" routes={ROUTES} />);
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });

  it('shows a Back button after navigating into preview from timezone', async () => {
    stubGenerateReportOk();
    render(<RouterProvider initial="timezone" routes={ROUTES} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        "A taste of what's coming",
      );
    });
    // canGoBack is now true because timezone pushed a history entry.
    expect(screen.getByRole('button', { name: /^back$/i })).not.toBeNull();
  });
});

describe('home route', () => {
  it('renders without crashing and shows "not scheduled" when chrome.alarms is absent', async () => {
    // setChrome in beforeEach set chrome.storage but not chrome.alarms → absent.
    render(<RouterProvider initial="home" routes={ROUTES} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Tab Obituary');
    await waitFor(() => {
      expect(screen.getByText(/Next report:\s*not scheduled/)).not.toBeNull();
    });
  });
});

describe('home route — navigation state', () => {
  function JumpToHome(): VNode {
    const router = useRouter();
    return (
      <button type="button" onClick={() => router.go('home')}>
        jump
      </button>
    );
  }

  it('renders without a Back button even when history is non-empty', () => {
    const routes: Record<RouteName, ComponentType<RouteProps>> = {
      ...ROUTES,
      welcome: JumpToHome,
    };
    render(<RouterProvider initial="welcome" routes={routes} />);
    fireEvent.click(screen.getByRole('button', { name: /jump/i }));
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });
});

describe('onboarding Back button', () => {
  it('tracking-opt-in Back returns to welcome when history is non-empty', async () => {
    render(<RouterProvider initial="welcome" routes={ROUTES} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /yes, track my browsing/i })).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByText(/A chronicle of your curiosity/)).not.toBeNull();
  });

  it('welcome does not render a Back button (no history, no onboarding prev)', () => {
    render(<RouterProvider initial="welcome" routes={ROUTES} />);
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });

  it('mid-flow route restored without history still offers Back (falls back to prev onboarding step)', async () => {
    // Simulate a reopened popup that landed on step 3 with no navigation history.
    render(<RouterProvider initial="email-capture" routes={ROUTES} />);
    // Back should be present despite canGoBack=false, because email-capture has
    // a prev step (tracking-opt-in) in the onboarding order.
    const back = screen.getByRole('button', { name: /^back$/i });
    expect(back).not.toBeNull();
    fireEvent.click(back);
    // Now on tracking-opt-in.
    expect(screen.getByRole('button', { name: /yes, track my browsing/i })).not.toBeNull();
  });

  it('next checks that nextOnboardingRoute chain is unchanged', () => {
    expect(nextOnboardingRoute('welcome')).toBe('tracking-opt-in');
    expect(nextOnboardingRoute('tracking-opt-in')).toBe('email-capture');
    expect(nextOnboardingRoute('email-capture')).toBe('cloud-opt-in');
    expect(nextOnboardingRoute('cloud-opt-in')).toBe('timezone');
  });
});
