/*
 * UX-13 (ADR-UX-P2-3): the ONE shared segmented-switch strip, replacing the
 * three hand-rolled `inline-flex gap-1` copies in SetupPanel.tsx (agent
 * backend, FIM Connect/Install, RAG embedding backend). Markup is
 * byte-copied from those strips — the a11y net-gain is `role="group"` named
 * by `ariaLabel` (the strips were anonymous) plus `aria-pressed` on every
 * option button. Row-shaped pickers (Agent/FIM `BackendOptionRow`) are out
 * of scope — ADR-UX-P2-3 explicitly keeps this to the THREE strip sites.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedSwitch } from './SegmentedSwitch';

const OPTIONS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
] as const;

describe('SegmentedSwitch (UX-13 / ADR-UX-P2-3)', () => {
  it('renders a role="group" named by ariaLabel, containing one button per option', () => {
    render(<SegmentedSwitch options={OPTIONS} value="alpha" onChange={() => {}} ariaLabel="Widget" />);
    const group = screen.getByRole('group', { name: 'Widget' });
    expect(within(group).getAllByRole('button')).toHaveLength(2);
  });

  it('marks the active option aria-pressed=true and every other option aria-pressed=false', () => {
    render(<SegmentedSwitch options={OPTIONS} value="beta" onChange={() => {}} ariaLabel="Widget" />);
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking an option fires onChange with that option\'s id exactly once', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedSwitch options={OPTIONS} value="alpha" onChange={onChange} ariaLabel="Widget" />);
    await user.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('beta');
  });

  it('defaults the group wrapper to self-start when no className is given', () => {
    render(<SegmentedSwitch options={OPTIONS} value="alpha" onChange={() => {}} ariaLabel="Widget" />);
    expect(screen.getByRole('group', { name: 'Widget' })).toHaveClass('self-start');
  });

  it('applies a caller-supplied className instead of the self-start default', () => {
    render(<SegmentedSwitch options={OPTIONS} value="alpha" onChange={() => {}} ariaLabel="Widget" className="mb-2" />);
    const group = screen.getByRole('group', { name: 'Widget' });
    expect(group).toHaveClass('mb-2');
    expect(group).not.toHaveClass('self-start');
  });

  // UX-02 (WCAG 1.4.1 use-of-color): the pressed segment must carry a
  // non-color cue (border + font-weight), not color alone. Unpressed uses
  // border-transparent so both states occupy the same box size — no shift.
  it('gives the pressed segment a border + weight cue, and the unpressed segment border-transparent with no accent border', () => {
    render(<SegmentedSwitch options={OPTIONS} value="beta" onChange={() => {}} ariaLabel="Widget" />);
    const pressed = screen.getByRole('button', { name: 'Beta' });
    const unpressed = screen.getByRole('button', { name: 'Alpha' });
    expect(pressed).toHaveClass('border-accent');
    expect(pressed).toHaveClass('font-semibold');
    expect(unpressed).toHaveClass('border-transparent');
    expect(unpressed).not.toHaveClass('border-accent');
  });
});
