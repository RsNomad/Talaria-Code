import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GatewayHealthBanner } from './GatewayHealthBanner';

describe('UX-02: GatewayHealthBanner', () => {
  it('ok: no visual banner, but the live region IS mounted (empty) — Finding-7', () => {
    render(<GatewayHealthBanner health={{ state: 'ok' }} anyTurnLive={false} onForceReconnect={async () => undefined} />);
    expect(screen.queryByText(/Management link/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('down: standing banner + polite announcement carrying the live attempts counter', () => {
    render(
      <GatewayHealthBanner health={{ state: 'down', attempts: 12 }} anyTurnLive={false} onForceReconnect={async () => undefined} />,
    );
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
    render(
      <GatewayHealthBanner health={{ state: 'degraded', attempts: 5 }} anyTurnLive={false} onForceReconnect={async () => undefined} />,
    );
    expect(
      screen.getByText('Management link unstable — panels may be stale (retrying — 5 attempts so far).', {
        selector: 'span.flex-1',
      }),
    ).toBeInTheDocument();
  });

  it('recovery: ok AFTER an outage announces restoration through the same region', () => {
    const { rerender } = render(
      <GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={false} onForceReconnect={async () => undefined} />,
    );
    rerender(<GatewayHealthBanner health={{ state: 'ok' }} anyTurnLive={false} onForceReconnect={async () => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Management link restored.');
    expect(screen.queryByRole('button', { name: 'Force reconnect' })).not.toBeInTheDocument();
  });

  /**
   * A11Y-07/ADR-UX-P2-1 (task-7-brief.md, "Trigger button" adoption): the
   * OLD assertion (`toBeDisabled()`) encoded the F-8-flavored bug this task
   * fixes — natively disabling the trigger the instant a request is in
   * flight blurs a keyboard/screen-reader user to `<body>`, exactly when the
   * ADR wants focus to LAND there (the confirm→returnFocus path returns
   * focus to this very button while it reads "Reconnecting…"). Rewritten to
   * the busy posture: `.not.toBeDisabled()` + `aria-disabled` + `aria-busy`,
   * matching CheckpointsPanel.dom.test.tsx's AU-40 precedent.
   */
  it('Force reconnect: invokes the callback, goes BUSY (not natively disabled) while pending, surfaces + announces a refusal', async () => {
    const user = userEvent.setup();
    let reject!: (reason: Error) => void;
    const onForceReconnect = vi.fn(() => new Promise<unknown>((_resolve, rej) => { reject = rej; }));
    render(
      <GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={false} onForceReconnect={onForceReconnect} />,
    );
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    expect(onForceReconnect).toHaveBeenCalledTimes(1);
    const reconnecting = screen.getByRole('button', { name: 'Reconnecting…' });
    expect(reconnecting, 'A11Y-07: an in-flight trigger must stay focusable — never natively disabled').not.toBeDisabled();
    expect(reconnecting).toHaveAttribute('aria-disabled', 'true');
    expect(reconnecting).toHaveAttribute('aria-busy', 'true');
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
    render(
      <GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={false} onForceReconnect={async () => undefined} />,
    );
    const unnamed = screen.getAllByRole('button').filter((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length === 0);
    expect(unnamed).toEqual([]);
    const region = screen.getByRole('status');
    expect(region.querySelector('button')).toBeNull();
  });
});

describe('UX-02/12b: confirm-on-live-turn gate for Force reconnect (SessionsPanel C4 pattern)', () => {
  const noop = async () => undefined;

  it('live turn: Force reconnect asks first — callback NOT fired, ConfirmStrip alertdialog shown (RED: pre-fix the click fires immediately)', async () => {
    const user = userEvent.setup();
    const onForceReconnect = vi.fn(async () => undefined);
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={onForceReconnect} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    expect(onForceReconnect).not.toHaveBeenCalled(); // the defect this task closes: no turn may die on a title-warning alone
    // A11Y-07 (task-7-brief.md): was `role="group"` — the inline strip
    // mounted with no dialog semantics at all, a consent surface an SR user
    // could not tell apart from a plain status readout. Now the shared
    // ConfirmStrip's `role="alertdialog"`, named the same way.
    expect(screen.getByRole('alertdialog', { name: 'Confirm force reconnect' })).toBeInTheDocument();
    expect(screen.getByText('A turn is still running — force reconnect will cancel it.')).toBeInTheDocument();
  });

  it('no live turn: fires immediately, no confirm strip (unchanged Task 12 behavior — the control)', async () => {
    const user = userEvent.setup();
    const onForceReconnect = vi.fn(async () => undefined);
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={false} onForceReconnect={onForceReconnect} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    expect(onForceReconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog', { name: 'Confirm force reconnect' })).not.toBeInTheDocument();
  });

  it('confirm: "Force reconnect anyway" fires the callback exactly once and closes the strip', async () => {
    const user = userEvent.setup();
    const onForceReconnect = vi.fn(async () => undefined);
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={onForceReconnect} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    await user.click(screen.getByRole('button', { name: 'Force reconnect anyway' }));
    expect(onForceReconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog', { name: 'Confirm force reconnect' })).not.toBeInTheDocument();
  });

  it('a11y: opening moves focus to the confirm control; Cancel closes and returns focus to Force reconnect', async () => {
    const user = userEvent.setup();
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={noop} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Force reconnect anyway' })));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: 'Confirm force reconnect' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Force reconnect' })));
  });

  it('a11y: Escape inside the strip cancels and returns focus (same treatment as Cancel)', async () => {
    const user = userEvent.setup();
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={noop} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog', { name: 'Confirm force reconnect' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Force reconnect' })));
  });

  it('axe-style (role/name/value) while confirming: every button named; still no interactive content inside the live element', async () => {
    const user = userEvent.setup();
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={noop} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    const unnamed = screen.getAllByRole('button').filter((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length === 0);
    expect(unnamed).toEqual([]);
    expect(screen.getByRole('status').querySelector('button')).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'Confirm force reconnect' })).toBeInTheDocument();
  });

  /**
   * ADR-UX-P2-1 (task-7-brief.md, "Trigger button" adoption): confirm's
   * `returnFocus` lands on the trigger while it is ALREADY busy — the
   * confirm click both fires `forceReconnect()` (which sets `pending`
   * synchronously) and hands focus back in the same commit, so the button
   * the strip returns focus to is the "Reconnecting…" one, not a stale
   * "Force reconnect" label. This is the load-bearing proof the trigger
   * stayed busy-focusable through the whole round trip, not just disabled
   * then silently unreachable.
   */
  it('ADR-UX-P2-1: confirming returns focus to the trigger, which is now busy ("Reconnecting…")', async () => {
    const user = userEvent.setup();
    const onForceReconnect = vi.fn(() => new Promise<unknown>(() => {})); // never resolves — hold the busy state
    render(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={onForceReconnect} />);
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    await user.click(screen.getByRole('button', { name: 'Force reconnect anyway' }));
    const reconnecting = screen.getByRole('button', { name: 'Reconnecting…' });
    await waitFor(() => expect(document.activeElement).toBe(reconnecting));
    expect(reconnecting).not.toBeDisabled();
    expect(reconnecting).toHaveAttribute('aria-disabled', 'true');
    expect(reconnecting).toHaveAttribute('aria-busy', 'true');
  });

  it('12b fix: a confirm strip left open when health recovers does NOT reappear on the next outage', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={noop} />,
    );
    await user.click(screen.getByRole('button', { name: 'Force reconnect' }));
    expect(screen.getByText('A turn is still running — force reconnect will cancel it.')).toBeInTheDocument();
    rerender(<GatewayHealthBanner health={{ state: 'ok' }} anyTurnLive={true} onForceReconnect={noop} />); // recovery — banner row unmounts
    rerender(<GatewayHealthBanner health={{ state: 'down', attempts: 10 }} anyTurnLive={true} onForceReconnect={noop} />); // NEW outage
    // Without the fix, stale `confirming` re-mounts the strip with no fresh request:
    expect(screen.queryByText('A turn is still running — force reconnect will cancel it.')).toBeNull();
  });
});
