import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { useRouter } from '../RouterProvider.js';
import { Button } from '../components/Button.js';
import { OnboardingActions } from '../components/OnboardingActions.js';
import { Progress } from '../components/Progress.js';
import { Screen } from '../components/Screen.js';
import { useSettings } from '../hooks/useSettings.js';
import { nextOnboardingRoute } from '../router.js';

export function TrackingOptInRoute(): VNode {
  const router = useRouter();
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (trackingOptIn: boolean): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await settings.updatePrivacy({ trackingOptIn });
      router.go(nextOnboardingRoute('tracking-opt-in') ?? 'home');
    } catch (_err) {
      setError('Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Track your browsing"
      body={
        <>
          <p>Tab Obituary watches which pages you visit so it can write about them later.</p>
          <p class="muted">Data stays in your browser unless you opt into cloud delivery.</p>
          <div class="choice-group">
            <Button onClick={() => void choose(true)} disabled={busy}>
              Yes, track my browsing
            </Button>
            <Button variant="secondary" onClick={() => void choose(false)} disabled={busy}>
              Not right now
            </Button>
          </div>
          <Progress route="tracking-opt-in" />
          {error ? <p class="error">{error}</p> : null}
        </>
      }
    >
      <OnboardingActions current="tracking-opt-in">{null}</OnboardingActions>
    </Screen>
  );
}
