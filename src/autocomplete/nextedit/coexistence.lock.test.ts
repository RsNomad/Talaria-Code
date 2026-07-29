import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type * as vscodeTypes from 'vscode';
import type { NextEditBackendOptions } from './backend';
import type { NextEditModelOutput, RenderedNextEditPrompt } from './formats/types';
import { must } from '../../testing/must';

/**
 * Task 14 — THE coexistence + interlock locks (R1/R2/R3/R5 + the `raw`
 * polarity). This file is the INVARIANT HOME for those rules: several of them
 * are also exercised by the behavioural suites (`mode.test.ts`'s 16-row table,
 * `shell.vscode.test.ts`'s gate sequence, `guard.test.ts`'s lighter key
 * sweep). That duplication is DELIBERATE — those files prove the behaviour of
 * the module they belong to, this one pins the rule itself so a future wave
 * cannot dissolve it by refactoring any single module.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LOCK HERE STRIPS COMMENTS AND PROVES ITS OWN REACH
 * ---------------------------------------------------------------------------
 * Four consecutive tasks in this plan shipped a guard that passed while
 * proving nothing, each caught only by a reviewer deliberately breaking the
 * source:
 *
 *  - Task 11: a source-scan lock matched patterns against RAW file content, so
 *    `backend.ts`'s own doc comment — which spells `assertSecureAuthTransport(
 *    url, !!apiKey)` WITH parentheses inside a `//` — satisfied it. Deleting
 *    both real guard calls left the lock 12/12 green.
 *  - Task 12: a gate was "proven" by a DIFFERENT mechanism (the mint) refusing
 *    the same input, so mutating the gate to `if (false && ...)` left 48/48
 *    green; and an abort test survived removing the abort because the mocked
 *    response never resolved either way.
 *  - Task 13: a render-time reconcile was deleted outright — 370/370 green.
 *
 * A lock that cannot go RED is WORSE than no lock: it advertises a safety
 * property that is not there. So every source-scan lock below obeys three
 * rules, and every one of them was verified by planting a real violation,
 * watching the RED, and restoring byte-for-byte:
 *
 *  1. **Comments are stripped before matching.** A pattern run against raw
 *     content is satisfiable by prose. The `raw`-polarity lock below is the
 *     sharpest example in the repo: `backends/OllamaFimBackend.ts`'s doc
 *     comment literally contains the string `raw: true` while the file's real
 *     body correctly never sends it — an unstripped scan would report the
 *     exact OPPOSITE of the truth. That inversion is asserted explicitly.
 *  2. **Reach is proven, not assumed.** A directory walker that collects zero
 *     files passes forever. Every scan asserts it really collected the tree it
 *     claims to cover (named DISTANT sentinel files + a count floor), and
 *     every predicate is fired against a violation planted in a DISTANT file —
 *     the same technique the Task 11 reviewer used to prove reach via
 *     `backends/OllamaFimBackend.ts` and `context/ringBuffer.ts`.
 *  3. **Equality over containment** wherever a dropped element inside a longer
 *     value would be the drift worth catching — most importantly the R3
 *     keybinding `when` clauses, which are compared with `toBe`, never
 *     `toContain`.
 *
 * All planted-violation probes are IN-MEMORY: a synthetic entry appended to
 * the REAL, already-collected file list. Nothing is ever written to disk
 * inside a scanned directory — disk probes are a known CI-flake source in this
 * repo (`purityScan.ts`'s own bounded-ENOENT-retry doc records the races they
 * caused).
 */

// ─────────────────────────── the vscode harness ──────────────────────────────

interface FakePosition {
  line: number;
  character: number;
}

interface FakeDocument {
  uri: { scheme: string; path: string; fsPath: string; toString(): string };
  version: number;
  lineCount: number;
  languageId: string;
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
  contentChanges: {
    range: { start: FakePosition; end: FakePosition };
    text: string;
  }[];
}

/**
 * The same minimal fake-module discipline `shell.vscode.test.ts` and
 * `config.test.ts` use: a plain object declared BEFORE the (hoisted) factory
 * closes over it. Spies are plain functions pushing into arrays, never
 * `vi.fn()` — `vi.fn()` swallows unhandled rejections, which is exactly how a
 * vacuous assertion gets built (Global Constraints, "Test hygiene").
 */
const host = {
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as { command: string; args: unknown[] }[],
  docChangeHandlers: [] as ((e: FakeChangeEvent) => void)[],
  activeEditorHandlers: [] as ((editor: FakeEditor | undefined) => void)[],
  windowStateHandlers: [] as ((s: { focused: boolean }) => void)[],
  activeTextEditor: undefined as FakeEditor | undefined,
  isTrusted: true,
  applyEditResult: true,
  warnings: [] as string[],
  infos: [] as string[],
  settings: new Map<string, unknown>(),
  decorationCalls: [] as { type: string; ranges: unknown[] }[],
};

function resetHost(): void {
  host.registeredCommands.clear();
  host.executed.length = 0;
  host.docChangeHandlers.length = 0;
  host.activeEditorHandlers.length = 0;
  host.windowStateHandlers.length = 0;
  host.activeTextEditor = undefined;
  host.isTrusted = true;
  host.applyEditResult = true;
  host.warnings.length = 0;
  host.infos.length = 0;
  host.settings.clear();
  host.decorationCalls.length = 0;
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
  class FakePositionCls {
    constructor(public readonly line: number, public readonly character: number) {}
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
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        host.registeredCommands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        host.executed.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    window: {
      createTextEditorDecorationType: () => ({ id: `decoration-${decorationSeq++}`, dispose() {} }),
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
      onDidChangeActiveTextEditor: (cb: (editor: FakeEditor | undefined) => void) => {
        host.activeEditorHandlers.push(cb);
        return { dispose() {} };
      },
      onDidChangeWindowState: (cb: (s: { focused: boolean }) => void) => {
        host.windowStateHandlers.push(cb);
        return { dispose() {} };
      },
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
      visibleTextEditors: [],
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
      applyEdit: (edit: FakeWorkspaceEdit) => {
        void edit;
        return Promise.resolve(host.applyEditResult);
      },
      asRelativePath: (uri: { toString(): string }) => uri.toString(),
      get isTrusted() {
        return host.isTrusted;
      },
    },
    ThemeColor: class {
      constructor(public readonly id: string) {}
    },
    Range: FakeRange,
    Position: FakePositionCls,
    WorkspaceEdit: FakeWorkspaceEdit,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Disposable: {
      from: (...items: { dispose(): void }[]) => ({ dispose: () => items.forEach((i) => i.dispose()) }),
    },
  };
});

/**
 * Backend spy — the R2 locks below are about WHETHER a request is built at all
 * and WHOSE signal gets aborted, never about the wire (`backend.test.ts` owns
 * that). `respond` is a plain function returning a real Promise.
 */
const backendSpy = {
  predicts: [] as { rendered: RenderedNextEditPrompt; signal: AbortSignal }[],
  respond: (_signal: AbortSignal): Promise<NextEditModelOutput> =>
    Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const }),
};

vi.mock('./backend', () => ({
  NextEditHttpBackend: class {
    constructor(_opts: NextEditBackendOptions) {}
    predict(
      _req: unknown,
      rendered: RenderedNextEditPrompt,
      signal: AbortSignal,
    ): Promise<NextEditModelOutput> {
      backendSpy.predicts.push({ rendered, signal });
      return backendSpy.respond(signal);
    }
  },
}));

import { registerTalariaNextEdit, fimActivityRelay } from './shell.vscode';
import { NextEditGuard, NEXT_EDIT_TOGGLES_KEY } from './guard';
import { applyToggleRequest, type ToggleRequest, type ToggleState } from './mode';
import { collectNonTestTsSources, type ScannableSource } from '../../host/purityScan';

// ───────────────────────────── scan infrastructure ───────────────────────────

const NEXTEDIT_DIR = __dirname;
const AUTOCOMPLETE_ROOT = join(NEXTEDIT_DIR, '..');
const SRC_ROOT = join(NEXTEDIT_DIR, '..', '..');
const REPO_ROOT = join(NEXTEDIT_DIR, '..', '..', '..');

/**
 * Strips block and line comments before matching. Byte-identical to
 * `reuseLocks.test.ts`'s helper (Task 11's Finding-1 fix), re-declared here
 * rather than imported because that file exports nothing — the same
 * "each lock file declares its own blunt scanner" posture every purity guard
 * in this repo already takes (`purityScan.ts`'s module doc).
 *
 * DOCUMENTED LIMITATION, carried verbatim and deliberately NOT made worse: it
 * is crude and has NO string-literal awareness, so a `//` sequence inside a
 * string literal (e.g. a URL) truncates that line for scanning purposes. That
 * is acceptable for a blunt token-presence lock — it can only ever cause a
 * scan to see LESS text, i.e. it is not a way to smuggle a real violation past
 * a lock unless the violation is itself written inside a string literal after
 * a `//`. No lock below is defeated by that: each one's planted-violation
 * proof exercises the predicate on ordinary code shapes.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** A collected tree plus its stripped text, so every lock scans real code. */
interface StrippedSource {
  readonly file: string;
  readonly content: string;
}

function loadStripped(root: string): StrippedSource[] {
  return collectNonTestTsSources(root).map((f) => ({ file: f.file, content: stripComments(f.content) }));
}

/** Files whose STRIPPED text matches `pattern`, as POSIX-relative paths. */
function filesMatching(sources: readonly StrippedSource[], pattern: RegExp): string[] {
  return sources.filter((f) => pattern.test(f.content)).map((f) => f.file);
}

/** Total occurrence count across the tree — catches a SECOND call in the SAME file. */
function countMatches(sources: readonly StrippedSource[], pattern: RegExp): number {
  const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`);
  let total = 0;
  for (const source of sources) {
    total += (source.content.match(global) ?? []).length;
  }
  return total;
}

/**
 * REACH PROOF for the `src/`-wide scans. A walker that silently collected
 * nothing (a wrong root, a renamed directory, a future `readdirSync` option
 * change) would make every "no offenders" assertion below pass forever. These
 * sentinels are deliberately DISTANT from `nextedit/` — the same files the
 * Task 11 reviewer used to prove reach — plus the two composition roots the
 * R1/R5 locks name as the single legitimate call sites.
 */
const SRC_REACH_SENTINELS = [
  'extension.ts',
  'autocomplete/index.ts',
  'autocomplete/provider.ts',
  'autocomplete/backends/OllamaFimBackend.ts',
  'autocomplete/context/ringBuffer.ts',
  'autocomplete/nextedit/guard.ts',
  'autocomplete/nextedit/shell.vscode.ts',
  'host/TalariaViewProvider.ts',
] as const;

describe('scan reach — every src/-wide lock below really walks the whole tree', () => {
  it('collects every distant sentinel file, and a plausible total (a zero-file walk would rubber-stamp everything)', () => {
    const files = loadStripped(SRC_ROOT).map((f) => f.file);
    for (const sentinel of SRC_REACH_SENTINELS) {
      expect(files, `reach sentinel missing: ${sentinel}`).toContain(sentinel);
    }
    // The tree held 170 non-test `.ts` files when this lock was written. The
    // floor is deliberately loose (files come and go) but far above zero, and
    // far above the ~13 a mistakenly `nextedit/`-rooted walk would return.
    expect(
      files.length,
      'reach floor: every src/-wide lock below depends on this walk covering the real tree, not a near-empty one',
    ).toBeGreaterThan(120);
  });

  it('test files are EXCLUDED from the walk — this lock file names every banned token itself and must not self-trip', () => {
    const files = loadStripped(SRC_ROOT).map((f) => f.file);
    expect(
      files,
      'this very file must not appear in the walk, or every lock below would self-trip on its own probe strings',
    ).not.toContain('autocomplete/nextedit/coexistence.lock.test.ts');
    const leaked = files.filter((f) => f.endsWith('.test.ts'));
    expect(leaked, 'the walk must exclude ALL .test.ts files — these leaked through the filter').toEqual([]);
  });

  it('the comment stripper is not a no-op (sanity check on the mechanism every lock below depends on)', () => {
    expect(
      stripComments('const o = { raw: true };').includes('raw: true'),
      'plain code must survive stripping unchanged',
    ).toBe(true);
    expect(
      stripComments('// never send raw: true here\nconst o = {};').includes('raw: true'),
      'a line comment must be stripped — otherwise prose satisfies every source-scan lock in this file',
    ).toBe(false);
    expect(
      stripComments('/* raw: true is FIM-forbidden */\nconst o = {};').includes('raw: true'),
      'a block comment must be stripped — otherwise prose satisfies every source-scan lock in this file',
    ).toBe(false);
  });
});

// ══════════════════════════════════ R1 ═══════════════════════════════════════

/**
 * Global Constraints, verbatim: "Exactly ONE `InlineCompletionItemProvider`.
 * Forever." — `@types/vscode/index.d.ts:14859-14861`: multiple providers "are
 * asked in parallel and the results are merged", so a second registration
 * would put next-edit and FIM on the same surface, competing. Next-edit
 * reaches the screen through decorations + context keys + keybindings instead.
 */
const REGISTER_INLINE_PROVIDER = /\bregisterInlineCompletionItemProvider\s*\(/;
const R1_SOLE_CALL_SITE = 'autocomplete/index.ts';

describe('R1 LOCK: registerInlineCompletionItemProvider is called EXACTLY once across src/', () => {
  it('exactly one file calls it, and it is autocomplete/index.ts', () => {
    const sources = loadStripped(SRC_ROOT);
    // EQUALITY, not containment: a second call site anywhere fails this.
    expect(
      filesMatching(sources, REGISTER_INLINE_PROVIDER),
      'R1: registerInlineCompletionItemProvider must be called from exactly ONE file (autocomplete/index.ts) — a second or moved call site would compete with FIM for the same inline-completion surface',
    ).toEqual([R1_SOLE_CALL_SITE]);
  });

  it('and it is called exactly ONCE in total — a second call in the SAME file is caught too', () => {
    expect(
      countMatches(loadStripped(SRC_ROOT), REGISTER_INLINE_PROVIDER),
      'R1: registerInlineCompletionItemProvider must be called exactly once in the whole tree, including a second call inside its own sole file',
    ).toBe(1);
  });

  it('RED-first proof: the same predicate flags a registration planted in a DISTANT module', () => {
    const withViolation: StrippedSource[] = [
      ...loadStripped(SRC_ROOT),
      {
        file: 'host/__second_provider_probe__.ts',
        content: 'vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, other);',
      },
    ];
    expect(
      filesMatching(withViolation, REGISTER_INLINE_PROVIDER),
      'R1 RED-first proof failed: a planted second call site did not break the sole-call-site equality — the predicate is not reaching distant files',
    ).not.toEqual([R1_SOLE_CALL_SITE]);
    expect(
      filesMatching(withViolation, REGISTER_INLINE_PROVIDER),
      'R1 RED-first proof failed: the planted violation file was not flagged at all',
    ).toContain('host/__second_provider_probe__.ts');
    expect(
      countMatches(withViolation, REGISTER_INLINE_PROVIDER),
      'R1 RED-first proof failed: expected the ORIGINAL call plus the planted one to total 2',
    ).toBe(2);
  });

  it('negative control: a comment DESCRIBING the ban does not count as a call', () => {
    const withCommentOnly: StrippedSource[] = [
      ...loadStripped(SRC_ROOT),
      {
        file: 'host/__comment_only_probe__.ts',
        content: stripComments(
          '// next-edit never calls registerInlineCompletionItemProvider(...)\nconst x = 1;',
        ),
      },
    ];
    expect(
      filesMatching(withCommentOnly, REGISTER_INLINE_PROVIDER),
      'R1 negative control failed: prose naming the banned call must not itself count as a call site',
    ).toEqual([R1_SOLE_CALL_SITE]);
  });
});

// ══════════════════════════════════ R2 ═══════════════════════════════════════

const autocompleteConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:7b',
  backend: 'ollama',
  // W5.2 Task 2 — this suite is about coexistence, not credentials, so it runs
  // keyless. Held as fixture STATE rather than a hard-coded `undefined` in the
  // accessor below so a future coexistence case can set it without first having
  // to re-plumb the deps object.
  apiKey: undefined as string | undefined,
};
const failures: string[] = [];

const SHELL_DEPS = {
  reportFailure: (msg: string) => void failures.push(msg),
  getAutocompleteEndpoint: () => autocompleteConfig.endpoint,
  getAutocompleteModel: () => autocompleteConfig.model,
  getAutocompleteBackend: () => autocompleteConfig.backend,
  getAutocompleteApiKey: () => autocompleteConfig.apiKey,
};

function makeDoc(): FakeDocument {
  const text = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join('\n');
  const lines = text.split('\n');
  return {
    uri: {
      scheme: 'file',
      path: '/w/a.ts',
      fsPath: '/w/a.ts',
      toString: () => 'file:///w/a.ts',
    },
    version: 1,
    languageId: 'typescript',
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

function makeEditor(document: FakeDocument, cursorLine = 10): FakeEditor {
  return {
    document,
    selection: { active: { line: cursorLine, character: 0 } },
    setDecorations(type: unknown, ranges: unknown[]) {
      host.decorationCalls.push({ type: (type as { id: string }).id, ranges });
    },
    revealRange(range: unknown) {
      void range;
    },
  };
}

interface RecordingMemento {
  readonly memento: vscodeTypes.Memento;
  readonly updates: { key: string; value: unknown }[];
  readonly store: Map<string, unknown>;
}

/** A real in-memory Memento that RECORDS its writes — plain functions only. */
function makeRecordingMemento(seed?: ToggleState): RecordingMemento {
  const store = new Map<string, unknown>();
  const updates: { key: string; value: unknown }[] = [];
  if (seed) store.set(NEXT_EDIT_TOGGLES_KEY, seed);
  const memento = {
    keys: () => [...store.keys()],
    get: (<T>(key: string, dflt?: T): T | undefined =>
      (store.has(key) ? (store.get(key) as T) : dflt)) as vscodeTypes.Memento['get'],
    update: async (key: string, value: unknown): Promise<void> => {
      updates.push({ key, value });
      store.set(key, value);
    },
  } as vscodeTypes.Memento;
  return { memento, updates, store };
}

function makeContext(): vscodeTypes.ExtensionContext {
  return { subscriptions: [] } as unknown as vscodeTypes.ExtensionContext;
}

async function setupShell(toggles: ToggleState): Promise<vscodeTypes.Disposable> {
  const guard = await NextEditGuard.hydrate(makeRecordingMemento(toggles).memento, {
    reportFailure: SHELL_DEPS.reportFailure,
  });
  return registerTalariaNextEdit(makeContext(), guard, SHELL_DEPS);
}

/** Drives the ONE trigger path through its edit-burst source, then settles the
 *  350 ms debounce. Deliberately NOT the R4 accept command, which would clear
 *  the very FIM visibility the R2 gate test is asserting. */
async function fireTrigger(): Promise<void> {
  const doc = host.activeTextEditor?.document;
  if (doc) {
    doc.version += 1;
    for (const handler of host.docChangeHandlers) {
      handler({
        document: doc,
        contentChanges: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x' },
        ],
      });
    }
  }
  await vi.advanceTimersByTimeAsync(400);
  await vi.advanceTimersByTimeAsync(0);
}

function contextKeyValue(key: string): unknown {
  const sets = host.executed.filter((e) => e.command === 'setContext' && e.args[0] === key);
  return sets.length === 0 ? undefined : must(sets[sets.length - 1]).args[1];
}

function resetR2(): void {
  vi.useFakeTimers();
  resetHost();
  failures.length = 0;
  backendSpy.predicts.length = 0;
  backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
  autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
  autocompleteConfig.model = 'qwen2.5-coder:7b';
  autocompleteConfig.backend = 'ollama';
  host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
  host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
}

describe('R2 LOCK (trigger gate): with FIM busy the trigger path builds ZERO requests', () => {
  beforeEach(resetR2);
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * NON-VACUITY CONTROL, and it is load-bearing. Every assertion in this
   * describe block is an ABSENCE (`predicts` is empty). An absence proves
   * nothing unless the very same harness, with the gate's input flipped, does
   * produce a request — otherwise a broken harness (no editor, no listener, a
   * mis-seeded config) would satisfy all of them with the gate deleted. This
   * is the Task 12 lesson: the abort test that survived removing the abort did
   * so because nothing could ever have settled either way.
   */
  it('CONTROL: with FIM IDLE the identical setup builds exactly ONE request', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(
      backendSpy.predicts,
      'NON-VACUITY CONTROL failed: with FIM idle the trigger must build a request — if this is 0 too, the whole R2 gate describe block is testing a harness that never fires at all',
    ).toHaveLength(1);
  });

  it('fimVisible=true (ghost text on screen): builds nothing', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(true); // a non-null item counts as visible

    await fireTrigger();

    expect(
      backendSpy.predicts,
      'R2 GATE 2 failed: with FIM ghost text visible on screen, next-edit must build ZERO requests',
    ).toHaveLength(0);
  });

  it('a FIM request merely IN FLIGHT (no result yet): builds nothing — R2 covers in-flight, not just on-screen', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted();

    await fireTrigger();

    expect(
      backendSpy.predicts,
      'R2 GATE 2 failed: a FIM request merely in flight (no result shown yet) must still block next-edit from building a request',
    ).toHaveLength(0);
  });

  it('the gate REOPENS once FIM settles with nothing — the lock pins a gate, not a permanent block', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted();
    await fireTrigger();
    expect(
      backendSpy.predicts,
      'R2 GATE 2 failed: FIM in flight must still block the trigger (setup half of this test)',
    ).toHaveLength(0);

    fimActivityRelay.resultShown(false);
    await fireTrigger();
    expect(
      backendSpy.predicts,
      'R2 GATE 2 failed: once FIM settles with no result, the gate must REOPEN — a permanently-stuck gate is as wrong as a leaky one',
    ).toHaveLength(1);
  });
});

describe('R2 LOCK (single-flight DIRECTION): FIM-start aborts next-edit; next-edit NEVER aborts FIM', () => {
  beforeEach(resetR2);
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A prediction whose settling THIS TEST controls, and which resolves with a
   * perfectly good rewrite. Deliberately NOT a promise that never settles:
   * that is precisely what made Task 12's abort test vacuous — with nothing
   * able to settle, "no proposal appeared" was true whether or not the abort
   * existed. Here the only thing that can keep a proposal off the screen is
   * the abort actually taking effect.
   */
  function deferredRewrite(): () => void {
    let settle = (): void => {};
    backendSpy.respond = () =>
      new Promise<NextEditModelOutput>((resolve) => {
        settle = () => resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
      });
    return () => settle();
  }

  it('CONTROL: the deferred response, left UNaborted, really does drive a proposal onto the screen', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      contextKeyValue('talaria.nextEdit.jumpVisible'),
      'NON-VACUITY CONTROL failed: an unaborted deferred response must reach the screen, or HALF 1 below proves nothing (absence would be true either way)',
    ).toBe(true);
  });

  it('HALF 1 — FIM requestStarted() aborts the in-flight next-edit signal, and the late response is discarded', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts, 'setup: the trigger must have built exactly one request before FIM starts').toHaveLength(
      1,
    );
    expect(
      must(backendSpy.predicts[0]).signal.aborted,
      'setup: the signal must start UNaborted, or the abort assertion below proves nothing',
    ).toBe(false);

    fimActivityRelay.requestStarted();

    // The abort ITSELF, not merely its consequence.
    expect(
      must(backendSpy.predicts[0]).signal.aborted,
      'R2 HALF 1 failed: FIM requestStarted() must abort the in-flight next-edit signal',
    ).toBe(true);

    // An abort does not un-send a request already on the wire: the response
    // still lands, and the shell must discard rather than show it.
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      contextKeyValue('talaria.nextEdit.jumpVisible'),
      'R2 HALF 1 failed: a response that lands AFTER its signal was aborted must be discarded, not shown as a proposal',
    ).not.toBe(true);
  });

  /**
   * HALF 2 — the half a "the abort happens" test can never show. `fimOwn`
   * stands for FIM's OWN request controller. The shell is given no route to
   * it, which is the whole claim: the seam is observation-only, so a full
   * next-edit lifecycle (build → predict → abort → dispose) cannot touch it.
   *
   * On its own this assertion is admittedly weak — an object the shell never
   * received obviously stays untouched. It is load-bearing only TOGETHER with
   * the two structural locks that follow, which prove the shell HAS no such
   * route to acquire: the relay surface carries no cancellation method, and
   * every `.abort()` in the shell is on the shell's own controller.
   */
  it('HALF 2 (runtime): a full next-edit lifecycle leaves a FIM-owned AbortController untouched', async () => {
    const fimOwn = new AbortController();
    host.activeTextEditor = makeEditor(makeDoc());
    // A DEFERRED response, so next-edit is genuinely still in flight when FIM
    // starts — with the default (immediately-resolving) responder the request
    // has already settled and cleared itself, so there would be nothing in
    // flight for either side to abort, and this test would prove nothing.
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts, 'setup: the trigger must have built exactly one request').toHaveLength(1);
    expect(
      must(backendSpy.predicts[0]).signal.aborted,
      'setup: the signal must start UNaborted, or the asymmetry assertion below proves nothing',
    ).toBe(false);

    // Both are now "in flight": next-edit really is, and `fimOwn` stands for
    // FIM's own request controller.
    fimActivityRelay.requestStarted();

    // The asymmetry, asserted in one place: next-edit's signal is aborted...
    expect(
      must(backendSpy.predicts[0]).signal.aborted,
      'R2 HALF 2 failed: FIM requestStarted() must abort the in-flight NEXT-EDIT signal (the direction R2 requires)',
    ).toBe(true);
    // ...and FIM's is not.
    expect(
      fimOwn.signal.aborted,
      'R2 HALF 2 (the direction runtime alone cannot fully prove) failed: a full next-edit lifecycle must leave a FIM-owned AbortController untouched',
    ).toBe(false);

    // Drive the rest of the lifecycle — late response, FIM settle, the R4
    // accept seam and its armed trigger — and FIM's controller stays untouched
    // throughout. There is no point at which next-edit reaches back at FIM.
    settle();
    fimActivityRelay.resultShown(true);
    fimActivityRelay.accepted();
    await vi.advanceTimersByTimeAsync(400);

    expect(
      fimOwn.signal.aborted,
      'R2 HALF 2 failed: the FIM-owned controller must stay untouched through the ENTIRE lifecycle, including the R4 accept seam and its armed re-trigger',
    ).toBe(false);
  });

  it('HALF 2 (structural): the FIM activity relay exposes ONLY observation methods — no cancellation surface', () => {
    // EQUALITY on the key set: adding a `cancel`/`abort`/`dispose` method to
    // the relay would hand next-edit exactly the handle R2 forbids it. All
    // four surviving members are OBSERVATIONS (FIM telling next-edit what it
    // did) or a command-id lookup — none can influence a FIM request.
    expect(
      Object.keys(fimActivityRelay).sort(),
      'R2 HALF 2 (structural) failed: fimActivityRelay must expose ONLY observation methods — a new member here (e.g. cancel/abort/dispose) would be a cancellation handle R2 forbids next-edit from having',
    ).toEqual(['acceptCommandId', 'accepted', 'requestStarted', 'resultShown'].sort());
  });
});

/**
 * HALF 2 (structural, source-scan): every `.abort()` call in the shell is on
 * the shell's OWN in-flight controller. This is the assertion that would go
 * RED if a future edit gave next-edit a FIM cancellation handle and used it —
 * the runtime half above cannot see that, because a test can only prove an
 * object it OWNS was not aborted.
 *
 * The regex captures the FULL receiver path, not just the trailing
 * identifier, and allows an optional `?` before the final `.abort(` — plain
 * `.abort(` and optional-chained `?.abort(` both count. TWO independent
 * blind spots this closes, both confirmed by a reviewer planting a real
 * violation and watching the narrower version stay green:
 *
 *  1. Without `\??`, an idiomatic `deps.getFimController?.()?.abort()` is
 *     entirely invisible to this scan — `?.abort(` never matches a bare
 *     `\.abort(`. A `getFimController?()` handle threaded through
 *     `NextEditShellDeps` and cancelled with `?.` trips neither this lock
 *     nor the runtime HALF 2 test above (which can only prove an object it
 *     OWNS was untouched) — this was the pair the Task 14 implementer
 *     nominated as sufficient to make "next-edit NEVER aborts FIM" load-
 *     bearing, and the reviewer showed it was not.
 *  2. Without capturing the full chain, `fim.inFlight.abort()` collapses to
 *     the same bare `inFlight` string the shell's OWN legitimate receiver
 *     produces, so a FIM-owned `inFlight` field would be indistinguishable
 *     from the shell's `inFlight` variable and the equality check below
 *     would rubber-stamp it.
 *
 * The repeating group models a member/call chain segment-by-segment
 * (`.name`, `?.name`, `()`, `?.()`) so a receiver like
 * `deps.getFimController?.()` is captured whole, not truncated to its last
 * segment.
 */
const ABORT_RECEIVER =
  /([A-Za-z_$][\w$]*(?:\?\.\(\s*\)|\(\s*\)|\?\.[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*)*)\??\s*\.\s*abort\s*\(/g;

function abortReceivers(content: string): string[] {
  // Group 1 is mandatory in ABORT_RECEIVER (not wrapped in `?`), so any
  // successful match always populates it — must() asserts that invariant
  // rather than silently coercing away a genuine (if unreachable) undefined.
  return [...content.matchAll(ABORT_RECEIVER)].map((m) =>
    must(m[1], 'ABORT_RECEIVER matched without capturing its mandatory receiver group'),
  );
}

describe('R2 LOCK (single-flight DIRECTION, structural): the shell aborts only its OWN controller', () => {
  it('every .abort() in shell.vscode.ts is called on the next-edit in-flight controller', () => {
    const shell = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'shell.vscode.ts');
    expect(shell, 'reach: shell.vscode.ts must be collected').toBeDefined();

    const receivers = abortReceivers(shell?.content ?? '');
    // Non-vacuity: there IS at least one abort — an empty list would pass the
    // equality below while proving the file has no abort mechanism at all.
    expect(
      receivers.length,
      'NON-VACUITY CONTROL failed: the shell must contain at least one .abort() call — an empty receiver list would pass the equality below for the wrong reason (the scan seeing nothing, not the code being correct)',
    ).toBeGreaterThan(0);
    expect(
      [...new Set(receivers)],
      'R2 structural failed: every .abort() receiver in shell.vscode.ts must be the shell OWN inFlight controller — a different receiver means next-edit has (or has grown) a way to abort something it does not own',
    ).toEqual(['inFlight']);
  });

  it('RED-first proof: a planted FIM abort in the same file IS flagged', () => {
    const shell = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'shell.vscode.ts');
    const withViolation = `${shell?.content ?? ''}\n    fimController.abort();\n`;

    const receivers = [...new Set(abortReceivers(withViolation))];
    expect(receivers, 'RED-first proof failed: a planted fimController.abort() was not detected at all').toContain(
      'fimController',
    );
    expect(
      receivers,
      'RED-first proof failed: a planted fimController.abort() must break the inFlight-only equality check',
    ).not.toEqual(['inFlight']);
  });

  /**
   * RED-first proof, byte-for-byte the reviewer's actual finding: a
   * `getFimController` handle threaded through `NextEditShellDeps` and
   * cancelled with idiomatic optional chaining inside `requestStarted()`.
   * This is the exact shape that left the pre-fix regex at 65/65 green — the
   * fix was verified by planting this in the REAL `shell.vscode.ts` and `NextEditShellDeps`,
   * watching this predicate flag it, then reverting byte-exactly).
   */
  it('RED-first proof: an optional-chained FIM abort (deps.getFimController?.()?.abort()) IS flagged', () => {
    const shell = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'shell.vscode.ts');
    const withViolation = `${shell?.content ?? ''}\n        deps.getFimController?.()?.abort();\n`;

    const receivers = [...new Set(abortReceivers(withViolation))];
    expect(
      receivers,
      'RED-first proof failed: an optional-chained deps.getFimController?.()?.abort() was not detected — this is the exact reviewer-found R2 violation the \\?? fix exists to catch',
    ).toContain('deps.getFimController?.()');
    expect(
      receivers,
      'RED-first proof failed: the optional-chained FIM abort must break the inFlight-only equality check',
    ).not.toEqual(['inFlight']);
  });

  /**
   * RED-first proof: `fim.inFlight.abort()` — a FIM-owned field that merely
   * happens to be NAMED `inFlight` — is caught as a DIFFERENT receiver than
   * the shell's own bare `inFlight` variable. The narrower, trailing-
   * identifier-only regex could not tell these apart.
   */
  it('RED-first proof: fim.inFlight.abort() is flagged as a DIFFERENT receiver than the shell bare inFlight', () => {
    const shell = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'shell.vscode.ts');
    const withViolation = `${shell?.content ?? ''}\n        fim.inFlight.abort();\n`;

    const receivers = [...new Set(abortReceivers(withViolation))];
    expect(
      receivers,
      'RED-first proof failed: fim.inFlight.abort() must be captured with its FULL receiver path, not truncated to the bare trailing identifier "inFlight"',
    ).toContain('fim.inFlight');
    expect(
      receivers,
      'RED-first proof failed: a FIM-owned field merely NAMED inFlight must not be indistinguishable from the shell own inFlight variable',
    ).not.toEqual(['inFlight']);
  });

  /**
   * REGRESSION CONTROL: the shell's own `abortInFlight()` uses an explicit
   * null check (`if (inFlight !== null) { inFlight.abort(); ... }`). Were it
   * collapsed to `inFlight?.abort()`, it must still resolve to the SAME
   * receiver, `inFlight` — that is the identical, still-own-controller
   * abort, merely spelled with a null-safety operator instead of an `if`.
   * The receiver-identity check above (`toEqual(['inFlight'])`) is the real
   * protection; this proves the `\??` addition does not turn a benign
   * self-abort refactor into either a false violation report or, worse, an
   * invisible one (an empty receiver list would silently pass the equality
   * check above for the wrong reason — see the non-vacuity comment there).
   */
  it('REGRESSION: collapsing abortInFlight() to inFlight?.abort() still resolves to the SAME receiver', () => {
    const shell = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'shell.vscode.ts');
    const withOptionalChain = (shell?.content ?? '').replace('inFlight.abort();', 'inFlight?.abort();');
    expect(
      withOptionalChain,
      'setup: the inFlight.abort() -> inFlight?.abort() substitution did not land — check the shell source still contains that exact substring',
    ).not.toBe(shell?.content ?? '');

    const receivers = [...new Set(abortReceivers(withOptionalChain))];
    expect(
      receivers.length,
      'REGRESSION failed: inFlight?.abort() must still be detected as SOME receiver, not silently made invisible by the \\?? addition',
    ).toBeGreaterThan(0);
    expect(
      receivers,
      'REGRESSION failed: inFlight?.abort() is a benign self-abort refactor and must still resolve to the SAME receiver, inFlight — not a false violation report',
    ).toEqual(['inFlight']);
  });
});

// ══════════════════════════════════ R3 ═══════════════════════════════════════

interface PackageKeybinding {
  command: string;
  key: string;
  when: string;
}

/**
 * R3 — "Tab ownership is a total function of state, written as a table and
 * locked by a test". The three `when` clauses below are compared with `toBe`,
 * never `toContain`: a guard silently dropped from inside a longer clause is
 * EXACTLY the drift this lock exists to catch, and containment would sail past
 * it. `jumpVisible` + `!jumped` vs `jumpVisible` + `jumped` is what makes Tab
 * ownership total and disjoint; the remaining negations yield Tab back to
 * every VS Code surface that legitimately owns it first (the suggest widget,
 * FIM's own inline suggestion, snippet mode, accessibility tab-moves-focus).
 */
const EXPECTED_KEYBINDINGS: readonly PackageKeybinding[] = [
  {
    command: 'talaria.nextEdit.jump',
    key: 'tab',
    when: 'talaria.nextEdit.jumpVisible && !talaria.nextEdit.jumped && editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inlineSuggestionVisible && !inlineEditIsVisible && !inSnippetMode && !editorTabMovesFocus',
  },
  {
    command: 'talaria.nextEdit.accept',
    key: 'tab',
    when: 'talaria.nextEdit.jumpVisible && talaria.nextEdit.jumped && editorTextFocus && !editorReadonly && !suggestWidgetVisible && !inlineSuggestionVisible && !inlineEditIsVisible && !inSnippetMode && !editorTabMovesFocus',
  },
  {
    command: 'talaria.nextEdit.dismiss',
    key: 'escape',
    when: 'talaria.nextEdit.jumpVisible && editorTextFocus && !suggestWidgetVisible && !inlineSuggestionVisible && !inlineEditIsVisible && !inSnippetMode',
  },
];

/**
 * FIX WAVE 2 (F-6). Esc's clause used to be only
 * `talaria.nextEdit.jumpVisible && editorTextFocus`, and the old rationale
 * ("Esc is not contended the way Tab is — core closes widgets first by
 * weight") was BACKWARDS. `keybindingService.ts`'s `_asCommandRule` assigns
 * package.json-contributed bindings `KeybindingWeight.ExternalExtension`
 * (400) + index; core's `hideSuggestWidget` is `EditorContrib` (100). The
 * merged list is sorted ASCENDING by weight and the resolver takes the LAST
 * match, so an extension Esc binding OUTRANKS every built-in Esc handler.
 * (microsoft/vscode#10004 is the same finding from the other side: a Vim
 * extension binding `escape`/`editorTextFocus` swallowed every core Esc
 * behaviour, and the VS Code team's answer was "having a complex `when`
 * clause is the only way for extension writers".)
 *
 * So Esc now yields to the four TRANSIENT overlays that legitimately own Esc
 * while they are up — suggest widget, inline suggestion, inline edit, snippet
 * mode — each of which is dismissed by the FIRST Esc, leaving the SECOND Esc
 * to dismiss our proposal. Layered dismissal, innermost first.
 *
 * Two of Tab's guards are deliberately NOT copied — this clause is reasoned,
 * not mirrored:
 *
 *  - `!editorReadonly` is a PERSISTENT document property, not a transient
 *    overlay. Gating dismiss on it would mean a proposal somehow visible over
 *    a read-only editor could never be dismissed — F-7's "unrecoverable
 *    state" bug shape, re-created on the keyboard. A dismiss must always be
 *    reachable wherever the thing it dismisses is visible.
 *  - `!editorTabMovesFocus` is a pure TAB-semantics setting (accessibility
 *    mode where Tab moves focus instead of indenting). It says nothing about
 *    Escape; copying it would be mechanical mirroring.
 */

interface RawPackageJson {
  contributes?: { keybindings?: PackageKeybinding[] };
}

/** The REAL on-disk read — used both by the lock and by the RED-first proof
 *  below, so the proof perturbs data that genuinely came off disk rather
 *  than a copy of the hardcoded `EXPECTED_KEYBINDINGS` constant. */
function readPackageJson(): RawPackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as RawPackageJson;
}

/** The exact filter the lock depends on, extracted so a perturbed (but
 *  still REAL-data-derived) package object can be run through it too. */
function filterNextEditKeybindings(pkg: RawPackageJson): PackageKeybinding[] {
  return (pkg.contributes?.keybindings ?? []).filter((b) => b.command.startsWith('talaria.nextEdit.'));
}

function loadNextEditKeybindings(): PackageKeybinding[] {
  return filterNextEditKeybindings(readPackageJson());
}

describe('R3 LOCK: the Tab table — every next-edit keybinding when-clause EQUALS its expected string', () => {
  it('reach: package.json really declares next-edit keybindings (an empty read would pass every check below)', () => {
    const bindings = loadNextEditKeybindings();
    expect(
      bindings.length,
      'R3 reach failed: package.json read returned ZERO talaria.nextEdit.* keybindings — an empty read would rubber-stamp every check below',
    ).toBeGreaterThan(0);
    expect(
      bindings,
      `R3 reach failed: expected exactly ${EXPECTED_KEYBINDINGS.length} next-edit keybindings in package.json`,
    ).toHaveLength(EXPECTED_KEYBINDINGS.length);
  });

  it('the three bindings EQUAL the expected table, exactly (not merely contain the guards)', () => {
    expect(
      loadNextEditKeybindings(),
      'R3 LOCK failed: the on-disk keybindings no longer EQUAL the pinned table — a guard, key, or when-clause changed in package.json. toEqual, never toContain: a dropped guard inside a longer clause is exactly the drift this catches',
    ).toEqual([...EXPECTED_KEYBINDINGS]);
  });

  it.each(EXPECTED_KEYBINDINGS)('$command: key and when-clause are byte-exact', (expected) => {
    const actual = loadNextEditKeybindings().find((b) => b.command === expected.command);
    expect(actual, `no keybinding for ${expected.command}`).toBeDefined();
    expect(actual?.key, `R3: ${expected.command}'s key binding changed`).toBe(expected.key);
    // toBe, never toContain — see this table's doc comment.
    expect(
      actual?.when,
      `R3: ${expected.command}'s when-clause no longer matches byte-for-byte — a guard was likely added, removed, or reordered in package.json`,
    ).toBe(expected.when);
  });

  it('Tab ownership is DISJOINT: jump and accept differ only in the jumped polarity', () => {
    const jump = EXPECTED_KEYBINDINGS.find((b) => b.command === 'talaria.nextEdit.jump');
    const accept = EXPECTED_KEYBINDINGS.find((b) => b.command === 'talaria.nextEdit.accept');
    expect(
      jump?.when.replace('!talaria.nextEdit.jumped', 'talaria.nextEdit.jumped'),
      'R3 failed: jump and accept when-clauses must differ ONLY in the jumped polarity — Tab ownership would no longer be total and disjoint',
    ).toBe(accept?.when);
  });

  /**
   * RED-first proof, on REAL data. The earlier version of this proof only
   * mutated the `EXPECTED_KEYBINDINGS` constant and compared two derived
   * strings to each other — it demonstrated that `String.prototype.replace`
   * plus `!==` works, never that the LOCK reads real data. (A prefix
   * produced by deleting a trailing substring is trivially `.includes()` by
   * the original and trivially unequal to it — both assertions held before a
   * single byte of `package.json` was ever read.)
   *
   * This version reads the ACTUAL on-disk `package.json`, drops one guard
   * from the REAL `jump` clause it finds there, and re-runs the exact filter
   * the lock depends on (`filterNextEditKeybindings`) — proving the failure
   * mode R3 exists to catch (a guard silently dropped from a longer clause)
   * is caught when it originates from disk, not from a hand-typed copy.
   */
  it('RED-first proof: a guard dropped from the REAL on-disk jump clause fails the equality check', () => {
    const pkg = readPackageJson();
    const realKeybindings = pkg.contributes?.keybindings ?? [];
    const jumpIndex = realKeybindings.findIndex((b) => b.command === 'talaria.nextEdit.jump');
    expect(jumpIndex, 'reach: package.json must declare talaria.nextEdit.jump').toBeGreaterThanOrEqual(0);

    const realJump = realKeybindings[jumpIndex] as PackageKeybinding;
    const perturbedWhen = realJump.when.replace(' && !editorTabMovesFocus', '');
    // The drop really landed on data that came off disk, not off the const.
    expect(
      perturbedWhen,
      'setup: the guard-drop replace did not land on the REAL on-disk when-clause — check the real package.json still contains " && !editorTabMovesFocus"',
    ).not.toBe(realJump.when);

    const perturbedKeybindings = [...realKeybindings];
    perturbedKeybindings[jumpIndex] = { ...realJump, when: perturbedWhen };
    const perturbed = filterNextEditKeybindings({ contributes: { keybindings: perturbedKeybindings } });

    // The SAME equality the working lock above (`toEqual`) relies on,
    // exercised here against REAL-data-derived input with one guard
    // dropped — this is the proof the earlier version was missing.
    expect(
      perturbed,
      'R3 RED-first proof failed: a guard dropped from the REAL on-disk jump when-clause must break the equality check — if this passes, the R3 lock cannot actually catch a dropped guard in package.json',
    ).not.toEqual([...EXPECTED_KEYBINDINGS]);
  });
});

// ══════════════════════════════════ R5 ═══════════════════════════════════════

/**
 * R5 single-writer/single-reader. The toggles are NOT VS Code settings; their
 * state lives in `ExtensionContext.globalState` under ONE key, owned by the
 * Guard. Two independent scans pin that:
 *
 *  1. The key LITERAL appears in exactly one non-test module — `guard.ts`.
 *  2. The `globalState` handle itself is reached in exactly one non-test
 *     module — `autocomplete/index.ts`, the composition root, which does
 *     nothing with it but hand it to `NextEditGuard.hydrate`.
 *
 * Together those mean: nobody can read or write the toggle state without going
 * through the Guard, because nobody else can name the key OR obtain the store.
 */
const TOGGLES_KEY_LITERAL = /['"`]hermes\.nextEdit\.toggles['"`]/;
const GLOBAL_STATE_HANDLE = /\bglobalState\b/;
const GLOBAL_STATE_DIRECT_ACCESS = /\bglobalState\s*\.\s*(?:get|update)\s*\(/;

describe('R5 LOCK (single-writer/single-reader): the Guard is bypassable by nobody', () => {
  it('the store-key literal appears in EXACTLY one non-test src/ module, and it is nextedit/guard.ts', () => {
    expect(
      filesMatching(loadStripped(SRC_ROOT), TOGGLES_KEY_LITERAL),
      'R5 failed: the hermes.nextEdit.toggles key literal must appear in EXACTLY one non-test module (guard.ts) — a second module naming the key is a potential bypass',
    ).toEqual(['autocomplete/nextedit/guard.ts']);
  });

  it('the exported constant really IS that literal (the scan and the runtime agree)', () => {
    expect(
      NEXT_EDIT_TOGGLES_KEY,
      'R5 setup: the exported NEXT_EDIT_TOGGLES_KEY constant drifted from the literal this scan matches',
    ).toBe('hermes.nextEdit.toggles');
    expect(
      TOGGLES_KEY_LITERAL.test(`const k = '${NEXT_EDIT_TOGGLES_KEY}';`),
      'R5 setup: the TOGGLES_KEY_LITERAL regex no longer matches the runtime constant it is meant to scan for',
    ).toBe(true);
  });

  it('the globalState handle is reached in EXACTLY one non-test src/ module — the composition root', () => {
    // `autocomplete/index.ts` obtains `context.globalState` and passes it
    // straight to `NextEditGuard.hydrate`. Any SECOND module reaching for the
    // store is a bypass route, whether or not it names the key.
    expect(
      filesMatching(loadStripped(SRC_ROOT), GLOBAL_STATE_HANDLE),
      'R5 failed: context.globalState must be reached from EXACTLY one non-test module (the composition root, autocomplete/index.ts) — a second reach is a bypass route around the Guard',
    ).toEqual(['autocomplete/index.ts']);
  });

  it('no module calls get/update directly on globalState — the Memento is only ever handed to the Guard', () => {
    // HONEST NOTE: this predicate matches nothing in the tree TODAY (the
    // composition root passes the Memento by reference; `guard.ts` calls
    // `.get`/`.update` on its own injected `state` field, never on a
    // `globalState`-named expression). It is a FORWARD-LOOKING ban, and it is
    // recorded as such rather than dressed up as currently load-bearing. Its
    // predicate is proven to fire by the planted violation below — that proof
    // is what stops it from being a lock that can never go RED.
    expect(
      filesMatching(loadStripped(SRC_ROOT), GLOBAL_STATE_DIRECT_ACCESS),
      'R5 (forward-looking) failed: a module now calls .get/.update directly on a globalState-named expression, bypassing the Guard',
    ).toEqual([]);
  });

  it('RED-first proof: both R5 scans flag violations planted in DISTANT modules', () => {
    const base = loadStripped(SRC_ROOT);

    const keyViolation: StrippedSource[] = [
      ...base,
      { file: 'host/__key_probe__.ts', content: "const k = 'hermes.nextEdit.toggles';" },
    ];
    expect(
      filesMatching(keyViolation, TOGGLES_KEY_LITERAL),
      'R5 RED-first proof failed: a planted key literal in a distant module was not flagged',
    ).toContain('host/__key_probe__.ts');
    expect(
      filesMatching(keyViolation, TOGGLES_KEY_LITERAL),
      'R5 RED-first proof failed: the planted key-literal violation must break the sole-module equality check',
    ).not.toEqual(['autocomplete/nextedit/guard.ts']);

    const handleViolation: StrippedSource[] = [
      ...base,
      { file: 'host/__store_probe__.ts', content: 'const s = context.globalState;' },
    ];
    expect(
      filesMatching(handleViolation, GLOBAL_STATE_HANDLE),
      'R5 RED-first proof failed: a planted globalState reach in a distant module was not flagged',
    ).toContain('host/__store_probe__.ts');

    const directViolation: StrippedSource[] = [
      ...base,
      {
        file: 'host/__direct_probe__.ts',
        content: "await context.globalState.update('hermes.nextEdit.toggles', { next: true });",
      },
    ];
    expect(
      filesMatching(directViolation, GLOBAL_STATE_DIRECT_ACCESS),
      'R5 RED-first proof failed: a planted direct globalState.update(...) call was not flagged by the forward-looking predicate',
    ).toEqual(['host/__direct_probe__.ts']);
  });

  it('negative control: prose about globalState in a comment is not a bypass', () => {
    const commentOnly: StrippedSource[] = [
      ...loadStripped(SRC_ROOT),
      {
        file: 'host/__prose_probe__.ts',
        content: stripComments("// the Guard owns globalState key 'hermes.nextEdit.toggles'\nconst x = 1;"),
      },
    ];
    expect(
      filesMatching(commentOnly, TOGGLES_KEY_LITERAL),
      'R5 negative control failed: prose naming the key in a comment must not count as a second key-literal module',
    ).toEqual(['autocomplete/nextedit/guard.ts']);
    expect(
      filesMatching(commentOnly, GLOBAL_STATE_HANDLE),
      'R5 negative control failed: prose naming globalState in a comment must not count as a second reach',
    ).toEqual(['autocomplete/index.ts']);
  });
});

/**
 * The exhaustive 16-row table (4 accepted-states × 4 requests). CANONICAL HOME
 * is this file; `mode.test.ts` covers the same table for the module it belongs
 * to and that coverage is deliberately kept. The property locked here is
 * narrower and is the security-relevant one: a REFUSAL persists NOTHING.
 */
const S = (next: boolean, generic: boolean): ToggleState => ({ next, generic });
const R = (source: 'next' | 'generic', on: boolean): ToggleRequest => ({ source, on });

const TOGGLE_TABLE: readonly (readonly [ToggleState, ToggleRequest, 'accepted' | 'refused'])[] = [
  [S(false, false), R('next', true), 'accepted'],
  [S(false, false), R('generic', true), 'accepted'],
  [S(false, false), R('next', false), 'accepted'],
  [S(false, false), R('generic', false), 'accepted'],
  [S(true, false), R('generic', true), 'refused'], // THE refusal
  [S(true, false), R('next', true), 'accepted'],
  [S(true, false), R('next', false), 'accepted'],
  [S(true, false), R('generic', false), 'accepted'],
  [S(false, true), R('next', true), 'refused'], // the mirror refusal
  [S(false, true), R('generic', true), 'accepted'],
  [S(false, true), R('generic', false), 'accepted'],
  [S(false, true), R('next', false), 'accepted'],
  // degenerate both-on rows: unreachable post-sanitize, but the function is TOTAL
  [S(true, true), R('next', false), 'accepted'],
  [S(true, true), R('generic', false), 'accepted'],
  [S(true, true), R('next', true), 'accepted'],
  [S(true, true), R('generic', true), 'accepted'],
];

describe('R5 LOCK (refusal persists nothing): applyToggleRequest over all 16 rows', () => {
  it('the table really is all 16 rows, and really contains refusals (a table of only accepts would be vacuous)', () => {
    expect(TOGGLE_TABLE, 'setup: the table must have all 16 (state × request) rows').toHaveLength(16);
    expect(
      TOGGLE_TABLE.filter(([, , result]) => result === 'refused'),
      'NON-VACUITY CONTROL failed: the table must contain the 2 real refusal rows, or the refusal-persists-nothing assertion below never actually exercises a refusal',
    ).toHaveLength(2);
    // Every (state × request) combination is present exactly once.
    const keys = TOGGLE_TABLE.map(([s, r]) => `${String(s.next)}${String(s.generic)}:${r.source}:${String(r.on)}`);
    expect(
      new Set(keys).size,
      'setup: the table must cover every (state × request) combination exactly once — a duplicate row would silently under-cover the space',
    ).toBe(16);
  });

  it.each(TOGGLE_TABLE)('accepted=%o req=%o -> %s', (accepted, req, expectedResult) => {
    const decision = applyToggleRequest(accepted, req);
    expect(
      decision.result,
      `R5: applyToggleRequest(${JSON.stringify(accepted)}, ${JSON.stringify(req)}) must resolve to "${expectedResult}"`,
    ).toBe(expectedResult);
    if (decision.result === 'refused') {
      // THE lock: a refusal leaves the ratified state byte-identical to input.
      expect(
        decision.accepted,
        'R5 failed: a REFUSAL must leave the ratified state byte-identical to its input — it must persist NOTHING',
      ).toEqual(accepted);
      expect(decision.alert, 'R5 failed: a refusal must surface a user-visible alert').not.toBeNull();
    }
  });

  it('every refused row leaves state deep-equal to its input (stated once more, as a whole-table property)', () => {
    const refused = TOGGLE_TABLE.filter(([, , result]) => result === 'refused');
    expect(
      refused.length,
      'NON-VACUITY CONTROL failed: there must be at least one refused row to exercise the property below',
    ).toBeGreaterThan(0);
    for (const [accepted, req] of refused) {
      const decision = applyToggleRequest(accepted, req);
      expect(
        decision.result,
        `R5: ${JSON.stringify(req)} against ${JSON.stringify(accepted)} must still resolve to "refused"`,
      ).toBe('refused');
      expect(
        decision.accepted,
        'R5 failed: a refusal must persist NOTHING — the ratified state must equal the input state exactly',
      ).toEqual(accepted);
    }
  });
});

describe('R5 LOCK (cold-start sanitize): a both-on store hydrates to both-off AND the reset is persisted', () => {
  beforeEach(() => {
    resetHost();
    failures.length = 0;
  });

  it('both-on seed: state is both-off, update called EXACTLY once with the reset, and the store now holds it', async () => {
    const { memento, updates, store } = makeRecordingMemento({ next: true, generic: true });

    const guard = await NextEditGuard.hydrate(memento, { reportFailure: SHELL_DEPS.reportFailure });

    expect(
      guard.getState(),
      'R5 cold-start sanitize failed: a both-on seed must hydrate the in-memory state to both-off',
    ).toEqual({ next: false, generic: false });
    // Fix wave, Finding 2 — companion to the assertion above. Under
    // read-through, `getState()` re-sanitizes on every call via
    // `readCurrent()`, so by itself it can no longer distinguish "hydrate()
    // persisted the reset" from "hydrate() left the store both-on and a live
    // read silently re-sanitized it" — both leave `getState()` reporting
    // both-off. This reads the RAW store directly, bypassing the Guard
    // entirely, at the same point in the test, so the pairing proves what the
    // line above alone no longer can.
    expect(
      store.get(NEXT_EDIT_TOGGLES_KEY),
      'R5: the raw store must already hold the sanitized both-off value immediately after hydrate() — ' +
        'getState() alone cannot prove this under read-through',
    ).toEqual({ next: false, generic: false });
    expect(guard.getMode(), 'R5 cold-start sanitize failed: a both-on seed must hydrate to mode "off"').toBe(
      'off',
    );
    // «скинет в OFF» — the reset is PERSISTED, so the next cold start does not
    // rediscover the same conflict.
    expect(
      updates,
      'R5: the both-off reset must be PERSISTED (exactly one Memento.update call), not just returned in memory — otherwise the next cold start rediscovers the same conflict',
    ).toHaveLength(1);
    expect(
      updates[0]?.key,
      'R5: the persisted reset must be written under NEXT_EDIT_TOGGLES_KEY, the one key the Guard owns',
    ).toBe(NEXT_EDIT_TOGGLES_KEY);
    expect(
      updates[0]?.value,
      'R5: the persisted reset value must be the sanitized both-off state, not the original both-on seed',
    ).toEqual({ next: false, generic: false });
    expect(
      store.get(NEXT_EDIT_TOGGLES_KEY),
      'R5: the Memento store itself must now hold the sanitized both-off state after hydrate()',
    ).toEqual({ next: false, generic: false });
    // ...plus exactly one user-visible notice.
    expect(
      host.warnings,
      'R5: a both-on conflict sanitize must surface exactly ONE user-visible warning',
    ).toHaveLength(1);
  });

  /**
   * NON-VACUITY CONTROL for the write assertion above: if `hydrate` wrote on
   * EVERY cold start, `updates).toHaveLength(1)` would be satisfied by a
   * sanitize that does nothing at all. A non-conflicting store must produce
   * ZERO writes and preserve its state.
   */
  it('CONTROL: a NON-conflicting store is preserved and writes NOTHING', async () => {
    const { memento, updates } = makeRecordingMemento({ next: true, generic: false });

    const guard = await NextEditGuard.hydrate(memento, { reportFailure: SHELL_DEPS.reportFailure });

    expect(
      guard.getState(),
      'NON-VACUITY CONTROL failed: a non-conflicting seed must be preserved exactly, unchanged by hydrate()',
    ).toEqual({ next: true, generic: false });
    expect(
      updates,
      'NON-VACUITY CONTROL failed: a non-conflicting store must trigger ZERO writes — if this is nonempty, the both-on test above (toHaveLength(1)) would pass even if hydrate() wrote unconditionally on every cold start',
    ).toEqual([]);
    expect(
      host.warnings,
      'NON-VACUITY CONTROL failed: a non-conflicting store must not surface any warning',
    ).toEqual([]);
  });

  it('CONTROL: a first-run (empty) store hydrates to both-off without writing', async () => {
    const { memento, updates } = makeRecordingMemento();

    const guard = await NextEditGuard.hydrate(memento, { reportFailure: SHELL_DEPS.reportFailure });

    expect(
      guard.getState(),
      'CONTROL failed: a first-run (empty) store must hydrate to both-off by default',
    ).toEqual({ next: false, generic: false });
    expect(
      updates,
      'CONTROL failed: a first-run empty store already matches the both-off default and must trigger ZERO writes',
    ).toEqual([]);
  });
});

// ═══════════════════════════════ raw polarity ════════════════════════════════

/**
 * Global Constraints, verbatim: "`raw` polarity: FIM never sends `raw`; the
 * next-edit Ollama transport ALWAYS sends `raw: true`." The two directions are
 * OPPOSITE and both correct — Ollama's `raw` skips server-side templating,
 * which FIM needs (its `suffix`-based native FIM depends on the model's
 * template) and which next-edit must NOT have (it renders its own complete
 * prompt, so a second templating pass would silently corrupt it).
 *
 * THIS LOCK IS THE REPO'S SHARPEST DEMONSTRATION OF WHY COMMENTS MUST BE
 * STRIPPED. `OllamaFimBackend.ts`'s doc comment says, correctly, that it
 * "deliberately never send[s] `raw: true` here" — so the literal string
 * `raw: true` IS present in that file's raw bytes. An unstripped scan reports
 * the exact opposite of the truth: it would flag the compliant FIM backend and
 * would let a `raw`-less next-edit backend pass on the strength of its own
 * prose. Both inversions are asserted explicitly below.
 */
const RAW_KEY = /\braw\s*:/;
const RAW_TRUE = /\braw\s*:\s*true/;

const FIM_BACKEND_FILE = 'OllamaFimBackend.ts';
const BACKENDS_DIR = join(AUTOCOMPLETE_ROOT, 'backends');

function readBackendSource(dir: string, file: string): { raw: string; stripped: string } {
  const found = collectNonTestTsSources(dir).find((f) => f.file === file);
  expect(found, `reach: ${file} must be collected from ${dir}`).toBeDefined();
  const raw = found?.content ?? '';
  return { raw, stripped: stripComments(raw) };
}

describe('RAW-POLARITY LOCK: OllamaFimBackend never sends raw; the next-edit ollama transport always does', () => {
  it('FIM side: OllamaFimBackend.ts sends NO raw key in real code', () => {
    const { stripped } = readBackendSource(BACKENDS_DIR, FIM_BACKEND_FILE);
    expect(
      RAW_KEY.test(stripped),
      'RAW-POLARITY failed: OllamaFimBackend.ts must NEVER send a raw key — FIM needs server-side templating, which "raw" would skip',
    ).toBe(false);
  });

  it('next-edit side: nextedit/backend.ts DOES send raw: true in real code', () => {
    const { stripped } = readBackendSource(NEXTEDIT_DIR, 'backend.ts');
    expect(
      RAW_TRUE.test(stripped),
      'RAW-POLARITY failed: nextedit/backend.ts must ALWAYS send raw: true to the Ollama transport — next-edit renders its own complete prompt, so server-side templating would silently corrupt it',
    ).toBe(true);
  });

  /**
   * The inversion proof. Without `stripComments`, this lock would report the
   * OPPOSITE of the truth on both sides — which is precisely the Task 11
   * failure mode, reproduced here as a permanent assertion so the stripping
   * step can never be quietly reverted.
   */
  it('PROOF the comment-strip is load-bearing: the FIM backend mentions raw: true in PROSE while never sending it', () => {
    const { raw, stripped } = readBackendSource(BACKENDS_DIR, FIM_BACKEND_FILE);

    // Raw bytes: present (the doc comment explaining why it is NOT sent).
    expect(
      RAW_TRUE.test(raw),
      'setup: OllamaFimBackend.ts must still contain the doc-comment PROSE "raw: true" on its RAW bytes — if this fails, the inversion this proof exists to demonstrate no longer applies',
    ).toBe(true);
    // Real code: absent. Revert the stripping and the FIM assertion above
    // flips to a false violation report.
    expect(
      RAW_TRUE.test(stripped),
      'RAW-POLARITY failed (comment-strip regression): raw: true must be ABSENT from the STRIPPED (comment-free) body — an unstripped scan would falsely flag this compliant FIM backend on the strength of its own prose',
    ).toBe(false);
  });

  it('RED-first proof: the FIM-side predicate flags a raw key planted in a request body', () => {
    const { stripped } = readBackendSource(BACKENDS_DIR, FIM_BACKEND_FILE);
    const withViolation = stripped.replace('stream: true,', 'stream: true,\n      raw: true,');

    expect(
      withViolation,
      'setup: the raw-key injection into OllamaFimBackend.ts did not land (offending file: autocomplete/backends/OllamaFimBackend.ts) — check the "stream: true," anchor still exists in the stripped body',
    ).not.toBe(stripped);
    expect(
      RAW_KEY.test(withViolation),
      'RAW-POLARITY RED-first proof failed: a raw key planted in the FIM request body was not detected',
    ).toBe(true);
  });

  it('RED-first proof: the next-edit-side predicate fails when raw: true is removed', () => {
    const { stripped } = readBackendSource(NEXTEDIT_DIR, 'backend.ts');
    const withRawRemoved = stripped.replace(/\braw\s*:\s*true\s*,?/, '');

    expect(
      withRawRemoved,
      'setup: removing raw: true from nextedit/backend.ts did not land (offending file: autocomplete/nextedit/backend.ts) — check the pattern still matches the stripped body',
    ).not.toBe(stripped);
    expect(
      RAW_TRUE.test(withRawRemoved),
      'RAW-POLARITY RED-first proof failed: removing raw: true from the next-edit Ollama transport must make the next-edit-side predicate fail — if it still reports true, the lock cannot actually catch a missing raw: true',
    ).toBe(false);
  });

  it('the raw patterns match realistic shapes and not prose (sanity check on the mechanism)', () => {
    expect(RAW_TRUE.test('raw: true,'), 'RAW_TRUE must match spaced "raw: true,"').toBe(true);
    expect(RAW_TRUE.test('raw:true,'), 'RAW_TRUE must match unspaced "raw:true,"').toBe(true);
    expect(RAW_KEY.test('raw : false,'), 'RAW_KEY must match "raw : false," (any raw key, any value)').toBe(
      true,
    );
    // `const raw of` / `raw` as an identifier is NOT a body key.
    expect(
      RAW_KEY.test('for await (const raw of readNdjsonLines(response)) {'),
      'RAW_KEY must NOT match `raw` used as a loop-variable identifier, not a body key',
    ).toBe(false);
    expect(
      RAW_KEY.test('function normalizeStopReason(raw: string | undefined)'),
      'RAW_KEY intentionally DOES match a `raw:` type annotation in a parameter list — documented sanity case, not a false negative',
    ).toBe(true);
  });
});

// ════════════════════ the guard.requestToggle caller lock ════════════════════

/**
 * CARRIED FROM TASK 13'S REVIEW — the only unguarded bypass left in this
 * feature, and the reason this lock is not in the Task 14 brief's list.
 *
 * The host toggle port must route through `requestNextEditToggle`
 * (`nextedit/shell.vscode.ts`), NEVER `guard.requestToggle` directly. The
 * Guard is transport-blind — it cannot see `getAutocompleteBackend()` — so
 * calling it directly bypasses BOTH:
 *
 *   1. the unsupported-backend refusal (`openai-compat`/`codestral` FIM
 *      backends must refuse Generic, ADR-009 — otherwise Ollama's OpenAI
 *      surface re-templates the prompt and silently corrupts it), and
 *   2. the one-shot `OLLAMA_CONTEXT_LENGTH` Generic setup note.
 *
 * The Task 13 reviewer proved the bypass is currently FREE: swapping the port
 * in `autocomplete/index.ts` to `guard.requestToggle` left 3042/3042 green and
 * `tsc` clean, even after tidying the now-unused import. Nothing but this lock
 * catches it.
 *
 * `.requestToggle(` has exactly ONE legitimate non-test call site — the
 * `await guard.requestToggle(req)` inside `requestNextEditToggle` itself.
 * (`guard.ts` DECLARES the method as `requestToggle(req: ToggleRequest)`, with
 * no leading dot, so the declaration is correctly not a call site.)
 */
const REQUEST_TOGGLE_CALL = /\.\s*requestToggle\s*\(/;
const REQUEST_TOGGLE_SOLE_CALL_SITE = 'autocomplete/nextedit/shell.vscode.ts';

describe('LOCK: guard.requestToggle has exactly ONE non-test caller — requestNextEditToggle', () => {
  it('exactly one non-test src/ module calls .requestToggle(, and it is the shell', () => {
    expect(
      filesMatching(loadStripped(SRC_ROOT), REQUEST_TOGGLE_CALL),
      'LOCK failed: guard.requestToggle must be called from EXACTLY one module (the shell requestNextEditToggle) — any other caller bypasses the unsupported-backend refusal and the Generic setup note',
    ).toEqual([REQUEST_TOGGLE_SOLE_CALL_SITE]);
  });

  it('and it is called exactly ONCE in total', () => {
    expect(
      countMatches(loadStripped(SRC_ROOT), REQUEST_TOGGLE_CALL),
      'LOCK failed: guard.requestToggle must be called exactly ONCE across the whole tree',
    ).toBe(1);
  });

  it('the sole call site really sits inside requestNextEditToggle (not merely somewhere in the file)', () => {
    const shell = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'shell.vscode.ts');
    const body = shell?.content ?? '';
    const fnStart = body.indexOf('export async function requestNextEditToggle');
    expect(fnStart, 'requestNextEditToggle must exist in the shell').toBeGreaterThanOrEqual(0);

    const callIndex = body.search(REQUEST_TOGGLE_CALL);
    expect(
      callIndex,
      'LOCK failed: the sole guard.requestToggle( call must appear AFTER requestNextEditToggle starts, i.e. genuinely inside it',
    ).toBeGreaterThan(fnStart);

    // ...and before the NEXT top-level declaration, i.e. genuinely inside it.
    const afterFn = body.indexOf('\nfunction ', fnStart);
    expect(
      afterFn,
      'setup: could not find the next top-level function declaration after requestNextEditToggle',
    ).toBeGreaterThan(fnStart);
    expect(
      callIndex,
      'LOCK failed: the sole guard.requestToggle( call must appear BEFORE the next top-level declaration, i.e. still inside requestNextEditToggle',
    ).toBeLessThan(afterFn);
  });

  it('the Guard method DECLARATION is not miscounted as a call site', () => {
    const guardSource = loadStripped(NEXTEDIT_DIR).find((f) => f.file === 'guard.ts');
    expect(guardSource, 'reach: guard.ts must be collected').toBeDefined();
    // The class declares `requestToggle(req: ToggleRequest)` — no leading dot.
    expect(
      guardSource?.content,
      'setup: guard.ts must still declare requestToggle(req: ToggleRequest) verbatim',
    ).toContain('requestToggle(req: ToggleRequest)');
    expect(
      REQUEST_TOGGLE_CALL.test(guardSource?.content ?? ''),
      'LOCK negative-control failed: the METHOD DECLARATION in guard.ts must not be miscounted as a call site (it has no leading dot)',
    ).toBe(false);
  });

  it('RED-first proof: a direct guard.requestToggle call planted in the composition root IS flagged', () => {
    // This is byte-for-byte the bypass the Task 13 reviewer performed and that
    // the whole suite failed to notice.
    const withBypass: StrippedSource[] = [
      ...loadStripped(SRC_ROOT),
      {
        file: 'autocomplete/__index_bypass_probe__.ts',
        content: 'request: (source, on) => guard.requestToggle({ source, on }),',
      },
    ];
    const offenders = filesMatching(withBypass, REQUEST_TOGGLE_CALL);
    expect(
      offenders,
      'RED-first proof failed: a planted direct guard.requestToggle bypass in the composition root was not flagged',
    ).toContain('autocomplete/__index_bypass_probe__.ts');
    expect(
      offenders,
      'RED-first proof failed: the planted bypass must break the sole-call-site equality check',
    ).not.toEqual([REQUEST_TOGGLE_SOLE_CALL_SITE]);
    expect(
      countMatches(withBypass, REQUEST_TOGGLE_CALL),
      'RED-first proof failed: expected the ORIGINAL call plus the planted bypass to total 2',
    ).toBe(2);
  });

  it('RED-first proof: a bypass planted in a DISTANT module (host/) is flagged too — the scan is not nextedit-scoped', () => {
    const withDistantBypass: StrippedSource[] = [
      ...loadStripped(SRC_ROOT),
      { file: 'host/__toggle_bypass_probe__.ts', content: 'void guard.requestToggle(req);' },
    ];
    expect(
      filesMatching(withDistantBypass, REQUEST_TOGGLE_CALL),
      'RED-first proof failed: a bypass planted in a module far from nextedit/ was not flagged — the scan may be incorrectly nextedit-scoped',
    ).toContain('host/__toggle_bypass_probe__.ts');
  });

  it('negative control: prose naming guard.requestToggle in a comment is not a call site', () => {
    // `autocomplete/index.ts` and `extension.ts` both DISCUSS the rule in
    // comments today — this control is what keeps that prose from tripping the
    // lock (and, equally, from satisfying it).
    const withProse: StrippedSource[] = [
      ...loadStripped(SRC_ROOT),
      {
        file: 'host/__toggle_prose_probe__.ts',
        content: stripComments('// route via requestNextEditToggle, never guard.requestToggle(...)\nconst x = 1;'),
      },
    ];
    expect(
      filesMatching(withProse, REQUEST_TOGGLE_CALL),
      'negative control failed: prose naming guard.requestToggle in a comment must not count as a call site',
    ).toEqual([REQUEST_TOGGLE_SOLE_CALL_SITE]);
  });
});

// ─────────────────── the ScannableSource contract this file rides ────────────

describe('the injected-probe technique matches the shared walker contract', () => {
  it('a synthetic probe is structurally a ScannableSource (in-memory injection, zero disk writes)', () => {
    const probe: ScannableSource = { file: 'host/__probe__.ts', content: 'const x = 1;' };
    expect(probe.file, 'a ScannableSource literal must carry its file field through unchanged').toBe(
      'host/__probe__.ts',
    );
    // No test in this file writes into a scanned directory: disk probes race
    // concurrently-walking sibling suites (`purityScan.ts`'s ENOENT-retry doc).
    expect(
      typeof probe.content,
      'a ScannableSource literal content field must be a plain string, matching every real collected source',
    ).toBe('string');
  });
});
