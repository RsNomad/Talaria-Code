/**
 * UX-02 (F2-19 UI face): the standing management-link banner. Fed by the
 * `gateway.health` push (AppState.gatewayHealth). Finding-7 discipline: the
 * LiveRegion below is PERMANENTLY mounted (only its text swaps); only the
 * VISUAL row is conditional. Polite (role=status), not assertive: this is a
 * standing state — the one-shot outage interruption is `system.error`'s job
 * (ErrorBanner, role=alert). The Force-reconnect button lives OUTSIDE the
 * live element (interactive content inside a status region pollutes the
 * announcement — same sibling pattern as Composer's attachNotice dismiss).
 * Visual language mirrors the App standing rows (App.tsx:852-864).
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { LiveRegion } from './LiveRegion';
import { ConfirmStrip } from './ConfirmStrip';
import { busyInteraction } from './busyInteraction';
import type { GatewayHealthView } from '../types';

function bannerText(health: GatewayHealthView): string {
  const retrying =
    health.attempts !== undefined ? ` (retrying — ${health.attempts} attempts so far)` : ' (retrying)';
  return health.state === 'down'
    ? `Management link down — panels may be stale${retrying}.`
    : `Management link unstable — panels may be stale${retrying}.`;
}

export function GatewayHealthBanner({
  health,
  anyTurnLive,
  onForceReconnect,
}: {
  health: GatewayHealthView;
  /** 12b: any tab's turn is live — the webview mirror of the liveness the
   * host's force guard fans out over (force-reconnect ends EVERY live turn,
   * so any-tab-live is the honest gate, not just the active tab). */
  anyTurnLive: boolean;
  /** Posts `setup.reconnectAgent {force:true}` — resolves on ok, REJECTS with the redacted refusal reason (dispatchSetup contract, App.tsx:591). */
  onForceReconnect: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  // Recovery announcement: only announce "restored" if an outage was ever shown.
  const sawOutage = useRef(false);
  if (health.state !== 'ok') sawOutage.current = true;

  /** 12b (C4 pattern, SessionsPanel.tsx:112-130): the inline "force reconnect
   * anyway?" strip — at most one confirm at a time (trivial here: one banner,
   * one action). NN/g: "Use a confirmation dialog before committing to
   * actions with serious consequences — such as destroying users' work" —
   * force-reconnect cancels every live turn, so a live turn asks first. */
  const [confirming, setConfirming] = useState(false);
  const reconnectRef = useRef<HTMLButtonElement | null>(null);
  // A11Y-07: focus-on-mount and the confirm control itself now live inside
  // the shared ConfirmStrip (ariaLabel-named alertdialog) — no local
  // confirmRef/focus-effect needed here.

  // 12b review fix (Task 2 — untouched by A11Y-07): an open confirm belongs
  // to ONE outage. If health recovers while the strip is up, the question
  // ("force reconnect will cancel the turn") is moot — drop it so a LATER
  // outage never resurrects a stale consent prompt the user did not just ask
  // for.
  useEffect(() => {
    if (health.state === 'ok') setConfirming(false);
  }, [health.state]);

  const announcement = failure
    ? `Force reconnect failed: ${failure}`
    : health.state !== 'ok'
      ? bannerText(health)
      : sawOutage.current
        ? 'Management link restored.'
        : '';

  const forceReconnect = () => {
    setPending(true);
    setFailure('');
    onForceReconnect().then(
      () => setPending(false),
      (err: unknown) => {
        setPending(false);
        setFailure(err instanceof Error ? err.message : String(err));
      },
    );
  };

  // A11Y-07/ADR-UX-P2-1: the trigger goes BUSY (not natively disabled) while
  // its own request is in flight, so it stays focusable for the moment
  // ConfirmStrip's `returnFocus` lands back on it mid-flight (see the ADR
  // test in the .dom.test.tsx). `pending` has no genuine-indefinite half
  // here — it's a pure in-flight gate — so it goes entirely into the second
  // (busy) argument, per busyInteraction's MIXED-site convention.
  const reconnectInteraction = busyInteraction(false, pending);

  const requestForceReconnect = () => {
    if (!reconnectInteraction.interactive) return; // busy guard, mirrors the native disabled it replaced
    if (anyTurnLive) {
      // 12b: never kill a live turn on a title-warning alone — ask first.
      setConfirming(true);
      return;
    }
    forceReconnect(); // no live turn → unchanged immediate fire (Task 12)
  };

  const confirmForceReconnect = () => {
    setConfirming(false);
    // If the turn ended while the strip was open, this is just a normal
    // force reconnect — still correct, nothing left to cancel (see the
    // race note in this task's header). Focus return is ConfirmStrip's job
    // now (ADR-UX-P2-1, `returnFocus`) — not this handler's.
    forceReconnect();
  };

  return (
    <>
      <LiveRegion text={announcement} className="sr-only" />
      {health.state !== 'ok' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 text-2xs text-muted">
          <Icon name="warning" size={12} className="flex-none text-warn" />
          <span className="min-w-0 flex-1">{bannerText(health)}</span>
          <button
            ref={reconnectRef}
            type="button"
            onClick={requestForceReconnect}
            disabled={reconnectInteraction.nativeDisabled}
            aria-disabled={reconnectInteraction.ariaDisabled}
            aria-busy={reconnectInteraction.ariaBusy}
            title="Force reconnect — cancels any running turn and rebuilds the agent connection"
            className="flex-none rounded border border-border px-1.5 py-0.5 text-2xs text-fg hover:bg-overlay aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            {pending ? 'Reconnecting…' : 'Force reconnect'}
          </button>
          {confirming && (
            <ConfirmStrip
              className="basis-full"
              ariaLabel="Confirm force reconnect"
              message="A turn is still running — force reconnect will cancel it."
              confirmLabel="Force reconnect anyway"
              onConfirm={confirmForceReconnect}
              onCancel={() => setConfirming(false)}
              returnFocus={() => reconnectRef.current?.focus()}
            />
          )}
          {failure && <span className="min-w-0 basis-full text-del">{failure}</span>}
        </div>
      )}
    </>
  );
}
