/*
 * Subagents / delegation panel: a flat, chronological list of `delegate_task`
 * calls observed on the LIVE ACP stream (host-side `SubagentAccumulator`),
 * each with its goal, live status, and a free-text preview/result once
 * available. Deliberately NOT a tree: the ACP stream only exposes the
 * delegate_task calls the MAIN agent makes directly — any further delegation
 * happening inside a spawned sub-agent is invisible to this stream, so there
 * is no role/model/depth/children to render (see `SubagentNode`'s fidelity
 * note in `protocol.ts`). For the same reason there is no pause/resume
 * control here — ACP exposes no such capability for a delegation, and
 * routing that button through tui_gateway would silently act on the wrong
 * process (per the wave-1 architecture decision, `docs/specs/wave-1-golive.md`).
 */
import type { SubagentsData, SubagentStatus } from '../protocol';
import { totalLookup } from '../lookup';
import { Icon } from '../components/Icon';
import { Pill, type PillTone } from '../components/Pill';
import { EmptyPanel, PanelShell } from './PanelShell';

/** Exported (UI-I1) so `SubagentsPanel.test.ts` can exercise the total
 * lookup directly — this repo's webview tests don't use jsdom. */
export const STATUS: Record<
  SubagentStatus,
  { tone: PillTone; label: string; icon: string; spin?: boolean }
> = {
  running: { tone: 'add', label: 'Running', icon: 'loading', spin: true },
  complete: { tone: 'add', label: 'Complete', icon: 'check' },
  failed: { tone: 'del', label: 'Failed', icon: 'error' },
  // X4: the delegation's turn was cancelled/interrupted before it reported a
  // completion — a terminal, non-error state (no live spinner).
  interrupted: { tone: 'warn', label: 'Interrupted', icon: 'circle-slash' },
};

/** UI-I1: a delegation `status` outside the known `SubagentStatus` enum (a
 * version-skewed or buggy host — `bridge.ts` only checks `.type`) falls back
 * to this instead of `STATUS[bad]` being `undefined` and `.tone` throwing
 * mid-render. */
export const UNKNOWN_SUBAGENT_STATUS: { tone: PillTone; label: string; icon: string; spin?: boolean } = {
  tone: 'neutral',
  label: 'Unknown',
  icon: 'question',
};

interface SubagentsPanelProps {
  data: SubagentsData;
  onInvoke: (method: string, params?: unknown) => void;
}

export function SubagentsPanel({ data }: SubagentsPanelProps) {
  if (data.delegations.length === 0) {
    return <EmptyPanel hint="No delegations yet — they appear here when Talaria delegates a task." />;
  }

  return (
    <PanelShell title="Subagents" meta={`${data.delegations.length} delegation${data.delegations.length === 1 ? '' : 's'}`}>
      <div className="flex flex-col gap-2">
        {data.delegations.map((d) => {
          const st = totalLookup(STATUS, d.status, UNKNOWN_SUBAGENT_STATUS);
          return (
            <div key={d.id} className="rounded-card border border-border bg-surface px-3 py-2">
              <div className="flex items-start gap-2">
                <Icon name="hubot" size={15} className="mt-0.5 flex-none text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-fg">{d.goal}</span>
                    <span className="ml-auto flex-none">
                      <Pill tone={st.tone} icon={st.icon} spin={st.spin} live={d.status === 'running'}>
                        {st.label}
                      </Pill>
                    </span>
                  </div>
                  {d.detail && (
                    <div className="mt-1 whitespace-pre-wrap text-2xs text-muted">{d.detail}</div>
                  )}
                  {d.startedAt && (
                    <div className="mt-1 font-mono text-2xs text-faint">{d.startedAt}</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}
