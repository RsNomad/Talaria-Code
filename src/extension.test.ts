/**
 * CF-08 / L5 F-1: `talaria.addToChat` / `explainCode` / `improveCode` /
 * `fixCode` / `generateCommitMessage` used to be registered ONLY when
 * `isHermesReady()` (workspace trusted AND `talaria.backend === 'acp'`). The
 * shipped DEFAULT is `talaria.backend: 'mock'`, so on every default install
 * these five commands were declared in `package.json`'s
 * `contributes.commands` (palette-visible, no `when:false`) but NEVER
 * registered — invoking any of them from the Command Palette produced VS
 * Code's raw `command 'talaria.addToChat' not found` error on first contact.
 *
 * This is a REAL activation test — it calls the real `activate()` from
 * `./extension` against a minimal fake `vscode` + `ExtensionContext`, then
 * asserts on what actually got registered via `vscode.commands.registerCommand`
 * (not a text scan like `commandParity.test.ts`, which only proves a
 * `registerCommand('talaria.x'` call exists SOMEWHERE under `src/` — not that
 * it actually runs under the shipped default config).
 *
 * Only `vscode` itself and the unrelated, heavy `./autocomplete` zone (its
 * own FIM-backend construction is irrelevant to command registration and
 * already covered by `autocomplete/activationDoesNotThrow.test.ts`) are
 * mocked — `TalariaViewProvider`, `MockBackend`, the diff-preview machinery,
 * the LSP/MCP lib host, and the editor-action/commit-message command
 * modules all run for REAL. No workspace folder is open and the workspace is
 * left trusted (irrelevant here — `talaria.backend` defaults to `'mock'`
 * regardless of trust), which keeps the RAG/LIB trust-gated zones inert
 * without needing to mock their internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mutable test-controlled state the fake `vscode` module reads. Declared
 * `const` (not `vi.hoisted()`) — every reference to it inside the
 * `vi.mock('vscode', ...)` factory below is INSIDE a nested closure (a
 * getter or an inner arrow function body), never dereferenced at the
 * factory's own top level, so it is never touched before this line has run —
 * the same discipline `autocomplete/activationDoesNotThrow.test.ts`'s `host`
 * object uses.
 */
const state = {
  settings: new Map<string, unknown>(),
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  warnings: [] as string[],
  infos: [] as string[],
  isTrusted: true,
  workspaceFolders: undefined as unknown,
  activeTextEditor: undefined as unknown,
  // CF-09: config-change listeners registered via
  // `vscode.workspace.onDidChangeConfiguration`, the executed-command log
  // (so a test can assert `workbench.action.reloadWindow` actually ran), and
  // the button label `showInformationMessage` resolves to (so a test can
  // simulate the user clicking "Reload Window" vs. dismissing the prompt).
  configChangeListeners: new Set<(e: { affectsConfiguration: (section: string) => boolean }) => void>(),
  executedCommands: [] as string[],
  infoResponse: undefined as string | undefined,
};

function resetState(): void {
  state.settings.clear();
  state.registeredCommands.clear();
  state.warnings.length = 0;
  state.infos.length = 0;
  state.isTrusted = true;
  state.workspaceFolders = undefined;
  state.activeTextEditor = undefined;
  state.configChangeListeners.clear();
  state.executedCommands.length = 0;
  state.infoResponse = undefined;
}

vi.mock('vscode', () => {
  // Defined INSIDE the factory (not a top-level reference the factory
  // closes over) — `vi.mock` factories are hoisted above the rest of this
  // module, so a class declared at module scope and merely REFERENCED here
  // (as opposed to dereferenced lazily inside a nested closure, like every
  // `state.*` access below) would hit the temporal dead zone at hoist time.
  class FakeEventEmitter<T> {
    private readonly listeners = new Set<(e: T) => void>();
    event = (listener: (e: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(e: T): void {
      for (const listener of [...this.listeners]) listener(e);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter: FakeEventEmitter,
    Disposable: {
      from: (...items: { dispose(): void }[]) => ({
        dispose: () => items.forEach((item) => item.dispose()),
      }),
    },
    CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction: class {
      constructor(
        public title: string,
        public kind?: unknown,
      ) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        state.registeredCommands.set(id, handler);
        return { dispose: () => state.registeredCommands.delete(id) };
      },
      executeCommand: (...args: unknown[]) => {
        state.executedCommands.push(String(args[0]));
        return Promise.resolve(undefined);
      },
    },
    languages: {
      registerCodeActionsProvider: () => ({ dispose() {} }),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        show: () => {},
        dispose: () => {},
      }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      showWarningMessage: (msg: string) => {
        state.warnings.push(msg);
        return Promise.resolve(undefined);
      },
      showInformationMessage: (msg: string, ..._items: string[]) => {
        state.infos.push(msg);
        return Promise.resolve(state.infoResponse);
      },
      get activeTextEditor() {
        return state.activeTextEditor;
      },
      tabGroups: {
        all: [] as unknown[],
        activeTabGroup: { activeTab: undefined },
        close: () => Promise.resolve(undefined),
      },
    },
    workspace: {
      getConfiguration: (section: string) => ({
        get: <T,>(key: string, dflt: T): T =>
          state.settings.has(`${section}.${key}`) ? (state.settings.get(`${section}.${key}`) as T) : dflt,
        update: () => Promise.resolve(undefined),
      }),
      get isTrusted() {
        return state.isTrusted;
      },
      get workspaceFolders() {
        return state.workspaceFolders as never;
      },
      onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
      onDidChangeConfiguration: (listener: (e: { affectsConfiguration: (section: string) => boolean }) => void) => {
        state.configChangeListeners.add(listener);
        return { dispose: () => state.configChangeListeners.delete(listener) };
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
    },
  };
});

/**
 * Deliberately mocked out: `./autocomplete`'s real backend construction
 * (SecretStorage, config-driven FIM backend selection) is orthogonal to
 * whether the FIVE palette commands under test get registered, and already
 * has its own dedicated activation coverage
 * (`autocomplete/activationDoesNotThrow.test.ts`).
 */
vi.mock('./autocomplete', () => ({
  registerTalariaAutocomplete: () => ({ dispose() {} }),
}));

import { activate } from './extension';
import type * as vscode from 'vscode';

/** A minimal `vscode.ExtensionContext` — only the members `activate()`
 * actually reads on the `backend: 'mock'` / no-workspace path this file
 * exercises (the trust-gated `acp` path — `CheckpointTracker`,
 * `HermesDashboardManager`, `ContextResolver`, `AcpBackend` itself — never
 * runs here, so their context needs are out of scope). The `unknown`
 * double-cast (never `any` — the repo's `anyIntroductionBan.test.ts` lock
 * bans it everywhere under `src/`) mirrors
 * `autocomplete/activationDoesNotThrow.test.ts`'s own `makeFakeContext`. */
function makeFakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: { fsPath: '/fake/ext', path: '/fake/ext' },
    globalStorageUri: { fsPath: '/fake/storage', path: '/fake/storage' },
    asAbsolutePath: (p: string) => p,
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(undefined),
      onDidChange: () => ({ dispose() {} }),
    },
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(undefined),
      keys: () => [],
    },
  } as unknown as vscode.ExtensionContext;
}

/** A minimal `vscode.TextEditor` with a non-empty document/selection so
 * `snapshotSelection` (`editorActions.vscode.ts`) and `fixCode`'s diagnostics
 * flatten both complete without throwing — the same shape
 * `editorActions.test.ts` exercises the pure `buildSeed` half with. */
function makeFakeEditor(): unknown {
  return {
    document: {
      uri: { path: 'src/foo.ts', fsPath: 'src/foo.ts' },
      languageId: 'typescript',
      getText: () => 'const x = 1;',
      lineAt: (line: number) => ({
        range: { start: { line, character: 0 }, end: { line, character: 12 } },
      }),
    },
    selection: {
      isEmpty: true,
      active: { line: 0 },
    },
  };
}

const PALETTE_COMMAND_IDS = [
  'talaria.addToChat',
  'talaria.explainCode',
  'talaria.improveCode',
  'talaria.fixCode',
  'talaria.generateCommitMessage',
];

describe('CF-08: palette commands register under the DEFAULT (mock) backend', () => {
  beforeEach(() => {
    resetState();
  });

  it('registers all five commands even though talaria.backend defaults to "mock" (no config set)', () => {
    activate(makeFakeContext());

    const missing = PALETTE_COMMAND_IDS.filter((id) => !state.registeredCommands.has(id));
    expect(missing).toEqual([]);
  });

  it('addToChat/explainCode/improveCode/fixCode: a mock-mode invocation shows an honest "needs the real Hermes backend" notice, never throws, never silently no-ops', () => {
    activate(makeFakeContext());
    state.activeTextEditor = makeFakeEditor();

    for (const id of ['talaria.addToChat', 'talaria.explainCode', 'talaria.improveCode', 'talaria.fixCode']) {
      state.warnings.length = 0;
      const handler = state.registeredCommands.get(id);
      expect(handler, `${id} must be registered`).toBeTypeOf('function');

      expect(() => handler?.()).not.toThrow();
      expect(
        state.warnings.some((w) => /needs? the real Hermes backend/i.test(w)),
        `${id}: expected a "needs the real Hermes backend" warning, got: ${JSON.stringify(state.warnings)}`,
      ).toBe(true);
    }
  });

  it('generateCommitMessage: a mock-mode invocation shows the same honest degrade (pre-existing behavior, unaffected by this fix)', async () => {
    activate(makeFakeContext());

    const handler = state.registeredCommands.get('talaria.generateCommitMessage');
    expect(handler).toBeTypeOf('function');

    await handler?.();
    expect(state.warnings.some((w) => /needs? the real Hermes backend/i.test(w))).toBe(true);
  });
});

/**
 * Fires every listener registered via `vscode.workspace.onDidChangeConfiguration`
 * with a fake `ConfigurationChangeEvent` whose `affectsConfiguration` is the
 * given predicate — mirrors how VS Code itself invokes the real listener.
 */
function fireConfigChange(affects: (section: string) => boolean): void {
  const event = { affectsConfiguration: affects };
  for (const listener of [...state.configChangeListeners]) listener(event);
}

/** Flushes the microtask queue so a `showInformationMessage(...).then(...)`
 * chain (fire-and-forget in `activate()`, never awaited by the caller) has
 * had a chance to run before the test asserts on its effects. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * CF-09 / L5 F-5: backend selection (`mock` vs `acp`) is resolved ONCE at
 * `activate()` (re-evaluated only on a trust grant). There is NO
 * `onDidChangeConfiguration` listener for `talaria.backend`, so the README's
 * onboarding step 3 ("switch talaria.backend from mock to acp") is a silent
 * no-op until the user manually reloads the window. Fix: an
 * `onDidChangeConfiguration` listener that, when `talaria.backend` is the
 * key that changed, prompts "reload to apply" and, on "Reload Window",
 * executes `workbench.action.reloadWindow` — never a live hot-swap (that
 * stays out of scope; the prompt is the contract).
 */
describe('CF-09: reload prompt when talaria.backend changes', () => {
  beforeEach(() => {
    resetState();
  });

  it('shows a "reload to apply" prompt when talaria.backend changes', () => {
    activate(makeFakeContext());

    fireConfigChange((section) => section === 'talaria.backend');

    expect(
      state.infos.some((m) => /reload/i.test(m)),
      `expected a reload prompt, got infos: ${JSON.stringify(state.infos)}`,
    ).toBe(true);
  });

  it('does not prompt when an unrelated setting changes', () => {
    activate(makeFakeContext());

    fireConfigChange((section) => section === 'talaria.someOtherSetting');

    expect(state.infos.some((m) => /reload/i.test(m))).toBe(false);
  });

  it('reloads the window when the user accepts the "Reload Window" prompt action', async () => {
    activate(makeFakeContext());
    state.infoResponse = 'Reload Window';

    fireConfigChange((section) => section === 'talaria.backend');
    await flushMicrotasks();

    expect(state.executedCommands).toContain('workbench.action.reloadWindow');
  });

  it('does not reload when the user dismisses the prompt without choosing an action', async () => {
    activate(makeFakeContext());
    state.infoResponse = undefined;

    fireConfigChange((section) => section === 'talaria.backend');
    await flushMicrotasks();

    expect(state.executedCommands).not.toContain('workbench.action.reloadWindow');
  });
});
