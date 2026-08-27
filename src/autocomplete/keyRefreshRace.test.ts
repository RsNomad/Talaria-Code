import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * BHF-F3-6 — the key-refresh race. Activation's `initApiKey` read and the
 * rotation listener's `secrets.get` re-read both used to assign
 * `secretApiKey` + `rebuild()` unconditionally: a SLOW activation read
 * settling after a rotation overwrote the fresher key, and the stale key
 * kept egressing. The fix is the codebase's own `modelSwitchSeq` liveness
 * token (`SessionController.ts`): capture `++keyRefreshSeq` at ISSUE time,
 * apply only while still current.
 *
 * Observability: `createBackend` is mocked to RECORD the apiKey of every
 * engine build — the sequence of recorded keys IS the sequence of live keys.
 * Deferred promises (not fake timers) drive the interleaving: timers cannot
 * reorder promise settlement, which is the whole race.
 */
const host = {
  backendKeys: [] as Array<string | undefined>,
};

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: { registerCommand: () => ({ dispose() {} }) },
  languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
  window: {
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, dflt: T): T => dflt,
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
  createBackend: (cfg: { apiKey?: string }) => {
    host.backendKeys.push(cfg.apiKey);
    return {
      name: 'ollama',
      capabilities: { nativeFim: true, assemblesCrossFileServerSide: false, streaming: true },
      streamFim: () => {
        throw new Error('no completion is requested in these tests');
      },
    };
  },
  clearBackendFactoryWarnings: () => {},
}));

vi.mock('./context/contextService.vscode', () => ({
  createHermesCrossFileContextService: () => ({
    service: { reconfigure: () => {}, snapshotFor: () => ({ snippets: [] }), maybeWarmUp: () => {} },
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

void vscode; // imported for the mock side effect only

function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `reads[i]` scripts the i-th `secrets.get` call (0 = activation's initApiKey read). */
function makeFakeContext(reads: Array<() => Promise<string | undefined>>): {
  ctx: vscode.ExtensionContext;
  fireSecretChange: (e: { key: string }) => void;
} {
  let getCallCount = 0;
  let fire: ((e: { key: string }) => void) | undefined;
  const ctx = {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: (_key: string) => {
        const read = reads[getCallCount];
        getCallCount += 1;
        return read !== undefined ? read() : Promise.resolve(undefined);
      },
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: (cb: (e: { key: string }) => void) => {
        fire = cb;
        return { dispose() {} };
      },
    },
  } as unknown as vscode.ExtensionContext;
  return {
    ctx,
    fireSecretChange: (e) => {
      expect(fire, 'onDidChange was never subscribed — the test would be vacuous').toBeDefined();
      fire!(e);
    },
  };
}

describe('BHF-F3-6: key-refresh sequence guard', () => {
  beforeEach(() => {
    host.backendKeys.length = 0;
  });

  it('a rotation issued while the activation read is still pending WINS; the slow activation read no-ops', async () => {
    const initRead = deferred<string | undefined>();
    const { ctx, fireSecretChange } = makeFakeContext([
      () => initRead.promise, // activation read — SLOW
      () => Promise.resolve('rotated-key'), // rotation re-read — fast
    ]);
    const disposable = registerTalariaAutocomplete(ctx, () => {});
    await flushAsync();
    // Activation's synchronous first build ran with no secret yet.
    expect(host.backendKeys).toEqual([undefined]);

    fireSecretChange({ key: AUTOCOMPLETE_API_KEY_SECRET });
    await flushAsync();
    expect(host.backendKeys).toEqual([undefined, 'rotated-key']);

    initRead.resolve('stale-init-key'); // the superseded read finally settles
    await flushAsync();
    disposable.dispose();

    // THE assertion: no third build — the stale read must not have applied.
    expect(host.backendKeys).toEqual([undefined, 'rotated-key']);
  });

  it('CONTROL: with no rotation, the activation read applies exactly as before', async () => {
    const { ctx } = makeFakeContext([() => Promise.resolve('init-key')]);
    const disposable = registerTalariaAutocomplete(ctx, () => {});
    await flushAsync();
    disposable.dispose();
    expect(host.backendKeys).toEqual([undefined, 'init-key']);
  });

  it('two rapid rotations settling out of order: the LAST-ISSUED read wins', async () => {
    const rotA = deferred<string | undefined>();
    const rotB = deferred<string | undefined>();
    const { ctx, fireSecretChange } = makeFakeContext([
      () => Promise.resolve(undefined), // activation read, settles immediately
      () => rotA.promise,
      () => rotB.promise,
    ]);
    const disposable = registerTalariaAutocomplete(ctx, () => {});
    await flushAsync(); // activation read applied (rebuild with undefined key)
    expect(host.backendKeys).toEqual([undefined, undefined]);

    fireSecretChange({ key: AUTOCOMPLETE_API_KEY_SECRET }); // issues rotA
    fireSecretChange({ key: AUTOCOMPLETE_API_KEY_SECRET }); // issues rotB (outranks rotA)
    rotB.resolve('key-B');
    await flushAsync();
    rotA.resolve('key-A'); // stale — must no-op
    await flushAsync();
    disposable.dispose();

    expect(host.backendKeys).toEqual([undefined, undefined, 'key-B']);
  });
});
