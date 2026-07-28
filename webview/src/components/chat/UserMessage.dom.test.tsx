import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserMessage } from './UserMessage';
import type { UserItem } from '../../types';

/**
 * C1 (path doc §5 C1): a multi-line prompt (Shift+Enter) collapses to one
 * run-on paragraph in the transcript because the bubble has no `white-space`
 * styling — the browser's default `normal` value collapses newlines to a
 * single space (MDN white-space:
 * https://developer.mozilla.org/en-US/docs/Web/CSS/white-space, fetched this
 * task: "Sequences of white space are collapsed. Newline characters are
 * treated as other white space." for `normal`). Fix: `whitespace-pre-wrap
 * break-words` on the bubble — `pre-wrap` "preserve[s]" whitespace sequences
 * and "[l]ines are broken at newline characters, ... and as necessary to
 * fill line boxes" (same MDN page), so user line breaks survive AND long
 * unbroken runs still wrap (no horizontal overflow) via `break-words`.
 *
 * jsdom has no layout engine, so this is a class-assertion test: the
 * presence of the Tailwind `whitespace-pre-wrap` utility class on the text
 * element IS the contract (the CSS behavior itself is documented above and
 * on MDN, not re-derived here).
 */
describe('UserMessage — C1: bubble preserves line breaks', () => {
  it('renders the bubble text node with whitespace-pre-wrap break-words', () => {
    const item: UserItem = {
      kind: 'user',
      turnId: 't1',
      text: 'line one\nline two',
      mode: 'default',
    };
    render(<UserMessage item={item} />);

    // RED today: the bubble has no `white-space` styling at all, so
    // multi-line text collapses to one run-on paragraph.
    // Match the LEAF element only (children.length === 0) — the outer
    // wrapper div shares the same textContent as the inner bubble div, and
    // testing-library's default whitespace normalizer would otherwise
    // collapse the literal "\n" this assertion depends on.
    const bubble = screen.getByText(
      (_content, element) => element?.textContent === 'line one\nline two' && element.children.length === 0,
    );
    expect(bubble).toHaveClass('whitespace-pre-wrap', 'break-words');
  });
});
