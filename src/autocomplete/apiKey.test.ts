import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickApiKey, shouldMigrateApiKey, shouldClearLegacyApiKeySetting } from './apiKey';

describe('pickApiKey', () => {
  it('prefers the SecretStorage value over the plaintext setting', () => {
    expect(pickApiKey('secret-key', 'setting-key')).toBe('secret-key');
  });

  it('falls back to the setting when no secret is present (legacy/back-compat)', () => {
    expect(pickApiKey(undefined, 'setting-key')).toBe('setting-key');
    expect(pickApiKey('', 'setting-key')).toBe('setting-key');
    expect(pickApiKey('   ', 'setting-key')).toBe('setting-key');
  });

  it('trims and returns undefined when neither is a real value', () => {
    expect(pickApiKey(undefined, undefined)).toBeUndefined();
    expect(pickApiKey('  ', '  ')).toBeUndefined();
  });

  it('trims the resolved value', () => {
    expect(pickApiKey('  padded  ', undefined)).toBe('padded');
  });
});

describe('shouldMigrateApiKey', () => {
  it('migrates when only the plaintext setting has a value', () => {
    expect(shouldMigrateApiKey(undefined, 'legacy')).toBe(true);
    expect(shouldMigrateApiKey('', 'legacy')).toBe(true);
  });

  it('does not migrate once a secret already exists', () => {
    expect(shouldMigrateApiKey('secret', 'legacy')).toBe(false);
  });

  it('does not migrate when there is no legacy setting', () => {
    expect(shouldMigrateApiKey(undefined, undefined)).toBe(false);
    expect(shouldMigrateApiKey(undefined, '   ')).toBe(false);
  });
});

describe('shouldClearLegacyApiKeySetting — the two-session migration gate', () => {
  // The plaintext setting is the user's only DURABLE copy until we have proof
  // the secret survived a process restart. `store()` resolving is NOT that
  // proof: on a keyring-less Linux session VS Code silently falls back to
  // in-memory storage, where store() succeeds and the value dies on quit.
  // The proof is a `secrets.get()` that returns the key on an activation where
  // migration did NOT run — that read can only come from persisted storage.
  it('does NOT clear in the session that migrated (the whole point)', () => {
    expect(
      shouldClearLegacyApiKeySetting('sk-legacy', 'sk-legacy', true),
      'clearing in the migrating session is the data-loss bug — store() resolving proves nothing',
    ).toBe(false);
  });

  it('CLEARS on a later session where the secret read back and migration did not run', () => {
    expect(shouldClearLegacyApiKeySetting('sk-legacy', 'sk-legacy', false)).toBe(true);
  });

  it('does NOT clear when the secret is absent — that is the failing case, and the setting is the survivor', () => {
    expect(
      shouldClearLegacyApiKeySetting(undefined, 'sk-legacy', false),
      'an absent secret means storage did not persist (or was destroyed by a decrypt failure) — the ' +
        'plaintext setting is now the ONLY copy and must never be deleted',
    ).toBe(false);
  });

  it('does NOT clear when there is no setting to clear', () => {
    expect(shouldClearLegacyApiKeySetting('sk-legacy', undefined, false)).toBe(false);
    expect(shouldClearLegacyApiKeySetting(undefined, undefined, false)).toBe(false);
  });

  it('treats whitespace-only as absent, exactly as pickApiKey does', () => {
    expect(shouldClearLegacyApiKeySetting('   ', 'sk-legacy', false)).toBe(false);
    expect(shouldClearLegacyApiKeySetting('sk-legacy', '   ', false)).toBe(false);
  });

  it('does NOT clear when the two values disagree — the setting holds something we never stored', () => {
    expect(
      shouldClearLegacyApiKeySetting('sk-from-secret', 'sk-different', false),
      'a setting holding a DIFFERENT value was not the thing we migrated; deleting it destroys data we ' +
        'never copied',
    ).toBe(false);
  });
});

// ───────────────────── the initApiKey call-site harness ──────────────────────

/**
 * ADR-017. The pure truth table above proves the DECISION; it cannot prove the
 * CALL SITE consults it. Restoring the pre-fix guard in `index.ts`
 * (`if (migratedThisSession || shouldClear...)`) leaves every test above green,
 * so these tests exist to close exactly that gap — and they were watched RED
 * against the real, unmodified shipped bug before the fix landed.
 *
 * `initApiKey` is module-private and `index.ts` has no test-only-export
 * precedent, so it is driven through the ONLY public entry point,
 * `registerHermesAutocomplete`, exactly as the extension host drives it.
 *
 * Spies are plain functions pushing into arrays, never `vi.fn()` — `vi.fn()`
 * swallows unhandled rejections, which is how a vacuous assertion gets built
 * (Global Constraints, "Test hygiene"; the shipped idiom is
 * `nextedit/guard.test.ts:18-32`).
 */
const host = {
  /** Backing store for `workspace.getConfiguration(section).get(key, dflt)`. */
  settings: new Map<string, unknown>(),
  /** Every `WorkspaceConfiguration.update` this activation performed, in order. */
  configUpdates: [] as { key: string; value: unknown }[],
  /** The `ConfigurationTarget` each of those updates named, same order. */
  configUpdateTargets: [] as unknown[],
  warnings: [] as string[],
  infos: [] as string[],
  /** The `apiKey` handed to `createBackend` on each (re)build, in order. The
   *  last entry is the effective key `initApiKey` resolved to, since the
   *  post-migration `rebuild()` is what feeds it. */
  backendApiKeys: [] as (string | undefined)[],
  /** Anything `reportFailure` logged — asserted to stay empty and key-free. */
  failures: [] as string[],
  /** FIX WAVE F-5: every `onDidChangeConfiguration` listener this activation
   *  registered, so a test can fire a real config change and observe the
   *  `rebuild()` it triggers. This is the ONLY seam through which
   *  `initApiKey`'s RETURN can be told apart from `pickApiKey`'s fallback to
   *  the setting — see the F-5 test's own doc comment. */
  configListeners: [] as ((e: { affectsConfiguration: (section: string) => boolean }) => void)[],
  /** FIX WAVE F-2: command handlers this activation registered, so the
   *  "clear my key" command can be driven exactly as the palette drives it. */
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /** What the next `showInputBox` resolves to. `undefined` = the user
   *  cancelled; `''`/whitespace = the documented "leave blank to clear". */
  inputBoxValue: undefined as string | undefined,
  /**
   * How `WorkspaceConfiguration.update` behaves, so the honest-toast paths are
   * reachable:
   *  - `'apply'`  — writes through to `host.settings` (a faithful fake).
   *  - `'throw'`  — rejects, e.g. a read-only `settings.json`.
   *  - `'silent'` — RESOLVES but the value stays put. This is the nastier
   *    shape: `apiKey` is machine-scoped, so a value living somewhere a
   *    Global update does not reach is still live in `pickApiKey` while the
   *    update reports success.
   */
  configUpdateMode: 'apply' as 'apply' | 'throw' | 'silent',
};

function resetHost(): void {
  host.settings.clear();
  host.configUpdates.length = 0;
  host.configUpdateTargets.length = 0;
  host.warnings.length = 0;
  host.infos.length = 0;
  host.backendApiKeys.length = 0;
  host.failures.length = 0;
  host.configListeners.length = 0;
  host.commands.clear();
  host.inputBoxValue = undefined;
  host.configUpdateMode = 'apply';
}

vi.mock('vscode', () => ({
  // Literals, not references to a module-scope const: this factory is hoisted
  // above every `const` in the file, so anything it evaluates EAGERLY would
  // hit the temporal dead zone. `host` above is safe only because it is read
  // lazily, from inside the closures below.
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      host.commands.set(id, handler);
      return { dispose() {} };
    },
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
    showInputBox: () => Promise.resolve(host.inputBoxValue),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, dflt: T): T =>
        host.settings.has(`${section}.${key}`) ? (host.settings.get(`${section}.${key}`) as T) : dflt,
      update: (key: string, value: unknown, target: unknown) => {
        host.configUpdates.push({ key, value });
        host.configUpdateTargets.push(target);
        if (host.configUpdateMode === 'throw') {
          return Promise.reject(new Error('settings.json is read-only'));
        }
        // F-2: `'apply'` writes through, so a later `get` sees the removal —
        // without that, code that VERIFIES its own clear could never be
        // distinguished from code that merely fires an update and hopes.
        if (host.configUpdateMode === 'apply') {
          if (value === undefined) host.settings.delete(`${section}.${key}`);
          else host.settings.set(`${section}.${key}`, value);
        }
        return Promise.resolve(undefined);
      },
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
 * The observation point for the effective key. `buildEngine` calls
 * `createBackend` once at activation (before the async key load resolves) and
 * again from `rebuild()` once it has — so the LAST recorded `apiKey` is what
 * `initApiKey` resolved to, fed through `pickApiKey` exactly as production
 * does.
 */
vi.mock('./backendFactory', () => ({
  createBackend: (cfg: { apiKey?: string }) => {
    host.backendApiKeys.push(cfg.apiKey);
    return {
      name: 'ollama',
      capabilities: { nativeFim: true, assemblesCrossFileServerSide: false, streaming: true },
      streamFim: () => {
        throw new Error('no completion is requested in these tests');
      },
    };
  },
  // T-6 F4/F6: `rebuild()` now calls this on every config change — a full
  // module mock (not `importOriginal`) must keep every named export the
  // real module has, same discipline as `createBackend` itself above.
  clearBackendFactoryWarnings: () => {},
}));

/**
 * Activation side-cars, stubbed because they wire large amounts of real
 * `vscode` listener surface that has nothing to do with the credential path.
 * The Guard itself is deliberately left REAL (it only needs a `Memento`), so
 * the activation sequence these tests drive is the production one.
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
  registerHermesNextEdit: () => ({ dispose() {} }),
  requestNextEditToggle: () => Promise.resolve({ next: false, generic: false }),
}));

import * as vscode from 'vscode';
import { registerHermesAutocomplete } from './index';

function makeFakeContext(options: {
  secrets: Map<string, string>;
  /** FIX WAVE F-4: makes `secrets.store` REJECT with this error — a keyring
   *  that is present but erroring, which `store()` resolving-or-not is the
   *  only signal of. Deliberately not `vi.fn().mockRejectedValue(...)`: this
   *  file's whole harness avoids `vi.fn()` because it swallows unhandled
   *  rejections, which is the exact failure mode F-4 is about. */
  storeRejects?: Error;
}): vscode.ExtensionContext {
  const globalStore = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: (key: string) => Promise.resolve(options.secrets.get(key)),
      store: (key: string, value: string) => {
        if (options.storeRejects) return Promise.reject(options.storeRejects);
        options.secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        options.secrets.delete(key);
        return Promise.resolve();
      },
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

/** Lets every pending microtask (the async key load and its `rebuild()`) run. */
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * One full activation against `settingValue` as the legacy plaintext setting.
 * Resolves to the effective API key the activation ended up using.
 */
async function initApiKeyForTest(
  ctx: vscode.ExtensionContext,
  settingValue: string | undefined,
): Promise<string | undefined> {
  host.settings.set('talaria.autocomplete.apiKey', settingValue ?? '');
  const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
  await flushAsync();
  disposable.dispose();
  return host.backendApiKeys[host.backendApiKeys.length - 1];
}

describe('initApiKey — the migrating session leaves the durable copy alone', () => {
  beforeEach(() => {
    resetHost();
  });

  it('session 1 stores the secret and does NOT update the configuration', async () => {
    const stored = new Map<string, string>();
    const ctx = makeFakeContext({ secrets: stored });

    const key = await initApiKeyForTest(ctx, 'sk-legacy');

    expect(key).toBe('sk-legacy');
    expect(stored.get('talaria.autocomplete.apiKey')).toBe('sk-legacy');
    expect(
      host.configUpdates,
      'DATA LOSS: clearing the plaintext setting in the migrating session destroys the only durable copy ' +
        'whenever SecretStorage silently fell back to in-memory',
    ).toEqual([]);
    // FIX WAVE F-1. The no-leak guard has to live HERE, on the empty-secrets
    // fixture, because this is the only test in which `shouldMigrateApiKey`
    // is true and the migration branch actually executes. Its sibling below
    // drives the CLEARING session, where the branch is skipped entirely — so
    // a key-bearing message added to the migration path itself was invisible
    // to the whole suite (proven: `showWarningMessage('… ' + legacy)` on that
    // branch stayed 17/17 green). Emptiness, not `.not.toContain`, for the
    // reason the sibling's doc comment gives: only emptiness can fail.
    expect(host.warnings, 'the migration path must surface nothing — no message can carry the key').toEqual(
      [],
    );
    expect(host.infos).toEqual([]);
    expect(host.failures).toEqual([]);
  });

  it('session 2 — the secret read back without migrating — clears the setting', async () => {
    const stored = new Map([['talaria.autocomplete.apiKey', 'sk-legacy']]);
    const ctx = makeFakeContext({ secrets: stored });

    await initApiKeyForTest(ctx, 'sk-legacy');

    expect(host.configUpdates).toEqual([{ key: 'apiKey', value: undefined }]);
    // `toEqual` treats an absent property and an `undefined` one alike, so the
    // strict form pins that the setting is REMOVED (`undefined`) rather than
    // blanked to `''`, which would leave a dead entry in settings.json.
    expect(host.configUpdates).toHaveLength(1);
    expect(host.configUpdates[0]).toStrictEqual({ key: 'apiKey', value: undefined });
    expect(
      host.configUpdateTargets,
      'the legacy key is user/global-scoped — clearing it anywhere else would leave it in place',
    ).toEqual([vscode.ConfigurationTarget.Global]);
  });

  it('the in-memory-fallback shape: store() resolved but the secret is gone next session ⇒ setting SURVIVES', async () => {
    // Session 2 on a keyring-less box: nothing persisted, so `get` finds nothing.
    const stored = new Map<string, string>();
    const ctx = makeFakeContext({ secrets: stored });

    const key = await initApiKeyForTest(ctx, 'sk-legacy');

    expect(key, 'the plaintext setting is now the only copy and must still work').toBe('sk-legacy');
    expect(
      host.configUpdates,
      'this is the exact scenario the bug destroyed the key in — the setting must never be cleared here',
    ).toEqual([]);
  });

  /**
   * Asserted as "surfaces NOTHING", not as "nothing surfaced contains the
   * key". The `.not.toContain` form alone would be VACUOUS here — this path
   * emits no messages at all, so a loop over them never runs a body and would
   * stay green even if the key were interpolated into a message that this
   * path does not currently emit. Emptiness is the claim that can actually
   * fail: any messaging added to the credential path — with or without the
   * key in it — turns this red and forces a deliberate look.
   *
   * FIX WAVE F-1: retitled. This fixture PRE-POPULATES the secret, so
   * `shouldMigrateApiKey` is false and the migration branch never runs here —
   * the session under test is the CLEARING one. The migrating session's own
   * no-leak guard lives on the empty-secrets test above, where the branch
   * actually executes.
   */
  it('surfaces and logs nothing at all on the clearing session (so no message can carry the key)', async () => {
    const stored = new Map([['talaria.autocomplete.apiKey', 'sk-legacy']]);
    const ctx = makeFakeContext({ secrets: stored });

    await initApiKeyForTest(ctx, 'sk-legacy');

    expect(host.warnings).toEqual([]);
    expect(host.infos).toEqual([]);
    expect(host.failures).toEqual([]);
  });

  /**
   * FIX WAVE F-5. The session-1 test's `expect(key).toBe('sk-legacy')` cannot
   * observe what it appears to. `key` is read off `createBackend`, i.e. out
   * of `pickApiKey(secretApiKey, cfg.apiKey)` — and on the migration path the
   * setting holds that very same value, so deleting `effective = legacy` from
   * `initApiKey` leaves it GREEN (proven): the return silently becomes
   * `undefined` and the setting fallback covers for it.
   *
   * Separating the two means taking the setting away and rebuilding. That is
   * not a contrived probe — it is exactly what the NEXT session does when
   * `shouldClearLegacyApiKeySetting` fires, what the "clear my key" command
   * now does (F-2), and what a user does by hand-deleting the deprecated
   * setting with the window open. The key has to survive it, and the only
   * place it can survive is the value `initApiKey` returned.
   */
  it('the migrated key lives in the activation, not the setting — it survives the setting being removed', async () => {
    const stored = new Map<string, string>();
    const ctx = makeFakeContext({ secrets: stored });
    host.settings.set('talaria.autocomplete.apiKey', 'sk-legacy');

    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();

    host.settings.set('talaria.autocomplete.apiKey', '');
    expect(
      host.configListeners,
      'no captured listener would make every assertion below vacuous',
    ).toHaveLength(1);
    for (const listener of host.configListeners) listener({ affectsConfiguration: () => true });
    await flushAsync();
    disposable.dispose();

    expect(
      host.backendApiKeys[host.backendApiKeys.length - 1],
      'with no setting left to fall back to, the ONLY source for this value is what initApiKey returned',
    ).toBe('sk-legacy');
  });

  /**
   * FIX WAVE F-4. `void initApiKey(...).then(onFulfilled)` carried NO
   * rejection arm, so a rejecting `secrets.store` produced an unhandled
   * rejection and the user was told nothing. The suite was blind to it: an
   * injected `throw` after the store left all 17 tests PASSING (vitest's
   * unhandled-error reporter set exit 1, but no assertion anywhere named the
   * behaviour, and a reporter-level signal is not a regression test).
   *
   * The injected error deliberately embeds the key, so the `.not.toContain`
   * below is non-vacuous — `host.failures[0]` is pinned to exist by the
   * length assertion first, and an arm that echoed `String(err)` would ship
   * the credential straight into the `Hermes` output channel.
   */
  it('reports a rejecting SecretStorage by kind — never unhandled, never echoing the error text', async () => {
    const stored = new Map<string, string>();
    const ctx = makeFakeContext({
      secrets: stored,
      storeRejects: new Error('keyring refused to store sk-legacy'),
    });

    const key = await initApiKeyForTest(ctx, 'sk-legacy');

    expect(host.failures, 'a swallowed rejection tells the user nothing at all').toHaveLength(1);
    expect(host.failures[0]).toContain('SecretStorage');
    expect(
      host.failures[0],
      'an error raised by store(key, value) can carry the VALUE in its message — reporting it by kind is ' +
        'the only form that cannot leak the credential into the output channel',
    ).not.toContain('sk-legacy');
    expect(
      key,
      'fail-safe: the legacy setting still feeds pickApiKey, so autocomplete keeps working',
    ).toBe('sk-legacy');
  });
});

/**
 * FIX WAVE F-2 (a regression the two-session migration introduced) and F-3.
 *
 * Blank input used to delete the secret and toast *"cleared"* while leaving
 * the legacy plaintext setting untouched — so `pickApiKey` fell straight back
 * to it and the next activation MIGRATED it back into SecretStorage. Before
 * the two-session change that window was ~0; afterwards it is at least one
 * session, and PERMANENT on the keyring-less box ADR-017 exists to protect:
 * there the secret never reads back, so the clearing session never arrives
 * and the plaintext key stays forever.
 *
 * The chosen behaviour: **"clear" removes the key from everywhere this
 * command can reach — the secret AND the legacy plaintext setting — and the
 * toast never claims a removal that was not confirmed.**
 *
 * ADR-017's caution does not transfer, in either half. Its two-session rule
 * protects the user's only durable copy through an AUTOMATIC, unrequested
 * migration; here the user is explicitly asking to hold no key, so preserving
 * a durable copy is the opposite of the request. Its `secret === setting`
 * agreement check exists so the automatic path never deletes data it did not
 * itself copy; a value the user is deleting on purpose needs no such
 * protection — which is also what closes F-3, the standing hole where a
 * plaintext value DIFFERING from the secret was unclearable by any path.
 *
 * The SAVE branch is deliberately left alone: clearing the plaintext setting
 * in the same session that stores a new secret is precisely the same-session
 * delete ADR-017's rule for successors forbids, since the replacement has not
 * been proven to survive a restart.
 */
describe('the "clear my key" command leaves no key anywhere it can reach', () => {
  beforeEach(() => {
    resetHost();
  });

  /**
   * Activates, then drives the registered command exactly as the palette
   * does. The secrets fixture is empty and the setting present, i.e. the
   * keyring-less session-1 shape — the state in which the old behaviour was
   * permanently wrong.
   */
  async function activateThenRunClearCommand(options: {
    secrets: Map<string, string>;
    setting: string;
    input: string;
  }): Promise<void> {
    host.settings.set('talaria.autocomplete.apiKey', options.setting);
    const ctx = makeFakeContext({ secrets: options.secrets });
    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();
    // Only the command's own messages should be asserted below.
    host.infos.length = 0;
    host.warnings.length = 0;
    const handler = host.commands.get('talaria.setAutocompleteApiKey');
    expect(
      typeof handler,
      'an unregistered command would make every assertion below vacuous',
    ).toBe('function');
    host.inputBoxValue = options.input;
    await handler!();
    disposable.dispose();
  }

  it('deletes the secret AND the lingering plaintext setting, then reports success', async () => {
    const stored = new Map<string, string>();

    await activateThenRunClearCommand({ secrets: stored, setting: 'sk-legacy', input: '' });

    expect(stored.has('talaria.autocomplete.apiKey'), 'the secret must be gone').toBe(false);
    expect(
      host.settings.get('talaria.autocomplete.apiKey'),
      'REGRESSION: a surviving plaintext setting is a live key — pickApiKey falls back to it and the next ' +
        'activation re-migrates it into SecretStorage, so the user was told "cleared" and still has a key',
    ).toBeUndefined();
    expect(host.infos).toEqual(['Talaria: autocomplete API key cleared.']);
    expect(host.warnings).toEqual([]);
  });

  it('cancelling (Escape, not a blank line) still touches nothing', async () => {
    const stored = new Map([['talaria.autocomplete.apiKey', 'sk-secret']]);

    host.settings.set('talaria.autocomplete.apiKey', 'sk-legacy');
    const ctx = makeFakeContext({ secrets: stored });
    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();
    host.configUpdates.length = 0;
    host.inputBoxValue = undefined;
    await host.commands.get('talaria.setAutocompleteApiKey')!();
    disposable.dispose();

    expect(stored.get('talaria.autocomplete.apiKey')).toBe('sk-secret');
    expect(host.configUpdates, 'a cancelled prompt must not clear anything').toEqual([]);
  });

  it('F-3: clears a plaintext setting whose value DIFFERS from the secret (no other path can)', async () => {
    const stored = new Map([['talaria.autocomplete.apiKey', 'sk-secret']]);

    await activateThenRunClearCommand({ secrets: stored, setting: 'sk-different', input: '' });

    expect(
      host.settings.get('talaria.autocomplete.apiKey'),
      'the automatic path refuses this forever (values disagree), so an H1-class plaintext credential ' +
        'would otherwise persist with no way for the user to be rid of it',
    ).toBeUndefined();
    expect(host.infos).toEqual(['Talaria: autocomplete API key cleared.']);
  });

  it('does NOT claim success when clearing the setting throws', async () => {
    const stored = new Map<string, string>();
    host.configUpdateMode = 'throw';

    await activateThenRunClearCommand({ secrets: stored, setting: 'sk-legacy', input: '   ' });

    expect(stored.has('talaria.autocomplete.apiKey'), 'the secret half did succeed').toBe(false);
    expect(
      host.infos,
      'telling the user "cleared" while a live plaintext key remains is exactly the lie F-2 removes',
    ).toEqual([]);
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toContain('talaria.autocomplete.apiKey');
    expect(
      host.warnings[0],
      'the warning names the SETTING to remove, never its value',
    ).not.toContain('sk-legacy');
  });

  it('does NOT claim success when the update resolves but the value is still there', async () => {
    const stored = new Map<string, string>();
    host.configUpdateMode = 'silent';

    await activateThenRunClearCommand({ secrets: stored, setting: 'sk-legacy', input: '' });

    expect(
      host.infos,
      'a resolving update is not proof of removal — the value is machine-scoped and may live somewhere a ' +
        'Global update cannot reach, which is the same "resolving call proves nothing" trap as ADR-017',
    ).toEqual([]);
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).not.toContain('sk-legacy');
  });

  it('writes no setting update at all when there is no plaintext value to clear', async () => {
    const stored = new Map([['talaria.autocomplete.apiKey', 'sk-secret']]);

    await activateThenRunClearCommand({ secrets: stored, setting: '', input: '' });

    expect(
      host.configUpdates,
      'nothing to clear must not provoke a pointless write into the user settings.json',
    ).toEqual([]);
    expect(host.infos).toEqual(['Talaria: autocomplete API key cleared.']);
  });
});

/**
 * FINAL REVIEW — FINDING 2. The SAVE branch of `promptAndStoreApiKey`
 * (`index.ts:419-420`) had ZERO tests, at the one site in the whole codebase
 * where the raw key is in scope on the line above a user-visible toast.
 *
 * The security lens replaced the constant message with
 * `` `Hermes: saved ${value.trim()}` `` — the raw API key interpolated into a
 * notification, which persists in the Notifications centre AND the window log
 * — and the full suite stayed GREEN.
 *
 * Every sibling branch was already guarded and none of them reached here: the
 * migration path asserts its message collections are EMPTY (it emits nothing),
 * the clear branch pins its exact string, the update-failure branch pins its
 * warning. The save branch is the only one that both emits a message and holds
 * the credential, and it was the only unguarded one.
 *
 * The control itself is correct today and always was — a frozen constant. What
 * was missing is its PROOF, which is the exact class this wave exists to close:
 * "never log or surface a key value" is a Global Constraint, and a constraint
 * whose violation ships green is a comment, not a constraint.
 *
 * ASSERTION SHAPE. `toEqual` on the whole array, not `.not.toContain(key)`:
 *  - equality pins the message CHARACTER-FOR-CHARACTER, so ANY interpolation
 *    — the key, a path, a URL, an error body — goes red, not just the one
 *    mutation the lens happened to write;
 *  - it simultaneously pins the COUNT, so a second toast added beside it is
 *    caught too;
 *  - and the array is non-empty in the passing case, so the assertion is
 *    reachable. A `.not.toContain` over a collection that could legally be
 *    empty is the vacuous shape this file's own F-1 note already records.
 *
 * The credential fixture is a distinctive literal that appears in no other
 * string on this path, so the belt-and-braces scan below cannot be satisfied
 * by accident.
 */
describe('FINDING 2: the SAVE branch stores the key and NEVER puts it in a message', () => {
  beforeEach(() => {
    resetHost();
  });

  /**
   * Activates, then drives `talaria.setAutocompleteApiKey` with a NON-EMPTY
   * input — the save path, exactly as the palette drives it. Messages emitted
   * during activation itself are cleared first so only the command's own
   * output is asserted.
   */
  async function activateThenSaveKey(options: {
    secrets: Map<string, string>;
    setting: string;
    input: string;
  }): Promise<void> {
    host.settings.set('talaria.autocomplete.apiKey', options.setting);
    const ctx = makeFakeContext({ secrets: options.secrets });
    const disposable = registerHermesAutocomplete(ctx, (msg: string) => host.failures.push(msg));
    await flushAsync();
    host.infos.length = 0;
    host.warnings.length = 0;
    host.configUpdates.length = 0;
    const handler = host.commands.get('talaria.setAutocompleteApiKey');
    expect(
      typeof handler,
      'an unregistered command would make every assertion below vacuous',
    ).toBe('function');
    host.inputBoxValue = options.input;
    await handler!();
    disposable.dispose();
  }

  it('stores the key in SecretStorage and reports success with a CONSTANT message', async () => {
    const stored = new Map<string, string>();

    await activateThenSaveKey({ secrets: stored, setting: '', input: 'sk-brand-new-value' });

    expect(stored.get('talaria.autocomplete.apiKey'), 'the key must reach the OS keychain').toBe(
      'sk-brand-new-value',
    );
    expect(
      host.infos,
      'SECURITY: this message is one line below the raw key. Interpolating it here persists the credential ' +
        'in the Notifications centre and the window log — exact equality is what makes that go red',
    ).toEqual(['Talaria: autocomplete API key saved to SecretStorage.']);
    expect(host.warnings).toEqual([]);
    expect(host.failures).toEqual([]);
  });

  it('no message or log line emitted by the save path contains the key, in any form', async () => {
    const stored = new Map<string, string>();

    await activateThenSaveKey({ secrets: stored, setting: '', input: '  sk-brand-new-value  ' });

    // Reach: the scan below iterates a collection that MUST be non-empty in
    // the passing case, or it would prove nothing. The save path emits exactly
    // one message, so this is 1 — pinned, not assumed.
    const surfaced = [...host.infos, ...host.warnings, ...host.failures];
    expect(surfaced, 'a scan over an empty collection passes forever').toHaveLength(1);
    for (const message of surfaced) {
      expect(message, 'the raw key must never appear in a surfaced message').not.toContain(
        'sk-brand-new-value',
      );
      expect(message, 'nor the untrimmed form the user actually typed').not.toContain(
        '  sk-brand-new-value  ',
      );
    }
  });

  it('trims the typed value before storing (padding must not become part of the credential)', async () => {
    const stored = new Map<string, string>();

    await activateThenSaveKey({ secrets: stored, setting: '', input: '  sk-brand-new-value\t' });

    expect(stored.get('talaria.autocomplete.apiKey')).toBe('sk-brand-new-value');
  });

  /**
   * ADR-017's successor rule, pinned on the branch it governs. `index.ts`'s
   * own comment states the save branch is "deliberately NOT given the same
   * treatment" as the clear branch: clearing the plaintext setting in the same
   * session that stores a new secret is exactly the same-session delete the
   * rule forbids, because the replacement has not been proven to survive a
   * restart. On a keyring-less box that delete would destroy the user's only
   * durable copy — the identical data-loss shape the two-session migration
   * exists to prevent.
   */
  it('leaves the legacy plaintext setting ALONE — a same-session delete is the ADR-017 data-loss shape', async () => {
    const stored = new Map<string, string>();

    await activateThenSaveKey({ secrets: stored, setting: 'sk-legacy', input: 'sk-brand-new-value' });

    expect(
      host.configUpdates,
      'the new secret has not been proven to survive a restart, so the durable copy must stay',
    ).toEqual([]);
    expect(host.settings.get('talaria.autocomplete.apiKey')).toBe('sk-legacy');
  });
});
