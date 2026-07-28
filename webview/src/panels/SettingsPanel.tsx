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
import type {
  NextEditToggleSource,
  NextEditToggleState,
  SettingsData,
  SettingField,
} from '../protocol';
import { LiveRegion } from '../components/LiveRegion';
import { Toggle } from '../components/Toggle';
import type { RemoteData } from '../state/remoteData';
import { PanelShell, RemotePanel, SectionLabel } from './PanelShell';
import {
  commitFieldEdit,
  initFieldEditState,
  initNextEditRowState,
  reconcileFieldEditState,
  reconcileNextEditRowState,
  type FieldValue,
} from './settingsField';

interface SettingsPanelProps {
  /**
   * F-7: the settings panel's RemoteData ITSELF — idle, loading, error or
   * success — not resolved `SettingsData`. This panel owns the gate now, and
   * applies it to the config.yaml sections ONLY.
   *
   * Taking the un-narrowed union is the load-bearing half: a caller holding
   * only resolved data can no longer satisfy this prop, so the pre-fix
   * "mount the whole panel once the agent answers" shape does not typecheck.
   * That is what stops F-7 coming back as an ordinary-looking refactor.
   */
  config: RemoteData<SettingsData> | undefined;
  /** Re-invoke the settings fetch (the gate's Retry, for the config half). */
  onRetryConfig: () => void;
  /** Persist a config edit (correlated → resolves ok / rejects). */
  onSetConfig: (key: string, value: FieldValue) => Promise<unknown>;
  /**
   * R5 (Task 13): the Guard-ratified next-edit toggles, delivered by the
   * `nextEdit.state` push. This is the rows' PROP — the P7-N6 prop-wins
   * reconcile below is what makes a push authoritative over any local edit.
   */
  nextEdit: NextEditToggleState;
  /**
   * R5: apply one toggle gesture over the host-internal correlated
   * `nextEdit.toggle` request. Resolves with the new state on accept, REJECTS
   * with the refusal message on refuse — which is exactly what makes the
   * switch snap back and show the reason.
   */
  onToggleNextEdit: (source: NextEditToggleSource, on: boolean) => Promise<unknown>;
}

/** The section heading both R5 rows live under (the pinned R5 naming). */
export const NEXT_EDIT_SECTION_LABEL = 'Next Edit Suggestions';

/**
 * The two R5 rows, NEXT first — the dedicated model is the flagship, Generic
 * is the fallback (`08` §8).
 *
 * This copy is OWNER-APPROVED and FROZEN (`08` §8's table, carried
 * character-for-character) and is locked by `SettingsPanel.test.ts`. The
 * honesty clauses are the point of it, not decoration: NEXT has no published
 * benchmark score and says so outright rather than borrowing a number, and
 * Generic's only number carries the "vendor-reported, unreplicated" qualifier
 * plus the "review every suggestion" instruction. Do not tighten, summarise,
 * or "improve" these strings.
 */
export const NEXT_EDIT_ROWS: ReadonlyArray<{
  source: NextEditToggleSource;
  label: string;
  description: string;
}> = [
  {
    source: 'next',
    label: 'Next Edit — dedicated model',
    description:
      'Uses sweep-next-edit-v2-7B on its own endpoint (talaria.nextEdit.endpoint). No published benchmark score exists for this model. Mutually exclusive with Generic.',
  },
  {
    source: 'generic',
    label: 'Next Edit — Generic via your FIM model',
    description:
      'Reuses your FIM model and endpoint with a different request shape. Quality ~55.62% (vendor-reported, unreplicated) — review every suggestion. Below 23 GiB VRAM set OLLAMA_CONTEXT_LENGTH=16384 on your server (see docs). Mutually exclusive with NEXT.',
  },
];

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
            text a user reaches for. Same fix `NextEditRow` below already
            carries: label the TITLE only, via htmlFor/id, so "click the title
            to toggle" survives while the prose and the error become
            selectable. `Toggle`'s own aria-label remains the control's
            accessible name either way. */}
        <label htmlFor={controlId} className="block cursor-pointer font-mono text-xs text-fg">
          {field.key}
        </label>
        {field.description && <div className="text-2xs text-muted">{field.description}</div>}
        {/* A3 (WCAG 2.2 SC 4.1.3): the "Not saved" error rides the shared
            `LiveRegion` (polite) — permanently mounted, only its text swaps
            (Finding 7's mounted-empty discipline, same as `NextEditRow`
            below). Previously a conditionally-mounted plain div: a rejected
            config write was visible but never announced to a screen reader. */}
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

/**
 * One R5 toggle row. Deliberately the SAME visual grammar as {@link FieldRow}
 * above — same row shell classes, same description slot, same inline-error
 * slot, same `Toggle` primitive, same pending affordance — differing only in
 * that it shows a human LABEL where a config row shows its `field.key`
 * (`08` §8: "a person enables a feature, not a Guard").
 *
 * It runs the SAME D3/N13 machine, through the SAME `commitFieldEdit`
 * driver. Unlike {@link FieldRow}, it reconciles through
 * {@link reconcileNextEditRowState} rather than the plain
 * `reconcileFieldEditState` — the two Next Edit sources are mutually
 * exclusive, so a refusal shown on THIS row can be caused by the OTHER
 * row's state (`otherOn`), and must clear the moment that state resolves it
 * even if this row's own `on` prop never moves (fix wave Finding 1). `on`
 * (this source) and `otherOn` (the other source) both come from the
 * `nextEdit.state` push; a refusal rejects the correlated request, which
 * `rollbackField` turns into a visible snap-back plus the reason inline.
 */
function NextEditRow({
  toggleId,
  label,
  description,
  on,
  otherOn,
  onToggle,
}: {
  /** Fix wave Finding 2: stable id linking the title `<label>` to the
   *  `Toggle` button via `htmlFor`, so only the title (not the description
   *  prose) is a click target for the switch. */
  toggleId: string;
  label: string;
  description: string;
  on: boolean;
  /** The OTHER Next Edit source's current on/off state (see class doc). */
  otherOn: boolean;
  onToggle: (on: boolean) => Promise<unknown>;
}) {
  const [state, setState] = useState(() => initNextEditRowState(on, otherOn));
  // Fix wave Finding 1/3: the cross-toggle prop-wins reconcile during
  // RENDER — see `reconcileNextEditRowState`'s doc for why the plain
  // single-value `reconcileFieldEditState` (which FieldRow still uses,
  // unchanged) is insufficient for this row.
  const reconciled = reconcileNextEditRowState(state, on, otherOn);
  if (reconciled !== state) setState(reconciled);
  const { pending, lastError } = reconciled;

  const commit = (next: FieldValue) => {
    void commitFieldEdit(setState, next, (v) => onToggle(v === true));
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        {/* Fix wave Finding 2: the switch's LABELLED region is the row
            TITLE only, via `htmlFor`/`id` — NOT the surrounding prose, which
            runs to ~3 lines and contains copyable technical detail like
            `OLLAMA_CONTEXT_LENGTH=16384`. Wrapping the whole row in a
            `<label>` was the exact defect audit G-3 found in `FieldRow`
            (fixed below to this same pattern): its "Not saved: …" inline
            error is precisely the text a user reaches for, and clicking it
            to read or copy it flipped the switch and re-issued the write
            that had just failed. `Toggle`'s own `aria-label` is the
            control's actual accessible name either way (an explicit
            `aria-label` wins accessible-name computation over an
            associated `<label>`'s text) — `htmlFor` here only restores the
            "click the title to toggle" affordance for the title alone. */}
        <label htmlFor={toggleId} className="block cursor-pointer text-xs text-fg">
          {label}
        </label>
        <div className="text-2xs text-muted">{description}</div>
        {/* Half one of the owner's «alert in the user's face»: the reason,
            in text (never colour alone), announced politely so a screen
            reader hears the refusal the sighted user sees. The Guard's own
            host-side warning is half two — one string, two surfaces.
            Fix wave Finding 7: the region stays MOUNTED unconditionally —
            only its text content changes — because a `role="status"`
            region that mounts together with its own content is the
            known-unreliable screen-reader announcement pattern. A3: migrated
            to the shared `LiveRegion` (§2.1) — identical DOM shape
            (role=status + aria-live=polite), pinned by
            `SettingsPanel.dom.test.tsx`'s existing role="status" lock. */}
        <LiveRegion
          text={lastError ? `Not saved: ${lastError}` : ''}
          className="text-2xs text-del"
          title={lastError}
        />
      </div>

      {/* F-8: `busy`, never `disabled`. This row is where the bug bites
          hardest — a REFUSAL is the likeliest outcome of toggling either of
          two mutually-exclusive sources, and a refusal is precisely the case
          the user must be able to RETRY without re-tabbing the whole panel
          to find the switch they were already on. */}
      <Toggle
        id={toggleId}
        on={reconciled.displayValue === true}
        label={label}
        busy={pending}
        onChange={commit}
      />
      {pending && (
        <span className="flex-none text-2xs text-muted" aria-live="polite">
          Saving…
        </span>
      )}
    </div>
  );
}

export function SettingsPanel({
  config,
  onRetryConfig,
  onSetConfig,
  nextEdit,
  onToggleNextEdit,
}: SettingsPanelProps) {
  return (
    <PanelShell title="Talaria config">
      {/* R5 (Task 13): the next-edit toggles are EXTENSION state, not
          config.yaml data, so they render as their own section rather than
          among the config sections. Placed first: this is the flagship
          surface of the feature, and burying it under the config dump would
          make the one control the whole capability depends on the hardest to
          find.

          F-7: and it renders OUTSIDE the gate below — unconditionally, in
          every RemoteData state. These toggles are extension `globalState`
          served HOST-INTERNALLY (`TalariaViewProvider.ts:591`) and pushed over
          `nextEdit.state`; no agent is involved at any point. Gating them on
          the agent-backed `panel.data` fetch (the pre-fix structure) meant
          that when the Hermes CLI failed to start, Settings showed Error +
          Retry and there was NO WAY LEFT to turn Generic back off — and by
          design these are not `settings.json` settings either, so the only
          remaining remedy was hand-editing `globalState`.

          The rule this encodes: a control's availability must follow the
          state it MUTATES, not whatever else happens to share its screen.
          Locked structurally in `SettingsPanel.test.ts`. */}
      <div>
        <SectionLabel>{NEXT_EDIT_SECTION_LABEL}</SectionLabel>
        <div className="overflow-hidden rounded-card border border-border">
          {NEXT_EDIT_ROWS.map((row) => (
            <NextEditRow
              key={row.source}
              toggleId={`next-edit-toggle-${row.source}`}
              label={row.label}
              description={row.description}
              on={nextEdit[row.source]}
              otherOn={nextEdit[row.source === 'next' ? 'generic' : 'next']}
              onToggle={(on) => onToggleNextEdit(row.source, on)}
            />
          ))}
        </div>
      </div>

      {/* The config.yaml half — and ONLY this half — is what actually needs
          the agent. Same `RemotePanel` every other data panel uses (Part X2):
          deliberately NOT a second, hand-rolled loading/error path, so there
          is still exactly one place in the app that decides what an
          unresolved panel looks like. */}
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
