import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReasoningBlock } from './ReasoningBlock';
import type { ReasoningItem } from '../../types';

/**
 * B5 (path doc §1 decision 15, SIMPLIFIED): the disclosure button lacks
 * `aria-expanded`, so screen-reader users can't tell whether "Thought" is
 * expanded (UI M-5). Fix: `aria-expanded={open}` on the button ONLY — no
 * state-restating `aria-label` ("Expand/Collapse reasoning"). The button
 * already carries a text name ("Thinking"/"Thought") and, per the W3C APG
 * disclosure pattern, `aria-expanded` alone conveys expanded/collapsed state
 * (https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/, fetched this run:
 * "When the content is visible, the element with role button has
 * aria-expanded set to true. When the content area is hidden, it is set to
 * false" — no requirement that the accessible name change with state).
 */
describe('ReasoningBlock — B5: disclosure button aria-expanded', () => {
  it('reflects aria-expanded=true while streaming (open by default)', () => {
    const item: ReasoningItem = {
      kind: 'reasoning',
      turnId: 't1',
      blockId: 'b1',
      text: 'thinking about it',
      streaming: true,
    };
    render(<ReasoningBlock item={item} />);

    // RED today: the button carries no aria-expanded attribute at all.
    const button = screen.getByRole('button', { name: /Thinking/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles to aria-expanded=false when the user collapses it, and back to true on re-open', async () => {
    const user = userEvent.setup();
    const item: ReasoningItem = {
      kind: 'reasoning',
      turnId: 't2',
      blockId: 'b2',
      text: 'thinking about it',
      streaming: true,
    };
    render(<ReasoningBlock item={item} />);

    const button = screen.getByRole('button', { name: /Thinking/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('does NOT add a state-restating aria-label — the visible text name is the sole accessible name', () => {
    const item: ReasoningItem = {
      kind: 'reasoning',
      turnId: 't3',
      blockId: 'b3',
      text: 'thinking about it',
      streaming: false,
    };
    render(<ReasoningBlock item={item} />);

    const button = screen.getByRole('button', { name: /Thought/ });
    expect(button).not.toHaveAttribute('aria-label');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});

/**
 * Tier-2 T-15, F7. The elapsed-time counter (`{seconds}s`) re-renders every
 * 100ms while streaming, inside `role="log"` (`ChatView.tsx`'s transcript
 * region has implicit `aria-live="polite"`) — so an unhidden counter spams a
 * screen reader with "0.1s… 0.2s… 0.3s…" for the whole duration of a
 * reasoning block. `aria-hidden="true"` on the counter span ONLY (not the
 * "Thinking"/"Thought" label span, not the button) removes it from the
 * accessibility tree — W3C ARIA accessible-name computation skips
 * `aria-hidden="true"` descendants, so the button's name is still exactly
 * "Thinking"/"Thought" with no numeric noise.
 */
describe('ReasoningBlock — F7: the ticking elapsed counter is not announced', () => {
  it('the counter span carries aria-hidden="true" while streaming', () => {
    const item: ReasoningItem = {
      kind: 'reasoning',
      turnId: 't4',
      blockId: 'b4',
      text: 'thinking about it',
      streaming: true,
    };
    render(<ReasoningBlock item={item} />);

    const counter = screen.getByText(/^0\.0s$/);
    expect(counter).toHaveAttribute('aria-hidden', 'true');
  });

  it('the disclosure button\'s accessible name excludes the counter text entirely', () => {
    const item: ReasoningItem = {
      kind: 'reasoning',
      turnId: 't5',
      blockId: 'b5',
      text: 'thinking about it',
      streaming: true,
    };
    render(<ReasoningBlock item={item} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAccessibleName('Thinking');
  });
});
