/**
 * W5-T5 · `contextService.vscode.ts` — the thin, deliberately-untested
 * `vscode` shell for `CrossFileContextService` (`contextService.ts`).
 * Mirrors this repo's `<name>.ts`/`<name>.vscode.ts` split
 * (`src/host/context/ports.vscode.ts`, `src/host/commands/diffDecision.ts`/
 * `.vscode.ts`) and W5-T2's `editTracker.ts`/`editTrackerAdapter.ts`: every
 * real DECISION (mode gating, ingest ordering, snapshot reuse/regenerate,
 * candidate shaping) lives in the headlessly-tested `contextService.ts`;
 * this file only translates real vscode events/state into the calls that
 * core already knows how to make. No `vscode` runtime import exists in
 * `contextService.ts` — this is the ONE place that imports it for real.
 *
 * Grounded at write-time — Context7 (`/microsoft/vscode-docs`, session) +
 * `node_modules/@types/vscode/index.d.ts` (installed, cross-checked):
 * - `window.tabGroups: TabGroups` (finalized 1.67) — `.all: readonly TabGroup[]`,
 *   each with `.tabs: readonly Tab[]`; `Tab.input` is a `TabInputText` (has
 *   `.uri: Uri`) for a plain text tab — narrowed via `instanceof`.
 * - `workspace.textDocuments: readonly TextDocument[]` — already-open
 *   in-memory documents; used instead of `workspace.openTextDocument` so
 *   gathering a tab's content never triggers new I/O on this background path.
 * - `workspace.onDidSaveTextDocument: Event<TextDocument>`,
 *   `window.onDidChangeActiveTextEditor: Event<TextEditor | undefined>`,
 *   `window.tabGroups.onDidChangeTabs: Event<TabChangeEvent>`,
 *   `workspace.onDidChangeTextDocument: Event<TextDocumentChangeEvent>`.
 * - `workspace.asRelativePath(uri, includeWorkspaceFolder?): string` — same
 *   API `editTrackerAdapter.ts` already uses for POSIX-normalized,
 *   workspace-relative paths (R11).
 */
import * as vscode from 'vscode';
import {
  CrossFileContextService,
  buildRecentlyOpenedCandidates,
  createEditTrackerSource,
  type CrossFileContextServiceModeInput,
  type OpenTab,
} from './contextService';
import { RingBuffer } from './ringBuffer';
import { createEditTrackerAdapter } from './editTrackerAdapter';
import type { Anchor, SnippetSource } from './types';

/** Cap on the focus-history list the "recently-opened" source orders by —
 *  generous (well above realistic open-tab counts) so it never itself
 *  becomes the bottleneck; the ladder's own cap-5 does the real limiting. */
const MRU_CAP = 32;

function toWorkspaceRelativePosixPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).split('\\').join('/');
}

/**
 * The "recently-opened" `SnippetSource` (§2.2). Reads ONLY already-open,
 * already-in-memory documents (`workspace.textDocuments`) — never
 * `openTextDocument`, which can perform real I/O; a tab whose document
 * isn't materialized is skipped rather than force-loaded (this is a
 * background gather, but "skip a slow one" still beats adding avoidable
 * I/O to every cycle). All real ordering/excerpting is the pure
 * `buildRecentlyOpenedCandidates` (`contextService.ts`).
 */
function createRecentlyOpenedSource(getMruUris: () => readonly string[]): SnippetSource {
  return {
    kind: 'recently-opened',
    async gather(anchor: Anchor): Promise<ReturnType<typeof buildRecentlyOpenedCandidates>> {
      const tabs: OpenTab[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof vscode.TabInputText)) continue;
          const uri = tab.input.uri;
          const uriString = uri.toString();
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriString);
          if (!doc) continue;
          tabs.push({ uri: uriString, filepath: toWorkspaceRelativePosixPath(uri), content: doc.getText() });
        }
      }
      return buildRecentlyOpenedCandidates(tabs, getMruUris(), anchor.uri);
    },
  };
}

export interface CreateCrossFileContextServiceOptions extends CrossFileContextServiceModeInput {
  readonly getSkipUntrustedRemote: () => boolean;
  readonly getEnabled: () => boolean;
  /** W5-T7 — `talaria.autocomplete.crossFile.warmUp` (default false). */
  readonly getWarmUpEnabled?: () => boolean;
}

export interface HermesCrossFileContextService {
  readonly service: CrossFileContextService;
  readonly disposable: vscode.Disposable;
}

/**
 * Constructs the real `CrossFileContextService` (owned by
 * `registerHermesAutocomplete`, index.ts) wired to real vscode listeners:
 * tab open/close, save (+ quarantine clear), active-editor change (+ MRU
 * tracking for the recently-opened source), and per-keystroke bookkeeping
 * that arms the debounced idle-tick gather trigger. NOT unit tested
 * directly — see the module doc comment.
 */
export function createHermesCrossFileContextService(
  options: CreateCrossFileContextServiceOptions,
): HermesCrossFileContextService {
  const ringBuffer = new RingBuffer();
  const editTrackerAdapter = createEditTrackerAdapter();
  const editTrackerSource = createEditTrackerSource(editTrackerAdapter.tracker);

  let mruUris: string[] = [];
  const recordActiveUri = (uri: string): void => {
    mruUris = [uri, ...mruUris.filter((existing) => existing !== uri)].slice(0, MRU_CAP);
  };
  const recentlyOpenedSource = createRecentlyOpenedSource(() => mruUris);

  const getCurrentAnchor = (): Anchor => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { uri: '', line: 0 };
    return { uri: editor.document.uri.toString(), line: editor.selection.active.line };
  };

  const service = new CrossFileContextService({
    capabilities: options.capabilities,
    template: options.template,
    crossFileEnabled: options.crossFileEnabled,
    prefixInjection: options.prefixInjection,
    backend: options.backend,
    ringBuffer,
    sources: [editTrackerSource, recentlyOpenedSource],
    getCurrentAnchor,
    getSkipUntrustedRemote: options.getSkipUntrustedRemote,
    getEnabled: options.getEnabled,
    getWarmUpEnabled: options.getWarmUpEnabled,
  });

  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    void service.handleSave(doc.uri.toString());
  });
  const activeEditorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      recordActiveUri(editor.document.uri.toString());
    }
    void service.handleActiveEditorChange();
  });
  const tabsSub = vscode.window.tabGroups.onDidChangeTabs(() => {
    void service.handleTabsChanged();
  });
  const textChangeSub = vscode.workspace.onDidChangeTextDocument(() => {
    service.recordKeystroke();
  });

  const disposable = vscode.Disposable.from(
    editTrackerAdapter,
    saveSub,
    activeEditorSub,
    tabsSub,
    textChangeSub,
    { dispose: () => service.dispose() },
  );

  return { service, disposable };
}
