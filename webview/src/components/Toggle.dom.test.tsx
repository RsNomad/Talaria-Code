import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toggle } from './Toggle';

/**
 * C3 (path doc §5 C3): the toggle knob was hardcoded `bg-white`, which risks
 * near-invisible contrast against a near-white track in light VS Code themes.
 * WCAG 2.2 SC 1.4.11 Non-text Contrast requires a minimum 3:1 contrast ratio
 * between a state-bearing UI part and its adjacent background, and gives
 * exactly this shape of control — a toggle's internal knob against its own
 * background — as the worked example
 * (https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html,
 * fetched this task: "the round toggle within contrasts with the internal
 * background").
 *
 * Fix: theme tokens instead of a fixed color — `bg-accent-fg` when on,
 * `bg-fg` when off (tracks stay `bg-accent` / `bg-overlay`, unchanged). Both
 * tokens already exist in `webview/tailwind.config.js` (`fg` → `--h-fg`,
 * `accent-fg` → `--h-accent-fg`) and are theme-aware across light/dark/
 * high-contrast via theme.css.
 *
 * jsdom has no layout engine, so this is a class-assertion test: the
 * presence/absence of the Tailwind utility classes on the knob IS the
 * contract. The actual rendered contrast ratio stays PLAUSIBLE-grade pending
 * the owner's Fedora Light+/HC-Light screenshots — this test cannot and does
 * not close that dimension out.
 */
function getKnob(container: HTMLElement): HTMLSpanElement {
  const knob = container.querySelector('button[role="switch"] > span');
  if (!(knob instanceof HTMLSpanElement)) {
    throw new Error('toggle knob <span> not found');
  }
  return knob;
}

describe('Toggle — C3: knob uses theme tokens, not hardcoded white', () => {
  it('on: knob is bg-accent-fg, never bg-white', () => {
    const { container } = render(<Toggle on={true} label="Test toggle" />);
    expect(screen.getByRole('switch')).toBeInTheDocument();

    const knob = getKnob(container);
    expect(knob).toHaveClass('bg-accent-fg');
    expect(knob).not.toHaveClass('bg-white');
  });

  it('off: knob is bg-fg, never bg-white', () => {
    const { container } = render(<Toggle on={false} label="Test toggle" />);
    expect(screen.getByRole('switch')).toBeInTheDocument();

    const knob = getKnob(container);
    expect(knob).toHaveClass('bg-fg');
    expect(knob).not.toHaveClass('bg-white');
  });
});
