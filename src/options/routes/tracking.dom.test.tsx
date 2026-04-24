// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../storage/db.js';
import { getPrivacy } from '../../storage/settings-store.js';
import { TrackingRoute } from './tracking.js';

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
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
  saved = (globalThis as unknown as { chrome?: ChromeHandle }).chrome;
  deleteChrome();
});
afterEach(() => {
  cleanup();
  if (saved === undefined) deleteChrome();
  else setChrome(saved);
});

describe('TrackingRoute', () => {
  it('persists trackingPaused=true when the toggle is clicked and notifies the SW', async () => {
    const send = vi.fn();
    setChrome({ runtime: { sendMessage: send } });

    render(<TrackingRoute />);
    const checkbox = (await screen.findByLabelText('Pause tracking')) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.change(checkbox, { target: { checked: true } });

    await waitFor(async () => {
      const db = await openDb();
      const p = await getPrivacy(db);
      db.close();
      expect(p?.trackingPaused).toBe(true);
    });
    expect(send).toHaveBeenCalledWith({ type: 'gates:invalidate' });
  });

  it('survives a missing chrome.runtime (no crash, still persists)', async () => {
    // chrome was cleared in beforeEach; nothing further to do.
    render(<TrackingRoute />);
    const checkbox = (await screen.findByLabelText('Pause tracking')) as HTMLInputElement;
    fireEvent.change(checkbox, { target: { checked: true } });

    await waitFor(async () => {
      const db = await openDb();
      const p = await getPrivacy(db);
      db.close();
      expect(p?.trackingPaused).toBe(true);
    });
  });

  it('reflects an existing paused=true setting on first render', async () => {
    const db = await openDb();
    await db.put('settings', {
      key: 'privacy',
      value: {
        trackingOptIn: true,
        cloudAiOptIn: false,
        trackingPaused: true,
        installedAt: 1,
      },
      schemaVersion: 1,
    });
    db.close();

    render(<TrackingRoute />);
    await waitFor(() => {
      const checkbox = screen.getByLabelText('Pause tracking') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });
  });

  it('does not throw if chrome.runtime.sendMessage itself throws synchronously', async () => {
    setChrome({
      runtime: {
        sendMessage: () => {
          throw new Error('boom');
        },
      },
    });
    render(<TrackingRoute />);
    const checkbox = (await screen.findByLabelText('Pause tracking')) as HTMLInputElement;
    expect(() => fireEvent.change(checkbox, { target: { checked: true } })).not.toThrow();
    await waitFor(async () => {
      const db = await openDb();
      const p = await getPrivacy(db);
      db.close();
      expect(p?.trackingPaused).toBe(true);
    });
  });

  it('does not throw if chrome is defined but chrome.runtime is missing', async () => {
    setChrome({});
    render(<TrackingRoute />);
    const checkbox = (await screen.findByLabelText('Pause tracking')) as HTMLInputElement;
    expect(() => fireEvent.change(checkbox, { target: { checked: true } })).not.toThrow();
    await waitFor(async () => {
      const db = await openDb();
      const p = await getPrivacy(db);
      db.close();
      expect(p?.trackingPaused).toBe(true);
    });
  });

  it('rapid toggle off-on-off settles on the final click (off)', async () => {
    const send = vi.fn();
    setChrome({ runtime: { sendMessage: send } });

    // Seed privacy.trackingPaused = true so the initial state is ON.
    const seedDb = await openDb();
    await seedDb.put('settings', {
      key: 'privacy',
      value: {
        trackingOptIn: true,
        cloudAiOptIn: false,
        trackingPaused: true,
        installedAt: 1,
      },
      schemaVersion: 1,
    });
    seedDb.close();

    render(<TrackingRoute />);
    const checkbox = (await screen.findByLabelText('Pause tracking')) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    // Fire three change events in quick succession: off, on, off.
    fireEvent.change(checkbox, { target: { checked: false } });
    fireEvent.change(checkbox, { target: { checked: true } });
    fireEvent.change(checkbox, { target: { checked: false } });

    // The useSettings per-key chain serializes the writes. Wait for the DB to
    // reach the last-sent value.
    await waitFor(async () => {
      const db = await openDb();
      const p = await getPrivacy(db);
      db.close();
      expect(p?.trackingPaused).toBe(false);
    });
    // The SW was pinged at least once per successful write; not asserting
    // exact count because batched React state flushes can coalesce.
    expect(send).toHaveBeenCalledWith({ type: 'gates:invalidate' });
  });
});
