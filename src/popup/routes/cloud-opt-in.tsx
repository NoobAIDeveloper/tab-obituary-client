import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { updateSettings } from '../../backend/index.js';
import { useRouter } from '../RouterProvider.js';
import { Button } from '../components/Button.js';
import { ConfirmationBanner } from '../components/ConfirmationBanner.js';
import { OnboardingActions } from '../components/OnboardingActions.js';
import { Progress } from '../components/Progress.js';
import { Screen } from '../components/Screen.js';
import { useSettings } from '../hooks/useSettings.js';
import { nextOnboardingRoute } from '../router.js';

export function CloudOptInRoute(): VNode {
  const router = useRouter();
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const choose = async (cloudAiOptIn: boolean): Promise<void> => {
    if (busy) return;
    setError(null);
    setNote(null);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      // Local write FIRST: IDB is authoritative for this preference. If the
      // server mismatches temporarily, the next popup session (or a Phase
      // 10/11 "pending settings sync" sweep) will reconcile.
      await settings.updatePrivacy({ cloudAiOptIn });

      const result = await updateSettings(
        { cloudAiOptIn },
        { signal: ctrl.signal },
      );

      if (!result.ok) {
        switch (result.error) {
          case 'aborted':
            // Component unmounted / navigated away. Silent.
            return;
          case 'no_token':
            // User arrived here without completing email-capture — anomaly,
            // not user-facing. Local write already landed; don't block them.
            console.warn(
              '[cloud-opt-in] /settings called without clientToken; advancing',
            );
            break;
          case 'rate_limited':
          case 'network_error':
          default:
            // Local state is authoritative; surface a small note but keep the
            // user moving. We do NOT roll back the local write — the user's
            // choice is persisted on device; the server catches up later.
            //
            // If this ever becomes common, a pending-settings-sync queue could retry on next authed call.
            console.warn(
              '[cloud-opt-in] /settings sync failed, local-only',
              result.error,
            );
            setNote("We'll sync this setting later.");
        }
      }

      router.go(nextOnboardingRoute('cloud-opt-in') ?? 'home');
    } catch (err) {
      // Only reachable if the local IDB write throws — the backend call
      // catches everything and returns ok:false.
      console.warn('[cloud-opt-in] local save failed', err);
      setError('Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Delivery mode"
      body={
        <>
          <ConfirmationBanner />
          <p>Choose whether the report is composed on your device or in the cloud.</p>
          <p class="muted">Cloud mode is faster; on-device keeps every byte local.</p>
          <div class="choice-group">
            <Button onClick={() => void choose(true)} disabled={busy}>
              Compose in the cloud
            </Button>
            <Button variant="secondary" onClick={() => void choose(false)} disabled={busy}>
              Compose on my device
            </Button>
          </div>
          <Progress route="cloud-opt-in" />
          {note ? <p class="muted">{note}</p> : null}
          {error ? <p class="error">{error}</p> : null}
        </>
      }
    >
      <OnboardingActions current="cloud-opt-in">{null}</OnboardingActions>
    </Screen>
  );
}
