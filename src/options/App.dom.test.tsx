// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FDBFactory();
});
afterEach(() => {
  cleanup();
});

describe('options App', () => {
  it('renders the three tabs and switches between them', async () => {
    render(<App />);
    // Header should appear immediately.
    expect(screen.getByText('Tab Obituary — Settings')).not.toBeNull();
    // Default is the blocklist section — assert on the blocklist form.
    await waitFor(() => {
      expect(screen.getByLabelText('Domain to block')).not.toBeNull();
    });

    // Switch to Tracking.
    fireEvent.click(screen.getByRole('tab', { name: 'Tracking' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Pause tracking')).not.toBeNull();
    });

    // Switch to Data.
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    await waitFor(() => {
      expect(screen.getByText('Export my data')).not.toBeNull();
    });
  });

  it('marks exactly one tab aria-selected at a time', async () => {
    render(<App />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    // Initially Blocklist is selected.
    const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe('Blocklist');

    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    await waitFor(() => {
      const afterSelected = screen
        .getAllByRole('tab')
        .filter((t) => t.getAttribute('aria-selected') === 'true');
      expect(afterSelected).toHaveLength(1);
      expect(afterSelected[0]?.textContent).toBe('Data');
    });
  });

  it('does not render the inactive tab bodies in the DOM', async () => {
    render(<App />);
    // Blocklist is the default — its input should be present, Tracking and
    // Data controls should NOT be.
    await waitFor(() => {
      expect(screen.getByLabelText('Domain to block')).not.toBeNull();
    });
    expect(screen.queryByLabelText('Pause tracking')).toBeNull();
    expect(screen.queryByText('Export my data')).toBeNull();
  });

  it('switching tabs back and forth preserves the page header and nav (no unmount loop)', async () => {
    render(<App />);
    expect(screen.getByText('Tab Obituary — Settings')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Tracking' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Pause tracking')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Blocklist' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Domain to block')).not.toBeNull();
    });
    // Header and tabs still there.
    expect(screen.getByText('Tab Obituary — Settings')).not.toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });
});
