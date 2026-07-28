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
    onDidChangeConfiguration: () => ({ dispose() {} }),
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
  registerHermesNextEdit: () => ({ dispose() {} }),
  requestNextEditToggle: () => Promise.resolve({ next: false, generic: false }),
}));

import * as vscode from 'vscode';
import { registerHermesAutocomplete } from './index';
import { AUTOCOMPLETE_API_KEY_SECRET } from './apiKey';

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

    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
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

    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
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

    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();

    fireSecretChange({ key: 'some.other.secret' });
    await flushAsync();
    disposable.dispose();

    expect(host.failures).toEqual([]);
  });
});
