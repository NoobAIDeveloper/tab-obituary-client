import type { ComponentChildren, JSX, VNode } from 'preact';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps {
  variant?: ButtonVariant;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>;
  children: ComponentChildren;
}

export function Button(props: ButtonProps): VNode {
  const variant: ButtonVariant = props.variant ?? 'primary';
  const className = `btn btn-${variant}`;
  return (
    <button
      type={props.type ?? 'button'}
      class={className}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
