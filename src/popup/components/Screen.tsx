import type { ComponentChildren, VNode } from 'preact';
import { useRouter } from '../RouterProvider.js';
import { Button } from './Button.js';

export interface ScreenProps {
  title: string;
  back?: boolean;
  body: ComponentChildren;
  children?: ComponentChildren;
}

export function Screen(props: ScreenProps): VNode {
  const router = useRouter();
  const showBack = props.back === true && router.canGoBack;
  return (
    <section class="screen">
      <header class="screen-header">
        <h1>{props.title}</h1>
      </header>
      <div class="screen-body">{props.body}</div>
      <footer class="screen-actions">
        {showBack ? (
          <Button variant="ghost" onClick={() => router.goBack()}>
            Back
          </Button>
        ) : null}
        {props.children}
      </footer>
    </section>
  );
}
