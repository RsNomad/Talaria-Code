/*
 * useToggle — optimistic write-through + rollback-on-error for a switch list,
 * with SEQUENTIAL persistence (W1.5).
 * ------------------------------------------------------------------
 * The Skills & Tools panels drive REAL toggles through Hermes's dashboard REST
 * surface. Following the desktop reference (`apps/desktop/src/index.tsx:331-340`)
 * each toggle is applied OPTIMISTICALLY (the switch flips immediately) and rolled
 * back only if the persist call rejects, so the UI never lies about a failed
 * write. Persist calls are run one at a time via {@link SequentialQueue} because
 * parallel calls race the `config.yaml` read-modify-write (`index.tsx:362`).
 *
 * The switch's on-state is `override ?? serverValue`: before any local toggle the
 * server's `enabled` shows through; after a toggle the optimistic value wins
 * (and stays — it equals the value we persisted).
 *
 * ## Rollback baseline (Correctness M4)
 * A naive rollback to `!next` ASSUMES the pre-toggle state was `!next`. Under
 * RAPID OPPOSING toggles on the same id that BOTH fail, that assumption breaks
 * and the switch settles disagreeing with the server. Instead this hook rolls a
 * failed toggle back to the last *server-confirmed* value for that id — the
 * `confirmed` map, updated only when a persist RESOLVES (absent ⇒ fall back to
 * the live `serverValue`). Two guards keep it correct under concurrency:
 *   1. a monotonic per-id `latestSeq`: a failed op reverts the display ONLY if it
 *      is still the most-recently-issued toggle for that id — a newer optimistic
 *      value is never clobbered by an older op's late rejection;
 *   2. rollback to `confirmed` (or, when there is none, DELETE the override so the
 *      live `serverValue` shows through again) — never a fabricated `!next`.
 * So two opposing toggles that both reject settle back to the true pre-first
 * value, and a mix of success/failure lands on whatever the server actually holds.
 *
 * ## V-11 TOGGLE-HONESTY: silent rollback + a permanently-masked authoritative push
 * Two dishonesties predated this section, both now closed:
 *  1. A rejected persist rolled the switch back with NO visible trace anywhere —
 *     the row just silently un-flipped. `lastError` (below) records the
 *     rejection's reason (`RemoteError.message`, via {@link errorMessage} — the
 *     SAME status-only-sanitized text `settingsField.ts` already uses, never a
 *     response body), cleared the moment a fresh `issueToggle` fires for that id
 *     (a new attempt hasn't failed yet). `SkillsPanel`/`ToolsPanel` render it
 *     through the repo's permanently-mounted `LiveRegion` ("Not saved: {reason}"),
 *     mirroring `SettingsPanel.tsx`'s `FieldRow`/`NextEditRow` grammar exactly
 *     (WCAG 2.2 SC 4.1.3 — a region that mounts together with its own content is
 *     the known-unreliable screen-reader announcement pattern).
 *  2. A CONFIRMED optimistic value never expired: `overrides[id]` stayed set
 *     forever once a toggle resolved, so a LATER authoritative `panel.data` push
 *     that disagreed (another editor's toggle, a host-side correction) was
 *     silently masked — the row went on showing the stale locally-confirmed
 *     value, never the live server truth. `settledSeq` + {@link reconcileToggle}
 *     close this the same way `SettingsPanel.tsx:118-126`'s
 *     `reconcileFieldEditState` already does for config rows: reconcile DURING
 *     RENDER (react.dev, "You Might Not Need an Effect" § "Adjusting some state
 *     when a prop changes" — not an Effect, which would paint one extra stale
 *     frame), and ONLY once `id`'s most-recently-issued op has actually SETTLED
 *     (`latestSeq[id] === settledSeq[id]`, i.e. nothing is still in flight for
 *     `id`) — an in-flight optimistic value is never clobbered, but the instant
 *     it settles the server becomes authority again, exactly like every other
 *     reconciled row in this app.
 *
 * The React-free transitions below are pure so they unit-test in plain node (this
 * repo has no DOM test harness for THEM — see `useToggle.test.ts`; the panels'
 * own `.dom.test.tsx` files cover the rendered wiring), and `useToggle` just
 * holds one {@link ToggleState}, applying updates via functional `setState`
 * updaters (which React queues/composes in order — reactjs/react.dev
 * `queueing-a-series-of-state-updates`). That composition matters more than
 * ever now: `isOn` (below) itself conditionally calls `setState` during render
 * to reconcile, and it can run for SEVERAL rows in the SAME render pass — only
 * the functional-updater form lets each row's reconcile compose against
 * whatever the previous row's already queued, instead of the last row's call
 * clobbering the others'.
 */
import { useRef, useState } from 'react';
import { SequentialQueue } from '../state/sequentialQueue';
import { errorMessage } from '../state/panels';

/** Persist one toggle. MUST reject on failure so the hook can roll the UI back. */
export type PerformToggle = (id: string, next: boolean) => Promise<unknown>;

export interface ToggleController {
  /** Current on-state for `id`: the optimistic override if set, else the server value. */
  isOn: (id: string, serverValue: boolean) => boolean;
  /** Flip `id` to `next`: optimistic UI now, persisted sequentially, rolled back on error. */
  toggle: (id: string, next: boolean) => void;
  /**
   * V-11: the reason the most recently SETTLED toggle for `id` was rejected, or
   * `undefined` if none happened yet (or a fresh toggle superseded/cleared it).
   * Render through the repo's `LiveRegion` as `Not saved: {reason}` — mirrors
   * `SettingsPanel.tsx`'s `FieldRow`/`NextEditRow`.
   */
  lastError: (id: string) => string | undefined;
}

/** Pure, React-free toggle state — unit-testable without a DOM. */
export interface ToggleState {
  /** Optimistic display value per id; absent ⇒ show the live `serverValue`. */
  overrides: Record<string, boolean>;
  /** Last server-CONFIRMED value per id (set on a resolved persist); absent ⇒ `serverValue`. */
  confirmed: Record<string, boolean>;
  /** Sequence number of the most-recently-ISSUED toggle per id (rollback guard). */
  latestSeq: Record<string, number>;
  /**
   * V-11: sequence number of the most-recently-SETTLED (confirmed or rejected)
   * op per id — but ONLY recorded when that op was, at settle time, still the
   * latest issued for `id` (the exact same staleness guard `rollbackToggle`
   * already used for the override revert). `latestSeq[id] === settledSeq[id]`
   * therefore means "no op is currently in flight for `id`" — the precondition
   * {@link reconcileToggle} needs before it is safe to let a later authoritative
   * `serverValue` show through again.
   */
  settledSeq: Record<string, number>;
  /**
   * V-11: the rejection reason of the most recently SETTLED op for `id`, if it
   * was rejected. Cleared the moment a fresh `issueToggle` fires for `id` (a new
   * attempt hasn't failed yet); left UNTOUCHED by {@link reconcileToggle} — an
   * announced rejection must survive its override being reconciled away, or the
   * user loses the explanation the instant the row goes quiet again.
   */
  lastError: Record<string, string>;
}

export const emptyToggleState: ToggleState = {
  overrides: {},
  confirmed: {},
  latestSeq: {},
  settledSeq: {},
  lastError: {},
};

/** Record an optimistic toggle: show `next` now; `seq` tickets this op for rollback.
 *  A fresh attempt clears any stale `lastError[id]` from a prior rejection — this
 *  attempt hasn't failed yet. */
export function issueToggle(s: ToggleState, id: string, next: boolean, seq: number): ToggleState {
  const lastError = { ...s.lastError };
  delete lastError[id];
  return {
    overrides: { ...s.overrides, [id]: next },
    confirmed: s.confirmed,
    latestSeq: { ...s.latestSeq, [id]: seq },
    settledSeq: s.settledSeq,
    lastError,
  };
}

/**
 * Persist RESOLVED: `next` is now the server-confirmed value for `id` —
 * `confirmed[id]` is updated UNCONDITIONALLY (even for a since-superseded op:
 * it is still real information about what the server actually holds, and is
 * exactly the rollback baseline a LATER op's rejection needs). `settledSeq[id]`
 * is the new, guarded field: only advanced when this op is still the latest
 * issued for `id`, so {@link reconcileToggle} can tell "fully settled" from
 * "an older op of a still-in-flight pair just confirmed".
 */
export function confirmToggle(s: ToggleState, id: string, next: boolean, seq: number): ToggleState {
  const settledSeq = s.latestSeq[id] === seq ? { ...s.settledSeq, [id]: seq } : s.settledSeq;
  return { ...s, confirmed: { ...s.confirmed, [id]: next }, settledSeq };
}

/**
 * Persist REJECTED: revert the display to the last confirmed value — but ONLY if
 * this op (`seq`) is still the latest issued for `id`; a newer toggle supersedes
 * us and its optimistic value must stand. With no confirmed value, DELETE the
 * override so the live `serverValue` shows through (never a fabricated `!next`).
 *
 * V-11: the same non-superseded branch also advances `settledSeq[id]` (see
 * {@link confirmToggle}'s doc) and records `reason` as `lastError[id]` — a
 * superseded rejection records NEITHER: a newer op is in flight or has already
 * settled for `id`, and its own outcome is what the user must see, not a stale
 * op's late-arriving refusal.
 */
export function rollbackToggle(s: ToggleState, id: string, seq: number, reason?: string): ToggleState {
  if (s.latestSeq[id] !== seq) return s; // superseded by a newer toggle — leave it entirely
  const overrides = { ...s.overrides };
  const confirmedValue = s.confirmed[id];
  // `ToggleState.confirmed` is `Record<string, boolean>` — a key present in
  // this object can never legitimately hold `undefined`, so this check is
  // equivalent to the prior `id in s.confirmed` (real narrowing, not a lie).
  if (confirmedValue !== undefined) overrides[id] = confirmedValue;
  else delete overrides[id];
  const lastError = { ...s.lastError };
  if (reason !== undefined) lastError[id] = reason;
  else delete lastError[id];
  return { ...s, overrides, settledSeq: { ...s.settledSeq, [id]: seq }, lastError };
}

/**
 * V-11: the reconcile half. While `id` has an op in flight (`latestSeq[id] !==
 * settledSeq[id]`) this is a strict no-op — the normal optimistic UI holds and
 * is never clobbered. Once `id` is fully settled, DELETE `overrides[id]` (and
 * `confirmed[id]`, its now-stale rollback baseline) so the live `serverValue`
 * argument to `isOn` shows through again — the server becomes authority the
 * instant there is nothing left in flight to protect. `lastError[id]` is
 * deliberately NOT touched here (see {@link ToggleState.lastError}'s doc).
 *
 * Returns `s` unchanged (same reference) whenever there is nothing to do, so a
 * caller doing the `if (next !== state) setState(next)` render-time-adjustment
 * idiom (`SettingsPanel.tsx:125-126`) never schedules a needless re-render.
 */
export function reconcileToggle(s: ToggleState, id: string): ToggleState {
  if (!(id in s.overrides)) return s; // nothing optimistic showing for `id` — nothing to reconcile
  if (s.latestSeq[id] !== s.settledSeq[id]) return s; // an op for `id` is still in flight — never clobber it
  const overrides = { ...s.overrides };
  delete overrides[id];
  const confirmed = { ...s.confirmed };
  delete confirmed[id];
  return { ...s, overrides, confirmed };
}

export function useToggle(perform: PerformToggle): ToggleController {
  const [state, setState] = useState<ToggleState>(emptyToggleState);
  const queueRef = useRef<SequentialQueue | null>(null);
  if (queueRef.current === null) queueRef.current = new SequentialQueue();
  const seqRef = useRef(0);

  // V-11: reconcile DURING RENDER, the react.dev "adjusting state when a prop
  // changes" pattern SettingsPanel.tsx:118-126 already carries — not an
  // Effect, which would commit one extra stale frame first. `isOn` is exactly
  // what the panels call, per row, during their own render (`isOn(sk.id,
  // sk.enabled)` / `isOn(ts.name, ts.enabled)`), so reconciling here IS
  // "called from the panels during render for each row". The `setState` call
  // uses the FUNCTIONAL updater (re-deriving from the freshest `s`, not the
  // precomputed `reconciled` closed over `state`) so several rows reconciling
  // within the same render pass compose instead of clobbering each other —
  // see this file's header doc.
  const isOn = (id: string, serverValue: boolean): boolean => {
    const reconciled = reconcileToggle(state, id);
    if (reconciled !== state) setState((s) => reconcileToggle(s, id));
    return reconciled.overrides[id] ?? serverValue;
  };

  // V-11: reads `state` directly, not `reconciled` — `reconcileToggle` never
  // touches `lastError`, so there is no ordering dependency on whether `isOn`
  // happened to run first for this id within the same render.
  const lastError = (id: string): string | undefined => state.lastError[id];

  const toggle = (id: string, next: boolean): void => {
    const seq = ++seqRef.current;
    // Optimistic: reflect the intended state immediately (and ticket this op).
    setState((s) => issueToggle(s, id, next, seq));
    // Persist sequentially; on success confirm, on failure roll back to the last
    // confirmed value (guarded so a stale rejection can't clobber a newer toggle)
    // and record why, for the row's "Not saved: …" announcement.
    void queueRef.current!.run(() => perform(id, next)).then(
      () => setState((s) => confirmToggle(s, id, next, seq)),
      (err: unknown) => setState((s) => rollbackToggle(s, id, seq, errorMessage(err))),
    );
  };

  return { isOn, toggle, lastError };
}
