import type { JSX, VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { canonicalDomain, isValidBlocklistDomain } from '../../lib/url-normalize.js';
import { useBlocklist } from '../hooks/useBlocklist.js';

function canonicalizeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const direct = canonicalDomain(trimmed);
  if (direct) return direct;
  return canonicalDomain(`https://${trimmed}`);
}

export function BlocklistRoute(): VNode {
  const { loading, entries, add, remove } = useBlocklist();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = input.trim();
  const canonical = useMemo(() => canonicalizeInput(input), [input]);
  const isValid = isValidBlocklistDomain(canonical);
  const helper =
    trimmed.length === 0 ? 'e.g. example.com' : isValid ? null : 'Enter a domain like example.com';

  const onSubmit = async (ev: JSX.TargetedEvent<HTMLFormElement, Event>): Promise<void> => {
    ev.preventDefault();
    if (!trimmed) {
      setError('Enter a domain.');
      return;
    }
    if (!isValid) {
      // Enter-to-submit on invalid input is a silent no-op beyond surfacing
      // the helper text already shown below the input.
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await add(trimmed);
      setInput('');
      setStatus(
        `Blocked ${result.domain}. Removed ${result.purgedEvents} past event${
          result.purgedEvents === 1 ? '' : 's'
        }.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add domain.');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (domain: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await remove(domain);
      setStatus(`Removed ${domain} from blocklist.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove domain.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <h2>Blocklist</h2>
      <p class="muted">
        Blocklisted pages won't be captured going forward, and matching past events are removed now.
        Removing a domain later does NOT restore deleted events.
      </p>
      <form class="blocklist-form" onSubmit={onSubmit}>
        <input
          type="text"
          class="form-input"
          placeholder="example.com"
          value={input}
          onInput={(ev) => setInput((ev.currentTarget as HTMLInputElement).value)}
          disabled={busy || loading}
          aria-label="Domain to block"
        />
        <button type="submit" class="btn btn-primary" disabled={busy || loading || !isValid}>
          {busy ? 'Saving…' : 'Add domain'}
        </button>
      </form>
      {helper ? <p class="muted blocklist-helper">{helper}</p> : null}
      {status ? <p class="inline-status">{status}</p> : null}
      {error ? <p class="inline-error">{error}</p> : null}
      {loading ? (
        <p class="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p class="muted">No domains blocked yet.</p>
      ) : (
        <ul class="blocklist-list">
          {entries.map((e) => (
            <li key={e.domain} class="blocklist-row">
              <span>
                <strong>{e.domain}</strong>{' '}
                <span class="blocklist-row-meta">
                  added {new Date(e.addedAt).toLocaleDateString()}
                </span>
              </span>
              <button
                type="button"
                class="blocklist-remove"
                aria-label={`Remove ${e.domain}`}
                onClick={() => {
                  void onRemove(e.domain);
                }}
                disabled={busy}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
