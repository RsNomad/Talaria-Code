import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmStrip } from './ConfirmStrip';

/**
 * A11Y-07 harness: a trigger button + open-state, mirroring every real call
 * site's shape (GatewayHealthBanner's `reconnectRef`, the panels' row
 * buttons Tasks 8-11 will adopt). `returnFocus` focuses the trigger — this
 * is ConfirmStrip's own ADR-UX-P2-1 contract, exercised here exactly as a
 * real caller wires it, not re-implemented by the test.
 */
function Harness({
  onConfirm = () => {},
  onCancel = () => {},
  confirmBusy,
  openInitially,
}: {
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmBusy?: boolean;
  openInitially?: boolean;
}) {
  const [open, setOpen] = useState(openInitially ?? false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Danger
      </button>
      {open && (
        <ConfirmStrip
          message="This will hurt."
          confirmLabel="Do it anyway"
          ariaLabel="Confirm danger"
          onConfirm={() => {
            onConfirm();
            setOpen(false);
          }}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
          returnFocus={() => triggerRef.current?.focus()}
          confirmBusy={confirmBusy}
        />
      )}
    </div>
  );
}

describe('A11Y-07: ConfirmStrip', () => {
  it('is an alertdialog named by ariaLabel and described by its message, and focus lands on the confirm control on mount', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Danger' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm danger' });
    expect(dialog).toHaveAccessibleDescription('This will hurt.');
    expect(dialog).not.toHaveAttribute('aria-modal');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Do it anyway' })));
  });

  it('Escape cancels and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Danger' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Do it anyway' })));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Danger' })));
  });

  it('confirm fires onConfirm once and returns focus to the trigger (ADR-UX-P2-1)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Danger' }));
    await user.click(screen.getByRole('button', { name: 'Do it anyway' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Danger' })));
  });

  it('confirmBusy renders the confirm aria-disabled + aria-busy, still focusable, click guarded', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} confirmBusy openInitially />);
    const confirmButton = screen.getByRole('button', { name: 'Do it anyway' });
    expect(confirmButton, 'busy must stay focusable — never natively disabled').not.toBeDisabled();
    expect(confirmButton).toHaveAttribute('aria-disabled', 'true');
    expect(confirmButton).toHaveAttribute('aria-busy', 'true');
    await user.click(confirmButton);
    expect(onConfirm, 'the click guard must block onConfirm while busy').not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Confirm danger' }), 'still open — the guarded click did not close it').toBeInTheDocument();
  });
});
