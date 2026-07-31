/*
 * W4-T6 (UI#8, state-parity): two rendering gaps between SubagentsPanel and
 * the rest of the UI.
 *
 * 1. `d.startedAt` used to render VERBATIM — a raw ISO-8601 timestamp — while
 *    `SessionsPanel.tsx`'s History rows show the SAME kind of "when" data
 *    through `relativeAge` ("5m ago"). Now shared via `webview/src/relativeAge.ts`.
 *
 * 2. The "Running" status reused `tone: 'add'` — the SAME tone `complete`
 *    already claims, so a running delegation and a finished one were
 *    visually identical at a glance. `ToolCard.tsx`'s STATUS map already
 *    established the vocabulary for this exact situation: `running: {tone:
 *    'run', ...}`, a dedicated in-progress tone distinct from both `add`
 *    (success) and `del` (failure). This unifies SubagentsPanel onto it.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SubagentsData } from '../protocol';
import { SubagentsPanel } from './SubagentsPanel';

function data(overrides: Partial<SubagentsData> = {}): SubagentsData {
  return { delegations: [], ...overrides };
}

describe('W4-T6: SubagentsPanel relative-age parity with SessionsPanel', () => {
  it('renders a relative age, not the raw ISO timestamp, for a delegation with startedAt', () => {
    render(
      <SubagentsPanel
        data={data({
          delegations: [
            {
              id: 'd1',
              goal: 'Fix the bug',
              status: 'complete',
              startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('5m ago')).toBeInTheDocument();
  });

  it('renders no age line when startedAt is absent (unchanged behavior)', () => {
    render(
      <SubagentsPanel
        data={data({ delegations: [{ id: 'd1', goal: 'Fix the bug', status: 'complete' }] })}
      />,
    );

    expect(screen.queryByText(/ago$/)).not.toBeInTheDocument();
  });
});

describe('W4-T6: the "Running" status tone matches ToolCard.tsx\'s vocabulary (the dedicated "run" tone, not "add")', () => {
  it('a running delegation gets the run tone, visually distinct from a completed one', () => {
    render(
      <SubagentsPanel
        data={data({ delegations: [{ id: 'd1', goal: 'Fix the bug', status: 'running' }] })}
      />,
    );

    const pillText = screen.getByText('Running');
    const pill = pillText.closest('span');
    expect(pill?.className).toContain('text-run');
    expect(pill?.className).not.toContain('text-add');
  });

  it('a complete delegation keeps the "add" (success) tone, unchanged', () => {
    render(
      <SubagentsPanel
        data={data({ delegations: [{ id: 'd1', goal: 'Fix the bug', status: 'complete' }] })}
      />,
    );

    const pillText = screen.getByText('Complete');
    const pill = pillText.closest('span');
    expect(pill?.className).toContain('text-add');
  });
});
