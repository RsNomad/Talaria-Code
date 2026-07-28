/* Skills panel: real enable/disable switches over Hermes's dashboard REST
 * surface (`PUT /api/skills/toggle`). Optimistic write-through with
 * rollback-on-error; bulk toggles are serialized (see useToggle). Rows show the
 * real description + provenance + usage the dashboard `GET /api/skills` returns. */
import type { SkillInfo, SkillsData } from '../protocol';
import { totalLookup } from '../lookup';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill } from '../components/Pill';
import { Toggle } from '../components/Toggle';
import { PanelShell } from './PanelShell';
import { useToggle } from './useToggle';

interface SkillsPanelProps {
  data: SkillsData;
  /** Persist a skill enable/disable (correlated → resolves/rejects). */
  onToggle: (name: string, enabled: boolean) => Promise<unknown>;
  /** Re-fetch the list from the dashboard (Reload). */
  onRefresh: () => void;
}

/** Human labels for the dashboard `provenance` classification. Exported
 * (UI-I1 sibling) so `SkillsPanel.test.ts` can exercise the total lookup
 * directly — this repo's webview tests don't use jsdom. */
export const PROVENANCE_LABEL: Record<NonNullable<SkillInfo['provenance']>, string> = {
  hub: 'hub',
  bundled: 'bundled',
  agent: 'local',
};

/** UI-I1 sibling: an out-of-contract `provenance` degrades gracefully today
 * (`<Pill>{undefined}</Pill>` renders no text) but is still guarded for
 * honesty. */
export const UNKNOWN_PROVENANCE_LABEL = 'unknown';

export function SkillsPanel({ data, onToggle, onRefresh }: SkillsPanelProps) {
  const { isOn, toggle, lastError } = useToggle(onToggle);

  return (
    <PanelShell title="Skills" meta={`${data.skills.length} skills`}>
      {data.skills.map((sk) => {
        const err = lastError(sk.id);
        return (
          <div
            key={sk.id}
            className="mb-1.5 flex items-start gap-2 rounded-card border border-border bg-surface px-3 py-2"
          >
            <Icon name="extensions" size={15} className="mt-0.5 flex-none text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-xs text-fg">{sk.name}</span>
                <Pill tone="neutral">{sk.category}</Pill>
                {sk.provenance && (
                  <Pill tone="neutral">
                    {totalLookup(PROVENANCE_LABEL, sk.provenance, UNKNOWN_PROVENANCE_LABEL)}
                  </Pill>
                )}
                {typeof sk.usage === 'number' && sk.usage > 0 && (
                  <span className="text-2xs text-faint">used {sk.usage}×</span>
                )}
              </div>
              {sk.description && (
                <div className="mt-0.5 text-2xs leading-snug text-muted">{sk.description}</div>
              )}
              {/* V-11 (TOGGLE-HONESTY): a rejected persist used to roll the
                  switch back with NOTHING surfaced anywhere. Same grammar
                  SettingsPanel's FieldRow already carries (SettingsPanel.tsx:
                  159): a permanently-mounted LiveRegion (WCAG 2.2 SC 4.1.3),
                  only its text swaps — never conditionally mounted. */}
              <LiveRegion text={err ? `Not saved: ${err}` : ''} className="text-2xs text-del" title={err} />
            </div>
            <div className="flex-none pt-0.5">
              <Toggle
                on={isOn(sk.id, sk.enabled)}
                label={`Enable ${sk.name}`}
                onChange={(next) => toggle(sk.id, next)}
              />
            </div>
          </div>
        );
      })}

      <p className="mt-1 px-1 text-2xs leading-snug text-faint">
        Toggles persist immediately and apply to new sessions; a chat already running may keep its
        current skills until its next session.
      </p>

      <button
        type="button"
        onClick={onRefresh}
        className="mt-1 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        <Icon name="refresh" size={13} />
        Reload skills
      </button>
    </PanelShell>
  );
}
