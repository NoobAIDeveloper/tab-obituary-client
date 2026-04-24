import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { WEEKLY_ALARM_NAME } from '../../lib/schedule.js';
import { Button } from '../components/Button.js';
import { ConfirmationBanner } from '../components/ConfirmationBanner.js';
import { Screen } from '../components/Screen.js';

type AlarmGetter = () => Promise<chrome.alarms.Alarm | undefined>;

function defaultGetAlarm(): AlarmGetter {
  return async () => {
    if (typeof chrome === 'undefined' || !chrome.alarms || !chrome.alarms.get) {
      return undefined;
    }
    try {
      const alarm = await chrome.alarms.get(WEEKLY_ALARM_NAME);
      return alarm ?? undefined;
    } catch {
      return undefined;
    }
  };
}

export interface HomeRouteProps {
  getAlarm?: AlarmGetter;
}

type NextReport =
  | { state: 'checking' }
  | { state: 'not-scheduled' }
  | { state: 'scheduled'; when: string };

export function HomeRoute(): VNode {
  return <HomeBody />;
}

// Exported separately so tests can inject a deterministic alarm getter; the
// router-facing HomeRoute must remain a zero-prop component for RouteProps.
export function HomeBody(props: HomeRouteProps = {}): VNode {
  const getter = props.getAlarm ?? defaultGetAlarm();
  // If chrome.alarms isn't available we can short-circuit to "not scheduled"
  // synchronously so the muted line doesn't flicker through "checking…" in
  // test environments where the API is simply absent.
  const hasChromeAlarms =
    typeof chrome !== 'undefined' && !!chrome.alarms && typeof chrome.alarms.get === 'function';
  const initial: NextReport =
    props.getAlarm || hasChromeAlarms ? { state: 'checking' } : { state: 'not-scheduled' };
  const [next, setNext] = useState<NextReport>(initial);

  useEffect(() => {
    let cancelled = false;
    getter().then((alarm) => {
      if (cancelled) return;
      if (!alarm || typeof alarm.scheduledTime !== 'number') {
        setNext({ state: 'not-scheduled' });
        return;
      }
      setNext({ state: 'scheduled', when: new Date(alarm.scheduledTime).toLocaleString() });
    });
    return () => {
      cancelled = true;
    };
    // getter is captured from props (or default) — effect runs once per route mount.
  }, [getter]);

  const label =
    next.state === 'scheduled'
      ? next.when
      : next.state === 'checking'
        ? 'checking…'
        : 'not scheduled';

  const openSettings = (): void => {
    // Gate on the API because popup tests and non-extension dev servers don't
    // have chrome.runtime.openOptionsPage — the handler should just no-op.
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.openOptionsPage === 'function'
    ) {
      try {
        chrome.runtime.openOptionsPage();
      } catch {
        // best-effort
      }
    }
  };

  return (
    <Screen
      title="Tab Obituary"
      body={
        <>
          <p>A chronicle of your curiosity.</p>
          <p class="muted">Next report: {label}</p>
          <ConfirmationBanner />
        </>
      }
    >
      <Button variant="ghost" onClick={openSettings}>
        Settings
      </Button>
    </Screen>
  );
}
