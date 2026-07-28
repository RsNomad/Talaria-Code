/**
 * nextedit/guard.ts — Job B Task 12 · THE Guard (R5).
 *
 * The NEXT/Generic toggles are NOT VS Code settings (owner: «юзер пишет
 * Endpoint, а не состояние True/False»). `settings.json` carries DATA only
 * (endpoint, model, transport — `config.ts`); the on/off STATE lives in the
 * extension's own store, `ExtensionContext.globalState`, under the one key
 * declared below. This module is the single WRITER and the single READER of
 * that key — nothing else in `src/` may name it (locked exhaustively in Task
 * 14; a lighter version of the same sweep ships in `guard.test.ts`).
 *
 * `setKeysForSync` is deliberately NOT called: these toggles are
 * hardware-bound (they select which local model serves next-edit) and must
 * not roam between machines via Settings Sync.
 *
 * All decision logic is the pure half in `mode.ts`
 * (`sanitizeStoredToggles`/`applyToggleRequest`/`resolveNextEditMode`) — this
 * class contributes exactly three things a pure function cannot: persistence,
 * SERIALIZATION (the promise queue below), and user-visible alerts.
 *
 * No re-entrancy exists by construction: `Memento` fires no change events
 * (`index.d.ts:8587-8624` has no listener surface), so a `state.update` here
 * can never loop back into this class.
 *
 * Field-by-field object construction only, no object-spread-with-override —
 * this file is in scope for `context/ringBuffer.test.ts`'s repo-wide purity
 * guards.
 */
import * as vscode from 'vscode';
import {
  applyToggleRequest,
  resolveNextEditMode,
  sanitizeStoredToggles,
  type NextEditMode,
  type ToggleDecision,
  type ToggleRequest,
  type ToggleState,
} from './mode';

/** The ONE store key. Exported for the Guard's own tests and Task 14's lock;
 *  no other module may name it. */
export const NEXT_EDIT_TOGGLES_KEY = 'hermes.nextEdit.toggles';

/**
 * First run returns `undefined` from `Memento.get` (`index.d.ts:8602-8612`)
 * ⇒ this hardcoded default. Never persisted on first run: an untouched store
 * and a store explicitly holding both-off mean the same thing, and writing on
 * activation would be a pointless disk touch on every fresh profile.
 *
 * FROZEN (fix wave, Finding 1). `coerceStoredToggles` hands this exact object
 * back BY REFERENCE on every empty-or-malformed-store read below, and
 * `sanitizeStoredToggles` (`mode.ts`) passes a non-conflicting input straight
 * through by reference too — it does NOT always allocate a fresh literal, so
 * this singleton genuinely can reach a caller of `readCurrent()`. `getState()`'s
 * explicit copy is the primary defense against a caller mutating what it gets
 * back; freezing here is the secondary one, so a later edit that drops that
 * copy in good faith cannot corrupt the process-wide default for every Guard
 * that hydrates from an empty store afterward.
 */
const DEFAULT_TOGGLES: ToggleState = Object.freeze({ next: false, generic: false });

/**
 * The two Settings-panel row labels, verbatim (`08` §8's row table;
 * `webview/src/panels/SettingsPanel.tsx`). The refusal copy interpolates
 * these and nothing else — see {@link REFUSAL_MESSAGES}.
 */
const NEXT_ROW_LABEL = 'Next Edit — dedicated model';
const GENERIC_ROW_LABEL = 'Next Edit — Generic via your FIM model';

/**
 * Refusal copy, pinned by the brief:
 * `"Next Edit: turn off <the other toggle> first — the two sources are
 * mutually exclusive."` — `refused-next` means the NEXT toggle-on was
 * refused, so the toggle to turn off is the OTHER one (Generic), and
 * vice-versa.
 *
 * U-6: `<the other toggle>` is the OTHER ROW'S LABEL, exactly as `08` §8
 * specifies ("with `<the other toggle>` filled with the other row's label").
 * It used to read "turn off NEXT first" / "turn off Generic first", and
 * neither "NEXT" nor "Generic" appears anywhere on screen — the rows are
 * titled "Next Edit — dedicated model" and "Next Edit — Generic via your FIM
 * model", so the user had to guess which row was being named. This string is
 * shown in two places at once (the host toast and, verbatim, the refused
 * row's inline error), which is precisely why it must name what the user is
 * looking at.
 */
const REFUSAL_MESSAGES: Readonly<Record<'refused-next' | 'refused-generic', string>> = Object.freeze({
  'refused-next': `Next Edit: turn off "${GENERIC_ROW_LABEL}" first — the two sources are mutually exclusive.`,
  'refused-generic': `Next Edit: turn off "${NEXT_ROW_LABEL}" first — the two sources are mutually exclusive.`,
});

/**
 * The one notice a cold-start sanitize emits. Copy is this task's own (the
 * brief pins only "plus one notice"): it names what was found, what was done,
 * and why, without blaming the user — a both-on store is only reachable by
 * hand-editing `globalState` or by a future bug, never by the UI.
 */
export const NEXT_EDIT_RESET_NOTICE =
  'Next Edit Suggestions: the stored NEXT/Generic state had both sources on. They are mutually exclusive, so both have been turned off.';

export interface NextEditGuardDeps {
  reportFailure(msg: string): void;
}

/**
 * T-6 sweep pair: derives the {@link REFUSAL_MESSAGES} key for a REFUSED
 * decision. `applyToggleRequest`'s contract (`mode.ts:44-49`) guarantees
 * `decision.alert` is non-null whenever `decision.result === 'refused'` —
 * but `ToggleDecision.alert`'s TYPE (`'refused-next' | 'refused-generic' |
 * null`) can't express that guarantee, since `alert` and `result` are two
 * independent fields on the same object rather than a discriminated union.
 * `applyOne` therefore still needs a defensive fallback for the
 * (structurally-possible, contractually-unreachable) `alert: null` case.
 *
 * The fallback derives from `req.source` using the SAME conditional
 * `applyToggleRequest` itself uses to populate `alert` in the first place
 * (`req.source === 'next' ? 'refused-next' : 'refused-generic'`) — so even
 * that unreachable branch names the row that is ACTUALLY conflicting,
 * rather than a value hardcoded independent of what was being refused. The
 * OLD code hardcoded `'refused-next'` for a null `alert` unconditionally,
 * which — had this branch ever been reached — would have told the user to
 * turn off the WRONG row whenever `req.source` was 'generic'.
 *
 * `Pick`-typed on both parameters so a minimal literal is enough at any
 * call site (including a synthetic one in a test — the real
 * `applyToggleRequest` can never produce the `alert: null` input this
 * fallback exists for).
 */
export function refusalAlertKey(
  decision: Pick<ToggleDecision, 'alert'>,
  req: Pick<ToggleRequest, 'source'>,
): 'refused-next' | 'refused-generic' {
  return decision.alert ?? (req.source === 'next' ? 'refused-next' : 'refused-generic');
}

/**
 * Coerces an unknown stored value into a `ToggleState`. A store that was
 * hand-edited into a non-boolean (or a value written by a future/older
 * schema) degrades field-by-field to `false` rather than throwing on
 * activation or, worse, letting a truthy string enable a source.
 */
function coerceStoredToggles(stored: unknown): ToggleState {
  if (typeof stored !== 'object' || stored === null) {
    return DEFAULT_TOGGLES;
  }
  const record = stored as Record<string, unknown>;
  return { next: record.next === true, generic: record.generic === true };
}

export class NextEditGuard {
  /**
   * The LAST value this Guard wrote — the serialization queue's working
   * value, and NOT the authority. The authority is the store (see
   * `readCurrent`): a second window on the same profile can ratify a
   * different state, and `ExtensionMemento` refreshes its cached value from
   * an internal storage event, so a re-read is correct where a cached field
   * is stale. Never make a decision from this field.
   *
   * Fix wave, Finding 3: `notify()` no longer reads this field either — it
   * reads through like every other consumer. `lastWritten` now backs exactly
   * one thing: `applyOne`'s own return value, the direct answer to THIS
   * caller's own request.
   */
  private lastWritten: ToggleState;

  /** The serialization queue. Always settled-and-value-less, so one caller's
   *  refusal can never reject the NEXT caller's turn (see `requestToggle`). */
  private queue: Promise<void> = Promise.resolve();

  private readonly listeners = new Set<(s: ToggleState) => void>();

  private constructor(
    private readonly state: vscode.Memento,
    accepted: ToggleState,
  ) {
    this.lastWritten = accepted;
  }

  /**
   * THE read path. The store is the authority; this class caches nothing for
   * decisions.
   *
   * Sanitizes SILENTLY and persists NOTHING: the alerting, persisting
   * sanitize belongs to `hydrate` and only to `hydrate`. If this method ever
   * writes or warns, it has become a second writer and R5's single-writer
   * invariant is gone.
   *
   * `Memento.get` is SYNCHRONOUS (`index.d.ts:8602`, `:8612` — returns
   * `T | undefined` / `T`, not a Thenable), which is the entire reason this
   * is affordable: no call site becomes async.
   */
  private readCurrent(): ToggleState {
    const stored = coerceStoredToggles(this.state.get(NEXT_EDIT_TOGGLES_KEY));
    return sanitizeStoredToggles(stored).accepted;
  }

  /**
   * Hydrates through `sanitizeStoredToggles`. If it reports `didReset`, the
   * reset is PERSISTED («скинет в OFF» — so the next cold start does not
   * rediscover the same conflict) and reported once, both to the output
   * channel (`deps.reportFailure`) and to the user (one warning).
   */
  static async hydrate(state: vscode.Memento, deps: NextEditGuardDeps): Promise<NextEditGuard> {
    const stored = coerceStoredToggles(state.get(NEXT_EDIT_TOGGLES_KEY));
    const { accepted, didReset } = sanitizeStoredToggles(stored);

    if (didReset) {
      await state.update(NEXT_EDIT_TOGGLES_KEY, accepted);
      deps.reportFailure(NEXT_EDIT_RESET_NOTICE);
      void vscode.window.showWarningMessage(NEXT_EDIT_RESET_NOTICE);
    }

    return new NextEditGuard(state, accepted);
  }

  /**
   * Serialized toggle application. Two callers arriving in the same tick are
   * served in order, and the second decides against the FIRST's ratified
   * state — without this queue both would read the same pre-decision snapshot
   * and both could be accepted, persisting exactly the both-on conflict R5
   * exists to make unreachable.
   *
   * On `'refused'`: nothing is persisted, one warning is shown, and the
   * returned promise REJECTS with that same message (the correlated webview
   * request rejects in turn, so the toggle visibly rolls back). One alert per
   * refusal — a deliberate retry is a NEW user gesture and re-alerts. The
   * `provider.ts` Set-keyed one-shot is deliberately NOT reused here: it
   * would silence exactly the retry the user needs feedback on.
   */
  requestToggle(req: ToggleRequest): Promise<ToggleState> {
    const run = this.queue.then(() => this.applyOne(req));
    // The queue itself must stay a RESOLVED chain: swallow the outcome here
    // (the caller owns `run`'s rejection) so a refusal cannot cascade into
    // the next caller's turn, and so no unhandled rejection escapes.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyOne(req: ToggleRequest): Promise<ToggleState> {
    const decision = applyToggleRequest(this.readCurrent(), req);

    if (decision.result === 'refused') {
      // T-6 sweep pair: see `refusalAlertKey`'s doc comment — the fallback
      // it applies for a (contractually-unreachable) null `decision.alert`
      // now derives from `req.source`, not a hardcoded row.
      const message = REFUSAL_MESSAGES[refusalAlertKey(decision, req)];
      void vscode.window.showWarningMessage(message);
      throw new Error(message);
    }

    // `update` returns a Thenable (`index.d.ts:8623`) — awaited so the
    // ratified state is never ahead of the store.
    await this.state.update(NEXT_EDIT_TOGGLES_KEY, decision.accepted);
    this.lastWritten = decision.accepted;
    this.notify();
    return this.lastWritten;
  }

  /**
   * Fix wave, Finding 3: reads through like every other consumer of this
   * class. `lastWritten` is only THIS transaction's own write; by the time
   * listeners run, a cross-window race could already have moved the store
   * further, and pushing `lastWritten` would then hand the panel a value
   * `getState()` would immediately contradict. Reading through costs one
   * more `Memento.get` per accepted toggle and keeps the push consistent
   * with the store, the single authority everywhere else in this class.
   */
  private notify(): void {
    const current = this.readCurrent();
    for (const listener of [...this.listeners]) {
      listener(current);
    }
  }

  getState(): ToggleState {
    // A copy — LOAD-BEARING, not merely defensive: on an empty or malformed
    // store, `readCurrent()` returns `DEFAULT_TOGGLES` itself (`coerceStoredToggles`
    // hands it back by reference; `sanitizeStoredToggles` passes a
    // non-conflicting input through by reference too — see the field's own
    // comment). Without this copy, a caller mutating the returned object would
    // mutate that module-level singleton, and every Guard that ever hydrates
    // from an empty store afterward would inherit the corruption. Confirmed by
    // mutation (fix wave, Finding 1): dropping this copy is caught only by the
    // `getState()` singleton-escape probe in `guard.test.ts`.
    const current = this.readCurrent();
    return { next: current.next, generic: current.generic };
  }

  getMode(): NextEditMode {
    const current = this.readCurrent();
    return resolveNextEditMode(current.next, current.generic);
  }

  /** Feeds the webview's state push (Task 13). Fires only on ACCEPTED changes. */
  onDidChange(listener: (s: ToggleState) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}
