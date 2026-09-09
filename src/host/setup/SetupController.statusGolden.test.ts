import { describe, it, expect } from 'vitest';
import { SetupController } from './SetupController';
import type { SetupHost, SetupControllerDeps, AdvertisedAuthMethod } from './SetupController';
import { AGENT_BACKENDS, FIM_BACKENDS, getBackend } from './registry';
import type { OllamaStatus } from './ollamaClient';
import type { LlamaCppLocateResult } from './llamaCppLocator';
import type { SetupData, SetupBackendOption, SetupCatalogModel } from '../../shared/protocol';

/**
 * WS-GD.2b Task B1 — characterization golden master for `SetupController
 * .status()`'s FULL `SetupData` shape (`.superpowers/plans/2026-08-29-ws-gd2-
 * god-unit-decomposition.md` lines 664-695).
 *
 * TEST-ONLY: this file pins what `status()` returns TODAY across a matrix of
 * probe/settings permutations, so Tasks B2-B7 (which MOVE `status()`'s guts
 * into per-domain modules) can prove they kept behavior byte-identical. Every
 * literal below was hand-derived by reading the CURRENT `status()` body
 * (SetupController.ts, symbol `status`), `registry.ts`'s `AGENT_BACKENDS`/
 * `FIM_BACKENDS`, `modelCatalog.ts`'s `MODEL_CATALOG` (13 rows), and
 * `osDetect.ts`/`packageTable.ts` — never copied from the plan's prose.
 *
 * The fake `SetupHost`/`SetupControllerDeps` below MIRROR (do not import)
 * `SetupController.test.ts`'s own `FakeSetupHost`/`makeFakeDeps` factories,
 * per the plan's binding instruction. `readOsRelease` is deliberately given a
 * MINIMAL fixture (`'ID=fedora\n'`, not the sibling suite's full Fedora-44
 * text) — the matrix below never varies the `os` block, so a minimal fixture
 * that resolves deterministically to `{family:'fedora', manager:'dnf'}` (no
 * `prettyName` key) is both correct and lower-risk to transcribe than the
 * full pretty-name string.
 */

// --- fake SetupHost (mirrors SetupController.test.ts's FakeSetupHost) -------

class FakeSetupHost implements SetupHost {
  trusted = true;
  settings = new Map<string, unknown>();
  secretValues = new Map<string, string>();
  globalStateStore = new Map<string, unknown>();

  async showModal(_message: string, _confirmLabel: string): Promise<boolean> {
    return true;
  }

  async showPasswordInput(_prompt: string): Promise<string | undefined> {
    return undefined;
  }

  createTerminal(_name: string, _preTypedCommand: string): void {}

  runInTerminal(_name: string, _shellPath: string, _shellArgs: string[]): void {}

  getSetting<T>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined;
  }

  async updateSettingGlobal(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }

  inspectSettingGlobal(key: string): unknown {
    return this.settings.get(key);
  }

  secrets = {
    store: async (key: string, v: string): Promise<void> => {
      this.secretValues.set(key, v);
    },
    has: async (key: string): Promise<boolean> => this.secretValues.has(key),
    delete: async (key: string): Promise<void> => {
      this.secretValues.delete(key);
    },
  };

  globalState = {
    get: <T>(key: string): T | undefined => this.globalStateStore.get(key) as T | undefined,
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

// --- fake SetupControllerDeps (mirrors SetupController.test.ts's makeFakeDeps) --

function makeFakeDeps(overrides: Partial<SetupControllerDeps> = {}): SetupControllerDeps {
  const deps: SetupControllerDeps = {
    locatePipx: async () => ({
      ok: true,
      env: { pipxPath: '/usr/bin/pipx', venvsRoot: '/home/u/.local/share/pipx/venvs', defaultPythonVersion: '3.12.0' },
    }),
    installHermes: async () => ({
      venvRoot: '/home/u/.local/share/pipx/venvs/hermes-agent',
      hermes: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes',
      hermesAcp: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes-acp',
      python: '/home/u/.local/share/pipx/venvs/hermes-agent/bin/python',
    }),
    // Row 1/2 (§ matrix): "Ollama down (`probeOllama` rejects -> running:false)".
    probeOllama: async () => {
      throw new Error('ECONNREFUSED');
    },
    pullModel: async () => {},
    probeRemote: async () => ({ ok: true, detail: 'ok' }),
    registry: { AGENT_BACKENDS, FIM_BACKENDS, getBackend },
    getNextEditSource: () => 'off',
    // Default = "no ACP initialize has surfaced auth methods yet" -> 'waiting-agent'.
    getAdvertisedAuthMethods: () => undefined,
    verifyHfDigest: async () => ({ ok: true }),
    resolveLfsOid: async () => ({ ok: false, reason: 'not used here' }),
    ingestGguf: async () => {},
    // Minimal fixture (see file doc) -> family:'fedora', manager:'dnf', no prettyName.
    readOsRelease: async () => ({ text: 'ID=fedora\n' }),
    // Default never settles: the memo's 'checking' state stays deterministic
    // for every row that doesn't explicitly override it (mirrors the sibling
    // suite's own default posture).
    locateLlamaServer: () => new Promise<LlamaCppLocateResult>(() => {}),
    scanStorePresence: async () => new Map<string, boolean>(),
    storeDest: (hfRepo: string, file: string) => {
      const destDir = `/home/u/.local/share/talaria/models/${hfRepo}`;
      return { ok: true as const, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    checkedStoreDest: async (hfRepo: string, file: string) => {
      const destDir = `/home/u/.local/share/talaria/models/${hfRepo}`;
      return { ok: true as const, destDir, destFile: file, destPath: `${destDir}/${file}` };
    },
    downloadGgufToStore: async () => {},
    ...overrides,
  };
  return deps;
}

/** The plan's pinned helper (Task B1 §"Interfaces"): one fresh controller, one `status()` call. */
async function statusFor(
  overrides: {
    settings?: Record<string, unknown>;
    trusted?: boolean;
    ollama?: OllamaStatus;
    deps?: Partial<SetupControllerDeps>;
  } = {},
): Promise<SetupData> {
  const host = new FakeSetupHost();
  if (overrides.trusted !== undefined) host.trusted = overrides.trusted;
  const settings = overrides.settings;
  if (settings !== undefined) {
    for (const [key, value] of Object.entries(settings)) host.settings.set(key, value);
  }
  const depsOverrides: Partial<SetupControllerDeps> = { ...overrides.deps };
  const ollama = overrides.ollama;
  if (ollama !== undefined) {
    depsOverrides.probeOllama = async (): Promise<OllamaStatus> => ollama;
  }
  const controller = new SetupController(host, makeFakeDeps(depsOverrides));
  return controller.status();
}

/** Row 8 needs TWO `status()` calls around a probe settle — outside `statusFor`'s one-call contract. */
function makeRawController(depsOverrides: Partial<SetupControllerDeps> = {}): SetupController {
  const host = new FakeSetupHost();
  return new SetupController(host, makeFakeDeps(depsOverrides));
}

// --- shared fixtures (grounded against registry.ts / modelCatalog.ts / SetupController.ts) --

const AGENT_ENDPOINT_DEFAULTS_FIXTURE = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8013',
  vllm: 'http://127.0.0.1:8000',
};

const RAG_ENDPOINT_DEFAULTS_FIXTURE = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8081',
  'openai-compat': 'http://127.0.0.1:8000',
};

// Task 13 §4.2 dedicated NEXT block: NEXT_DEDICATED_MODEL.gguf.sha256 === ''
// at HEAD -> downloadReady:false everywhere (plan's binding note). The
// true-branch (`guided.llamacpp` present, `modelDefaults.ollama` non-empty)
// is intentionally UN-PINNED here — it needs the registry const mocked,
// which the pinned-mode `provisionModel` tests already own.
type DedicatedNext = NonNullable<SetupData['nextEdit']['dedicated']>;
const BASE_DEDICATED_NEXT: DedicatedNext = {
  displayName: 'Sweep Next-Edit v2 (7B)',
  modelDefaults: { ollama: '', openaiCompat: 'sweepai/sweep-next-edit-v2-7B' },
  downloadReady: false,
  downloadApproxBytes: 4_680_000_000,
  warning:
    'Needs ~15 GB of GPU memory at full precision, or ~5 GB for the 4-bit build. On a CPU-only machine a 7B model produces a few tokens per second — dedicated next-edit will feel slow; the Generic mode reuses your smaller FIM model instead.',
  guided: {
    vllm: 'Run: vllm serve sweepai/sweep-next-edit-v2-7B\n(official Sweep release, ~15 GB download)',
  },
};

// --- agent.options (registry.ts AGENT_BACKENDS, projected by projectBackend) --

const AGENT_OPTION_HERMES: SetupBackendOption = {
  id: 'hermes',
  kind: 'agent',
  status: 'available',
  displayName: 'Hermes',
  description:
    'Open-source agent harness by Nous Research — installed from PyPI into an isolated pipx venv; talks ACP over stdio.',
  localInstall: { flavor: 'pipx', effort: 'one-script' },
};

const AGENT_OPTION_OPENCLAW: SetupBackendOption = {
  id: 'openclaw',
  kind: 'agent',
  status: 'coming-soon',
  displayName: 'OpenClaw',
  description: 'Coming soon — not yet available in this release.',
};

const AGENT_OPTION_TALARIA_AI: SetupBackendOption = {
  id: 'talaria-ai',
  kind: 'agent',
  status: 'coming-soon',
  displayName: 'Talaria AI',
  description: 'Coming soon — not yet available in this release.',
};

const AGENT_OPTIONS_BASE: SetupBackendOption[] = [AGENT_OPTION_HERMES, AGENT_OPTION_OPENCLAW, AGENT_OPTION_TALARIA_AI];

// --- fim.options (registry.ts FIM_BACKENDS, projected by projectBackend) ----
// FI-33: `projectBackend`'s localInstall branch is now the static
// {flavor,effort} pair — it no longer varies with the ollama probe result,
// so ONE ollama option fixture now covers both the ollama-down baseline and
// the "ollama up" row (see row 4 below, which used to need a `_PRESENT`
// variant of this fixture for the dead per-model presence echo).

const FIM_OPTION_OLLAMA: SetupBackendOption = {
  id: 'ollama',
  kind: 'fim',
  status: 'available',
  displayName: 'Ollama',
  description:
    'Local model runner with one-script install and in-panel model pulls; also serves the embedding model for the codebase index.',
  remote: {
    endpointDefault: 'http://127.0.0.1:11434',
    endpointValue: '',
    endpointPlaceholder: 'http://127.0.0.1:11434',
    auth: 'none',
    apiKeySet: false,
    probe: 'ollama-tags',
  },
  localInstall: {
    flavor: 'guided-terminal',
    effort: 'one-script',
  },
  nextEditTransport: 'ollama',
};

const FIM_OPTION_LLAMACPP: SetupBackendOption = {
  id: 'llamacpp',
  kind: 'fim',
  status: 'available',
  displayName: 'llama.cpp',
  description:
    'llama-server with native FIM — manual install (release binary, distro package, or your own build); we do not build it for you.',
  remote: {
    endpointDefault: 'http://127.0.0.1:8080',
    endpointValue: '',
    endpointPlaceholder: 'http://127.0.0.1:8080',
    auth: 'apiKey-optional',
    apiKeySet: false,
    probe: 'llamacpp-health',
  },
  localInstall: { flavor: 'guided-terminal', effort: 'manual-guided' },
  nextEditTransport: 'openai-compat',
};

const FIM_OPTION_VLLM: SetupBackendOption = {
  id: 'vllm',
  kind: 'fim',
  status: 'available',
  displayName: 'vLLM',
  description: 'High-throughput OpenAI-compatible server — manual install (multi-GB CUDA/torch download, hardware-bound).',
  remote: {
    endpointDefault: 'http://127.0.0.1:8000',
    endpointValue: '',
    endpointPlaceholder: 'http://127.0.0.1:8000',
    auth: 'apiKey-optional',
    apiKeySet: false,
    probe: 'openai-models',
  },
  localInstall: { flavor: 'docs-only', effort: 'manual-guided' },
  docsUrl: 'https://docs.vllm.ai/',
  nextEditTransport: 'openai-compat',
};

const FIM_OPTION_CODESTRAL: SetupBackendOption = {
  id: 'codestral',
  kind: 'fim',
  status: 'available',
  displayName: 'Codestral (Mistral)',
  description: 'Mistral’s hosted FIM API — remote-only; requires an API key (stored in your OS keychain, never in settings).',
  remote: {
    endpointDefault: 'https://codestral.mistral.ai',
    endpointValue: '',
    endpointPlaceholder: 'https://codestral.mistral.ai',
    auth: 'apiKey-required',
    apiKeySet: false,
    probe: 'none',
  },
};

const FIM_OPTION_OPENAI_COMPAT: SetupBackendOption = {
  id: 'openai-compat',
  kind: 'fim',
  status: 'available',
  displayName: 'OpenAI-compatible server',
  description:
    'Bring your own OpenAI-compatible endpoint — strictly-spec servers may reject Talaria’s extra fields; prefer the vllm/ollama/llamacpp entries when one fits.',
  remote: {
    endpointDefault: 'http://127.0.0.1:8000',
    endpointValue: '',
    endpointPlaceholder: 'http://127.0.0.1:8000',
    auth: 'apiKey-optional',
    apiKeySet: false,
    probe: 'openai-models',
  },
  nextEditTransport: 'openai-compat',
};

const FIM_OPTIONS_BASE: SetupBackendOption[] = [
  FIM_OPTION_OLLAMA,
  FIM_OPTION_LLAMACPP,
  FIM_OPTION_VLLM,
  FIM_OPTION_CODESTRAL,
  FIM_OPTION_OPENAI_COMPAT,
];

// --- catalog.models (modelCatalog.ts MODEL_CATALOG, 13 rows, storePresence empty) --
// FIM_BASE_BUILD_NOTE / MOE_HONESTY_NOTE strings copied verbatim from modelCatalog.ts.

const FIM_BASE_BUILD_NOTE =
  "Base build (Q8) from ggml-org — the llama.cpp project's own packaging of Qwen's base model.";
const MOE_HONESTY_NOTE =
  'MoE ≠ smaller: a 35B MoE still needs ~20 GiB for weights — only compute is light (~3B active per token).';

const BASELINE_CATALOG: SetupCatalogModel[] = [
  {
    id: 'qwen25-coder-1.5b',
    role: 'fim',
    defaultForRole: true,
    displayName: 'Qwen2.5-Coder 1.5B (base)',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    contextWindow: 32768,
    vramLine: 'any modern GPU (~1–2 GB)',
    note: FIM_BASE_BUILD_NOTE,
    progressId: 'qwen25-coder-1.5b',
    ollamaTag: 'qwen2.5-coder:1.5b-base',
    ollamaApproxBytes: 986_000_000,
    llamacpp: { file: 'qwen2.5-coder-1.5b-q8_0.gguf', approxBytes: 1_646_573_056, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen2.5-Coder-1.5B' },
  },
  {
    id: 'qwen25-coder-7b',
    role: 'fim',
    displayName: 'Qwen2.5-Coder 7B (base)',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    vramLine: 'Ollama Q4 ≈ 6 GB · llama.cpp Q8 ≈ 9–10 GB',
    note: FIM_BASE_BUILD_NOTE,
    progressId: 'qwen25-coder-7b',
    ollamaTag: 'qwen2.5-coder:7b-base',
    ollamaApproxBytes: 4_700_000_000,
    llamacpp: { file: 'qwen2.5-coder-7b-q8_0.gguf', approxBytes: 8_098_525_600, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen2.5-Coder-7B' },
  },
  {
    id: 'qwen25-coder-14b',
    role: 'fim',
    displayName: 'Qwen2.5-Coder 14B (base)',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    vramLine: 'Ollama Q4 ≈ 11 GB · llama.cpp Q8 wants a 24 GB card',
    note: FIM_BASE_BUILD_NOTE,
    progressId: 'qwen25-coder-14b',
    ollamaTag: 'qwen2.5-coder:14b-base',
    ollamaApproxBytes: 9_000_000_000,
    llamacpp: { file: 'qwen2.5-coder-14b-q8_0.gguf', approxBytes: 15_701_597_984, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen2.5-Coder-14B' },
  },
  {
    id: 'qwen3-embedding-0.6b',
    role: 'embedding',
    defaultForRole: true,
    displayName: 'Qwen3-Embedding 0.6B',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    vramLine: '< 1.5 GB',
    progressId: 'qwen3-embedding-0.6b',
    ollamaTag: 'qwen3-embedding:0.6b',
    ollamaApproxBytes: 639_000_000,
    llamacpp: { file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', approxBytes: 639_150_592, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen3-Embedding-0.6B' },
  },
  {
    id: 'qwen3-embedding-4b',
    role: 'embedding',
    displayName: 'Qwen3-Embedding 4B',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    contextWindow: 40960,
    vramLine: '≈ 3 GB',
    progressId: 'qwen3-embedding-4b',
    ollamaTag: 'qwen3-embedding:4b',
    ollamaApproxBytes: 2_500_000_000,
    llamacpp: { file: 'Qwen3-Embedding-4B-Q4_K_M.gguf', approxBytes: 2_496_703_776, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen3-Embedding-4B' },
  },
  {
    id: 'embeddinggemma-300m',
    role: 'embedding',
    displayName: 'EmbeddingGemma 300M',
    publisher: 'ggml-org',
    license: 'Gemma',
    contextWindow: 2048,
    vramLine: '< 1 GB',
    note: '2K context on the Ollama build — fine for Talaria’s chunk sizes (≤512 tokens).',
    progressId: 'embeddinggemma-300m',
    ollamaTag: 'embeddinggemma:300m',
    ollamaApproxBytes: 622_000_000,
    llamacpp: { file: 'embeddinggemma-300M-Q8_0.gguf', approxBytes: 333_590_944, present: false, available: true },
    vllm: { runCommand: 'vllm serve google/embeddinggemma-300m' },
  },
  {
    id: 'devstral-24b',
    role: 'agent',
    defaultForRole: true,
    displayName: 'Devstral-24B (2507)',
    publisher: 'mistralai',
    license: 'Apache-2.0',
    contextWindow: 131072,
    vramLine: '24GB-comfortable — the sweet spot: ~55K ctx fp16-KV / ~110K Q8-KV; 128K window',
    progressId: 'devstral-24b',
    ollamaCreatedName: 'devstral-small-2507:24b',
    ollamaApproxBytes: 14_333_915_904,
    llamacpp: { file: 'Devstral-Small-2507-Q4_K_M.gguf', approxBytes: 14_333_915_904, present: false, available: true },
    vllm: { runCommand: 'vllm serve mistralai/Devstral-Small-2507' },
  },
  {
    id: 'ornith-9b',
    role: 'agent',
    displayName: 'Ornith-1.0 9B',
    publisher: 'ornith-ai',
    license: 'MIT',
    vramLine: '24GB-easy (128K+ ctx headroom)',
    progressId: 'ornith-9b',
    ollamaTag: 'ornith:9b',
    ollamaApproxBytes: 5_600_000_000,
    llamacpp: { file: 'ornith-1.0-9b-Q4_K_M.gguf', approxBytes: 5_629_108_704, present: false, available: true },
    vllm: { runCommand: 'vllm serve ornith-ai/Ornith-1.0-9B' },
  },
  {
    id: 'ornith-35b',
    role: 'agent',
    displayName: 'Ornith-1.0 35B (MoE)',
    publisher: 'ornith-ai',
    license: 'MIT',
    vramLine: '24GB-stretch (CPU-offload) / 32GB-comfortable',
    note: MOE_HONESTY_NOTE,
    progressId: 'ornith-35b',
    ollamaTag: 'ornith:35b',
    ollamaApproxBytes: 21_000_000_000,
    llamacpp: { file: 'ornith-1.0-35b-Q4_K_M.gguf', approxBytes: 21_166_757_760, present: false, available: true },
    vllm: { runCommand: 'vllm serve ornith-ai/Ornith-1.0-35B' },
  },
  {
    id: 'qwen36-27b',
    role: 'agent',
    displayName: 'Qwen3.6-27B',
    publisher: 'unsloth',
    license: 'Apache-2.0',
    contextWindow: 262144,
    vramLine: '24GB-comfortable, tighter ctx (~24–40K)',
    note: 'Vision input is optional — llama-server needs the separate mmproj file (not downloaded here); text works without it.',
    progressId: 'qwen36-27b',
    ollamaTag: 'qwen3.6:27b',
    ollamaApproxBytes: 17_000_000_000,
    llamacpp: { file: 'Qwen3.6-27B-Q4_K_M.gguf', approxBytes: 16_817_244_384, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen3.6-27B' },
  },
  {
    id: 'gpt-oss-20b',
    role: 'agent',
    displayName: 'gpt-oss-20b',
    publisher: 'ggml-org',
    license: 'Apache-2.0',
    contextWindow: 131072,
    vramLine: '24GB-easy (100K+ ctx)',
    progressId: 'gpt-oss-20b',
    ollamaTag: 'gpt-oss:20b',
    ollamaApproxBytes: 14_000_000_000,
    llamacpp: { file: 'gpt-oss-20b-MXFP4.gguf', approxBytes: 12_109_566_624, present: false, available: true },
    // exception row (SC-2): openai is not allowlisted, but VLLM_ONLY_SERVE_REPOS carries it.
    vllm: { runCommand: 'vllm serve openai/gpt-oss-20b' },
  },
  {
    id: 'qwen36-35b-a3b',
    role: 'agent',
    displayName: 'Qwen3.6-35B-A3B',
    publisher: 'unsloth',
    license: 'Apache-2.0',
    vramLine: '24GB-stretch (offload) / 32GB-comfortable',
    note: MOE_HONESTY_NOTE,
    progressId: 'qwen36-35b-a3b',
    ollamaTag: 'qwen3.6:35b',
    ollamaApproxBytes: 24_000_000_000,
    llamacpp: { file: 'Qwen3.6-35B-A3B-UD-Q4_K_S.gguf', approxBytes: 20_893_015_008, present: false, available: true },
    vllm: { runCommand: 'vllm serve Qwen/Qwen3.6-35B-A3B' },
  },
  {
    id: 'sweep-next',
    role: 'next',
    defaultForRole: true,
    displayName: 'Sweep Next-Edit v2 (7B)',
    publisher: 'SyntinalCo',
    license: 'Apache-2.0',
    contextWindow: 32768,
    vramLine: 'Q4 ≈ 5 GB',
    progressId: 'sweep-next',
    ollamaCreatedName: 'sweep-next-edit-v2-7b:q4_k_m',
    ollamaApproxBytes: 4_680_000_000,
    // pinned verify, sha256:'' at HEAD -> available:false (fail-closed).
    llamacpp: { file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf', approxBytes: 4_680_000_000, present: false, available: false },
    // exception row (SC-2): sweepai is not allowlisted, but VLLM_ONLY_SERVE_REPOS carries it.
    vllm: { runCommand: 'vllm serve sweepai/sweep-next-edit-v2-7B' },
  },
];

// --- BASE_DATA: row 1 (baseline empty) — every other row is a diff off this --

const BASE_DATA: SetupData = {
  trusted: true,
  agent: { options: AGENT_OPTIONS_BASE, selectedId: 'hermes', phase: 'missing' },
  provider: { phase: 'waiting-agent' },
  fim: {
    options: FIM_OPTIONS_BASE,
    selectedId: 'ollama',
    enabled: true,
    model: 'qwen2.5-coder:1.5b-base',
    endpointValue: '',
    tuning: {
      debounceMs: 350,
      maxPromptTokens: 1024,
      temperature: 0.01,
      crossFileEnabled: true,
      prefixInjection: false,
      prefixInjectionRemote: false,
      warmUp: false,
    },
  },
  nextEdit: {
    source: 'off',
    backend: 'ollama',
    endpoint: '',
    model: '',
    dedicatedConfigured: false,
    genericSupported: true,
    dedicated: BASE_DEDICATED_NEXT,
  },
  rag: {
    enabled: true,
    embedEndpoint: 'http://127.0.0.1:11434',
    embedBackend: 'ollama',
    embedModel: 'qwen3-embedding:0.6b',
    tuning: { dims: 0, maxChunkTokens: 512, debounceMs: 500, excludeGlobs: [] },
    indexDir: '.hermes/index',
    endpointDefaults: RAG_ENDPOINT_DEFAULTS_FIXTURE,
  },
  ollama: { running: false, endpoint: 'http://127.0.0.1:11434', models: [] },
  catalog: { models: BASELINE_CATALOG },
  llamacppRuntime: { binary: 'checking' },
  agentLocalModel: { endpointDefaults: AGENT_ENDPOINT_DEFAULTS_FIXTURE },
  ready: false,
  os: { family: 'fedora', manager: 'dnf' },
};

// -----------------------------------------------------------------------------

describe('WS-GD.2b B1: status() whole-shape golden master (probe-permutation matrix)', () => {
  it('row 1: baseline empty — trusted, no settings, Ollama down, llama.cpp unsettled', async () => {
    const data = await statusFor();
    expect(data).toEqual(BASE_DATA);
  });

  it('row 2: untrusted — identical to baseline plus rag.preconditionDetail', async () => {
    const data = await statusFor({ trusted: false });
    expect(data).toEqual({
      ...BASE_DATA,
      trusted: false,
      rag: { ...BASE_DATA.rag, preconditionDetail: 'The codebase index needs a trusted, open workspace.' },
    });
  });

  it('row 3: agent ready — hermesPath+backend acp, an advertised auth method -> agent ready, provider configured, ready:true', async () => {
    const methods: AdvertisedAuthMethod[] = [{ id: 'anthropic', name: 'x' }];
    const data = await statusFor({
      settings: {
        'talaria.hermesPath': '/home/u/.local/share/pipx/venvs/hermes-agent/bin/hermes',
        'talaria.backend': 'acp',
      },
      deps: { getAdvertisedAuthMethods: () => methods },
    });
    // Surprising-but-verified (see report): `ready` does NOT require the
    // Ollama daemon to be reachable — computeReady only checks agentPhase +
    // providerPhase + fimGreen (backend 'available' + enabled + auth
    // satisfied), so this row flips ready:true even with Ollama still down.
    expect(data).toEqual({
      ...BASE_DATA,
      agent: { ...BASE_DATA.agent, phase: 'ready' },
      provider: { phase: 'configured', providerId: 'anthropic' },
      ready: true,
    });
  });

  it('row 4: Ollama up with models — only ollama.running/ollama.models change (FI-33: fim/rag no longer vary with the probe — the dead per-model presence echo was the only thing that used to)', async () => {
    const data = await statusFor({
      ollama: {
        running: true,
        models: [
          { name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 },
          { name: 'qwen3-embedding:0.6b', sizeBytes: 639_000_000 },
        ],
      },
    });
    expect(data).toEqual({
      ...BASE_DATA,
      ollama: {
        running: true,
        endpoint: 'http://127.0.0.1:11434',
        models: [
          { name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 },
          { name: 'qwen3-embedding:0.6b', sizeBytes: 639_000_000 },
        ],
      },
    });
  });

  it('row 5: saved agent model, valid — agentLocalModel.saved with servedName + providerGuidance', async () => {
    const data = await statusFor({
      settings: {
        'talaria.agent.localModel.modelId': 'devstral-24b',
        'talaria.agent.localModel.backend': 'ollama',
        'talaria.agent.localModel.endpoint': 'http://127.0.0.1:11434',
      },
    });
    expect(data).toEqual({
      ...BASE_DATA,
      agentLocalModel: {
        endpointDefaults: AGENT_ENDPOINT_DEFAULTS_FIXTURE,
        saved: {
          modelId: 'devstral-24b',
          backend: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          // hf-ingest tier -> servedNameFor returns the CREATED name, not a tag.
          servedName: 'devstral-small-2507:24b',
        },
        providerGuidance:
          'Local model ready. The provider step unlocks once Hermes is installed and connected — the Provider card below will show "Configure provider".',
      },
    });
  });

  it('row 6: saved agent model, corrupt backend — degrades to {endpointDefaults} only (fail-closed, no saved key)', async () => {
    const data = await statusFor({
      settings: {
        'talaria.agent.localModel.modelId': 'devstral-24b',
        'talaria.agent.localModel.backend': 'bogus',
        'talaria.agent.localModel.endpoint': 'http://127.0.0.1:11434',
      },
    });
    expect(data).toEqual(BASE_DATA);
  });

  it("row 7a: nextEdit.dedicatedBackendId='vllm' -> present on the wire", async () => {
    const data = await statusFor({ settings: { 'talaria.nextEdit.dedicatedBackendId': 'vllm' } });
    expect(data).toEqual({ ...BASE_DATA, nextEdit: { ...BASE_DATA.nextEdit, dedicatedBackendId: 'vllm' } });
  });

  it("row 7b: nextEdit.dedicatedBackendId='bogus' -> key OMITTED (falls back to baseline)", async () => {
    const data = await statusFor({ settings: { 'talaria.nextEdit.dedicatedBackendId': 'bogus' } });
    expect(data).toEqual(BASE_DATA);
  });

  it("row 8a: llama.cpp probe settles 'not-found' -> binary:'missing' + install guidance present", async () => {
    const controller = makeRawController({
      locateLlamaServer: async (): Promise<LlamaCppLocateResult> => ({
        ok: false,
        reason: 'not-found',
        detail: 'clean miss',
      }),
    });
    // Register the settle-listener BEFORE the first status() call — the fake
    // probe resolves immediately, so the settle can land during OR after
    // that first await; awaiting this promise afterwards is correct either way.
    const settled = new Promise<void>((resolve) => {
      controller.onStatusChanged(() => resolve());
    });
    await controller.status();
    await settled;
    const data = await controller.status();
    expect(data).toEqual({
      ...BASE_DATA,
      llamacppRuntime: {
        binary: 'missing',
        install: {
          command: 'sudo dnf install llama-cpp',
          guidance: 'llama-server was not found on your PATH. Install llama.cpp, then re-check.',
          docsUrl: 'https://packages.fedoraproject.org/search?query=llama-cpp',
        },
      },
    });
  });

  it("row 8b: llama.cpp probe settles 'probe-timeout' -> binary:'unknown', NO install key (CC-5)", async () => {
    const controller = makeRawController({
      locateLlamaServer: async (): Promise<LlamaCppLocateResult> => ({
        ok: false,
        reason: 'probe-timeout',
        detail: 'shell wedged',
      }),
    });
    const settled = new Promise<void>((resolve) => {
      controller.onStatusChanged(() => resolve());
    });
    await controller.status();
    await settled;
    const data = await controller.status();
    expect(data).toEqual({ ...BASE_DATA, llamacppRuntime: { binary: 'unknown' } });
  });

  // CA-M18 (single-flight, short-TTL memo over safeProbeOllama: back-to-back
  // status() calls share ONE probe; a bumpStatus-firing mutation like
  // setup.recheck invalidates the memo so the NEXT call re-probes) is already
  // pinned by SetupController.test.ts's own "CA-M18: back-to-back status()
  // passes share ONE Ollama probe" describe block (grep OLLAMA_PROBE_MEMO_TTL_MS
  // there) — not duplicated here per the plan's explicit instruction.
});
