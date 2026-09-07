/**
 * nextedit/nextEditShellWiring.ts — WS-F3 F3-8 (FI-07): the ctor's three
 * wiring blocks moved out of `shell.vscode.ts` VERBATIM (bodies + doc
 * comments), the LAST leaf of the `text/route/egress/executor/relay/
 * failureSurface/wiring` module map (ADR-FSU-08, recorded at the end of
 * ADR-025-I).
 *
 * UNLIKE every other WS-F3 leaf, this module IS a `vscode` adapter: it calls
 * `vscode.workspace.onDidChangeTextDocument`, `vscode.window.
 * onDidChangeActiveTextEditor`, `vscode.window.onDidChangeWindowState`, and
 * `vscode.commands.registerCommand` directly, because the blocks it hosts
 * genuinely wire vscode events/commands to the shell's FSM. It is therefore
 * ADDED to `nextEditPurity.test.ts`'s `ADAPTER_ALLOW` (4 → 5 files).
 *
 * `ShellHostSeams` is the NARROW port these three builders close over —
 * derived by reading exactly what each moved block references on `this`,
 * nothing wider. `fim` is passed as the SAME mutable object the shell holds
 * (object-reference sharing, no copy — mutating `seams.fim.x` mutates the
 * shell's own field), so no accessor is needed for it. `trackedVersion` is a
 * bare primitive field on the shell, so it is exposed as a get/set ACCESSOR
 * PROPERTY (not two named methods) precisely so every block body's
 * `this.trackedVersion` becomes `seams.trackedVersion` — a literal
 * `this.` → `seams.` rename, not a reshaping into method calls.
 *
 * `shell.vscode.ts` constructs one `ShellHostSeams` object (an explicit seam
 * object, never `this` itself — `NextEditShell`'s `fim`/`dispatch`/
 * `armTrigger`/`abortInFlight`/`currentProposal` are `private`, and passing
 * `this` structurally into a public interface that names a private member
 * does not type-check under `strict`) and passes it to all three builders,
 * then collects their returned disposables into the same composite
 * `vscode.Disposable.from(...)` it always built, in the SAME order.
 */
import * as vscode from 'vscode';
import { isRecordableScheme } from '../context/recordableScheme';
import type { FimActivityListener } from '../provider';
import { remapRange } from './anchors';
import { fimActivityRelay } from './fimActivityRelay';
import { toContentChangeLites } from './nextEditEgress';
import type { AnchoredProposal, NextEditFsmEvent } from './types';

/**
 * The command VS Code executes when the user ACCEPTS FIM ghost text — the R4
 * seam. Registered exactly once, by `registerCommands` below, and advertised
 * to `provider.ts` through `acceptCommandId()` ONLY by the registration that
 * registered it. `provider.ts` never names this string: an item can
 * therefore not carry a command id that nothing has registered.
 *
 * WS-F3 F3-8 (FI-07): moved here, unchanged, from `shell.vscode.ts` — both of
 * its two use sites (`buildFimActivity`'s `acceptCommandId` and
 * `registerCommands`'s fourth registration) moved into this module in the
 * same commit, so the constant moves with them. It is module-private here
 * exactly as it was in the shell: nothing outside this file's own two
 * builders ever names it.
 */
const FIM_ACCEPT_COMMAND = 'talaria.nextEdit.onFimAccept';

/**
 * The exact set of shell fields/methods the three builders below close over
 * — derived by reading each moved block's body, not the whole class.
 *
 *  - `fim`: `buildFimActivity` reads/writes `.visible`/`.inFlightCount`;
 *    `registerListeners`'s active-editor listener writes `.visible`.
 *  - `trackedVersion`: `registerListeners`'s doc-change listener reads and
 *    writes it (the freshness token for the live proposal's coordinates).
 *  - `dispatch`/`armTrigger`/`abortInFlight`/`currentProposal`: called by one
 *    or more of the three blocks, exactly as they called `this.X` before.
 */
export interface ShellHostSeams {
  readonly fim: { visible: boolean; inFlightCount: number };
  trackedVersion: number | null;
  dispatch(event: NextEditFsmEvent): void;
  armTrigger(): void;
  abortInFlight(): void;
  currentProposal(): AnchoredProposal | null;
}

/**
 * `buildFimActivity` — the shell's former `this.fimActivity = {...}` object
 * literal, moved VERBATIM (every `this.X` → `seams.X`).
 */
export function buildFimActivity(seams: ShellHostSeams): FimActivityListener {
  return {
    requestStarted: () => {
      seams.fim.inFlightCount += 1;
      try {
        // R2, the direction that matters: FIM-start aborts next-edit. Never
        // the reverse — nothing in this module can cancel a FIM request.
        seams.abortInFlight();
        seams.dispatch({ kind: 'fimVisibility', visible: true });
      } catch {
        // Must not escape this call: `provider.ts` sets its own
        // `fimRequested` flag only AFTER `requestStarted()` returns, and
        // only a set flag makes its `finally` call the paired
        // `resultShown` later. A throw here (e.g. `dispatch()` reaching a
        // throwing host) would skip that flag and strand the increment
        // above forever — unlike the boolean this refcount replaced, it
        // does not self-heal on the next FIM cycle. The count's integrity
        // matters more than reporting whatever failed downstream.
      }
    },
    resultShown: (hasItem: boolean) => {
      if (seams.fim.inFlightCount === 0) {
        // UNPAIRED settle: a settle whose `requestStarted` was delivered to
        // a PREVIOUS registration (the relay swapped while that request was
        // in flight), or a stray duplicate — either way nothing of ours is
        // outstanding to count out. Complete no-op: touching `visible` here
        // could silently clear a GENUINELY visible ghost-text flag set by a
        // real, unrelated request, reopening GATE 2 against R2.
        return;
      }
      seams.fim.inFlightCount -= 1;
      // SUPERSEDED settle — a NEWER FIM request is still in flight, so this
      // result speaks for a request VS Code has already cancelled and whose
      // item it discarded. It may not report on visibility at all: the
      // newest request is the one that gets to settle that, and until it
      // does the refcount above holds GATE 2 closed on its own. Treating a
      // stale settle as authoritative is what let a boolean `visible` be
      // cleared out from under a live FIM request.
      if (seams.fim.inFlightCount > 0) return;
      // Conservative visibility: a non-null item COUNTS as on screen, even
      // though VS Code may still decline to render it.
      seams.fim.visible = hasItem;
      seams.dispatch({ kind: 'fimVisibility', visible: hasItem });
    },
    accepted: () => {
      // The ghost text was consumed, so FIM is no longer on screen — and this
      // is the R4 seam: the post-FIM-accept moment is exactly when a next
      // edit is most likely to exist.
      //
      // The refcount is deliberately NOT zeroed here. `provider.ts` pairs
      // every `requestStarted` with a `resultShown` in its own `finally`, so
      // the request that produced this accepted item has already been counted
      // out; any count still standing belongs to a LATER request that is
      // genuinely in flight. Zeroing it would discard that and reopen GATE 2
      // against R2 — the armed trigger below simply waits for it instead.
      seams.fim.visible = false;
      seams.dispatch({ kind: 'fimVisibility', visible: false });
      seams.armTrigger();
    },
    // Safe to answer unconditionally: this object only ever reaches the relay
    // AFTER the command below is registered (see the attach site in
    // `shell.vscode.ts`'s ctor) and it leaves the relay when this
    // registration disposes.
    acceptCommandId: () => FIM_ACCEPT_COMMAND,
  };
}

/**
 * `registerListeners` — the ctor's `onDidChangeTextDocument` +
 * `onDidChangeActiveTextEditor` + `onDidChangeWindowState` subscriptions,
 * moved VERBATIM (every `this.X` → `seams.X`). Returns the disposables the
 * ctor used to collect directly.
 */
export function registerListeners(seams: ShellHostSeams): vscode.Disposable[] {
  const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
    // CF-19 — GATE-4 parity: a non-recordable scheme (Output/SCM/etc.) must
    // not arm anything at all. Before this guard, `armTrigger()` ran
    // unconditionally on EVERY `onDidChangeTextDocument` event regardless of
    // which document changed, so edit-burst noise from an unrelated
    // Output/SCM document could arm (and eventually fire) a next-edit
    // request against the CURRENT active editor — a document GATE-4 would
    // separately have to be scheme-valid on its own, but the arm itself
    // never checked the document that actually changed.
    if (!isRecordableScheme(e.document.uri.scheme)) return;

    // Source 2 of the ONE trigger path: the debounced edit burst. Armed
    // unconditionally (once past the scheme guard above) — `trigger()`
    // itself resolves which editor/document is current, so no editor lookup
    // is needed (or wanted) this early.
    seams.armTrigger();

    const proposal = seams.currentProposal();
    if (proposal === null || proposal.region.uri !== e.document.uri.toString()) return;

    if (e.contentChanges.length === 0) {
      // A metadata-only event (dirty-flag, EOL, save) still bumps `version`.
      // Nothing textual moved, so re-baseline instead of dismissing.
      seams.trackedVersion = e.document.version;
      return;
    }

    if (seams.trackedVersion === null || e.document.version !== seams.trackedVersion + 1) {
      // Versions skipped ⇒ at least one change event never reached us, so the
      // changes in hand cannot describe the full delta. Fail closed.
      seams.dispatch({ kind: 'docChanged', remapped: null });
      return;
    }

    const remapped = remapRange(
      { startLine: proposal.region.startLine, endLine: proposal.region.endLine },
      toContentChangeLites(e.contentChanges),
    );
    seams.trackedVersion = e.document.version;
    seams.dispatch({ kind: 'docChanged', remapped });
  });

  const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
    // C-6 — the one clearer `fim.visible` can safely have. Esc on ghost text
    // is unobservable on the stable API, so nothing but the NEXT FIM request
    // settling ever lowered this flag; disable FIM in between and GATE 2 stays
    // shut for the rest of the session with no ghost text on screen at all.
    //
    // Why THIS event and not `onDidChangeTextDocument`: an inline suggestion
    // is painted into ONE editor and cannot outlive it being switched away
    // from, so clearing here cannot let next-edit build against ghost text
    // that is genuinely on screen. A document change would be the wrong
    // signal — the ordinary keystroke path fires it BEFORE FIM's provider is
    // invoked, so it would reopen the gate in exactly the window R2 exists to
    // close.
    //
    // `inFlightCount` is deliberately NOT touched: a FIM request in flight
    // survives an editor switch, and it alone must keep the gate shut.
    seams.fim.visible = false;
    seams.dispatch({ kind: 'editorChanged' });
  });

  const windowStateSubscription = vscode.window.onDidChangeWindowState((windowState) => {
    if (!windowState.focused) {
      seams.dispatch({ kind: 'focusLost' });
    }
  });

  return [changeSubscription, activeEditorSubscription, windowStateSubscription];
}

/**
 * `registerCommands` — the ctor's four `vscode.commands.registerCommand`
 * calls (registered ONCE), moved VERBATIM (every `this.X` → `seams.X`).
 * Returns the command disposables the ctor used to collect directly.
 */
export function registerCommands(seams: ShellHostSeams): vscode.Disposable[] {
  const jumpCommand = vscode.commands.registerCommand('talaria.nextEdit.jump', () => {
    seams.dispatch({ kind: 'tabJump' });
  });
  const acceptCommand = vscode.commands.registerCommand('talaria.nextEdit.accept', () => {
    seams.dispatch({ kind: 'tabAccept' });
  });
  const dismissCommand = vscode.commands.registerCommand('talaria.nextEdit.dismiss', () => {
    seams.dispatch({ kind: 'esc' });
  });
  // The R4 seam: fired by the InlineCompletionItem's own `command`, which VS
  // Code executes when the user ACCEPTS the FIM ghost text.
  const onFimAcceptCommand = vscode.commands.registerCommand(FIM_ACCEPT_COMMAND, () => {
    fimActivityRelay.accepted();
  });

  return [jumpCommand, acceptCommand, dismissCommand, onFimAcceptCommand];
}
