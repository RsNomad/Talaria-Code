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
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // a11y: focus lands on the confirm control the moment the strip opens.
  // Synchronous post-commit effect — no rAF needed (unlike useMenuFocus's
  // open-in-same-tick case): the strip mounts in the very commit that sets
  // `confirming`, so the node exists when this runs.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // 12b review fix: an open confirm belongs to ONE outage. If health
  // recovers while the strip is up, the question ("force reconnect will
  // cancel the turn") is moot — drop it so a LATER outage never resurrects
  // a stale consent prompt the user did not just ask for.
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

  const requestForceReconnect = () => {
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
    // race note in this task's header).
    forceReconnect();
  };

  const cancelConfirm = () => {
    setConfirming(false);
    reconnectRef.current?.focus(); // a11y: hand focus back where it came from
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
            disabled={pending}
            title="Force reconnect — cancels any running turn and rebuilds the agent connection"
            className="flex-none rounded border border-border px-1.5 py-0.5 text-2xs text-fg hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Reconnecting…' : 'Force reconnect'}
          </button>
          {confirming && (
            <div
              role="group"
              aria-label="Confirm force reconnect"
              className="basis-full rounded border border-warn bg-warn-soft px-2 py-1.5"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  cancelConfirm();
                }
              }}
            >
              <div className="flex items-start gap-1.5 text-2xs text-fg">
                <Icon name="warning" size={12} className="mt-0.5 flex-none text-warn" />
                <span>A turn is still running — force reconnect will cancel it.</span>
              </div>
              <div className="mt-1.5 flex gap-2">
                <button
                  ref={confirmRef}
                  type="button"
                  onClick={confirmForceReconnect}
                  className="rounded border border-warn px-2 py-0.5 font-mono text-2xs text-warn hover:bg-overlay"
                >
                  Force reconnect anyway
                </button>
                <button
                  type="button"
                  onClick={cancelConfirm}
                  className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {failure && <span className="min-w-0 basis-full text-del">{failure}</span>}
        </div>
      )}
    </>
  );
}
