/*
 * RED-first: UI-I2b. SettingsPanel's field row used to seed local display
 * state from `field.value` ONCE (`useState(field.value)`) and never look at
 * the prop again — the row's `key={field.key}` is stable so it never
 * remounts, so a later PUSH of `panel.data:settings` (another editor's edit,
 * or any future host correction) never reconciled into the row, and a
 * `config.set` write had no rollback: a rejected/no-op write left the row
 * showing whatever the user last picked, forever, whether or not the host
 * actually persisted it.
 *
 * D3/N13: `config.set` is now a correlated `bridge.request`, so the machine
 * gains real confirm/rollback transitions (`confirmField`/`rollbackField`)
 * instead of relying solely on a lucky later prop push. The former
 * KNOWN-LIMIT test below (a same-value re-push being indistinguishable from
 * no push) is superseded by a POSITIVE rollback test: a rejected write now
 * visibly reverts via `rollbackField`, driven by the request's own
 * resolve/reject — not by waiting on `reconcileFieldEditState` to get lucky.
 */
import { describe, it, expect } from 'vitest';
import {
  commitFieldEdit,
  confirmField,
  editFieldLocally,
  initFieldEditState,
  initNextEditRowState,
  reconcileFieldEditState,
  reconcileNextEditRowState,
  rollbackField,
  type FieldEditState,
  type FieldValue,
} from './settingsField';

describe('settings field reconcile (UI-I2b)', () => {
  it('displays the prop value until the user edits it', () => {
    const s = initFieldEditState('default');
    expect(s.displayValue).toBe('default');
  });

  it('a local edit is reflected immediately (optimistic)', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    expect(s.displayValue).toBe('accept_edits');
  });

  it('reconcile is a no-op while the prop has not moved — an in-flight edit survives an unrelated re-render', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = reconcileFieldEditState(s, 'default'); // same prop value as at init
    expect(s.displayValue).toBe('accept_edits'); // local edit still stands
  });

  it('a fresh, DIFFERENT prop value (a host push) reconciles the display, overriding a stale local edit — the forever-shadow fix', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits'); // user picks a new value; config.set posted
    // A host push arrives carrying a value that differs from BOTH the
    // original and the local edit (another editor's change, or any future
    // confirmed-value push). The `useState(field.value)` bug this replaces
    // would NEVER see this — `key={field.key}` never remounts — so the row
    // would keep showing the user's stale pick forever, disagreeing with
    // the host.
    s = reconcileFieldEditState(s, 'dont_ask');
    expect(s.displayValue).toBe('dont_ask');
  });

  it('a confirmed matching push also reconciles cleanly (behavior-preserving for the already-correct path)', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = reconcileFieldEditState(s, 'accept_edits'); // host confirms the exact value the user picked
    expect(s.displayValue).toBe('accept_edits');
  });

  it('FORMER KNOWN LIMIT, NOW FIXED: a rejected boolean write visibly rolls back via rollbackField, even though its value round-trips to the ORIGINAL value (a case reconcile alone could never distinguish from "nothing happened") — the correlated config.set request drives the rollback directly, not a lucky later prop push', () => {
    let s = initFieldEditState(false);
    s = editFieldLocally(s, true); // user flips the toggle on; config.set posted, pending
    expect(s.pending).toBe(true);
    s = rollbackField(s, 'denied'); // the correlated request rejected (or resolved ok:false)
    expect(s.displayValue).toBe(false); // reverted to the last known-persisted value
    expect(s.pending).toBe(false);
    expect(s.lastError).toBe('denied');
  });
});

describe('settings field pending/confirm/rollback (D3/N13: config.set is now correlated)', () => {
  it('initFieldEditState starts not pending', () => {
    const s = initFieldEditState('default');
    expect(s.pending).toBe(false);
  });

  it('editFieldLocally marks the field pending (in-flight) alongside the optimistic display', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    expect(s.displayValue).toBe('accept_edits');
    expect(s.pending).toBe(true);
  });

  it('confirmField clears pending and pins lastPropValue to the confirmed displayValue', () => {
    let s = initFieldEditState(false);
    s = editFieldLocally(s, true);
    s = confirmField(s);
    expect(s.pending).toBe(false);
    expect(s.lastPropValue).toBe(true);
    expect(s.displayValue).toBe(true);
  });

  it('confirmField pins the baseline so a later same-value prop push is a no-op (no flicker)', () => {
    let s = initFieldEditState(false);
    s = editFieldLocally(s, true);
    s = confirmField(s);
    const reconciled = reconcileFieldEditState(s, true); // host later pushes the same confirmed value
    expect(reconciled).toBe(s); // reconcile treats it as already-current — no-op by identity
  });

  it('rollbackField reverts displayValue to lastPropValue and clears pending', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = rollbackField(s);
    expect(s.displayValue).toBe('default');
    expect(s.pending).toBe(false);
  });

  it('rollbackField records the optional error reason', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = rollbackField(s, 'config.set failed: invalid value');
    expect(s.lastError).toBe('config.set failed: invalid value');
  });

  it('rollbackField with no error argument leaves lastError undefined', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = rollbackField(s);
    expect(s.lastError).toBeUndefined();
  });

  it('a fresh edit after a failed set clears the stale lastError (this attempt has not failed yet)', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = rollbackField(s, 'denied'); // prior attempt failed
    expect(s.lastError).toBe('denied');
    s = editFieldLocally(s, 'dont_ask'); // user tries again
    expect(s.lastError).toBeUndefined();
    expect(s.pending).toBe(true);
  });

  it('confirmField clears a stale lastError from a prior failed set (the successful save removes the error affordance)', () => {
    let s = initFieldEditState('default');
    s = editFieldLocally(s, 'accept_edits');
    s = rollbackField(s, 'denied');
    s = editFieldLocally(s, 'dont_ask');
    s = confirmField(s); // this one succeeds
    expect(s.lastError).toBeUndefined();
    expect(s.displayValue).toBe('dont_ask');
    expect(s.lastPropValue).toBe('dont_ask');
  });
});

/*
 * W5.1 Task 13 (R5): `commitFieldEdit` is the ONE D3/N13 driver every
 * SettingsPanel row runs — the config `FieldRow` and the two Next Edit rows
 * alike. Extracted (behaviour-identical) from `FieldRow`'s former inline
 * `commit` so that "a refusal snaps the row back and shows the reason" is
 * provable headlessly, against the real code the row executes, rather than
 * against a re-typed copy of it.
 *
 * Test hygiene: every `request` below is a PLAIN function returning a REAL
 * promise, never a `vi.fn()` — a `vi.fn()` mock swallows unhandled rejections,
 * which would make the refusal assertions vacuous.
 */
describe('commitFieldEdit — the single D3/N13 confirm/rollback driver (Task 13)', () => {
  function harness(initial: FieldValue) {
    let state = initFieldEditState(initial);
    return {
      get: () => state,
      setState: (updater: (s: FieldEditState) => FieldEditState) => {
        state = updater(state);
      },
    };
  }

  it('shows the optimistic value and marks the row pending WHILE the correlated request is in flight', () => {
    const h = harness(false);
    let release: (v: unknown) => void = () => {};
    void commitFieldEdit(h.setState, true, () => new Promise((res) => { release = res; }));

    expect(h.get().displayValue).toBe(true);
    expect(h.get().pending).toBe(true);
    release(undefined);
  });

  it('an ACCEPTED toggle confirms: the optimistic value becomes the reconciled baseline and pending clears', async () => {
    const h = harness(false);
    await commitFieldEdit(h.setState, true, () => Promise.resolve({ next: true, generic: false }));

    expect(h.get().displayValue).toBe(true);
    expect(h.get().lastPropValue).toBe(true);
    expect(h.get().pending).toBe(false);
    expect(h.get().lastError).toBeUndefined();
  });

  it('a REFUSAL snaps the row back to the last persisted value and records the reason verbatim', async () => {
    const refusal = 'Next Edit: turn off NEXT first — the two sources are mutually exclusive.';
    const h = harness(false);
    await commitFieldEdit(h.setState, true, () => Promise.reject(new Error(refusal)));

    expect(h.get().displayValue).toBe(false); // visibly snapped back
    expect(h.get().pending).toBe(false);
    expect(h.get().lastError).toBe(refusal); // and the user is told WHY
  });

  it('a non-Error STRING rejection still rolls back with a readable reason (never a silent revert)', async () => {
    const h = harness(false);
    await commitFieldEdit(h.setState, true, () => Promise.reject('bridge disposed'));

    expect(h.get().displayValue).toBe(false);
    expect(h.get().lastError).toBe('bridge disposed');
  });

  it('a non-Error, non-string rejection (e.g. a plain object) still rolls back and NEVER surfaces "[object Object]" — Finding 5/6: converged with state/panels.ts\'s errorMessage, whose typed fallback replaces the old raw String(err)', async () => {
    const h = harness(false);
    await commitFieldEdit(h.setState, true, () => Promise.reject({ code: 'DENIED' }));

    expect(h.get().displayValue).toBe(false);
    expect(h.get().lastError).not.toContain('[object Object]');
    expect(h.get().lastError).toBe('Request failed.');
  });

  it('never rejects to its caller — the row handles BOTH outcomes itself, so a refusal cannot become an unhandled rejection', async () => {
    const h = harness(false);
    await expect(
      commitFieldEdit(h.setState, true, () => Promise.reject(new Error('refused'))),
    ).resolves.toBeUndefined();
  });

  it('a host push still wins over a rolled-back row (the P7-N6 prop-wins outer layer is unchanged by this extraction)', async () => {
    const h = harness(false);
    await commitFieldEdit(h.setState, true, () => Promise.reject(new Error('refused')));
    // The Guard later ratifies `next: true` from elsewhere and pushes it.
    const reconciled = reconcileFieldEditState(h.get(), true);

    expect(reconciled.displayValue).toBe(true);
    expect(reconciled.lastError).toBeUndefined();
  });
});

/*
 * Fix wave Finding 1 (UX bug) + Finding 3 (test integrity): `NextEditRow`'s
 * reconcile used to just call `reconcileFieldEditState(state, on)` — the
 * SAME single-value decision `FieldRow` uses. That is wrong for this row:
 * the two Next Edit sources are mutually exclusive, so a REFUSAL on one row
 * ("turn off NEXT first") is caused by the OTHER row's state, not this row's
 * own `on` prop. When the user then resolves the refusal by flipping the
 * OTHER toggle off, THIS row's own `on` prop never moves (it was refused, so
 * it never changed), so `reconcileFieldEditState` no-ops and the now-false
 * refusal text is stuck until the next unrelated flip on this row.
 *
 * `reconcileNextEditRowState` closes this by reconciling against BOTH
 * sources' state, not just this row's own. It is built ON TOP of (calls)
 * `reconcileFieldEditState` for the single-value half of the decision, so
 * `FieldRow`'s well-tested, UNCHANGED function is the one shared "reconcile
 * decision" both row types run — this file adds only the second dimension
 * `NextEditRow` alone needs. `reconcileFieldEditState` itself is not modified
 * by one character in this fix wave (behaviour-identical for `FieldRow`,
 * provable by inspection: the diff touches no line of that function).
 */
describe('reconcileNextEditRowState — the cross-toggle prop-wins DECISION (fix wave Finding 1/3)', () => {
  it('initNextEditRowState seeds displayValue/lastPropValue from `on` and remembers the OTHER source alongside it', () => {
    const s = initNextEditRowState(true, false);
    expect(s.displayValue).toBe(true);
    expect(s.lastPropValue).toBe(true);
    expect(s.lastOtherOn).toBe(false);
    expect(s.pending).toBe(false);
  });

  it('is a no-op (by REFERENCE) when NEITHER this row\'s `on` nor the other source has moved — an in-flight local edit survives an unrelated re-render, exactly like reconcileFieldEditState', () => {
    let s = initNextEditRowState(false, false);
    s = editFieldLocally(s, true); // user flips this row; request in flight
    const reconciled = reconcileNextEditRowState(s, false, false); // same props re-render
    expect(reconciled).toBe(s);
    expect(reconciled.displayValue).toBe(true); // local edit still stands
  });

  it("reconciles when THIS row's own `on` prop genuinely moves (the ordinary FieldRow-equivalent case), the other source unchanged — a stale rolled-back error clears once a fresh push confirms a new value for THIS row", () => {
    let s = initNextEditRowState(false, false);
    s = editFieldLocally(s, true);
    s = rollbackField(s, 'some earlier refusal');
    // A later, unrelated push ratifies THIS row's source as genuinely on
    // (e.g. accepted on a retry); the other source stays false throughout.
    const reconciled = reconcileNextEditRowState(s, /* on moves false->true */ true, /* otherOn unchanged */ false);

    expect(reconciled.displayValue).toBe(true);
    expect(reconciled.lastPropValue).toBe(true);
    expect(reconciled.lastError).toBeUndefined();
    expect(reconciled.lastOtherOn).toBe(false);
  });

  it("THE FINDING-1 FIX: a stale refusal clears the moment the OTHER toggle's state resolves it, even though THIS row's OWN `on` prop never moved", () => {
    // Generic row: refused (NEXT was on), so Generic's own `on` never left `false`.
    let generic = initNextEditRowState(false, /* otherOn = NEXT */ true);
    generic = editFieldLocally(generic, true); // user attempts to flip Generic on
    generic = rollbackField(generic, 'Next Edit: turn off NEXT first — the two sources are mutually exclusive.');
    expect(generic.displayValue).toBe(false);
    expect(generic.lastError).toContain('turn off NEXT first');

    // The user then turns NEXT off. Generic's OWN `on` prop is still `false`
    // (unchanged) — the bug this fixes is that reconcileFieldEditState(state,
    // false) would no-op here and leave the stale refusal showing forever.
    const reconciled = reconcileNextEditRowState(generic, /* on (unchanged) */ false, /* otherOn: NEXT now off */ false);

    expect(reconciled.displayValue).toBe(false); // still visually off — correct
    expect(reconciled.lastError).toBeUndefined(); // the stale refusal is GONE
  });

  it('reconciles (reinit, error cleared) when BOTH this row\'s `on` and the other source move in the same push', () => {
    let s = initNextEditRowState(false, true);
    s = editFieldLocally(s, true);
    s = rollbackField(s, 'refused');
    const reconciled = reconcileNextEditRowState(s, true, false); // own on moved AND other moved
    expect(reconciled.displayValue).toBe(true);
    expect(reconciled.lastError).toBeUndefined();
    expect(reconciled.lastOtherOn).toBe(false);
  });

  it('a confirmed matching push (both values re-pushed unchanged) stays a no-op by reference — no flicker', () => {
    let s = initNextEditRowState(false, false);
    s = editFieldLocally(s, true);
    s = confirmField(s);
    const reconciled = reconcileNextEditRowState(s, true, false);
    expect(reconciled).toBe(s);
  });

  it('delegates the single-value half to reconcileFieldEditState unchanged: mutation guard — reconcileNextEditRowState must call through, not reimplement the same-value check divergently', () => {
    // Proven indirectly: reconcileFieldEditState(state, propValue) returning
    // the SAME reference on a matching propValue is reconcileNextEditRowState's
    // own no-op precondition too (see the "no-op by REFERENCE" test above).
    // This test locks the DELEGATION by checking the reinit path produces
    // EXACTLY what initFieldEditState(on) would (same shape/keys for the
    // shared fields), so a future edit cannot quietly diverge the two paths.
    const s = initNextEditRowState(true, true);
    const edited = editFieldLocally(s, false);
    const reconciled = reconcileNextEditRowState(edited, /* on moves true->false */ false, /* otherOn unchanged */ true);
    const expected = initFieldEditState(false);
    expect(reconciled.displayValue).toBe(expected.displayValue);
    expect(reconciled.lastPropValue).toBe(expected.lastPropValue);
    expect(reconciled.pending).toBe(expected.pending);
    expect(reconciled.lastError).toBe(expected.lastError);
  });
});

describe('reconcileFieldEditState — B-6: the prop wins the moment it moves', () => {
  it('returns a NEW state when the incoming prop value differs from the last reconciled one', () => {
    const initial = initFieldEditState(false);
    const next = reconcileFieldEditState(initial, true);
    expect(next).not.toBe(initial);
    expect(next.displayValue).toBe(true);
  });

  it('is referentially identical (a real no-op) when the prop has not moved — an in-flight local edit survives an unrelated re-render', () => {
    const initial = initFieldEditState(false);
    expect(reconcileFieldEditState(initial, false)).toBe(initial);
  });

  it('a host push overrides a pending local edit (the row can never permanently shadow a rejected value)', () => {
    // BRIEF CORRECTION (task-13-report.md has the full audit trail): the
    // literal brief used `initFieldEditState(false)` here, which sets
    // `lastPropValue: false` — identical to the `propValue: false` pushed
    // below, so `reconcileFieldEditState` correctly treats it as a NO-OP (the
    // documented, independently-tested "prop hasn't moved" invariant this
    // same file locks a few lines up) and the test failed against CORRECT,
    // unmodified production code. Starting from `true` makes the push an
    // actual prop move (true -> false), which is what "overrides a pending
    // local edit" requires; the assertion below is unchanged from the brief.
    const edited = editFieldLocally(initFieldEditState(true), true);
    const reconciled = reconcileFieldEditState(edited, false);
    expect(reconciled.displayValue).toBe(false);
  });
});
