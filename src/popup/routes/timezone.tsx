import type { VNode } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useRouter } from '../RouterProvider.js';
import { Button } from '../components/Button.js';
import { ConfirmationBanner } from '../components/ConfirmationBanner.js';
import { OnboardingActions } from '../components/OnboardingActions.js';
import { Progress } from '../components/Progress.js';
import { Screen } from '../components/Screen.js';
import { useSettings } from '../hooks/useSettings.js';

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function supportedZones(): string[] | null {
  // Intl.supportedValuesOf is modern-browser only; treat absence as "fall back to text input".
  const anyIntl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof anyIntl.supportedValuesOf !== 'function') return null;
  try {
    return anyIntl.supportedValuesOf('timeZone');
  } catch {
    return null;
  }
}

export function TimezoneRoute(): VNode {
  const router = useRouter();
  const settings = useSettings();
  const detected = useMemo(() => detectTimezone(), []);
  const zones = useMemo(() => supportedZones(), []);
  const [value, setValue] = useState<string>(settings.user?.timezone ?? detected);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // useSettings hydrates from IDB asynchronously; swap the detected default for
  // the stored zone once it arrives, but only while the user hasn't opened the
  // editor (so we never clobber an in-progress edit).
  const storedTimezone = settings.user?.timezone;
  useEffect(() => {
    if (!editing && storedTimezone && storedTimezone !== value) {
      setValue(storedTimezone);
    }
  }, [storedTimezone, editing, value]);

  const onContinue = async (): Promise<void> => {
    if (!value.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      await settings.updateUser({ timezone: value.trim() });
      router.go('preview');
    } catch (_err) {
      setError('Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="When should it arrive?"
      body={
        <>
          <ConfirmationBanner />
          <p>Your weekly summary lands on Sunday morning in your local time.</p>
          {editing ? (
            <div class="form-field">
              <label htmlFor="tz-editor">
                <span>Timezone</span>
              </label>
              {zones ? (
                <select
                  id="tz-editor"
                  class="form-input"
                  value={value}
                  onChange={(e) => setValue((e.currentTarget as HTMLSelectElement).value)}
                >
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="tz-editor"
                  class="form-input"
                  type="text"
                  value={value}
                  onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
                  placeholder="Area/City"
                />
              )}
            </div>
          ) : (
            <div class="readonly-label" data-testid="tz-detected">
              {value}
              <Button variant="ghost" onClick={() => setEditing(true)}>
                change
              </Button>
            </div>
          )}
          <Progress route="timezone" />
          {error ? <p class="error">{error}</p> : null}
        </>
      }
    >
      <OnboardingActions current="timezone">
        <Button onClick={() => void onContinue()} disabled={!value.trim() || busy}>
          Continue
        </Button>
      </OnboardingActions>
    </Screen>
  );
}
