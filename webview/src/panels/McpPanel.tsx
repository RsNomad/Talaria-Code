/* MCP panel: configured servers with connection status, and a real
 * "Reload servers" action. Status is only ever connected/disconnected — the
 * join that feeds it (config.get + tools.list) can't observe a live error/
 * running state — so the former per-server error card + Retry (which gated on a
 * status that never occurs) were removed (W1.5 / A4).
 *
 * A#5: "Reload servers" now runs over the CORRELATED request path (`onReload`
 * resolves with the gateway's `{status, message?}` envelope, or rejects), so the
 * server's confirmation / failure is SURFACED inline instead of being dropped by
 * a fire-and-forget invoke. The click is still the confirmation (the host sends
 * `confirm:true`); we only make the RESULT visible. */
import { useState } from 'react';
import type { McpData, McpStatus } from '../protocol';
import { totalLookup } from '../lookup';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill, type PillTone } from '../components/Pill';
import { PanelShell } from './PanelShell';

/** Exported (UI-I1) so `McpPanel.test.ts` can exercise the total lookup
 * directly — this repo's webview tests don't use jsdom. */
export const STATUS: Record<McpStatus, { tone: PillTone; label: string; icon: string }> = {
  connected: { tone: 'add', label: 'Connected', icon: 'circle-filled' },
  disconnected: { tone: 'neutral', label: 'Disconnected', icon: 'circle-outline' },
};

/** UI-I1: a server `status` outside the known `McpStatus` enum (a
 * version-skewed or buggy host — `bridge.ts` only checks `.type`) falls back
 * to this instead of `STATUS[bad]` being `undefined` and `.tone` throwing
 * mid-render. */
export const UNKNOWN_MCP_STATUS: { tone: PillTone; label: string; icon: string } = {
  tone: 'neutral',
  label: 'Unknown',
  icon: 'question',
};

interface McpPanelProps {
  data: McpData;
  /** Correlated reload — resolves with the gateway's reload result, or rejects. */
  onReload: () => Promise<unknown>;
}

/** A user-facing notice derived from the reload outcome. */
interface ReloadNotice {
  tone: 'ok' | 'error';
  text: string;
}

/**
 * Turn the gateway's reload result into a notice. `reload.mcp` returns
 * `{status: 'reloaded'|'confirm_required', message?}` (`tui_gateway/server.py:
 * 11148-11221`). Since the host sends `confirm:true`, the normal outcome is
 * `reloaded`; we still surface `message` verbatim when present so the server's
 * own words show through.
 */
function interpretReload(result: unknown): ReloadNotice {
  const r = (result ?? {}) as { status?: unknown; message?: unknown };
  const message = typeof r.message === 'string' && r.message ? r.message : undefined;
  if (r.status === 'reloaded') return { tone: 'ok', text: message ?? 'MCP servers reloaded.' };
  if (r.status === 'confirm_required') {
    return { tone: 'error', text: message ?? 'Reload needs confirmation.' };
  }
  return { tone: 'ok', text: message ?? 'Reload requested.' };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Reload failed.';
}

export function McpPanel({ data, onReload }: McpPanelProps) {
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<ReloadNotice | undefined>();

  const handleReload = () => {
    setReloading(true);
    setNotice(undefined);
    void onReload()
      .then(
        (result) => setNotice(interpretReload(result)),
        (err: unknown) => setNotice({ tone: 'error', text: errorMessage(err) }),
      )
      .finally(() => setReloading(false));
  };

  return (
    <PanelShell title="Active MCP servers" meta={`${data.servers.length} configured`}>
      {data.servers.map((srv) => {
        const s = totalLookup(STATUS, srv.status, UNKNOWN_MCP_STATUS);
        return (
          <div key={srv.id} className="mb-2 rounded-card border border-border bg-surface px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Icon name="server-process" size={15} className="flex-none text-accent" />
              <span className="min-w-0 truncate font-mono text-xs text-fg">{srv.name}</span>
              <span className="ml-auto flex-none">
                <Pill tone={s.tone} icon={s.icon}>
                  {s.label}
                </Pill>
              </span>
            </div>
            <div className="mt-1.5 truncate font-mono text-2xs text-faint" title={srv.command}>
              {srv.command}
            </div>
            <div className="mt-1 font-mono text-2xs uppercase tracking-wide text-faint">
              {srv.toolCount} tools
            </div>
          </div>
        );
      })}

      {/* Reload result / error surfaced inline (A#5). T-15/F6: the
          screen-reader announcement is carried by the permanently-mounted
          `LiveRegion` below (Finding-7 discipline — the region itself must
          never be conditionally mounted, only its text swaps); the colored
          card here is the sighted-user rendering of the same notice and no
          longer carries its own role="status", which would double-announce
          the same text. */}
      <LiveRegion text={notice?.text ?? ''} className="sr-only" />
      {notice && (
        <div
          className={`mt-1 flex items-start gap-2 rounded-card border px-3 py-2 text-2xs ${
            notice.tone === 'ok'
              ? 'border-border bg-surface text-muted'
              : 'border-del bg-del-soft text-fg'
          }`}
        >
          <Icon
            name={notice.tone === 'ok' ? 'check' : 'error'}
            size={13}
            className={`mt-0.5 flex-none ${notice.tone === 'ok' ? 'text-accent' : 'text-del'}`}
          />
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
        </div>
      )}

      {/* Real reload: the gateway gates `reload.mcp` behind a confirm
          (`approvals.mcp_reload_confirm`, default true) and returns
          `{status:'confirm_required'}` with no `confirm` — so the click IS the
          confirmation. `confirm:true` makes it actually reload
          (`tui_gateway/server.py:11148-11221`), after which the host re-fetches
          the panel. The correlated request lets us show the result above. */}
      <button
        type="button"
        onClick={handleReload}
        disabled={reloading}
        className="mt-1 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60 disabled:hover:border-border disabled:hover:text-muted"
      >
        <Icon name={reloading ? 'loading' : 'refresh'} size={13} spin={reloading} />
        {reloading ? 'Reloading…' : 'Reload servers'}
      </button>
    </PanelShell>
  );
}
