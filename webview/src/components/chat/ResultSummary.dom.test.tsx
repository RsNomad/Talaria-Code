import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultSummary } from './ResultSummary';
import type { ResultItem } from '../../types';

/**
 * ARCH-1 (final review, UI I-4) — T4: the end-of-turn card must render an
 * HONEST, visually distinct treatment per `result.summary.status`. Before
 * this fix the component hardcoded a green "Turn complete" pass-filled icon
 * for every turn outcome — a cancelled or refused turn rendered identically
 * to a genuinely successful one (the exact "claim not backed by reality"
 * defect class this remediation programme exists to kill; see
 * `remediation-architecture.md` §1).
 *
 * Tone grounding: NOT invented for this task. `SubagentsPanel.tsx`'s STATUS
 * map already uses this exact pairing for the identical semantic situation
 * (a delegation's turn ending early, non-error): `interrupted: { tone:
 * 'warn', icon: 'circle-slash' }`, and `failed: { tone: 'del', icon:
 * 'error' }` for a genuine failure — this is the codebase's own established
 * non-success vocabulary, reused here rather than a new one invented for
 * this card.
 */
describe('ResultSummary — ARCH-1 (final review, UI I-4): honest per-status tone', () => {
  it('renders the green "Turn complete" card for status=complete (unchanged happy path)', () => {
    const item: ResultItem = { kind: 'result', turnId: 't1', status: 'complete' };
    render(<ResultSummary item={item} />);

    expect(screen.getByText('Turn complete')).toBeInTheDocument();
    expect(document.querySelector('.codicon-pass-filled')).not.toBeNull();
  });

  it('renders a non-green "Turn cancelled" card for status=cancelled', () => {
    const item: ResultItem = { kind: 'result', turnId: 't2', status: 'cancelled' };
    render(<ResultSummary item={item} />);

    // RED today: the component hardcodes "Turn complete" regardless of status.
    expect(screen.getByText('Turn cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Turn complete')).toBeNull();

    // Not just different text — a genuinely different, non-success tone:
    // the green pass-filled icon must be ABSENT, and the codebase's own
    // "interrupted" icon (SubagentsPanel.tsx) must be present instead.
    expect(document.querySelector('.codicon-pass-filled')).toBeNull();
    expect(document.querySelector('.codicon-circle-slash')).not.toBeNull();
  });

  it('renders "Turn ended with an error" for status=error', () => {
    const item: ResultItem = { kind: 'result', turnId: 't3', status: 'error' };
    render(<ResultSummary item={item} />);

    // RED today: the component hardcodes "Turn complete" regardless of status.
    expect(screen.getByText('Turn ended with an error')).toBeInTheDocument();
    expect(screen.queryByText('Turn complete')).toBeNull();

    expect(document.querySelector('.codicon-pass-filled')).toBeNull();
    expect(document.querySelector('.codicon-error')).not.toBeNull();
  });

  it('still renders the usage rollup and recap text for a non-complete status (visibility, not suppression)', () => {
    // ARCH-1 §1.1 / NN/g visibility-of-status: the card is kept for
    // cancelled/refused turns rather than suppressed — the usage rollup is
    // still true and the point of the fix is honest visibility, not hiding.
    const item: ResultItem = {
      kind: 'result',
      turnId: 't4',
      status: 'cancelled',
      text: 'stopped partway through',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    render(<ResultSummary item={item} />);

    expect(screen.getByText('Turn cancelled')).toBeInTheDocument();
    expect(screen.getByText('stopped partway through')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('T4 review fix: an out-of-contract status normalizes to a safe fallback instead of throwing', () => {
    // `bridge.ts` never structurally validates `status` — only `.type`. A
    // malformed / version-skewed value must not crash the render (which
    // previously blanked the ENTIRE transcript via the chat ErrorBoundary).
    // Cast through `unknown` to bypass the compile-time `ResultItem['status']`
    // union — this simulates exactly the untrusted-wire-payload scenario
    // `bridge.ts` cannot rule out.
    const item = { kind: 'result', turnId: 't5', status: 'refused' } as unknown as ResultItem;

    expect(() => render(<ResultSummary item={item} />)).not.toThrow();

    // Honest, non-committal fallback — NOT the green "complete" treatment
    // (would resurrect the silent-green defect) and NOT a false "error"
    // claim either (an unrecognized status might be a newer non-error state).
    expect(screen.getByText('Turn ended')).toBeInTheDocument();
    expect(screen.queryByText('Turn complete')).toBeNull();
    expect(screen.queryByText('Turn ended with an error')).toBeNull();
    expect(document.querySelector('.codicon-pass-filled')).toBeNull();
    expect(document.querySelector('.codicon-question')).not.toBeNull();
  });
});
