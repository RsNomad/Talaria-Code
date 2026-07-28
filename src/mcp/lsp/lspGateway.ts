/**
 * W3 (LIB) · T4 — `LspGateway`: the ONE place LIB is allowed to talk to VS
 * Code's command surface (research doc §5.1/§5.3). A thin, minimal binding —
 * six named read verbs plus T8's `getCodeActions`, each either a direct
 * `vscode.languages.*` API call (`getDiagnostics`, synchronous, not a
 * command) or a call through the private {@link run} helper, which routes
 * EVERY `executeCommand` through {@link assertAllowlistedCommand} FIRST,
 * before ever reaching `vscode.commands.executeCommand`. This is the seam T6
 * (`tools.ts`) injects a fake `LspGateway` for.
 *
 * RAW verb layer only — deliberately. No confinement (`resolveWithinWorkspaceReal`),
 * no `openTextDocument` warm-up, no `Promise.race` deadline, no caching, no
 * result sanitizing/shaping/framing. Those all belong to T6's handler
 * pipeline and T5's shaper (research doc §5.1's cross-cutting pipeline
 * paragraph) — adding any of them here would blur the seam the independent
 * security review checks: this file's only job is "call the allowlisted
 * command, return exactly what VS Code gave back."
 *
 * Every verb's command-ID string literal is written directly in its own
 * call below (not imported from a shared constant) so the static
 * invariant-lock test (`lspInvariant.test.ts`) can pin, by a plain text
 * scan, that this file's source references each of the 6 allowlisted IDs.
 *
 * Grounded via Context7 at write-time (`/microsoft/vscode-docs`,
 * `api/references/commands.md`) — command IDs, parameters, and return types
 * match research doc §5.1's table verbatim; see `lspCommandAllowlist.ts` for
 * the full grounding note.
 *
 * ## `getCodeActions` (W3 · T8b — the gate-bypass-trap verb)
 * Grounded at THIS write-time three ways: (1) Context7 `/microsoft/vscode`
 * search over the live source confirmed the `ApiCommand` registration in
 * `extHostApiCommands.ts` — `new ApiCommand('vscode.executeCodeActionProvider',
 * '_executeCodeActionProvider', ..., [ApiCommandArgument.Uri,
 * new ApiCommandArgument('rangeOrSelection', ...), ApiCommandArgument.String
 * .with('kind', ...).optional(), ApiCommandArgument.Number.with(
 * 'itemResolveCount', 'Number of code actions to resolve (too large numbers
 * slow down code actions)').optional()]` — the exact 4-arg form used below;
 * (2) the raw `api/references/commands.md` doc entry (fetched this pass)
 * confirms the same 4 parameters and "A promise that resolves to an array of
 * Command-instances" (in practice `(CodeAction | Command)[]`, since the
 * public `ApiCommandResult` converter wraps both shapes — see the adapter's
 * own doc comment, `libToolDeps.vscode.ts`); (3) the internal
 * `_executeCodeActionProvider` handler's own per-item resolve step (also
 * fetched this pass, the extension-host `CodeActionAdapter` class) returns
 * `{edit?, command?}` as **inspectable data** — it never calls
 * `commands.executeCommand`. So `itemResolveCount=K` fills in the first K
 * actions' `.edit` (and, since v1.78, possibly `.command` as data too — the
 * v1.78 release notes: "allow lazy resolution of commands within [the
 * provider's own per-item resolve callback]") but NEVER runs anything; the
 * security property this gateway relies on — resolution never executes a
 * command — holds regardless of that v1.78 nuance, because LIB only ever
 * reads `.command !== undefined` as a boolean signal (T6b's `tools.ts`/T8a's
 * `codeActionSerialize.ts`) and never calls `vscode.commands.executeCommand`
 * on it.
 */
import * as vscode from 'vscode';

import { assertAllowlistedCommand } from './lspCommandAllowlist';

/**
 * The six named read verbs plus `getCodeActions` (T8b — research doc §5.3:
 * "`LspGateway` (T4) exposes exactly six named read verbs + `getCodeActions`
 * (T8)").
 */
export interface LspGateway {
  getDiagnostics(uri?: vscode.Uri): vscode.Diagnostic[] | [vscode.Uri, vscode.Diagnostic[]][];
  getDefinition(
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<vscode.Location[] | vscode.LocationLink[]>;
  getReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]>;
  getDocumentSymbols(
    uri: vscode.Uri,
  ): Promise<(vscode.SymbolInformation | vscode.DocumentSymbol)[]>;
  getWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]>;
  getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]>;
  /**
   * `itemResolveCount` is `K` — VS Code resolves ONLY the first `K` actions'
   * `.edit` (query-time resolution baked into `executeCodeActionProvider`
   * itself); it NEVER runs a `.command` and this file NEVER calls the
   * separate per-item resolve API (that API stays permanently banned — see
   * `lspCommandAllowlist.ts` and `lspInvariant.test.ts`'s dedicated ban
   * pattern). Raw return, no shaping — T6b/T8a own the fail-closed
   * classification.
   */
  getCodeActions(
    uri: vscode.Uri,
    range: vscode.Range,
    kind: string | undefined,
    itemResolveCount: number,
  ): Promise<vscode.CodeAction[]>;
}

/**
 * The private, hard-allowlisted `executeCommand` core. Calls
 * {@link assertAllowlistedCommand} FIRST — a non-allowlisted `commandId`
 * throws there and `vscode.commands.executeCommand` is never reached.
 * `async` so the `Thenable` VS Code's own typings return for
 * `executeCommand` unwraps into a genuine `Promise<T>` here — no `try/catch`:
 * a provider error propagates to T6's pipeline, which owns the typed
 * deadline/status handling (research doc §5.1).
 */
async function run<T>(commandId: string, ...args: unknown[]): Promise<T> {
  assertAllowlistedCommand(commandId);
  return vscode.commands.executeCommand<T>(commandId, ...args);
}

/** The real implementation, wiring each verb to its fixed, allowlisted
 * command (or, for `getDiagnostics`, the direct `languages` API). */
export function createLspGateway(): LspGateway {
  return {
    getDiagnostics(uri) {
      return uri === undefined
        ? vscode.languages.getDiagnostics()
        : vscode.languages.getDiagnostics(uri);
    },
    getDefinition(uri, position) {
      return run<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position,
      );
    },
    getReferences(uri, position) {
      return run<vscode.Location[]>('vscode.executeReferenceProvider', uri, position);
    },
    getDocumentSymbols(uri) {
      return run<(vscode.SymbolInformation | vscode.DocumentSymbol)[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
    },
    getWorkspaceSymbols(query) {
      return run<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
    },
    getHover(uri, position) {
      return run<vscode.Hover[]>('vscode.executeHoverProvider', uri, position);
    },
    getCodeActions(uri, range, kind, itemResolveCount) {
      return run<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        range,
        kind ?? 'quickfix',
        itemResolveCount,
      );
    },
  };
}
