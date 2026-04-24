// @vitest-environment happy-dom
// Net-new edge-case coverage for chunk 5.2. The happy-path per-screen
// assertions live in routes.dom.test.tsx; this file picks up the gaps the
// primary file doesn't exercise (error paths, pre-population, Back-with-no-
// history fallbacks, re-visit preservation, focus).
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import type { ComponentType, VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../storage/db.js';
import { getPrivacy, getUser, setPrivacy, setUser } from '../../storage/settings-store.js';
import { type RouteProps, RouterProvider, useRouter } from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { ROUTES } from './index.js';

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
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
});
afterEach(() => {
  cleanup();
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
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

describe('welcome — re-visit preserves installedAt and user uuid', () => {
  it('pre-seeded privacy.installedAt survives Continue', async () => {
    const db = await openDb();
    await setPrivacy(db, {
      trackingOptIn: false,
      cloudAiOptIn: false,
      trackingPaused: false,
      installedAt: 1_700_000_000_000,
    });
    db.close();
    render(<RouterProvider initial="welcome" routes={sentinelRoutes('welcome')} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-tracking-opt-in')).not.toBeNull();
    });
    const db2 = await openDb();
    const p = await getPrivacy(db2);
    db2.close();
    expect(p?.installedAt).toBe(1_700_000_000_000);
  });

  it('first-visit Continue produces a uuid-shaped user.uuid and a non-empty timezone', async () => {
    render(<RouterProvider initial="welcome" routes={sentinelRoutes('welcome')} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-tracking-opt-in')).not.toBeNull();
    });
    const db = await openDb();
    const u = await getUser(db);
    db.close();
    expect(u?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect((u?.timezone ?? '').length).toBeGreaterThan(0);
  });
});

describe('tracking-opt-in — failure path', () => {
  it('shows an error and does NOT navigate when the IDB factory is broken', async () => {
    // Replace indexedDB with a factory whose open always throws — updatePrivacy
    // will reject, the route's try/catch will set the error and skip router.go.
    const broken = {
      open: (): IDBOpenDBRequest => {
        throw new Error('forced failure');
      },
      deleteDatabase: (): IDBOpenDBRequest => {
        throw new Error('n/a');
      },
      databases: async (): Promise<IDBDatabaseInfo[]> => [],
      cmp: (): number => 0,
    } as unknown as IDBFactory;
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = broken;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      render(
        <RouterProvider initial="tracking-opt-in" routes={sentinelRoutes('tracking-opt-in')} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /yes, track my browsing/i }));
      await waitFor(() => {
        expect(document.querySelector('.error')).not.toBeNull();
      });
      // Navigation must NOT have happened.
      expect(screen.queryByTestId('sentinel-email-capture')).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('email-capture — focus, pre-population, invalid submit', () => {
  it('input receives focus on mount', async () => {
    render(<RouterProvider initial="email-capture" routes={ROUTES} />);
    const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('pre-populates the input with settings.user.email when a user row exists', async () => {
    const db = await openDb();
    await setUser(db, {
      uuid: '11111111-1111-4111-8111-111111111111',
      email: 'existing@example.com',
      emailConfirmed: false,
      timezone: 'UTC',
      plan: 'free',
      createdAt: 1,
    });
    db.close();
    render(<RouterProvider initial="email-capture" routes={ROUTES} />);
    // The route reads settings.user via useSettings; the initial load is async.
    await waitFor(() => {
      const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
      expect(input.value).toBe('existing@example.com');
    });
  });

  it('pressing Enter while the email is invalid does nothing (no navigation, no write)', async () => {
    render(<RouterProvider initial="email-capture" routes={sentinelRoutes('email-capture')} />);
    const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'not-an-email' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Give the async pipeline a chance to do nothing.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
    const db = await openDb();
    const u = await getUser(db);
    db.close();
    expect(u?.email).toBeUndefined();
  });

  it('pressing a non-Enter key does not submit', async () => {
    render(<RouterProvider initial="email-capture" routes={sentinelRoutes('email-capture')} />);
    const input = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'valid@example.com' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('sentinel-cloud-opt-in')).toBeNull();
  });

  it('Back button without history falls back to tracking-opt-in', () => {
    // Freshly-mounted at email-capture: canGoBack is false, but onboarding prev
    // is tracking-opt-in so the component renders Back and wires it to go().
    render(<RouterProvider initial="email-capture" routes={ROUTES} />);
    const back = screen.getByRole('button', { name: /^back$/i });
    fireEvent.click(back);
    expect(screen.getByRole('button', { name: /yes, track my browsing/i })).not.toBeNull();
  });
});

describe('cloud-opt-in — Back without history', () => {
  it('falls back to email-capture', () => {
    render(<RouterProvider initial="cloud-opt-in" routes={ROUTES} />);
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    // email-capture renders the input with placeholder "you@example.com".
    expect(screen.getByPlaceholderText('you@example.com')).not.toBeNull();
  });
});

describe('timezone — edited value is persisted, Back fallback, empty-value guard', () => {
  it('clicking change, then Continue, persists the new selection to user.timezone', async () => {
    render(<RouterProvider initial="timezone" routes={sentinelRoutes('timezone')} />);
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    const editor = document.querySelector('.form-input') as HTMLSelectElement | HTMLInputElement;
    expect(editor).not.toBeNull();
    // If it's a <select>, pick a different known option; else, type a new value.
    if (editor.tagName === 'SELECT') {
      const sel = editor as HTMLSelectElement;
      // Pick a deterministic zone that every tzdb exposes.
      const target = Array.from(sel.options).find((o) => o.value === 'Europe/Paris');
      if (target) {
        sel.value = 'Europe/Paris';
        fireEvent.change(sel);
      }
    } else {
      fireEvent.input(editor, { target: { value: 'Europe/Paris' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('sentinel-preview')).not.toBeNull();
    });
    const db = await openDb();
    const u = await getUser(db);
    db.close();
    expect(u?.timezone).toBe('Europe/Paris');
  });

  it('Continue is disabled when the fallback text input is emptied', () => {
    // Force the text-input fallback path by temporarily hiding
    // Intl.supportedValuesOf from the route's detection.
    const orig = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf =
      undefined;
    try {
      render(<RouterProvider initial="timezone" routes={ROUTES} />);
      fireEvent.click(screen.getByRole('button', { name: /change/i }));
      const editor = document.querySelector('.form-input') as HTMLInputElement;
      expect(editor.tagName).toBe('INPUT');
      fireEvent.input(editor, { target: { value: '' } });
      const btn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    } finally {
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf = orig;
    }
  });

  it('Continue whitespace-only in the fallback input remains disabled', () => {
    const orig = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf =
      undefined;
    try {
      render(<RouterProvider initial="timezone" routes={ROUTES} />);
      fireEvent.click(screen.getByRole('button', { name: /change/i }));
      const editor = document.querySelector('.form-input') as HTMLInputElement;
      fireEvent.input(editor, { target: { value: '   ' } });
      const btn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    } finally {
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf = orig;
    }
  });

  it('Back without history falls back to cloud-opt-in', () => {
    render(<RouterProvider initial="timezone" routes={ROUTES} />);
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByRole('button', { name: /compose in the cloud/i })).not.toBeNull();
  });
});

describe('timezone hydration', () => {
  it('stored timezone hydrates into the readonly label after async IDB load', async () => {
    // Seed IDB with a user row whose timezone is Europe/Paris. Whatever the
    // Intl-detected zone is in this environment, the readonly label must end
    // up displaying the stored value once useSettings hydrates.
    const db = await openDb();
    await setUser(db, {
      uuid: '22222222-2222-4222-8222-222222222222',
      emailConfirmed: false,
      timezone: 'Europe/Paris',
      plan: 'free',
      createdAt: 1,
    });
    db.close();
    render(<RouterProvider initial="timezone" routes={ROUTES} />);
    // The useEffect(!editing) guard should swap the Intl-detected default for
    // the stored zone once the async load resolves.
    await waitFor(() => {
      const label = document.querySelector('[data-testid="tz-detected"]');
      expect(label?.textContent ?? '').toContain('Europe/Paris');
    });
  });

  it('open-editor state is NOT clobbered by a late hydration', async () => {
    // Regression: while the editor is open, a late settings.user change
    // (e.g. a hydration that arrives after the user clicked "change")
    // must NOT overwrite the in-progress edited value. The !editing guard
    // in TimezoneRoute's useEffect is what protects this.
    //
    // We simulate a late hydration by seeding IDB with a "stale" row
    // BEFORE render (so hydration places that value into `value`), then
    // opening the editor, typing a different value, and finally writing
    // a fresh row to IDB with a different timezone AND triggering the
    // hook to pick it up. The hook doesn't auto-poll IDB, so the most
    // faithful way to drive a real storedTimezone change while the same
    // hook instance is mounted is to use the route's own submit path
    // — but that navigates away. Instead, we simulate the scenario by
    // unblocking hydration AFTER the user has already opened the editor.
    //
    // Implementation: seed a "late" IDB row that hydration will deliver,
    // then immediately render. The initial hook load is a microtask away
    // — we race it by synchronously opening the editor BEFORE awaiting
    // the hydration. Because happy-dom + fake-indexeddb resolve getUser
    // on a later tick, clicking "change" in the same synchronous block
    // opens the editor before hydration lands. Then we await; hydration
    // fires, storedTimezone becomes 'Asia/Tokyo', the effect runs, but
    // the !editing guard skips the swap.
    const db = await openDb();
    await setUser(db, {
      uuid: '33333333-3333-4333-8333-333333333333',
      emailConfirmed: false,
      timezone: 'Asia/Tokyo',
      plan: 'free',
      createdAt: 1,
    });
    db.close();

    render(<RouterProvider initial="timezone" routes={sentinelRoutes('timezone')} />);

    // Synchronously — before hydration resolves — open the editor.
    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    const editor = document.querySelector('.form-input') as HTMLSelectElement | HTMLInputElement;
    expect(editor).not.toBeNull();

    // Type / select a value distinct from the seeded 'Asia/Tokyo'.
    const typedValue = 'Europe/London';
    if (editor.tagName === 'SELECT') {
      const sel = editor as HTMLSelectElement;
      // Europe/London is in every tzdb supportedValuesOf output; if for
      // some reason it's absent, fall back to the first non-Asia/Tokyo
      // option so the assertion still has a distinct target.
      const hasLondon = Array.from(sel.options).some((o) => o.value === typedValue);
      const target = hasLondon
        ? typedValue
        : (Array.from(sel.options).find((o) => o.value !== 'Asia/Tokyo')?.value ??
          sel.options[0]?.value ??
          'UTC');
      sel.value = target;
      fireEvent.change(sel);
    } else {
      fireEvent.input(editor, { target: { value: typedValue } });
    }

    const editedSnapshot = (
      document.querySelector('.form-input') as HTMLSelectElement | HTMLInputElement
    ).value;
    expect(editedSnapshot).not.toBe('Asia/Tokyo');

    // Now let the late hydration land. Give microtasks/promises a chance
    // to propagate through useSettings' initial load and the effect.
    await new Promise((r) => setTimeout(r, 50));

    // The editor is still open (editing === true), so the guard must
    // have prevented storedTimezone from clobbering the typed value.
    const editorAfter = document.querySelector('.form-input') as
      | HTMLSelectElement
      | HTMLInputElement;
    expect(editorAfter).not.toBeNull();
    expect(editorAfter.value).toBe(editedSnapshot);
    expect(editorAfter.value).not.toBe('Asia/Tokyo');
  });
});

describe('home — navigation invariants', () => {
  function JumpToHome(): VNode {
    const router = useRouter();
    return (
      <button type="button" onClick={() => router.go('home')}>
        jump
      </button>
    );
  }

  it('never renders a Back button, even when canGoBack is true', () => {
    const routes: Record<RouteName, ComponentType<RouteProps>> = {
      ...ROUTES,
      welcome: JumpToHome,
    };
    render(<RouterProvider initial="welcome" routes={routes} />);
    fireEvent.click(screen.getByRole('button', { name: /jump/i }));
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
  });
});
