// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the backend client surface so the account-delete cascade in DataRoute
// doesn't try to hit the network. Must be hoisted above the DataRoute import.
vi.mock('../../backend/client.js', () => ({
  deleteAccount: vi.fn(),
}));

import { deleteAccount } from '../../backend/client.js';
import { openDb } from '../../storage/db.js';
import { appendEvent, countEvents } from '../../storage/events-store.js';
import { DataRoute } from './data.js';

const mockDeleteAccount = vi.mocked(deleteAccount);

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// happy-dom doesn't implement HTMLDialogElement.showModal/close. Provide the
// minimum shim that our component needs so the render path doesn't blow up.
function stubDialog(): void {
  const proto = (globalThis as unknown as { HTMLDialogElement?: typeof HTMLDialogElement })
    .HTMLDialogElement?.prototype;
  if (!proto) return;
  if (typeof proto.showModal !== 'function') {
    Object.defineProperty(proto, 'showModal', {
      configurable: true,
      writable: true,
      value: function showModal(this: HTMLDialogElement): void {
        this.setAttribute('open', '');
      },
    });
  }
  if (typeof proto.close !== 'function') {
    Object.defineProperty(proto, 'close', {
      configurable: true,
      writable: true,
      value: function close(this: HTMLDialogElement): void {
        this.removeAttribute('open');
      },
    });
  }
}

describe('DataRoute — export', () => {
  it('triggers a download with a tab-obituary-YYYY-MM-DD.json filename and revokes the URL', async () => {
    stubDialog();
    // Seed one event so the exported bundle is non-trivial.
    const db = await openDb();
    await appendEvent(db, {
      type: 'activate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    db.close();

    const createSpy = vi.fn().mockReturnValue('blob:fake-url');
    const revokeSpy = vi.fn();
    (globalThis as unknown as { URL: typeof URL }).URL = Object.assign(URL, {
      createObjectURL: createSpy as unknown as typeof URL.createObjectURL,
      revokeObjectURL: revokeSpy as unknown as typeof URL.revokeObjectURL,
    });
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        const el = origCreate(tag);
        if (tag === 'a') {
          // Replace click so happy-dom doesn't try to navigate.
          (el as HTMLAnchorElement).click = clickSpy;
        }
        return el;
      });

    render(<DataRoute />);
    // Give the useEffect a tick to open the DB handle.
    await new Promise((r) => setTimeout(r, 5));

    const button = screen.getByText('Export my data');
    fireEvent.click(button);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake-url');

    // Filename shape check.
    const anchorCalls = createElementSpy.mock.results
      .map((r) => r.value as HTMLElement)
      .filter((el) => el.tagName === 'A') as HTMLAnchorElement[];
    const anchor = anchorCalls[0];
    expect(anchor?.download).toMatch(/^tab-obituary-\d{4}-\d{2}-\d{2}\.json$/);

    await waitFor(() => {
      expect(screen.getByText(/Exported 1 events and 0 sessions/)).not.toBeNull();
    });
  });
});

describe('DataRoute — delete confirmation ladder', () => {
  it('cancel path does not wipe data', async () => {
    stubDialog();
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    db.close();

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete all my browsing data'));
    // Dialog renders the cancel button "Keep my data".
    await waitFor(() => {
      expect(screen.getByText('Keep my data')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Keep my data'));

    const checkDb = await openDb();
    expect(await countEvents(checkDb)).toBe(1);
    checkDb.close();
  });

  it('confirm path wipes events and reports counts', async () => {
    stubDialog();
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    await appendEvent(db, {
      type: 'navigate',
      ts: 2,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    db.close();

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete all my browsing data'));
    await waitFor(() => {
      expect(screen.getByText('Delete')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByText(/Deleted 2 events and 0 sessions/)).not.toBeNull();
    });

    const checkDb = await openDb();
    expect(await countEvents(checkDb)).toBe(0);
    checkDb.close();
  });
});

describe('DataRoute — export content integrity', () => {
  it('creates a Blob with application/json MIME and an export bundle payload', async () => {
    stubDialog();

    // Seed one event so the bundle is non-trivial.
    const db = await openDb();
    await appendEvent(db, {
      type: 'activate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    db.close();

    // Capture the Blob handed to createObjectURL so we can assert MIME + payload.
    const blobs: Blob[] = [];
    const createSpy = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:fake';
    });
    const revokeSpy = vi.fn();
    (globalThis as unknown as { URL: typeof URL }).URL = Object.assign(URL, {
      createObjectURL: createSpy as unknown as typeof URL.createObjectURL,
      revokeObjectURL: revokeSpy as unknown as typeof URL.revokeObjectURL,
    });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = (): void => undefined;
      }
      return el;
    });

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.click(screen.getByText('Export my data'));

    await waitFor(() => {
      expect(blobs).toHaveLength(1);
    });
    const blob = blobs[0] as Blob;
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events).toHaveLength(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake');
  });

  it('filename date matches a stubbed Date for deterministic verification', async () => {
    stubDialog();
    // Freeze Date to 2026-02-07 local — getFullYear/Month/Date return these.
    const frozen = new Date(2026, 1, 7, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(frozen);

    const createSpy = vi.fn().mockReturnValue('blob:frozen');
    (globalThis as unknown as { URL: typeof URL }).URL = Object.assign(URL, {
      createObjectURL: createSpy as unknown as typeof URL.createObjectURL,
      revokeObjectURL: (() => undefined) as unknown as typeof URL.revokeObjectURL,
    });
    const anchors: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = (): void => undefined;
        anchors.push(el as HTMLAnchorElement);
      }
      return el;
    });

    render(<DataRoute />);
    await vi.advanceTimersByTimeAsync(10);
    fireEvent.click(screen.getByText('Export my data'));
    await vi.advanceTimersByTimeAsync(50);

    // Not wrapped in waitFor because vi.useFakeTimers + waitFor don't cooperate.
    // If something is wrong we'll see empty anchors and the expect below fails.
    vi.useRealTimers();
    expect(anchors[0]?.download).toBe('tab-obituary-2026-02-07.json');
  });
});

describe('DataRoute — confirmation modal', () => {
  it('re-opens cleanly after the "Keep my data" path closes it', async () => {
    stubDialog();
    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete all my browsing data'));
    await waitFor(() => {
      expect(screen.getByText('Keep my data')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Keep my data'));
    // Re-open.
    fireEvent.click(screen.getByText('Delete all my browsing data'));
    await waitFor(() => {
      expect(screen.getByText('Delete')).not.toBeNull();
    });
  });

  it('reports 0 events and 0 sessions on confirm when the DB is empty', async () => {
    stubDialog();
    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete all my browsing data'));
    await waitFor(() => {
      expect(screen.getByText('Delete')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByText(/Deleted 0 events and 0 sessions/)).not.toBeNull();
    });
  });

  it('does not wipe preserved settings rows on confirm', async () => {
    stubDialog();
    const db = await openDb();
    await db.put('settings', {
      key: 'user',
      value: {
        uuid: '00000000-0000-4000-8000-000000000000',
        emailConfirmed: false,
        timezone: 'UTC',
        plan: 'free',
        createdAt: 1,
      },
      schemaVersion: 1,
    });
    db.close();

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.click(screen.getByText('Delete all my browsing data'));
    await waitFor(() => {
      expect(screen.getByText('Delete')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(screen.getByText(/Deleted 0 events/)).not.toBeNull();
    });

    const after = await openDb();
    const row = await after.get('settings', 'user');
    expect(row?.value.uuid).toBe('00000000-0000-4000-8000-000000000000');
    after.close();
  });
});

// ---------------------------------------------------------------------------
// Account-delete cascade — smoke test only. The cascade module has its own
// unit tests; here we just prove the UI wires click → confirm → cascade.
// ---------------------------------------------------------------------------

describe('DataRoute — account delete cascade', () => {
  beforeEach(() => {
    mockDeleteAccount.mockReset();
    // A minimal chrome.storage.local stub so the cascade's storage step
    // runs without throwing. The cascade also writes a progress record.
    const data: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => {
            if (key in data) return { [key]: data[key] };
            return {};
          }),
          set: vi.fn(async (patch: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(patch)) data[k] = v;
          }),
          remove: vi.fn(async (key: string) => {
            delete data[key];
          }),
        },
      },
    };
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: clean up chrome binding between tests
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('click "Delete my account" opens the modal and success renders confirmation', async () => {
    stubDialog();
    mockDeleteAccount.mockResolvedValue({
      ok: true,
      data: { status: 'deleted' },
    });

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete my account'));
    // Modal confirm button text.
    await waitFor(() => {
      expect(screen.getByText('Delete account')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete account'));

    await waitFor(() => {
      expect(
        screen.getByText('Your account and all local data have been deleted.'),
      ).not.toBeNull();
    });

    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('cancel path closes the modal without calling deleteAccount', async () => {
    stubDialog();

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => {
      expect(screen.getByText('Keep my account')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Keep my account'));

    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('modal body contains account-delete copy (differs from data-wipe body)', async () => {
    stubDialog();
    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));
    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => {
      expect(
        screen.getByText(/We'll remove your account on our server/),
      ).not.toBeNull();
    });
  });

  it('account-delete failure renders error copy and does NOT render success', async () => {
    stubDialog();
    mockDeleteAccount.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'bad_request',
    });

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => {
      expect(screen.getByText('Delete account')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete account'));

    await waitFor(() => {
      expect(
        screen.getByText(
          /We couldn't complete deletion: bad_request\. Try again in a minute\./,
        ),
      ).not.toBeNull();
    });
    // Success copy must be absent.
    expect(
      screen.queryByText('Your account and all local data have been deleted.'),
    ).toBeNull();
  });

  it('modal closes before the cascade resolves (status appears in the page, not the dialog)', async () => {
    stubDialog();

    // Hold the backend resolution until we assert the modal is closed.
    let resolveFetch: (v: unknown) => void = () => undefined;
    mockDeleteAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => {
      expect(screen.getByText('Delete account')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete account'));

    // The "Deleting account…" status should appear in-page BEFORE we resolve.
    await waitFor(() => {
      expect(screen.getByText(/Deleting account/)).not.toBeNull();
    });
    // The dialog's `open` attribute should have been removed by the
    // ConfirmModal's useEffect once `accountConfirmOpen` flipped to false.
    const dialog = document.querySelector('dialog.confirm-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute('open')).toBe(false);

    // Now resolve the cascade.
    resolveFetch({ ok: true, data: { status: 'deleted' } });

    await waitFor(() => {
      expect(
        screen.getByText('Your account and all local data have been deleted.'),
      ).not.toBeNull();
    });
  });

  it('rapid double-click on the same "Delete account" button only invokes the cascade once', async () => {
    stubDialog();

    // Hold the first deleteAccount call unresolved so we can issue a second
    // click while the handler is still in flight.
    let resolveFetch: (v: unknown) => void = () => undefined;
    mockDeleteAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => {
      expect(screen.getByText('Delete account')).not.toBeNull();
    });

    // Capture the button reference BEFORE clicking so we can synchronously
    // dispatch a second click on the same node even after the first click
    // closes the modal in state. This mimics a user who double-clicks.
    const confirmBtn = screen.getByText('Delete account');
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    // Wait until the cascade has actually invoked the backend mock so
    // `resolveFetch` captures the real pending promise.
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalled();
    });

    // Let the single in-flight cascade complete.
    resolveFetch({ ok: true, data: { status: 'deleted' } });

    await waitFor(() => {
      expect(
        screen.getByText('Your account and all local data have been deleted.'),
      ).not.toBeNull();
    });
    // Assert the cascade was only invoked once. This relies on the handler
    // guarding against re-entry (e.g. by checking accountBusy before doing
    // work, or by the modal close + button-unmount landing before a second
    // synchronous click can reach the click listener).
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it('"Delete my account" button is disabled while the cascade is busy', async () => {
    stubDialog();

    let resolveFetch: (v: unknown) => void = () => undefined;
    mockDeleteAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    fireEvent.click(screen.getByText('Delete my account'));
    await waitFor(() => {
      expect(screen.getByText('Delete account')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete account'));

    // While busy, the outer "Delete my account" button should be disabled.
    await waitFor(() => {
      const btn = screen.getByText('Delete my account') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    resolveFetch({ ok: true, data: { status: 'deleted' } });

    await waitFor(() => {
      expect(
        screen.getByText('Your account and all local data have been deleted.'),
      ).not.toBeNull();
    });
  });

  it('account cascade does NOT regress the "Delete all my browsing data" soft-delete', async () => {
    stubDialog();
    // Seed an event so the soft-delete has something to count.
    const db = await openDb();
    await appendEvent(db, {
      type: 'activate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'example.com',
    });
    db.close();

    render(<DataRoute />);
    await new Promise((r) => setTimeout(r, 5));

    // Regular soft-delete should still open a modal with its own copy.
    fireEvent.click(screen.getByText('Delete all my browsing data'));
    await waitFor(() => {
      expect(screen.getByText('Keep my data')).not.toBeNull();
    });
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(screen.getByText(/Deleted 1 events/)).not.toBeNull();
    });
    // The backend was not touched — the soft-delete is local-only.
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });
});
