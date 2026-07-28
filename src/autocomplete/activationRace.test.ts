import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * FINAL REVIEW — FINDING 1. The deactivate-during-hydration guard in
 * `index.ts` (`if (nextEditTornDown) return;`) was completely unguarded:
 * deleting that ONE line left the entire suite green (3282 pass / 1 known
 * `CheckpointTracker` EBUSY flake). The line predates wave 5.2, but 5.2
 * rewired this continuation three times, so it was live, load-bearing and
 * unproven at once.
 *
 * WHAT THE LINE HOLDS. `NextEditGuard.hydrate` is async, so
 * `registerHermesNextEdit` always lands on a later tick. Close the window (or
 * reload the extension) during startup and the composite disposable runs
 * FIRST — the activation is already dead when hydration resolves. Without the
 * guard the continuation then goes on to:
 *
 *   1. attach three event subscriptions, four commands and two decoration
 *      types to that dead activation, and
 *   2. push the resulting disposable onto an ALREADY-DRAINED
 *      `context.subscriptions` (`shell.vscode.ts:1391`) — nothing will ever
 *      dispose it, and
 *   3. re-point the module-level `currentFimActivity` relay
 *      (`shell.vscode.ts:1362`) at a shell nobody will dispose.
 *
 * (3) is the serious one. That slot is R2's refcount: next-edit may not BUILD
 * a request while FIM has ghost text on screen or in flight. BF-B's liveness
 * check on the dispose side (`shell.vscode.ts:1384`, "clear the relay only
 * while THIS registration still owns it") exists precisely so a stale
 * registration cannot disarm R2 for the shell that is actually live — and a
 * registration that runs AFTER its own teardown is a stale registration that
 * BF-B can never reach, because its dispose already ran. The next activation's
 * `registerCommand` then throws *command already exists*.
 *
 * WHY THE SHELL IS MOCKED HERE. The observable this test needs is whether the
 * continuation RAN AT ALL — `registerHermesNextEdit` is the single gate every
 * one of (1)(2)(3) sits behind, so counting its calls is necessary and
 * sufficient. The real shell is exercised for its own behaviour by
 * `nextedit/shell.vscode.test.ts`; re-constructing it here would only add a
 * second copy of that harness to observe a call count.
 *
 * The `NextEditGuard` is deliberately left REAL (it needs only a `Memento`),
 * so the async shape this race depends on is production's, not a stub's.
 *
 * NON-VACUITY. Every "did not happen" assertion below is paired with a CONTROL
 * that runs the identical activation WITHOUT the teardown and asserts the same
 * things DO happen. A harness that silently stopped registering — a renamed
 * mock, a throwing hydrate, a swallowed rejection — would satisfy the
 * teardown case forever; only the control can tell "correctly suppressed"
 * apart from "never worked".
 */

/** Observation points. Read lazily from inside the `vi.mock` factories below
 *  (which are hoisted above every `const` in this file), never eagerly. */
const host = {
  settings: new Map<string, unknown>(),
  warnings: [] as string[],
  infos: [] as string[],
  failures: [] as string[],
};

/** Every call the hydration continuation makes, in order. */
const shell = {
  registerCalls: 0,
  /** Disposals of the disposable `registerHermesNextEdit` handed back. */
  disposeCalls: 0,
};

function resetAll(): void {
  host.settings.clear();
  host.warnings.length = 0;
  host.infos.length = 0;
  host.failures.length = 0;
  shell.registerCalls = 0;
  shell.disposeCalls = 0;
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
    showWarningMessage: (msg: string) => {
      host.warnings.push(msg);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (msg: string) => {
      host.infos.push(msg);
      return Promise.resolve(undefined);
    },
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

/**
 * `registerHermesNextEdit` counts its calls and — exactly like the real one
 * (`shell.vscode.ts:1391`) — pushes onto `context.subscriptions`. That push is
 * modelled rather than stubbed away because "what landed on an already-drained
 * subscriptions array" is one of the three consequences under test.
 */
vi.mock('./nextedit/shell.vscode', () => ({
  fimActivityRelay: {
    requestStarted: () => {},
    resultShown: () => {},
    accepted: () => {},
    acceptCommandId: () => undefined,
  },
  registerHermesNextEdit: (context: { subscriptions: { dispose(): void }[] }) => {
    shell.registerCalls += 1;
    const disposable = {
      dispose: () => {
        shell.disposeCalls += 1;
      },
    };
    context.subscriptions.push(disposable);
    return disposable;
  },
  requestNextEditToggle: () => Promise.resolve({ next: false, generic: false }),
}));

import { registerHermesAutocomplete } from './index';

interface FakeContext {
  ctx: import('vscode').ExtensionContext;
  /** The SAME array `context.subscriptions` points at, for length assertions. */
  subscriptions: { dispose(): void }[];
}

function makeFakeContext(): FakeContext {
  const globalStore = new Map<string, unknown>();
  const subscriptions: { dispose(): void }[] = [];
  const ctx = {
    subscriptions,
    secrets: {
      get: () => Promise.resolve(undefined),
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
  } as unknown as import('vscode').ExtensionContext;
  return { ctx, subscriptions };
}

/** Lets the hydration promise and its continuation run. */
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('FINDING 1: next-edit registration must not attach to a torn-down activation', () => {
  beforeEach(() => {
    resetAll();
  });

  /**
   * THE RACE. `dispose()` is called SYNCHRONOUSLY on the returned disposable,
   * i.e. strictly before `NextEditGuard.hydrate` can resolve — the exact
   * ordering of "the window is closed during startup". The guard must make the
   * continuation a no-op.
   */
  it('deactivating before hydration resolves cancels the registration entirely', async () => {
    const { ctx, subscriptions } = makeFakeContext();

    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    // Nothing may have registered yet — hydration is async by construction. If
    // this ever fails, the race below is no longer the race being tested.
    expect(
      shell.registerCalls,
      'hydration is async: registration cannot have happened on the synchronous path',
    ).toBe(0);
    const subscriptionsAtTeardown = subscriptions.length;
    disposable.dispose();

    await flushAsync();

    expect(
      shell.registerCalls,
      'R2: a registration on a dead activation re-points the module-level currentFimActivity relay at a ' +
        'shell nobody will dispose (shell.vscode.ts:1362), disarming R2 for the NEXT activation — whose ' +
        "registerCommand then throws 'command already exists'",
    ).toBe(0);
    expect(
      subscriptions.length,
      'context.subscriptions was already drained by the host — anything pushed onto it now is never disposed',
    ).toBe(subscriptionsAtTeardown);
    expect(host.failures, 'a cancelled registration is an ordinary shutdown, not a failure').toEqual([]);
  });

  /**
   * The toggle port is published from the SAME continuation, so it must be
   * suppressed by the same guard. Handing the webview a port over a Guard whose
   * shell was never registered would let a `nextEdit.toggle` request mutate
   * persisted state for an activation that no longer exists.
   */
  it('no toggle port is published to the webview when the activation lost the race', async () => {
    const { ctx } = makeFakeContext();
    let portsPublished = 0;

    const disposable = registerHermesAutocomplete(
      ctx,
      (msg: string) => host.failures.push(msg),
      () => {
        portsPublished += 1;
      },
    );
    disposable.dispose();

    await flushAsync();

    expect(portsPublished).toBe(0);
  });

  /**
   * THE CONTROL, and the reason the two tests above are not vacuous. The
   * identical activation, WITHOUT the teardown: everything the guard suppresses
   * must otherwise happen exactly once. Deleting the guard makes the two tests
   * above RED while this one stays green; breaking the harness makes THIS one
   * red. The pair can only both pass when the guard is present and working.
   */
  it('CONTROL: without the teardown the same activation registers exactly once and publishes its port', async () => {
    const { ctx, subscriptions } = makeFakeContext();
    let portsPublished = 0;

    const disposable = registerHermesAutocomplete(
      ctx,
      (msg: string) => host.failures.push(msg),
      () => {
        portsPublished += 1;
      },
    );
    const subscriptionsBefore = subscriptions.length;

    await flushAsync();

    expect(
      shell.registerCalls,
      'if this is 0 the harness is broken and the suppression tests above prove nothing',
    ).toBe(1);
    expect(portsPublished).toBe(1);
    expect(subscriptions.length).toBe(subscriptionsBefore + 1);
    expect(host.failures).toEqual([]);

    // And the live registration IS reachable by teardown — the disposable the
    // continuation stored is the one `dispose()` reaches, which is what makes
    // the torn-down case a genuine leak rather than a deferred cleanup.
    disposable.dispose();
    expect(shell.disposeCalls).toBe(1);
  });

  /**
   * Ordering, pinned separately: the guard is checked BEFORE the register call,
   * not compensated for afterwards by disposing what was just built. A
   * "register then immediately dispose" implementation would satisfy the leak
   * assertions above by accident while still having attached commands and
   * re-pointed the relay for the duration — and on the real shell, transiently
   * disarming R2 is the whole harm.
   */
  it('the torn-down activation never registers-then-disposes — it never registers at all', async () => {
    const { ctx } = makeFakeContext();

    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    disposable.dispose();

    await flushAsync();

    expect(shell.registerCalls).toBe(0);
    expect(
      shell.disposeCalls,
      'a dispose here would mean the shell HAD been constructed — the relay was re-pointed and the commands ' +
        'were registered, however briefly',
    ).toBe(0);
  });
});
