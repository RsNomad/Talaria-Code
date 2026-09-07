import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscodeTypes from 'vscode';

/**
 * WS-F3 F3-1 — the CHARACTERIZATION-FIRST golden master for the "pure"
 * surfaces `shell.vscode.ts` will be decomposed around (F3-2..F3-9, the
 * GD.2 playbook). This file PINS today's behaviour against the UNTOUCHED
 * `shell.vscode.ts` — it is not a RED test, and it must stay green with
 * ZERO edits through every later extraction (a golden that needs editing to
 * survive an extraction means the extraction changed behaviour).
 *
 * IMPORT MECHANIC. Every surface this file can reach as an EXPORT is
 * imported straight `from './shell.vscode'` (the façade) — `diffMayEgress`,
 * `deriveGenericTransport`, `genericUnsupportedBackendMessage`,
 * `GENERIC_SETUP_NOTE`, `NEXT_EDIT_MODEL_UNSET_NOTE`, `registerTalariaNextEdit`.
 * F3-2..F3-8 move implementations to new modules but the shell RE-EXPORTS
 * each one, so these keep resolving through `./shell.vscode` with ZERO edits.
 *
 * HONEST GAP (report this — the brief's own escape hatch): `resolveRoute`,
 * `partitionEgressableDiffs`, `ensureTrailingNewline`, `stripLineTerminator`,
 * `extractRegionRange` and `toWorkspaceRelativePosixPath` are, on the
 * CURRENT (re-grounded) HEAD, module-PRIVATE in `shell.vscode.ts` — they are
 * not in the `export` list re-confirmed by grep, so a golden cannot `import`
 * them directly without adding an export to production code, which the
 * brief forbids outright ("CHANGE NO PRODUCTION CODE"). Sections B and C
 * below pin them at full fidelity ANYWAY, but INDIRECTLY: through the one
 * façade entry point that is exported — `registerTalariaNextEdit` — reading
 * their OBSERVABLE OUTPUT off the exact runtime object each one produces
 * (the `NextEditRequest` handed to the (mocked) backend's `predict()`, and
 * the (mocked) backend's construction options). This is not a re-
 * implementation and does not invent behaviour: every expected value below
 * was computed by READING the current `shell.vscode.ts` source (cited by
 * name in each block) against a hand-traced input, then asserted against
 * what the REAL, unmodified function produces at runtime. `partitionEgressableDiffs`
 * specifically is pinned via the ALGEBRAIC identity its own source shows
 * (`kept = diffs.filter(d => diffMayEgress(d, sentinels))`, `shell.vscode.ts:703-711`)
 * applied to the exported `diffMayEgress` — so the FI-27 "pin what partition
 * KEEPS" requirement is satisfied without calling the private function at all.
 */

// ─────────────────────────── module-load-safe vscode stub ────────────────────
// `shell.vscode.ts` imports `vscode` at module scope — Section A (diffMayEgress)
// touches no vscode API at all (mirrors `diffEgressDrift.lock.test.ts`'s own
// minimal stub), so it gets the cheapest possible mock. Sections B/C/D need the
// fuller harness below (same file, same `vi.mock` — vitest hoists exactly one
// factory per module per test file).

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
  setDecorations(type: unknown, ranges: unknown[]): void;
  revealRange(range: unknown, type: unknown): void;
}

interface FakeChangeEvent {
  document: FakeDocument;
  contentChanges: { range: { start: FakePosition; end: FakePosition }; text: string }[];
}

const host = {
  docChangeHandlers: [] as ((e: FakeChangeEvent) => void)[],
  activeTextEditor: undefined as FakeEditor | undefined,
  visibleTextEditors: [] as FakeEditor[],
  visibleEditorHandlers: [] as ((editors: FakeEditor[]) => void)[],
  isTrusted: true,
  warnings: [] as string[],
  infos: [] as string[],
  settings: new Map<string, unknown>(),
  /** Overridable per-row: `vscode.workspace.asRelativePath`'s return value,
   *  so the `toWorkspaceRelativePosixPath` rows can prove the backslash→slash
   *  conversion is the SHELL's own doing, not the (real) API's. */
  relativePathOverride: undefined as string | undefined,
};

function resetHost(): void {
  host.docChangeHandlers.length = 0;
  host.activeTextEditor = undefined;
  host.visibleTextEditors.length = 0;
  host.visibleEditorHandlers.length = 0;
  host.isTrusted = true;
  host.warnings.length = 0;
  host.infos.length = 0;
  host.settings.clear();
  host.relativePathOverride = undefined;
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
  return {
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: () => Promise.resolve(undefined),
    },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      showWarningMessage: (msg: string) => {
        host.warnings.push(msg);
        return Promise.resolve(undefined);
      },
      showInformationMessage: (msg: string) => {
        host.infos.push(msg);
        return Promise.resolve(undefined);
      },
      get activeTextEditor() {
        return host.activeTextEditor;
      },
      get visibleTextEditors() {
        return host.visibleTextEditors;
      },
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: (cb: (editors: FakeEditor[]) => void) => {
        host.visibleEditorHandlers.push(cb);
        return { dispose() {} };
      },
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
      asRelativePath: (uri: { toString(): string }) => host.relativePathOverride ?? uri.toString(),
      get isTrusted() {
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

/** Same two-shape spy the pre-existing `shell.vscode.test.ts` uses: captures
 *  the ROUTE the shell resolved (via the backend's construction options) and
 *  every REQUEST it built (the exact runtime object handed to `predict`,
 *  fields intact — `ScannedNextEditRequest` is `NextEditRequest & brand`, so
 *  reading it as `NextEditRequest` loses nothing). Never `vi.fn()` (Global
 *  Constraints: plain functions pushing into arrays). */
const backendSpy = {
  constructed: [] as NextEditBackendOptions[],
  predicts: [] as { opts: NextEditBackendOptions; req: NextEditRequest }[],
  respond: (): Promise<NextEditModelOutput> => Promise.resolve({ text: '', stopReason: 'stop' as const }),
};

vi.mock('./backend', async () => {
  const actual = await vi.importActual<typeof import('./backend')>('./backend');
  return {
    // Field-by-field (never `{ ...actual, ... }`) — the repo's own
    // ringBuffer.test.ts SPREAD_RE guard shape, kept here on principle even
    // though it only scans non-test sources.
    clearNextEditBackendWarnings: actual.clearNextEditBackendWarnings,
    NextEditHttpBackend: class {
      constructor(private readonly opts: NextEditBackendOptions) {
        backendSpy.constructed.push(opts);
      }
      predict(req: NextEditRequest): Promise<NextEditModelOutput> {
        backendSpy.predicts.push({ opts: this.opts, req });
        return backendSpy.respond();
      }
    },
  };
});

const mintCalls: string[] = [];
vi.mock('./scan', async () => {
  const actual = await vi.importActual<typeof import('./scan')>('./scan');
  return {
    NEXT_EDIT_FIELD_CLASSIFICATION: actual.NEXT_EDIT_FIELD_CLASSIFICATION,
    contentChecksFor: actual.contentChecksFor,
    // The REAL class, not a stand-in: `surfaceTriggerFailure`'s
    // `err instanceof NextEditMintRejectionError` narrows against whatever
    // this partial mock exports under that name.
    NextEditMintRejectionError: actual.NextEditMintRejectionError,
    mintScannedNextEditRequest: (req: NextEditRequest, sentinels: readonly string[]) => {
      mintCalls.push(req.region.filepath);
      return actual.mintScannedNextEditRequest(req, sentinels);
    },
  };
});

import {
  diffMayEgress,
  registerTalariaNextEdit,
  requestNextEditToggle,
  deriveGenericTransport,
  genericUnsupportedBackendMessage,
  GENERIC_SETUP_NOTE,
  NEXT_EDIT_MODEL_UNSET_NOTE,
  type NextEditShellDeps,
} from './shell.vscode';
import { NextEditGuard, type NextEditConfigPort, type NextEditSource } from './guard';
import type { ToggleState } from './mode';
import type { NextEditRequest, RecentDiff } from './types';
import type { NextEditBackendOptions } from './backend';
import type { NextEditModelOutput } from './formats/types';
import { sliceLines, splitLinesKeepingTerminators } from './formats/shared';
import { BackendHttpError, StreamIdleTimeoutError } from '../backends/http';
import { InsecureTransportError } from '../backends/secureTransport';
import { NextEditMintRejectionError } from './scan';

// ════════════════════════════ Part A — egress corpus ══════════════════════════
// `diffMayEgress` IS exported today, so this part needs no indirection at all.

describe('golden: diffMayEgress + the partitionEgressableDiffs KEPT-list identity (FI-27)', () => {
  const SENTINELS = ['<|next|>', '<|editable_region_start|>'];

  function makeDiff(over: Partial<RecentDiff>): RecentDiff {
    return {
      uri: 'file:///w/a.ts',
      filepath: 'a.ts',
      startLine: 0,
      endLine: 1,
      before: 'const a = 1;\n',
      after: 'const a = 2;\n',
      ...over,
    };
  }

  const CLEAN = makeDiff({});
  const SENTINEL_IN_BEFORE = makeDiff({ before: 'x <|next|> y' });
  const SENTINEL_IN_AFTER = makeDiff({ after: 'x <|editable_region_start|> y' });
  const REAL_SECRET = makeDiff({ after: 'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"\n' });
  const ABOVE_CURSOR_PURE_INSERTION = makeDiff({ uri: 'file:///w/b.ts', filepath: 'b.ts', startLine: 0, endLine: 0, before: '', after: 'const inserted = true;\n' });
  const EMPTY_DIFF = makeDiff({ before: '', after: '' });

  const CORPUS: ReadonlyArray<{ name: string; diff: RecentDiff; expected: boolean }> = [
    { name: 'a clean diff', diff: CLEAN, expected: true },
    { name: 'a sentinel in `before`', diff: SENTINEL_IN_BEFORE, expected: false },
    { name: 'a sentinel in `after`', diff: SENTINEL_IN_AFTER, expected: false },
    { name: 'a real secret shape', diff: REAL_SECRET, expected: false },
    { name: 'an above-cursor pure insertion (a clean diff — no secret concern of its own)', diff: ABOVE_CURSOR_PURE_INSERTION, expected: true },
    { name: 'an empty diff', diff: EMPTY_DIFF, expected: true },
  ];

  it('reach: the corpus exercises both verdicts', () => {
    expect(CORPUS.some((c) => c.expected)).toBe(true);
    expect(CORPUS.some((c) => !c.expected)).toBe(true);
  });

  it.each(CORPUS)('diffMayEgress($name) === $expected', ({ diff, expected }) => {
    expect(diffMayEgress(diff, SENTINELS)).toBe(expected);
  });

  it(
    'the KEPT list `partitionEgressableDiffs` returns (shell.vscode.ts:699-713) is, by its own source, ' +
      '`diffs.filter(d => diffMayEgress(d, sentinels))` — pinned here via that identity so F3-4\'s rename to ' +
      '`filterEgressableDiffs` (returning only the kept list) is 0-edit against this golden',
    () => {
      const diffs = CORPUS.map((c) => c.diff);
      const kept = diffs.filter((d) => diffMayEgress(d, SENTINELS));
      const expectedKept = CORPUS.filter((c) => c.expected).map((c) => c.diff);
      expect(kept).toEqual(expectedKept);
      expect(kept).toEqual([CLEAN, ABOVE_CURSOR_PURE_INSERTION, EMPTY_DIFF]);
    },
  );
});

describe('golden: deriveGenericTransport (shell.vscode.ts:136-141, exported, direct)', () => {
  it.each([
    { backend: 'ollama', expected: 'ollama' },
    { backend: 'vllm', expected: 'openai-compat' },
    { backend: 'llamacpp', expected: 'openai-compat' },
    { backend: 'codestral', expected: null },
    { backend: 'openai-compat', expected: null },
    { backend: 'unknown-future-backend', expected: null },
  ])('deriveGenericTransport($backend) === $expected', ({ backend, expected }) => {
    expect(deriveGenericTransport(backend)).toBe(expected);
  });
});

// ═══════════════════════ Part B1 — sliceLines / splitLinesKeepingTerminators ═══
// Exported from `./formats/shared` (WS-F4 F4-1) — the brief explicitly allows
// sourcing these two from there directly when `./shell.vscode` doesn't
// re-export them, which it does not today.

describe('golden: sliceLines / splitLinesKeepingTerminators (formats/shared.ts, used by extractRegionRange)', () => {
  it.each([
    { name: 'LF-terminated, no trailing empty chunk', text: 'a\nb\nc\n', expected: ['a\n', 'b\n', 'c\n'] },
    { name: 'no trailing terminator at all', text: 'a\nb\nc', expected: ['a\n', 'b\n', 'c'] },
    { name: 'empty string', text: '', expected: [] },
    { name: 'CRLF is not a recognised split point on its own (only bare \\n splits)', text: 'a\r\nb\n', expected: ['a\r\n', 'b\n'] },
  ])('splitLinesKeepingTerminators($name)', ({ text, expected }) => {
    expect(splitLinesKeepingTerminators(text)).toEqual(expected);
  });

  it.each([
    { name: 'whole range', text: 'a\nb\nc\n', start: 0, end: 2, expected: 'a\nb\nc\n' },
    { name: 'sub-range', text: 'a\nb\nc\n', start: 1, end: 1, expected: 'b\n' },
    { name: 'range past the end degrades to Array.slice, not a throw', text: 'a\nb\n', start: 5, end: 9, expected: '' },
  ])('sliceLines($name)', ({ text, start, end, expected }) => {
    expect(sliceLines(text, start, end)).toBe(expected);
  });
});

// ═════════════════ shared trigger harness for Parts B2, C and D ═══════════════

const SHELL_DEPS_TEMPLATE = {
  reportFailure: (msg: string) => void failures.push(msg),
  getAutocompleteEndpoint: () => autocompleteConfig.endpoint,
  getAutocompleteModel: () => autocompleteConfig.model,
  getAutocompleteBackend: () => autocompleteConfig.backend,
  getAutocompleteApiKey: () => autocompleteConfig.apiKey,
};

const failures: string[] = [];
const autocompleteConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:7b',
  backend: 'ollama',
  apiKey: undefined as string | undefined,
};

function makeContext(): vscodeTypes.ExtensionContext {
  return { subscriptions: [] } as unknown as vscodeTypes.ExtensionContext;
}

function makeSourcePort(initial: NextEditSource = 'off'): NextEditConfigPort {
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

function sourceOf(toggles?: ToggleState): NextEditSource {
  if (toggles?.next) return 'dedicated';
  if (toggles?.generic) return 'generic';
  return 'off';
}

async function setupShell(toggles: ToggleState, deps: NextEditShellDeps = SHELL_DEPS_TEMPLATE): Promise<void> {
  const guard = await NextEditGuard.hydrate(makeSourcePort(sourceOf(toggles)), {
    reportFailure: SHELL_DEPS_TEMPLATE.reportFailure,
  });
  registerTalariaNextEdit(makeContext(), guard, deps);
}

function makeDoc(options: { uri?: string; path?: string; scheme?: string; text: string }): FakeDocument {
  const uri = options.uri ?? 'file:///home/u/project/a.ts';
  const path = options.path ?? '/home/u/project/a.ts';
  const scheme = options.scheme ?? 'file';
  const { text } = options;
  const lines = text.split(/\r\n|\n/);
  return {
    uri: { scheme, path, fsPath: path, toString: () => uri },
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
    setDecorations: () => {},
    revealRange: () => {},
  };
}

/** Fires the ONE debounced edit-burst trigger and settles it. Mirrors
 *  `shell.vscode.test.ts`'s own `fireTrigger` (same debounce constant). */
async function fireTrigger(): Promise<void> {
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

function resetSpies(): void {
  resetHost();
  failures.length = 0;
  backendSpy.constructed.length = 0;
  backendSpy.predicts.length = 0;
  mintCalls.length = 0;
  backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN\n', stopReason: 'stop' as const });
  autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
  autocompleteConfig.model = 'qwen2.5-coder:7b';
  autocompleteConfig.backend = 'ollama';
  autocompleteConfig.apiKey = undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSpies();
});

afterEach(() => {
  vi.useRealTimers();
});

// ══════════════ Part B2 — ensureTrailingNewline / stripLineTerminator / ═══════
// ══════════════ extractRegionRange / toWorkspaceRelativePosixPath ═════════════
//
// INDIRECT (see the file header's "HONEST GAP" note): each row drives ONE
// trigger through `registerTalariaNextEdit` and reads the exact runtime
// `NextEditRequest` the (mocked) backend's `predict()` receives —
// `buildRequest` (shell.vscode.ts:1524-1591) assigns:
//   fileContext:   ensureTrailingNewline(docWindow.text)      — :1580
//   docText:       docWindow.text                             — :1581 (UNwrapped: the contrast case)
//   preEditRegion: extractRegionRange(preEditDocText, ...)    — :1543-1544, composing
//                  splitLinesKeepingTerminators + sliceLines + stripLineTerminator (:605-609)
//   region.filepath: toWorkspaceRelativePosixPath(document.uri) — :1569, :557-559

describe('golden: ensureTrailingNewline / docText contrast (shell.vscode.ts:568-570, :1580-1581)', () => {
  it('a document with NO trailing newline gets one ONLY on fileContext, never on docText', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\nconst b = 2;' }), 1);
    await setupShell({ next: false, generic: true });
    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    const req = backendSpy.predicts[0]?.req;
    expect(req?.fileContext).toBe('const a = 1;\nconst b = 2;\n');
    expect(req?.fileContext.endsWith('\n')).toBe(true);
    expect(req?.docText).toBe('const a = 1;\nconst b = 2;');
    expect(req?.docText.endsWith('\n')).toBe(false);
  });

  it('a document that ALREADY ends in a newline is left byte-identical (the no-op branch)', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\n' }), 0);
    await setupShell({ next: false, generic: true });
    await fireTrigger();

    const req = backendSpy.predicts[0]?.req;
    expect(req?.fileContext).toBe('const a = 1;\n');
    expect(req?.fileContext).toBe(req?.docText);
  });
});

describe('golden: toWorkspaceRelativePosixPath (shell.vscode.ts:555-559)', () => {
  it('a Windows-style relative path from vscode.workspace.asRelativePath is converted to POSIX', async () => {
    host.relativePathOverride = 'src\\components\\a.ts';
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\n' }), 0);
    await setupShell({ next: false, generic: true });
    await fireTrigger();

    expect(backendSpy.predicts[0]?.req.region.filepath).toBe('src/components/a.ts');
  });

  it('an already-POSIX relative path passes through unchanged', async () => {
    host.relativePathOverride = 'src/components/a.ts';
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\n' }), 0);
    await setupShell({ next: false, generic: true });
    await fireTrigger();

    expect(backendSpy.predicts[0]?.req.region.filepath).toBe('src/components/a.ts');
  });
});

describe('golden: extractRegionRange + stripLineTerminator (shell.vscode.ts:568-609)', () => {
  const URI = 'file:///home/u/project/a.ts';
  const PATH = '/home/u/project/a.ts';

  /** Seeds the edit-tracker's shadow with `preEditText` (via a visible editor
   *  present BEFORE the shell registers, exactly as `createEditTrackerAdapter`
   *  requires — mirrors `shell.vscode.test.ts`'s own `runTriggerCapturingWire`
   *  recipe), then fires one trigger against `documentText`. */
  async function captureWithShadow(documentText: string, preEditText: string, cursorLine: number): Promise<NextEditRequest | undefined> {
    host.visibleTextEditors.push(makeEditor(makeDoc({ uri: URI, path: PATH, text: preEditText }), cursorLine));
    host.activeTextEditor = makeEditor(makeDoc({ uri: URI, path: PATH, text: documentText }), cursorLine);
    await setupShell({ next: true, generic: false });
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
    await fireTrigger();
    return backendSpy.predicts[0]?.req;
  }

  it('span reaches the document\'s phantom trailing-newline line: the terminator is NOT stripped (endLine >= lineCount)', async () => {
    // 4 vscode-reported lines ("line0","line1","line2",""), span [0,3] — the
    // function's OWN splitLinesKeepingTerminators sees only 3 REAL chunks, so
    // endLine(3) < lineCount(3) is false and extractRegionRange returns the
    // shadow untouched.
    const text = 'line0\nline1\nline2\n';
    const req = await captureWithShadow(text, text, 1);
    expect(req?.preEditRegion).toBe('line0\nline1\nline2\n');
  });

  it('ordinary LF strip: span stays within real content lines, ONE trailing \\n is removed', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `L${i}`);
    const text = `${lines.join('\n')}\n`; // 25 real lines, vscode-reported lineCount 26
    const req = await captureWithShadow(text, text, 5); // span [0,15] — well inside the 25 real lines
    const expected = `${lines.slice(0, 16).join('\n')}`; // L0..L15, no trailing terminator
    expect(req?.preEditRegion).toBe(expected);
  });

  it('CRLF tail on the span\'s own last line: stripLineTerminator removes BOTH bytes, no stray \\r survives', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `L${i}`);
    const shadowLines = [...lines];
    // splitLinesKeepingTerminators only ever splits on a bare '\n' — a '\r'
    // immediately before it rides along in the SAME chunk, so this alone is
    // enough to make line 15's own chunk end "...\r\n".
    const text = `${shadowLines.slice(0, 15).join('\n')}\n${shadowLines[15]}\r\n${shadowLines.slice(16).join('\n')}\n`;
    const req = await captureWithShadow(text, text, 5); // span [0,15]
    const expected = `${lines.slice(0, 16).join('\n')}`;
    expect(req?.preEditRegion).toBe(expected);
    expect(req?.preEditRegion).not.toMatch(/\r/);
  });

  it('a genuinely blank last line in the span survives as ONE trailing \\n, never stripped away entirely', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `L${i}`);
    // Line 15 (the span's own last line) is empty content.
    const withBlank = [...lines];
    withBlank[15] = '';
    const text = `${withBlank.join('\n')}\n`;
    const req = await captureWithShadow(text, text, 5); // span [0,15]
    expect(req?.preEditRegion?.endsWith('\n')).toBe(true);
    expect(req?.preEditRegion?.endsWith('\n\n')).toBe(false);
    expect(req?.preEditRegion).toBe(`${lines.slice(0, 15).join('\n')}\n`);
  });

  it('no shadow at all (preEditDocText === null): the field is null, extractRegionRange never runs', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ uri: URI, path: PATH, text: 'a\nb\nc\n' }), 1);
    await setupShell({ next: true, generic: false });
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
    await fireTrigger();
    expect(backendSpy.predicts[0]?.req.preEditRegion).toBeNull();
  });
});

// ════════════════════ Part C — route resolution (indirect) ════════════════════
//
// `resolveRoute` (shell.vscode.ts:488-536) is module-private. Each row below
// drives ONE trigger and reads the route PROJECTED onto the (mocked)
// backend's construction options (`transport`/`apiBase`/`model`/`apiKey`),
// plus whichever one-shot message the route resolution surfaces — the same
// two things `resolveReportedRoute` (:1481-1517) does with a `RouteResolution`
// before anything downstream ever sees it. `DEFAULT_NEXT_EDIT_ENDPOINTS`
// (:80-83) and the info/warning copy are re-grounded by reading the source,
// not invented.

interface RouteRow {
  name: string;
  mode: 'next' | 'generic';
  nextConfig?: { backend?: string; endpoint?: string; model?: string };
  genericConfig?: { backend?: string; endpoint?: string; model?: string; apiKey?: string };
  expectConstructed: Partial<NextEditBackendOptions> | null;
  expectApiKeyPresent?: boolean;
  expectWarning?: string;
}

const ROWS: readonly RouteRow[] = [
  {
    name: 'next / ollama / empty endpoint falls back to the ollama default',
    mode: 'next',
    nextConfig: { backend: 'ollama', endpoint: '', model: 'sweep-next-edit-v2-7B' },
    expectConstructed: { transport: 'ollama', apiBase: 'http://127.0.0.1:11434', model: 'sweep-next-edit-v2-7B' },
    expectApiKeyPresent: false,
  },
  {
    name: 'next / openai-compat / empty endpoint falls back to the openai-compat default',
    mode: 'next',
    nextConfig: { backend: 'openai-compat', endpoint: '', model: 'sweep-next-edit-v2-7B' },
    expectConstructed: { transport: 'openai-compat', apiBase: 'http://127.0.0.1:8000', model: 'sweep-next-edit-v2-7B' },
    expectApiKeyPresent: false,
  },
  {
    name: 'next / a REMOTE endpoint fires the one-shot observational WARNING (not an info toast)',
    mode: 'next',
    nextConfig: { backend: 'ollama', endpoint: 'http://192.0.2.10:11434', model: 'sweep-next-edit-v2-7B' },
    expectConstructed: { transport: 'ollama', apiBase: 'http://192.0.2.10:11434', model: 'sweep-next-edit-v2-7B' },
    expectWarning:
      'Next Edit is using a REMOTE endpoint for its dedicated model (talaria.nextEdit.endpoint). ' +
      'Next Edit sends no credential of its own. If this endpoint requires authentication, say so — ' +
      'it would need its own key, never the autocomplete key.',
  },
  {
    name: 'next / empty model: no route at all, the actionable one-shot note fires',
    mode: 'next',
    nextConfig: { backend: 'ollama', endpoint: '', model: '' },
    expectConstructed: null,
    expectWarning: NEXT_EDIT_MODEL_UNSET_NOTE,
  },
  {
    name: 'generic / ollama backend, no key',
    mode: 'generic',
    genericConfig: { backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' },
    expectConstructed: { transport: 'ollama', apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b' },
    expectApiKeyPresent: false,
  },
  {
    name: 'generic / ollama backend, WITH a key: the key rides the route',
    mode: 'generic',
    genericConfig: { backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', apiKey: 'sk-test-key' },
    expectConstructed: { transport: 'ollama', apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', apiKey: 'sk-test-key' },
    expectApiKeyPresent: true,
  },
  {
    name: 'generic / vllm backend derives openai-compat',
    mode: 'generic',
    genericConfig: { backend: 'vllm', endpoint: 'http://127.0.0.1:8000', model: 'm' },
    expectConstructed: { transport: 'openai-compat', apiBase: 'http://127.0.0.1:8000', model: 'm' },
  },
  {
    name: 'generic / llamacpp backend derives openai-compat',
    mode: 'generic',
    genericConfig: { backend: 'llamacpp', endpoint: 'http://127.0.0.1:8000', model: 'm' },
    expectConstructed: { transport: 'openai-compat', apiBase: 'http://127.0.0.1:8000', model: 'm' },
  },
  {
    name: 'generic / codestral backend: UNSUPPORTED, no route, byte-exact refusal message',
    mode: 'generic',
    genericConfig: { backend: 'codestral', endpoint: 'http://127.0.0.1:8000', model: 'm' },
    expectConstructed: null,
    expectWarning: genericUnsupportedBackendMessage('codestral'),
  },
  {
    name: 'generic / openai-compat backend: ALSO unsupported (re-templates server-side)',
    mode: 'generic',
    genericConfig: { backend: 'openai-compat', endpoint: 'http://127.0.0.1:8000', model: 'm' },
    expectConstructed: null,
    expectWarning: genericUnsupportedBackendMessage('openai-compat'),
  },
  {
    name: 'generic / empty endpoint: silently unconfigured — no message at all',
    mode: 'generic',
    genericConfig: { backend: 'ollama', endpoint: '', model: 'm' },
    expectConstructed: null,
  },
  {
    name: 'generic / empty model: silently unconfigured — no message at all',
    mode: 'generic',
    genericConfig: { backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: '' },
    expectConstructed: null,
  },
];

describe('golden: route resolution, projected through the backend construction (shell.vscode.ts:488-536, indirect)', () => {
  it.each(ROWS)('$name', async (row) => {
    if (row.mode === 'next') {
      host.settings.set('talaria.nextEdit.backend', row.nextConfig?.backend ?? 'ollama');
      host.settings.set('talaria.nextEdit.endpoint', row.nextConfig?.endpoint ?? '');
      host.settings.set('talaria.nextEdit.model', row.nextConfig?.model ?? '');
    } else {
      autocompleteConfig.backend = row.genericConfig?.backend ?? 'ollama';
      autocompleteConfig.endpoint = row.genericConfig?.endpoint ?? '';
      autocompleteConfig.model = row.genericConfig?.model ?? '';
      autocompleteConfig.apiKey = row.genericConfig?.apiKey;
    }
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\nconst b = 2;\n' }), 0);
    await setupShell({ next: row.mode === 'next', generic: row.mode === 'generic' });
    await fireTrigger();

    if (row.expectConstructed === null) {
      expect(backendSpy.constructed).toHaveLength(0);
    } else {
      expect(backendSpy.constructed).toHaveLength(1);
      const opts = backendSpy.constructed[0];
      expect(opts?.transport).toBe(row.expectConstructed.transport);
      expect(opts?.apiBase).toBe(row.expectConstructed.apiBase);
      expect(opts?.model).toBe(row.expectConstructed.model);
      if (row.expectApiKeyPresent === true) {
        expect(opts?.apiKey).toBe(row.expectConstructed.apiKey);
      } else if (row.expectApiKeyPresent === false) {
        expect('apiKey' in (opts as object)).toBe(false);
      }
    }

    if (row.expectWarning !== undefined) {
      expect(failures).toContain(row.expectWarning);
      expect(host.warnings).toContain(row.expectWarning);
    } else {
      // The two deliberately-silent rows (generic-unconfigured): NOTHING is
      // surfaced — confirmed here so "silent" stays silent through refactors.
      expect(failures).toEqual([]);
      expect(host.warnings).toEqual([]);
    }
  });
});

// ═════════════════ requestNextEditToggle (exported — direct) ══════════════════
// The webview toggle entry point (shell.vscode.ts:400-422). Directly
// importable, so pinned straight, no indirection needed.

describe('golden: requestNextEditToggle byte-exact copy (shell.vscode.ts:400-422)', () => {
  async function makeGuard(): Promise<NextEditGuard> {
    return NextEditGuard.hydrate(makeSourcePort('off'), { reportFailure: SHELL_DEPS_TEMPLATE.reportFailure });
  }

  it('generic toggle-ON against an UNSUPPORTED FIM backend is refused BEFORE the guard ratifies anything', async () => {
    autocompleteConfig.backend = 'codestral';
    const guard = await makeGuard();
    await expect(
      requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS_TEMPLATE),
    ).rejects.toThrow(genericUnsupportedBackendMessage('codestral'));

    expect(failures).toContain(genericUnsupportedBackendMessage('codestral'));
    expect(host.warnings).toContain(genericUnsupportedBackendMessage('codestral'));
    expect(host.infos).toEqual([]);
    expect(guard.getState()).toEqual({ next: false, generic: false }); // never ratified
  });

  it('generic toggle-ON against a SUPPORTED FIM backend is accepted and shows GENERIC_SETUP_NOTE exactly once', async () => {
    autocompleteConfig.backend = 'ollama';
    const guard = await makeGuard();
    const state = await requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS_TEMPLATE);

    expect(state).toEqual({ next: false, generic: true });
    expect(host.infos).toEqual([GENERIC_SETUP_NOTE]);
  });

  it('a `next` toggle-ON never shows the generic setup note', async () => {
    const guard = await makeGuard();
    await requestNextEditToggle(guard, { source: 'next', on: true }, SHELL_DEPS_TEMPLATE);
    expect(host.infos).toEqual([]);
  });
});

// ═══════════════════ Part D — byte-exact failure copy (indirect) ══════════════
//
// `surfaceTriggerFailure` (shell.vscode.ts:1287-1372) is a PRIVATE method —
// exercised, exactly as the brief anticipates for this surface, through the
// shell's own failure path: a rejecting `backendSpy.respond` for each error
// class the method distinguishes, reading the exact toast text back off
// `vscode.window.showWarningMessage` (`host.warnings`) and the log line off
// `deps.reportFailure` (`failures`). Strings below are copied byte-for-byte
// from the current source, not re-typed from memory.

describe('golden: surfaceTriggerFailure byte-exact copy (shell.vscode.ts:1287-1372, indirect)', () => {
  async function fireOnceWithError(err: unknown): Promise<void> {
    backendSpy.respond = () => Promise.reject(err);
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\nconst b = 2;\n' }), 0);
    autocompleteConfig.endpoint = 'http://example.test:8000';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    await setupShell({ next: false, generic: true });
    await fireTrigger();
  }

  it('InsecureTransportError — rebuilt copy, never echoes the throw site', async () => {
    await fireOnceWithError(new InsecureTransportError('CWE-319: refusing http://example.test'));
    expect(host.warnings).toEqual([
      'Next Edit is paused: refusing to send credentials over cleartext HTTP to a remote host. Use https, or point the endpoint at a loopback address (127.0.0.1/localhost).',
    ]);
  });

  it('BackendHttpError 404 — names the model + the model setting', async () => {
    await fireOnceWithError(new BackendHttpError('not found', 404, 'Not Found'));
    expect(host.warnings).toEqual([
      'Next Edit is paused: the ollama server at example.test:8000 does not serve the model "qwen2.5-coder:7b" (404). Check "talaria.autocomplete.model".',
    ]);
  });

  it('BackendHttpError 401 — auth copy, names the endpoint setting', async () => {
    await fireOnceWithError(new BackendHttpError('unauthorized', 401, 'Unauthorized'));
    expect(host.warnings).toEqual([
      'Next Edit is paused: the ollama server at example.test:8000 rejected the request (401 Unauthorized). Check that "talaria.autocomplete.endpoint" points at a server this machine is authorized to use.',
    ]);
  });

  it('BackendHttpError 400 — dialect/context-length copy', async () => {
    await fireOnceWithError(new BackendHttpError('bad request', 400, 'Bad Request'));
    expect(host.warnings).toEqual([
      "Next Edit is paused: the server at example.test:8000 rejected the request (400 Bad Request). This usually means the configured transport doesn't match the server's API dialect — it can also mean the prompt exceeded the server's context length.",
    ]);
  });

  it('BackendHttpError other status — generic HTTP copy', async () => {
    await fireOnceWithError(new BackendHttpError('server error', 500, 'Internal Server Error'));
    expect(host.warnings).toEqual([
      'Next Edit is paused: the ollama server at example.test:8000 returned 500 Internal Server Error. Check "talaria.autocomplete.endpoint".',
    ]);
  });

  it('NextEditMintRejectionError — technical log line ONLY, never a toast (the badge/notice surface owns the human copy)', async () => {
    await fireOnceWithError(new NextEditMintRejectionError('secret'));
    expect(host.warnings).toEqual([]);
    expect(failures).toEqual([
      'Next Edit skipped for this file: its content cannot be sent safely (rule: secret). No request was sent.',
    ]);
  });

  it('StreamIdleTimeoutError falls into the `unreachable` fallback arm (R1-7) — never misdiagnosed as a mint rejection', async () => {
    await fireOnceWithError(new StreamIdleTimeoutError());
    expect(host.warnings).toEqual([
      'Next Edit is paused: the request to the ollama server at example.test:8000 failed. Check "talaria.autocomplete.endpoint", and that the server is running.',
    ]);
  });

  it('a bare unrecognised Error ALSO falls into the same `unreachable` fallback', async () => {
    await fireOnceWithError(new Error('ECONNREFUSED'));
    expect(host.warnings).toEqual([
      'Next Edit is paused: the request to the ollama server at example.test:8000 failed. Check "talaria.autocomplete.endpoint", and that the server is running.',
    ]);
  });
});

// ═══════════════════ perturbation sanity — see the F3-1 report ════════════════
// (This describe block intentionally stays empty. The characterization-sanity
// check the brief requires — temporarily break one production surface, watch
// a golden fail, then revert — is a one-off manual step performed while
// building this file, not a permanent test. Its outcome is recorded in
// `.superpowers/sdd/r2-defer-F3-1-report.md`.)
