import { exportBundleSchema } from '@tabob/shared';
import type { IDBPDatabase } from 'idb';
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { runDeleteCascade } from '../../storage/delete-cascade.js';
import type { TabObituaryDB } from '../../storage/db.js';
import { openDb } from '../../storage/db.js';
import { deleteAllData, exportAllData } from '../../storage/purge.js';
import { ConfirmModal } from '../components/ConfirmModal.js';

function filenameFor(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `tab-obituary-${y}-${m}-${d}.json`;
}

// Trigger a download via a temporary anchor — the standard browser recipe.
// URL.createObjectURL is mocked in DOM tests so we can assert the filename
// and payload round-trip without touching real download plumbing.
function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function DataRoute(): VNode {
  const dbRef = useRef<IDBPDatabase<TabObituaryDB> | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Account-delete UI state is kept separate from the soft-delete state
  // above so a cascade running in the background doesn't interleave its
  // status messages with "Export my data" toasts.
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountConfirmOpen, setAccountConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await openDb();
        if (cancelled) {
          db.close();
          return;
        }
        dbRef.current = db;
      } catch (err) {
        // The individual action handlers surface a user-facing error when the
        // DB is still missing at click time, so we just log here.
        console.warn('DataRoute: openDb failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function ensureDb(): Promise<IDBPDatabase<TabObituaryDB>> {
    if (dbRef.current) return dbRef.current;
    const db = await openDb();
    dbRef.current = db;
    return db;
  }

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const db = await ensureDb();
      const bundle = await exportAllData(db);
      // Validate before writing the file: catches schema drift that would
      // produce an invalid JSON for downstream re-import.
      exportBundleSchema.parse(bundle);
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      triggerDownload(filenameFor(new Date()), blob);
      setStatus(`Exported ${bundle.events.length} events and ${bundle.sessions.length} sessions.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  const onRequestDelete = (): void => {
    setStatus(null);
    setError(null);
    setConfirmOpen(true);
  };

  const onConfirmDelete = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const db = await ensureDb();
      // Count before the wipe so the confirmation message is meaningful.
      const [eventCount, sessionCount] = await Promise.all([
        db.count('events'),
        db.count('sessions'),
      ]);
      await deleteAllData(db);
      setStatus(`Deleted ${eventCount} events and ${sessionCount} sessions.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const onCancelDelete = (): void => {
    setConfirmOpen(false);
  };

  // -- Account-delete cascade -----------------------------------------------

  const onRequestAccountDelete = (): void => {
    setAccountStatus(null);
    setAccountError(null);
    setAccountConfirmOpen(true);
  };

  // A plain ref used as a re-entrancy latch. State-based `accountBusy`
  // cannot guard against a synchronous double-click because React/Preact
  // state updates don't land until the next render, which happens after
  // the current batched click handlers have all run. The ref is set
  // imperatively so the second click sees it immediately.
  const accountCascadeInFlight = useRef(false);

  const onConfirmAccountDelete = async (): Promise<void> => {
    if (accountCascadeInFlight.current) return;
    accountCascadeInFlight.current = true;
    setAccountBusy(true);
    setAccountError(null);
    setAccountStatus('Deleting account…');
    // Close the modal up front so the user sees the "Deleting account…"
    // state on the page instead of behind the dialog.
    setAccountConfirmOpen(false);
    try {
      const db = await ensureDb();
      const result = await runDeleteCascade(db);
      if (result.status === 'completed') {
        setAccountStatus('Your account and all local data have been deleted.');
      } else {
        setAccountStatus(null);
        setAccountError(
          `We couldn't complete deletion: ${result.error}. Try again in a minute.`,
        );
      }
    } catch (err) {
      setAccountStatus(null);
      const message = err instanceof Error ? err.message : 'unknown error';
      setAccountError(
        `We couldn't complete deletion: ${message}. Try again in a minute.`,
      );
    } finally {
      setAccountBusy(false);
      accountCascadeInFlight.current = false;
    }
  };

  const onCancelAccountDelete = (): void => {
    setAccountConfirmOpen(false);
  };

  return (
    <>
      <section class="card">
        <h2>Your data</h2>
        <p class="muted">
          Everything you see here lives on this device only. Export a copy anytime, or delete it all
          in one click.
        </p>
        <div class="data-actions">
          <button
            type="button"
            class="btn btn-secondary"
            onClick={() => {
              void onExport();
            }}
            disabled={busy}
          >
            Export my data
          </button>
          <button
            type="button"
            class="btn btn-destructive"
            onClick={onRequestDelete}
            disabled={busy}
          >
            Delete all my browsing data
          </button>
        </div>
        {status ? <p class="inline-status">{status}</p> : null}
        {error ? <p class="inline-error">{error}</p> : null}
        <ConfirmModal
          open={confirmOpen}
          title="Delete everything?"
          body="This removes every event, session, summary, and blocklist entry from this device. Your settings and email preference remain. This cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Keep my data"
          onConfirm={() => {
            void onConfirmDelete();
          }}
          onCancel={onCancelDelete}
        />
      </section>
      <section class="card">
        <h2>Your account</h2>
        <p class="muted">
          Deleting your account removes your email and all server-side records, signs you out of
          this device, and wipes every local event, session, summary, and setting. This cannot be
          undone.
        </p>
        <div class="data-actions">
          <button
            type="button"
            class="btn btn-destructive"
            onClick={onRequestAccountDelete}
            disabled={accountBusy}
          >
            Delete my account
          </button>
        </div>
        {accountStatus ? <p class="inline-status">{accountStatus}</p> : null}
        {accountError ? <p class="inline-error">{accountError}</p> : null}
        <ConfirmModal
          open={accountConfirmOpen}
          title="Delete your account?"
          body="We'll remove your account on our server, sign you out here, and delete all local browsing data, sessions, summaries, and settings. This cannot be undone."
          confirmLabel="Delete account"
          cancelLabel="Keep my account"
          onConfirm={() => {
            void onConfirmAccountDelete();
          }}
          onCancel={onCancelAccountDelete}
        />
      </section>
    </>
  );
}
