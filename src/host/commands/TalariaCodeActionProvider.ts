/**
 * W2 T3 — F-A code actions (§3.3): the ONE `TalariaCodeActionProvider`,
 * registered on `'*'` for `providedCodeActionKinds: [QuickFix]`. Returns
 * "Fix with Hermes" ONLY when `context.diagnostics.length > 0` (no
 * always-on lightbulb, doc 03 §5.1), `isPreferred: false` (never hijack the
 * LSP's own quick fix, doc 03 §5.9), no Refactor-kind abuse (§5.2), and no
 * work beyond the synchronous predicate below (§5.4 — no async work in
 * `provideCodeActions`).
 *
 * Like every editor action in this feature, the returned action is a prompt
 * SEEDER: its `command` is bound to `talaria.fixWithHermes`
 * (`editorActions.vscode.ts`), which snapshots the editor and posts
 * `composer.seed` — NEVER a `WorkspaceEdit`. `context.diagnostics` (already
 * scoped to `range` by VS Code) is forwarded as the command's argument so the
 * handler doesn't need to re-query `languages.getDiagnostics`.
 */
import * as vscode from 'vscode';

/**
 * PURE predicate behind `provideCodeActions` — offer the fix action iff the
 * range has at least one diagnostic. Extracted so the gate itself is
 * headlessly testable without a `vscode` mock beyond what this file already
 * needs.
 */
export function shouldOfferFix(diagnosticsLength: number): boolean {
  return diagnosticsLength > 0;
}

export class TalariaCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    _document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!shouldOfferFix(context.diagnostics.length)) return [];

    const action = new vscode.CodeAction('Fix with Talaria', vscode.CodeActionKind.QuickFix);
    action.isPreferred = false;
    action.command = {
      command: 'talaria.fixWithHermes',
      title: 'Fix with Talaria',
      arguments: [context.diagnostics],
    };
    return [action];
  }
}
