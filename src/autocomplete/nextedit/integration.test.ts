import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscodeTypes from 'vscode';
import { NextEditGuard, NEXT_EDIT_RESET_NOTICE } from './guard';
import type { ToggleState } from './mode';
import { must } from '../../testing/must';

/**
 * nextedit/integration.test.ts — Task 15 · end-to-end proof that the
 * next-edit pieces (Tasks 1-14, each independently reviewed and merged)
 * actually compose, across the three owner-stated scenarios
 * (`08-jobB-final-architecture.md` §1, `09-jobB-final-plan.md` Global
 * Constraints):
 *
 *   1. FIM ON + NEXT ON      — two endpoints, two backends, no conflict.
 *   2. FIM ON, both OFF      — plain FIM only, zero next-edit activity.
 *   3. FIM ON + Generic ON   — the FIM endpoint+model again, a second
 *                              request shape emulating next-edit.
 *
 * plus the R5 refusal round-trip, the R5 cold-start sanitize, and the R2
 * cross-channel abort — the six scenarios `task-15-brief.md` Step 1 pins.
 *
 * THE MOCK BOUNDARY — this is what makes this file an INTEGRATION test
 * rather than a restatement of `shell.vscode.test.ts` /
 * `coexistence.lock.test.ts`: only `vscode` is mocked (it does not exist
 * outside the extension host). `./backend` (the REAL `NextEditHttpBackend`),
 * `./scan` (the REAL egress mint), `./guard`/`./mode` (the REAL Guard + R5
 * pure halves), `./fsm` (the REAL reducer), `./anchors`, and BOTH
 * `formats/*` modules are the SHIPPED code, unmocked. The one stub below the
 * `vscode` boundary is `global.fetch` itself (`vi.stubGlobal`, the same
 * technique `backend.test.ts` already uses for its own narrower unit
 * coverage) — a canned HTTP response, never a mocked module.
 *
 * Every other suite in this feature mocks `./backend`
 * (`shell.vscode.test.ts`, `coexistence.lock.test.ts`) or exercises one
 * module in isolation (`backend.test.ts`, `sweepV2.test.ts`,
 * `genericInstruct.test.ts`, `fsm.test.ts`, `guard.test.ts`, `mode.test.ts`)
 * — none of them drives a REAL render -> REAL mint -> REAL fetch -> REAL
 * parse -> REAL fsm -> REAL executor chain through the ONE public entry
 * point (`registerHermesNextEdit`) in a single test. That seam is this
 * file's whole job; it is the only place a wiring mistake between two
 * already-reviewed modules (e.g. a route built for the wrong endpoint, a
 * response shape the real parser rejects, a real HTTP-level abort that
 * doesn't reach the FSM) could hide.
 */

// ─────────────────────────────── the vscode harness ──────────────────────────────

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
  contentChanges: { range: { start: FakePosition; end: FakePosition }; text: string }[];
}

const host = {
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as { command: string; args: unknown[] }[],
  docChangeHandlers: [] as ((e: FakeChangeEvent) => void)[],
  activeEditorHandlers: [] as ((editor: FakeEditor | undefined) => void)[],
  windowStateHandlers: [] as ((s: { focused: boolean }) => void)[],
  activeTextEditor: undefined as FakeEditor | undefined,
  isTrusted: true,
  applyEditResult: true,
  appliedEdits: [] as { uri: string; range: unknown; newText: string }[],
  warnings: [] as string[],
  infos: [] as string[],
  settings: new Map<string, unknown>(),
  decorationCalls: [] as { type: string; ranges: unknown[] }[],
  reveals: [] as unknown[],
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
  host.appliedEdits.length = 0;
  host.warnings.length = 0;
  host.infos.length = 0;
  host.settings.clear();
  host.decorationCalls.length = 0;
  host.reveals.length = 0;
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
        host.appliedEdits.push(...edit.edits);
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

// The real shell, the real guard, the real formats, the real backend, the
// real scan, the real fsm — imported AFTER the vscode mock so they resolve
// against it. Nothing under `./` is mocked in this file except `vscode`
// itself and (below) `global.fetch`.
import { registerHermesNextEdit, requestNextEditToggle, fimActivityRelay, GENERIC_SETUP_NOTE } from './shell.vscode';

// ─────────────────────────────── fetch stubbing ──────────────────────────────

interface CapturedFetch {
  url: string;
  body: Record<string, unknown>;
}

/** D1: `NextEditHttpBackend.predict` now reads its body via
 *  `readJsonBounded` (`response.body.getReader()`), not `response.json()` —
 *  this fixture must supply a real `ReadableStream` body, not a `json()`
 *  method, or the REAL backend call this file exercises rejects with a
 *  JSON-parse error on an empty body. */
function jsonBodyStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeOkResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', body: jsonBodyStream(body) } as unknown as Response;
}

/** The Ollama `/api/generate` non-streaming success shape both scenarios 1
 *  and 3 use (both route through the `ollama` transport in this file's
 *  fixtures — `done_reason: 'stop'`, as the brief pins). */
function ollamaOkBody(text: string): unknown {
  return { response: text, done: true, done_reason: 'stop' };
}

/** Every call resolves immediately with the SAME rewrite text — good enough
 *  to prove the wire round-trips for real; the specific text ('REWRITTEN
 *  LINE\n') is chosen to be a real rewrite under BOTH formats' parse rules
 *  (never equal to the ~21-line region, never a pure insertion above the
 *  cursor) — the same fixture `shell.vscode.test.ts`'s mocked-backend
 *  suite already validates produces a `rewrite` verdict; here it round-trips
 *  through the REAL backend + REAL parse instead of a mocked one. */
function stubFetchAlwaysRewrites(text = 'REWRITTEN LINE\n'): CapturedFetch[] {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body });
    return Promise.resolve(fakeOkResponse(ollamaOkBody(text)));
  });
  return calls;
}

/** A fetch stub that never settles on its own — only an abort (via the
 *  AbortSignal `backend.ts` forwards into the real `fetch` call) ends it,
 *  exactly like a real in-flight HTTP request. This is what makes the
 *  cross-channel scenario a genuine proof rather than a simulated one: the
 *  abort travels through the REAL `AbortController` -> REAL `fetch(...,
 *  {signal})` -> this stub's own `abort` listener, not a hand-waved
 *  "settle()" callback a mocked backend would need. */
function stubDeferredFetch(): { calls: CapturedFetch[]; getSignal: () => AbortSignal | undefined } {
  const calls: CapturedFetch[] = [];
  let capturedSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body });
    capturedSignal = init.signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  });
  return { calls, getSignal: () => capturedSignal };
}

function stubFetchNeverCalled(): CapturedFetch[] {
  const calls: CapturedFetch[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body });
    return Promise.reject(new Error('integration.test.ts: fetch must not be called in this scenario'));
  });
  return calls;
}

// ─────────────────────────────── document + editor fixtures ──────────────────

const LINES = Array.from({ length: 21 }, (_, i) => `const v${i} = ${i};`);
const DOC_TEXT = `${LINES.join('\n')}\n`;

function makeDoc(): FakeDocument {
  const uri = 'file:///home/u/project/a.ts';
  const path = '/home/u/project/a.ts';
  const lines = DOC_TEXT.split('\n');
  return {
    uri: { scheme: 'file', path, fsPath: path, toString: () => uri },
    version: 1,
    languageId: 'typescript',
    get lineCount() {
      return lines.length;
    },
    getText(range?: { start: FakePosition; end: FakePosition }): string {
      if (!range) return DOC_TEXT;
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

/** A recording Memento — like `makeMemento`, but exposes every write, so the
 *  refusal round-trip and cold-start scenarios can assert the store either
 *  was or was NOT touched, not merely infer it from in-memory state. */
function makeRecordingMemento(seed?: ToggleState): {
  memento: vscodeTypes.Memento;
  updates: { key: string; value: unknown }[];
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  const updates: { key: string; value: unknown }[] = [];
  if (seed) store.set('hermes.nextEdit.toggles', seed);
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

const failures: string[] = [];
const autocompleteConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:7b',
  backend: 'ollama',
  // W5.2 Task 2 — this suite exercises the R2 interlock, not credentials, so it
  // runs keyless. Held as fixture STATE rather than a hard-coded `undefined` in
  // the accessor below so a future case can set it without re-plumbing DEPS.
  apiKey: undefined as string | undefined,
};

const DEPS = {
  reportFailure: (msg: string) => void failures.push(msg),
  getAutocompleteEndpoint: () => autocompleteConfig.endpoint,
  getAutocompleteModel: () => autocompleteConfig.model,
  getAutocompleteBackend: () => autocompleteConfig.backend,
  getAutocompleteApiKey: () => autocompleteConfig.apiKey,
};

async function setupShell(toggles: ToggleState): Promise<{ guard: NextEditGuard; disposable: vscodeTypes.Disposable }> {
  const guard = await NextEditGuard.hydrate(makeMemento(toggles), { reportFailure: DEPS.reportFailure });
  const disposable = registerHermesNextEdit(makeContext(), guard, DEPS);
  return { guard, disposable };
}

/** Drives the ONE trigger path via its edit-burst source (a document
 *  change), then settles the 350 ms debounce and the promise chain behind
 *  it — including the REAL network round trip through the stubbed
 *  `global.fetch`. */
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

function contextKeyValue(key: string): unknown {
  const sets = host.executed.filter((e) => e.command === 'setContext' && e.args[0] === key);
  return sets.length === 0 ? undefined : must(sets[sets.length - 1]).args[1];
}

function anyDecorationShown(): boolean {
  return host.decorationCalls.some((c) => c.ranges.length > 0);
}

function resetAll(): void {
  vi.useFakeTimers();
  resetHost();
  failures.length = 0;
  autocompleteConfig.endpoint = 'http://127.0.0.1:11434';
  autocompleteConfig.model = 'qwen2.5-coder:7b';
  autocompleteConfig.backend = 'ollama';
  host.settings.set('talaria.nextEdit.endpoint', 'http://127.0.0.1:11435');
  host.settings.set('talaria.nextEdit.model', 'sweep-next-edit-v2-7B');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ══════════════════════════ Scenario 1 — FIM ON + NEXT ON ═══════════════════════

describe('Scenario 1 (owner: FIM ON + NEXT ON — two endpoints, two backends, no conflict)', () => {
  beforeEach(resetAll);

  it('edit -> trigger -> sweepV2 render -> mint -> predict(real fetch, stubbed 200, done_reason:"stop") -> parse -> proposalReady -> decorations -> tabJump -> reveal -> tabAccept -> applyEdit(true) -> idle, keys false — against cfg.endpoint', async () => {
    const calls = stubFetchAlwaysRewrites();
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    // edit -> trigger -> render -> mint -> predict -> parse -> proposalReady
    await fireTrigger();

    expect(calls, 'the request must reach the REAL fetch exactly once').toHaveLength(1);
    const call = must(calls[0]);
    // "against cfg.endpoint" — talaria.nextEdit.endpoint, NEVER the FIM/
    // autocomplete endpoint (proving the two-endpoints half of the owner's
    // sentence, not merely that SOME endpoint was called).
    expect(call.url).toBe('http://127.0.0.1:11435/api/generate');
    expect(call.url).not.toContain('11434');
    // The real sweepV2 render + the real backend body shape (`08` §5.2's raw
    // polarity, `08` §5.1's non-streaming body).
    expect(call.body.model).toBe('sweep-next-edit-v2-7B');
    expect(call.body.raw).toBe(true);
    expect(call.body.stream).toBe(false);
    expect(call.body.prompt).toContain('<|cursor|>');
    const options = call.body.options as { stop: readonly string[] };
    expect(options.stop).toEqual(['<|endoftext|>', '<|file_sep|>']);

    // proposalReady -> decorations
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    expect(anyDecorationShown()).toBe(true);

    // tabJump -> reveal
    await host.registeredCommands.get('talaria.nextEdit.jump')?.();
    expect(contextKeyValue('talaria.nextEdit.jumped')).toBe(true);
    expect(host.reveals.length).toBeGreaterThan(0);

    // tabAccept -> applyEdit(true) -> idle, keys false
    await host.registeredCommands.get('talaria.nextEdit.accept')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.appliedEdits).toHaveLength(1);
    expect(must(host.appliedEdits[0]).newText).toContain('REWRITTEN LINE');
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);
    expect(contextKeyValue('talaria.nextEdit.jumped')).toBe(false);
    // applyEdit(true): a successful apply notes nothing (contrast the
    // FAILED-apply case, which notes once).
    expect(host.warnings).toEqual([]);
    expect(failures).toEqual([]);
  });
});

// ══════════════════════ Scenario 3 — FIM ON + Generic ON ═══════════════════════

describe('Scenario 3 (owner: FIM ON + Generic ON — one endpoint/model, a second request shape)', () => {
  beforeEach(resetAll);

  it('full lifecycle on the AUTOCOMPLETE endpoint+model via genericInstruct, and the setup note fires ONCE, on the accepted toggle-on', async () => {
    const calls = stubFetchAlwaysRewrites();
    host.activeTextEditor = makeEditor(makeDoc());
    const { guard } = await setupShell({ next: false, generic: false });

    // The accepted generic toggle-on — the ONLY site the `08` §6.3 setup
    // note may fire from.
    await requestNextEditToggle(guard, { source: 'generic', on: true }, DEPS);
    expect(host.infos, 'the setup note must fire exactly once on the accepted toggle-on').toEqual([
      GENERIC_SETUP_NOTE,
    ]);

    // edit -> trigger -> genericInstruct render -> mint -> predict (real
    // fetch) -> parse -> proposalReady, against the AUTOCOMPLETE endpoint —
    // NEVER talaria.nextEdit.endpoint (proving "rides the main FIM endpoint",
    // not merely "some endpoint").
    await fireTrigger();

    expect(calls).toHaveLength(1);
    const call = must(calls[0]);
    expect(call.url).toBe('http://127.0.0.1:11434/api/generate');
    expect(call.url).not.toContain('11435');
    expect(call.body.model).toBe('qwen2.5-coder:7b');
    expect(call.body.prompt).toContain('<|im_start|>user');
    expect(call.body.raw).toBe(true);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    expect(anyDecorationShown()).toBe(true);

    await host.registeredCommands.get('talaria.nextEdit.jump')?.();
    await host.registeredCommands.get('talaria.nextEdit.accept')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(host.appliedEdits).toHaveLength(1);
    expect(must(host.appliedEdits[0]).newText).toContain('REWRITTEN LINE');
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(false);

    // THE "once" — load-bearing (controller ambiguity #3). A full, accepted
    // next-edit cycle must NOT re-fire the setup note: it is tied to the
    // toggle-on gesture, never to a proposal being built, shown, or applied.
    expect(host.infos, 'the setup note must NOT re-fire from the trigger/predict/apply cycle').toEqual([
      GENERIC_SETUP_NOTE,
    ]);

    // Drive a SECOND full cycle (a fresh edit -> trigger -> ... -> accept)
    // to prove the "once" holds across repeated usage, not just a single
    // proposal — a note gated only on "have I fired before" would still
    // pass with a single cycle but this second one would catch a
    // per-request re-fire regression.
    await fireTrigger();
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);
    await host.registeredCommands.get('talaria.nextEdit.jump')?.();
    await host.registeredCommands.get('talaria.nextEdit.accept')?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(host.infos, 'the setup note must still not have re-fired after a SECOND accepted cycle').toEqual([
      GENERIC_SETUP_NOTE,
    ]);
  });
});

// ══════════════════════ Scenario 2 — both sources OFF ═══════════════════════

describe('Scenario 2 (owner: FIM ON, NEXT OFF, Generic OFF — plain FIM only)', () => {
  beforeEach(resetAll);

  it('zero next-edit activity, and the FIM activity relay stays inert (no next-edit fetch, no throw)', async () => {
    const calls = stubFetchNeverCalled();
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: false, generic: false });

    await fireTrigger();
    expect(calls).toHaveLength(0);
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBeUndefined();

    // FIM unaffected: its own activity relay (the ONLY seam next-edit has
    // into FIM's lifecycle, `08` §7.2/§7.4) must keep working without ever
    // reaching for the next-edit wire while the capability is off.
    expect(() => fimActivityRelay.requestStarted()).not.toThrow();
    expect(() => fimActivityRelay.resultShown(true)).not.toThrow();
    expect(() => fimActivityRelay.accepted()).not.toThrow(); // arms the R4 trigger

    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls, 'GATE 1 (mode off) must hold even after the R4 accept seam arms the trigger').toHaveLength(0);
  });
});

// ══════════════════════ Refusal round-trip ═══════════════════════

describe('R5 refusal round-trip (owner: turn ONE on, the second is refused, one alert)', () => {
  beforeEach(resetAll);

  it('NEXT on, then a generic toggle-on request rejects; the store is untouched; one warning; NEXT (and FIM) unaffected', async () => {
    const { memento, updates, store } = makeRecordingMemento();
    const guard = await NextEditGuard.hydrate(memento, { reportFailure: DEPS.reportFailure });

    await requestNextEditToggle(guard, { source: 'next', on: true }, DEPS);
    expect(guard.getState()).toEqual({ next: true, generic: false });
    expect(updates, 'setup: the NEXT toggle-on must have persisted').toHaveLength(1);
    const persistedBeforeRefusal = store.get('hermes.nextEdit.toggles');

    await expect(requestNextEditToggle(guard, { source: 'generic', on: true }, DEPS)).rejects.toThrow(
      'Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.',
    );

    // The ratified state, in-memory AND on disk, is untouched by the
    // refusal — no second write.
    expect(guard.getState()).toEqual({ next: true, generic: false });
    expect(updates, 'a refusal must persist NOTHING — no second Memento.update call').toHaveLength(1);
    expect(store.get('hermes.nextEdit.toggles')).toEqual(persistedBeforeRefusal);
    // One warning — the alert that, at the webview layer (`SettingsPanel.tsx`
    // / `settingsField.ts`'s `rollbackField`, covered by
    // `webview/src/rpc.test.ts` and the panel's own suite, out of scope
    // here), is what makes the Settings row visibly snap back.
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toBe(
      'Next Edit: turn off "Next Edit — dedicated model" first — the two sources are mutually exclusive.',
    );
    // The setup note must not have fired for a REFUSED generic toggle-on.
    expect(host.infos).toEqual([]);

    // NEXT (and, by the same token, FIM) unaffected: the refused Generic
    // attempt must not have disturbed NEXT's own ability to function.
    const calls = stubFetchAlwaysRewrites();
    host.activeTextEditor = makeEditor(makeDoc());
    registerHermesNextEdit(makeContext(), guard, DEPS);
    await fireTrigger();
    expect(calls).toHaveLength(1);
    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).toBe(true);

    expect(() => fimActivityRelay.requestStarted()).not.toThrow();
    expect(() => fimActivityRelay.resultShown(false)).not.toThrow();
  });
});

// ══════════════════════ Cold-start sanitize ═══════════════════════

describe('R5 cold-start sanitize (owner: a hand-edited both-on store is unrepresentable)', () => {
  beforeEach(resetAll);

  it('a hand-edited both-on store resets to OFF, persists the reset, one notice, zero next-edit activity; FIM unaffected', async () => {
    const { memento, updates, store } = makeRecordingMemento({ next: true, generic: true });

    const guard = await NextEditGuard.hydrate(memento, { reportFailure: DEPS.reportFailure });

    expect(guard.getState()).toEqual({ next: false, generic: false });
    expect(guard.getMode()).toBe('off');
    expect(updates, 'the reset must be PERSISTED (exactly one Memento.update call)').toHaveLength(1);
    expect(updates[0]?.value).toEqual({ next: false, generic: false });
    expect(store.get('hermes.nextEdit.toggles')).toEqual({ next: false, generic: false });
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toBe(NEXT_EDIT_RESET_NOTICE);

    const calls = stubFetchNeverCalled();
    host.activeTextEditor = makeEditor(makeDoc());
    registerHermesNextEdit(makeContext(), guard, DEPS);

    await fireTrigger();
    expect(calls, 'a sanitized both-off store must build zero next-edit requests').toHaveLength(0);

    // FIM unaffected: the sanitize must not have left the FIM activity relay
    // in a broken state.
    expect(() => fimActivityRelay.requestStarted()).not.toThrow();
    expect(() => fimActivityRelay.resultShown(true)).not.toThrow();
    expect(() => fimActivityRelay.accepted()).not.toThrow();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
  });
});

// ══════════════════════ Cross-channel (R2) ═══════════════════════

describe('Cross-channel (owner: R2 — FIM always wins over an in-flight next-edit)', () => {
  beforeEach(resetAll);

  it('a FIM result shown mid-flight aborts the pending next-edit REQUEST (a real AbortSignal reaching a real in-flight fetch) and NO decoration ever appears', async () => {
    const { calls, getSignal } = stubDeferredFetch();
    host.activeTextEditor = makeEditor(makeDoc());
    await setupShell({ next: true, generic: false });

    await fireTrigger();
    expect(calls, 'setup: the trigger must have reached the real fetch exactly once').toHaveLength(1);
    const signal = getSignal();
    expect(signal, 'setup: the real fetch call must have received an AbortSignal').toBeDefined();
    expect(signal?.aborted, 'setup: the signal must start UNaborted').toBe(false);

    // FIM starts, and its result is shown mid-flight — R2: FIM always wins.
    fimActivityRelay.requestStarted();
    fimActivityRelay.resultShown(true);

    // The abort reaches the REAL fetch call's REAL AbortSignal — not a
    // simulated "settle() with nothing" the way a mocked-backend suite has
    // to.
    expect(signal?.aborted, 'R2: FIM must abort the in-flight next-edit REQUEST').toBe(true);

    // Let the stub's abort-triggered rejection propagate through the real
    // backend.predict() -> the shell's own catch -> back to idle.
    await vi.advanceTimersByTimeAsync(0);

    expect(contextKeyValue('talaria.nextEdit.jumpVisible')).not.toBe(true);
    expect(anyDecorationShown(), 'NO decoration may ever appear for an aborted next-edit request').toBe(false);
  });
});
