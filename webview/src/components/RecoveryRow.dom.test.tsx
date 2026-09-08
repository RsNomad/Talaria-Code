import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecoveryRow } from './RecoveryRow';

/**
 * FI-36 drift-lock: `RecoveryRow` is the shared chrome extracted from
 * App.tsx's 3 duplicated status/recovery rows (openFailed/Reconnect,
 * sessionLost/History, newSessionPending). This test asserts the exact
 * className strings + `Icon` props + button shape byte-for-byte so any
 * future drift in the ONE shared component is caught here first.
 */
describe('RecoveryRow: shared chrome for the 3 App.tsx status/recovery rows (FI-36)', () => {
  it('renders the row chrome + icon + message + an action button with the exact classes', () => {
    const onClick = vi.fn();
    render(
      <RecoveryRow
        icon={{ name: 'warning', className: 'flex-none text-warn' }}
        message="This chat never connected to the agent."
        action={{ label: 'Reconnect', onClick }}
      />,
    );

    const row = screen.getByText('This chat never connected to the agent.').closest('div');
    expect(row).not.toBeNull();
    expect(row).toHaveClass(
      'flex',
      'items-center',
      'gap-2',
      'border-b',
      'border-border',
      'bg-surface',
      'px-3',
      'py-2',
      'text-2xs',
      'text-muted',
    );

    const icon = row?.querySelector('.codicon-warning');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass('flex-none', 'text-warn');
    expect(icon).not.toHaveClass('codicon-modifier-spin');
    expect(icon).toHaveStyle({ fontSize: '12px' });

    const button = screen.getByRole('button', { name: 'Reconnect' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass(
      'flex-none',
      'rounded',
      'border',
      'border-border',
      'px-1.5',
      'py-0.5',
      'text-2xs',
      'text-fg',
      'hover:bg-overlay',
    );
  });

  it('spins the icon and renders no button when no action is given (the newSessionPending shape)', () => {
    render(<RecoveryRow icon={{ name: 'loading', spin: true, className: 'flex-none' }} message="Starting a new session…" />);

    const row = screen.getByText('Starting a new session…').closest('div');
    const icon = row?.querySelector('.codicon-loading');
    expect(icon).toHaveClass('codicon-modifier-spin', 'flex-none');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls the action onClick exactly once when the button is clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <RecoveryRow
        icon={{ name: 'warning', className: 'flex-none text-warn' }}
        message="Session lost."
        action={{ label: 'History', onClick }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
