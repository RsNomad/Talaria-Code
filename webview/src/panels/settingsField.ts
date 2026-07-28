/*
 * P7-N6 (UI-I2b): SettingsPanel's field row used to seed local display state
 * from `field.value` ONCE (`useState(field.value)`) — the row's
 * `key={field.key}` is stable so it never remounts, so a later PUSH of
 * `panel.data:settings` (another editor's edit, or any host correction)
 * never reconciled into the row. The row kept showing whatever the user
 * last picked, forever, whether or not the host actually persisted it: a
 * lie about saved config.
 *
 * `reconcileFieldEditState` closes the reconciliation half of that gap using
 * React's own documented "adjust state while rendering" pattern (react.dev,
 * "You Might Not Need an Effect" § Adjusting some state when a prop
 * changes) instead of an Effect (which would render one extra frame of the
 * stale value): the component compares the freshly-rendered `field.value`
 * PROP against the value this state was last reconciled against, and the
 * moment the prop has actually moved, that fresh value wins over any
 * in-flight local edit — so a host push always corrects the row. This stays
 * the OUTER prop-wins safety layer, unconditionally, even after D3 below.
 *
 * D3/N13: `config.set` is now a correlated `bridge.request` (like
 * `toolsets.toggle`/`skills.toggle`/`reload.mcp`) instead of fire-and-forget
 * `control.invoke`, so the machine gets a real inner confirm/rollback layer
 * driven by the request's own resolve/reject: `editFieldLocally` marks the
 * field `pending` (in-flight); `confirmField` clears `pending` and pins
 * `lastPropValue` to the confirmed `displayValue` (so a later same-value
 * host push is a no-op — no flicker); `rollbackField` reverts `displayValue`
 * to `lastPropValue` and clears `pending`, optionally recording `lastError`.
 * This finally gives a TRUE rollback-on-rejection (the former KNOWN-LIMIT
 * gap — see `settingsField.test.ts`'s flipped test) without touching
 * `reconcileFieldEditState`, which still wins over ALL of this on any actual
 * host push (prop-wins outer layer, unchanged).
 */
import { errorMessage } from '../state/panels';

export type FieldValue = string | number | boolean;

/** One field row's local display state. */
export interface FieldEditState {
  /** The prop value this state was last reconciled against. */
  lastPropValue: FieldValue;
  /** What the row currently displays: an in-flight local edit if any, else `lastPropValue`. */
  displayValue: FieldValue;
  /** True while a `config.set` request issued from this edit is in flight. */
  pending: boolean;
  /** The last rollback's error reason, if any (surfaced as a subtle row affordance). */
  lastError?: string;
  /**
   * `NextEditRow` ONLY (fix wave Finding 1): the OTHER Next Edit source's
   * on/off state this row's reconcile was last checked against. Stays
   * `undefined` forever for `FieldRow`'s config rows — nothing there sets or
   * reads it, so its presence changes no config-row behaviour.
   */
  lastOtherOn?: boolean;
}

export function initFieldEditState(propValue: FieldValue): FieldEditState {
  return { lastPropValue: propValue, displayValue: propValue, pending: false };
}

/** The user edits the field: the display jumps to `next` immediately
 * (optimistic) and the field is marked in-flight — the caller fires the
 * correlated `config.set` request alongside this and resolves it via
 * {@link confirmField}/{@link rollbackField}. A fresh edit clears any stale
 * `lastError` from a prior failed set (this attempt hasn't failed yet). */
export function editFieldLocally(state: FieldEditState, next: FieldValue): FieldEditState {
  return { ...state, displayValue: next, pending: true, lastError: undefined };
}

/**
 * The in-flight `config.set` request resolved ok: the host persisted what we
 * displayed — pin it as the reconciled baseline (`lastPropValue`) so a later
 * push of the SAME value is a no-op under {@link reconcileFieldEditState},
 * and clear `pending`.
 */
export function confirmField(state: FieldEditState): FieldEditState {
  return { ...state, pending: false, lastPropValue: state.displayValue, lastError: undefined };
}

/**
 * The in-flight `config.set` request rejected (or resolved not-ok): revert
 * the display to the last known-persisted value and clear `pending`. `error`,
 * when given, is recorded as `lastError` for a subtle row-level affordance.
 */
export function rollbackField(state: FieldEditState, error?: string): FieldEditState {
  return { ...state, displayValue: state.lastPropValue, pending: false, lastError: error };
}

/**
 * Reconcile against a freshly-rendered `propValue`. A no-op while the prop
 * hasn't moved since the last reconcile (so an in-flight local edit is never
 * clobbered by the SAME data re-rendering) — but the moment the prop
 * actually changes, that fresh value wins over any local edit, confirmed or
 * rejected: the panel can never permanently show an unpersisted value as
 * persisted. This is the OUTER layer: it still wins over any pending/
 * confirmed/rolled-back state above on a genuine host push.
 */
export function reconcileFieldEditState(state: FieldEditState, propValue: FieldValue): FieldEditState {
  if (propValue === state.lastPropValue) return state;
  return initFieldEditState(propValue);
}

/**
 * Fix wave Finding 1 (UX bug) + Finding 3 (test integrity): `NextEditRow`'s
 * two sources are mutually exclusive, so a refusal shown on ROW A can be
 * caused by row B's state — and resolved by row B changing, even while row
 * A's OWN `on` prop never moves. `reconcileFieldEditState` alone can't see
 * that: it only ever compares THIS row's single value, so a stale refusal
 * text could survive the very action that invalidated it (the reviewer's
 * proven repro: flip Generic on while NEXT is on -> refused; turn NEXT off
 * -> Generic's `on` prop is STILL `false`, so the old reconcile no-ops and
 * the now-false "turn off NEXT first" text is stuck).
 *
 * Seeds/reconciles the row's state from BOTH this row's `on` and the OTHER
 * source's `otherOn` — a fresh push wins (reinitializing, which clears any
 * `lastError`) the moment EITHER value has moved since the last reconcile,
 * not just this row's own.
 */
export function initNextEditRowState(on: boolean, otherOn: boolean): FieldEditState {
  return { ...initFieldEditState(on), lastOtherOn: otherOn };
}

/**
 * The cross-toggle reconcile DECISION `NextEditRow` runs instead of the
 * plain `reconcileFieldEditState`. Deliberately built ON TOP of (calls
 * through to) `reconcileFieldEditState` for the single-value half of the
 * decision — so the two row types run the SAME underlying "has the value
 * this state was last reconciled against actually moved" check, and this
 * function adds only the second dimension `NextEditRow` alone needs.
 * `reconcileFieldEditState` itself is untouched by this — `FieldRow`'s
 * behaviour is unaffected byte-for-byte.
 */
export function reconcileNextEditRowState(
  state: FieldEditState,
  on: boolean,
  otherOn: boolean,
): FieldEditState {
  const reconciledOwn = reconcileFieldEditState(state, on);
  if (reconciledOwn !== state) {
    // This row's own prop moved: reconcileFieldEditState already produced a
    // fresh initFieldEditState(on) (lastError cleared); carry the fresh
    // otherOn baseline alongside it.
    return { ...reconciledOwn, lastOtherOn: otherOn };
  }
  // This row's own `on` hasn't moved. THE FINDING-1 FIX: still check whether
  // the OTHER source has — if so, a stale refusal caused by that source must
  // clear now, even though nothing about THIS row's own value changed.
  if (otherOn === state.lastOtherOn) return state; // truly nothing changed
  return initNextEditRowState(on, otherOn);
}

/*
 * Fix wave Finding 5: this used to be a SECOND, divergent `errorMessage` —
 * `err instanceof Error ? err.message : String(err)` — which, unlike
 * `state/panels.ts`'s version, could surface a raw `String(err)` such as
 * `"[object Object]"` for a non-Error, non-string rejection (see Finding 6's
 * broadened test). Converged onto `state/panels.ts`'s `errorMessage` (the
 * BETTER user-facing text: `Error` -> `.message`, a string as-is, anything
 * else -> a clean `'Request failed.'` fallback, never a `String(err)` dump) —
 * re-exported here so existing call sites/imports of `errorMessage` from this
 * module keep working unchanged. `panels/SessionsPanel.tsx` already imports
 * FROM `state/panels.ts` (`loadMoreFooterState`), so a `panels/` file
 * depending on `state/panels.ts` is an established, no-cycle pattern here. */
export { errorMessage };

/**
 * THE D3/N13 driver: the one place the machine above is sequenced against a
 * correlated request. Extracted (behaviour-identical) from `SettingsPanel`'s
 * former inline `FieldRow.commit` in W5.1 Task 13, so that the config rows and
 * the «Next Edit Suggestions» rows run the SAME code rather than two
 * hand-copied lookalikes — and so the confirm/rollback transitions are
 * provable headlessly, against the code the row actually executes.
 *
 * `editFieldLocally` shows the optimistic value and marks the row pending;
 * the request's own resolve/reject then maps 1:1 onto
 * `confirmField`/`rollbackField` (grounded in `rpc.ts`'s `handleResponse`: a
 * `control.response{ok:false}` REJECTS the pending promise). A rejection is
 * therefore a normal, fully-handled outcome — the returned promise ALWAYS
 * fulfils, so a refusal can never surface as an unhandled rejection.
 *
 * `reconcileFieldEditState` remains the OUTER prop-wins layer and is
 * untouched by this: any genuine host push still corrects the row over
 * whatever this produced.
 */
export function commitFieldEdit(
  setState: (updater: (s: FieldEditState) => FieldEditState) => void,
  next: FieldValue,
  request: (next: FieldValue) => Promise<unknown>,
): Promise<void> {
  setState((s) => editFieldLocally(s, next));
  return request(next).then(
    () => setState((s) => confirmField(s)),
    (err: unknown) => setState((s) => rollbackField(s, errorMessage(err))),
  );
}
