/*
 * Settings panel: the flattened config.yaml sections. Each field renders by its
 * declared type — booleans as toggles, enums as a segmented picker, everything
 * else as a read-out. Edits post `config.set`.
 *
 * D3/N13: `config.set` rides the CORRELATED `bridge.request` path (like
 * `toolsets.toggle`/`skills.toggle`/`reload.mcp`), not fire-and-forget
 * `control.invoke` — a rejected/failed write now visibly ROLLS BACK the row
 * instead of leaving it showing an unpersisted value forever. `onSetConfig`
 * resolves ok on a successful persist and rejects otherwise (grounded in
 * `webview/src/rpc.ts`'s `handleResponse`: a `control.response{ok:false}`
 * REJECTS the pending promise, `{ok:true}` resolves with `result`) — mapped
 * 1:1 via `.then(confirm, rollback)` below. `reconcileFieldEditState` (P7-N6)
 * stays wired exactly as before as the OUTER prop-wins layer: any actual host
 * push (including one from a different editor) still corrects the row over
 * whatever this inner pending/confirmed/rolled-back state holds.
 *
 * Mock caveat (documented, not fixed): `MockBackend.invokeControl` acks
 * unknown methods with `{ok: true, mock: true, method}` (see
 * `src/host/backend/MockBackend.ts`), so on the standalone mock backend
 * `config.set` always "confirms" without actually persisting anything — fine
 * for the dev scaffold; the mock/real backend badge (D2) already makes the
 * mock visible.
 */
import { useState } from 'react';
import type { SettingsData, SettingField } from '../protocol';
import { LiveRegion } from '../components/LiveRegion';
import { Toggle } from '../components/Toggle';
import type { RemoteData } from '../state/remoteData';
import { PanelShell, RemotePanel, SectionLabel } from './PanelShell';
import { commitFieldEdit, initFieldEditState, reconcileFieldEditState, type FieldValue } from './settingsField';

interface SettingsPanelProps {
  /**
   * F-7: the settings panel's RemoteData ITSELF — idle, loading, error or
   * success — not resolved `SettingsData`. This panel owns the gate
   * internally (same shape as before Task 12, kept deliberately unchanged —
   * see the module doc above `SettingsPanel`) and applies it to the
   * config.yaml sections, which since Task 12 (§5.1/§5.2) is the whole of
   * this panel's content: NEXT consolidated into the Setup/Talaria-Config
   * panel (`SetupPanel.tsx`), so "Agent config" now holds Hermes
   * agent-runtime config only.
   *
   * Taking the un-narrowed union is still the load-bearing half: a caller
   * holding only resolved data can no longer satisfy this prop, so a
   * "mount the panel only once the agent answers" shape does not typecheck.
   */
  config: RemoteData<SettingsData> | undefined;
  /** Re-invoke the settings fetch (the gate's Retry). */
  onRetryConfig: () => void;
  /** Persist a config edit (correlated → resolves ok / rejects). */
  onSetConfig: (key: string, value: FieldValue) => Promise<unknown>;
}

function FieldRow({
  field,
  onSet,
}: {
  field: SettingField;
  onSet: (value: FieldValue) => Promise<unknown>;
}) {
  const [state, setState] = useState(() => initFieldEditState(field.value));
  // P7-N6 (UI-I2b): reconcile during RENDER (react.dev "You Might Not Need
  // an Effect" section "Adjusting some state when a prop changes"), not an
  // Effect -- an Effect would render one extra frame of the stale value. A
  // no-op while `field.value` hasn't moved since the last reconcile, so an
  // in-flight local edit survives an unrelated re-render; the moment the
  // prop DOES move (a host push), it wins over any local edit -- the row
  // can no longer permanently shadow a stale/rejected value forever.
  const reconciled = reconcileFieldEditState(state, field.value);
  if (reconciled !== state) setState(reconciled);
  const local = reconciled.displayValue;
  const { pending, lastError } = reconciled;

  // D3/N13, via the shared driver (Task 13): identical sequencing to the
  // inline version this replaced — `editFieldLocally` then confirm/rollback
  // off the correlated request's own resolve/reject.
  const commit = (next: FieldValue) => {
    void commitFieldEdit(setState, next, onSet);
  };

  const controlId = `settings-field-${field.key.replace(/\./g, '-')}`;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        {/* Audit G-3: the whole row used to be one <label>, so a click on the
            description or on the "Not saved: …" error flipped the switch and
            re-issued the write that had just failed. The error is exactly the
            text a user reaches for. Fix: label the TITLE only, via
            htmlFor/id, so "click the title to toggle" survives while the
            prose and the error become selectable. `Toggle`'s own aria-label
            remains the control's accessible name either way. */}
        <label htmlFor={controlId} className="block cursor-pointer font-mono text-xs text-fg">
          {field.key}
        </label>
        {field.description && <div className="text-2xs text-muted">{field.description}</div>}
        {/* A3 (WCAG 2.2 SC 4.1.3): the "Not saved" error rides the shared
            `LiveRegion` (polite) — permanently mounted, only its text swaps
            (Finding 7's mounted-empty discipline). Previously a
            conditionally-mounted plain div: a rejected config write was
            visible but never announced to a screen reader. */}
        <LiveRegion
          text={lastError ? `Not saved: ${lastError}` : ''}
          className="text-2xs text-del"
          title={lastError}
        />
      </div>

      {/* F-8: the switch takes `busy`, not `disabled` — an in-flight write
          must not blur the control the user is standing on (see
          `Toggle.tsx`). The `<select>` below still uses native `disabled`:
          same blur, but it is not what F-8 scoped, and unlike the switch it
          has no ARIA-only equivalent that keeps a native listbox operable —
          carried, noted in this fix wave's report. */}
      {field.type === 'boolean' ? (
        <Toggle id={controlId} on={local === true} label={field.key} busy={pending} onChange={commit} />
      ) : field.type === 'enum' && field.options ? (
        <select
          id={controlId}
          value={String(local)}
          disabled={pending}
          onChange={(e) => commit(e.target.value)}
          className="flex-none rounded border border-border bg-overlay px-2 py-0.5 font-mono text-2xs text-fg disabled:opacity-60"
        >
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <span className="flex-none font-mono text-2xs text-muted">{String(local)}</span>
      )}
      {pending && (
        <span className="flex-none text-2xs text-muted" aria-live="polite">
          Saving…
        </span>
      )}
    </div>
  );
}

export function SettingsPanel({ config, onRetryConfig, onSetConfig }: SettingsPanelProps) {
  return (
    <PanelShell title="Agent config">
      {/* Task 12 (§5.1/§5.2): this panel now holds Hermes agent-runtime
          config.yaml sections ONLY — the «Next Edit Suggestions» rows that
          used to render here (unconditionally, ahead of this gate, because
          they were extension `globalState`/setting state that needed no
          agent) moved to the Setup/Talaria-Config panel (`SetupPanel.tsx`),
          which reads the same frozen copy from `./nextEditCopy` and the same
          `nextEdit.state`/`nextEdit.toggle` protocol methods this panel used
          to consume. Nothing else in "Agent config" needs an agent-free
          escape hatch, so the RemotePanel gate below now covers the panel's
          entire content — kept as an internal gate (not an external
          App.tsx-side wrap) deliberately, to leave this shape unchanged
          rather than fold it into the ordinary external-RemotePanel pattern
          other panels use. Same `RemotePanel` every other data panel uses
          (Part X2): deliberately NOT a second, hand-rolled loading/error
          path, so there is still exactly one place in the app that decides
          what an unresolved panel looks like. */}
      <RemotePanel remote={config} loadingHint="Loading settings…" onRetry={onRetryConfig}>
        {(data) =>
          data.sections.map((section) => (
            <div key={section.name}>
              <SectionLabel>{section.name}</SectionLabel>
              <div className="overflow-hidden rounded-card border border-border">
                {section.fields.map((field) => (
                  <FieldRow key={field.key} field={field} onSet={(value) => onSetConfig(field.key, value)} />
                ))}
              </div>
            </div>
          ))
        }
      </RemotePanel>
    </PanelShell>
  );
}
