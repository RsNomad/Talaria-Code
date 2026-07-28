/*
 * Models panel: active-model header plus the provider-grouped model list.
 * Selecting a model posts setModel to the host. Active is whichever model id
 * matches the EFFECTIVE current model (P7-N6, UI-I2a) — see
 * `resolveEffectiveModelId` below.
 */
import type { ModelsData } from '../protocol';
import { Icon } from '../components/Icon';
import { Pill } from '../components/Pill';
import { PanelShell, SectionLabel } from './PanelShell';
import { resolveEffectiveModelId } from './modelSelection';

interface ModelsPanelProps {
  data: ModelsData;
  /** P7-N6 (UI-I2a): the ACTIVE tab's optimistic model pick — the SAME
   * source the composer chip already trusts (`App.tsx`'s `modelLabel` reads
   * `activeTab.currentModelId`). `null` until the tab has ever picked/bound
   * a model, in which case the panel payload's `currentModelId` is
   * authoritative. */
  activeModelId: string | null;
  onSetModel: (modelId: string) => void;
  onInvoke: (method: string, params?: unknown) => void;
}

export function ModelsPanel({ data, activeModelId, onSetModel, onInvoke }: ModelsPanelProps) {
  // P7-N6 (UI-I2a): read the SAME effective model id the composer chip
  // uses — preferring the tab's optimistic pick over the (possibly stale)
  // panel payload — so selecting a model highlights immediately and never
  // disagrees with the chip.
  const effectiveModelId = resolveEffectiveModelId(activeModelId, data.currentModelId);
  const active = data.providers
    .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.name })))
    .find((m) => m.id === effectiveModelId);
  // G-10: the ACTIVE model's own provider — distinct from `active` above
  // (the active MODEL). Used only to derive the pill below.
  const activeProvider = data.providers.find((p) => p.models.some((m) => m.id === effectiveModelId));

  return (
    <PanelShell title="Models">
      {/* active model header */}
      <div className="rounded-card border border-border bg-surface px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="h-eyebrow">Active model</span>
          {/* Audit G-10: this pill was hardcoded `Online` and derived from
              nothing, so it could sit directly above the provider's own
              "not connected" marker below — the panel contradicting itself on
              one screen. It now reports the ACTIVE model's provider state, and
              says nothing when there is nothing to say. */}
          {activeProvider?.connected === true ? (
            <Pill tone="add" icon="zap">
              Online
            </Pill>
          ) : activeProvider?.connected === false ? (
            <Pill tone="warn" icon="warning">
              Not connected
            </Pill>
          ) : null}
        </div>
        <div className="mt-1.5 min-w-0">
          <div className="truncate font-mono text-sm text-fg">{active?.label ?? effectiveModelId}</div>
          <div className="truncate text-2xs text-faint">
            {active?.provider ?? 'unknown'}
            {active?.contextWindow ? ` · ${(active.contextWindow / 1000).toFixed(0)}k context` : ''}
          </div>
        </div>
      </div>

      {data.providers.map((p) => (
        <div key={p.id}>
          <SectionLabel>
            {p.name}
            {!p.connected && (
              <span className="ml-1.5 text-2xs normal-case text-warn">not connected</span>
            )}
          </SectionLabel>
          <div className="overflow-hidden rounded-card border border-border">
            {p.models.map((m) => {
              const isActive = m.id === effectiveModelId;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onSetModel(m.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className={`flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left last:border-0 ${
                    isActive ? 'bg-accent-soft' : 'bg-surface hover:bg-overlay'
                  }`}
                >
                  <Icon
                    name={isActive ? 'pass-filled' : 'circle-large-outline'}
                    size={14}
                    className={isActive ? 'flex-none text-accent' : 'flex-none text-faint'}
                  />
                  <span
                    className={`min-w-0 truncate font-mono text-xs ${
                      isActive ? 'text-accent' : 'text-fg'
                    }`}
                  >
                    {m.label}
                  </span>
                  {m.contextWindow && (
                    <span className="ml-auto flex-none">
                      <Pill tone="neutral">{(m.contextWindow / 1000).toFixed(0)}k</Pill>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onInvoke('model.save_key')}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        <Icon name="key" size={13} />
        Add provider key
      </button>
    </PanelShell>
  );
}
