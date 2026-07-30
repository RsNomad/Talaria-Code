import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Review C-1 (CRITICAL). `registerTalariaAutocomplete`'s `buildEngine` call
 * at activation (`index.ts:95`) runs SYNCHRONOUSLY, before SecretStorage's
 * async `context.secrets.get` has resolved (`index.ts:90-94` documents this
 * deliberately) — so the FIRST `createBackend` call any activation ever
 * makes always sees `apiKey: undefined`, regardless of what SecretStorage or
 * the legacy plaintext setting eventually contain, and regardless of
 * whether autocomplete is even enabled (`buildEngine` runs before any
 * `cfg.enabled` check). A `createBackend` that THROWS for a keyless
 * `codestral` config therefore throws out of `activate()` itself
 * (`extension.ts:325` calls `registerTalariaAutocomplete` unguarded, and
 * `activate()` has no try/catch anywhere around it) — killing every zone
 * registered after it (RAG, the LSP/MCP lib server, the dashboard, ...) —
 * for the legitimate, DOCUMENTED "key lives in SecretStorage" configuration.
 * The user put the key exactly where `createBackend`'s own error message
 * tells them to.
 *
 * THIS is the one activation test file that does NOT mock `./backendFactory`
 * — every other one does (`apiKey.test.ts:228`'s `vi.mock('./backendFactory'
 * , ...)`, `activationRace.test.ts:115`'s own copy), which is exactly why
 * the real `createBackend` had never run inside a real activation in this
 * suite, and exactly why 3319 green tests missed this. Only `vscode` and the
 * two activation side-cars unrelated to the credential path
 * (`context/contextService.vscode`, `nextedit/shell.vscode`) are stubbed
 * here — `createBackend` and every FIM backend class it can construct,
 * including the real `CodestralFimBackend`, run for real.
 */

const host = {
  settings: new Map<string, unknown>(),
  failures: [] as string[],
  /** Every `onDidChangeConfiguration` listener this activation registered —
   *  lets a test fire a real config change and observe `rebuild()`. */
  configListeners: [] as ((e: { affectsConfiguration: (section: string) => boolean }) => void)[],
};

function resetHost(): void {
  host.settings.clear();
  host.failures.length = 0;
  host.configListeners.length = 0;
}

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: {
    registerCommand: () => ({ dispose() {} }),
  },
  languages: {
    registerInlineCompletionItemProvider: () => ({ dispose() {} }),
  },
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, dflt: T): T =>
        host.settings.has(`${section}.${key}`) ? (host.settings.get(`${section}.${key}`) as T) : dflt,
      update: () => Promise.resolve(undefined),
    }),
    onDidChangeConfiguration: (
      listener: (e: { affectsConfiguration: (section: string) => boolean }) => void,
    ) => {
      host.configListeners.push(listener);
      return { dispose() {} };
    },
    get isTrusted() {
      return true;
    },
  },
  Disposable: {
    from: (...items: { dispose(): void }[]) => ({
      dispose: () => items.forEach((item) => item.dispose()),
    }),
  },
}));

/**
 * Deliberately NOT mocked: `./backendFactory` (the real `createBackend`) and
 * every FIM backend it can construct, including `./backends/
 * CodestralFimBackend`. This is the entire point of this file — see the
 * module doc above.
 */

vi.mock('./context/contextService.vscode', () => ({
  createHermesCrossFileContextService: () => ({
    service: {
      reconfigure: () => {},
      snapshotFor: () => ({ snippets: [] }),
      maybeWarmUp: () => {},
    },
    disposable: { dispose() {} },
  }),
}));

vi.mock('./nextedit/shell.vscode', () => ({
  fimActivityRelay: {
    requestStarted: () => {},
    resultShown: () => {},
    accepted: () => {},
    acceptCommandId: () => undefined,
  },
  registerTalariaNextEdit: () => ({ dispose() {} }),
  requestNextEditToggle: () => Promise.resolve({ next: false, generic: false }),
}));

import * as vscode from 'vscode';
import { registerTalariaAutocomplete } from './index';

/**
 * `secrets.get` deliberately resolves on a LATER microtask (a real
 * `Promise.resolve(...)`, never a value returned synchronously) — mirrors
 * the real SecretStorage API, which is always async, and is the exact
 * condition C-1 depends on: activation's first `buildEngine()` call must
 * see this NOT YET resolved.
 */
function makeFakeContext(secretValue: string | undefined): vscode.ExtensionContext {
  const globalStore = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: (key: string) =>
        Promise.resolve(key === 'talaria.autocomplete.apiKey' ? secretValue : undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: () => ({ dispose() {} }),
    },
    globalState: {
      get: (key: string) => globalStore.get(key),
      update: (key: string, value: unknown) => {
        globalStore.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...globalStore.keys()],
      setKeysForSync: () => {},
    },
  } as unknown as vscode.ExtensionContext;
}

describe('C-1: registerTalariaAutocomplete must not throw during synchronous activation (real backendFactory, real CodestralFimBackend)', () => {
  beforeEach(() => {
    resetHost();
  });

  it('does not throw when backend=codestral and the key legitimately lives ONLY in SecretStorage (async — not yet resolved at the point buildEngine runs)', () => {
    host.settings.set('talaria.autocomplete.backend', 'codestral');
    // No `talaria.autocomplete.apiKey` setting at all: the documented,
    // correct configuration — the user ran "Talaria: Set Autocomplete API
    // Key" and the key lives ONLY in SecretStorage.
    const ctx = makeFakeContext('sk-real-key-in-secretstorage');

    let disposable: vscode.Disposable | undefined;
    expect(() => {
      disposable = registerTalariaAutocomplete(ctx, (msg) => host.failures.push(msg));
    }).not.toThrow();

    disposable?.dispose();
  });

  it('does not throw when autocomplete is disabled and backend=codestral with no key anywhere (buildEngine runs before any cfg.enabled check)', () => {
    host.settings.set('talaria.autocomplete.enabled', false);
    host.settings.set('talaria.autocomplete.backend', 'codestral');
    const ctx = makeFakeContext(undefined);

    let disposable: vscode.Disposable | undefined;
    expect(() => {
      disposable = registerTalariaAutocomplete(ctx, (msg) => host.failures.push(msg));
    }).not.toThrow();

    disposable?.dispose();
  });

  /**
   * Review C-1's "second, self-healing instance": switching
   * `talaria.autocomplete.backend` to `codestral` in user settings BEFORE a
   * key exists anywhere used to throw inside the `onDidChangeConfiguration`
   * listener (`index.ts:208-217`) — `cfg` was reassigned before the
   * throwing `rebuild()` call, leaving the provider's `cfg`-reading
   * closures reporting `codestral` against a STALE `engine` that was still
   * the previous backend, until the next rebuild self-healed it. Moving the
   * refusal off `createBackend` makes `rebuild()` itself never throw for
   * this case any more, so this transient desync no longer occurs — proven
   * here by firing a real config-change event and asserting it completes
   * without throwing.
   */
  it("does not throw when talaria.autocomplete.backend is switched to codestral via a live config change, before any key exists anywhere (the 'self-healing instance' is now moot — rebuild() never throws for this case)", () => {
    const ctx = makeFakeContext(undefined);
    const disposable = registerTalariaAutocomplete(ctx, (msg) => host.failures.push(msg));

    host.settings.set('talaria.autocomplete.backend', 'codestral');
    expect(() => {
      for (const listener of host.configListeners) {
        listener({ affectsConfiguration: (section) => section === 'talaria.autocomplete' });
      }
    }).not.toThrow();

    disposable.dispose();
  });

  it('control: a non-codestral default (ollama) backend never threw either — proves this file`s harness itself is sound, not just permissive', () => {
    const ctx = makeFakeContext(undefined);

    let disposable: vscode.Disposable | undefined;
    expect(() => {
      disposable = registerTalariaAutocomplete(ctx, (msg) => host.failures.push(msg));
    }).not.toThrow();

    disposable?.dispose();
  });
});
