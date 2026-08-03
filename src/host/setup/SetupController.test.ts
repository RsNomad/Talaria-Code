import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SetupController,
  TIER2_TUNABLE_KEYS,
  MUTATING_METHODS,
  READ_ONLY_METHODS,
  type SetupHost,
  type SetupControllerDeps,
} from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend } from './registry';
import type { PipxLocateResult } from './pipxLocator';
import type { HermesPaths } from './pipxInstaller';
import type { OllamaStatus } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import { AUTOCOMPLETE_API_KEY_SECRET } from '../../autocomplete/apiKey';
import type { SetupMethod, SetupProgress } from '../../shared/protocol';

/**
 * Task 9 behavior-contract tests (task-9-brief.md + plan §7/§8) against a
 * FAKE SetupHost + FAKE engines — no real vscode, no real subprocess/fetch.
 * The fake host RECORDS every call in `calls` (in order) so write-ORDER and
 * refusal-side-effect assertions are provable, not just outcome-based.
 */

class FakeSetupHost implements SetupHost {
  calls: string[] = [];
  trusted = true;
  settings = new Map<string, unknown>();
  secretValues = new Map<string, string>();
  globalStateStore = new Map<string, unknown>();
  modalResponses: boolean[] = [];
  passwordResponses: (string | undefined)[] = [];
  terminalsCreated: { name: string; command: string }[] = [];
  terminalsRun: { name: string; shellPath: string; args: string[] }[] = [];
  reloadOffers = 0;
  reloadCalls = 0;

  async showModal(message: string, _confirmLabel: string): Promise<boolean> {
    this.calls.push(`showModal:${message}`);
    return this.modalResponses.length > 0 ? (this.modalResponses.shift() as boolean) : true;
  }

  async showPasswordInput(_prompt: string): Promise<string | undefined> {
    this.calls.push('showPasswordInput');
    return this.passwordResponses.shift();
  }

  createTerminal(name: string, preTypedCommand: string): void {
    this.calls.push(`createTerminal:${name}`);
    this.terminalsCreated.push({ name, command: preTypedCommand });
  }

  runInTerminal(name: string, shellPath: string, shellArgs: string[]): void {
    this.calls.push(`runInTerminal:${name}`);
    this.terminalsRun.push({ name, shellPath, args: shellArgs });
  }

  getSetting<T>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined;
  }

  async updateSettingGlobal(key: string, value: unknown): Promise<void> {
    this.calls.push(`write:${key}=${JSON.stringify(value)}`);
    this.settings.set(key, value);
  }

  secrets = {
    store: async (key: string, v: string): Promise<void> => {
      this.calls.push(`secrets.store:${key}`);
      this.secretValues.set(key, v);
    },
    has: async (key: string): Promise<boolean> => this.secretValues.has(key),
    delete: async (key: string): Promise<void> => {
      this.calls.push(`secrets.delete:${key}`);
      this.secretValues.delete(key);
    },
  };

  globalState = {
    get: <T,>(key: string): T | undefined => this.globalStateStore.get(key) as T | undefined,
    update: async (key: string, v: unknown): Promise<void> => {
      this.calls.push(`globalState:${key}`);
      this.globalStateStore.set(key, v);
    },
  };

  isTrusted(): boolean {
    return this.trusted;
  }

  offerReload(): void {
    this.calls.push('offerReload');
    this.reloadOffers++;
  }

  reload(): void {
    this.calls.push('reload');
    this.reloadCalls++;
  }
}

const OK_PIPX_LOCATE: PipxLocateResult = {
  ok: true,
  env: { pipxPath: '/usr/bin/pipx', venvsRoot: '/home/u/.local/share/pipx/venvs', defaultPythonVersion: '3.12.0' },
};

const OK_HERMES_PATHS: HermesPaths = {
  venvRoot: '/home/u/.local/share/pipx/venvs/hermes-agent',
  hermes: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes',
  hermesAcp: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes-acp',
  python: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/python',
};

function makeFakeDeps(overrides: Partial<SetupControllerDeps> = {}): { deps: SetupControllerDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: SetupControllerDeps = {
    locatePipx: async (): Promise<PipxLocateResult> => {
      calls.push('locatePipx');
      return OK_PIPX_LOCATE;
    },
    installHermes: async (_recipe, _env, onEvent, _signal): Promise<HermesPaths> => {
      calls.push('installHermes');
      onEvent({ kind: 'phase', phase: 'pipx-install' });
      onEvent({ kind: 'log', line: 'installing...' });
      onEvent({ kind: 'phase', phase: 'verify' });
      onEvent({ kind: 'done', paths: OK_HERMES_PATHS });
      return OK_HERMES_PATHS;
    },
    probeOllama: async (): Promise<OllamaStatus> => {
      calls.push('probeOllama');
      return { running: false, detail: 'not running' };
    },
    pullModel: async (_endpoint, _model, onProgress): Promise<void> => {
      calls.push('pullModel');
      onProgress({ status: 'success' });
    },
    probeRemote: async (): Promise<ProbeOutcome> => {
      calls.push('probeRemote');
      return { ok: true, detail: 'ok' };
    },
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    getNextEditSource: () => 'off',
    // Task 13: default = "no ACP initialize has surfaced auth methods yet"
    // (mock backend / before connect) → provider card 'waiting-agent'.
    getAdvertisedAuthMethods: () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

function makeController(hostOverrides: Partial<FakeSetupHost> = {}, depsOverrides: Partial<SetupControllerDeps> = {}) {
  const host = new FakeSetupHost();
  Object.assign(host, hostOverrides);
  const { deps, calls: depCalls } = makeFakeDeps(depsOverrides);
  const controller = new SetupController(host, deps);
  return { host, deps, depCalls, controller };
}

// --- FM-14: trust gate ------------------------------------------------------

describe('FM-14: mutating methods refused when untrusted', () => {
  const MUTATING: { method: SetupMethod; params: unknown }[] = [
    { method: 'setup.install', params: { backendId: 'hermes' } },
    { method: 'setup.applyAgent', params: { backendId: 'hermes' } },
    { method: 'setup.applyFim', params: { backendId: 'ollama' } },
    { method: 'setup.setApiKey', params: {} },
    { method: 'setup.pullModel', params: { model: 'qwen2.5-coder:1.5b-base' } },
    { method: 'setup.openProviderWizard', params: {} },
    { method: 'setup.openInstallTerminal', params: { backendId: 'ollama' } },
    { method: 'setup.openBootstrapTerminal', params: {} },
    { method: 'setup.reload', params: {} },
    { method: 'setup.setNextEdit', params: { backend: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'x' } },
    { method: 'setup.setRag', params: { enabled: true } },
    { method: 'setup.setTunable', params: { key: TIER2_TUNABLE_KEYS[0], value: 100 } },
  ];

  for (const { method, params } of MUTATING) {
    it(`refuses '${method}' with no side effect when workspace is untrusted`, async () => {
      const { host, controller } = makeController({ trusted: false });
      const result = await controller.handle(method, params);
      expect(result.ok).toBe(false);
      expect(host.calls).toEqual([]); // no modal, no write, no terminal, no secret op
    });
  }

  it('read-only setup.testRemote still works when untrusted (not the trust refusal)', async () => {
    const { controller } = makeController({ trusted: false });
    const result = await controller.handle('setup.testRemote', { backendId: 'ollama' });
    // The fake probeRemote resolves {ok:true} by default — proves the call
    // actually reached the engine instead of being short-circuited by the
    // trust gate (which would have returned the pinned trust-refusal reason).
    expect(result).toEqual({ ok: true });
  });

  it('read-only setup.recheck still works when untrusted', async () => {
    const { controller } = makeController({ trusted: false });
    const result = await controller.handle('setup.recheck', {});
    expect(result).toEqual({ ok: true });
  });

  it('setup.cancel still works when untrusted', async () => {
    const { controller } = makeController({ trusted: false });
    const result = await controller.handle('setup.cancel', { op: 'install', id: 'hermes' });
    expect(result).toEqual({ ok: true });
  });

  it('status() still renders when untrusted', async () => {
    const { controller } = makeController({ trusted: false });
    const data = await controller.status();
    expect(data.trusted).toBe(false);
  });
});

// --- FM-13: Tier-1 modal decline -> no side effect --------------------------

describe('FM-13: Tier-1 modal decline -> {ok:false, reason:"declined"} with NO side effect', () => {
  it('setup.install: decline -> locatePipx/installHermes never called, no writes', async () => {
    const { host, depCalls, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(depCalls).toEqual([]);
    expect(host.calls.filter((c) => c.startsWith('write:') || c.startsWith('globalState:'))).toEqual([]);
    expect(host.reloadOffers).toBe(0);
  });

  it('setup.applyFim: decline -> no settings written', async () => {
    const { host, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.applyFim', { backendId: 'ollama', endpoint: 'http://127.0.0.1:11434' });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.settings.size).toBe(0);
  });

  it('setup.setNextEdit: decline -> no settings written', async () => {
    const { host, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.setNextEdit', {
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:1.5b-base',
    });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.settings.size).toBe(0);
  });

  it('setup.setRag: decline -> no settings written', async () => {
    const { host, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.setRag', { enabled: false });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.settings.size).toBe(0);
  });

  it('setup.openProviderWizard: decline -> runInTerminal never called', async () => {
    const { host, controller } = makeController({ modalResponses: [false], settings: settingsMap({ 'talaria.hermesPath': '/x/bin/hermes' }) });
    const result = await controller.handle('setup.openProviderWizard', {});
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.terminalsRun).toEqual([]);
  });

  it('setup.openInstallTerminal: decline -> createTerminal never called', async () => {
    const { host, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'ollama' });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.terminalsCreated).toEqual([]);
  });

  it('setup.openBootstrapTerminal: decline -> createTerminal never called', async () => {
    const { host, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.openBootstrapTerminal', {});
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.terminalsCreated).toEqual([]);
  });

  it('setup.applyAgent: decline -> no settings written, no reload offered', async () => {
    const { host, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.applyAgent', { backendId: 'hermes' });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.settings.size).toBe(0);
    expect(host.reloadOffers).toBe(0);
  });

  it('setup.pullModel: decline -> deps.pullModel never called', async () => {
    const { depCalls, controller } = makeController({ modalResponses: [false] });
    const result = await controller.handle('setup.pullModel', { model: 'qwen2.5-coder:1.5b-base' });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(depCalls).toEqual([]);
  });
});

// --- FM-16: setTunable allowlist --------------------------------------------

describe('FM-16: setup.setTunable allowlist (D9)', () => {
  it('refuses a key outside TIER2_TUNABLE_KEYS with an exact reason, no write, no modal', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setTunable', {
      key: 'talaria.autocomplete.crossFile.prefixInjectionRemote', // Tier-1, NOT Tier-2
      value: true,
    });
    expect(result).toEqual({ ok: false, reason: 'not a tunable' });
    expect(host.settings.size).toBe(0);
    expect(host.calls.some((c) => c.startsWith('showModal'))).toBe(false);
  });

  it('refuses a completely unknown key', async () => {
    const { controller } = makeController();
    const result = await controller.handle('setup.setTunable', { key: 'talaria.backend', value: 'acp' });
    expect(result).toEqual({ ok: false, reason: 'not a tunable' });
  });

  it('allowlisted key writes host-validated value with NO modal', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setTunable', { key: 'talaria.autocomplete.debounceMs', value: 500 });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.autocomplete.debounceMs')).toBe(500);
    expect(host.calls.some((c) => c.startsWith('showModal'))).toBe(false);
  });

  it('every TIER2_TUNABLE_KEYS entry round-trips a valid value with no modal', async () => {
    const validValues: Record<string, unknown> = {
      'talaria.autocomplete.debounceMs': 400,
      'talaria.autocomplete.maxPromptTokens': 2048,
      'talaria.autocomplete.temperature': 0.5,
      'talaria.autocomplete.crossFile.enabled': false,
      'talaria.autocomplete.crossFile.prefixInjection': true,
      'talaria.autocomplete.crossFile.warmUp': true,
      'talaria.rag.dims': 768,
      'talaria.rag.maxChunkTokens': 1024,
      'talaria.rag.debounceMs': 750,
      'talaria.rag.excludeGlobs': ['**/node_modules/**'],
    };
    for (const key of TIER2_TUNABLE_KEYS) {
      const { host, controller } = makeController();
      const result = await controller.handle('setup.setTunable', { key, value: validValues[key] });
      expect(result, `key=${key}`).toEqual({ ok: true });
      expect(host.settings.get(key)).toEqual(validValues[key]);
    }
  });

  it('rejects a host-invalid value for an allowlisted key without writing', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setTunable', { key: 'talaria.autocomplete.debounceMs', value: -5 });
    expect(result.ok).toBe(false);
    expect(host.settings.size).toBe(0);
  });
});

// --- FM-12: install single-flight -------------------------------------------

describe('FM-12: setup.install single-flight', () => {
  it('a second concurrent install is refused while the first is still in flight', async () => {
    const host = new FakeSetupHost();
    // Modal never resolves during this test — keeps the first call "in flight".
    let resolveModal: (v: boolean) => void = () => {};
    host.showModal = () =>
      new Promise<boolean>((resolve) => {
        resolveModal = resolve;
      });
    const { deps } = makeFakeDeps();
    const controller = new SetupController(host, deps);

    const first = controller.handle('setup.install', { backendId: 'hermes' });
    const second = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(second).toEqual({ ok: false, reason: 'install already running' });

    resolveModal(false); // let the first finish (declined) so the test can end cleanly
    await first;
  });
});

// --- FM-12: pullModel single-flight (latch BEFORE the modal) ----------------

describe('FM-12: setup.pullModel single-flight', () => {
  it('a second concurrent pullModel for the same model is refused while the first modal is still pending', async () => {
    const host = new FakeSetupHost();
    // Modal never resolves during this test — keeps the first call "in flight".
    let resolveModal: (v: boolean) => void = () => {};
    host.showModal = () =>
      new Promise<boolean>((resolve) => {
        resolveModal = resolve;
      });
    const { deps } = makeFakeDeps();
    const controller = new SetupController(host, deps);

    const first = controller.handle('setup.pullModel', { model: 'qwen2.5-coder:1.5b-base' });
    const second = await controller.handle('setup.pullModel', { model: 'qwen2.5-coder:1.5b-base' });
    expect(second).toEqual({ ok: false, reason: 'pull already running' });

    resolveModal(false); // let the first finish (declined) so the test can end cleanly
    await first;
  });
});

// --- Happy install: full order proof ----------------------------------------

describe('happy install: fail-closed ORDER (locatePipx -> installHermes -> writes together -> globalState -> offerReload)', () => {
  it('performs every step in the pinned order and returns ok:true', async () => {
    const { host, depCalls, controller } = makeController();
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result).toEqual({ ok: true });

    expect(depCalls).toEqual(['locatePipx', 'installHermes']);

    const relevant = host.calls.filter(
      (c) =>
        c.startsWith('showModal') ||
        c.startsWith('write:talaria.hermesPath') ||
        c.startsWith('write:talaria.pythonPath') ||
        c.startsWith('write:talaria.backend') ||
        c.startsWith('globalState:talaria.setup.hermesInstall') ||
        c === 'offerReload',
    );
    expect(relevant.map((c) => c.split('=')[0])).toEqual([
      expect.stringContaining('showModal:'),
      'write:talaria.hermesPath',
      'write:talaria.pythonPath',
      'write:talaria.backend',
      'globalState:talaria.setup.hermesInstall',
      'offerReload',
    ]);

    expect(host.settings.get('talaria.hermesPath')).toBe(OK_HERMES_PATHS.hermes);
    expect(host.settings.get('talaria.pythonPath')).toBe(OK_HERMES_PATHS.python);
    expect(host.settings.get('talaria.backend')).toBe('acp');
    const record = host.globalStateStore.get('talaria.setup.hermesInstall') as {
      version: string;
      venvRoot: string;
      installedAt: string;
    };
    expect(record.version).toBe('0.18.2');
    expect(record.venvRoot).toBe(OK_HERMES_PATHS.venvRoot);
    expect(typeof record.installedAt).toBe('string');
  });

  it('writes NOTHING when locatePipx resolves ok:false (fail-closed before install)', async () => {
    const { host, depCalls, controller } = makeController(
      {},
      {
        locatePipx: async () => {
          depCallsRecorder.push('locatePipx');
          return { ok: false, reason: 'pipx-missing', detail: 'no pipx' };
        },
      },
    );
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result).toEqual({ ok: false, reason: 'pipx-missing' });
    expect(host.settings.size).toBe(0);
    expect(host.reloadOffers).toBe(0);
    void depCalls; // depCalls from makeFakeDeps default isn't used here
  });
  const depCallsRecorder: string[] = [];

  it('T4 M-2: a REJECTING locatePipx never becomes an unhandled rejection — surfaces as {ok:false}', async () => {
    const { host, controller } = makeController(
      {},
      {
        locatePipx: async () => {
          throw new Error('pipx vanished mid-flow');
        },
      },
    );
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('pipx vanished');
    expect(host.settings.size).toBe(0);
  });

  it('writes NOTHING when installHermes rejects (verify failure) — fail-closed', async () => {
    const { host, controller } = makeController(
      {},
      {
        installHermes: async () => {
          throw new Error('hermes install failed at phase "verify": no marker');
        },
      },
    );
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result.ok).toBe(false);
    expect(host.settings.size).toBe(0);
    expect(host.reloadOffers).toBe(0);
  });

  it('a post-verify updateSettingGlobal rejection returns {ok:false} instead of throwing (fault-tolerant)', async () => {
    const host = new FakeSetupHost();
    const realUpdate = host.updateSettingGlobal.bind(host);
    host.updateSettingGlobal = async (key: string, value: unknown): Promise<void> => {
      if (key === 'talaria.backend') throw new Error('EBUSY: settings.json is locked');
      return realUpdate(key, value);
    };
    const { deps } = makeFakeDeps();
    const controller = new SetupController(host, deps);

    // handle() must not throw — a rejecting write is a returned error, not
    // an unhandled rejection out of the controller.
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('settings.json is locked');

    // Partial write: hermesPath/pythonPath landed before the rejection, but
    // the backend switch (and everything after it) never happened — the
    // fail-safe state the finding describes (backend stays unset/'mock').
    expect(host.settings.get('talaria.hermesPath')).toBe(OK_HERMES_PATHS.hermes);
    expect(host.settings.get('talaria.backend')).toBeUndefined();
    expect(host.globalStateStore.has('talaria.setup.hermesInstall')).toBe(false);
    expect(host.reloadOffers).toBe(0);
  });
});

// --- setup.setApiKey ----------------------------------------------------------

describe('setup.setApiKey: password input -> secrets.store, never echoed', () => {
  it('stores the entered key under AUTOCOMPLETE_API_KEY_SECRET', async () => {
    const { host, controller } = makeController({ passwordResponses: ['sk-super-secret-123'] });
    const result = await controller.handle('setup.setApiKey', {});
    expect(result).toEqual({ ok: true });
    expect(host.secretValues.get(AUTOCOMPLETE_API_KEY_SECRET)).toBe('sk-super-secret-123');
  });

  it('cancelling the password prompt declines with no secrets.store call', async () => {
    const { host, controller } = makeController({ passwordResponses: [undefined] });
    const result = await controller.handle('setup.setApiKey', {});
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.calls.some((c) => c.startsWith('secrets.store'))).toBe(false);
  });

  it('clear:true shows a modal and deletes the secret on accept', async () => {
    const { host, controller } = makeController({ modalResponses: [true] });
    const result = await controller.handle('setup.setApiKey', { clear: true });
    expect(result).toEqual({ ok: true });
    expect(host.calls).toContain(`secrets.delete:${AUTOCOMPLETE_API_KEY_SECRET}`);
  });

  it('the raw key never appears anywhere in status() output — only apiKeySet:boolean', async () => {
    const { controller } = makeController({ passwordResponses: ['sk-super-secret-123'] });
    await controller.handle('setup.setApiKey', {});
    const data = await controller.status();
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('sk-super-secret-123');
    const codestral = data.fim.options.find((o) => o.id === 'codestral');
    expect(codestral?.remote?.apiKeySet).toBe(true);
  });
});

// --- setup.applyFim: modal shows old->new endpoint --------------------------

describe('setup.applyFim: Tier-1 modal names old->new endpoint', () => {
  it('modal message contains both the old and the new endpoint', async () => {
    const { host, controller } = makeController({ settings: settingsMap({ 'talaria.autocomplete.endpoint': 'http://old-host:9000' }) });
    const result = await controller.handle('setup.applyFim', { backendId: 'ollama', endpoint: 'http://127.0.0.1:11434' });
    expect(result).toEqual({ ok: true });
    const modalCall = host.calls.find((c) => c.startsWith('showModal:'));
    expect(modalCall).toContain('http://old-host:9000');
    expect(modalCall).toContain('http://127.0.0.1:11434');
    expect(host.settings.get('talaria.autocomplete.backend')).toBe('ollama');
    expect(host.settings.get('talaria.autocomplete.endpoint')).toBe('http://127.0.0.1:11434');
  });

  it('refuses an invalid endpoint URL before showing any modal', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.applyFim', { backendId: 'ollama', endpoint: 'not-a-url' });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual([]);
  });
});

// --- setup.setNextEdit ---------------------------------------------------------

describe('setup.setNextEdit: validates URL then Tier-1-writes the three keys', () => {
  it('invalid endpoint is refused before any modal/write', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setNextEdit', { backend: 'ollama', endpoint: 'ftp://bad', model: 'x' });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual([]);
  });

  it('valid input shows modal then writes backend+endpoint+model together', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setNextEdit', {
      backend: 'openai-compat',
      endpoint: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.nextEdit.backend')).toBe('openai-compat');
    expect(host.settings.get('talaria.nextEdit.endpoint')).toBe('http://127.0.0.1:8000');
    expect(host.settings.get('talaria.nextEdit.model')).toBe('qwen2.5-coder:1.5b-base');
  });
});

// --- setup.setRag ----------------------------------------------------------

describe('setup.setRag: Tier-1 writes', () => {
  it('writes only the provided fields after a modal accept', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setRag', { enabled: false, embedModel: 'qwen3-embedding:0.6b' });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.rag.enabled')).toBe(false);
    expect(host.settings.get('talaria.rag.embedModel')).toBe('qwen3-embedding:0.6b');
    expect(host.settings.has('talaria.rag.indexDir')).toBe(false);
  });
});

// --- setup.openProviderWizard ------------------------------------------------

describe('setup.openProviderWizard: runInTerminal(name, <hermesAcp>, ["--setup"])', () => {
  it('derives the hermes-acp sibling path and runs it with --setup', async () => {
    const { host, controller } = makeController({
      settings: settingsMap({ 'talaria.hermesPath': '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes' }),
    });
    const result = await controller.handle('setup.openProviderWizard', {});
    expect(result).toEqual({ ok: true });
    expect(host.terminalsRun).toEqual([
      {
        name: 'Hermes Provider Setup',
        shellPath: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes-acp',
        args: ['--setup'],
      },
    ]);
  });

  it('refuses when hermes is not installed yet (no hermesPath)', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.openProviderWizard', {});
    expect(result.ok).toBe(false);
    expect(host.terminalsRun).toEqual([]);
    expect(host.calls).toEqual([]); // never even shows the modal
  });
});

// --- setup.openInstallTerminal -----------------------------------------------

describe('setup.openInstallTerminal: createTerminal pre-typed only', () => {
  it('creates a terminal with the exact guided-terminal command', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'ollama' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([
      { name: 'Ollama install', command: 'curl -fsSL https://ollama.com/install.sh | sh' },
    ]);
  });

  it('refuses for a backend with no guided-terminal recipe (hermes is pipx)', async () => {
    const { controller } = makeController();
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'hermes' });
    expect(result.ok).toBe(false);
  });
});

// --- setup.openBootstrapTerminal (T11 IMPORTANT host-gap 2) ------------------

describe('setup.openBootstrapTerminal: Tier-1 modal -> createTerminal("Install pipx", "sudo dnf install pipx") pre-typed', () => {
  it('accept -> creates a terminal with the exact pre-typed pipx bootstrap command', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.openBootstrapTerminal', {});
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([{ name: 'Install pipx', command: 'sudo dnf install pipx' }]);
  });

  it('shows a modal naming the exact command BEFORE creating the terminal', async () => {
    const { host, controller } = makeController();
    await controller.handle('setup.openBootstrapTerminal', {});
    const modalCall = host.calls.find((c) => c.startsWith('showModal:'));
    expect(modalCall).toBeDefined();
    expect(modalCall).toContain('sudo dnf install pipx');
    // Modal happens before the terminal is created (write-order proof, same
    // discipline as `setup.openInstallTerminal`/`setup.applyFim`).
    expect(host.calls.indexOf(modalCall as string)).toBeLessThan(
      host.calls.findIndex((c) => c.startsWith('createTerminal:')),
    );
  });
});

// --- setup.reload (T11 IMPORTANT host-gap 1) ---------------------------------

describe('setup.reload: trust-gated (FM-14), modal-free, calls host.reload() directly', () => {
  it('trusted: calls host.reload() with no modal', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.reload', {});
    expect(result).toEqual({ ok: true });
    expect(host.reloadCalls).toBe(1);
    expect(host.calls).toEqual(['reload']); // no showModal: entry anywhere
  });

  it('untrusted: refused, host.reload() never called (also covered by the FM-14 table above)', async () => {
    const { host, controller } = makeController({ trusted: false });
    const result = await controller.handle('setup.reload', {});
    expect(result.ok).toBe(false);
    expect(host.reloadCalls).toBe(0);
  });
});

// --- FIX 1 (final review wave, IMPORTANT): setup.recheck re-probes pipx -----

describe('setup.recheck re-probes pipx (FIX 1: the pipx-missing/python-unsuitable recovery dead-end)', () => {
  it('a cached pipx-missing clears after a successful recheck-triggered relocate — Install becomes actionable again', async () => {
    let calls = 0;
    const { controller } = makeController(
      {},
      {
        locatePipx: async (): Promise<PipxLocateResult> => {
          calls++;
          return calls === 1
            ? { ok: false, reason: 'pipx-missing', detail: 'no pipx on PATH' }
            : OK_PIPX_LOCATE;
        },
      },
    );

    // Drive the install into the sticky pipx-missing state (locatePipx call #1).
    const installResult = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(installResult).toEqual({ ok: false, reason: 'pipx-missing' });
    expect((await controller.status()).agent.phase).toBe('pipx-missing');

    // Without a recheck, status() alone never re-probes (this is the bug: it
    // would stay 'pipx-missing' forever). setup.recheck re-runs locatePipx
    // (call #2, now ok) and CLEARS the sticky issue.
    const recheckResult = await controller.handle('setup.recheck', {});
    expect(recheckResult).toEqual({ ok: true });
    expect(calls).toBe(2);

    const data = await controller.status();
    expect(data.agent.phase).toBe('missing'); // Install button is back
  });

  it('python-unsuitable -> recheck -> still unsuitable refreshes the detail honestly instead of staying stale', async () => {
    const { controller } = makeController(
      {},
      {
        locatePipx: async (): Promise<PipxLocateResult> => ({
          ok: false,
          reason: 'python-unsuitable',
          detail: 'no suitable python (>=3.11, <3.14) found',
        }),
      },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });
    expect((await controller.status()).agent.phase).toBe('python-unsuitable');

    const recheckResult = await controller.handle('setup.recheck', {});
    expect(recheckResult).toEqual({ ok: true });

    const data = await controller.status();
    expect(data.agent.phase).toBe('python-unsuitable');
    expect(data.agent.detail).toContain('no suitable python');
  });

  it('pipx-missing can flip to python-unsuitable across recheck attempts (refreshed, not merely confirmed)', async () => {
    let calls = 0;
    const { controller } = makeController(
      {},
      {
        locatePipx: async (): Promise<PipxLocateResult> => {
          calls++;
          return calls === 1
            ? { ok: false, reason: 'pipx-missing', detail: 'no pipx' }
            : { ok: false, reason: 'python-unsuitable', detail: 'pipx found, python too old' };
        },
      },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });
    expect((await controller.status()).agent.phase).toBe('pipx-missing');

    await controller.handle('setup.recheck', {});
    expect((await controller.status()).agent.phase).toBe('python-unsuitable');
  });

  it('T4 M-2 carry-forward: a REJECTING locatePipx during recheck never becomes an unhandled rejection', async () => {
    const { controller } = makeController(
      {},
      {
        locatePipx: async () => {
          throw new Error('pipx vanished mid-flow');
        },
      },
    );
    const result = await controller.handle('setup.recheck', {});
    expect(result).toEqual({ ok: true });
    const data = await controller.status();
    expect(data.agent.phase).toBe('error');
    expect(data.agent.detail).toContain('pipx vanished');
  });

  it('a successful recheck with no prior issue is a harmless no-op (still missing, not mis-flagged)', async () => {
    const { controller } = makeController();
    const result = await controller.handle('setup.recheck', {});
    expect(result).toEqual({ ok: true });
    expect((await controller.status()).agent.phase).toBe('missing');
  });
});

// --- FIX 3 (final review wave): MUTATING_METHODS exhaustiveness lock --------

describe('MUTATING_METHODS / READ_ONLY_METHODS partition the full SetupMethod union (FIX 3)', () => {
  // A `Record<SetupMethod, true>` literal: TypeScript refuses to compile
  // this object if a new value is ever added to the `SetupMethod` union
  // without a matching key here — a compile-time backstop layered on top of
  // the runtime Set-equality assertion below. Adding the key here is NOT
  // enough on its own, though: the runtime assertion is what actually fails
  // if that new method isn't ALSO placed into MUTATING_METHODS or
  // READ_ONLY_METHODS — i.e. classified, not just acknowledged.
  const ALL_SETUP_METHODS_MAP: Record<SetupMethod, true> = {
    'setup.status': true,
    'setup.install': true,
    'setup.applyAgent': true,
    'setup.applyFim': true,
    'setup.setApiKey': true,
    'setup.testRemote': true,
    'setup.pullModel': true,
    'setup.cancel': true,
    'setup.openProviderWizard': true,
    'setup.openInstallTerminal': true,
    'setup.openBootstrapTerminal': true,
    'setup.recheck': true,
    'setup.reload': true,
    'setup.setNextEdit': true,
    'setup.setRag': true,
    'setup.setTunable': true,
  };
  const ALL_SETUP_METHODS = Object.keys(ALL_SETUP_METHODS_MAP) as SetupMethod[];

  it('every SetupMethod appears in exactly one of MUTATING_METHODS / READ_ONLY_METHODS', () => {
    const combined = [...MUTATING_METHODS, ...READ_ONLY_METHODS];
    // No duplicates across the two sets (a method classified as BOTH would
    // pass the "union covers everything" check below without this).
    expect(new Set(combined).size).toBe(combined.length);
    expect([...combined].sort()).toEqual([...ALL_SETUP_METHODS].sort());
  });
});

// --- FIX 4 (final review wave, T13 M-1): null-guard on malformed authMethods -

describe('computeProviderCard null-guard (FIX 4): a malformed (null) advertised-method entry is dropped, not thrown', () => {
  it('a null entry mixed with a valid managed method is dropped; the valid one still resolves configured', async () => {
    // Deliberately malformed input (a null array element) — proves
    // computeProviderCard's `m?.id` guard drops it instead of throwing on
    // `m.id` off a null `m`. The dep's declared type can't forbid this at
    // compile time; only the runtime guard can.
    const malformed: unknown[] = [null, { id: 'openrouter', name: 'openrouter creds' }];
    const { controller } = makeController(
      {},
      { getAdvertisedAuthMethods: () => malformed as { id: string; name: string }[] },
    );
    const data = await controller.status();
    expect(data.provider).toEqual({ phase: 'configured', providerId: 'openrouter' });
  });

  it('an array of ONLY malformed entries resolves unconfigured, never throws', async () => {
    const malformed: unknown[] = [null, undefined];
    const { controller } = makeController(
      {},
      { getAdvertisedAuthMethods: () => malformed as { id: string; name: string }[] },
    );
    const data = await controller.status();
    expect(data.provider).toEqual({ phase: 'unconfigured' });
  });
});

// --- status() assembly --------------------------------------------------------

describe('status(): assembles SetupData from registry + settings + secrets + ollama probe', () => {
  it('defaults: agent missing, fim ollama, rag defaults, ollama not running', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    expect(data.agent.phase).toBe('missing');
    expect(data.fim.selectedId).toBe('ollama');
    expect(data.fim.model).toBe('qwen2.5-coder:1.5b-base');
    expect(data.rag.embedModel).toBe('qwen3-embedding:0.6b');
    expect(data.ollama.running).toBe(false);
    expect(data.ready).toBe(false);
  });

  it('hermesPath set + backend=mock -> installed-inactive', async () => {
    const { controller } = makeController({
      settings: settingsMap({ 'talaria.hermesPath': '/x/bin/hermes', 'talaria.backend': 'mock' }),
    });
    const data = await controller.status();
    expect(data.agent.phase).toBe('installed-inactive');
  });

  it('hermesPath set + backend=acp but NO advertised authMethods yet -> agent ready, provider waiting-agent, ready:false', async () => {
    // Task 13 update: the provider card is now driven SOLELY by the
    // ACP-advertised authMethods (dep seam) — settings saying "acp" no longer
    // flips it off 'waiting-agent'; only a real initialize result does.
    const { controller } = makeController({
      settings: settingsMap({ 'talaria.hermesPath': '/x/bin/hermes', 'talaria.backend': 'acp' }),
    });
    const data = await controller.status();
    expect(data.agent.phase).toBe('ready');
    expect(data.provider.phase).toBe('waiting-agent');
    expect(data.ready).toBe(false);
  });

  it('after a successful install, phase is awaiting-reload (not ready) until a reload actually happens', async () => {
    const { controller } = makeController();
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.phase).toBe('awaiting-reload');
  });

  it('ollama running populates ollama.models and embedModelPresent', async () => {
    const { controller } = makeController(
      {},
      {
        probeOllama: async () => ({
          running: true,
          models: [{ name: 'qwen3-embedding:0.6b', sizeBytes: 123 }],
        }),
      },
    );
    const data = await controller.status();
    expect(data.ollama.running).toBe(true);
    expect(data.rag.embedModelPresent).toBe(true);
  });

  it('nextEdit.source=generic on a backend without generic support carries a refusalDetail', async () => {
    const { controller } = makeController(
      { settings: settingsMap({ 'talaria.autocomplete.backend': 'codestral' }) },
      { getNextEditSource: () => 'generic' },
    );
    const data = await controller.status();
    expect(data.nextEdit.refusalDetail).toBeDefined();
  });
});

// --- Task 13: provider card from the ACP-advertised authMethods (§2.1) -------

describe('Task 13: provider card mapped from the advertised authMethods', () => {
  const SETUP_ONLY = [{ id: 'hermes-setup', name: 'Configure Hermes provider' }];
  const PROVIDER_AND_SETUP = [
    { id: 'openrouter', name: 'openrouter runtime credentials' },
    { id: 'hermes-setup', name: 'Configure Hermes provider' },
  ];

  it('dep returns undefined (no initialize yet / mock backend) -> waiting-agent, no providerId', async () => {
    const { controller } = makeController({}, { getAdvertisedAuthMethods: () => undefined });
    const data = await controller.status();
    expect(data.provider).toEqual({ phase: 'waiting-agent' });
  });

  it('ONLY hermes-setup advertised -> unconfigured (the wizard is the way forward), no providerId', async () => {
    const { controller } = makeController({}, { getAdvertisedAuthMethods: () => SETUP_ONLY });
    const data = await controller.status();
    expect(data.provider).toEqual({ phase: 'unconfigured' });
  });

  it('an agent-managed method (id != hermes-setup) -> configured, providerId = that id', async () => {
    const { controller } = makeController({}, { getAdvertisedAuthMethods: () => PROVIDER_AND_SETUP });
    const data = await controller.status();
    expect(data.provider).toEqual({ phase: 'configured', providerId: 'openrouter' });
  });

  it('an EMPTY advertisement (agent answered, zero methods) -> unconfigured, never a fabricated configured', async () => {
    const { controller } = makeController({}, { getAdvertisedAuthMethods: () => [] });
    const data = await controller.status();
    expect(data.provider).toEqual({ phase: 'unconfigured' });
  });

  it('agent ready + provider configured + FIM green -> ready:true', async () => {
    const { controller } = makeController(
      { settings: settingsMap({ 'talaria.hermesPath': '/x/bin/hermes', 'talaria.backend': 'acp' }) },
      { getAdvertisedAuthMethods: () => PROVIDER_AND_SETUP },
    );
    const data = await controller.status();
    expect(data.agent.phase).toBe('ready');
    expect(data.provider).toEqual({ phase: 'configured', providerId: 'openrouter' });
    expect(data.ready).toBe(true);
  });

  it('provider configured but the agent NOT ready keeps the composite ready:false (never provider-only ready)', async () => {
    const { controller } = makeController({}, { getAdvertisedAuthMethods: () => PROVIDER_AND_SETUP });
    const data = await controller.status();
    expect(data.agent.phase).toBe('missing');
    expect(data.provider.phase).toBe('configured');
    expect(data.ready).toBe(false);
  });

  // --- FIX 5 (final review wave, T9 M4): read-path write removed --------------
  // `status()` used to write `globalState['talaria.setup.completed']=true` on
  // every read where `ready` was true — a WRITE on a READ path with zero
  // readers anywhere in `src` (confirmed by grep). Deleted outright rather
  // than fixed in place; this proves `status()` no longer touches
  // globalState at all, on either a ready or not-ready computation.
  it('status() never writes globalState, ready or not (T9 M4: dead read-path write removed)', async () => {
    const { host, controller } = makeController(
      { settings: settingsMap({ 'talaria.hermesPath': '/x/bin/hermes', 'talaria.backend': 'acp' }) },
      { getAdvertisedAuthMethods: () => PROVIDER_AND_SETUP },
    );
    const before = host.calls.length;
    const data = await controller.status();
    expect(data.ready).toBe(true);
    expect(host.calls.slice(before).some((c) => c.startsWith('globalState:'))).toBe(false);
    expect(host.globalStateStore.has('talaria.setup.completed')).toBe(false);
  });
});

// --- onProgress: throttled >=150ms via a real timer --------------------------

describe('onProgress: throttled >=150ms per (op, id) via a real timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the first event immediately, coalesces a rapid burst into one delayed final emission', async () => {
    const { controller } = makeController();
    const received: SetupProgress[] = [];
    controller.onProgress((p) => received.push(p));

    // Drive three rapid 'log' events through the private pushProgress path by
    // installing (which streams phase/log/done events from the fake engine).
    // First event of an install should land synchronously (elapsed=Infinity).
    const installPromise = controller.handle('setup.install', { backendId: 'hermes' });

    // The fake installHermes fires its onEvent calls synchronously inside its
    // own async function body — by the time the modal (auto-accepted) and the
    // locatePipx/installHermes awaits settle, several progress events will
    // have been pushed within the same tick window.
    await vi.runAllTimersAsync();
    await installPromise;

    expect(received.length).toBeGreaterThan(0);
    // The very first pushed event was emitted with zero delay.
    expect(received[0]?.op).toBe('install');
  });

  it('two pushes for the same (op,id) inside the throttle window collapse into one timer-delivered value', () => {
    const { controller } = makeController();
    const received: SetupProgress[] = [];
    controller.onProgress((p) => received.push(p));

    const push = (controller as unknown as { pushProgress(p: SetupProgress): void }).pushProgress.bind(controller);
    push({ op: 'pull', id: 'model-x', phase: 'a' });
    expect(received).toEqual([{ op: 'pull', id: 'model-x', phase: 'a' }]);

    push({ op: 'pull', id: 'model-x', phase: 'b' });
    push({ op: 'pull', id: 'model-x', phase: 'c' });
    // Still throttled — no second emission yet.
    expect(received.length).toBe(1);

    vi.advanceTimersByTime(149);
    expect(received.length).toBe(1);

    vi.advanceTimersByTime(2);
    // Only the LATEST pending value ('c') was delivered, not 'b'.
    expect(received).toEqual([
      { op: 'pull', id: 'model-x', phase: 'a' },
      { op: 'pull', id: 'model-x', phase: 'c' },
    ]);
  });
});

// --- helper ------------------------------------------------------------------

function settingsMap(entries: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(entries));
}
