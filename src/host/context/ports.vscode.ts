/**
 * §2a `ports.vscode.ts` — the `vscode`-backed adapters for `DiagnosticsPort`,
 * `EditorPort`, `WorkspacePort` (`context/types.ts`), assembled into the full
 * {@link ResolverPorts} bundle together with the caller-supplied
 * `TerminalPort`/`GitPort` instances (`terminalCapture.ts` / `scm/gitPort.ts`
 * — those two are constructed separately since they carry their own
 * lifecycle/disposal). This is THE ONLY new `vscode` importer under
 * `src/host/context/` (hard constraint — `resolver.ts`/`format.ts`/
 * `sanitize.ts`/`mentions.ts` stay headless).
 *
 * Every adapter is a thin pass-through: the actual mapping/escaping/policy
 * logic lives in headlessly-tested pure helpers (`diagnosticsMapper.ts`,
 * `queryToGlob.ts`) that this file merely feeds vscode-shaped data into.
 *
 * Grounded at write-time — Context7 (`/microsoft/vscode-docs`, session) +
 * `node_modules/@types/vscode/index.d.ts` (installed `1.125.0`, cross-checked
 * against `microsoft/vscode` `src/vscode-dts/vscode.d.ts` fetched raw):
 * - `languages.getDiagnostics(): [Uri, Diagnostic[]][]` (the no-arg overload);
 *   `Diagnostic{range,message,severity,source?}`; `DiagnosticSeverity.Error = 0`,
 *   `.Warning = 1` (exact ordinals confirmed against the upstream enum).
 * - `window.activeTextEditor: TextEditor | undefined`; `TextEditor.selection: Selection`
 *   (`Selection extends Range` — `start`/`end: Position`, `isEmpty: boolean`);
 *   `TextEditor.document: TextDocument`; `TextDocument.getText(range?): string`;
 *   `TextDocument.uri: Uri`.
 * - `workspace.workspaceFolders: readonly WorkspaceFolder[] | undefined`;
 *   `workspace.findFiles(include: GlobPattern, exclude?: GlobPattern | null,
 *   maxResults?: number, token?: CancellationToken): Thenable<Uri[]>` — exact
 *   signature and doc comments (`exclude: undefined` applies `files.exclude`;
 *   passing an explicit exclude glob here per the T2d brief instead).
 */
import * as vscode from 'vscode';

import type { ResolverPorts } from './resolver';
import { mapDiagnosticEntries } from './diagnosticsMapper';
import type { DiagnosticEntryLike } from './diagnosticsMapper';
import { queryToGlob } from './queryToGlob';
import type { GitPort, TerminalPort } from './types';

/** Explicit exclude glob (§2a deliverable 4: "excluding node_modules/.git")
 * — passed EXPLICITLY rather than relying on the user's `files.exclude`
 * (`undefined` would apply that setting, which the user could have emptied). */
const FIND_FILES_EXCLUDE = '{**/node_modules/**,**/.git/**}';

/**
 * Assemble the full {@link ResolverPorts} bundle: `diagnostics`/`editor`/
 * `workspace` are constructed here (vscode-backed); `terminal`/`git` are the
 * caller's already-constructed instances (they own their own disposal /
 * activation lifecycle, unlike the other three which are stateless
 * pass-throughs constructed fresh on every call).
 */
export function createVscodeContextPorts(terminal: TerminalPort, git: GitPort): ResolverPorts {
  return {
    diagnostics: {
      all: () => {
        const entries: DiagnosticEntryLike[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
          for (const d of diagnostics) {
            entries.push({
              path: uri.fsPath,
              severity: d.severity,
              line: d.range.start.line,
              message: d.message,
              source: d.source,
            });
          }
        }
        return mapDiagnosticEntries(entries, vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning);
      },
    },
    editor: {
      activeSelection: () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return undefined;
        const { selection, document } = editor;
        return {
          path: document.uri.fsPath,
          text: document.getText(selection),
          range: { startLine: selection.start.line + 1, endLine: selection.end.line + 1 },
        };
      },
    },
    workspace: {
      roots: () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
      findFiles: async (query, maxResults) => {
        const cappedResults = Math.max(0, Math.floor(maxResults));
        if (cappedResults === 0) return [];
        const uris = await vscode.workspace.findFiles(queryToGlob(query), FIND_FILES_EXCLUDE, cappedResults);
        return uris.map((u) => u.fsPath);
      },
    },
    terminal,
    git,
  };
}
