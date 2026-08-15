/* Tools panel: toolset bundles with a real per-TOOLSET enable switch over
 * Hermes's dashboard REST surface (`PUT /api/tools/toolsets/{name}`), each
 * showing its member tools (read-only). Optimistic write-through with
 * rollback-on-error; bulk toggles serialized (see useToggle). The dashboard
 * toggles at the toolset level — there is no per-tool enable route. */
import type { ToolsData, ToolInfo, ToolKind } from '../protocol';
import { totalLookup } from '../lookup';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Toggle } from '../components/Toggle';
import { PanelShell, SectionLabel } from './PanelShell';
import { useToggle } from './useToggle';

interface ToolsPanelProps {
  data: ToolsData;
  /** Persist a toolset enable/disable (correlated → resolves/rejects). */
  onToggle: (name: string, enabled: boolean) => Promise<unknown>;
}

/** Exported (UI-I1 sibling) so `ToolsPanel.test.ts` can exercise the total
 * lookup directly — this repo's webview tests don't use jsdom. */
export const KIND_ICON: Record<ToolKind, string> = {
  read: 'file',
  edit: 'edit',
  execute: 'terminal',
  search: 'search',
  fetch: 'globe',
  think: 'lightbulb',
  other: 'tools',
};

/** UI-I1 sibling: an out-of-contract `kind` degrades gracefully today
 * (`codicon-undefined` renders no glyph) but is still guarded for honesty. */
export const UNKNOWN_KIND_ICON = 'question';

function toolsByToolset(tools: ToolInfo[]): Map<string, ToolInfo[]> {
  const map = new Map<string, ToolInfo[]>();
  for (const t of tools) {
    const list = map.get(t.toolset) ?? [];
    list.push(t);
    map.set(t.toolset, list);
  }
  return map;
}

export function ToolsPanel({ data, onToggle }: ToolsPanelProps) {
  const { isOn, toggle, lastError } = useToggle(onToggle);
  const grouped = toolsByToolset(data.tools);

  return (
    <PanelShell title="Tools" meta="Hermes CLI & desktop sessions">
      {/* TG-1 (AU-47, ADR-4 "bless the reality"): this panel writes
          `platform_toolsets.cli`, which the editor chat's `hermes acp` agent
          NEVER reads — its toolset is a hardcoded constant, built once at
          session mint. The toggles below are real (they govern Hermes' CLI
          and desktop sessions), so the fix is honest relabeling, not hiding:
          the caption above states the TRUE scope (C2 read-only-caption
          precedent, `SettingsPanel.tsx`'s `meta="read-only"`), and this note
          (C1/C3 relocated-note precedent — lives ABOVE the toolset loop so it
          reads as a panel-level note, not the last group's own caption)
          spells it out. Intentional, announced copy change — supersedes the
          prior persist-latency-only wording. */}
      <p className="mb-2 px-1 text-2xs leading-snug text-faint">
        These toggles govern Hermes' CLI and desktop sessions. The editor chat uses Hermes' fixed editor
        toolset and is not affected.
      </p>
      {data.toolsets.map((ts) => {
        const on = isOn(ts.name, ts.enabled);
        const err = lastError(ts.name);
        return (
          <div key={ts.name}>
            <div className="mb-1.5 mt-3 flex items-center gap-2 first:mt-0">
              <SectionLabel>{ts.name}</SectionLabel>
              <span className="font-mono text-2xs text-faint">{ts.toolCount} tools</span>
              <span className="ml-auto flex-none">
                <Toggle on={on} label={`Enable ${ts.name} toolset`} onChange={(next) => toggle(ts.name, next)} />
              </span>
            </div>
            {/* V-11 (TOGGLE-HONESTY): see SkillsPanel.tsx's identical block —
                same grammar as SettingsPanel's FieldRow, mounted
                unconditionally (WCAG 2.2 SC 4.1.3), only its text swaps. */}
            <LiveRegion text={err ? `Not saved: ${err}` : ''} className="mb-1.5 text-2xs text-del" title={err} />
            {(grouped.get(ts.name) ?? []).map((t) => (
              <div
                key={t.name}
                className={`mb-1.5 flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 ${
                  on ? '' : 'opacity-50'
                }`}
              >
                <Icon
                  name={totalLookup(KIND_ICON, t.kind, UNKNOWN_KIND_ICON)}
                  size={15}
                  className="flex-none text-muted"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-fg">
                    {t.name}
                    {t.source !== 'core' && (
                      <span className="ml-1.5 text-2xs uppercase tracking-wide text-faint">{t.source}</span>
                    )}
                  </div>
                  {t.description && <div className="text-2xs leading-snug text-muted">{t.description}</div>}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </PanelShell>
  );
}
