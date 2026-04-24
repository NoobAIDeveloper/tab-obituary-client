// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ONBOARDING_ORDER, type RouteName } from '../router.js';
import { Progress } from './Progress.js';

afterEach(() => cleanup());

describe('Progress', () => {
  it.each(
    ONBOARDING_ORDER.map((route, idx) => [route, idx + 1]) as ReadonlyArray<[RouteName, number]>,
  )('renders "Step %s of 5" for onboarding route %s', (route, expected) => {
    render(<Progress route={route} />);
    const el = screen.getByText(new RegExp(`Step ${expected} of 5`));
    expect(el.className).toContain('progress-indicator');
  });

  it('renders nothing for preview', () => {
    const { container } = render(<Progress route="preview" />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for home', () => {
    const { container } = render(<Progress route="home" />);
    expect(container.textContent).toBe('');
  });
});
