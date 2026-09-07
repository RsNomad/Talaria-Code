import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscodeTypes from 'vscode';

/**
 * WS-F3 F3-1 — the CHARACTERIZATION-FIRST golden master for `NextEditShell`'s
 * ORCHESTRATION (the trigger path's ordered effects, and the R2 "FIM stops
 * next-edit" interrupt). Pins today's behaviour against the UNTOUCHED
 * `shell.vscode.ts`; must stay green with ZERO edits through F3-2..F3-9.
 *
 * `NextEditShell` itself is a module-private class (re-grounded on current
 * HEAD — no `export` on the `class NextEditShell` declaration). The brief
 * asks to "instantiate the NextEditShell class from ./shell.vscode"; the
 * only way to do that without a production edit is through the class's own
 * sole public entry point, `registerTalariaNextEdit` (which does exactly
 * `new NextEditShell(...).disposable` and nothing else) — the SAME
 * substitution the pre-existing `shell.vscode.test.ts` already uses for
 * every one of its 3000+ lines of characterization. This file follows that
 * established precedent rather than inventing a second one.
 *
 * ORDERING, not membership: every assertion below is against a single
 * `calls: string[]` log, appended to in real call order by the mocks
 * themselves (never re-sorted, never deduped) — a plain array pushed into by
 * plain functions (Global Constraints: never `vi.fn()`).
 */

interface FakePosition { line: number; character: number }

interface FakeDocument {
  uri: { scheme: string; path: string; fsPath: string; toString(): string };
  version: number;
  lineCount: number;
  getText(range?: { start: FakePosition; end: FakePosition }): string;
  lineAt(line: number): { text: string; range: { end: FakePosition } };
}

interface FakeEditor {
  document: FakeDocument;
  selection: { active: FakePosition };
  setDecorations(type: { id: string }, ranges: unknown[]): void;
  revealRange(range: unknown, kind: unknown): void;
}

interface FakeChangeEvent {
  document: FakeDocument;
  contentChanges: { range: { start: FakePosition; end: FakePosition }; text: string }[];
}

/** THE ordered log every mock hook below appends to. */
const calls: string[] = [];

const host = {
  docChangeHandlers: [] as ((e: FakeChangeEvent) => void)[],
  activeTextEditor: undefined as FakeEditor | undefined,
  visibleTextEditors: [] as FakeEditor[],
  isTrusted: true,
  settings: new Map<string, unknown>(),
};

function resetHost(): void {
  host.docChangeHandlers.length = 0;
  host.activeTextEditor = undefined;
  host.visibleTextEditors.length = 0;
  host.isTrusted = true;
  host.settings.clear();
  calls.length = 0;
}

vi.mock('vscode', () => {
  class FakeRange {
    readonly start: FakePosition;
    readonly end: FakePosition;
    constructor(a: number | FakePosition, b: number | FakePosition, c?: number, d?: number) {
      if (typeof a === 'number' && typeof b === 'number') {
        this.start = { line: a, character: b };
        this.end = { line: c ?? a, character: d ?? b };
      } else {
        this.start = a as FakePosition;
        this.end = b as FakePosition;
      }
    }
  }
  class FakeWorkspaceEdit {
    readonly edits: { uri: string; range: unknown; newText: string }[] = [];
    replace(uri: { toString(): string }, range: unknown, newText: string): void {
      this.edits.push({ uri: uri.toString(), range, newText });
    }
  }
  let decorationSeq = 0;
  return {
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: (command: string, ...args: unknown[]) => {
        if (command === 'setContext') {
          calls.push(`vscode.setContext:${String(args[0])}=${String(args[1])}`);
        }
        return Promise.resolve(undefined);
      },
    },
    window: {
      // The constructor creates exactly two decoration types, region THEN
      // locator (shell.vscode.ts:893-897) — tagged by shape, not call order,
      // so the tag survives even if that creation order ever changes.
      createTextEditorDecorationType: (options: Record<string, unknown>) => ({
        id: 'isWholeLine' in options ? 'region-decoration' : 'locator-decoration',
        seq: decorationSeq++,
        dispose() {},
      }),
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
      get activeTextEditor() {
        calls.push('vscode.activeTextEditor');
        return host.activeTextEditor;
      },
      get visibleTextEditors() {
        return host.visibleTextEditors;
      },
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    },
    workspace: {
      getConfiguration: (section: string) => ({
        get: <T>(key: string, dflt: T): T =>
          host.settings.has(`${section}.${key}`) ? (host.settings.get(`${section}.${key}`) as T) : dflt,
      }),
      onDidChangeTextDocument: (cb: (e: FakeChangeEvent) => void) => {
        host.docChangeHandlers.push(cb);
        return { dispose() {} };
      },
      onDidCloseTextDocument: () => ({ dispose() {} }),
      applyEdit: () => Promise.resolve(true),
      asRelativePath: (uri: { toString(): string }) => uri.toString(),
      get isTrusted() {
        calls.push('vscode.isTrusted');
        return host.isTrusted;
      },
    },
    ThemeColor: class {
      constructor(public readonly id: string) {}
    },
    Range: FakeRange,
    WorkspaceEdit: FakeWorkspaceEdit,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Disposable: {
      from: (...items: { dispose(): void }[]) => ({ dispose: () => items.forEach((i) => i.dispose()) }),
    },
  };
});

vi.mock('./backend', async () => {
  const actual = await vi.importActual<typeof import('./backend')>('./backend');
  return {
    // Field-by-field (never `{ ...actual, ... }`) — the repo's own
    // ringBuffer.test.ts SPREAD_RE guard shape, kept here on principle even
    // though it only scans non-test sources.
    clearNextEditBackendWarnings: actual.clearNextEditBackendWarnings,
    NextEditHttpBackend: class {
      constructor() {
        calls.push('backend.constructed');
      }
      predict(_req: unknown, _rendered: unknown, signal: AbortSignal): Promise<{ text: string; stopReason: 'stop' }> {
        calls.push('backend.predict');
        signal.addEventListener('abort', () => calls.push('backend.signal.aborted'));
        return backendRespond();
      }
    },
  };
});

vi.mock('./scan', async () => {
  const actual = await vi.importActual<typeof import('./scan')>('./scan');
  return {
    NEXT_EDIT_FIELD_CLASSIFICATION: actual.NEXT_EDIT_FIELD_CLASSIFICATION,
    contentChecksFor: actual.contentChecksFor,
    NextEditMintRejectionError: actual.NextEditMintRejectionError,
    mintScannedNextEditRequest: (req: Parameters<typeof actual.mintScannedNextEditRequest>[0], sentinels: readonly string[]) => {
      calls.push('scan.mintScannedNextEditRequest');
      return actual.mintScannedNextEditRequest(req, sentinels);
    },
  };
});

/** Never resolves for the "Stop" scenario (the whole point is to interrupt it
 *  before it ever settles); the happy-path scenario overwrites this per-test
 *  with an immediately-resolving response. */
let backendRespond: () => Promise<{ text: string; stopReason: 'stop' }> = () =>
  new Promise(() => {
    /* deliberately never settles unless a test overwrites this */
  });

import { registerTalariaNextEdit, fimActivityRelay, type NextEditShellDeps } from './shell.vscode';
import { NextEditGuard, type NextEditConfigPort, type NextEditSource } from './guard';
import type { ToggleState } from './mode';

function makeContext(): vscodeTypes.ExtensionContext {
  return { subscriptions: [] } as unknown as vscodeTypes.ExtensionContext;
}

function makeSourcePort(initial: NextEditSource): NextEditConfigPort {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: async (v: NextEditSource): Promise<void> => {
      value = v;
      for (const listener of [...listeners]) listener();
    },
    onDidChange: (cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    },
  };
}

function sourceOf(toggles: ToggleState): NextEditSource {
  if (toggles.next) return 'dedicated';
  if (toggles.generic) return 'generic';
  return 'off';
}

const failures: string[] = [];
const autocompleteConfig = { endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', backend: 'ollama' };
const SHELL_DEPS: NextEditShellDeps = {
  reportFailure: (msg: string) => void failures.push(msg),
  getAutocompleteEndpoint: () => {
    calls.push('deps.getAutocompleteEndpoint');
    return autocompleteConfig.endpoint;
  },
  getAutocompleteModel: () => {
    calls.push('deps.getAutocompleteModel');
    return autocompleteConfig.model;
  },
  getAutocompleteBackend: () => {
    calls.push('deps.getAutocompleteBackend');
    return autocompleteConfig.backend;
  },
  getAutocompleteApiKey: () => {
    calls.push('deps.getAutocompleteApiKey');
    return undefined;
  },
};

async function setupShell(toggles: ToggleState): Promise<void> {
  const guard = await NextEditGuard.hydrate(makeSourcePort(sourceOf(toggles)), { reportFailure: SHELL_DEPS.reportFailure });
  registerTalariaNextEdit(makeContext(), guard, SHELL_DEPS);
}

function makeDoc(text: string): FakeDocument {
  const uri = 'file:///home/u/project/a.ts';
  const path = '/home/u/project/a.ts';
  const lines = text.split(/\r\n|\n/);
  return {
    uri: { scheme: 'file', path, fsPath: path, toString: () => uri },
    version: 1,
    get lineCount() {
      return lines.length;
    },
    getText(range?: { start: FakePosition; end: FakePosition }): string {
      if (!range) return text;
      const out: string[] = [];
      for (let line = range.start.line; line <= range.end.line; line++) {
        const content = lines[line] ?? '';
        const from = line === range.start.line ? range.start.character : 0;
        const to = line === range.end.line ? range.end.character : content.length;
        out.push(content.slice(from, to));
      }
      return out.join('\n');
    },
    lineAt(line: number) {
      const content = lines[line] ?? '';
      return { text: content, range: { end: { line, character: content.length } } };
    },
  };
}

function makeEditor(document: FakeDocument, cursorLine: number): FakeEditor {
  return {
    document,
    selection: { active: { line: cursorLine, character: 0 } },
    setDecorations: (type: { id: string }) => calls.push(`vscode.setDecorations:${type.id}`),
    revealRange: () => calls.push('vscode.revealRange'),
  };
}

/** Fires the debounced edit-burst trigger and settles the 350 ms debounce
 *  (same constant `shell.vscode.ts` uses), then lets any already-resolved
 *  microtasks drain. Does NOT wait for `backend.predict()` to settle — the
 *  Stop scenario depends on it staying suspended mid-flight. */
async function fireTriggerAndSettle(): Promise<void> {
  const doc = host.activeTextEditor?.document;
  if (doc) {
    doc.version += 1;
    for (const handler of host.docChangeHandlers) {
      handler({
        document: doc,
        contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x' }],
      });
    }
  }
  await vi.advanceTimersByTimeAsync(400);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHost();
  failures.length = 0;
  autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
  autocompleteConfig.model = 'qwen2.5-coder:7b';
  autocompleteConfig.backend = 'ollama';
  backendRespond = () => new Promise(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

// ══════════════════════ Part E — trigger spy-ORDER bank ═══════════════════════

describe('golden: ONE happy trigger path, ordered calls (shell.vscode.ts: trigger→resolveReportedRoute→buildRequest→runPrediction→decorate)', () => {
  it('the ordered sequence is exactly: activeTextEditor, the four deps.* route reads, isTrusted, the mint, backend construct+predict, then setContext(jumpVisible) + BOTH decorations', async () => {
    backendRespond = () => Promise.resolve({ text: 'REWRITTEN\n', stopReason: 'stop' as const });
    host.activeTextEditor = makeEditor(makeDoc('const a = 1;\nconst b = 2;\n'), 0);

    await setupShell({ next: false, generic: true });
    calls.length = 0; // isolate the trigger's own sequence from setup/registration noise
    await fireTriggerAndSettle();
    // Let the (already-resolved) predict promise's continuation (proposalReady
    // dispatch + decorate) actually run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([
      'vscode.activeTextEditor', // trigger()'s own editor read, ahead of the trust gate
      'deps.getAutocompleteBackend', // resolveReportedRoute -> resolveRoute (generic branch)
      'deps.getAutocompleteEndpoint',
      'deps.getAutocompleteModel',
      'deps.getAutocompleteApiKey',
      'vscode.isTrusted', // GATE 3
      'scan.mintScannedNextEditRequest', // runPrediction, after buildRequest succeeded
      'backend.constructed',
      'backend.predict',
      'vscode.activeTextEditor', // F-1 identity re-check: editorFor(request.cursor.uri), :1652
      'vscode.setContext:talaria.nextEdit.jumpVisible=true',
      'vscode.activeTextEditor', // showDecorations' own editorFor(p.region.uri), :904
      'vscode.setDecorations:region-decoration',
      'vscode.setDecorations:locator-decoration',
    ]);
  });
});

// ════════════════════════ Part F — Stop spy-ORDER bank ════════════════════════
// R2: FIM starting STOPS next-edit. `fimActivity.requestStarted`
// (shell.vscode.ts:1016-1033) calls `abortInFlight()` (:1374-1387) BEFORE
// dispatching `fimVisibility(true)`, and `fimVisibility(true)` clears from
// ANY state (`fsm.ts:73-76`, unconditional `cleared()` — proved directly
// against the untouched `fsm.ts` by this same repo's `fsm.test.ts`), so the
// abort and the FSM's clearAll cleanup are pinned together, in that order.

describe('golden: FIM interrupts an in-flight next-edit prediction ("Stop"), ordered calls', () => {
  it('abortInFlight aborts the live controller FIRST, then the fimVisibility dispatch runs its clearAll cleanup', async () => {
    // backendRespond stays the never-settling default — the prediction must
    // still be in flight when FIM starts.
    host.activeTextEditor = makeEditor(makeDoc('const a = 1;\nconst b = 2;\n'), 0);

    await setupShell({ next: false, generic: true });
    await fireTriggerAndSettle();
    expect(calls, 'the prediction must genuinely be in flight before FIM interrupts it').toContain('backend.predict');

    calls.length = 0; // isolate the interrupt sequence itself
    fimActivityRelay.requestStarted();

    expect(calls).toEqual([
      'backend.signal.aborted',
      'vscode.setContext:talaria.nextEdit.jumpVisible=false',
      'vscode.setContext:talaria.nextEdit.jumped=false',
    ]);
  });
});
