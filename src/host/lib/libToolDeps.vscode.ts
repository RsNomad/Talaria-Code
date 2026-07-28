/**
 * W3 (LIB) · T7b (+ T8b's `getCodeActions`/`readFullText` addition, brief
 * `w3-t8b-brief.md`) — the vscode-backed `LspToolDeps` adapter (research doc
 * §5.1/§5.2/§4.5/§6, brief `w3-t7b-brief.md`). Lives OUTSIDE `src/mcp/lsp/`
 * (imports `vscode` + `node:fs` — both banned in that directory by
 * `lspInvariant.test.ts`) — this is the ONE place those two seams are wired
 * together for LIB. Composes:
 *
 *  - `gateway: LspToolGateway` — wraps T4's `createLspGateway()` (the ONE
 *    vscode-command-executing verb layer), converting plain seam inputs to
 *    real `vscode.Uri`/`vscode.Position` and mapping the real result back to
 *    plain via T7a's pure `lspResultMap` functions — called INSIDE each
 *    async verb (T7a carry) so a mapper throw becomes a normal promise
 *    rejection, caught by the T6b handler's own `runOnce`/`safeHandler`
 *    wrapping rather than escaping uncaught or being silently swallowed
 *    here.
 *  - `resolvePathArg` — resolves a workspace-relative path against the LIVE
 *    workspace roots (read fresh on every call, §4.5) via
 *    `resolveWithinWorkspaceReal` (symlink-aware realpath containment,
 *    `pathConfine.ts`); the first root that accepts it wins. `null` on every
 *    root ⇒ REFUSE. On success, warms the document up via
 *    `workspace.openTextDocument` (required — the `vscode.execute*Provider`
 *    commands throw `illegalArgument` against an unopened document) and
 *    returns its `{uri, languageId, version}`. An `openTextDocument` failure
 *    (deleted/unreadable file racing the realpath check) fails closed to
 *    `null`, logged — never thrown.
 *  - `classifyUri` — `buildConfinementVerdict` (T6a) over REALPATH'D live
 *    workspace roots (T6a M-2 carry — `findContainingRoot`'s prefix match
 *    only lines up against a canonical target when the roots it's compared
 *    against are canonical too), computed fresh on every call (§4.5) rather
 *    than cached, so there is no `onDidChangeWorkspaceFolders` subscription
 *    to invalidate/leak/dispose.
 *  - `readSnippet` — `openTextDocument` + `extractSnippet` (T6a); any
 *    failure (deleted file, provider error) fails closed to `undefined`,
 *    logged — never throws, matching `LspToolDeps.readSnippet`'s contract.
 *  - `readFullText` (T8b) — `openTextDocument().getText()`; same fail-closed
 *    shape as `readSnippet`. The handler (`tools.ts`) calls this ONLY for a
 *    uri `classifyUri` already confirmed in-root (R2.1).
 *  - `gateway.getCodeActions` (T8b, the gate-bypass-trap verb) — calls T4's
 *    allowlisted `executeCodeActionProvider` with `itemResolveCount=K`, then
 *    extracts each `vscode.CodeAction` into a `RawCodeAction`: the ONE
 *    build-blind step is the `_allEntries` feature-detect (`typeof
 *    _allEntries !== 'function'` ⇒ absent ⇒ the pure `buildRawCodeActionEdit`
 *    fails closed to `allEntriesAvailable:false`) plus the PUBLIC, documented
 *    `WorkspaceEdit.entries()` read (real `.range`/`.newText`). Every
 *    fail-closed DECISION about that raw data — text-vs-non-text
 *    classification, the entry-count consistency guard — is PURE and lives
 *    in `libToolDepsPure.ts` (`classifyAllEntries`/`buildRawCodeActionEdit`,
 *    unit-tested with plain fixtures), not left build-blind. This is the F-5
 *    Fedora probe: `_allEntries`' PRESENCE on shipped VS Code, and
 *    multi-hunk fidelity.
 *  - `sleep`/`log`.
 *
 * The genuinely pure sub-steps (T7b's candidate-path construction + the
 * forward-slash-normalized workspace-relative display path; T8b's
 * `_allEntries` classification core) are extracted to `libToolDepsPure.ts`
 * and unit-tested there headlessly; everything else here touches
 * `vscode`/`fs` directly and is build-blind (verified by the Fedora GATE-R/
 * GATE-A probes, not vitest).
 *
 * ## Grounding (Context7 `/microsoft/vscode-docs` + the installed
 * `@types/vscode` package — `node_modules/@types/vscode/index.d.ts`, the
 * same grounding discipline `ports.vscode.ts` documents at its own file
 * header):
 *  - `workspace.openTextDocument(uri: Uri): Thenable<TextDocument>` — "Will
 *    be rejected if the file does not exist or cannot be loaded" (own doc
 *    comment, `index.d.ts:14164-14165`) — confirms the try/catch fail-closed
 *    shape below is required, not defensive-for-no-reason.
 *  - `workspace.workspaceFolders: readonly WorkspaceFolder[] | undefined`
 *    (`index.d.ts:13832`) — read fresh via `.map(f => f.uri.fsPath)` on every
 *    call, never cached, so a folder add/remove is picked up immediately.
 *  - `Hover.contents: Array<MarkdownString | MarkedString>` where
 *    `MarkedString = string | {language: string; value: string}` and
 *    `MarkdownString` carries a `.value: string` field (`index.d.ts:3012-
 *    3116`) — structurally satisfies T7a's `HoverLike.contents` duck type
 *    with zero adaptation, confirmed by direct read of the installed types
 *    rather than assumed from memory.
 *  - `Diagnostic.severity: DiagnosticSeverity` (a numeric enum), `.code?:
 *    string | number | {value, target}` (`index.d.ts:7104-7142`) —
 *    structurally satisfies T7a's `DiagnosticLike`.
 *  - `DocumentSymbol.children: DocumentSymbol[]` is always present (never
 *    optional, `index.d.ts:3625`) — satisfies `DocumentSymbolLike`'s
 *    always-array `children` field, matching the module doc's claim in
 *    `lspResultMap.ts`.
 */
import { promises as fs } from 'node:fs';

import * as vscode from 'vscode';

import { createLspGateway } from '../../mcp/lsp/lspGateway';
import type { LspGateway } from '../../mcp/lsp/lspGateway';
import { buildConfinementVerdict, extractSnippet } from '../../mcp/lsp/toolPipeline';
import type { ConfinementVerdict, PlainPosition, PlainRange } from '../../mcp/lsp/resultShaper';
import type {
  LspToolDeps,
  LspToolGateway,
  RawCodeAction,
  RawCodeActionEdit,
  RawCodeActionFile,
  ResolvedPathArg,
  SharedLspToolState,
} from '../../mcp/lsp/lspToolContract';
import {
  mapDefinitionTargets,
  mapDiagnosticsDump,
  mapDiagnosticsForUri,
  mapDocumentSymbols,
  mapHover,
  mapReferences,
  mapWorkspaceSymbols,
  toPlainRange,
} from '../../mcp/lsp/lspResultMap';
import { resolveWithinWorkspaceReal } from '../backend/acp/pathConfine';
import { buildCandidatePaths, buildRawCodeActionEdit, toWorkspaceRelative } from './libToolDepsPure';

function toVscodePosition(position: PlainPosition): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

/** Every currently-open workspace folder's fs path, read fresh — never
 * cached (§4.5: "live at call time"). */
function liveWorkspaceRoots(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

/**
 * Realpath's every LIVE workspace root, for `classifyUri`'s confinement
 * verdict (T6a M-2 carry). Computed fresh on every call — no cache to
 * invalidate on `onDidChangeWorkspaceFolders`, which is the simplest way to
 * stay correct across a folder add/remove with zero extra subscription/
 * disposal surface for a factory function that is never handed
 * `context.subscriptions`. A root whose realpath fails (e.g. removed
 * mid-session, or a permissions error) falls back to its raw form rather
 * than being dropped: `resolveWithinWorkspaceReal` independently
 * re-canonicalizes and re-verifies real containment per call regardless, so
 * this fallback can only ever mis-render a *display* relPath, never widen
 * what is actually treated as in-root — the containment DECISION always
 * flows through `resolveWithinWorkspaceReal`, never through this list alone.
 */
async function realpathLiveRoots(): Promise<string[]> {
  const rawRoots = liveWorkspaceRoots();
  return Promise.all(
    rawRoots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return root;
      }
    }),
  );
}

/**
 * `LspGateway.getDiagnostics`'s return type is a union
 * (`vscode.Diagnostic[] | [vscode.Uri, vscode.Diagnostic[]][]`) that is
 * discriminated by WHICH overload the caller invoked (with vs without a
 * `uri`), not by inspecting runtime shape — the interface only expresses
 * that as a plain union. These two thin, narrowly-scoped wrappers each carry
 * a single documented cast asserting the exact invariant `lspGateway.ts`'s
 * own two-case doc comment already states, never a blind `any`.
 */
function callDiagnosticsForUri(gateway: LspGateway, uri: vscode.Uri): vscode.Diagnostic[] {
  return gateway.getDiagnostics(uri) as vscode.Diagnostic[];
}
function callDiagnosticsDump(gateway: LspGateway): [vscode.Uri, vscode.Diagnostic[]][] {
  return gateway.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][];
}

// ---------------------------------------------------------------------------
// W3 (LIB) · T8b — `lsp_code_actions`'s build-blind extraction (GATE-A/F-5)
//
// The ONLY vscode-touching, genuinely unverifiable-headless part of T8's
// autofix wiring: reading a real `vscode.CodeAction`/`vscode.WorkspaceEdit`.
// Every fail-closed DECISION about what's extracted here lives in the pure
// `buildRawCodeActionEdit`/`classifyAllEntries` (`libToolDepsPure.ts`,
// unit-tested with plain fixtures) — this section's job is narrowly just:
// call the two real WorkspaceEdit methods and hand their raw results to
// those pure functions.
// ---------------------------------------------------------------------------

/**
 * `_allEntries` feature-detect (the F-5 probe: its PRESENCE on shipped VS
 * Code is what the Fedora matrix verifies). UNDOCUMENTED in `@types/vscode`
 * — this is the ONE narrow, documented `as unknown as {...}` cast in this
 * file (per the brief's hard constraint), confined to this single call site.
 * Absent (`typeof ... !== 'function'`) ⇒ `undefined`, which
 * `buildRawCodeActionEdit` turns into `allEntriesAvailable:false` (FAIL
 * CLOSED — never a best-effort read of a partial/heuristic entry list).
 */
function extractAllEntriesRaw(edit: vscode.WorkspaceEdit): readonly unknown[] | undefined {
  const anyEdit = edit as unknown as { _allEntries?: () => readonly unknown[] };
  return typeof anyEdit._allEntries === 'function' ? anyEdit._allEntries() : undefined;
}

/** The PUBLIC, documented `WorkspaceEdit.entries(): [Uri, TextEdit[]][]`
 * ("Get all text edits grouped by resource") — real `vscode.TextEdit`
 * `.range`/`.newText` fields, guaranteed by `@types/vscode`, unlike
 * `_allEntries()`'s undocumented per-entry shape. This is the ONLY source of
 * actual edit DATA `getCodeActions` ever serializes; `_allEntries()` is used
 * purely as a classifier (see `buildRawCodeActionEdit`). */
function extractPublicTextFiles(edit: vscode.WorkspaceEdit): RawCodeActionFile[] {
  return edit.entries().map(([uri, edits]) => ({
    uri: uri.toString(),
    edits: edits.map((e) => ({ range: toPlainRange(e.range), newText: e.newText })),
  }));
}

function mapWorkspaceEdit(edit: vscode.WorkspaceEdit): RawCodeActionEdit {
  return buildRawCodeActionEdit(extractAllEntriesRaw(edit), extractPublicTextFiles(edit));
}

function isDefinedCodeAction(a: vscode.CodeAction | undefined | null): a is vscode.CodeAction {
  return a !== undefined && a !== null;
}

/** `hasCommand` reads `.command !== undefined` — TRUE for both a real
 * `vscode.CodeAction.command` (an object) and a legacy bare `vscode.Command`
 * result (whose OWN `.command` field is the command-id STRING) — either
 * shape correctly classifies as "has a command" without needing to
 * special-case the legacy union member (T8's `RawCodeAction.hasCommand` is a
 * boolean signal only; the command id/string is NEVER read, rendered, or
 * executed — see `lspGateway.ts`'s grounding note). */
function mapRawCodeAction(action: vscode.CodeAction): RawCodeAction {
  const hasCommand = action.command !== undefined;
  if (action.edit === undefined) {
    return { title: action.title, hasCommand };
  }
  return { title: action.title, hasCommand, edit: mapWorkspaceEdit(action.edit) };
}

/**
 * Build the real, vscode-backed `LspToolDeps` T6b's `buildLibMcpServer`
 * consumes. `output` is the extension's shared Hermes output channel — every
 * fail-closed/degraded signal below is logged there, prefixed identically to
 * every other Hermes log line.
 *
 * `shared` (S-1 fix) is the composition root's ONE `createSharedLspToolState()`
 * result — the concurrency pool, first-empty indexing tracker, and
 * doc-symbols LRU. This function is called fresh on every LIB POST (mirroring
 * every OTHER field here, which is deliberately re-read/re-built per call —
 * see the module doc's "§4.5: live at call time" notes), but `shared` itself
 * must be the SAME instance every time — the caller (`extension.ts`)
 * constructs it exactly once and passes it through unchanged. Never call
 * `createSharedLspToolState()` in here.
 */
export function createLibToolDeps(
  output: vscode.OutputChannel,
  shared: SharedLspToolState,
): LspToolDeps {
  const rawGateway = createLspGateway();
  const log = (msg: string): void => output.appendLine(`Talaria LSP: ${msg}`);

  const gateway: LspToolGateway = {
    getDiagnostics(uri) {
      if (uri === undefined) {
        return mapDiagnosticsDump(callDiagnosticsDump(rawGateway));
      }
      const raw = callDiagnosticsForUri(rawGateway, vscode.Uri.parse(uri));
      return [mapDiagnosticsForUri(raw, uri)];
    },
    async getDefinition(uri, position) {
      const raw = await rawGateway.getDefinition(vscode.Uri.parse(uri), toVscodePosition(position));
      return mapDefinitionTargets(raw);
    },
    async getReferences(uri, position) {
      const raw = await rawGateway.getReferences(vscode.Uri.parse(uri), toVscodePosition(position));
      return mapReferences(raw);
    },
    async getDocumentSymbols(uri) {
      const raw = await rawGateway.getDocumentSymbols(vscode.Uri.parse(uri));
      return mapDocumentSymbols(raw);
    },
    async getWorkspaceSymbols(query) {
      const raw = await rawGateway.getWorkspaceSymbols(query);
      return mapWorkspaceSymbols(raw);
    },
    async getHover(uri, position) {
      const raw = await rawGateway.getHover(vscode.Uri.parse(uri), toVscodePosition(position));
      return mapHover(raw);
    },
    async getCodeActions(uri, range, kind, itemResolveCount) {
      const rawActions = await rawGateway.getCodeActions(
        vscode.Uri.parse(uri),
        new vscode.Range(toVscodePosition(range.start), toVscodePosition(range.end)),
        kind,
        itemResolveCount,
      );
      // `executeCommand`'s real typed return can be `undefined` (no provider/
      // no active editor) despite `LspGateway.getCodeActions`'s non-optional
      // declared type; a defensive `?? []` + per-entry filter keeps this
      // total rather than trusting the declared type over the live API.
      return (rawActions ?? []).filter(isDefinedCodeAction).map(mapRawCodeAction);
    },
  };

  async function resolvePathArg(workspaceRelativePath: string): Promise<ResolvedPathArg | null> {
    const roots = liveWorkspaceRoots();
    if (roots.length === 0) {
      return null;
    }
    const candidates = buildCandidatePaths(workspaceRelativePath, roots);
    for (const candidate of candidates) {
      const canonical = await resolveWithinWorkspaceReal(candidate, roots);
      if (canonical === null) {
        continue;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(canonical));
        return { uri: doc.uri.toString(), languageId: doc.languageId, version: doc.version };
      } catch (err) {
        // I-1: try the next candidate (next workspace root) rather than
        // aborting — the first root's candidate always passes confinement
        // (`realpathOfExistingPrefix` canonicalizes even a non-existent leaf),
        // so a `return` here would leave every file in a 2nd+ root unreachable.
        // Each candidate is independently confined above, so advancing stays
        // fail-closed; the trailing `return null` covers all-candidates-failed.
        log(`resolvePathArg: openTextDocument failed for ${canonical} — ${String(err)}`);
        continue;
      }
    }
    return null;
  }

  async function classifyUri(uriString: string): Promise<ConfinementVerdict> {
    const rawFsPath = vscode.Uri.parse(uriString).fsPath;
    const realpathRoots = await realpathLiveRoots();
    return buildConfinementVerdict(rawFsPath, realpathRoots, resolveWithinWorkspaceReal, toWorkspaceRelative);
  }

  async function readSnippet(
    uriString: string,
    range: PlainRange,
    maxLines: number,
  ): Promise<string | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
      return extractSnippet(doc.getText(), range, maxLines);
    } catch (err) {
      log(`readSnippet: openTextDocument failed for ${uriString} — ${String(err)}`);
      return undefined;
    }
  }

  /** `lsp_code_actions`' full in-root doc text (T8b) — same fail-closed
   * shape as `readSnippet`: any `openTextDocument` failure logs and returns
   * `undefined`, never throws. The handler (`tools.ts`) calls this ONLY for
   * a uri `classifyUri` already confirmed in-root (R2.1). */
  async function readFullText(uriString: string): Promise<string | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
      return doc.getText();
    } catch (err) {
      log(`readFullText: openTextDocument failed for ${uriString} — ${String(err)}`);
      return undefined;
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return { gateway, resolvePathArg, classifyUri, readSnippet, readFullText, sleep, log, ...shared };
}
