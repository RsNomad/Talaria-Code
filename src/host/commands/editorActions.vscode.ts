/**
 * W2 T3 — F-A code actions (§3.3): the impure command handlers behind the
 * `editor/context` "Hermes" submenu (Add/Explain/Improve with Hermes) and the
 * `hermes.fixWithHermes` command the QuickFix action
 * (`HermesCodeActionProvider.ts`) binds to. This is the ONLY `vscode`
 * importer in `src/host/commands/` — mirrors `context/ports.vscode.ts`'s
 * split (pure logic in `editorActions.ts`, the `vscode`-touching shell
 * here), so `buildSeed`/`flattenDiagnosticsForFix` stay headlessly testable.
 *
 * SECURITY / HARD CONSTRAINT (doc §3.3, non-negotiable): every handler below
 * is a prompt SEEDER — it snapshots the editor, builds a plain
 * `composer.seed` payload via the pure `buildSeed`, and hands it to
 * `provider.seedComposer`. NONE of them ever construct or apply a
 * `vscode.WorkspaceEdit`; a resulting agent edit hits the unchanged
 * `handleRequestPermission` -> `evaluateEditPolicy` gate, same as any other
 * agent-proposed edit. Build-blind (compile-checked + Fedora-verified) —
 * deliberately thin: snapshot -> secret gate -> `buildSeed` -> `seedComposer`.
 */
import * as vscode from 'vscode';

import type { LineRange } from '../../shared/protocol';
import { isSecretForCompletion } from '../backend/policy/editPolicy';
import {
  buildSeed,
  flattenDiagnosticsForFix,
  type EditorActionIntent,
  type FlatDiagnostic,
  type SeedTarget,
} from './editorActions';

/** `Uri.path` is already POSIX (forward-slash) per the URI spec; the
 * `.replace` is defensive parity with `autocomplete/provider.ts`'s identical
 * secret-path normalization for a Windows dev box (`document.uri.fsPath`
 * would otherwise carry backslashes there — production target is Fedora). */
function posixPath(uri: vscode.Uri): string {
  return (uri.path || uri.fsPath || '').replace(/\\/g, '/');
}

interface EditorSnapshot {
  path: string;
  languageId: string;
  code: string;
  range: LineRange;
}

/**
 * Snapshot the given editor's selection SYNCHRONOUSLY (doc §5.6: capture
 * before any `await` — there is none here, but this is the single place that
 * reads `editor.selection`/`editor.document`, so a future `await` inserted
 * elsewhere can never race it). An empty selection (reachable only via the
 * QuickFix path — the submenu items are `when: editorHasSelection`) widens
 * to the full line under the caret so `code` is never empty.
 */
function snapshotSelection(editor: vscode.TextEditor): EditorSnapshot {
  const { document, selection } = editor;
  const useRange: vscode.Range = selection.isEmpty
    ? document.lineAt(selection.active.line).range
    : selection;
  return {
    path: posixPath(document.uri),
    languageId: document.languageId,
    code: document.getText(useRange),
    range: { startLine: useRange.start.line + 1, endLine: useRange.end.line + 1 },
  };
}

/**
 * The secret floor (doc §3.3 "Gating & safety"): hard-block with a warning
 * notification when the active document's path is
 * `isSecretForCompletion`-classified — fail-closed, consistent with the
 * autocomplete gate. The user can still paste the content manually (a
 * deliberate human act); this file never reads/sends it on their behalf.
 */
function runSeedAction(
  intent: EditorActionIntent,
  provider: SeedTarget,
  diagnostics: readonly FlatDiagnostic[] = [],
): void {
  const editor = vscode.window.activeTextEditor; // snapshot FIRST (§5.6)
  if (!editor) return;

  const snapshot = snapshotSelection(editor);
  if (isSecretForCompletion(snapshot.path)) {
    void vscode.window.showWarningMessage(
      `Hermes: "${snapshot.path}" looks like a secret file — refusing to send its contents. Paste it manually if you really need to.`,
    );
    return;
  }

  const problems =
    intent === 'fix'
      ? flattenDiagnosticsForFix(
          snapshot.path,
          diagnostics,
          vscode.DiagnosticSeverity.Error,
          vscode.DiagnosticSeverity.Warning,
        )
      : '';

  const seed = buildSeed({
    intent,
    path: snapshot.path,
    languageId: snapshot.languageId,
    code: snapshot.code,
    range: snapshot.range,
    problems,
  });
  provider.seedComposer(seed);
}

export function addToHermes(provider: SeedTarget): void {
  runSeedAction('add', provider);
}

export function explainWithHermes(provider: SeedTarget): void {
  runSeedAction('explain', provider);
}

export function improveWithHermes(provider: SeedTarget): void {
  runSeedAction('improve', provider);
}

/**
 * Bound to the `hermes.fixWithHermes` command `HermesCodeActionProvider`'s
 * "Fix with Hermes" QuickFix carries (`command.arguments`) — `diagnostics`
 * are the SAME `context.diagnostics` VS Code handed the provider for the
 * range that produced the lightbulb, so the seeded "Problems:" section is
 * exactly what triggered the action (more precise than re-querying
 * `languages.getDiagnostics` at invocation time).
 */
export function fixWithHermes(provider: SeedTarget, diagnostics: readonly vscode.Diagnostic[] = []): void {
  const flat: FlatDiagnostic[] = diagnostics.map((d) => ({
    severity: d.severity,
    line: d.range.start.line,
    message: d.message,
    source: d.source,
  }));
  runSeedAction('fix', provider, flat);
}

/**
 * Register the four commands (self-registering module pattern, matching
 * `registerHermesAutocomplete`) — the ONLY thing `extension.ts` calls to
 * wire this file in.
 */
export function registerEditorActions(context: vscode.ExtensionContext, provider: SeedTarget): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hermes.addToHermes', () => addToHermes(provider)),
    vscode.commands.registerCommand('hermes.explainWithHermes', () => explainWithHermes(provider)),
    vscode.commands.registerCommand('hermes.improveWithHermes', () => improveWithHermes(provider)),
    vscode.commands.registerCommand(
      'hermes.fixWithHermes',
      (diagnostics?: vscode.Diagnostic[]) => fixWithHermes(provider, diagnostics ?? []),
    ),
  );
}
