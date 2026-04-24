// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

afterEach(() => cleanup());

describe('Button', () => {
  it('defaults to the primary variant', () => {
    render(<Button>Click</Button>);
    const el = screen.getByRole('button');
    expect(el.className).toBe('btn btn-primary');
  });

  it('renders a secondary variant', () => {
    render(<Button variant="secondary">Click</Button>);
    expect(screen.getByRole('button').className).toBe('btn btn-secondary');
  });

  it('renders a ghost variant', () => {
    render(<Button variant="ghost">Click</Button>);
    expect(screen.getByRole('button').className).toBe('btn btn-ghost');
  });

  it('defaults to type=button (not submit)', () => {
    render(<Button>Click</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).type).toBe('button');
  });

  it('honors type="submit" when requested', () => {
    render(<Button type="submit">Click</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).type).toBe('submit');
  });

  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled={true} onClick={onClick}>
        Click
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders its children', () => {
    render(<Button>hello world</Button>);
    expect(screen.getByRole('button').textContent).toBe('hello world');
  });
});
