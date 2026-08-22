import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GatewayHealthBanner } from './GatewayHealthBanner';

describe('UX-02: GatewayHealthBanner', () => {
  it('ok: no visual banner, but the live region IS mounted (empty) — Finding-7', () => {
    render(<GatewayHealthBanner health={{ state: 'ok' }} onForceReconnect={async () => undefined} />);
    expect(screen.queryByText(/Management link/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('down: standing banner + polite announcement carrying the live attempts counter', () => {
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 12 }} onForceReconnect={async () => undefined} />);
    // Finding-7: the standing text is deliberately DUAL-CHANNEL — the same
    // sentence appears both in the always-visible row and (redundantly) in
    // the permanently-mounted sr-only region, so a plain `getByText` matches
    // both nodes. Scope to the visible row's stable production class (same
    // precedent as Composer.dom.test.tsx's `attachNoticeRegion` helper).
    expect(
      screen.getByText('Management link down — panels may be stale (retrying — 12 attempts so far).', {
        selector: 'span.flex-1',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Management link down');
    expect(screen.getByRole('button', { name: 'Force reconnect' })).toBeEnabled();
  });

  it('degraded: the softer copy', () => {
    render(<GatewayHealthBanner health={{ state: 'degraded', attempts: 5 }} onForceReconnect={async () => undefined} />);
    expect(
      screen.getByText('Management link unstable — panels may be stale (retrying — 5 attempts so far).', {
        selector: 'span.flex-1',
      }),
    ).toBeInTheDocument();
  });

  it('recovery: ok AFTER an outage announces restoration through the same region', () => {
    const { rerender } = render(
      <GatewayHealthBanner health={{ state: 'down', attempts: 10 }} onForceReconnect={async () => undefined} />,
    );
    rerender(<GatewayHealthBanner health={{ state: 'ok' }} onForceReconnect={async () => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Management link restored.');
    expect(screen.queryByRole('button', { name: 'Force reconnect' })).not.toBeInTheDocument();
  });

  it('Force reconnect: invokes the callback, disables while pending, surfaces + announces a refusal', async () => {
    const user = userEvent.setup();
    let reject!: (reason: Error) => void;
    const onForceReconnect = vi.fn(() => new Promise<unknown>((_resolve, rej) => { reject = rej; }));
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} onForceReconnect={onForceReconnect} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    expect(onForceReconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reconnecting…' })).toBeDisabled();
    await act(async () => {
      reject(new Error('The agent is already (re)connecting — wait a moment, then re-check.'));
    });
    expect(screen.getByRole('button', { name: 'Force reconnect' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Force reconnect failed:');
    // Same dual-channel duplication as above: the raw reason is echoed in
    // both the region and the visible failure span. Scope to the visible
    // span's stable production class.
    expect(screen.getByText(/already \(re\)connecting/, { selector: 'span.text-del' })).toBeInTheDocument();
  });

  it('axe-style: no unnamed buttons; the interactive control lives OUTSIDE the live element', () => {
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} onForceReconnect={async () => undefined} />);
    const unnamed = screen.getAllByRole('button').filter((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length === 0);
    expect(unnamed).toEqual([]);
    const region = screen.getByRole('status');
    expect(region.querySelector('button')).toBeNull();
  });
});
