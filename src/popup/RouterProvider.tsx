import type { ComponentType, VNode } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useMemo, useState } from 'preact/hooks';
import { type RouteName, writePersistedRoute } from './router.js';

export type RouteProps = Record<never, never>;

export interface RouterApi {
  route: RouteName;
  go: (next: RouteName) => void;
  goBack: () => void;
  canGoBack: boolean;
}

const RouterContext = createContext<RouterApi | null>(null);

export function useRouter(): RouterApi {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used inside <RouterProvider>');
  return ctx;
}

export interface RouterProviderProps {
  initial: RouteName;
  routes: Record<RouteName, ComponentType<RouteProps>>;
}

export function RouterProvider(props: RouterProviderProps): VNode {
  const [route, setRoute] = useState<RouteName>(props.initial);
  const [history, setHistory] = useState<readonly RouteName[]>([]);

  const go = useCallback(
    (next: RouteName) => {
      setHistory((prev) => [...prev, route]);
      setRoute(next);
      void writePersistedRoute(next);
    },
    [route],
  );

  const goBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last === undefined) return prev;
      setRoute(last);
      return prev.slice(0, -1);
    });
  }, []);

  const api: RouterApi = useMemo(
    () => ({ route, go, goBack, canGoBack: history.length > 0 }),
    [route, go, goBack, history.length],
  );

  const Current = props.routes[route];
  return (
    <RouterContext.Provider value={api}>
      <Current />
    </RouterContext.Provider>
  );
}
