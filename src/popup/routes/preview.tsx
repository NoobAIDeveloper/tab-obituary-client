import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import { useRouter } from '../RouterProvider.js';
import { Button } from '../components/Button.js';
import { EmailPreview } from '../components/EmailPreview.js';
import { Screen } from '../components/Screen.js';
import { usePreviewReport } from '../hooks/usePreviewReport.js';

/**
 * Onboarding "wow moment" — renders a freshly generated preview email built
 * from the user's last 24h of Chrome history. See PRD §8.2.
 *
 * The static `SAMPLE_EMAIL_HTML` fixture still lives in
 * `../fixtures/sample-email.ts` for use by other tests, but is no longer
 * rendered here. This route refuses to fall back to it: if generation
 * fails, we show an inline error with a Try again button rather than
 * pretending a canned email was the user's.
 */
export function PreviewRoute(): VNode {
  const router = useRouter();
  const { state, start, cancel } = usePreviewReport();

  // Auto-start on mount; cancel in-flight when we unmount.
  useEffect(() => {
    start();
    return () => {
      cancel();
    };
  }, [start, cancel]);

  let body: VNode;
  if (state.status === 'ready') {
    body = (
      <>
        <p class="muted">Subject: {state.subject}</p>
        <EmailPreview html={state.html} />
      </>
    );
  } else if (state.status === 'error') {
    body = (
      <div class="preview-error">
        <p>{errorMessage(state.code, state.retryAfter)}</p>
        <Button onClick={() => start()}>Try again</Button>
      </div>
    );
  } else {
    // idle + loading both render the same waiting state. We deliberately
    // do NOT differentiate 'history' vs 'network' — the history read is
    // sub-second, the LLM round-trip dominates the perceived wait, and a
    // flickering phase indicator just looks noisy.
    body = (
      <div class="preview-loading" aria-live="polite">
        <p>Writing your preview…</p>
        <p class="muted">
          This may take 10–15 seconds while we read the last day of your browsing.
        </p>
      </div>
    );
  }

  return (
    <Screen title="A taste of what's coming" back={true} body={body}>
      <Button onClick={() => router.go('home')}>Continue</Button>
    </Screen>
  );
}

/**
 * Map the hook's error code to user-facing copy. Kept local to the route so
 * wording stays co-located with the UI context. Deliberately friendly and
 * non-technical — the codes themselves go to the console for debugging.
 */
function errorMessage(
  code: string,
  retryAfter: number | undefined,
): string {
  switch (code) {
    case 'rate_limited':
      return typeof retryAfter === 'number'
        ? `Please wait ${retryAfter}s and try again.`
        : 'Too many attempts. Please wait a moment and try again.';
    case 'network_error':
      return "Couldn't reach the server. Please check your connection.";
    case 'invalid_response':
      return "We got an unexpected response. Please try again.";
    case 'unauthorized':
      return "Your session expired. Please reopen the popup and try again.";
    case 'no_token':
      return "No account yet — please finish subscribing first.";
    case 'settings_missing':
      return "Still setting up — please wait a moment and try again.";
    case 'server_error':
      return "Our server hit a snag. Please try again in a moment.";
    default:
      return "Something went wrong. Please try again.";
  }
}
