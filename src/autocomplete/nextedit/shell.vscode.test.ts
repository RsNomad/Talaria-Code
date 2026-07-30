import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscodeTypes from 'vscode';
import type {
  AnchoredProposal,
  EditableRegion,
  LineRange,
  NextEditEffect,
  NextEditRequest,
  RecentDiff,
  ScannedNextEditRequest,
} from './types';
import type { NextEditBackendOptions } from './backend';
import type { NextEditModelOutput, RenderedNextEditPrompt } from './formats/types';
import { must } from '../../testing/must';

/**
 * Task 12 Steps 1 + 3 — the effect executor, and the mode/trigger path.
 *
 * `vi.mock('vscode', ...)` follows the same discipline as
 * `nextedit/config.test.ts` and `context/editTracker.test.ts`: a minimal fake
 * module declared BEFORE the (hoisted) factory closes over it, with the real
 * module imported AFTER so it resolves against the fake.
 *
 * `./backend` is mocked too — these tests are about WHICH request the shell
 * decides to build and WHERE it routes it, not about the wire. The real
 * transport has its own suite (`backend.test.ts`).
 *
 * Test hygiene (Global Constraints): spies are plain functions pushing into
 * arrays, never `vi.fn()`, so nothing silently swallows a rejection.
 */

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

const host = {
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  registrationCounts: new Map<string, number>(),
  executed: [] as { command: string; args: unknown[] }[],
  docChangeHandlers: [] as ((e: FakeChangeEvent) => void)[],
  activeEditorHandlers: [] as ((editor: FakeEditor | undefined) => void)[],
  windowStateHandlers: [] as ((s: { focused: boolean }) => void)[],
  activeTextEditor: undefined as FakeEditor | undefined,
  /** F-3: `createEditTrackerAdapter` seeds its shadow cache from the VISIBLE
   *  editors, and only a seeded uri can ever produce a `RecentDiff`. The
   *  previous fake left this permanently empty, so `getRecentDiffs()` was
   *  vacuously empty in every shell test — which is why no test could see the
   *  shell hand the mint a cross-document diff it should have filtered. */
  visibleTextEditors: [] as FakeEditor[],
  visibleEditorHandlers: [] as ((editors: FakeEditor[]) => void)[],
  isTrusted: true,
  applyEditResult: true,
  appliedEdits: [] as { uri: string; range: unknown; newText: string }[],
  warnings: [] as string[],
  infos: [] as string[],
  settings: new Map<string, unknown>(),
  decorationCalls: [] as { type: string; ranges: unknown[] }[],
  reveals: [] as unknown[],
  /** Getter-access trace — the ONLY way to prove a later gate was never
   *  reached when an earlier one should have stopped the trigger. */
  accessLog: [] as string[],
  /** Fix-wave-2 FINDING A fault injection: makes `commands.executeCommand`
   *  throw synchronously, the way a broken host would. `clearAll()` calls it
   *  TWICE on a throwing effect (once inside the executor's own `try`, once
   *  again from its `catch`), so this is enough to make `dispatch()` itself
   *  throw — the one path `executor.run` cannot swallow. */
  throwOnExecuteCommand: false,
};

function resetHost(): void {
  host.registeredCommands.clear();
  host.registrationCounts.clear();
  host.executed.length = 0;
  host.docChangeHandlers.length = 0;
  host.activeEditorHandlers.length = 0;
  host.windowStateHandlers.length = 0;
  host.activeTextEditor = undefined;
  host.visibleTextEditors.length = 0;
  host.visibleEditorHandlers.length = 0;
  host.isTrusted = true;
  host.applyEditResult = true;
  host.appliedEdits.length = 0;
  host.warnings.length = 0;
  host.infos.length = 0;
  host.settings.clear();
  host.decorationCalls.length = 0;
  host.reveals.length = 0;
  host.accessLog.length = 0;
  host.throwOnExecuteCommand = false;
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
        host.registrationCounts.set(id, (host.registrationCounts.get(id) ?? 0) + 1);
        return { dispose() {} };
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        if (host.throwOnExecuteCommand) {
          throw new Error('executeCommand failure (fault injection)');
        }
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
        host.accessLog.push('activeTextEditor');
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
      onDidChangeVisibleTextEditors: (cb: (editors: FakeEditor[]) => void) => {
        host.visibleEditorHandlers.push(cb);
        return { dispose() {} };
      },
      get visibleTextEditors() {
        return host.visibleTextEditors;
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
      applyEdit: (edit: FakeWorkspaceEdit) => {
        host.appliedEdits.push(...edit.edits);
        return Promise.resolve(host.applyEditResult);
      },
      asRelativePath: (uri: { toString(): string }) => uri.toString(),
      get isTrusted() {
        host.accessLog.push('isTrusted');
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

/** Backend spy — captures both halves of the routing decision: the
 *  CONSTRUCTION options (apiBase/model/transport/sentinels) and every
 *  `predict` call (request, rendered prompt, abort signal). */
const backendSpy = {
  constructed: [] as NextEditBackendOptions[],
  predicts: [] as {
    opts: NextEditBackendOptions;
    req: {
      model: string;
      fileContext: string;
      changesAboveCursor: boolean;
      docVersion: number;
      diffs: readonly RecentDiff[];
    };
    rendered: RenderedNextEditPrompt;
    signal: AbortSignal;
  }[],
  /** Default: a completion that parses to a rewrite. */
  respond: (_signal: AbortSignal): Promise<NextEditModelOutput> =>
    Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const }),
  /**
   * W5.2 Task 2 — opt-in delegation to the REAL `NextEditHttpBackend`.
   *
   * Every other test in this file wants the wire stubbed out; the credential
   * tests below want the opposite, and cannot be written any other way. The
   * claim "a key plus a cleartext remote endpoint is REFUSED, and nothing
   * leaves the process" lives entirely inside the real `predict()` — its
   * `assertSecureAuthTransport` call and the `fetch` it guards. Against the
   * stub, `fetchCalls === 0` is true because no backend implementation exists
   * at all, which is the textbook vacuous guard: it would stay green with the
   * whole security check deleted.
   *
   * Default `false`, so no existing test's behaviour changes.
   */
  useRealTransport: false,
};

vi.mock('./backend', async () => {
  const actual = await vi.importActual<typeof import('./backend')>('./backend');
  return {
    NextEditHttpBackend: class {
      private readonly real: InstanceType<typeof actual.NextEditHttpBackend> | null;
      constructor(private readonly opts: NextEditBackendOptions) {
        backendSpy.constructed.push(opts);
        // B-3 ordering probe: `host.accessLog` already records `isTrusted`
        // reads, so pushing a construction marker into the SAME log gives the
        // two events one timeline. Without a shared timeline you can assert
        // "the gate ran" and "the backend was built" but never "in that
        // order" — which is exactly the constraint, and exactly what the audit
        // broke while the suite stayed green.
        host.accessLog.push('NextEditHttpBackend.constructed');
        this.real = backendSpy.useRealTransport ? new actual.NextEditHttpBackend(opts) : null;
      }
      predict(
        req: ScannedNextEditRequest,
        rendered: RenderedNextEditPrompt,
        signal: AbortSignal,
      ): Promise<NextEditModelOutput> {
        backendSpy.predicts.push({ opts: this.opts, req, rendered, signal });
        // The spy records the call either way — so `predicts` still reports
        // "a request was BUILT" even on the path where the real backend then
        // refuses to send it. That distinction is what the transport-guard
        // test asserts against `fetchCalls`.
        return this.real === null ? backendSpy.respond(signal) : this.real.predict(req, rendered, signal);
      }
    },
  };
});

/**
 * Mint spy (fix wave, FINDING 2) — GATE 5 has to be proven by its OWN
 * mechanism. `/home/u/.env` ALSO trips the request-level mint
 * (`scanSnippetForSecrets` rejects it on `ruleId: 'path'`), so a GATE-5 test
 * that only asserts "nothing was predicted" stays green with the shell's gate
 * deleted — the mint silently answers for it. This spy records every mint
 * call and delegates to the REAL implementation (behaviour unchanged
 * everywhere else), which lets the gate's own test assert the stronger claim:
 * the trigger stopped BEFORE the request was ever built, not after.
 *
 * A plain array + plain function, never `vi.fn()` (Global Constraints).
 */
const mintCalls: string[] = [];

vi.mock('./scan', async () => {
  const actual = await vi.importActual<typeof import('./scan')>('./scan');
  return {
    NEXT_EDIT_FIELD_CLASSIFICATION: actual.NEXT_EDIT_FIELD_CLASSIFICATION,
    contentChecksFor: actual.contentChecksFor,
    // V-1 — the REAL class, not a stand-in: `shell.vscode.ts`'s
    // `surfaceTriggerFailure` does `err instanceof NextEditMintRejectionError`
    // against whatever this partial mock exports under that name. Omitting
    // it here would leave the import `undefined` and turn every mint
    // rejection into a TypeError at the `instanceof` check instead of the
    // honest toast this fix exists to produce.
    NextEditMintRejectionError: actual.NextEditMintRejectionError,
    mintScannedNextEditRequest: (req: NextEditRequest, sentinels: readonly string[]) => {
      mintCalls.push(req.region.filepath);
      return actual.mintScannedNextEditRequest(req, sentinels);
    },
  };
});

import {
  makeExecutor,
  registerTalariaNextEdit,
  requestNextEditToggle,
  deriveGenericTransport,
  fimActivityRelay,
  GENERIC_SETUP_NOTE,
  NEXT_EDIT_MODEL_UNSET_NOTE,
  genericUnsupportedBackendMessage,
  type NextEditExecutorHost,
} from './shell.vscode';
import { NextEditGuard } from './guard';
import { BackendHttpError } from '../backends/http';
import { InsecureTransportError } from '../backends/secureTransport';
import type { ToggleState } from './mode';

// ─────────────────────────── Step 1: the executor ───────────────────────────

const REGION: EditableRegion = {
  uri: 'file:///w/a.ts',
  filepath: 'a.ts',
  startLine: 4,
  endLine: 8,
  content: 'const a = 1;\n',
};

const P: AnchoredProposal = { region: REGION, newText: 'const a = 2;\n', docVersion: 7, cursorLine: 6 };

interface MockHost extends NextEditExecutorHost {
  readonly contextKeys: Map<string, boolean>;
  readonly regionDecorationRanges: LineRange[];
  readonly reveals: LineRange[];
  readonly applies: { region: EditableRegion; newText: string }[];
  readonly notes: string[];
  readonly locatorTexts: string[];
  applyResolves: boolean;
  applyRejects: boolean;
  throwOnShowDecorations: boolean;
  /** F-1: the host DECLINES to paint (its editor is gone / no longer the one
   *  the proposal belongs to) — a silent early return, not a throw. */
  paintDeclined: boolean;
}

function makeMockHost(): MockHost {
  const contextKeys = new Map<string, boolean>();
  const regionDecorationRanges: LineRange[] = [];
  const mock: MockHost = {
    contextKeys,
    regionDecorationRanges,
    reveals: [],
    applies: [],
    notes: [],
    locatorTexts: [],
    applyResolves: true,
    applyRejects: false,
    throwOnShowDecorations: false,
    paintDeclined: false,
    setContext(key, value) {
      contextKeys.set(key, value);
    },
    showDecorations(p, jumped) {
      if (mock.throwOnShowDecorations) throw new Error('decoration failure');
      if (mock.paintDeclined) return false;
      regionDecorationRanges.length = 0;
      regionDecorationRanges.push({ startLine: p.region.startLine, endLine: p.region.endLine });
      mock.locatorTexts.push(jumped ? 'Tab to accept' : 'Tab to jump');
      return true;
    },
    clearDecorations() {
      regionDecorationRanges.length = 0;
    },
    reveal(range) {
      mock.reveals.push(range);
    },
    applyEdit(region, newText) {
      mock.applies.push({ region, newText });
      return mock.applyRejects ? Promise.reject(new Error('applyEdit threw')) : Promise.resolve(mock.applyResolves);
    },
    note(msgId) {
      mock.notes.push(msgId);
    },
  };
  return mock;
}

describe('next-edit effect executor', () => {
  it('INVARIANT (replaces the deleted wall-clock timeout): after every effect batch, jumpVisible === decorationsShown', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);
    const batches: NextEditEffect[][] = [
      [{ kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true }, { kind: 'showDecorations', p: P }],
      [{ kind: 'clearAll' }],
      [{ kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true }, { kind: 'showDecorations', p: P }],
      [{ kind: 'clearAll' }],
    ];
    for (const b of batches) {
      exec.run(b);
      expect(mock.contextKeys.get('talaria.nextEdit.jumpVisible') === true)
        .toBe(mock.regionDecorationRanges.length > 0);
    }
  });

  it('clearAll drives BOTH context keys false and clears the decorations', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);

    exec.run([
      { kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true },
      { kind: 'showDecorations', p: P },
      { kind: 'setContext', key: 'talaria.nextEdit.jumped', value: true },
    ]);
    expect(mock.regionDecorationRanges.length).toBe(1);

    exec.run([{ kind: 'clearAll' }]);
    expect(mock.contextKeys.get('talaria.nextEdit.jumpVisible')).toBe(false);
    expect(mock.contextKeys.get('talaria.nextEdit.jumped')).toBe(false);
    expect(mock.regionDecorationRanges.length).toBe(0);
  });

  it('an executor exception forces clearAll — the invariant survives a throwing host', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);
    mock.throwOnShowDecorations = true;

    exec.run([
      { kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true },
      { kind: 'showDecorations', p: P },
    ]);

    expect(mock.contextKeys.get('talaria.nextEdit.jumpVisible')).toBe(false);
    expect(mock.contextKeys.get('talaria.nextEdit.jumped')).toBe(false);
    expect(mock.regionDecorationRanges.length).toBe(0);
  });

  it('F-1: a DECLINED paint forces clearAll — a SILENT no-op host may not leave jumpVisible up with nothing on screen', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);
    mock.paintDeclined = true;

    // The exact batch `idle × proposalReady` emits. The executor's own header
    // names this invariant ("a stuck jumpVisible with nothing on screen would
    // silently steal Tab") but only enforced it for a THROWING host — a host
    // that early-returns walks straight through.
    exec.run([
      { kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true },
      { kind: 'showDecorations', p: P },
    ]);

    expect(mock.contextKeys.get('talaria.nextEdit.jumpVisible')).toBe(false);
    expect(mock.contextKeys.get('talaria.nextEdit.jumped')).toBe(false);
    expect(mock.regionDecorationRanges.length).toBe(0);
  });

  it('F-1: a paint DECLINED during the jumped re-render clears too (the locator re-render is a paint like any other)', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);

    exec.run([
      { kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true },
      { kind: 'showDecorations', p: P },
    ]);
    expect(mock.regionDecorationRanges.length).toBe(1);

    // The editor went away between the proposal and the jump.
    mock.paintDeclined = true;
    exec.run([{ kind: 'setContext', key: 'talaria.nextEdit.jumped', value: true }]);

    expect(mock.contextKeys.get('talaria.nextEdit.jumpVisible')).toBe(false);
    expect(mock.regionDecorationRanges.length).toBe(0);
  });

  it('reveal forwards the range to the host', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);
    exec.run([{ kind: 'reveal', range: { startLine: 4, endLine: 8 } }]);
    expect(mock.reveals).toEqual([{ startLine: 4, endLine: 8 }]);
  });

  it('applyEdit reports the host boolean back as an applyResult event', async () => {
    const mock = makeMockHost();
    const results: boolean[] = [];
    const exec = makeExecutor(mock, (ok) => void results.push(ok));

    mock.applyResolves = true;
    exec.run([{ kind: 'applyEdit', region: REGION, newText: 'const a = 2;\n' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(mock.applies).toEqual([{ region: REGION, newText: 'const a = 2;\n' }]);
    expect(results).toEqual([true]);
  });

  it('a REJECTED applyEdit is reported as applyResult(false), never as an unhandled rejection', async () => {
    const mock = makeMockHost();
    const results: boolean[] = [];
    const exec = makeExecutor(mock, (ok) => void results.push(ok));

    mock.applyRejects = true;
    exec.run([{ kind: 'applyEdit', region: REGION, newText: 'x' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(results).toEqual([false]);
  });

  it('noteOnce surfaces a given msgId exactly once, however many times it is emitted', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);

    exec.run([{ kind: 'noteOnce', msgId: 'apply-failed' }]);
    exec.run([{ kind: 'noteOnce', msgId: 'apply-failed' }]);
    exec.run([{ kind: 'noteOnce', msgId: 'other' }]);

    expect(mock.notes).toEqual(['apply-failed', 'other']);
  });

  it('the locator flips to "Tab to accept" once the jumped key goes up (the FSM tabJump batch carries no showDecorations)', () => {
    const mock = makeMockHost();
    const exec = makeExecutor(mock);

    exec.run([
      { kind: 'setContext', key: 'talaria.nextEdit.jumpVisible', value: true },
      { kind: 'showDecorations', p: P },
    ]);
    expect(mock.locatorTexts).toEqual(['Tab to jump']);

    exec.run([
      { kind: 'setContext', key: 'talaria.nextEdit.jumped', value: true },
      { kind: 'reveal', range: { startLine: 4, endLine: 8 } },
    ]);
    expect(mock.locatorTexts).toEqual(['Tab to jump', 'Tab to accept']);
    expect(mock.regionDecorationRanges.length).toBe(1);
  });
});

// ─────────────────── Step 3: mode wiring + the trigger path ──────────────────

const LINES = Array.from({ length: 21 }, (_, i) => `const v${i} = ${i};`);
const DOC_TEXT = `${LINES.join('\n')}\n`;

function makeDoc(options?: {
  uri?: string;
  scheme?: string;
  path?: string;
  version?: number;
  text?: string;
}): FakeDocument {
  const uri = options?.uri ?? 'file:///home/u/project/a.ts';
  const path = options?.path ?? '/home/u/project/a.ts';
  const scheme = options?.scheme ?? 'file';
  const text = options?.text ?? DOC_TEXT;
  // Real VS Code treats `\r\n` as ONE line terminator and excludes it from
  // `lineAt().text` entirely — splitting on '\n' alone would leave a stray
  // '\r' glued to the end of every CRLF line's mock `.text`, which is not
  // what the real API reports and would make a guard written against this
  // mock assert the wrong ground truth.
  const lines = text.split(/\r\n|\n/);
  return {
    uri: { scheme, path, fsPath: path, toString: () => uri },
    version: options?.version ?? 1,
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
      host.reveals.push(range);
    },
  };
}

function makeMemento(seed?: ToggleState): vscodeTypes.Memento {
  const store = new Map<string, unknown>();
  if (seed) store.set('hermes.nextEdit.toggles', seed);
  return {
    keys: () => [...store.keys()],
    get: (<T>(key: string, dflt?: T): T | undefined =>
      (store.has(key) ? (store.get(key) as T) : dflt)) as vscodeTypes.Memento['get'],
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
    },
  };
}

const SHELL_DEPS = {
  reportFailure: (msg: string) => void failures.push(msg),
  getAutocompleteEndpoint: () => autocompleteConfig.endpoint,
  getAutocompleteModel: () => autocompleteConfig.model,
  getAutocompleteBackend: () => autocompleteConfig.backend,
  // W5.2 Task 2 — the same live-closure posture as the three above, standing
  // in for `index.ts`'s `pickApiKey(secretApiKey, cfg.apiKey)`.
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

/** Registers the shell against a freshly-hydrated Guard. */
async function setupShell(toggles?: ToggleState): Promise<{
  guard: NextEditGuard;
  disposable: vscodeTypes.Disposable;
}> {
  const guard = await NextEditGuard.hydrate(makeMemento(toggles), { reportFailure: SHELL_DEPS.reportFailure });
  const disposable = registerTalariaNextEdit(makeContext(), guard, SHELL_DEPS);
  return { guard, disposable };
}

/**
 * Drives the ONE trigger path via its edit-burst source (a document change),
 * then settles the 350 ms debounce and the promise chain behind it.
 *
 * Deliberately NOT the R4 accept command: that command also clears FIM
 * visibility, which would defeat the very gate the FIM-busy tests are
 * asserting. R4 gets its own dedicated test instead.
 */
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
  const setContexts = host.executed.filter((e) => e.command === 'setContext' && e.args[0] === key);
  return setContexts.length === 0
    ? undefined
    : must(setContexts[setContexts.length - 1]).args[1];
}

/**
 * Fix wave FINDING 4 — `backendSpy.useRealTransport` was reset only inside
 * the W5.2 credentials suite's own `beforeEach` and inside
 * `runTriggerCapturingFetch`'s `finally`. Every other describe block in this
 * file relied on that being enough rather than resetting it themselves. A
 * FILE-SCOPED `afterEach` (declared outside any `describe`, so Vitest runs
 * it after EVERY test in this file) makes the reset unconditional instead of
 * depending on one block to leave shared spy state clean for the next.
 */
afterEach(() => {
  backendSpy.useRealTransport = false;
});

describe('next-edit trigger — the gates, IN ORDER', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GATE 1 (mode off): builds NOTHING — and never even looks at the active editor', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: false, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    // The mode gate is FIRST: with the capability off, nothing downstream is
    // consulted at all.
    expect(host.accessLog).not.toContain('activeTextEditor');
    expect(host.accessLog).not.toContain('isTrusted');
  });

  it('GATE 2 (FIM ghost text VISIBLE): builds nothing, and never reaches the trust gate', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(true); // a non-null item counts as visible
    host.accessLog.length = 0;

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.accessLog).not.toContain('isTrusted');
  });

  it('GATE 2 (FIM request IN FLIGHT): builds nothing — R2 covers in-flight, not just on-screen', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted(); // no resultShown yet: still in flight
    host.accessLog.length = 0;

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.accessLog).not.toContain('isTrusted');
  });

  it('GATE 3 (untrusted + remote endpoint): builds nothing', async () => {
    host.settings.set('talaria.nextEdit.endpoint', 'http://gpu.example.com:11434');
    host.activeTextEditor = makeEditor(makeDoc());
    host.isTrusted = false;
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
  });

  it('GATE 3 does NOT fire for an untrusted workspace on a LOOPBACK endpoint (parity with FIM S4.3)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    host.isTrusted = false;
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('GATE 4 (scheme filter): a vscode-scm document builds nothing (mirrors provider.ts)', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ scheme: 'vscode-scm' }));
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
  });

  it('GATE 5 (secret path): /home/u/.env builds nothing — FIM parity, not inherited', async () => {
    host.activeTextEditor = makeEditor(
      makeDoc({ uri: 'file:///home/u/.env', path: '/home/u/.env' }),
    );
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    // The load-bearing half. `predicts` alone cannot distinguish "the shell's
    // ACTIVE-FILE gate stopped the trigger" from "the gate was deleted and
    // the request-level mint threw on the same path" — both leave zero
    // predicts. The mint is a SEPARATE, content-level backstop (`08` §9.3:
    // secret-scan is NOT inherited); only the never-reached mint proves the
    // gate itself is alive. Delete GATE 5 and this assertion is what fails.
    expect(mintCalls).toEqual([]);
  });

  it('the mint spy is NOT vacuous: an all-gates-open trigger really does reach mintScannedNextEditRequest', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    // Without this, GATE 5's `mintCalls` assertion above could be passing
    // simply because the spy never observes anything at all.
    expect(mintCalls).toHaveLength(1);
  });

  it('all gates open: exactly ONE request is built and predicted', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
  });
});

describe('next-edit mode routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('NEXT routes to talaria.nextEdit.endpoint/model with the sweep-v2 format', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    const call = must(backendSpy.predicts[0]);
    expect(call.opts.apiBase).toBe('http://127.0.0.1:11435');
    expect(call.opts.model).toBe('sweep-next-edit-v2-7B');
    expect(call.opts.transport).toBe('ollama');
    // sweep-v2's own sentinel set — the format module is the single source.
    expect(call.opts.sentinels).toEqual(['<|file_sep|>', '<|cursor|>', '<|endoftext|>']);
    expect(call.rendered.prompt).toContain('<|cursor|>');
  });

  it('GENERIC routes to the AUTOCOMPLETE endpoint+model with the generic-instruct format', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: false, generic: true });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    const call = must(backendSpy.predicts[0]);
    expect(call.opts.apiBase).toBe('http://127.0.0.1:11434');
    expect(call.opts.model).toBe('qwen2.5-coder:7b');
    expect(call.rendered.prompt).toContain('<|im_start|>');
  });

  it('the built request carries the SAME model the backend is constructed with (backend.ts:129 fail-closed contract)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    const call = must(backendSpy.predicts[0]);
    expect(call.req.model).toBe(call.opts.model);
  });

  it('fileContext always ends in a newline (the sweepV2/generic render contract)', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: 'const a = 1;\nconst b = 2;' })); // no trailing \n
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(must(backendSpy.predicts[0]).req.fileContext.endsWith('\n')).toBe(true);
  });

  it('NEXT with an empty configured model builds nothing (an empty model can only 404)', async () => {
    host.settings.set('talaria.nextEdit.model', '');
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
  });

  it('deriveGenericTransport: ollama -> ollama, vllm|llamacpp -> openai-compat, codestral|openai-compat -> unsupported', () => {
    expect(deriveGenericTransport('ollama')).toBe('ollama');
    expect(deriveGenericTransport('vllm')).toBe('openai-compat');
    expect(deriveGenericTransport('llamacpp')).toBe('openai-compat');
    expect(deriveGenericTransport('codestral')).toBeNull();
    expect(deriveGenericTransport('openai-compat')).toBeNull();
  });
});

describe('next-edit toggle gate (transport support + the generic setup note)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the GENERIC setup note fires exactly once, on the ACCEPTED generic toggle-on', async () => {
    const guard = await NextEditGuard.hydrate(makeMemento(), { reportFailure: SHELL_DEPS.reportFailure });

    await requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS);

    expect(host.infos).toEqual([GENERIC_SETUP_NOTE]);
  });

  it('the setup note does NOT fire for a NEXT toggle-on, nor for a generic toggle-OFF', async () => {
    const guard = await NextEditGuard.hydrate(makeMemento(), { reportFailure: SHELL_DEPS.reportFailure });

    await requestNextEditToggle(guard, { source: 'next', on: true }, SHELL_DEPS);
    await requestNextEditToggle(guard, { source: 'next', on: false }, SHELL_DEPS);
    await requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS);
    await requestNextEditToggle(guard, { source: 'generic', on: false }, SHELL_DEPS);

    expect(host.infos).toEqual([GENERIC_SETUP_NOTE]); // only the one accepted generic toggle-ON
  });

  it('the setup note does NOT fire when the generic toggle-on is REFUSED by the Guard', async () => {
    const guard = await NextEditGuard.hydrate(makeMemento({ next: true, generic: false }), {
      reportFailure: SHELL_DEPS.reportFailure,
    });

    await expect(
      requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS),
    ).rejects.toThrow('mutually exclusive');

    expect(host.infos).toEqual([]);
  });

  it('a codestral FIM backend REFUSES the generic toggle-on with an actionable message (ADR-009)', async () => {
    autocompleteConfig.backend = 'codestral';
    const guard = await NextEditGuard.hydrate(makeMemento(), { reportFailure: SHELL_DEPS.reportFailure });

    await expect(
      requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS),
    ).rejects.toThrow(genericUnsupportedBackendMessage('codestral'));

    expect(guard.getState()).toEqual({ next: false, generic: false }); // nothing ratified
    expect(host.warnings).toEqual([genericUnsupportedBackendMessage('codestral')]);
    expect(host.infos).toEqual([]);                                    // and no setup note
  });

  it('an openai-compat FIM backend REFUSES the generic toggle-on too (Ollama OAI double-templating)', async () => {
    autocompleteConfig.backend = 'openai-compat';
    const guard = await NextEditGuard.hydrate(makeMemento(), { reportFailure: SHELL_DEPS.reportFailure });

    await expect(
      requestNextEditToggle(guard, { source: 'generic', on: true }, SHELL_DEPS),
    ).rejects.toThrow(genericUnsupportedBackendMessage('openai-compat'));

    expect(guard.getState()).toEqual({ next: false, generic: false });
  });

  it('an unsupported FIM backend never blocks turning generic OFF, nor the NEXT source', async () => {
    autocompleteConfig.backend = 'codestral';
    const guard = await NextEditGuard.hydrate(makeMemento({ next: false, generic: true }), {
      reportFailure: SHELL_DEPS.reportFailure,
    });

    await expect(requestNextEditToggle(guard, { source: 'generic', on: false }, SHELL_DEPS)).resolves.toEqual({
      next: false,
      generic: false,
    });
    await expect(requestNextEditToggle(guard, { source: 'next', on: true }, SHELL_DEPS)).resolves.toEqual({
      next: true,
      generic: false,
    });
  });
});

describe('next-edit R2 single-flight and the FIM seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('FIM requestStarted() ABORTS the in-flight next-edit signal (R2: FIM always wins)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    // A prediction that never settles on its own — only an abort can end it.
    backendSpy.respond = (signal: AbortSignal) =>
      new Promise<NextEditModelOutput>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(false);

    fimActivityRelay.requestStarted();

    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(true);
  });

  /**
   * A prediction whose settling this test controls. Deliberately NOT a
   * promise that rejects on abort: one that never settles makes the
   * "no proposal appeared" assertion vacuously true (nothing could ever
   * have produced one), which is exactly how the previous version of the
   * abort test below survived deleting the abort it claimed to test.
   * This response resolves with a perfectly good rewrite — the SAME one the
   * default responder uses — so the only thing that can keep a proposal off
   * the screen is the abort actually taking effect.
   */
  function deferredRewrite(): () => void {
    let settle = (): void => {};
    backendSpy.respond = () =>
      new Promise<NextEditModelOutput>((resolve) => {
        settle = () => resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
      });
    return () => settle();
  }

  it('CONTROL for the abort test: the deferred response, left UNaborted, does drive a proposal onto the screen', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    settle();
    await vi.advanceTimersByTimeAsync(0);

    // Non-vacuity proof for the next test: this exact response IS capable of
    // reaching proposalReady, so the abort test below is asserting a real
    // absence rather than an impossibility.
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    expect(host.decorationCalls.some((c) => c.ranges.length > 0)).toBe(true);
  });

  it('an aborted next-edit never reaches proposalReady — the abort itself is observed, not just the absence', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(false);

    fimActivityRelay.requestStarted();

    // The abort ITSELF — delete `abortInFlight()` from the FIM seam and this
    // assertion fails, rather than passing on a technicality.
    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(true);

    // The response lands anyway (an abort does not un-send a request already
    // on the wire); the shell must discard it rather than show it.
    settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).not.toBe(true);
    expect(host.decorationCalls.some((c) => c.ranges.length > 0)).toBe(false);
  });

  it('next-edit NEVER aborts FIM — running a full next-edit leaves the FIM in-flight state untouched', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);

    // FIM starts AFTER next-edit finished: FIM wins, and next-edit's own
    // completion never cancelled anything on the FIM side (the shell holds no
    // FIM cancellation handle at all — the seam is observation-only).
    fimActivityRelay.requestStarted();
    host.accessLog.length = 0;

    // FIM is now in flight, so the next trigger is refused by GATE 2 — proving
    // next-edit yielded to FIM rather than the reverse.
    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('R4 seam: accepting FIM ghost text arms the SAME trigger path (and clears FIM visibility first)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    // FIM shows and the user accepts it — the post-accept moment is exactly
    // when a next edit is most likely to exist.
    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(true);
    expect(backendSpy.predicts).toHaveLength(0); // still visible: GATE 2 holds

    await host.registeredCommands.get('talaria.nextEdit.onFimAccept')?.();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('OVERLAPPING FIM requests: a SUPERSEDED resultShown does not reopen GATE 2 while a newer request is still in flight', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    // The ordinary keystroke sequence. VS Code cancels FIM #1's token and
    // immediately invokes the provider again (#2), but #1's `finally` still
    // runs — LATER — and fires `resultShown(false)` for a request that is
    // already superseded. Boolean in-flight tracking read that as "FIM is
    // idle" while #2 was genuinely in flight.
    fimActivityRelay.requestStarted(); // #1
    fimActivityRelay.requestStarted(); // #2 — supersedes #1
    fimActivityRelay.resultShown(false); // #1's finally, arriving out of order

    await fireTrigger();

    // R2 is load-bearing: next-edit may not even BUILD a request while a FIM
    // request is in flight.
    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.accessLog).not.toContain('isTrusted');
  });

  it('OVERLAPPING FIM requests: a SUPERSEDED resultShown cannot clear a visible ghost-text flag either', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted(); // #1
    fimActivityRelay.resultShown(true); // #1 put ghost text on screen
    fimActivityRelay.requestStarted(); // #2 — now in flight
    fimActivityRelay.resultShown(false); // a STALE settle for #1, after #2 started

    // #2 settles with nothing: only THIS (non-superseded) result may speak for
    // visibility. It reports no item, so the gate legitimately reopens.
    fimActivityRelay.resultShown(false);

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('the LAST in-flight FIM request settling is what reopens GATE 2 — one resultShown per requestStarted', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted(); // #1
    fimActivityRelay.requestStarted(); // #2
    fimActivityRelay.resultShown(false); // #1 settles — #2 still in flight
    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(0);

    fimActivityRelay.resultShown(false); // #2 settles — FIM is genuinely idle
    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('resultShown(false) releases GATE 2 — a FIM request that produced nothing does not block next-edit forever', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(false);

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('FIX WAVE 2 FINDING A: a throw out of dispatch() inside requestStarted() must not strand the in-flight count', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    // Force `dispatch()` to throw INSIDE `requestStarted()`: `fimVisibility`
    // (true) reduces to a single `clearAll` effect from any state, and a
    // throwing `executeCommand` makes `clearAll()` throw both on the
    // executor's first attempt AND on its own catch-driven retry — the one
    // case `executor.run` cannot swallow.
    host.throwOnExecuteCommand = true;

    // Must not escape this call: `provider.ts` sets its own `fimRequested`
    // flag only AFTER `requestStarted()` returns (`provider.ts:367`), and
    // only a set flag makes its `finally` call the paired `resultShown`
    // later. A throw here skips that flag and, unlike the boolean this
    // refcount replaced, the count does not self-heal on the next FIM
    // cycle — GATE 2 would stay closed for the rest of the session.
    expect(() => fimActivityRelay.requestStarted()).not.toThrow();

    host.throwOnExecuteCommand = false;

    // Pairing still works normally: the request this call represents can
    // still settle and hand GATE 2 back.
    fimActivityRelay.resultShown(false);

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('FIX WAVE 2 FINDING B: an UNPAIRED settle (count already 0) must not touch fim.visible either', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    // A clean cycle: FIM goes visible, and settles — count is back to 0.
    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(true);
    host.accessLog.length = 0;

    // A stray, UNPAIRED settle arrives — no matching `requestStarted` for
    // it, so the count is already 0 before this call. Before the fix, the
    // clamp (`Math.max(0, count - 1)`) left the count at 0 either way, so
    // the superseded-settle guard (`if (count > 0) return`) did not fire —
    // and `fim.visible` was overwritten with `hasItem` (false) regardless,
    // silently clearing a GENUINELY visible ghost-text flag and reopening
    // GATE 2 against R2.
    fimActivityRelay.resultShown(false);

    await fireTrigger();
    // R2 must still hold: real ghost text is on screen, so next-edit may
    // not even build a request.
    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.accessLog).not.toContain('isTrusted');
  });

  it('a successful prediction shows the proposal (jumpVisible up, region decorated)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    expect(host.decorationCalls.some((c) => c.ranges.length > 0)).toBe(true);
  });
});

/**
 * F-1 (UI Critical · ARCH I-1 · CODE C-7) — the editor-identity defect. Three
 * of the four final-review lenses found this independently.
 *
 * NOTHING in this suite ever changed `host.activeTextEditor` BETWEEN the
 * trigger and the proposal before these tests: all 34 `activeTextEditor =`
 * sites set one editor and keep it, which is exactly why the defect shipped.
 */
describe('next-edit editor identity across the round trip (F-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A prediction whose settling the test controls, resolving with a rewrite
   *  that IS capable of reaching `proposalReady` (see the control below). */
  function deferredRewrite(): () => void {
    let settle = (): void => {};
    backendSpy.respond = () =>
      new Promise<NextEditModelOutput>((resolve) => {
        settle = () => resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
      });
    return () => settle();
  }

  function otherDoc(): FakeDocument {
    return makeDoc({ uri: 'file:///home/u/project/b.ts', path: '/home/u/project/b.ts' });
  }

  it('CONTROL: the same deferred response, with the SAME editor still active, does drive a proposal onto the screen', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    expect(host.decorationCalls.some((c) => c.ranges.length > 0)).toBe(true);
  });

  it('a proposal that lands after the user switched FILES never reaches proposalReady (no stuck jumpVisible, no hijacked Tab)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const settle = deferredRewrite();
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);

    // The user switches to b.ts while a.ts's request is on the wire. The
    // shell re-checks `document.version` and `fimBusy()` after the await —
    // neither of which moved — but never that the proposal's editor is the
    // one the user is now looking at.
    host.activeTextEditor = makeEditor(otherDoc());

    settle();
    await vi.advanceTimersByTimeAsync(0);

    // `jumpVisible` true with zero decorations anywhere is the failure: Tab
    // in b.ts would fire `talaria.nextEdit.jump` instead of indenting.
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).not.toBe(true);
    expect(host.decorationCalls.some((c) => c.ranges.length > 0)).toBe(false);

    // The LOAD-BEARING half, and the same discipline GATE 5's `mintCalls`
    // assertion uses. The two settled assertions above cannot tell "the
    // trigger re-checked identity and never dispatched" from "it dispatched
    // and the declined paint cleaned up after it" — F-1's fix has two halves
    // and each must be provable on its own. `jumpVisible` was never even
    // RAISED here: delete the post-round-trip `editorFor(uri)` re-check and
    // this is the assertion that fails.
    const raised = host.executed.filter(
      (e) => e.command === 'setContext' && e.args[0] === 'talaria.nextEdit.jumpVisible' && e.args[1] === true,
    );
    expect(raised).toEqual([]);
  });

  it('reveal never acts on a FOREIGN editor — b.ts is not scrolled to a line range taken from a.ts geometry', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });
    await fireTrigger();
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);

    // The active editor moves WITHOUT the `onDidChangeActiveTextEditor`
    // handler firing — the race the uri check exists for. `reveal` reads
    // `vscode.window.activeTextEditor` directly, so nothing else stops it.
    host.activeTextEditor = makeEditor(otherDoc());
    host.reveals.length = 0;

    await host.registeredCommands.get('talaria.nextEdit.jump')?.();

    expect(host.reveals).toEqual([]);
  });
});

/**
 * F-2 (CODE C-1) — a second proposal while one is on screen destroys both.
 * `proposed × proposalReady` is UNMODELED in T10's FSM (`fsm.test.ts:80`
 * pins `idle + clearAll`), and the trigger had no state gate at all.
 */
describe('next-edit does not build while a proposal owns the screen (F-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A tall document so the region (cursor ± 10) has room above it. */
  const TALL = `${Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;

  it('an edit ABOVE the region, WITH the debounce advanced, keeps the remapped proposal instead of eating both', async () => {
    const doc = makeDoc({ text: TALL });
    host.activeTextEditor = makeEditor(doc, 40); // region = lines 30..50
    await setupShell({ next: true, generic: false });
    await fireTrigger();
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    expect(backendSpy.predicts).toHaveLength(1);

    // Insert two lines at line 5 — entirely above the region, so `remapRange`
    // succeeds and the state stays `proposed`. The shipped shell ALSO armed
    // the debounced trigger on this same event; 350 ms later the model
    // returned a valid rewrite and `proposed × proposalReady` cleared
    // everything, discarding the new proposal too.
    doc.version += 1;
    for (const handler of host.docChangeHandlers) {
      handler({
        document: doc,
        contentChanges: [
          { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, text: 'a\nb\n' },
        ],
      });
    }
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    // R2's shape, applied to next-edit's own surface: do not even BUILD a
    // request while something is displayed.
    expect(backendSpy.predicts).toHaveLength(1);
    // And the remapped proposal is still on screen.
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
  });

  it('dismissing the proposal re-opens the trigger — the gate is a gate, not a permanent stop', async () => {
    const doc = makeDoc({ text: TALL });
    host.activeTextEditor = makeEditor(doc, 40);
    await setupShell({ next: true, generic: false });
    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);

    await host.registeredCommands.get('talaria.nextEdit.dismiss')?.();
    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(2);
  });
});

/**
 * F-3 (CODE C-2) — one `.env` edit silently killed next-edit for EVERY file.
 *
 * `getRecentDiffs()` is a CROSS-DOCUMENT ring (`editTrackerAdapter.ts:199`).
 * The shell passed it to the mint unfiltered; `scan.ts` scans each
 * `before`/`after` under `path: diff.filepath` and the FIRST reject aborts
 * the whole mint, so a single `.env` diff poisoned every subsequent request
 * until the 16-entry ring evicted it.
 *
 * The FIM sibling gets this right — `ringBuffer.ingest` drops the offending
 * snippet and keeps working everywhere else. These tests pin the same shape
 * for next-edit. The MINT IS NOT WEAKENED anywhere: it still fails closed on
 * everything it is handed.
 */
describe('next-edit filters the cross-document diff ring before the mint (F-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Seeds ONE tracked diff for `uri` into the (cross-document) ring, then
   * leaves `a.ts` active. Mirrors what the adapter does for a real edit: the
   * uri must be VISIBLE first (that is what seeds its shadow), and only then
   * does a content change produce a `RecentDiff`.
   */
  async function withTrackedDiffIn(uri: string, path: string): Promise<void> {
    const foreign = makeDoc({ uri, path, text: 'ALPHA=1\nBETA=2\n' });
    const foreignEditor = makeEditor(foreign, 0);
    host.visibleTextEditors.push(foreignEditor);
    host.activeTextEditor = foreignEditor;

    await setupShell({ next: true, generic: false });

    foreign.version += 1;
    for (const handler of host.docChangeHandlers) {
      handler({
        document: foreign,
        contentChanges: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: '9' },
        ],
      });
    }

    // The user moves to an ordinary source file. The ring still holds the
    // foreign diff — it is cross-document by design.
    host.activeTextEditor = makeEditor(makeDoc());
  }

  it('CONTROL: a diff from an ORDINARY file is carried into the request (the filter is not just dropping everything)', async () => {
    await withTrackedDiffIn('file:///w/notes.ts', '/w/notes.ts');

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    expect(must(backendSpy.predicts[0]).req.diffs.map((d) => d.filepath)).toEqual([
      'file:///w/notes.ts',
    ]);
  });

  it('a .env diff is DROPPED and next-edit keeps working in a.ts (the mint is never handed it)', async () => {
    await withTrackedDiffIn('file:///w/.env', '/w/.env');

    await fireTrigger();

    // Before: the mint threw `ruleId=path` and the shell's empty catch
    // swallowed it — zero predicts, no message, for every file, until the
    // ring evicted the entry.
    expect(backendSpy.predicts).toHaveLength(1);
    expect(must(backendSpy.predicts[0]).req.diffs).toEqual([]);
  });

  it('a .env diff does not stop an ORDINARY diff in the same ring from egressing (drop the entry, not the feature)', async () => {
    await withTrackedDiffIn('file:///w/.env', '/w/.env');

    // A second tracked document, this one perfectly ordinary.
    const ok = makeDoc({ uri: 'file:///w/notes.ts', path: '/w/notes.ts', text: 'ALPHA=1\nBETA=2\n' });
    const okEditor = makeEditor(ok, 0);
    host.visibleTextEditors.push(okEditor);
    for (const handler of host.visibleEditorHandlers) {
      handler(host.visibleTextEditors);
    }
    ok.version += 1;
    for (const handler of host.docChangeHandlers) {
      handler({
        document: ok,
        contentChanges: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: '9' },
        ],
      });
    }
    host.activeTextEditor = makeEditor(makeDoc());

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    expect(must(backendSpy.predicts[0]).req.diffs.map((d) => d.filepath)).toEqual([
      'file:///w/notes.ts',
    ]);
  });
});

/**
 * F-4 (ARCH I-2, ranked #1 for "what will hurt the next wave") — the
 * silent-failure posture, plus the two Minors that ride on it (F-5, C-5).
 *
 * `08` §9.3 promises transport-guard refusals "surface once (actionable)".
 * The shipped catch swallowed EVERYTHING non-abort, so a CWE-319 refusal, a
 * wrong endpoint or a 404-ing model left next-edit silently dead forever —
 * the exact silent-default class T16 closed on the FIM side.
 *
 * Global Constraint, binding on every message below: error messages never
 * carry a response body or an API key, and never the matched secret text.
 */
describe('next-edit fails VISIBLY, once (F-4 / F-5 / C-5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 404 model surfaces ONE actionable warning naming the model and the setting — and never a second time', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    backendSpy.respond = () =>
      Promise.reject(new BackendHttpError('Next-edit Ollama /api/generate failed: 404 Not Found', 404, 'Not Found'));
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toContain('sweep-next-edit-v2-7B');
    expect(host.warnings[0]).toContain('talaria.nextEdit.model');
    expect(failures).toHaveLength(1);

    // One-shot: a failing config must not toast on every keystroke.
    await fireTrigger();
    await fireTrigger();
    expect(host.warnings).toHaveLength(1);
  });

  it('a 401 surfaces once, and the message carries NO response body and NO api key', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    backendSpy.respond = () =>
      Promise.reject(new BackendHttpError('failed: 401 Unauthorized', 401, 'Unauthorized'));
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toContain('401');
    // Global Constraint: status + statusText only.
    expect(host.warnings[0]).not.toContain('sk-');
    expect(host.warnings[0]).not.toContain('Bearer');
  });

  it('a CWE-319 transport refusal surfaces once, WITHOUT echoing the throw site (which can carry the raw url)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    backendSpy.respond = () =>
      Promise.reject(
        new InsecureTransportError('refusing to send Authorization over cleartext http://user:pw@gpu.example.com (CWE-319)'),
      );
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).not.toContain('user:pw');
    expect(host.warnings[0]).not.toContain('CWE-319');
    expect(host.warnings[0]).toContain('https');
  });

  it('an ABORTED request surfaces NOTHING — aborts are the common case, not a failure', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    backendSpy.respond = (signal: AbortSignal) =>
      new Promise<NextEditModelOutput>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);

    fimActivityRelay.requestStarted(); // R2: FIM-start aborts next-edit
    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(true);

    // Settle the rejected `await` inside `trigger()` — the abort rejection
    // reaches the catch as a microtask, and a single timer flush is NOT
    // enough to run it. Without these the assertions below would be vacuous:
    // "nothing was surfaced" would be true only because the catch had not run
    // yet, and deleting the abort check would still leave this test green.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(host.warnings).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('F-5: NEXT on with an EMPTY talaria.nextEdit.model says so once, instead of being permanently, silently inert', async () => {
    host.settings.set('talaria.nextEdit.model', '');
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.warnings).toEqual([NEXT_EDIT_MODEL_UNSET_NOTE]);
    expect(NEXT_EDIT_MODEL_UNSET_NOTE).toContain('talaria.nextEdit.model');
    expect(failures).toEqual([NEXT_EDIT_MODEL_UNSET_NOTE]);

    await fireTrigger();
    expect(host.warnings).toHaveLength(1);
  });

  it('C-5: an unsupported FIM backend adopted AFTER Generic was ratified surfaces the same actionable refusal, once', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: false, generic: true });

    // Ratified against ollama; the user then switches
    // `talaria.autocomplete.backend`. The toggle stays ON, and before this the
    // run-time path just returned `null` — permanently, silently dead.
    autocompleteConfig.backend = 'codestral';

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.warnings).toEqual([genericUnsupportedBackendMessage('codestral')]);

    await fireTrigger();
    expect(host.warnings).toHaveLength(1);
  });
});

/**
 * V-1 — next-edit was structurally dead on any file over ~16 KB / ~450
 * lines: the whole document went into `fileContext`/`docText`/
 * `preEditDocText`, and the request-level mint's own `MAX_SCAN_CONTENT`
 * (16 000 chars, `secretScanner.ts`) rejected it on EVERY trigger — for a
 * request that was NEVER SENT, the old toast then blamed a healthy server
 * ("check that the server is running"). Fix: bound the doc-level context to
 * a SCANNED window around the cursor (vendor-conformant ±150 lines,
 * `fileWindow.ts`'s `windowAroundCursor`), strictly BEFORE the one mint
 * (`scan.ts`) — the mint itself, and its scan rules, are UNCHANGED.
 *
 * No existing fixture in this file (or `integration.test.ts`) pins a
 * whole-document assertion that the fix overturns: every document these
 * suites already use is well under 150 lines / 12 000 chars, so the window
 * equals the whole file for all of them and their behaviour is unchanged
 * (re-verified: the full pre-existing suite stays green with the production
 * fix applied, zero retitles needed).
 */
describe('V-1: next-edit is not structurally dead on an oversized file (bounded, scanned window)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 600 lines x ~48 chars/line ≈ 29 KB — comfortably over the old
   *  whole-file `MAX_SCAN_CONTENT` bound (16 000 chars) and the vendor's own
   *  ±150-line window. */
  const BIG_LINES = Array.from(
    { length: 600 },
    (_, i) => `const bigVariable${i} = ${i}; // padding padding pad`,
  );
  const BIG_DOC = `${BIG_LINES.join('\n')}\n`;
  const CURSOR_LINE = 300;

  it('RED-1: a 600-line/~29KB document builds and sends a request instead of dying at the mint on every trigger', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: BIG_DOC }), CURSOR_LINE);
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    expect(host.warnings).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('RED-1b: the sent fileContext is bounded under the mint budget (<=12 000 chars), not the whole ~29KB file', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: BIG_DOC }), CURSOR_LINE);
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    const call = must(backendSpy.predicts[0]);
    expect(call.req.fileContext.length).toBeLessThanOrEqual(12_000);
    expect(call.req.fileContext.length).toBeLessThan(BIG_DOC.length);
  });

  it('RED-1c: the window is a contiguous slice containing the cursor line, and IS what sweepV2 renders as {initial_file} (vendor shape)', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: BIG_DOC }), CURSOR_LINE);
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    const call = must(backendSpy.predicts[0]);
    expect(call.req.fileContext).toContain(`const bigVariable${CURSOR_LINE} = ${CURSOR_LINE};`);
    // sweepV2's render splices `req.fileContext` verbatim right after the
    // `<|file_sep|>{path}\n` header — `{initial_file}` === the window.
    expect(call.rendered.prompt).toContain(call.req.fileContext);
  });

  it('RED-2: an oversized line 200 lines above the cursor (well outside the ±150 window) does not poison the mint or reach the wire', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `const filler${i} = ${i};`);
    lines[100] = 'x'.repeat(3000); // 200 lines above cursor(300) — structurally outside the window
    const doc = `${lines.join('\n')}\n`;
    host.activeTextEditor = makeEditor(makeDoc({ text: doc }), CURSOR_LINE);
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(1);
    expect(host.warnings).toEqual([]);
    const call = must(backendSpy.predicts[0]);
    expect(call.req.fileContext).not.toContain('x'.repeat(3000));
  });

  it('RED-3: a 3 000-char line ON the cursor line makes the mint reject oversized-line, and the toast is the HONEST mint-rejection copy (never the server-blame fallback)', async () => {
    const lines = Array.from({ length: 21 }, (_, i) => `const v${i} = ${i};`);
    lines[10] = 'x'.repeat(3000);
    const doc = `${lines.join('\n')}\n`;
    // Cursor on line 10 — the oversized line itself. The ±10-line REGION
    // (unwindowed) always contains the cursor line, so it carries the
    // oversized line regardless of doc-level windowing — correct and
    // honest (next-edit over a minified line is meaningless).
    host.activeTextEditor = makeEditor(makeDoc({ text: doc }), 10);
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    expect(backendSpy.predicts).toHaveLength(0);
    // The mint WAS reached (and rejected) — this is not an earlier gate skip.
    expect(mintCalls).toHaveLength(1);
    expect(host.warnings).toHaveLength(1);
    const msg = must(host.warnings[0]);
    expect(msg).toContain('oversized-line');
    expect(msg).toContain('No request was sent');
    expect(msg.toLowerCase()).not.toContain('server');
    expect(msg).not.toContain('talaria.nextEdit.endpoint');
    expect(msg).not.toContain('talaria.nextEdit.model');
    expect(failures).toEqual([msg]);
  });

  /**
   * RED-4 — the egress-drift lock (mutation-proven, both directions): a
   * secret INSIDE the window still makes the mint reject (fail-closed is
   * NOT weakened by windowing); the SAME secret OUTSIDE the window in a
   * file that is otherwise clean lets the request through, AND the secret
   * text never reaches the wire (strictly LESS egress than the pre-fix
   * whole-document scan, which would have rejected on this secret
   * regardless of how far it sat from the cursor).
   */
  describe('RED-4: egress-drift lock — the window is what gets scanned, not the whole file', () => {
    const TOTAL_LINES = 400;
    const CURSOR = 200;
    // A real AWS access-key-id shape (`secretScanner.ts`'s `aws-akia`
    // provider detector: /\bAKIA[0-9A-Z]{16}\b/).
    const SECRET = 'AKIAABCDEFGHIJKLMNOP';

    function buildDoc(secretLine: number): string {
      const lines = Array.from({ length: TOTAL_LINES }, (_, i) =>
        i === secretLine ? `const leaked = "${SECRET}";` : `const filler${i} = ${i};`,
      );
      return `${lines.join('\n')}\n`;
    }

    it('a secret INSIDE the +-150-line window (outside the +-10 region) still makes the mint reject', async () => {
      const doc = buildDoc(CURSOR + 50); // 50 lines below cursor: inside the window, outside the region
      host.activeTextEditor = makeEditor(makeDoc({ text: doc }), CURSOR);
      await setupShell({ next: true, generic: false });

      await fireTrigger();

      expect(backendSpy.predicts).toHaveLength(0);
      expect(mintCalls).toHaveLength(1);
      expect(host.warnings).toHaveLength(1);
      const msg = must(host.warnings[0]);
      expect(msg).toContain('aws-akia');
      expect(msg).not.toContain(SECRET);
    });

    it('the SAME secret OUTSIDE the window (180 lines from the cursor) lets the request through, and the secret text never reaches the wire', async () => {
      const doc = buildDoc(CURSOR - 180); // 180 lines above cursor: outside the +-150 window and the +-10 region
      host.activeTextEditor = makeEditor(makeDoc({ text: doc }), CURSOR);
      await setupShell({ next: true, generic: false });

      await fireTrigger();

      expect(backendSpy.predicts).toHaveLength(1);
      expect(host.warnings).toEqual([]);
      const call = must(backendSpy.predicts[0]);
      expect(call.req.fileContext).not.toContain(SECRET);
      expect(call.rendered.prompt).not.toContain(SECRET);
    });
  });
});

/**
 * C-6 — `fim.visible` had no clearer for ghost text the USER dismissed. Esc
 * on ghost text is unobservable on the stable API, so only the NEXT FIM
 * request settling could ever lower the flag — and if FIM is disabled in the
 * meantime, GATE 2 stays shut for the rest of the session. Fails closed
 * (R2-safe), but it is a silent-dead-feature path.
 */
describe('next-edit recovers from stale FIM ghost-text visibility (C-6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an ACTIVE-EDITOR switch clears the stale visible flag — ghost text cannot outlive the editor it was painted in', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(true); // ghost text on screen; count back to 0

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(0); // GATE 2 correctly holds

    host.activeTextEditor = makeEditor(
      makeDoc({ uri: 'file:///home/u/project/b.ts', path: '/home/u/project/b.ts' }),
    );
    for (const handler of host.activeEditorHandlers) {
      handler(host.activeTextEditor);
    }

    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
  });

  it('R2 IS NOT WEAKENED: an editor switch never clears the FIM IN-FLIGHT count', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted(); // in flight, never settled

    for (const handler of host.activeEditorHandlers) {
      handler(host.activeTextEditor);
    }
    host.accessLog.length = 0;

    await fireTrigger();

    // A live FIM request still owns the gate — next-edit may not even BUILD.
    expect(backendSpy.predicts).toHaveLength(0);
    expect(host.accessLog).not.toContain('isTrusted');
  });
});

/**
 * U-7 — the locator was decoration, not information: `⤵ ${distance} lines`
 * with `distance = |region.startLine − cursorLine|` and a region of
 * cursor ± windowLines reads "⤵ 10 lines" for EVERY proposal past line 10 —
 * a constant — and the DOWN arrow pointed at a region starting ten lines
 * ABOVE the cursor.
 */
describe('next-edit locator says something true (U-7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The locator decoration carries `{ range, renderOptions }`; the region
   *  decoration carries bare ranges. Tell them apart by shape. */
  function lastLocatorText(): string {
    const texts = host.decorationCalls
      .flatMap((c) => c.ranges)
      .map((r) => (r as { renderOptions?: { after?: { contentText?: string } } }).renderOptions?.after?.contentText)
      .filter((t): t is string => typeof t === 'string');
    return texts[texts.length - 1] ?? '';
  }

  const TALL = `${Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;

  it('names the real region span in 1-based editor coordinates, not a constant distance', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: TALL }), 40); // region = lines 30..50
    await setupShell({ next: true, generic: false });

    await fireTrigger();

    const locator = lastLocatorText();
    expect(locator).toContain('31'); // 0-based 30 rendered as the editor shows it
    expect(locator).toContain('51');
    // The two falsehoods, gone: a constant distance and a DOWN arrow aimed at
    // a region that starts above the cursor.
    expect(locator).not.toContain('⤵');
    expect(locator).not.toContain('10 lines');
    // The parts that were always true are preserved verbatim.
    expect(locator).toContain('Tab to jump');
    expect(locator).toContain('Esc to dismiss');
  });

  it('is not a constant: a proposal at a different cursor line reads differently', async () => {
    host.activeTextEditor = makeEditor(makeDoc({ text: TALL }), 40);
    const first = await (async (): Promise<string> => {
      await setupShell({ next: true, generic: false });
      await fireTrigger();
      return lastLocatorText();
    })();

    resetHost();
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
    host.activeTextEditor = makeEditor(makeDoc({ text: TALL }), 20); // region = 10..30
    await setupShell({ next: true, generic: false });
    await fireTrigger();

    expect(lastLocatorText()).not.toBe(first);
  });
});

describe('next-edit document listeners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Brings the shell to a live, on-screen proposal. */
  async function withProposal(): Promise<FakeDocument> {
    const doc = makeDoc();
    host.activeTextEditor = makeEditor(doc);
    await setupShell({ next: true, generic: false });
    await fireTrigger();
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    return doc;
  }

  function fireDocChange(doc: FakeDocument, version: number, changes: FakeChangeEvent['contentChanges']): void {
    doc.version = version;
    for (const handler of host.docChangeHandlers) {
      handler({ document: doc, contentChanges: changes });
    }
  }

  it('a VERSION MISMATCH dismisses the proposal (docChanged(null) => idle)', async () => {
    const doc = await withProposal();

    // Version jumps by two: at least one change event was missed, so the
    // contentChanges in hand cannot describe the full delta.
    fireDocChange(doc, doc.version + 2, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x' },
    ]);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
  });

  it('an edit OVERLAPPING the region dismisses the proposal (remapRange returns null)', async () => {
    const doc = await withProposal();

    fireDocChange(doc, doc.version + 1, [
      { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 3 } }, text: 'zzz' },
    ]);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
  });

  it('an edit ENTIRELY ABOVE the region SHIFTS the proposal down instead of dismissing it', async () => {
    // A taller document so the region (cursor ± 10 lines) has room above it.
    const tall = `${Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;
    const doc = makeDoc({ text: tall });
    host.activeTextEditor = makeEditor(doc, 40); // region = lines 30..50
    await setupShell({ next: true, generic: false });
    await fireTrigger();
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);

    // The REGION decoration carries bare ranges; the locator decoration
    // carries `{ range, renderOptions }` entries. Tell them apart by shape.
    const regionCalls = (): { ranges: unknown[] }[] =>
      host.decorationCalls.filter(
        (c) => c.ranges.length > 0 && (c.ranges[0] as { start?: unknown }).start !== undefined,
      );
    const before = regionCalls().length;

    // Insert two lines at line 5 — entirely above the region, no overlap, so
    // remapRange shifts the tracked span by +2 rather than returning null.
    fireDocChange(doc, doc.version + 1, [
      { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, text: 'a\nb\n' },
    ]);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    const after = regionCalls();
    expect(after.length).toBeGreaterThan(before);
    // The re-anchored region starts 2 lines lower than the original 30.
    const lastRegionRange = must(after[after.length - 1]).ranges[0] as { start: { line: number } };
    expect(lastRegionRange.start.line).toBe(32);
  });

  it('editorChanged (active editor switch) clears the proposal', async () => {
    await withProposal();

    for (const handler of host.activeEditorHandlers) {
      handler(undefined);
    }

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
  });

  it('focusLost (window unfocused) clears the proposal', async () => {
    await withProposal();

    for (const handler of host.windowStateHandlers) {
      handler({ focused: false });
    }

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
  });

  it('a window state that REGAINS focus does not disturb a live proposal', async () => {
    await withProposal();

    for (const handler of host.windowStateHandlers) {
      handler({ focused: true });
    }

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
  });
});

describe('next-edit commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers each next-edit command exactly ONCE', async () => {
    await setupShell({ next: false, generic: false });

    for (const id of [
      'talaria.nextEdit.jump',
      'talaria.nextEdit.accept',
      'talaria.nextEdit.dismiss',
      'talaria.nextEdit.onFimAccept',
    ]) {
      expect(host.registrationCounts.get(id), `${id} registration count`).toBe(1);
    }
  });

  it('jump then accept applies the edit through a plain WorkspaceEdit (never the ACP diff gate)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });
    await fireTrigger();

    await host.registeredCommands.get('talaria.nextEdit.jump')?.();
    expect(contextKeyValue('talaria.nextEdit.jumped')).toBe(true);

    await host.registeredCommands.get('talaria.nextEdit.accept')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.appliedEdits).toHaveLength(1);
    expect(must(host.appliedEdits[0]).newText).toContain('REWRITTEN LINE');
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
  });

  it('a FAILED applyEdit dismisses and notes once', async () => {
    host.applyEditResult = false;
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });
    await fireTrigger();

    await host.registeredCommands.get('talaria.nextEdit.jump')?.();
    await host.registeredCommands.get('talaria.nextEdit.accept')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
    expect(host.warnings).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('dismiss (Esc) clears the proposal', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });
    await fireTrigger();

    await host.registeredCommands.get('talaria.nextEdit.dismiss')?.();

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
  });

  it('disposing the shell detaches the FIM relay (a later FIM event is a no-op)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const { disposable } = await setupShell({ next: true, generic: false });

    disposable.dispose();

    // Must not throw and must not reach a torn-down shell.
    expect(() => fimActivityRelay.requestStarted()).not.toThrow();
    expect(() => fimActivityRelay.resultShown(true)).not.toThrow();
    expect(() => fimActivityRelay.accepted()).not.toThrow();
  });

  it('the relay advertises the R4 accept command ONLY while a registration that registered it is attached', async () => {
    // `currentFimActivity` is a MODULE-level slot that outlives any one test,
    // so establish the detached baseline deterministically instead of
    // assuming it — this is the state `index.ts` is left in for good when
    // `NextEditGuard.hydrate()` REJECTS (its handler only logs).
    (await setupShell({ next: false, generic: false })).disposable.dispose();
    expect(fimActivityRelay.acceptCommandId()).toBeUndefined();

    const { disposable } = await setupShell({ next: true, generic: false });

    // Attached: the advertised id is registered, and executing it reaches the
    // live shell rather than a missing command.
    expect(fimActivityRelay.acceptCommandId()).toBe('talaria.nextEdit.onFimAccept');
    expect(host.registeredCommands.has('talaria.nextEdit.onFimAccept')).toBe(true);

    disposable.dispose();

    // Detached again — the command's disposable went with it, so the
    // advertisement must go too.
    expect(fimActivityRelay.acceptCommandId()).toBeUndefined();
  });

  it('disposing an OLDER registration never disarms the relay for a NEWER one (dispose clears the slot only while it still owns it)', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    const older = await setupShell({ next: true, generic: false });
    const live = await setupShell({ next: true, generic: false });

    // The stale registration goes away. `currentFimActivity` is a module
    // singleton, so an unconditional reset here would silently point the
    // relay back at the no-op — disarming R2 for the registration that is
    // actually running.
    older.disposable.dispose();

    fimActivityRelay.requestStarted();
    await fireTrigger();

    // R2 must still hold for the LIVE registration: FIM is in flight, so
    // next-edit may not build anything.
    expect(backendSpy.predicts).toHaveLength(0);

    live.disposable.dispose();
  });
});

describe('LOCK: the shell is the only next-edit context-key writer, and registers no inline provider', () => {
  /**
   * The WRITE signature, not a mere mention: `executeCommand('setContext',
   * ...)` is the only way a context key can actually be set. `fsm.ts` and
   * `types.ts` both name the string `'setContext'` (they declare and emit the
   * EFFECT describing a write) and both name `talaria.nextEdit.*` keys — but
   * neither can perform one, which is precisely the separation this lock
   * exists to keep: the pure core decides, the shell alone acts.
   */
  const SET_CONTEXT_WRITE_RE = /executeCommand\(\s*['"]setContext['"]/;

  it('no other non-test file under src/ writes talaria.nextEdit.* context keys', async () => {
    const { collectNonTestTsSources } = await import('../../host/purityScan');
    const path = await import('node:path');

    const offenders = collectNonTestTsSources(path.join(__dirname, '..', '..'))
      .filter((f) => SET_CONTEXT_WRITE_RE.test(f.content) && /talaria\.nextEdit\./.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual(['autocomplete/nextedit/shell.vscode.ts']);
  });

  it('the write-signature predicate is not a no-op that would rubber-stamp everything (sanity check on the mechanism)', () => {
    expect(SET_CONTEXT_WRITE_RE.test("void vscode.commands.executeCommand('setContext', key, value);")).toBe(true);
    // A pure core naming the effect kind is NOT a write.
    expect(SET_CONTEXT_WRITE_RE.test("| { kind: 'setContext'; key: 'talaria.nextEdit.jumped' }")).toBe(false);
  });

  it('the shell never registers an InlineCompletionItemProvider (exactly ONE, forever — index.ts owns it)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'shell.vscode.ts'), 'utf8');
    expect(source).not.toContain('registerInlineCompletionItemProvider');
  });
});

describe('W5.2 read-through hazard: the trigger snapshots the mode ONCE', () => {
  it('source lock: shell.vscode.ts calls guard.getMode() exactly once', async () => {
    // Fix wave, Finding 4: matches this file's existing idiom (the
    // 'shell never registers an InlineCompletionItemProvider' test just
    // above uses the same dynamic import) rather than a top-level one.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs
      .readFileSync(path.join(__dirname, 'shell.vscode.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    const calls = src.match(/guard\.getMode\(\)/g) ?? [];
    expect(
      calls.length,
      'read-through hazard: getMode() must be read ONCE per trigger and threaded. A second call can ' +
        'answer differently mid-flight and build a request in a mode that is no longer on (R2/R5).',
    ).toBe(1);
  });

  it('RED-first proof: the same predicate flags a planted second read', () => {
    const planted = 'const mode = guard.getMode();\nconst again = guard.getMode();';
    const calls = planted.match(/guard\.getMode\(\)/g) ?? [];
    expect(calls.length).toBe(2);
  });
});

// ───────── W5.2 Task 2: Generic rides FIM's endpoint, therefore FIM's key ─────

/**
 * The scenario a credential test describes. Every field is optional except
 * `mode`; anything left out keeps the `beforeEach` default, so each test names
 * only what it is actually about.
 */
interface CredentialScenario {
  mode: 'generic' | 'next';
  autocompleteEndpoint?: string;
  autocompleteModel?: string;
  autocompleteBackend?: string;
  autocompleteApiKey?: string;
  nextEditEndpoint?: string;
  nextEditModel?: string;
  /** Status the stubbed `fetch` answers with — only ever reached on a run the
   *  transport guard ALLOWS to leave the process. */
  httpStatus?: number;
  /**
   * W5.2 Task 3 (tripwire) — how many times `runTriggerCapturingFetch` drives
   * the ONE trigger path. Default 1 (every existing caller). Each firing
   * after the first is preceded by the `talaria.nextEdit.dismiss` command (the
   * same `esc` a user would press), which `08` §7.6 defines as an
   * unconditional return to `idle` from any state, so a SECOND genuine
   * trigger reliably reaches the route-resolution site again.
   *
   * The explicit dismiss is for FIXTURE ROBUSTNESS, not because a second
   * firing would otherwise be gated. The T3 report and an earlier version of
   * this comment claimed GATE 2b blocks it; the T3 reviewer disproved that by
   * building the naive no-reset helper and watching it discriminate correctly
   * (GREEN with dedup, RED without). The real mechanism in this fixture:
   * `windowLines` 10 around `cursorLine` 10 in a 21-line document anchors the
   * region across the WHOLE document, so `fireTrigger`'s own synthetic edit
   * always overlaps it and self-dismisses to `idle` via the documented
   * unmodeled-combination default — no explicit dismiss required. That makes
   * the no-reset form correct but silently dependent on those three fixture
   * numbers; the dismiss removes the dependency. Do not restore the GATE 2b
   * explanation: it is not what happens here.
   */
  triggers?: number;
}

async function applyCredentialScenario(scenario: CredentialScenario): Promise<void> {
  if (scenario.autocompleteEndpoint !== undefined) autocompleteConfig.endpoint = scenario.autocompleteEndpoint;
  if (scenario.autocompleteModel !== undefined) autocompleteConfig.model = scenario.autocompleteModel;
  if (scenario.autocompleteBackend !== undefined) autocompleteConfig.backend = scenario.autocompleteBackend;
  autocompleteConfig.apiKey = scenario.autocompleteApiKey;
  if (scenario.nextEditEndpoint !== undefined) host.settings.set('talaria.nextEdit.endpoint', scenario.nextEditEndpoint);
  if (scenario.nextEditModel !== undefined) host.settings.set('talaria.nextEdit.model', scenario.nextEditModel);
  host.activeTextEditor = makeEditor(makeDoc());
  await setupShell(
    scenario.mode === 'generic' ? { next: false, generic: true } : { next: true, generic: false },
  );
}

/**
 * Drives one trigger and returns the options the shell CONSTRUCTED the backend
 * with — which is where the credential decision is actually made.
 *
 * The length assertion is load-bearing, not a courtesy: without it a scenario
 * that silently built nothing at all would hand back `undefined` for every
 * field, and the "NEXT carries no key" test would pass for the wrong reason
 * forever.
 */
async function runTriggerCapturingBackendOptions(
  scenario: CredentialScenario,
): Promise<NextEditBackendOptions> {
  await applyCredentialScenario(scenario);
  await fireTrigger();
  expect(
    backendSpy.constructed.length,
    'the scenario must actually reach backend construction — otherwise every field below is ' +
      'undefined for a reason that has nothing to do with credentials',
  ).toBe(1);
  return must(backendSpy.constructed[0]);
}

interface CredentialFetchRun {
  /** How many times the process actually tried to talk to the network. */
  fetchCalls: number;
  /** Lines that reached the Talaria output channel (`deps.reportFailure`). */
  surfaced: string[];
  /** Toasts (`vscode.window.showWarningMessage`). */
  warnings: string[];
}

/**
 * Same drive, but against the REAL `NextEditHttpBackend` with `fetch` stubbed —
 * the only arrangement in which "the guard refused, and nothing left the
 * process" is a claim rather than a tautology.
 *
 * Global Constraints: a plain function pushing into an array, never `vi.fn()`.
 * The refusal path REJECTS, and a `vi.fn()` stub would swallow that rejection
 * and leave `fetchCalls === 0` true for the wrong reason.
 */
async function runTriggerCapturingFetch(scenario: CredentialScenario): Promise<CredentialFetchRun> {
  const status = scenario.httpStatus ?? 200;
  const fetchedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown): Promise<unknown> => {
    fetchedUrls.push(String(input));
    // D1: the REAL `NextEditHttpBackend` reads its body via
    // `readJsonBounded` (`response.body.getReader()`), not `response.json()`
    // — a real `ReadableStream` body is required for the ok-status branch to
    // actually reach a success outcome rather than silently erroring on an
    // empty body. Serves both transports' response shapes from one body,
    // the same way `backend.ts` reads only the fields it needs from each.
    const okBody = {
      response: 'REWRITTEN LINE\n',
      done_reason: 'stop',
      choices: [{ text: 'REWRITTEN LINE\n', finish_reason: 'stop' }],
    };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : 'OK',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(okBody)));
          controller.close();
        },
      }),
    });
  }) as typeof globalThis.fetch;
  backendSpy.useRealTransport = true;
  try {
    await applyCredentialScenario(scenario);
    const triggerCount = scenario.triggers ?? 1;
    for (let t = 0; t < triggerCount; t++) {
      await fireTrigger();
      // Settle the real backend's own promise chain (fetch -> json -> the
      // shell's catch). Same reasoning as the abort test above: a single
      // timer flush is not enough, and without this the assertions would
      // run while the refusal was still an unsettled rejection.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      if (t < triggerCount - 1) {
        // Reset to `idle` before the NEXT firing — see `CredentialScenario`'s
        // `triggers` doc comment for why this is required for a second
        // firing to reach the route-resolution site at all.
        host.registeredCommands.get('talaria.nextEdit.dismiss')?.();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    backendSpy.useRealTransport = false;
  }
  return { fetchCalls: fetchedUrls.length, surfaced: [...failures], warnings: [...host.warnings] };
}

describe('W5.2 credentials: Generic rides FIM\'s endpoint, therefore FIM\'s key', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.useRealTransport = false;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GENERIC carries the FIM SecretStorage key into the backend options', async () => {
    const captured = await runTriggerCapturingBackendOptions({
      mode: 'generic',
      autocompleteEndpoint: 'https://fim.example.test',
      autocompleteModel: 'qwen2.5-coder:7b',
      autocompleteBackend: 'ollama',
      autocompleteApiKey: 'sk-live-generic-1',
    });
    expect(
      captured.apiKey,
      'Generic routes to the FIM endpoint and model — an unauthenticated request there is not "safer", ' +
        'it is simply a request that 401s',
    ).toBe('sk-live-generic-1');
  });

  it('NEXT carries NO Authorization, ever, even with a FIM key set', async () => {
    const captured = await runTriggerCapturingBackendOptions({
      mode: 'next',
      nextEditEndpoint: 'http://127.0.0.1:11434',
      nextEditModel: 'sweep-next-edit-v2-7B',
      autocompleteApiKey: 'sk-live-must-not-leak',
    });
    expect(
      captured.apiKey,
      'YAGNI lock: the NEXT branch must leave NextEditRoute.apiKey UNSET. Reusing FIM\'s key would send ' +
        'FIM\'s credential to a DIFFERENT host — a genuine new exposure.',
    ).toBeUndefined();
  });

  it('GENERIC + key + cleartext http:// to a REMOTE host: refuses, and fetch is never called', async () => {
    const run = await runTriggerCapturingFetch({
      mode: 'generic',
      autocompleteEndpoint: 'http://remote-box.example.test:11434',
      autocompleteBackend: 'ollama',
      autocompleteApiKey: 'sk-live-cleartext',
    });
    expect(run.fetchCalls, 'egress guards fail toward LESS egress — nothing may leave').toBe(0);
    expect(run.surfaced.join('\n')).toContain('refusing to send credentials over cleartext HTTP');
  });

  it('no failure path carries the key — not the toast, not the output channel', async () => {
    const key = 'sk-live-never-printed';
    const run = await runTriggerCapturingFetch({
      mode: 'generic',
      autocompleteEndpoint: 'http://remote-box.example.test:11434',
      autocompleteBackend: 'ollama',
      autocompleteApiKey: key,
      httpStatus: 401,
    });
    const messages = [...run.surfaced, ...run.warnings];
    // Fix wave FINDING 1: this scenario MUST surface the insecure-transport
    // refusal (to both the output channel and the toast), or the loop below
    // iterates zero times and "proves" nothing while looking like it checked
    // something. Without this, suppressing the insecure-transport
    // `surfaceOnce` call turns this test vacuously green instead of red.
    expect(messages.length, 'this scenario must actually surface a failure — an empty collection is not a pass').toBeGreaterThan(0);
    for (const message of messages) {
      expect(message, 'error messages carry status + statusText only').not.toContain(key);
    }
  });

  /**
   * The test above stops at the transport guard, so its `httpStatus` is never
   * read and the SERVER-rejection arm of `surfaceTriggerFailure` stays
   * unvisited. This is the same claim over https, where the request genuinely
   * reaches the wire, comes back 401, and is reported — the one arm that
   * formats a failure for a request the key was actually attached to.
   */
  it('no failure path carries the key — including the 401 arm a keyed request actually reaches', async () => {
    const key = 'sk-live-401-never-printed';
    const run = await runTriggerCapturingFetch({
      mode: 'generic',
      autocompleteEndpoint: 'https://fim.example.test',
      // Fix wave FINDING 3: must be a transport that actually attaches the
      // key. `ollama` never sends Authorization (backend.ts's predictOllama
      // builds Content-Type only — parity with OllamaFimBackend.ts), so with
      // `ollama` here the comment above ("a request the key was actually
      // attached to") was false: the key never reached the wire, even though
      // the assertion below still (correctly) checks for its absence.
      // `vllm` -> deriveGenericTransport -> 'openai-compat', whose
      // predictOpenAiCompat DOES attach `Authorization: Bearer <key>`, so
      // this is genuinely the 401 arm for a keyed request.
      autocompleteBackend: 'vllm',
      autocompleteApiKey: key,
      httpStatus: 401,
    });
    // Unlike the cleartext case this one MUST reach the network: https with a
    // key is exactly what `assertSecureAuthTransport` is meant to allow, and
    // without this the 401 arm below would never have been exercised.
    expect(run.fetchCalls, 'https + key is permitted egress — the guard must not refuse it').toBe(1);
    expect(run.surfaced.join('\n')).toContain('401 Unauthorized');
    for (const message of [...run.surfaced, ...run.warnings]) {
      expect(message, 'error messages carry status + statusText only').not.toContain(key);
    }
  });
});

describe('W5.2 tripwire: a NEXT route to a non-loopback host is reported once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.useRealTransport = false;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on the FIRST non-loopback NEXT route, and never a second time', async () => {
    const run = await runTriggerCapturingFetch({
      mode: 'next',
      nextEditEndpoint: 'http://gpu-box.example.test:11434',
      nextEditModel: 'sweep-next-edit-v2-7B',
      triggers: 2,
    });
    const hits = run.surfaced.filter((m) => m.includes('Next Edit is using a REMOTE endpoint'));
    expect(
      hits.length,
      'the tripwire must fire exactly once per registration — it is an observation, not a nag',
    ).toBe(1);
  });

  it('does NOT fire for a loopback NEXT endpoint', async () => {
    const run = await runTriggerCapturingFetch({
      mode: 'next',
      nextEditEndpoint: 'http://127.0.0.1:11434',
      nextEditModel: 'sweep-next-edit-v2-7B',
    });
    expect(run.surfaced.filter((m) => m.includes('REMOTE endpoint'))).toEqual([]);
  });

  it('does NOT fire for a remote GENERIC route — this tripwire is about NEXT only', async () => {
    const run = await runTriggerCapturingFetch({
      mode: 'generic',
      autocompleteEndpoint: 'https://fim.example.test',
      autocompleteBackend: 'ollama',
    });
    expect(run.surfaced.filter((m) => m.includes('REMOTE endpoint'))).toEqual([]);
  });
});

// ───── W5.2 Task 12 / C-3: original/ and current/ agree on the newline ──────

/**
 * C-3 asserts on the BYTES THAT LEAVE THE PROCESS, never on an intermediate
 * field of the `NextEditRequest`.
 *
 * The defect is a byte in the rendered prompt — a blank line the model reads
 * as a one-line difference between `original/` and `current/`. A test that
 * inspected `req.preEditRegion` would be asserting on a value this test
 * computed the expectation for, not on what the model is actually handed;
 * `sweepV2.render` sits between the two and appends a separator '\n' of its
 * own, which is precisely the byte that turns the field-level asymmetry into
 * a visible blank line. So the capture point is `fetch`'s request body, with
 * the real `NextEditHttpBackend` in the path.
 *
 * Global Constraints: a plain function pushing into an array, never `vi.fn()`.
 */
interface WireCapture {
  /** `JSON.parse(body).prompt` — the exact string handed to the runner. */
  prompt: string;
  /** The `original/` section body, with the template's own single trailing
   *  separator '\n' removed and NOTHING else — so a block that carries its
   *  own terminator still shows one here. */
  originalBlock: string;
  /** The `current/` section body, same treatment. Still carries `<|cursor|>`. */
  currentBlock: string;
}

const ORIGINAL_HEADER = '<|file_sep|>original/';
const CURRENT_HEADER = '<|file_sep|>current/';
const UPDATED_HEADER = '<|file_sep|>updated/';

/**
 * The bytes between a section's header LINE and the '\n' that the template
 * places before the next header. Deliberately does not trim: the whole point
 * is to see a terminator the block itself carries.
 */
function sectionBody(prompt: string, header: string, nextHeader: string): string {
  const headerAt = prompt.indexOf(header);
  expect(headerAt, `the wire prompt must carry a ${header} section`).toBeGreaterThan(-1);
  const bodyStart = prompt.indexOf('\n', headerAt) + 1;
  const bodyEnd = prompt.indexOf(`\n${nextHeader}`, bodyStart);
  expect(bodyEnd, `the wire prompt must carry a ${nextHeader} section after ${header}`).toBeGreaterThan(-1);
  return prompt.slice(bodyStart, bodyEnd);
}

/**
 * Drives ONE next-edit trigger with a pre-edit shadow in place and returns
 * what actually went out.
 *
 * The shadow is real, not injected: `createEditTrackerAdapter` only ever
 * produces a `getPreEditText` answer for a uri it saw in a VISIBLE editor
 * BEFORE the change, so the pre-edit document is seeded through
 * `host.visibleTextEditors` under the SAME uri the active editor carries.
 * `preEditDocText: null` seeds nothing, which is the genuine no-shadow path.
 */
async function runTriggerCapturingWire(options: {
  documentText: string;
  preEditDocText: string | null;
  cursorLine: number;
}): Promise<WireCapture> {
  const uri = 'file:///home/u/project/a.ts';
  const path = '/home/u/project/a.ts';
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { body?: string }): Promise<unknown> => {
    bodies.push(String(init?.body ?? ''));
    // D1: the REAL `NextEditHttpBackend` reads its body via `readJsonBounded`
    // (`response.body.getReader()`), not `response.json()` — a real
    // `ReadableStream` body is required for this to actually reach the
    // "empty completion parses to no-op" outcome the comment below promises,
    // rather than silently erroring on an empty body.
    const okBody = { response: '', done_reason: 'stop', choices: [{ text: '', finish_reason: 'stop' }] };
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      // An empty completion parses to `no-op`, so nothing is applied and the
      // run stays purely about egress.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(okBody)));
          controller.close();
        },
      }),
    });
  }) as typeof globalThis.fetch;
  backendSpy.useRealTransport = true;
  try {
    if (options.preEditDocText !== null) {
      host.visibleTextEditors.push(
        makeEditor(makeDoc({ uri, path, text: options.preEditDocText }), options.cursorLine),
      );
    }
    host.activeTextEditor = makeEditor(makeDoc({ uri, path, text: options.documentText }), options.cursorLine);
    await setupShell({ next: true, generic: false });
    await fireTrigger();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    globalThis.fetch = originalFetch;
    backendSpy.useRealTransport = false;
  }

  expect(
    bodies.length,
    'the scenario must actually reach the wire — otherwise every byte assertion below is vacuous',
  ).toBe(1);
  const prompt = (JSON.parse(must(bodies[0])) as { prompt: string }).prompt;
  return {
    prompt,
    originalBlock: sectionBody(prompt, ORIGINAL_HEADER, CURRENT_HEADER),
    currentBlock: sectionBody(prompt, CURRENT_HEADER, UPDATED_HEADER),
  };
}

/** `currentBlock` minus its ONE `<|cursor|>` marker — i.e. the region text as
 *  the wire carries it. The count assertion keeps the strip honest. */
function currentBlockWithoutCursor(capture: WireCapture): string {
  const hits = capture.currentBlock.match(/<\|cursor\|>/g) ?? [];
  expect(hits.length, 'the current/ block must carry exactly one cursor marker').toBe(1);
  return capture.currentBlock.replace('<|cursor|>', '');
}

/** A 21-line document (+ trailing newline). The region window is cursor ± 10,
 *  so a cursor on line 10 spans [0, 20] — ending on a line that HAS TEXT.
 *  That is the case in which `getText` and a line extractor disagree. */
const PRE_EDIT_TEXT = `${LINES.map((l, i) => (i === 10 ? 'const v10 = 0;' : l)).join('\n')}\n`;
/** Same span, but the pre-edit text's last region line is GENUINELY blank —
 *  the user has since typed `const v20 = 20;` onto it. */
const PRE_EDIT_BLANK_TAIL = `${LINES.slice(0, 20).concat('').join('\n')}\n`;
/** Content byte-identical to DOC_TEXT; only the shadow's ONE trailing
 *  terminator is CRLF instead of LF — a Windows-authored file, or a
 *  `core.autocrlf` checkout. Exercises the CRLF branch of `stripLineTerminator`
 *  specifically (endLine < lineCount, so the strip fires). */
const PRE_EDIT_TEXT_CRLF_TAIL = `${LINES.join('\n')}\r\n`;

describe('C-3: original/ and current/ agree on the trailing newline (wire bytes)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.useRealTransport = false;
    autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
    autocompleteConfig.model = 'qwen2.5-coder:7b';
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no blank line is injected between the original/ block and the current/ header', async () => {
    const wire = await runTriggerCapturingWire({
      documentText: DOC_TEXT,
      preEditDocText: PRE_EDIT_TEXT,
      cursorLine: 10,
    });

    expect(
      wire.prompt,
      'C-3: original/ gained a trailing newline current/ does not have — a phantom one-line difference ' +
        'injected into every comparison the model makes, on exactly the axis it reads as "what changed"',
    ).not.toContain(`const v20 = 20;\n\n${CURRENT_HEADER}`);
    expect(wire.prompt).toContain(`const v20 = 20;\n${CURRENT_HEADER}`);
  });

  it('the two blocks carry the same number of lines — the only difference is the real edit', async () => {
    const wire = await runTriggerCapturingWire({
      documentText: DOC_TEXT,
      preEditDocText: PRE_EDIT_TEXT,
      cursorLine: 10,
    });

    const originalLines = wire.originalBlock.split('\n');
    const currentLines = currentBlockWithoutCursor(wire).split('\n');
    expect(
      originalLines.length,
      'the model diffs these two blocks line-for-line; a length disagreement the user never made is noise ' +
        'on the one signal the format exists to carry',
    ).toBe(currentLines.length);
    // And the difference is exactly the one line the user actually changed.
    const differing = originalLines.filter((line, i) => line !== currentLines[i]);
    expect(differing).toEqual(['const v10 = 0;']);
  });

  it('an IDENTICAL shadow renders the two blocks byte-identical', async () => {
    const wire = await runTriggerCapturingWire({
      documentText: DOC_TEXT,
      preEditDocText: DOC_TEXT,
      cursorLine: 10,
    });

    expect(
      wire.originalBlock,
      'with an identical shadow the two blocks must be byte-identical — any difference is phantom',
    ).toBe(currentBlockWithoutCursor(wire));
  });

  it('a CRLF-terminated pre-edit shadow does not leak a stray \\r onto the wire', async () => {
    const wire = await runTriggerCapturingWire({
      documentText: DOC_TEXT,
      preEditDocText: PRE_EDIT_TEXT_CRLF_TAIL,
      cursorLine: 10,
    });

    // Content is byte-identical to DOC_TEXT; only the shadow's source
    // terminator differs ('\r\n' vs '\n'). A correct strip removes it
    // entirely, so no '\r' may reach the wire at all, and the two blocks
    // must be byte-identical — same bar as the identical-shadow case above.
    // A stray '\r' surviving here is the C-3 defect class re-entering
    // through the egress path, on a document convention C-3's own fix never
    // exercised.
    expect(wire.prompt, 'no CR byte may reach the wire').not.toMatch(/\r/);
    expect(wire.originalBlock).toBe(currentBlockWithoutCursor(wire));
  });

  it('a GENUINELY blank last line in the pre-edit region survives on the wire', async () => {
    const wire = await runTriggerCapturingWire({
      documentText: DOC_TEXT,
      preEditDocText: PRE_EDIT_BLANK_TAIL,
      cursorLine: 10,
    });

    // The pre-edit text really did end that region with an empty line, and
    // the user really did type onto it. Exactly ONE separator newline is the
    // template's; the one before it is the blank line itself. Removing the
    // blank line would misreport what the user changed just as badly as
    // inventing one.
    expect(
      wire.prompt,
      'the fix removes an asymmetry, it does not strip terminators — a region whose pre-edit text genuinely ' +
        'ended in a blank line must keep it',
    ).toContain(`const v19 = 19;\n\n${CURRENT_HEADER}`);
    expect(wire.prompt).not.toContain(`const v19 = 19;\n${CURRENT_HEADER}`);
    expect(wire.prompt).not.toContain(`const v19 = 19;\n\n\n${CURRENT_HEADER}`);
  });

  it('a region clamped to the document END keeps the newline BOTH blocks legitimately carry', async () => {
    // A short document: the window clamps to the final (empty) line, so
    // `region.content` legitimately ENDS with '\n' — `getText` runs to the
    // start of that empty line. Here the two blocks already agree, and any
    // unconditional strip would CREATE the very asymmetry C-3 removes.
    const wire = await runTriggerCapturingWire({
      documentText: 'line0\nline1\nline2\nline3\nline4\n',
      preEditDocText: 'line0\nline1\nOLD\nline3\nline4\n',
      cursorLine: 2,
    });

    expect(
      wire.originalBlock,
      'region.content ends at the START of the trailing empty line, so it carries that newline too — ' +
        'dropping it from original/ would inject the phantom difference in the other direction',
    ).toBe('line0\nline1\nOLD\nline3\nline4\n');
    expect(wire.originalBlock.split('\n').length).toBe(currentBlockWithoutCursor(wire).split('\n').length);
  });

  /**
   * Exercises the `preEditDocText === null` branch of the ternary at the
   * `preEditRegion` call site — the ONE branch that bypasses
   * `extractRegionRange`/`stripLineTerminator` entirely, short-circuiting to
   * `region.content` before either is ever called. It therefore cannot fail
   * from any change to that strip logic (confirmed: unaffected by all three
   * mutations below, and by the CRLF mutation above). It legitimately locks
   * the documented `null` fallback and must stay — just don't count it as
   * C-3 strip-logic coverage; guards 1-5 and the CRLF guard above are that.
   */
  it('with NO shadow the original/ block is the current region text, byte for byte', async () => {
    const wire = await runTriggerCapturingWire({
      documentText: DOC_TEXT,
      preEditDocText: null,
      cursorLine: 10,
    });

    expect(
      wire.originalBlock,
      'the documented fallback (04 §1.3): no shadow ⇒ original/ IS the current region text, and the ' +
        'fallback must not acquire a terminator the block it falls back to does not have',
    ).toBe(currentBlockWithoutCursor(wire));
  });
});

describe('B-2/B-8: the round-trip freshness checks are individually observable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('B-2: a document whose version moved DURING the request produces no proposal (the file-corruption path)', async () => {
    const doc = makeDoc();
    host.activeTextEditor = makeEditor(doc);
    await setupShell({ next: true, generic: false });

    // Bump the document version while the backend is mid-flight. This is the
    // real-world case: the user keeps typing while the model thinks. Without
    // shell.vscode.ts:1202, the stale rewrite is painted and Tab applies it to
    // text that has already changed.
    backendSpy.respond = async () => {
      doc.version += 1;
      return { text: 'REWRITTEN LINE\n', stopReason: 'stop' as const };
    };

    await fireTrigger();

    expect(host.decorationCalls.filter((c) => c.ranges.length > 0)).toHaveLength(0);
  });

  it('B-2 control: the SAME flow with a stable version DOES produce a proposal (non-vacuous)', async () => {
    const doc = makeDoc();
    host.activeTextEditor = makeEditor(doc);
    await setupShell({ next: true, generic: false });

    backendSpy.respond = async () => ({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });

    await fireTrigger();

    expect(host.decorationCalls.filter((c) => c.ranges.length > 0).length).toBeGreaterThan(0);
  });

  /**
   * B-8's brief specified `const first = fireTrigger(); await fireTrigger();`
   * (racing the two triggers) to abort the first via a second one. Verified
   * NOT to work: `AutocompleteDebouncer.delayAndShouldDebounce` (debouncer.ts)
   * is trailing-edge and tags every call with a sequence number — a call
   * whose sequence has since been superseded resolves `true` ("dropped") and
   * `armTrigger()`'s `.then()` never calls `trigger()` at all for it. Firing
   * both `fireTrigger()` calls before either debounce timer elapses means
   * ONLY the second ever reaches `trigger()`/`predict()` — confirmed by
   * instrumenting the raced version: `backendSpy.predicts.length === 1` and
   * `predicts[0].signal.aborted === false`. Nothing ever aborts the sole
   * request, so the stub (which resolves only on an abort) hangs forever and
   * "no decorations" was vacuously true regardless of `:1191` — deleting the
   * guard left the raced version green too (watched, not assumed).
   *
   * Fix: let the FIRST trigger genuinely reach `predict()` (`await
   * fireTrigger()` in full) before arming the second, so the second
   * `trigger()` call's own `abortInFlight()` has a real in-flight request to
   * abort. That still leaves a second confound: `fireTrigger()` bumps
   * `doc.version` as part of simulating the edit, and by the time request
   * #1's `predict()` resumes (via the abort), `document.version` has moved
   * — meaning the STILL-PRESENT `:1202` freshness check would independently
   * discard the response too, again making a passing test ambiguous between
   * `:1191` and `:1202`. Restoring `doc.version` to request #1's own snapshot
   * before the second debounce timer elapses removes that confound: neither
   * request's own captured `docVersion` differs from `document.version` at
   * resume time, so `:1202` cannot be what stops this — isolating `:1191`.
   */
  it('B-8: an ABORTED request produces no proposal even though the version never moved', async () => {
    const doc = makeDoc();
    host.activeTextEditor = makeEditor(doc);
    await setupShell({ next: true, generic: false });

    // Resolve the backend only AFTER the shell's own abort fires, with the
    // version untouched — so `document.version !== docVersion` cannot be what
    // stops this. Only shell.vscode.ts:1191 can.
    backendSpy.respond = async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { text: 'REWRITTEN LINE\n', stopReason: 'stop' as const };
    };

    // Request #1: let its OWN debounce genuinely elapse and reach predict(),
    // where it hangs (nothing has aborted it yet).
    await fireTrigger();
    expect(backendSpy.predicts).toHaveLength(1);
    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(false);
    const versionAtFirstRequest = doc.version;

    // Request #2: a genuine second edit-burst, arming a genuine second
    // trigger. The version bump is restored before the debounce elapses, so
    // by the time request #1 resumes it sees the SAME version it started
    // with — :1202 cannot fire, isolating :1191 as the only possible cause.
    doc.version += 1;
    for (const handler of host.docChangeHandlers) {
      handler({
        document: doc,
        contentChanges: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'y' },
        ],
      });
    }
    doc.version = versionAtFirstRequest;
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    // The abort ITSELF, observed directly — not just the absence of a
    // proposal. Request #2 reached predict() (its own trigger() called
    // abortInFlight() before building its own request) and request #1's
    // signal is the one that got aborted.
    expect(backendSpy.predicts).toHaveLength(2);
    expect(must(backendSpy.predicts[0]).signal.aborted).toBe(true);
    // Sanity: the version restore held — request #1's resumed continuation
    // sees the SAME version it captured, so :1202 genuinely cannot fire.
    expect(doc.version).toBe(versionAtFirstRequest);

    expect(host.decorationCalls.filter((c) => c.ranges.length > 0)).toHaveLength(0);
  });
});

describe('B-3/B-7: ordering and settle no-ops are individually observable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHost();
    failures.length = 0;
    backendSpy.constructed.length = 0;
    backendSpy.predicts.length = 0;
    mintCalls.length = 0;
    backendSpy.respond = () => Promise.resolve({ text: 'REWRITTEN LINE\n', stopReason: 'stop' as const });
    autocompleteConfig.backend = 'ollama';
    autocompleteConfig.apiKey = undefined;
    host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
    host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('B-3: the trust read happens strictly BEFORE the backend is constructed', async () => {
    host.settings.set('talaria.nextEdit.endpoint', 'http://gpu.example.com:11434');
    host.activeTextEditor = makeEditor(makeDoc());
    host.isTrusted = true;
    await setupShell({ next: true, generic: false });
    host.accessLog.length = 0;

    await fireTrigger();

    const trustAt = host.accessLog.indexOf('isTrusted');
    const builtAt = host.accessLog.indexOf('NextEditHttpBackend.constructed');
    expect(trustAt).toBeGreaterThanOrEqual(0);
    expect(builtAt).toBeGreaterThanOrEqual(0);
    // Global Constraint: `vscode.workspace.isTrusted` is checked STRICTLY
    // before `new NextEditHttpBackend(...)`.
    expect(trustAt).toBeLessThan(builtAt);
  });

  it('B-3: an untrusted workspace with a REMOTE endpoint never constructs the backend at all', async () => {
    host.settings.set('talaria.nextEdit.endpoint', 'http://gpu.example.com:11434');
    host.activeTextEditor = makeEditor(makeDoc());
    host.isTrusted = false;
    await setupShell({ next: true, generic: false });
    backendSpy.constructed.length = 0;

    await fireTrigger();

    // The pre-existing test asserted only `predicts`. A backend that is BUILT
    // and then not used has already read the endpoint and the key.
    expect(backendSpy.constructed).toHaveLength(0);
  });

  /**
   * The brief's literal B-7 shape (`requestStarted(); requestStarted();
   * resultShown(false); fireTrigger(); expect(predicts).toHaveLength(0)`) was
   * VERIFIED vacuous, not assumed: run against `shell.vscode.ts` with
   * `:1295`'s `if (fim.inFlightCount > 0) return;` deleted, it — and the
   * WHOLE repo gate (189 files / 3425 passed / 7 skipped, identical to
   * clean) — stayed green. Traced to two compounding reasons:
   *
   * 1. GATE 2 (`fimBusy() = fim.visible || fim.inFlightCount > 0`) is what
   *    `predicts` actually observes, and by the DEFINITION of "superseded"
   *    (a newer request is still in flight), `inFlightCount` is guaranteed
   *    to still be > 0 the instant a superseded settle runs — with or
   *    without `:1295`. So `predicts` staying empty proves nothing about
   *    `:1295` specifically; it is already, and independently, guaranteed
   *    by the count. (The pre-existing test "the LAST in-flight FIM request
   *    settling is what reopens GATE 2", `:1164` at the time of writing,
   *    already covers this exact count-level shape.)
   * 2. `resultShown(false)` (`hasItem: false`) makes the corrupted write
   *    `dispatch({ kind: 'fimVisibility', visible: false })` — and
   *    `fsm.ts` makes `fimVisibility(false)` an UNCONDITIONAL no-op
   *    (`if (e.kind === 'fimVisibility' && !e.visible) return { state: s,
   *    effects: [] };`), so even the ONE call `:1295` was supposed to
   *    suppress produces no effects either way. Both the guarded and the
   *    unguarded path are silent.
   *
   * Per the programme rule against unverified protection claims, the test
   * is fixed rather than shipped vacuous. `hasItem: true` is what makes
   * `:1295`'s absence independently observable: `fimVisibility(true)`
   * unconditionally clears the FSM (`cleared()` — a `clearAll` batch),
   * regardless of `inFlightCount`, so the corrupted dispatch leaves a
   * trace (`setContext` calls reaching the host) that GATE 2's own count
   * check can never mask — this assertion never calls `trigger()` at all,
   * so `inFlightCount` being 1 (B is genuinely still in flight) cannot be
   * what keeps it clean.
   */
  it('B-7: a SUPERSEDED FIM settle reaches NEITHER the FSM nor the executor — a genuine no-op, not just gated by the refcount', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted(); // request A: inFlightCount 0 -> 1
    fimActivityRelay.requestStarted(); // request B: inFlightCount 1 -> 2, A now superseded
    // Isolate: both calls above already ran their OWN (correct)
    // `fimVisibility(true)` dispatch — only A's settle is under test now.
    host.executed.length = 0;

    // A settles: refcount 2 -> 1 (B is still outstanding) — a SUPERSEDED
    // settle. `hasItem: true`, not `false` — see the doc comment above.
    fimActivityRelay.resultShown(true);

    const setContextCalls = host.executed.filter((e) => e.command === 'setContext');
    expect(setContextCalls).toHaveLength(0);
  });

  it('B-7 control: the AUTHORITATIVE settle (refcount reaches 0) DOES dispatch — proving the assertion above is not vacuously true', async () => {
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    fimActivityRelay.requestStarted(); // the ONLY request: inFlightCount 0 -> 1
    host.executed.length = 0;

    // Settles: refcount 1 -> 0. Genuinely the last one outstanding, so this
    // one is NOT superseded and must reach the executor.
    fimActivityRelay.resultShown(true);

    const setContextCalls = host.executed.filter((e) => e.command === 'setContext');
    expect(setContextCalls.length).toBeGreaterThan(0);
  });
});
