/**
 * nextedit/guard.ts — THE Guard (R5), re-based onto the setting
 * (onboarding/setup wave Task 2 · plan §5.5 · decision D7).
 *
 * The NEXT/Generic on-off state used to live in `ExtensionContext.globalState`
 * under `hermes.nextEdit.toggles`. That parallel store is gone: the single
 * source of truth is now the `talaria.nextEdit.source` enum setting
 * (`'off' | 'dedicated' | 'generic'`, machine scope, default `'off'`,
 * declared in package.json's "Next Edit" section and trust-restricted). Both
 * surfaces — the webview toggle rows AND the native settings page — edit that
 * ONE key; native-page edits flow back into the rows for free through
 * `onDidChangeConfiguration`.
 *
 * Mutual exclusion is STRUCTURAL now (D7): one enum value cannot hold two
 * "on" sources, so toggling the second source on REPLACES the first. The old
 * refusal path (and its copy) is gone from this module. The one refusal that
 * survives — "Generic on a FIM backend with no generic-NEXT support" — is a
 * transport concern and stays in `shell.vscode.ts`'s `requestNextEditToggle`
 * for the webview gesture; a native-page edit that lands that combo is NOT
 * reverted (a settings store can always hold it) — the engine no-ops with the
 * existing one-shot warning (`resolveRoute`'s `generic-unsupported-backend`
 * arm).
 *
 * The Guard talks to the setting through the narrow {@link NextEditConfigPort}
 * seam, so all of its logic is testable against an in-memory fake with no
 * live VS Code — and, F-7 by construction, the toggle control needs NO agent
 * connected: settings need no agent.
 *
 * The legacy `globalState` key survives in exactly one place: the one-time
 * migration ({@link migrateNextEditToggles}, §5.3), wired once at activation
 * in `extension.ts`. This module remains the ONLY one allowed to name either
 * key literal (locked in `guard.test.ts` and `coexistence.lock.test.ts`).
 *
 * `setKeysForSync` is still never called anywhere (locked in
 * `guard.test.ts`): the setting is machine-scoped — VS Code itself does not
 * roam machine-scoped settings — and nothing may reopen roaming for the
 * legacy memento key either.
 *
 * Field-by-field object construction only, no object-spread-with-override —
 * this file is in scope for `context/ringBuffer.test.ts`'s repo-wide purity
 * guards.
 */
import * as vscode from 'vscode';
import {
  resolveNextEditMode,
  sanitizeStoredToggles,
  type NextEditMode,
  type ToggleRequest,
  type ToggleState,
} from './mode';

/**
 * The LEGACY globalState key. Named ONLY for the one-time §5.3 migration —
 * nothing reads or writes it outside {@link migrateNextEditToggles}. Exported
 * for the Guard's own tests and the Task-14-style locks; no other module may
 * name it.
 */
export const NEXT_EDIT_TOGGLES_KEY = 'hermes.nextEdit.toggles';

/**
 * The ONE setting key (full dotted name, as `affectsConfiguration` takes it).
 * Exported for the Guard's own tests and the Task-14-style locks; no other
 * module may name it — every read/write goes through the port below.
 */
export const NEXT_EDIT_SOURCE_SETTING = 'talaria.nextEdit.source';

/** The section/key split of {@link NEXT_EDIT_SOURCE_SETTING}, for
 *  `getConfiguration(section).get/update(key, …)`. Derived, not restated, so
 *  the three spellings cannot drift. */
const SOURCE_SECTION = NEXT_EDIT_SOURCE_SETTING.slice(0, NEXT_EDIT_SOURCE_SETTING.lastIndexOf('.'));
const SOURCE_KEY = NEXT_EDIT_SOURCE_SETTING.slice(NEXT_EDIT_SOURCE_SETTING.lastIndexOf('.') + 1);

/** The enum the setting holds. Matches package.json's declaration exactly
 *  (locked by `host/configurationSections.test.ts`). */
export type NextEditSource = 'off' | 'dedicated' | 'generic';

/**
 * The seam the Guard (and the §5.3 migration) reads/writes the setting
 * through. The one production implementation is
 * {@link createVsCodeNextEditConfigPort}; tests inject in-memory fakes.
 */
export interface NextEditConfigPort {
  get(): NextEditSource;
  set(value: NextEditSource): Promise<void>;
  onDidChange(cb: () => void): { dispose(): void };
}

/**
 * A settings store can hold anything (`settings.json` is hand-editable), so
 * the read coerces: anything that is not exactly `'dedicated'` or `'generic'`
 * degrades to `'off'` — fail-closed, never throwing, and never letting a
 * truthy garbage value enable a source. The old Memento-era
 * `coerceStoredToggles` posture, carried to the new store.
 */
function coerceNextEditSource(raw: unknown): NextEditSource {
  return raw === 'dedicated' || raw === 'generic' ? raw : 'off';
}

/**
 * The real port, over `vscode.workspace`:
 *  - `get` reads FRESH through `getConfiguration` on every call (a
 *    `WorkspaceConfiguration` is a snapshot, so caching one would go stale);
 *  - `set` writes at `ConfigurationTarget.Global` — the key is machine-scoped
 *    (it steers where editor context is sent), so Global is the only target
 *    that can hold it;
 *  - `onDidChange` filters `onDidChangeConfiguration` through
 *    `affectsConfiguration(NEXT_EDIT_SOURCE_SETTING)`, which fires for BOTH
 *    our own `set` and a native settings-page edit — one event source for
 *    every writer, which is what makes native edits reach the webview rows.
 */
export function createVsCodeNextEditConfigPort(): NextEditConfigPort {
  return {
    get: () =>
      coerceNextEditSource(
        vscode.workspace.getConfiguration(SOURCE_SECTION).get<string>(SOURCE_KEY, 'off'),
      ),
    set: async (value: NextEditSource): Promise<void> => {
      await vscode.workspace
        .getConfiguration(SOURCE_SECTION)
        .update(SOURCE_KEY, value, vscode.ConfigurationTarget.Global);
    },
    onDidChange: (cb: () => void) =>
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(NEXT_EDIT_SOURCE_SETTING)) {
          cb();
        }
      }),
  };
}

/** enum → the `{next, generic}` pair the rest of the feature (and the webview
 *  protocol) speaks. Always a FRESH object — callers may mutate their copy. */
function toToggleState(source: NextEditSource): ToggleState {
  return { next: source === 'dedicated', generic: source === 'generic' };
}

/**
 * One toggle gesture as an enum transition — the whole of what used to be
 * `applyToggleRequest` plus the refusal machinery:
 *  - toggle-ON simply BECOMES that source (structural exclusion: assigning
 *    one enum value is what replaces the other — there is no conflict state
 *    to refuse);
 *  - toggle-OFF of the ACTIVE source goes to `'off'`;
 *  - toggle-OFF of an INACTIVE source changes nothing (same as the old
 *    `withToggle(state, source, false)` on an already-false field).
 */
function applyToggleToSource(current: NextEditSource, req: ToggleRequest): NextEditSource {
  const own: NextEditSource = req.source === 'next' ? 'dedicated' : 'generic';
  if (req.on) return own;
  return current === own ? 'off' : current;
}

export interface NextEditGuardDeps {
  reportFailure(msg: string): void;
}

export class NextEditGuard {
  /** The serialization queue. Always settled-and-value-less, so one caller's
   *  failed settings write can never reject the NEXT caller's turn. */
  private queue: Promise<void> = Promise.resolve();

  private readonly listeners = new Set<(s: ToggleState) => void>();

  /**
   * The last value PUSHED to listeners — a dedupe cursor, NOT an authority.
   * Every read path (`getState`/`getMode`) goes through `config.get()`
   * fresh; this field only stops the config-change event from re-pushing a
   * value the listeners already have (the event can fire for our own write
   * AND for section-level changes that did not move this key).
   */
  private lastPushed: NextEditSource;

  private readonly configSubscription: { dispose(): void };

  private constructor(
    private readonly config: NextEditConfigPort,
    private readonly deps: NextEditGuardDeps,
  ) {
    this.lastPushed = config.get();
    // THE one notification source. Our own `set` and a native-page edit both
    // land here (the real port's event fires for both), so `applyOne` below
    // deliberately does NOT push a second time.
    this.configSubscription = config.onDidChange(() => this.notify());
  }

  /**
   * Async for call-site stability (hydration has been a `.then` continuation
   * since Task 12 and the activation-race guard in `autocomplete/index.ts`
   * depends on it landing on a later tick) — there is nothing left to await:
   * the setting needs no sanitize (an enum cannot hold two "on" values, and
   * the port coerces garbage to `'off'` on read) and no cold-start write.
   */
  static async hydrate(config: NextEditConfigPort, deps: NextEditGuardDeps): Promise<NextEditGuard> {
    return new NextEditGuard(config, deps);
  }

  /**
   * Serialized toggle application. Two callers arriving in the same tick are
   * served in order, and the second decides against the FIRST's ratified
   * value — the queue survives the re-base because `config.set` is async and
   * two interleaved read-then-write pairs could still race each other.
   *
   * No refusal path: mutual exclusion is structural (see the module doc).
   * The returned promise rejects only if the settings WRITE itself fails —
   * reported once to the output channel, and propagated so the webview row
   * visibly rolls back instead of showing a state that never persisted.
   */
  requestToggle(req: ToggleRequest): Promise<ToggleState> {
    const run = this.queue.then(() => this.applyOne(req));
    // The queue itself must stay a RESOLVED chain: swallow the outcome here
    // (the caller owns `run`'s rejection) so a failed write cannot cascade
    // into the next caller's turn, and no unhandled rejection escapes.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyOne(req: ToggleRequest): Promise<ToggleState> {
    const current = this.config.get();
    const next = applyToggleToSource(current, req);
    if (next !== current) {
      try {
        await this.config.set(next);
      } catch (err) {
        this.deps.reportFailure(
          `[nextEdit] could not write ${NEXT_EDIT_SOURCE_SETTING}: ${String(err)}`,
        );
        throw err;
      }
    }
    // Read through, never echo `next` back: the store is the authority, and
    // by the time the write resolved another window could have moved it.
    return toToggleState(this.config.get());
  }

  /** Push the CURRENT derived state — deduped via `lastPushed` (see its doc). */
  private notify(): void {
    const current = this.config.get();
    if (current === this.lastPushed) return;
    this.lastPushed = current;
    for (const listener of [...this.listeners]) {
      // A fresh object per listener: no shared value a callback could mutate
      // out from under its siblings.
      listener(toToggleState(current));
    }
  }

  getState(): ToggleState {
    return toToggleState(this.config.get());
  }

  getMode(): NextEditMode {
    const current = this.getState();
    return resolveNextEditMode(current.next, current.generic);
  }

  /** Feeds the webview's state push and the shell's lazy edit-tracker build.
   *  Fires on every genuine value change — our own accepted toggles AND
   *  native-page edits, one event source for both. */
  onDidChange(listener: (s: ToggleState) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Releases the config-change subscription. Wired into the autocomplete
   *  zone's composite disposable at the composition root. */
  dispose(): void {
    this.configSubscription.dispose();
    this.listeners.clear();
  }
}

/**
 * Coerces an unknown stored value into a `ToggleState` — the legacy store was
 * hand-editable, so a non-boolean degrades field-by-field to `false` rather
 * than throwing or letting a truthy string enable a source. Kept ONLY for the
 * migration below.
 */
function coerceStoredToggles(stored: unknown): ToggleState {
  if (typeof stored !== 'object' || stored === null) {
    return { next: false, generic: false };
  }
  const record = stored as Record<string, unknown>;
  return { next: record.next === true, generic: record.generic === true };
}

/**
 * The one-time §5.3 migration: `globalState['hermes.nextEdit.toggles']` →
 * `talaria.nextEdit.source`. Runs once at activation (`extension.ts`);
 * idempotent by the LATCH: the memento delete is the latch, so a second run
 * (and every activation after) finds no memento key and returns immediately.
 *
 *  - Memento absent → complete no-op (fresh install, or already migrated).
 *  - Setting still default `'off'` → write `next ? 'dedicated' : generic ?
 *    'generic' : 'off'` at Global, then delete the memento key. A computed
 *    `'off'` skips the write — the setting already reads `'off'`, and writing
 *    the default explicitly would only churn the user's settings.json.
 *  - Setting already NON-default → the user has expressed a preference since
 *    (or another window migrated first): delete the memento WITHOUT
 *    overwriting the setting.
 *  - A legacy BOTH-ON store (the old hand-edited conflict) sanitizes to OFF —
 *    byte-for-byte the outcome the old cold-start reset produced, never a
 *    silent pick of one source.
 *
 * ORDER MATTERS, and it is the fail-safe: the setting is written BEFORE the
 * memento is deleted, so a failed write leaves the latch intact and the next
 * activation retries — a burned latch with nothing migrated would silently
 * turn a beta user's NEXT off forever.
 *
 * `Memento.update(key, undefined)` REMOVES the key (API-pinned: "using
 * `undefined` as value removes the key from the underlying storage").
 */
export async function migrateNextEditToggles(
  state: vscode.Memento,
  config: NextEditConfigPort,
): Promise<void> {
  const stored = state.get(NEXT_EDIT_TOGGLES_KEY);
  if (stored === undefined) return; // the latch: nothing to migrate

  if (config.get() === 'off') {
    const { accepted } = sanitizeStoredToggles(coerceStoredToggles(stored));
    const source: NextEditSource = accepted.next ? 'dedicated' : accepted.generic ? 'generic' : 'off';
    if (source !== 'off') {
      await config.set(source);
    }
  }

  await state.update(NEXT_EDIT_TOGGLES_KEY, undefined);
}
