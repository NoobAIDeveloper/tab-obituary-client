import type { JSX, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setClientToken, subscribe } from '../../backend/index.js';
import { isEmail } from '../../lib/validate-email.js';
import { useRouter } from '../RouterProvider.js';
import { Button } from '../components/Button.js';
import { OnboardingActions } from '../components/OnboardingActions.js';
import { Progress } from '../components/Progress.js';
import { Screen } from '../components/Screen.js';
import { useSettings } from '../hooks/useSettings.js';
import { nextOnboardingRoute } from '../router.js';

export function EmailCaptureRoute(): VNode {
  const router = useRouter();
  const settings = useSettings();
  const [value, setValue] = useState(settings.user?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // useSettings hydrates from IDB asynchronously; sync the stored email in only
  // while the field is still empty so we don't clobber what the user has typed.
  const storedEmail = settings.user?.email;
  useEffect(() => {
    if (storedEmail && value === '') {
      setValue(storedEmail);
    }
  }, [storedEmail, value]);

  // Cancel any in-flight /subscribe if the component unmounts mid-request.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const valid = isEmail(value);

  const onSubmit = async (): Promise<void> => {
    if (!valid || busy) return;
    setError(null);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const normalized = value.trim();

    try {
      const result = await subscribe(normalized, { signal: ctrl.signal });

      if (!result.ok) {
        // Map API error codes to user-facing copy. The backend's zod issues
        // are deliberately collapsed to a single generic message so we don't
        // spill internal schema detail into the UI.
        let message: string;
        switch (result.error) {
          case 'rate_limited': {
            const secs = result.retryAfter;
            message =
              typeof secs === 'number'
                ? `Please wait ${secs}s and try again.`
                : 'Too many attempts. Please wait a moment and try again.';
            break;
          }
          case 'email_send_failed':
            message =
              "We couldn't send your confirmation email. Please try again.";
            break;
          case 'bad_request':
            message = "That email wasn't accepted. Please check it and retry.";
            break;
          case 'network_error':
            message = "Couldn't reach the server. Please check your connection.";
            break;
          case 'aborted':
            // Component unmounted or the user navigated away. Silent.
            return;
          default:
            console.warn('[email-capture] subscribe failed', result.error);
            message = 'Something went wrong. Please try again.';
        }
        setError(message);
        return;
      }

      // Success. Persist the clientToken if the response carried one
      // (`subscribed` or `link_resent`; `already_subscribed` does not).
      if ('clientToken' in result.data) {
        await setClientToken(result.data.clientToken);
      }

      // CRITICAL: overwrite any locally-minted uuid with the server's. The
      // `useSettings.defaultUser()` helper mints a random uuid so IDB writes
      // can succeed pre-subscribe, but from here on we want the server's uuid
      // so `/settings`, `/export`, etc. agree on identity. If a prior aborted
      // onboarding left a different uuid in the row, we overwrite it — the
      // server is authoritative from this point forward.
      await settings.updateUser({
        email: normalized,
        uuid: result.data.uuid,
        emailConfirmed: false,
      });

      router.go(nextOnboardingRoute('email-capture') ?? 'home');
    } catch (err) {
      // `subscribe()` catches network/abort internally and returns ok:false,
      // so a real throw here is an IDB/local failure from `updateUser`.
      console.warn('[email-capture] local save failed', err);
      setError('Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void onSubmit();
    }
  };

  return (
    <Screen
      title="Where should we send it?"
      body={
        <>
          <p>Your weekly obituary will arrive in your inbox.</p>
          <label class="form-field">
            <span>Email</span>
            <input
              ref={inputRef}
              class="form-input"
              type="email"
              autocomplete="email"
              spellcheck={false}
              value={value}
              onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={onKeyDown}
              placeholder="you@example.com"
            />
          </label>
          <p class="muted">We'll only email your weekly report.</p>
          <Progress route="email-capture" />
          {error ? <p class="error">{error}</p> : null}
        </>
      }
    >
      <OnboardingActions current="email-capture">
        <Button onClick={() => void onSubmit()} disabled={!valid || busy}>
          Continue
        </Button>
      </OnboardingActions>
    </Screen>
  );
}
