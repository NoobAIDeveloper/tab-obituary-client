import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { useSettings } from '../../popup/hooks/useSettings.js';

// The options page runs in its own frame and cannot reach the service worker's
// in-memory gate caches directly — this message tells the SW to drop them.
function notifyGateInvalidate(): void {
  if (
    typeof chrome === 'undefined' ||
    !chrome.runtime ||
    typeof chrome.runtime.sendMessage !== 'function'
  ) {
    return;
  }
  try {
    // We intentionally ignore the reply; the SW acks but there's nothing to do
    // with it and some MV3 environments reject the promise when no listener
    // answers synchronously.
    void chrome.runtime.sendMessage({ type: 'gates:invalidate' });
  } catch {
    // best-effort
  }
}

export function TrackingRoute(): VNode {
  const { privacy, loading, updatePrivacy } = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paused = privacy?.trackingPaused ?? false;

  const onChange = async (ev: JSX.TargetedEvent<HTMLInputElement, Event>): Promise<void> => {
    const next = (ev.currentTarget as HTMLInputElement).checked;
    setBusy(true);
    setError(null);
    try {
      await updatePrivacy({ trackingPaused: next });
      notifyGateInvalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <h2>Tracking</h2>
      <label class="toggle-row">
        <input
          type="checkbox"
          checked={paused}
          onChange={(ev) => {
            void onChange(ev);
          }}
          disabled={busy || loading}
          aria-label="Pause tracking"
        />
        <span>Pause tracking</span>
      </label>
      <p class="muted">While paused, no new events are captured. Flip it off to resume.</p>
      {error ? <p class="inline-error">{error}</p> : null}
    </section>
  );
}
