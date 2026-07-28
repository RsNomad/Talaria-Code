/**
 * W3 (LIB) · T4 — the pure, hard-allowlisted set of VS Code `executeCommand`
 * IDs the LIB gateway (`lspGateway.ts`) is permitted to invoke, plus the
 * fail-closed guard that enforces it. This is the security core of the read
 * surface (research doc §5.3): every `executeCommand` call LIB ever makes
 * MUST route through {@link assertAllowlistedCommand} first — the static
 * invariant-lock test (`lspInvariant.test.ts`) mechanically pins this set to
 * exactly the 6 IDs below (T8 added the 6th, `executeCodeActionProvider`).
 * That test is a CI tripwire that catches accidental or obvious
 * reintroduction of a mutation call or a non-gateway `executeCommand` — it
 * is a plain text scan, not a proof; the actual runtime guarantee is this
 * file's allowlist guard plus the fact LIB only ever exposes read verbs.
 *
 * NO `vscode` import here — headless, unit-testable build-blind
 * (`lspCommandAllowlist.test.ts`).
 *
 * Grounded via Context7 at write-time (`/microsoft/vscode-docs`,
 * `api/references/commands.md`, cross-checked against the raw doc source on
 * GitHub) — the 5 read-tool command-ID strings below match research doc
 * §5.1's table verbatim (T4's own independent verification). T8's addition,
 * `vscode.executeCodeActionProvider`, is separately Context7/GitHub-source
 * grounded at T8b write-time (`lspGateway.ts`'s own doc comment carries that
 * note) — its documented parameters are `uri, rangeOrSelection, kind?,
 * itemResolveCount?`, returning `(CodeAction | Command)[]`.
 * `vscode.languages.getDiagnostics` is a direct API call, not an
 * `executeCommand` ID, so it is intentionally NOT a member of this set — the
 * gateway calls it directly. The DIFFERENT, per-item, command-execution-
 * capable resolve API this codebase permanently bans (see `lspGateway.ts`'s
 * own doc comment and `lspInvariant.test.ts`'s dedicated ban pattern) is
 * intentionally, permanently NOT a member: T8's resolution need is served
 * entirely by `executeCodeActionProvider`'s own `itemResolveCount` argument,
 * which fills in `.edit` (and, as data, `.command`) on the query itself —
 * never a separate resolve-then-run pathway.
 */

export const LSP_READ_COMMANDS: ReadonlySet<string> = new Set([
  'vscode.executeDefinitionProvider',
  'vscode.executeReferenceProvider',
  'vscode.executeDocumentSymbolProvider',
  'vscode.executeWorkspaceSymbolProvider',
  'vscode.executeHoverProvider',
  'vscode.executeCodeActionProvider',
]);

/**
 * Fail-closed guard: throws a plain {@link Error} naming the offending id
 * when `id` is not one of the 6 allowlisted command IDs above. The gateway's
 * private `run<T>` calls this FIRST, before `vscode.commands.executeCommand`,
 * so no caller can ever reach a non-allowlisted VS Code command through
 * LIB — mutate or otherwise. No silent skip: an unlisted id always throws,
 * never returns.
 */
export function assertAllowlistedCommand(id: string): void {
  if (!LSP_READ_COMMANDS.has(id)) {
    throw new Error(`lspGateway: command not allowlisted: ${id}`);
  }
}
