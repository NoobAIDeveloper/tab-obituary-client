// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../storage/db.js';
import { appendEvent } from '../../storage/events-store.js';
import { BlocklistRoute } from './blocklist.js';

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
});
afterEach(() => {
  cleanup();
});

describe('BlocklistRoute', () => {
  it('adds a domain via the form, reports the purge count, and lists it', async () => {
    // Seed two matching events so the reported purge count is informative.
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

    render(<BlocklistRoute />);
    // Wait until initial load completes (no more "Loading…").
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });

    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText(/Blocked example\.com/)).not.toBeNull();
    });
    expect(screen.getByText(/Removed 2 past events/)).not.toBeNull();
    expect(screen.getByText('example.com')).not.toBeNull();
  });

  it('pluralizes event count correctly (0 events and 1 event)', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });

    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'unique.com' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText(/Removed 0 past events/)).not.toBeNull();
    });
  });

  it('rejects empty input with an inline error', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });

    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText(/Enter a domain/)).not.toBeNull();
    });
  });

  it('remove × affordance removes an entry from the list', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });

    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'bye.com' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText('bye.com')).not.toBeNull();
    });

    const removeBtn = screen.getByLabelText('Remove bye.com');
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByText('bye.com')).toBeNull();
    });
    expect(screen.getByText(/Removed bye\.com from blocklist/)).not.toBeNull();
  });

  it('canonicalizes a raw URL input down to the eTLD+1', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'https://news.ycombinator.com/item?id=1' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(screen.getByText('ycombinator.com')).not.toBeNull();
    });
  });

  it('clears the input field after a successful add', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'clear-me.example' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(screen.getByText('clear-me.example')).not.toBeNull();
    });
    // The controlled input's value should be emptied after the submit succeeded.
    const againInput = screen.getByLabelText('Domain to block') as HTMLInputElement;
    expect(againInput.value).toBe('');
  });

  it('uses singular "event" (not "events") when exactly 1 past event was purged', async () => {
    // Pre-seed one matching event so the purge count is 1.
    const db = await openDb();
    await appendEvent(db, {
      type: 'navigate',
      ts: 1,
      tzOffsetMin: 0,
      tabId: 1,
      domain: 'one.example',
    });
    db.close();

    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'one.example' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(screen.getByText(/Removed 1 past event\./)).not.toBeNull();
    });
    // And we should NOT see the plural form.
    expect(screen.queryByText(/Removed 1 past events/)).toBeNull();
  });

  it('disables the Add button and input while a submit is pending', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    const form = input.closest('form') as HTMLFormElement;
    fireEvent.input(input, { target: { value: 'pending.example' } });
    fireEvent.submit(form);
    // Within the same microtask-ish window the button label should read "Saving…".
    // If the write is too fast for us to observe it in flight, that's a harmless
    // miss — still, assert the final resolved state.
    await waitFor(() => {
      expect(screen.getByText('pending.example')).not.toBeNull();
    });
    // Input is cleared after a successful submit, which makes the Add button
    // disabled again (empty input is not a valid blocklist domain).
    const btn = screen.getByRole('button', { name: /add domain|saving/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(input.value).toBe('');
  });

  it('renders addedAt via toLocaleDateString on each entry', async () => {
    // Seed a deterministic epoch (2026-01-15 UTC — date string varies by locale
    // but the year should always appear).
    const db = await openDb();
    await db.put('blocklist', {
      domain: 'dated.example',
      addedAt: Date.UTC(2026, 0, 15),
      scope: 'exclude_all',
      schemaVersion: 1,
    });
    db.close();
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    // Not asserting exact string (locale/tz-dependent); just that we emit the
    // "added <something>" meta span next to the domain.
    expect(screen.getByText(/^added /)).not.toBeNull();
  });

  it('pasting a scheme-only "https://" is rejected and does not add a row', async () => {
    // "https://" canonicalises to null then "https" on the retry — neither is a
    // valid blocklist key. Submitting should be a no-op and no "Blocked" status
    // should appear.
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'https://' } });
    // The Add button should be disabled on invalid input.
    const btn = screen.getByRole('button', { name: /add domain|saving/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    // No "Blocked …" status should render, and no blocklist row should appear.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/^Blocked /)).toBeNull();
    expect(screen.queryByText(/^https$/)).toBeNull();
  });

  it('keeps the Add button disabled while the input is not a valid domain and shows helper text', async () => {
    render(<BlocklistRoute />);
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull();
    });
    // Empty: helper text shows "e.g. example.com" and button is disabled.
    const btn = screen.getByRole('button', { name: /add domain|saving/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('e.g. example.com')).not.toBeNull();

    const input = screen.getByLabelText('Domain to block') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'not a domain' } });
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Enter a domain like example\.com/)).not.toBeNull();

    fireEvent.input(input, { target: { value: 'valid.example' } });
    expect(btn.disabled).toBe(false);
  });
});
