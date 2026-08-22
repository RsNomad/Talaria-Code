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
import { useRef, useState } from 'react';
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
  onForceReconnect,
}: {
  health: GatewayHealthView;
  /** Posts `setup.reconnectAgent {force:true}` — resolves on ok, REJECTS with the redacted refusal reason (dispatchSetup contract, App.tsx:591). */
  onForceReconnect: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  // Recovery announcement: only announce "restored" if an outage was ever shown.
  const sawOutage = useRef(false);
  if (health.state !== 'ok') sawOutage.current = true;

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

  return (
    <>
      <LiveRegion text={announcement} className="sr-only" />
      {health.state !== 'ok' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 text-2xs text-muted">
          <Icon name="warning" size={12} className="flex-none text-warn" />
          <span className="min-w-0 flex-1">{bannerText(health)}</span>
          <button
            type="button"
            onClick={forceReconnect}
            disabled={pending}
            title="Force reconnect — cancels any running turn and rebuilds the agent connection"
            className="flex-none rounded border border-border px-1.5 py-0.5 text-2xs text-fg hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Reconnecting…' : 'Force reconnect'}
          </button>
          {failure && <span className="min-w-0 basis-full text-del">{failure}</span>}
        </div>
      )}
    </>
  );
}
