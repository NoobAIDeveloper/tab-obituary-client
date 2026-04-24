import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { BlocklistRoute } from './routes/blocklist.js';
import { DataRoute } from './routes/data.js';
import { TrackingRoute } from './routes/tracking.js';

type Tab = 'blocklist' | 'tracking' | 'data';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'blocklist', label: 'Blocklist' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'data', label: 'Data' },
];

export function App(): VNode {
  const [active, setActive] = useState<Tab>('blocklist');

  return (
    <main>
      <h1>Tab Obituary — Settings</h1>
      <nav class="options-nav" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            class="options-nav-btn"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {active === 'blocklist' ? <BlocklistRoute /> : null}
      {active === 'tracking' ? <TrackingRoute /> : null}
      {active === 'data' ? <DataRoute /> : null}
    </main>
  );
}
