import type { ComponentChildren, VNode } from 'preact';
import { useRouter } from '../RouterProvider.js';
import { type RouteName, prevOnboardingRoute } from '../router.js';
import { Button } from './Button.js';

export interface OnboardingActionsProps {
  current: RouteName;
  children: ComponentChildren;
}

// Robust Back: pop history if the popup was opened fresh within this session;
// otherwise, a popup restored mid-flow has no history and we walk the linear
// onboarding order back one step. Without this, a refreshed popup on step 3
// would render no Back button at all even though there's a visible "prev" step.
export function OnboardingActions(props: OnboardingActionsProps): VNode {
  const router = useRouter();
  const fallbackPrev = prevOnboardingRoute(props.current);
  const showBack = router.canGoBack || fallbackPrev !== null;

  const onBack = (): void => {
    if (router.canGoBack) {
      router.goBack();
      return;
    }
    if (fallbackPrev) router.go(fallbackPrev);
  };

  return (
    <>
      {showBack ? (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      ) : null}
      {props.children}
    </>
  );
}
