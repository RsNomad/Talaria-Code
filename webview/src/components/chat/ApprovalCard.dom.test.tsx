/**
 * T-A2 (audit-2 Cluster A, closes V-6/V-7 user-visible halves; renders the
 * settled state shipped by T-A0/T-A1). ApprovalCard's render precedence,
 * exact per the wave-3 architect refinement (`audit2-wave3-architecture.md`
 * "T-A2" §"Render precedence"):
 *   ① settledOutcome === 'selected'        -> "Responded: {label}"
 *   ② other settledOutcome                 -> terminal copy, ZERO buttons
 *   ③ resolvedOptionId set (optimistic)    -> "Responded: {label}"
 *   ④ component-local one-shot expiry      -> expired copy, ZERO buttons
 *   ⑤ else                                 -> live buttons + static deadline line
 *
 * Buttons render iff `resolvedOptionId === undefined && settledOutcome ===
 * undefined` and the card has not locally expired. No ticking counter
 * anywhere (WCAG 2.2.2 / uiux-F7) — the deadline line is a STATIC sentence;
 * the component-local timer is display-only (fires once, cleared on
 * unmount), the HOST `approval.settle` push stays the authority.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalItem } from '../../types';

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval',
    turnId: 't1',
    id: 'appr-1',
    toolId: 'tool-1',
    approvalKind: 'edit',
    title: 'Edit: src/a.ts',
    options: [
      { id: 'allow', label: 'Allow', kind: 'allow_once' },
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ],
    ...overrides,
  };
}

describe('ApprovalCard — settled-card copy (V-4/V-5) and expiry (V-6)', () => {
  it('renders "Responded: {label}" for a selected settlement (unchanged grammar)', () => {
    render(
      <ApprovalCard
        item={approval({ settledOutcome: 'selected', resolvedOptionId: 'allow' })}
        onRespond={() => undefined}
      />,
    );
    expect(screen.getByText('Responded: Allow')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the cancelled terminal copy with zero buttons', () => {
    render(<ApprovalCard item={approval({ settledOutcome: 'cancelled' })} onRespond={() => undefined} />);
    expect(screen.getByText('Cancelled — the turn ended before a response')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the expired terminal copy (with seconds) with zero buttons', () => {
    render(
      <ApprovalCard
        item={approval({ settledOutcome: 'expired', timeoutMs: 60_000 })}
        onRespond={() => undefined}
      />,
    );
    expect(
      screen.getByText('Expired — automatically denied after 60 seconds without a response'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the superseded terminal copy with zero buttons', () => {
    render(<ApprovalCard item={approval({ settledOutcome: 'superseded' })} onRespond={() => undefined} />);
    expect(screen.getByText('No longer awaiting a response')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('V-6 the user-visible lie: an item with BOTH an optimistic resolvedOptionId AND settledOutcome:"expired" renders EXPIRED, not "Responded" (settledOutcome wins — precedence ② beats ③)', () => {
    render(
      <ApprovalCard
        item={approval({ resolvedOptionId: 'allow', settledOutcome: 'expired', timeoutMs: 60_000 })}
        onRespond={() => undefined}
      />,
    );
    expect(
      screen.getByText('Expired — automatically denied after 60 seconds without a response'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Responded/)).not.toBeInTheDocument();
  });

  it('renders live buttons and the static deadline line while genuinely pending with a known timeout', () => {
    render(<ApprovalCard item={approval({ timeoutMs: 45_000 })} onRespond={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getByText('Auto-denies if not answered (about 45 seconds)')).toBeInTheDocument();
  });

  it('renders live buttons with NO deadline line when timeoutMs is absent (never fabricate a deadline the wire did not state)', () => {
    render(<ApprovalCard item={approval({ timeoutMs: undefined })} onRespond={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.queryByText(/Auto-denies/)).not.toBeInTheDocument();
  });

  it('clicking a live option still calls onRespond with that option id', () => {
    const calls: string[] = [];
    render(<ApprovalCard item={approval()} onRespond={(id) => calls.push(id)} />);
    screen.getByRole('button', { name: 'Deny' }).click();
    expect(calls).toEqual(['deny']);
  });

  it('V-6 local expiry: a component-local one-shot timer hides the buttons at the deadline even with no host push, and is cleared on unmount (no leaked timer)', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(
        <ApprovalCard item={approval({ timeoutMs: 1_000 })} onRespond={() => undefined} />,
      );
      expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(
        screen.getByText('Expired — automatically denied after 1 second without a response'),
      ).toBeInTheDocument();

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm a local timer at all for an already-settled item (no leaked timer on a terminal card)', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(
        <ApprovalCard
          item={approval({ settledOutcome: 'cancelled', timeoutMs: 1_000 })}
          onRespond={() => undefined}
        />,
      );
      expect(vi.getTimerCount()).toBe(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
