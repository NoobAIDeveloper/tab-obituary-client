/**
 * Small banner that nudges the user to click the confirmation link we mailed
 * them, and lets them tell the popup "I confirmed, check now."
 *
 * Rendering rules:
 *   - Only when local `user.email` is set AND `user.emailConfirmed === false`.
 *   - Once the hook flips local truth to true, this component self-hides on
 *     the next render (the gate above returns null). No explicit dismiss.
 *
 * Intentionally NOT included: automatic polling, a "change email" link, a
 * dismiss button. Keep the surface small — 9.3 and Phase 10 will layer on
 * richer account-management UI.
 *
 * The "Resend" button is deferred: the backend's `/subscribe` is idempotent
 * and re-sends the magic link, so this is cheap to wire in later. For 9.2
 * we keep the UI to just "I confirmed" so the banner doesn't turn into a
 * dense account panel mid-onboarding.
 */

import type { VNode } from 'preact';
import { useEmailConfirmation } from '../hooks/useEmailConfirmation.js';
import { Button } from './Button.js';

export function ConfirmationBanner(): VNode | null {
  // Read user data through the same hook that performs the flip. Calling
  // `useSettings()` separately here would spin up a second instance whose
  // in-memory mirror never observes the `emailConfirmed:true` write that
  // the hook performs on its own instance — so the banner would fail to
  // self-hide after the user clicks "I confirmed".
  const confirmation = useEmailConfirmation();
  const email = confirmation.user.email;
  const emailConfirmed = confirmation.user.emailConfirmed;

  // Gate: pre-subscribe (no email) or already-confirmed → render nothing.
  // A `true` for `emailConfirmed` is the only state that should hide the
  // banner; `undefined` (loading) and `false` both allow it to render once
  // an email is set.
  if (email === undefined || email === '') return null;
  if (emailConfirmed === true) return null;

  const checking = confirmation.status === 'checking';
  const hadError = confirmation.status === 'error';

  return (
    <div class="confirmation-banner" role="status" data-testid="confirmation-banner">
      <p>
        Check your inbox — we sent a link to <strong>{email}</strong>.
      </p>
      <div class="confirmation-banner-actions">
        <Button
          variant="secondary"
          disabled={checking}
          onClick={() => {
            void confirmation.refresh();
          }}
        >
          {checking ? 'Checking…' : 'I confirmed'}
        </Button>
      </div>
      {hadError ? (
        <p class="error">We couldn't verify yet — try again.</p>
      ) : null}
    </div>
  );
}
