import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { useRouter } from '../RouterProvider.js';
import { Button } from '../components/Button.js';
import { OnboardingActions } from '../components/OnboardingActions.js';
import { Progress } from '../components/Progress.js';
import { Screen } from '../components/Screen.js';
import { useSettings } from '../hooks/useSettings.js';
import { nextOnboardingRoute } from '../router.js';

export function WelcomeRoute(): VNode {
  const router = useRouter();
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onContinue = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      // Default-synthesize user + privacy rows on first ever open. Empty
      // patches merge with the in-memory row (or the default if absent) and
      // persist — preserving existing installedAt on a replay.
      await settings.updateUser({});
      await settings.updatePrivacy({});
      router.go(nextOnboardingRoute('welcome') ?? 'home');
    } catch (_err) {
      setError('Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Tab Obituary"
      body={
        <>
          <p>A chronicle of your curiosity, delivered every Sunday.</p>
          <p class="muted">Welcome. Let's set up your weekly report.</p>
          <Progress route="welcome" />
          {error ? <p class="error">{error}</p> : null}
        </>
      }
    >
      <OnboardingActions current="welcome">
        <Button onClick={onContinue} disabled={busy}>
          Continue
        </Button>
      </OnboardingActions>
    </Screen>
  );
}
