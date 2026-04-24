import type { VNode } from 'preact';
import { ONBOARDING_ORDER, type RouteName, onboardingStepIndex } from '../router.js';

export interface ProgressProps {
  route: RouteName;
}

export function Progress(props: ProgressProps): VNode | null {
  const idx = onboardingStepIndex(props.route);
  if (idx === null) return null;
  const total = ONBOARDING_ORDER.length;
  return (
    <p class="progress-indicator">
      Step {idx + 1} of {total}
    </p>
  );
}
