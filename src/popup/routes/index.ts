import type { ComponentType } from 'preact';
import type { RouteProps } from '../RouterProvider.js';
import type { RouteName } from '../router.js';
import { CloudOptInRoute } from './cloud-opt-in.js';
import { EmailCaptureRoute } from './email-capture.js';
import { HomeRoute } from './home.js';
import { PreviewRoute } from './preview.js';
import { TimezoneRoute } from './timezone.js';
import { TrackingOptInRoute } from './tracking-opt-in.js';
import { WelcomeRoute } from './welcome.js';

export const ROUTES: Record<RouteName, ComponentType<RouteProps>> = {
  welcome: WelcomeRoute,
  'tracking-opt-in': TrackingOptInRoute,
  'email-capture': EmailCaptureRoute,
  'cloud-opt-in': CloudOptInRoute,
  timezone: TimezoneRoute,
  preview: PreviewRoute,
  home: HomeRoute,
};
