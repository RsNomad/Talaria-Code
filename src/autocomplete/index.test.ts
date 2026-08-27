import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Audit C-7. `index.ts`'s `secretDisposable = context.secrets.onDidChange(...)`
 * re-reads the key with `void context.secrets.get(AUTOCOMPLETE_API_KEY_SECRET)
 * .then((key) => {...})` — a single-argument `.then()`. SecretStorage.get can
 * REJECT (a keyring that is present but erroring), and with no rejection arm
 * that left the PREVIOUS key live and told the user nothing at all: a rotation
 * silently failed to take effect.
 *
 * Mirrors the harness style already used for the sibling activation-time
 * rejection (`apiKey.test.ts`'s F-4 tests) and the race-condition suite
 * (`activationRace.test.ts`) — minimal `vscode` mock, `backendFactory` and the
 * two activation side-cars stubbed, everything else real.
 */

const host = {
  settings: new Map<string, unknown>(),
  failures: [] as string[],
};

function resetHost(): void {
  host.settings.clear();
  host.failures.length = 0;
  createdStatusItems.length = 0;
  shownWarningToasts.length = 0;
  registeredInlineProviders.length = 0;
  closeListeners.length = 0;
}

/** CA-06-face + CA-06-path-face recorders — plain-array pushes (repo
 *  convention, never `vi.fn()`). Populated by the `vscode` mock below. */
const createdStatusItems: string[] = [];
const shownWarningToasts: string[] = [];
const registeredInlineProviders: vscode.InlineCompletionItemProvider[] = [];
const closeListeners: Array<(doc: { uri: { toString(): string } }) => void> = [];

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
  Position: class {
    constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  },
  Uri: {
    parse: (value: string) => ({
      scheme: value.slice(0, Math.max(0, value.indexOf(':'))),
      fsPath: value.startsWith('file://') ? value.slice('file://'.length) : value,
    }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: () => Promise.resolve(undefined),
  },
  languages: {
    registerInlineCompletionItemProvider: (
      _selector: unknown,
      provider: vscode.InlineCompletionItemProvider,
    ) => {
      registeredInlineProviders.push(provider);
      return { dispose() {} };
    },
    createLanguageStatusItem: (id: string) => {
      createdStatusItems.push(id);
      return {
        id,
        name: undefined,
        text: '',
        detail: undefined,
        severity: 0,
        command: undefined,
        accessibilityInformation: undefined,
        busy: false,
        dispose(): void {},
      };
    },
  },
  window: {
    showWarningMessage: (message: string) => {
      shownWarningToasts.push(message);
      return Promise.resolve(undefined);
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, dflt: T): T =>
        host.settings.has(`${section}.${key}`) ? (host.settings.get(`${section}.${key}`) as T) : dflt,
      update: () => Promise.resolve(undefined),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidCloseTextDocument: (cb: (doc: { uri: { toString(): string } }) => void) => {
      closeListeners.push(cb);
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

vi.mock('./backendFactory', () => ({
  createBackend: () => ({
    name: 'ollama',
    capabilities: { nativeFim: true, assemblesCrossFileServerSide: false, streaming: true },
    streamFim: () => {
      throw new Error('no completion is requested in these tests');
    },
  }),
  // T-6 F4/F6: `rebuild()` now calls this on every config change — a full
  // module mock (not `importOriginal`) must keep every named export the
  // real module has, same discipline as `createBackend` itself above.
  clearBackendFactoryWarnings: () => {},
}));

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
import { AUTOCOMPLETE_API_KEY_SECRET } from './apiKey';
import { must } from '../testing/must';

/** Lets pending microtasks (async key load, `rebuild()`, the re-read) run. */
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The FIRST `secrets.get` call is activation's own `initApiKey` read (must
 * succeed cleanly so this test isolates the re-read path, not that
 * already-covered one — see `apiKey.test.ts`'s F-4 suite). Every call AFTER
 * that models the keyring going bad: `onDidChange` fires, the handler
 * re-reads, and THAT read rejects.
 */
function makeFakeContext(): {
  ctx: vscode.ExtensionContext;
  fireSecretChange: (e: { key: string }) => void;
} {
  let getCallCount = 0;
  let fireSecretChange: ((e: { key: string }) => void) | undefined;
  const globalStore = new Map<string, unknown>();
  const ctx = {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: (_key: string) => {
        getCallCount += 1;
        if (getCallCount === 1) return Promise.resolve(undefined);
        return Promise.reject(new Error('keyring unavailable'));
      },
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: (cb: (e: { key: string }) => void) => {
        fireSecretChange = cb;
        return { dispose() {} };
      },
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
  return {
    ctx,
    fireSecretChange: (e) => {
      expect(fireSecretChange, 'onDidChange was never subscribed — the test would be vacuous').toBeDefined();
      fireSecretChange!(e);
    },
  };
}

describe('C-7: a failed secret re-read is reported, never silent', () => {
  beforeEach(() => {
    resetHost();
  });

  it('reports failure and keeps going when SecretStorage.get rejects on a post-activation re-read, instead of leaving the old key live in silence', async () => {
    const { ctx, fireSecretChange } = makeFakeContext();

    const disposable = registerTalariaAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync(); // let activation's own (successful) key load settle first
    expect(
      host.failures,
      'activation itself must not have failed — otherwise the assertion below is vacuous',
    ).toEqual([]);

    fireSecretChange({ key: AUTOCOMPLETE_API_KEY_SECRET });
    await flushAsync();
    disposable.dispose();

    expect(
      host.failures.some((l) => l.includes('failed to re-read the autocomplete API key')),
    ).toBe(true);
  });

  it("never echoes the error text (only its kind) — a keyring error can carry the key's storage path", async () => {
    const { ctx, fireSecretChange } = makeFakeContext();

    const disposable = registerTalariaAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();

    fireSecretChange({ key: AUTOCOMPLETE_API_KEY_SECRET });
    await flushAsync();
    disposable.dispose();

    const match = host.failures.find((l) => l.includes('failed to re-read the autocomplete API key'));
    expect(match).toBeDefined();
    expect(match).not.toContain('keyring unavailable');
  });

  it('ignores a change on an unrelated secret key (no re-read, nothing reported)', async () => {
    const { ctx, fireSecretChange } = makeFakeContext();

    const disposable = registerTalariaAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();

    fireSecretChange({ key: 'some.other.secret' });
    await flushAsync();
    disposable.dispose();

    expect(host.failures).toEqual([]);
  });
});

describe('CA-06-face + CA-06-path-face — composition-root wiring', () => {
  beforeEach(() => {
    resetHost();
  });

  it('CA-06-face content surface is inert at rest: activation on the default (loopback) config creates no language status item and no toast', () => {
    const { ctx } = makeFakeContext();
    const disposable = registerTalariaAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    disposable.dispose();
    expect(createdStatusItems).toEqual([]);
  });

  it('CA-06-path-face fires on the DEFAULT loopback config: a secret doc through the registered provider creates the Information badge, no toast', async () => {
    const { ctx } = makeFakeContext();
    const disposable = registerTalariaAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    const provider = must(registeredInlineProviders[0]); // the mock's recorded registration
    const doc = {
      languageId: 'plaintext',
      uri: { scheme: 'file', path: '/repo/.env', toString: () => 'file:///repo/.env' },
    };
    const result = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      new vscode.Position(0, 0),
      { triggerKind: 1, selectedCompletionInfo: undefined } as unknown as vscode.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as unknown as vscode.CancellationToken,
    );
    expect(result).toBeNull();
    expect(createdStatusItems).toEqual(['talaria.autocomplete.egressPaused:file:///repo/.env']);
    expect(shownWarningToasts).toEqual([]); // content face stays inert on loopback; path kind never toasts
    disposable.dispose();
  });
});
