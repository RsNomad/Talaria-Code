/**
 * nextedit/shell.vscode.ts — Job B Task 12 · THE shell.
 *
 * Everything `vscode`-shaped that next-edit needs lives here: the effect
 * executor, the trigger path, the listeners, the commands, the toggle gate.
 * Every DECISION this file makes was already made by a pure core it calls —
 * the shell translates, it does not judge. `TextDocument.version` is the
 * freshness token and it stays here (Global Constraints: "Pure cores, thin
 * shell").
 *
 * This file NEVER calls the inline-completion registration API (Global
 * Constraints: "Exactly ONE InlineCompletionItemProvider. Forever." — the
 * sole call site stays `src/autocomplete/index.ts`). Next-edit reaches the
 * screen through decorations + context keys + keybindings, never through the
 * inline-completion surface. Locked by a source scan in this file's tests.
 *
 * Field-by-field object construction only, no object-spread-with-override,
 * and no brand casts — the request brand is obtained by CALLING the one
 * sanctioned mint (`scan.ts`). This file is in scope for
 * `context/ringBuffer.test.ts`'s repo-wide BRAND-FORGERY guards: a ban on
 * forging the request brand via a cast (see that file's own module doc for
 * the exact pattern — not restated here, since that guard's scan reads raw
 * file text, comments included, and restating the pattern here would trip
 * it) plus a brand-preserving-spread ban. Those two guards check ONLY the
 * cast/spread shapes they name, nothing more (F-10: this comment used to
 * call them "purity guards", which overstated what they enforce). The
 * separate `vscode`-import purity boundary this file also lives inside is
 * locked by `nextEditPurity.test.ts`, not by `ringBuffer.test.ts`.
 */
import * as vscode from 'vscode';
import { AutocompleteDebouncer } from '../debouncer';
import { isSecretForCompletion } from '../../shared/secretPaths';
import { createEditTrackerAdapter, type EditTrackerAdapter } from '../context/editTrackerAdapter';
import { isTriggerableScheme } from '../context/recordableScheme';
import type { FimActivityListener } from '../provider';
import { OnceRegistry } from '../onceRegistry';
import { regionAroundCursor } from './anchors';
import { NextEditHttpBackend } from './backend';
import { DEFAULT_FILE_WINDOW_OPTIONS, windowAroundCursor } from './fileWindow';
import { attachFimActivity, detachFimActivity, fimActivityRelay } from './fimActivityRelay';
import { reduceNextEdit } from './fsm';
import type { RenderedNextEditPrompt } from './formats/types';
import { NextEditGuard } from './guard';
import { resolveNextEditMode, type NextEditMode, type ToggleRequest, type ToggleState } from './mode';
import { computeChangesAboveCursor, filterEgressableDiffs } from './nextEditEgress';
import { describeTriggerFailure } from './nextEditFailureSurface';
import {
  deriveGenericTransport,
  GENERIC_SETUP_NOTE,
  genericUnsupportedBackendMessage,
  NEXT_EDIT_MODEL_UNSET_NOTE,
  resolveRoute,
  type NextEditRoute,
} from './nextEditRoute';
import { buildFimActivity, registerCommands, registerListeners, type ShellHostSeams } from './nextEditShellWiring';
import { ensureTrailingNewline, extractRegionRange, stripLineTerminator } from './nextEditText';
import {
  makeExecutor,
  type NextEditContextKey,
  type NextEditExecutor,
  type NextEditExecutorHost,
} from './nextEditExecutor';
import { mintScannedNextEditRequest, NextEditMintRejectionError } from './scan';
import type {
  AnchoredProposal,
  ApplyExpectation,
  EditableRegion,
  NextEditFsmEvent,
  NextEditFsmState,
  NextEditRequest,
} from './types';

/**
 * WS-F3 F3-5 (FI-06): `NextEditContextKey`, `NextEditExecutorHost`,
 * `NextEditExecutor` and `makeExecutor` moved verbatim to `./nextEditExecutor`
 * (a vscode-FREE leaf, alongside the effect-executor core) — re-exported here
 * so the shell's own public surface, and `shell.vscode.test.ts`'s
 * `import { makeExecutor, type NextEditExecutorHost } from './shell.vscode'`,
 * keep resolving through `./shell.vscode` with zero further edits, exactly as
 * the F3-1 golden masters' own module doc anticipates ("F3-2..F3-8 move
 * implementations to new modules but the shell RE-EXPORTS each one").
 */
export { makeExecutor };
export type { NextEditContextKey, NextEditExecutorHost, NextEditExecutor };

/** The edit-burst debounce. Matches `talaria.autocomplete.debounceMs`'s own
 *  350 ms default — next-edit rides the same "the user paused typing" signal
 *  FIM does, and reuses FIM's debouncer implementation rather than a second
 *  hand-rolled timer. */
const TRIGGER_DEBOUNCE_MS = 350;

/** Copy for every `noteOnce` msgId the FSM can emit. */
const NOTE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'apply-failed':
    'Next Edit: the proposed edit could not be applied — the document changed underneath it. The proposal was dismissed.',
});

/**
 * WS-F3 F3-3 (FI-06): `DEFAULT_NEXT_EDIT_ENDPOINTS`, `GENERIC_SETUP_NOTE`,
 * `NEXT_EDIT_MODEL_UNSET_NOTE`, `genericUnsupportedBackendMessage` and
 * `deriveGenericTransport` moved verbatim to `./nextEditRoute` (a vscode-FREE
 * leaf, alongside the route-resolution core) — re-exported here so the
 * shell's own public surface, and every internal call site below, keep
 * resolving through `./shell.vscode` with zero further edits, exactly as the
 * F3-1 golden masters' own module doc anticipates ("F3-2..F3-8 move
 * implementations to new modules but the shell RE-EXPORTS each one").
 */
export { deriveGenericTransport, GENERIC_SETUP_NOTE, NEXT_EDIT_MODEL_UNSET_NOTE, genericUnsupportedBackendMessage };

// ──────────────────────────────── the FIM seam ───────────────────────────────

/**
 * WS-F3 F3-8 (FI-07): `FIM_ACCEPT_COMMAND` (the R4 seam's command id) moved
 * verbatim to `./nextEditShellWiring`, alongside its two use sites
 * (`buildFimActivity`'s `acceptCommandId` and `registerCommands`'s fourth
 * registration) — both moved there in the same commit, so the constant moved
 * with them rather than being re-exported. Nothing in `shell.vscode.ts`
 * itself names it any more; the ctor advertises it indirectly, by calling
 * `attachFimActivity(this.fimActivity)` AFTER `registerCommands` has run.
 */

/**
 * WS-F3 F3-6 (FI-06): `NO_OP_FIM_ACTIVITY`, the module-level `currentFimActivity`
 * slot, and `fimActivityRelay` itself moved verbatim to `./fimActivityRelay`
 * (a vscode-FREE leaf; the slot is KEPT BY DESIGN — provider→shell
 * decoupling, and FI-26's future home, task F10-2) — re-exported here so the
 * shell's own public surface, and `provider.ts`'s/`index.ts`'s
 * `import { fimActivityRelay, ... } from './nextedit/shell.vscode'` plus
 * `shell.vscode.test.ts`'s and `nextedit.golden.shell.test.ts`'s own
 * `import { fimActivityRelay, ... } from './shell.vscode'`, keep resolving
 * through `./shell.vscode` with zero further edits, exactly as the F3-1
 * golden masters' own module doc anticipates ("F3-2..F3-8 move
 * implementations to new modules but the shell RE-EXPORTS each one").
 */
export { fimActivityRelay };

// ───────────────────────────── the toggle gate ───────────────────────────────

/** CA-06-NE-face — the notice seam's shapes. Observational only: §7 of the design. */
export type NextEditEgressVerdict = 'path-block' | 'content-block' | 'allow';
export type NextEditEgressObserver = (filepath: string, verdict: NextEditEgressVerdict) => void;

export interface NextEditShellDeps {
  reportFailure(msg: string): void;
  getAutocompleteEndpoint(): string;
  getAutocompleteModel(): string;
  getAutocompleteBackend(): string;
  /**
   * The EFFECTIVE FIM key — the SecretStorage value, falling back to the
   * deprecated machine-scoped setting, exactly as the FIM engine resolves it
   * (`apiKey.ts` `pickApiKey`). Generic rides FIM's endpoint and FIM's model,
   * so it must ride FIM's credential: the destination is byte-identical, and
   * an unauthenticated request to an authed endpoint is not safer, it is
   * simply one that fails.
   *
   * The NEXT route must NEVER read this — it has its own endpoint, and
   * sending FIM's credential to a different host would be a genuine new
   * exposure. That is enforced structurally: the `next` branch of
   * `resolveRoute` leaves `NextEditRoute.apiKey` unset.
   */
  getAutocompleteApiKey(): string | undefined;
  /** CA-06-NE-face — optional, purely OBSERVATIONAL: notified with the
   *  egress verdict at GATE 5 ('path-block'), after a successful mint
   *  ('allow'), and on a mint rejection ('content-block'). It cannot affect
   *  the trigger path: every call goes through the shell's never-throwing
   *  `notifyEgress` helper, is decided-then-notified, synchronous, and
   *  result-ignored. Absent in every test/lock harness by design; the
   *  composition root wires it UNCONDITIONALLY (the next-edit gates are
   *  locality-unconditioned, unlike FIM's CA-06). */
  onEgressVerdict?: NextEditEgressObserver;
}

/**
 * THE toggle entry point — Task 13's webview `nextEdit.toggle` request calls
 * this, never `guard.requestToggle` directly.
 *
 * Two things wrap the Guard's own (transport-blind) decision:
 *
 *  1. A generic toggle-ON against an unsupported FIM backend is refused HERE,
 *     before the Guard ratifies anything — the Guard knows nothing about
 *     transports, and a refusal that persisted first would leave a mode
 *     selected that can never produce a valid prompt. Since Task 2 (§5.5/D7)
 *     this is the ONLY refusal left on the webview path: mutual exclusion is
 *     structural in the `talaria.nextEdit.source` enum, so the old
 *     second-source conflict now RESOLVES with the replaced state. A
 *     native-page edit that lands the unsupported combo is deliberately NOT
 *     reverted — a settings store can always hold it, and the engine no-ops
 *     with the one-shot `generic-unsupported-backend` warning in `trigger()`.
 *  2. The `08` §6.3 setup note fires on an ACCEPTED generic toggle-on, and
 *     only there: not on a refusal, not on toggle-off, not on
 *     the NEXT source. Exactly one note per accepted gesture — it is emitted
 *     from this one site, so there is no second path that could double it.
 */
export async function requestNextEditToggle(
  guard: NextEditGuard,
  req: ToggleRequest,
  deps: NextEditShellDeps,
): Promise<ToggleState> {
  if (req.source === 'generic' && req.on) {
    const fimBackend = deps.getAutocompleteBackend();
    if (deriveGenericTransport(fimBackend) === null) {
      const message = genericUnsupportedBackendMessage(fimBackend);
      deps.reportFailure(message);
      void vscode.window.showWarningMessage(message);
      throw new Error(message);
    }
  }

  const accepted = await guard.requestToggle(req);

  if (req.source === 'generic' && req.on) {
    void vscode.window.showInformationMessage(GENERIC_SETUP_NOTE);
  }

  return accepted;
}

// ────────────────────────────── request building ─────────────────────────────

/**
 * WS-F3 F3-3 (FI-06): the `NextEditRoute` shape, `isLoopbackEndpoint`,
 * `RouteResolution` and `resolveRoute` (plus `endpointLabel`) moved verbatim
 * to `./nextEditRoute` (a vscode-FREE leaf) — imported above where the shell
 * still consumes them (`resolveRoute` from `resolveReportedRoute` below,
 * `NextEditRoute` as the type every method below still spells).
 * `isLoopbackEndpoint` and `RouteResolution` are module-private/unused-by-name
 * in this file; neither was part of the shell's public surface before the
 * move, so neither needs re-exporting — the F3-1 goldens observe them only
 * through `registerTalariaNextEdit`, unaffected by this move. `endpointLabel`
 * itself is no longer imported HERE at all (WS-F3 F3-7, FI-13):
 * `surfaceTriggerFailure`'s only caller of it moved to
 * `nextEditFailureSurface.ts`'s `describeTriggerFailure`, which imports
 * `endpointLabel` directly from `./nextEditRoute`.
 */

/** Workspace-relative POSIX path, mirroring `editTrackerAdapter.ts`'s helper
 *  (Fedora/Linux target; workspace URIs are always '/'-separated).
 *
 *  STAYS here (WS-F3 F3-2, critic I-1): unlike the three text helpers below,
 *  this one calls `vscode.workspace.asRelativePath` on a `vscode.Uri` and is
 *  therefore NOT pure — moving it into the vscode-FREE `nextEditText.ts`
 *  would break that module's purity boundary (`nextEditPurity.test.ts`). */
function toWorkspaceRelativePosixPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).split('\\').join('/');
}

/**
 * WS-F3 F3-2 (FI-06): `ensureTrailingNewline`, `stripLineTerminator`, and
 * `extractRegionRange` moved verbatim to `./nextEditText` (a vscode-FREE pure
 * leaf) — re-exported here so the shell's own surface, and every internal
 * call site below, keep resolving through `./shell.vscode` with zero further
 * edits, exactly as the F3-1 golden masters' own module doc anticipates
 * ("F3-2..F3-8 move implementations to new modules but the shell RE-EXPORTS
 * each one").
 */
export { ensureTrailingNewline, stripLineTerminator, extractRegionRange };

/**
 * WS-F3 F3-4 (FI-06, FI-27): `diffMayEgress`, `filterEgressableDiffs`
 * (renamed from `partitionEgressableDiffs`, now returning the kept list
 * only), `computeChangesAboveCursor`, and `toContentChangeLites` moved
 * verbatim to `./nextEditEgress` (a vscode-FREE leaf) — `diffMayEgress` is
 * re-exported here so `diffEgressDrift.lock.test.ts`'s own
 * `import { diffMayEgress } from './shell.vscode'` keeps resolving through
 * `./shell.vscode` with zero further edits, exactly as the F3-1 golden
 * masters' own module doc anticipates ("F3-2..F3-8 move implementations to
 * new modules but the shell RE-EXPORTS each one").
 */
export { diffMayEgress } from './nextEditEgress';

// ─────────────────────────────── registration ────────────────────────────────

/**
 * FUNC-NEXTEDIT — the shell, promoted from a 770-line closure to a class.
 * The closure already received its deps as parameters (the Fowler parameter
 * seam); the constructor takes the same three. Every method body is the
 * closure's body moved verbatim — behavior is pinned by the T15 ordered
 * traces and the pre-existing shell suite (zero assertion edits).
 * Module-private: the ONLY public entry stays `registerTalariaNextEdit`.
 */
class NextEditShell {
  private disposed = false;
  private state: NextEditFsmState = { kind: 'idle' };
  /** The document version the live proposal is anchored to. `null` when idle.
   *  This is the freshness token the Global Constraints keep in the shell. */
  private trackedVersion: number | null = null;
  /** BHF-F3-15 — the freshness pair for the applyEdit effect this dispatch
   *  may emit, captured BEFORE the reducer can transition to idle (tabAccept
   *  does) and null the tracking state below. */
  private pendingApplyExpectation: ApplyExpectation | null = null;
  /** The next-edit request in flight, if any. Aborted by a FIM start (R2) and
   *  by the next next-edit trigger (single-flight). NEVER the reverse: this
   *  module holds no FIM cancellation handle at all. */
  private inFlight: AbortController | null = null;

  /**
   * R2's view of what FIM is doing. `inFlightCount` is a REFCOUNT, not a
   * flag, and that distinction is load-bearing: VS Code invokes
   * `provideInlineCompletionItems` concurrently — it cancels the superseded
   * token, but that invocation still runs to its own `finally`, which fires
   * the paired `resultShown` (`provider.ts`). So the ORDINARY keystroke
   * sequence is `requestStarted(#2)` and only then `resultShown(#1)`. A
   * boolean would be cleared by #1's late settle while #2 was genuinely in
   * flight, opening GATE 2 and letting next-edit build a request during a
   * live FIM request — precisely what R2 forbids. Counting makes "FIM is
   * idle" mean what it says: every started request has settled.
   */
  private readonly fim = { visible: false, inFlightCount: 0 };
  private readonly debouncer = new AutocompleteDebouncer();

  /**
   * FI-26 (FSU §5 Q4) — task F10-2b: ONE {@link OnceRegistry} instance for
   * the whole shell lifetime (per activation — `NextEditShell` is
   * constructed once per `registerTalariaNextEdit` call). `runPrediction`
   * constructs a fresh `NextEditHttpBackend` per prediction attempt but
   * always passes THIS SAME instance as `registry` — never a fresh
   * `new OnceRegistry()` per prediction, which would reset dedup on every
   * attempt (warn every time = a regression). Sharing this one instance
   * across predictions gives warn-once-per-activation, matching the FIM
   * path's own activation-scoped registry (`index.ts`'s `onceRegistry`,
   * threaded to `backendFactory.ts`'s `createBackend` and to
   * `provider.ts`'s construction).
   */
  private readonly onceRegistry = new OnceRegistry();

  /**
   * CF-20-lazy — `createEditTrackerAdapter()` is next-edit's HALF of two
   * complete edit-tracking pipelines that used to run on the keystroke hot
   * path regardless of whether next-edit was ever reachable: it subscribes
   * to `onDidChangeTextDocument`/`onDidChangeVisibleTextEditors` and folds
   * every edit into a live diff ring plus a per-document shadow-text cache
   * (`editTrackerAdapter.ts`). A user who never enables EITHER next-edit
   * toggle used to pay that cost forever, for a feature that GATE 1 below
   * refuses to even build a request for. FIM's own tracker
   * (`context/contextService.vscode.ts`) is a wholly separate instance and
   * is unaffected by this — that half was never gated by these toggles.
   *
   * Deferred to the Guard's FIRST toggle-on and memoized: built at most
   * once per registration, and every later toggle reuses the same instance
   * rather than rebuilding it.
   *
   * Why this reads `ToggleState` (via `guard.getState()` / the change
   * listener's own argument) and resolves it with `resolveNextEditMode`
   * rather than calling `guard.getMode()`: the read-through-hazard source
   * lock further down this file (`shell.vscode.test.ts`, "the trigger
   * snapshots the mode ONCE") pins `guard.getMode()` to EXACTLY one call
   * site, inside `trigger()`. A second call site here would trip it, and
   * would also (for the reason that lock exists) risk answering
   * differently mid-flight from the read `trigger()` already took.
   */
  private editTrackerInstance: EditTrackerAdapter | null = null;

  /**
   * F-4 — the one-shot failure surface, mirroring `provider.ts`'s
   * `surfacedAutocompleteFailures` + `surfaceIfFirst` pair rather than
   * inventing a second mechanism. `08` §9.3: transport-guard refusals
   * "surface once (actionable)".
   *
   * REGISTRATION-scoped, not module-scoped, which is the one deliberate
   * difference from the FIM side: `registerTalariaNextEdit` IS next-edit's
   * re-arm point (a fresh registration re-arms every warning), so no
   * `clearSurfaced…` export is needed and no state leaks between activations.
   * A config-change re-arm was considered and rejected: it would need an
   * `onDidChangeConfiguration` subscription, and the shell's own coexistence
   * lock suite constructs it against a fake `vscode` that has no such API.
   *
   * No timers, no counters, no state beyond this Set.
   */
  private readonly surfacedFailures = new Set<string>();

  // Two decoration types, created ONCE for the whole activation.
  private readonly regionDecoration: vscode.TextEditorDecorationType;
  private readonly locatorDecoration: vscode.TextEditorDecorationType;

  /**
   * The executor's host port. Built in the constructor; its methods MUST be
   * arrow-bodied object properties so `this` inside them binds to the shell
   * instance — they reference `this.editorFor`, `this.currentProposal`, and
   * the decoration fields above.
   */
  private readonly executorHost: NextEditExecutorHost;
  private readonly executor: NextEditExecutor;

  /**
   * Held under its own name so `dispose()` below can prove it still OWNS the
   * module-level relay slot before clearing it — `./fimActivityRelay`'s
   * `currentFimActivity` is a single shared slot, and a newer registration
   * may already have taken it.
   */
  private readonly fimActivity: FimActivityListener;

  readonly disposable: vscode.Disposable;

  constructor(
    context: vscode.ExtensionContext,
    private readonly guard: NextEditGuard,
    private readonly deps: NextEditShellDeps,
  ) {
    // Covers a Guard hydrated ALREADY on (state persisted from a previous
    // session) — no `onDidChange` event fires this session in that case, so
    // without this check the adapter would never be built at all and
    // next-edit would run silently inert (no pre-edit shadow, an always-empty
    // diff ring) until the user toggled it off and back on.
    this.buildEditTrackerOnToggleOn(this.guard.getState());
    const guardToggleSubscription = this.guard.onDidChange((toggles) => this.buildEditTrackerOnToggleOn(toggles));

    this.regionDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    });
    this.locatorDecoration = vscode.window.createTextEditorDecorationType({});

    this.executorHost = {
      setContext: (key, value) => {
        void vscode.commands.executeCommand('setContext', key, value);
      },
      showDecorations: (p, jumped) => {
        const editor = this.editorFor(p.region.uri);
        // F-1: DECLINE rather than silently no-op. The executor turns a declined
        // paint into a full `clearAll`, so `jumpVisible` can never stand up
        // against an empty screen (and Tab can never be stolen in a file that
        // has no proposal).
        if (editor === undefined) return false;
        const regionRange = new vscode.Range(p.region.startLine, 0, p.region.endLine, 0);
        editor.setDecorations(this.regionDecoration, [regionRange]);

        // U-7 — the SPAN, in the 1-based coordinates the gutter shows, not a
        // "distance". `regionAroundCursor` returns cursor ± windowLines, so the
        // old `|startLine − cursorLine|` was the CONSTANT `windowLines` for
        // every proposal past line 10, and its `⤵` pointed DOWN at a region
        // that starts ten lines ABOVE the cursor. This says something the user
        // can check against their own gutter.
        const firstLine = p.region.startLine + 1;
        const lastLine = p.region.endLine + 1;
        const verb = jumped ? 'Tab to accept' : 'Tab to jump';
        const lineLength = editor.document.lineAt(p.cursorLine).text.length;
        // Zero-width end-of-line range on the CURSOR line — the locator rides
        // where the user is looking, not where the edit is.
        const locatorRange = new vscode.Range(p.cursorLine, lineLength, p.cursorLine, lineLength);
        editor.setDecorations(this.locatorDecoration, [
          {
            range: locatorRange,
            renderOptions: {
              after: {
                // U-7: `08` §10 pins this copy as `⤵ N lines · <verb> · Esc to
                // dismiss`. The verb and the Esc clause are kept verbatim; the
                // leading clause is the one the final review found to be
                // untrue in every case, so it now reports the span instead of a
                // constant. `⇕` because the region brackets the cursor (it is
                // cursor ± windowLines) — it never lies below it, which is what
                // `⤵` claimed. Visual separation from the code is `margin`'s
                // job, never padding baked into the string.
                contentText: `⇕ lines ${firstLine}–${lastLine} · ${verb} · Esc to dismiss`,
                margin: '0 0 0 1em',
                color: new vscode.ThemeColor('editorGhostText.foreground'),
              },
            },
          },
        ]);
        return true;
      },
      clearDecorations: () => {
        for (const editor of vscode.window.visibleTextEditors) {
          editor.setDecorations(this.regionDecoration, []);
          editor.setDecorations(this.locatorDecoration, []);
        }
      },
      reveal: (range) => {
        // F-1: `range` is bare line geometry — it carries no uri of its own, so
        // an unqualified `activeTextEditor` would happily scroll a FOREIGN file
        // to line numbers taken from the proposal's document. The live proposal
        // is the range's only owner (`reveal` is emitted solely by
        // `proposed × tabJump`, whose `p` is the state the shell already holds),
        // so resolve the editor through the SAME `editorFor` identity check the
        // paint uses — one definition, so the two cannot drift.
        const proposal = this.currentProposal();
        const editor = proposal === null ? undefined : this.editorFor(proposal.region.uri);
        if (editor === undefined) return;
        editor.revealRange(
          new vscode.Range(range.startLine, 0, range.endLine, 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      },
      applyEdit: async (region, newText, expected) => {
        // A plain WorkspaceEdit — never the ACP diff-decision gate (Global
        // Constraints). This is the user's own accepted edit in their own
        // editor, not an agent-proposed change needing approval.
        //
        // BHF-F3-15 — fail-closed re-validation, immediately before the edit:
        if (expected === null) return false;
        const editor = this.editorFor(region.uri);
        if (editor === undefined) return false;
        const document = editor.document;
        // (1) VERSION: `TextDocument.version` strictly increases on every
        // change — any interleaved edit in the dispatch→apply gap fails this.
        if (document.version !== expected.docVersion) return false;
        const endLine = Math.min(region.endLine, document.lineCount - 1);
        const range = new vscode.Range(
          region.startLine,
          0,
          endLine,
          document.lineAt(endLine).text.length,
        );
        // (2) BASE TEXT: the bytes being replaced must be the bytes the
        // proposal was anchored to — the belt for anything version cannot
        // see (e.g. a reanchor-drift bug). getText(range) clamps, mirroring
        // the proposal-time read.
        if (document.getText(range) !== expected.baseText) return false;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, newText);
        // `workspace.applyEdit` resolves false when the edit could not be
        // applied (all-or-nothing for text-only edits) — that residual-window
        // failure reports through the same boolean.
        return vscode.workspace.applyEdit(edit);
      },
      note: (msgId) => {
        const message = NOTE_MESSAGES[msgId] ?? `Next Edit: ${msgId}`;
        this.deps.reportFailure(message);
        void vscode.window.showWarningMessage(message);
      },
    };

    this.executor = makeExecutor(
      this.executorHost,
      (ok) => this.dispatch({ kind: 'applyResult', ok }),
      () => this.pendingApplyExpectation,
    );

    // WS-F3 F3-8 (FI-07): the NARROW port `buildFimActivity`/
    // `registerListeners`/`registerCommands` (`./nextEditShellWiring`) close
    // over — an EXPLICIT seam object, never `this` itself (`fim`/`dispatch`/
    // `armTrigger`/`abortInFlight`/`currentProposal` are all `private`, and
    // passing `this` structurally into a public interface naming a private
    // member does not type-check under `strict`). `fim` is the SAME mutable
    // object this class holds (reference-shared, no copy); `trackedVersion`
    // is a get/set ACCESSOR PROPERTY bridging to the class's own private
    // field, precisely so every moved block's `this.trackedVersion` becomes
    // `seams.trackedVersion` — a literal rename, not a reshaping into method
    // calls. `shell` is captured because a `get`/`set` accessor shorthand's
    // own `this` binds to the object literal it lives on, not the enclosing
    // constructor's `this`.
    const shell = this;
    const hostSeams: ShellHostSeams = {
      fim: this.fim,
      get trackedVersion(): number | null {
        return shell.trackedVersion;
      },
      set trackedVersion(value: number | null) {
        shell.trackedVersion = value;
      },
      dispatch: (event) => this.dispatch(event),
      armTrigger: () => this.armTrigger(),
      abortInFlight: () => this.abortInFlight(),
      currentProposal: () => this.currentProposal(),
    };

    // The FIM-activity object literal, the onDidChangeTextDocument/
    // onDidChangeActiveTextEditor/onDidChangeWindowState listeners, and the
    // four registerCommand calls all moved verbatim to `./nextEditShellWiring`
    // — the ctor now delegates to their builders over `hostSeams` above, IN
    // THE SAME ORDER it always built them (registration/attach/dispose ORDER
    // is load-bearing — F3-1's spy-ORDER golden pins it).
    this.fimActivity = buildFimActivity(hostSeams);
    const listenerDisposables = registerListeners(hostSeams);
    const commandDisposables = registerCommands(hostSeams);

    // ATTACH LAST. `fimActivity.acceptCommandId()` advertises FIM_ACCEPT_COMMAND
    // to `provider.ts`, so the relay may not point here until that command is
    // actually registered — which happened inside `registerCommands` above.
    // Ordering it this way makes "an advertised command is a registered
    // command" structural rather than a property of where the assignment
    // happened to sit.
    attachFimActivity(this.fimActivity);

    this.disposable = vscode.Disposable.from(
      ...listenerDisposables,
      ...commandDisposables,
      guardToggleSubscription,
      this.regionDecoration,
      this.locatorDecoration,
      {
        dispose: () => {
          this.disposed = true;
          this.abortInFlight();
          // CF-20-lazy: the adapter may never have been built at all (both
          // toggles stayed off for the whole registration) — `?.` rather than
          // an unconditional `.dispose()`.
          this.editTrackerInstance?.dispose();
          // BF-B's liveness idiom (`SessionController.ts`'s `disposed` re-check),
          // applied to a MODULE-level slot (now `./fimActivityRelay`'s own):
          // `detachFimActivity` clears the relay only while THIS registration
          // still owns it. Disposing a registration that a newer one already
          // replaced must not point the relay back at the no-op — that would
          // silently disarm R2 for the shell that is actually live.
          detachFimActivity(this.fimActivity);
        },
      },
    );

    context.subscriptions.push(this.disposable);
  }

  /** GATE 2's predicate, and the same one the post-round-trip freshness
   *  re-check uses — one definition so the two can never drift apart. */
  private fimBusy(): boolean {
    return this.fim.visible || this.fim.inFlightCount > 0;
  }

  private ensureEditTracker(): EditTrackerAdapter {
    if (this.editTrackerInstance === null) {
      this.editTrackerInstance = createEditTrackerAdapter();
    }
    return this.editTrackerInstance;
  }

  private buildEditTrackerOnToggleOn(toggles: ToggleState): void {
    if (resolveNextEditMode(toggles.next, toggles.generic) !== 'off') {
      this.ensureEditTracker();
    }
  }

  private surfaceOnce(key: string, message: string): void {
    if (this.surfacedFailures.has(key)) return;
    this.surfacedFailures.add(key);
    this.deps.reportFailure(message);
    void vscode.window.showWarningMessage(message);
  }

  /**
   * CA-06-NE-face — the ONE way the egress observer is ever invoked. Never
   * throws: a broken notice surface must not abort a healthy request on the
   * allow path, and must not disturb a block path. Decided-then-notified at
   * every call site.
   */
  private notifyEgress(filepath: string, verdict: NextEditEgressVerdict): void {
    const observer = this.deps.onEgressVerdict;
    if (observer === undefined) return;
    try {
      observer(filepath, verdict);
    } catch {
      // Observational only — swallow. See the design's §7(a).
    }
  }

  private editorFor(uri: string): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    return active !== undefined && active.document.uri.toString() === uri ? active : undefined;
  }

  private currentProposal(): AnchoredProposal | null {
    return this.state.kind === 'idle' ? null : this.state.p;
  }

  private dispatch(event: NextEditFsmEvent): void {
    if (this.disposed) return;
    // BHF-F3-15: snapshot pre-reduce — `trackedVersion` is the version the
    // live proposal's coordinates are valid FOR (advanced on every
    // successful reanchor), `region.content` the bytes being replaced.
    const proposal = this.currentProposal();
    this.pendingApplyExpectation =
      proposal !== null && this.trackedVersion !== null
        ? { docVersion: this.trackedVersion, baseText: proposal.region.content }
        : null;
    const next = reduceNextEdit(this.state, event);
    this.state = next.state;
    if (this.state.kind === 'idle') {
      this.trackedVersion = null;
    }
    this.executor.run(next.effects);
  }

  /**
   * F-4 — classify ONE trigger failure into a message the user can act on, or
   * into deliberate silence. WS-F3 F3-7 (FI-13): the classification AND the
   * byte-exact copy now live in the pure `describeTriggerFailure`
   * (`nextEditFailureSurface.ts`, which itself defers the actual error→`kind`
   * decision to the shared `classifyBackendFailure`, `../failureClass`) —
   * this method shrinks to a thin caller that keeps ONLY the two
   * side-effecting things a pure function cannot own: the `surfaceOnce`
   * toast + its dedup Set, and the mint path's separate log-only dedup
   * (same `surfacedFailures` Set, no toast). Reproduces BOTH paths exactly:
   * a `'toast'` channel goes through `surfaceOnce` (dedup + `reportFailure` +
   * `showWarningMessage`); a `'log'` channel (mint only) dedups against the
   * SAME Set but calls only `reportFailure`, never the toast.
   */
  private surfaceTriggerFailure(err: unknown, route: NextEditRoute, mode: NextEditMode): void {
    const { key, message, channel } = describeTriggerFailure(err, route, mode);
    if (channel === 'toast') {
      this.surfaceOnce(key, message);
      return;
    }
    if (!this.surfacedFailures.has(key)) {
      this.surfacedFailures.add(key);
      this.deps.reportFailure(message);
    }
  }

  private abortInFlight(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }

  // ── the ONE trigger path ─────────────────────────────────────────────────

  /**
   * The gates run IN ORDER — this is a sequence, not a set. A later gate is
   * never reachable when an earlier one would have stopped the trigger, which
   * is what keeps the cheapest and most security-relevant checks (is the
   * capability even on? is FIM busy?) ahead of anything that touches the
   * document.
   */
  private async trigger(): Promise<void> {
    // GATE 1 — mode. The Guard is the ONLY authority; nothing here reads the
    // store or a config boolean (there is none).
    const mode = this.guard.getMode();
    if (mode !== 'next' && mode !== 'generic') return;

    // GATE 2 — R2: FIM idle. Next-edit may not even BUILD a request while FIM
    // has ghost text on screen OR a request in flight.
    if (this.fimBusy()) return;

    // GATE 2b (F-2) — next-edit's OWN surface is idle. R2's shape applied to
    // this feature's own decorations: do not even BUILD a request while a
    // proposal is displayed.
    //
    // Why this and not "model `proposed × proposalReady` as a replacement in
    // the FSM": T10's reducer treats every unmodeled combination as
    // `idle + clearAll` (`08` §7.6 — a SAFE DEFAULT, not a designed
    // behaviour), and `08` specifies no replacement semantics anywhere. So a
    // proposal on screen plus a debounced edit destroyed BOTH — the live
    // proposal AND the fresh one that had just been paid for. Gating here
    // leaves the displayed proposal to be re-anchored by `docChanged` (which
    // is what `remapRange` is for) and skips a wasted round trip; the FSM's
    // reviewed pure core is left exactly as T10 shipped it.
    //
    // A gate, not a stop: `esc`, an overlapping edit, a focus loss, an editor
    // switch and an accept all return the state to `idle`, and the very next
    // edit burst triggers normally.
    if (this.state.kind !== 'idle') return;

    // NOT a gate — the two steps the gate sequence is INTERRUPTED by, named
    // explicitly because the brief pins the order mode → FIM → trust →
    // scheme → secret and this sits between gates 2 and 3.
    //
    // Why it is safe HERE rather than after GATE 5: neither step reads a
    // single byte of the document. The editor lookup only resolves WHICH
    // document is current (its content is read further down, after every
    // gate has passed), and `resolveRoute` reads configuration only —
    // endpoint/model/backend, and (W5.2 Task 2) the FIM key for the generic
    // branch — never `document`. Reading the key here is not egress: it is
    // copied into a local route object, and the single construction site that
    // hands it to a backend still sits strictly BELOW the trust gate, where it
    // has always been. Nothing security-relevant
    // can therefore happen ahead of the trust, scheme or secret gates; both
    // are pure "is there anything to do at all?" checks, and doing them
    // early only means bailing out sooner. Do NOT add a step here that
    // touches the document — that belongs below GATE 5.
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) return;
    const document = editor.document;

    const route = this.resolveReportedRoute(mode);
    if (route === null) return;

    // GATE 3 — trust. Read unconditionally (not short-circuited behind
    // `route.remote`) so reaching this gate is observable.
    const trusted = vscode.workspace.isTrusted;
    if (route.remote && !trusted) return;

    // GATE 4 — scheme filter, mirroring `provider.ts`.
    if (!isTriggerableScheme(document.uri.scheme)) return;

    // GATE 5 — secret-path skip, FIM parity (`08` §9.3). Secret-scan is NOT
    // inherited: this is the ACTIVE-FILE gate, and the request-level mint
    // below is the separate content-level backstop.
    const fsPathLike = (document.uri.path ?? document.uri.fsPath ?? '').replace(/\\/g, '/');
    if (isSecretForCompletion(fsPathLike)) {
      // CA-06-NE-face: tell the notice surface WHY nothing will ever happen
      // in this file. Decided-then-notified: the return below is
      // unconditional and unchanged.
      this.notifyEgress(document.uri.toString(), 'path-block');
      return;
    }

    const built = this.buildRequest(editor, document, route);
    if (built === null) return;
    await this.runPrediction(document, route, mode, built.request, built.rendered);
  }

  /**
   * `resolveRoute` + the F-5/C-5 surfacing arms + the B.2 remote
   * observation — moved verbatim from between GATE 2b and GATE 3. Returns
   * null when nothing routable.
   */
  private resolveReportedRoute(mode: NextEditMode): NextEditRoute | null {
    // F-5 / C-5 — a route that cannot be built is REPORTED (once) when the
    // user can do something about it, instead of returning into silence while
    // the panel row still reads as if the source were running.
    const resolution = resolveRoute(mode, this.deps);
    if (resolution.kind === 'next-model-unset') {
      this.surfaceOnce('next-model-unset', NEXT_EDIT_MODEL_UNSET_NOTE);
      return null;
    }
    if (resolution.kind === 'generic-unsupported-backend') {
      this.surfaceOnce(
        `generic-unsupported-backend|${resolution.fimBackend}`,
        genericUnsupportedBackendMessage(resolution.fimBackend),
      );
      return null;
    }
    if (resolution.kind !== 'route') return null;
    const route = resolution.route;

    // B.2 tripwire. NEXT deliberately has NO credential (ADR-014): the shipped
    // matrix is a local GGUF import on a loopback endpoint, so there is nothing
    // to authenticate to. The one observation that would reopen that decision
    // is a NEXT route pointing off-box — and `remote` is ALREADY computed, so
    // reporting it costs one line and turns a speculative question into an
    // observed event. This is an observation, not a warning: it does not gate,
    // block, or refuse anything.
    if (mode === 'next' && route.remote) {
      this.surfaceOnce(
        'next-remote-endpoint',
        'Next Edit is using a REMOTE endpoint for its dedicated model (talaria.nextEdit.endpoint). ' +
          'Next Edit sends no credential of its own. If this endpoint requires authentication, say so — ' +
          'it would need its own key, never the autocomplete key.',
      );
    }

    return route;
  }

  /**
   * The request-assembly block — everything from `const cursor =
   * editor.selection.active;` through `const renderResult = …` /
   * `renderResult.kind === 'skip'` — verbatim.
   */
  private buildRequest(
    editor: vscode.TextEditor,
    document: vscode.TextDocument,
    route: NextEditRoute,
  ): { request: NextEditRequest; rendered: RenderedNextEditPrompt } | null {
    const cursor = editor.selection.active;
    const uri = document.uri.toString();
    const span = regionAroundCursor(cursor.line, document.lineCount, route.format.windowLines);
    const regionEndLength = document.lineAt(span.endLine).text.length;
    const regionContent = document.getText(
      new vscode.Range(span.startLine, 0, span.endLine, regionEndLength),
    );
    const docText = document.getText();
    const preEditDocText = this.ensureEditTracker().getPreEditText(uri) ?? null;
    // C-3 / ADR-018 — `preEditRegion` is extracted from the FULL pre-edit
    // text, BEFORE windowing. The region and the doc-level window are
    // independent (exactly as in the vendor script: `block` is ±10 lines,
    // `initial_file` is ±150 — two separate slots, not one derived from the
    // other), so this must not move below the V-1 windowing step.
    const preEditRegion =
      preEditDocText === null ? null : extractRegionRange(preEditDocText, span.startLine, span.endLine);
    // V-1 fix — bound the doc-level context to a SCANNED window around the
    // cursor (vendor-conformant ±150 lines, `fileWindow.ts`) instead of the
    // whole file. This happens strictly BEFORE `mintScannedNextEditRequest`
    // below: the mint itself, and every field it scans, is UNCHANGED — this
    // only shrinks WHAT the fields carry, never WHO scans them.
    // `windowAroundCursor` clamps `cursorLine` internally, so the same
    // `cursor.line` (a CURRENT-document coordinate) is safe to pass for the
    // pre-edit shadow too, even though that text may have a different line
    // count.
    const docWindow = windowAroundCursor(docText, cursor.line, DEFAULT_FILE_WINDOW_OPTIONS);
    const preEditWindow =
      preEditDocText === null ? null : windowAroundCursor(preEditDocText, cursor.line, DEFAULT_FILE_WINDOW_OPTIONS);
    // F-3 — the ring is cross-document, so it is filtered HERE, before the
    // mint ever sees it. `changesAboveCursor` reads the same kept list, so the
    // structural heuristic and the egressing payload describe one history.
    const diffs = filterEgressableDiffs(this.ensureEditTracker().tracker.getRecentDiffs(), route.format.sentinels);
    const docVersion = document.version;

    const region: EditableRegion = {
      uri,
      filepath: toWorkspaceRelativePosixPath(document.uri),
      startLine: span.startLine,
      endLine: span.endLine,
      content: regionContent,
    };

    const request: NextEditRequest = {
      model: route.model,
      cursor: { uri, line: cursor.line, character: cursor.character },
      region,
      preEditRegion,
      fileContext: ensureTrailingNewline(docWindow.text),
      docText: docWindow.text,
      preEditDocText: preEditWindow?.text ?? null,
      changesAboveCursor: computeChangesAboveCursor(diffs, uri, cursor.line),
      diffs,
      docVersion,
    };

    const renderResult = route.format.render(request);
    if (renderResult.kind === 'skip') return null;
    return { request, rendered: renderResult.prompt };
  }

  /**
   * The round trip — from `const controller = new AbortController();`
   * through the whole try/catch/finally — verbatim. The freshness
   * re-checks read `request.docVersion` / `request.cursor.uri` /
   * `request.cursor.line` (the same values the old locals held — the
   * request already carries all three).
   */
  private async runPrediction(
    document: vscode.TextDocument,
    route: NextEditRoute,
    mode: NextEditMode,
    request: NextEditRequest,
    rendered: RenderedNextEditPrompt,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortInFlight();
    this.inFlight = controller;

    try {
      // The brand comes from CALLING the one sanctioned mint — it throws
      // fail-closed (ruleId only, never the matched text) if any egressing
      // content field carries a secret or a format sentinel.
      const scanned = mintScannedNextEditRequest(request, route.format.sentinels);

      // CA-06-NE-face: the content verdict for this attempt is ALLOW — the
      // mint ratified every egressing field. An earlier block's badge clears
      // on this edge. Guarded: a throwing observer cannot abort the request.
      this.notifyEgress(request.cursor.uri, 'allow');

      const backend = new NextEditHttpBackend({
        transport: route.transport,
        apiBase: route.apiBase,
        model: route.model,
        sentinels: route.format.sentinels,
        // FI-26 (F10-2b): the shell's own STABLE field — constructed once
        // per activation and shared across every prediction attempt — never
        // a fresh `new OnceRegistry()` here (this call runs once per
        // prediction; a fresh instance each time would reset dedup on every
        // attempt instead of warning once per activation).
        registry: this.onceRegistry,
        // Absent for the NEXT branch, by construction (see NextEditRoute).
        ...(route.apiKey !== undefined ? { apiKey: route.apiKey } : {}),
      });

      const output = await backend.predict(scanned, rendered, controller.signal);
      if (controller.signal.aborted || this.disposed) return;

      // CONTRACT (`formats/*`): `parse` trusts that `rendered` and `request`
      // are a MATCHED pair — it cannot detect a mismatch. Both locals below
      // come from this one call, and nothing reassigns them.
      const verdict = route.format.parse(output, rendered, request);
      if (verdict.kind !== 'rewrite') return;

      // Freshness re-check: the document must not have moved under the
      // request, and FIM must STILL be idle (R2 covers the whole round trip,
      // not just its start).
      if (document.version !== request.docVersion) return;
      if (this.fimBusy()) return;
      // F-1 — IDENTITY re-check, the third freshness dimension. `version` only
      // answers "did THIS document change?"; it says nothing about whether the
      // user is still looking at it. Switching files mid-round-trip moves
      // neither the version nor `fimBusy()`, so without this the proposal
      // lands for a document that is no longer on screen: `jumpVisible` goes
      // up with zero decorations anywhere and Tab is hijacked in the file the
      // user actually has open. Same `editorFor` predicate the paint uses.
      if (this.editorFor(request.cursor.uri) === undefined) return;

      this.trackedVersion = request.docVersion;
      this.dispatch({
        kind: 'proposalReady',
        p: {
          region: verdict.region,
          newText: verdict.newText,
          docVersion: request.docVersion,
          cursorLine: request.cursor.line,
        },
      });
    } catch (err) {
      // Aborts are the common case here and are not failures: R2 aborts every
      // in-flight prediction the moment FIM starts, and each new trigger
      // aborts its predecessor. Those must stay silent.
      if (controller.signal.aborted || this.disposed) return;
      // F-4 — everything else is surfaced ONCE and actionably (`08` §9.3).
      // The old bare catch swallowed all of it, so a CWE-319 refusal, a wrong
      // endpoint or a 404-ing model left next-edit dead for the whole session
      // with no signal anywhere. A toast per keystroke would indeed be worse
      // than a missing suggestion, which is exactly what `surfaceOnce` is for.
      //
      // CA-06-NE-face: a mint rejection is the content-block verdict for
      // this file — the badge + one-shot toast render it (rule-id-free);
      // surfaceTriggerFailure below keeps only the technical log line.
      if (err instanceof NextEditMintRejectionError) {
        this.notifyEgress(request.cursor.uri, 'content-block');
      }
      this.surfaceTriggerFailure(err, route, mode);
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = null;
      }
    }
  }

  private armTrigger(): void {
    void this.debouncer.delayAndShouldDebounce(TRIGGER_DEBOUNCE_MS).then(
      (superseded) => {
        if (superseded || this.disposed) return undefined;
        return this.trigger();
      },
      () => undefined,
    );
  }
}

/**
 * Wires next-edit into VS Code. Called from `index.ts` beside
 * `registerTalariaAutocomplete`, with a Guard already hydrated from the
 * `talaria.nextEdit.source` config port (Task 2 §5.5).
 */
export function registerTalariaNextEdit(
  context: vscode.ExtensionContext,
  guard: NextEditGuard,
  deps: NextEditShellDeps,
): vscode.Disposable {
  return new NextEditShell(context, guard, deps).disposable;
}
