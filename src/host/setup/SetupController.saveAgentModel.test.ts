import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import {
  SetupController,
  servedNameFor,
  composeAgentGuidance,
  type SetupHost,
  type SetupControllerDeps,
} from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend } from './registry';
import { MODEL_CATALOG } from './modelCatalog';
import type { PipxLocateResult } from './pipxLocator';
import type { OllamaStatus } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import type { LlamaCppLocateResult } from './llamaCppLocator';
import type { GgufDestResult } from './modelStore';

/**
 * T8 (beta.6 §2.5/§6): `setup.saveAgentModel` + `status().agentLocalModel` +
 * the 2 additive restoration settings (`nextEdit.dedicatedBackendId`,
 * `rag.embedBackend`). Own fixture file (mirrors
 * `SetupController.provisionModel.test.ts`'s style) — the REAL catalog is
 * used throughout (no poisoned-fixture suite needed here: the only "bad
 * source" branches this method can reach are already covered by T7's
 * `assertProvisionSources`/`composeVllmCell` gates, reused verbatim).
 */

// --- §6 copy, verbatim (drift-locked) ----------------------------------------

const UNKNOWN_ID_REFUSAL = 'Unknown model — the catalog is fixed in this release.';
const ROLE_REFUSAL = 'modelId must be an agent-role catalog model.';
const BACKEND_REFUSAL = "backend must be 'ollama', 'llamacpp', or 'vllm'.";
const CLEAR_MODAL = 'Clear the saved local agent model?';
const AGENT_ENDPOINT_DEFAULTS = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8013',
  vllm: 'http://127.0.0.1:8000',
};

// §6 "Agent guidance — …" — verbatim. beta.6 panel-fix PT8 (audit A8, the
// one-carrier ✓ rule): the leading ✓ is stripped — this copy always renders
// via the webview's `DoneLine` (a `pass-filled` icon already carries the
// check; a literal ✓ beside it would double up).
const GUIDANCE_UNCONFIGURED = (endpoint: string, servedName: string): string =>
  `Local model ready. Next: press "Configure provider" on the Provider card below → choose the ` +
  `OpenAI-compatible (custom URL) provider → base URL: ${endpoint}/v1 · model: ${servedName}. Test shows the served model if unsure.`;
const GUIDANCE_WAITING =
  'Local model ready. The provider step unlocks once Hermes is installed and connected — the Provider card below will show "Configure provider".';
const GUIDANCE_CONFIGURED = (endpoint: string, servedName: string): string =>
  `Local model saved. Your provider is already configured — update it to ${endpoint}/v1 · ${servedName} if you want the agent on this model.`;

// --- fakes -------------------------------------------------------------------

class FakeHost implements SetupHost {
  calls: string[] = [];
  modalResponses: boolean[] = [];
  settings = new Map<string, unknown>();
  globalStateStore = new Map<string, unknown>();
  trusted = true;

  async showModal(message: string, _confirmLabel: string): Promise<boolean> {
    this.calls.push(`showModal:${message}`);
    return this.modalResponses.length > 0 ? (this.modalResponses.shift() as boolean) : true;
  }
  async showPasswordInput(): Promise<string | undefined> {
    return undefined;
  }
  createTerminal(): void {}
  runInTerminal(): void {}
  getSetting<T>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined;
  }
  async updateSettingGlobal(key: string, value: unknown): Promise<void> {
    this.calls.push(`write:${key}=${JSON.stringify(value)}`);
    this.settings.set(key, value);
  }
  secrets = {
    store: async (): Promise<void> => {},
    has: async (): Promise<boolean> => false,
    delete: async (): Promise<void> => {},
  };
  globalState = {
    get: <T,>(key: string): T | undefined => this.globalStateStore.get(key) as T | undefined,
    update: async (key: string, v: unknown): Promise<void> => {
      this.globalStateStore.set(key, v);
    },
  };
  isTrusted(): boolean {
    return this.trusted;
  }
  offerReload(): void {}
  reload(): void {}
}

function makeSaveController(
  overrides: Partial<SetupControllerDeps> = {},
  hostOverrides: Partial<FakeHost> = {},
): { host: FakeHost; controller: SetupController } {
  const host = new FakeHost();
  Object.assign(host, hostOverrides);
  const deps: SetupControllerDeps = {
    locatePipx: async (): Promise<PipxLocateResult> => ({ ok: false, reason: 'pipx-missing', detail: 'unused' }),
    readOsRelease: async () => ({}),
    installHermes: async () => {
      throw new Error('not used here');
    },
    probeOllama: async (): Promise<OllamaStatus> => ({ running: false, detail: 'not running' }),
    pullModel: async (): Promise<void> => {},
    probeRemote: async (): Promise<ProbeOutcome> => ({ ok: true, detail: 'ok' }),
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    getNextEditSource: () => 'off',
    getAdvertisedAuthMethods: () => undefined,
    verifyHfDigest: async () => ({ ok: true }),
    ingestGguf: async (): Promise<void> => {},
    resolveLfsOid: async () => ({ ok: false, reason: 'not used here' }),
    locateLlamaServer: (): Promise<LlamaCppLocateResult> => new Promise<LlamaCppLocateResult>(() => {}),
    scanStorePresence: async () => new Map<string, boolean>(),
    storeDest: (hfRepo: string, file: string): GgufDestResult => {
      const destDir = `${homedir()}/.local/share/talaria/models/${hfRepo}`;
      return { ok: true, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    checkedStoreDest: async (hfRepo: string, file: string) => {
      const destDir = `${homedir()}/.local/share/talaria/models/${hfRepo}`;
      return { ok: true as const, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    downloadGgufToStore: async (): Promise<void> => {},
    ...overrides,
  };
  const controller = new SetupController(host, deps);
  return { host, controller };
}

const ORNITH = MODEL_CATALOG.find((m) => m.id === 'ornith-9b')!;
const DEVSTRAL = MODEL_CATALOG.find((m) => m.id === 'devstral-24b')!;

// --- role-gate + params -------------------------------------------------------

describe('setup.saveAgentModel: role-gate + params (before any modal)', () => {
  it('unknown modelId is refused, no modal shown', async () => {
    const { host, controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'nonexistent-id',
      backend: 'ollama',
      endpoint: AGENT_ENDPOINT_DEFAULTS.ollama,
    });
    expect(result).toEqual({ ok: false, reason: UNKNOWN_ID_REFUSAL });
    expect(host.calls).toEqual([]);
  });

  it('a fim-role modelId is refused (role-gate), no modal shown', async () => {
    const { host, controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'qwen25-coder-1.5b',
      backend: 'ollama',
      endpoint: AGENT_ENDPOINT_DEFAULTS.ollama,
    });
    expect(result).toEqual({ ok: false, reason: ROLE_REFUSAL });
    expect(host.calls).toEqual([]);
  });

  it('an embedding-role modelId is refused (role-gate)', async () => {
    const { controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'qwen3-embedding-0.6b',
      backend: 'ollama',
      endpoint: AGENT_ENDPOINT_DEFAULTS.ollama,
    });
    expect(result).toEqual({ ok: false, reason: ROLE_REFUSAL });
  });

  it('a next-role modelId is refused (role-gate)', async () => {
    const { controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'sweep-next',
      backend: 'ollama',
      endpoint: AGENT_ENDPOINT_DEFAULTS.ollama,
    });
    expect(result).toEqual({ ok: false, reason: ROLE_REFUSAL });
  });

  it('an invalid backend is refused before any modal', async () => {
    const { host, controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'devstral-24b',
      backend: 'codestral',
      endpoint: AGENT_ENDPOINT_DEFAULTS.ollama,
    });
    expect(result).toEqual({ ok: false, reason: BACKEND_REFUSAL });
    expect(host.calls).toEqual([]);
  });

  it("'vllm' backend is ALLOWED here (unlike setup.provisionModel)", async () => {
    const { controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'devstral-24b',
      backend: 'vllm',
      endpoint: AGENT_ENDPOINT_DEFAULTS.vllm,
    });
    expect(result).toEqual({ ok: true });
  });

  it('a missing endpoint is refused before any modal', async () => {
    const { host, controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', { modelId: 'devstral-24b', backend: 'ollama' });
    expect(result).toEqual({ ok: false, reason: 'endpoint is required.' });
    expect(host.calls).toEqual([]);
  });

  it('an invalid endpoint URL is refused before any modal', async () => {
    const { host, controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'devstral-24b',
      backend: 'ollama',
      endpoint: 'not-a-url',
    });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual([]);
  });
});

// --- modal + 3 Global writes ---------------------------------------------------

describe('setup.saveAgentModel: Tier-1 modal (verbatim) then 3 Global writes', () => {
  it('shows the exact §6 modal, and a decline writes nothing', async () => {
    const { host, controller } = makeSaveController(undefined, { modalResponses: [false] });
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'ornith-9b',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.calls).toEqual([`showModal:Set the local agent model to '${ORNITH.displayName}' via ollama at http://127.0.0.1:11434?`]);
  });

  it('a confirm writes all 3 settings Global, modal BEFORE any write', async () => {
    const { host, controller } = makeSaveController();
    const result = await controller.handle('setup.saveAgentModel', {
      modelId: 'ornith-9b',
      backend: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
    });
    expect(result).toEqual({ ok: true });
    expect(host.calls).toEqual([
      `showModal:Set the local agent model to '${ORNITH.displayName}' via ollama at http://127.0.0.1:11434?`,
      `write:talaria.agent.localModel.modelId=${JSON.stringify('ornith-9b')}`,
      `write:talaria.agent.localModel.backend=${JSON.stringify('ollama')}`,
      `write:talaria.agent.localModel.endpoint=${JSON.stringify('http://127.0.0.1:11434')}`,
    ]);
    expect(host.settings.get('talaria.agent.localModel.modelId')).toBe('ornith-9b');
    expect(host.settings.get('talaria.agent.localModel.backend')).toBe('ollama');
    expect(host.settings.get('talaria.agent.localModel.endpoint')).toBe('http://127.0.0.1:11434');
  });
});

// --- {clear:true} --------------------------------------------------------------

describe('setup.saveAgentModel({clear:true}): modal-gated unset of all 3 keys', () => {
  function seeded(): { host: FakeHost; controller: SetupController } {
    const { host, controller } = makeSaveController();
    host.settings.set('talaria.agent.localModel.modelId', 'ornith-9b');
    host.settings.set('talaria.agent.localModel.backend', 'ollama');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:11434');
    return { host, controller };
  }

  it('shows a modal; a decline unsets nothing', async () => {
    const { host, controller } = seeded();
    host.modalResponses = [false];
    const result = await controller.handle('setup.saveAgentModel', { clear: true });
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(host.calls).toEqual([`showModal:${CLEAR_MODAL}`]);
    expect(host.settings.get('talaria.agent.localModel.modelId')).toBe('ornith-9b');
    expect(host.settings.get('talaria.agent.localModel.backend')).toBe('ollama');
    expect(host.settings.get('talaria.agent.localModel.endpoint')).toBe('http://127.0.0.1:11434');
  });

  it('a confirm unsets all 3 keys', async () => {
    const { host, controller } = seeded();
    const result = await controller.handle('setup.saveAgentModel', { clear: true });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.agent.localModel.modelId')).toBeUndefined();
    expect(host.settings.get('talaria.agent.localModel.backend')).toBeUndefined();
    expect(host.settings.get('talaria.agent.localModel.endpoint')).toBeUndefined();
  });

  it('ignores modelId/backend/endpoint when clear:true is also present', async () => {
    const { host, controller } = seeded();
    const result = await controller.handle('setup.saveAgentModel', {
      clear: true,
      modelId: 'devstral-24b',
      backend: 'vllm',
      endpoint: 'http://127.0.0.1:8000',
    });
    expect(result).toEqual({ ok: true });
    expect(host.settings.get('talaria.agent.localModel.modelId')).toBeUndefined();
  });
});

// --- status().agentLocalModel ---------------------------------------------------

describe('status().agentLocalModel: endpointDefaults + saved recompose', () => {
  it('endpointDefaults are always present; no saved state when nothing is configured', async () => {
    const { controller } = makeSaveController();
    const data = await controller.status();
    expect(data.agentLocalModel?.endpointDefaults).toEqual(AGENT_ENDPOINT_DEFAULTS);
    expect(data.agentLocalModel?.saved).toBeUndefined();
    expect(data.agentLocalModel?.providerGuidance).toBeUndefined();
  });

  it('servedName table: ollama library tier = the tag (ornith-9b)', async () => {
    const { host, controller } = makeSaveController();
    host.settings.set('talaria.agent.localModel.modelId', 'ornith-9b');
    host.settings.set('talaria.agent.localModel.backend', 'ollama');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:11434');
    const data = await controller.status();
    expect(data.agentLocalModel?.saved?.servedName).toBe('ornith:9b');
    expect(data.agentLocalModel?.saved?.runCommand).toBeUndefined(); // ollama needs none
  });

  it('servedName table: ollama hf-ingest tier (devstral) = the CREATED name (rev 3)', async () => {
    const { host, controller } = makeSaveController();
    host.settings.set('talaria.agent.localModel.modelId', 'devstral-24b');
    host.settings.set('talaria.agent.localModel.backend', 'ollama');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:11434');
    const data = await controller.status();
    expect(data.agentLocalModel?.saved?.servedName).toBe('devstral-small-2507:24b');
  });

  it('servedName table: llamacpp = the GGUF file name', async () => {
    const { host, controller } = makeSaveController();
    host.settings.set('talaria.agent.localModel.modelId', 'devstral-24b');
    host.settings.set('talaria.agent.localModel.backend', 'llamacpp');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:8013');
    const data = await controller.status();
    expect(data.agentLocalModel?.saved?.servedName).toBe('Devstral-Small-2507-Q4_K_M.gguf');
  });

  it('servedName table: vllm = the serveRepo', async () => {
    const { host, controller } = makeSaveController();
    host.settings.set('talaria.agent.localModel.modelId', 'devstral-24b');
    host.settings.set('talaria.agent.localModel.backend', 'vllm');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:8000');
    const data = await controller.status();
    expect(data.agentLocalModel?.saved?.servedName).toBe('mistralai/Devstral-Small-2507');
    expect(data.agentLocalModel?.saved?.runCommand).toBe('vllm serve mistralai/Devstral-Small-2507');
  });

  it('llamacpp runCommand: absent when the file is not present in the store', async () => {
    const { host, controller } = makeSaveController({ scanStorePresence: async () => new Map() });
    host.settings.set('talaria.agent.localModel.modelId', 'devstral-24b');
    host.settings.set('talaria.agent.localModel.backend', 'llamacpp');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:8013');
    const data = await controller.status();
    expect(data.agentLocalModel?.saved?.runCommand).toBeUndefined();
  });

  it('llamacpp runCommand: recomposed from the SAVED endpoint PORT when present — never a literal (CC-6)', async () => {
    const { host, controller } = makeSaveController({
      scanStorePresence: async () => new Map([['devstral-24b', true]]),
    });
    host.settings.set('talaria.agent.localModel.modelId', 'devstral-24b');
    host.settings.set('talaria.agent.localModel.backend', 'llamacpp');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:8013');
    const expectedDest = `${homedir()}/.local/share/talaria/models/mistralai/Devstral-Small-2507_gguf/Devstral-Small-2507-Q4_K_M.gguf`;
    const data = await controller.status();
    expect(data.agentLocalModel?.saved?.runCommand).toBe(
      `llama-server -m ~/.local/share/talaria/models/mistralai/Devstral-Small-2507_gguf/Devstral-Small-2507-Q4_K_M.gguf --jinja --port 8013`,
    );
    void expectedDest; // documents the pre-redaction path this asserts against

    // Change ONLY the saved endpoint's port — the composed command's port
    // must change with it (proves "recomposed from the saved port", never a
    // hardcoded LLAMACPP_RUN_FLAGS.agent literal).
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:9999');
    const data2 = await controller.status();
    expect(data2.agentLocalModel?.saved?.runCommand).toBe(
      'llama-server -m ~/.local/share/talaria/models/mistralai/Devstral-Small-2507_gguf/Devstral-Small-2507-Q4_K_M.gguf --jinja --port 9999',
    );
  });

  it('a stale/corrupted setting (modelId no longer in the catalog) degrades to no saved state, never throws', async () => {
    const { host, controller } = makeSaveController();
    host.settings.set('talaria.agent.localModel.modelId', 'no-longer-exists');
    host.settings.set('talaria.agent.localModel.backend', 'ollama');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:11434');
    const data = await controller.status();
    expect(data.agentLocalModel?.saved).toBeUndefined();
  });
});

// --- providerGuidance ------------------------------------------------------------

describe('status().agentLocalModel.providerGuidance: the §6 variant per provider.phase', () => {
  async function statusWith(authMethods: { id: string; name: string }[] | undefined) {
    const { host, controller } = makeSaveController({ getAdvertisedAuthMethods: () => authMethods });
    host.settings.set('talaria.agent.localModel.modelId', 'ornith-9b');
    host.settings.set('talaria.agent.localModel.backend', 'ollama');
    host.settings.set('talaria.agent.localModel.endpoint', 'http://127.0.0.1:11434');
    return controller.status();
  }

  it("provider.phase 'waiting-agent' (no ACP init yet) -> the waiting variant", async () => {
    const data = await statusWith(undefined);
    expect(data.provider.phase).toBe('waiting-agent');
    expect(data.agentLocalModel?.providerGuidance).toBe(GUIDANCE_WAITING);
  });

  it("provider.phase 'unconfigured' (only hermes-setup advertised) -> the wizard-pointing variant", async () => {
    const data = await statusWith([{ id: 'hermes-setup', name: 'Terminal setup' }]);
    expect(data.provider.phase).toBe('unconfigured');
    expect(data.agentLocalModel?.providerGuidance).toBe(GUIDANCE_UNCONFIGURED('http://127.0.0.1:11434', 'ornith:9b'));
  });

  it("provider.phase 'configured' (a managed method advertised) -> the update-it-if-you-want variant", async () => {
    const data = await statusWith([{ id: 'openrouter', name: 'OpenRouter' }]);
    expect(data.provider.phase).toBe('configured');
    expect(data.agentLocalModel?.providerGuidance).toBe(GUIDANCE_CONFIGURED('http://127.0.0.1:11434', 'ornith:9b'));
  });

  it('composeAgentGuidance direct: the currently-unreachable "unknown" phase shares the waiting copy', () => {
    expect(composeAgentGuidance('unknown', 'http://127.0.0.1:11434', 'ornith:9b')).toBe(GUIDANCE_WAITING);
  });

  it('servedNameFor direct: exhaustive over the 3 backends for a library-tier + hf-ingest-tier row', () => {
    expect(servedNameFor(ORNITH, 'ollama')).toBe('ornith:9b');
    expect(servedNameFor(ORNITH, 'llamacpp')).toBe('ornith-1.0-9b-Q4_K_M.gguf');
    expect(servedNameFor(ORNITH, 'vllm')).toBe('ornith-ai/Ornith-1.0-9B');
    expect(servedNameFor(DEVSTRAL, 'ollama')).toBe('devstral-small-2507:24b');
  });
});
