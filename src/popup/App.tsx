import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { RouterProvider } from './RouterProvider.js';
import { type RouteName, readPersistedRoute } from './router.js';
import { ROUTES } from './routes/index.js';

type Resolved = { status: 'loading' } | { status: 'ready'; route: RouteName };

export function App(): VNode {
  const [resolved, setResolved] = useState<Resolved>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    readPersistedRoute().then((r) => {
      if (cancelled) return;
      setResolved({ status: 'ready', route: r ?? 'welcome' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (resolved.status === 'loading') {
    return (
      <section class="screen">
        <header class="screen-header">
          <h1>Tab Obituary</h1>
        </header>
      </section>
    );
  }

  return <RouterProvider initial={resolved.route} routes={ROUTES} />;
}
