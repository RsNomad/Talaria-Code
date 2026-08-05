/**
 * Backend registry — the declarative spine of Setup / Talaria Config
 * (onboarding-backend-setup-architecture.md §4, Task 3).
 *
 * PURE DATA + TYPES, zero `vscode` imports (unit-testable headless; the same
 * discipline `src/host/purityScan.ts` mechanizes elsewhere — and
 * `registry.test.ts` (h) turns that ban into a scan over this directory).
 * Zero imports of ANY kind, in fact: every string here is data, drift-locked
 * by `registry.test.ts` against its real source of truth
 * (`src/autocomplete/config.ts` DEFAULT_ENDPOINTS/DEFAULT_MODEL,
 * `src/autocomplete/apiKey.ts` AUTOCOMPLETE_API_KEY_SECRET, package.json's
 * `talaria.rag.embedModel` default, and the Hermes §2.1 packaging facts).
 */

export type BackendStatus = 'available' | 'coming-soon';
export type BackendKindTag = 'agent' | 'fim';

export interface EndpointField {
  settingKey: string;            // e.g. 'talaria.autocomplete.endpoint'
  defaultValue: string;          // mirrors config.ts DEFAULT_ENDPOINTS verbatim
  placeholder: string;
}

export type AuthSpec =
  | { kind: 'none' }
  | { kind: 'apiKey'; required: boolean;
      /** SecretStorage key — v1 FIM entries all reuse AUTOCOMPLETE_API_KEY_SECRET
       *  (one active FIM backend at a time; matches the existing engine). */
      secretKey: string }
  | { kind: 'env'; vars: { name: string; description: string; secret: boolean }[] };

export type ProbeSpec =
  | { kind: 'ollama-tags' }      // GET /api/tags        → models[]          (§2.4)
  | { kind: 'llamacpp-health' }  // GET /health          → {status:"ok"}|503 (§2.5)
  | { kind: 'openai-models' }    // GET /v1/models (+Bearer if key)          (§2.5)
  | { kind: 'none' };            // no unauthenticated probe (codestral)

export type InstallRecipe =
  | { kind: 'pipx';
      packageSpec: string;       // `hermes-agent[acp]==${HERMES_PIN}` — extras REQUIRED (§2.1)
      pinnedVersion: string;     // = HERMES_PIN; bumped intentionally per extension release
      pythonRange: { minInclusive: string; maxExclusive: string }; // '3.11' / '3.14'
      apps: { main: string; acpCheck?: string };  // console-script names
      postCheck: { app: string; args: string[]; expectStdoutIncludes: string } }
  | { kind: 'guided-terminal';   // we OPEN a terminal with the command pre-typed; user runs it
      command: string; docsUrl: string;
      /** beta.5 T6 (§1.2 A3): when set, `SetupController.handleOpenInstallTerminal`
       *  overrides `command` with the OS engine's (`packageTable.ts`) verified
       *  line for the detected family — fail-open CLOSED (S-F9): a family
       *  with no engine entry for this key REFUSES instead of falling back
       *  to this recipe's own static `command` (which is Fedora-shaped and
       *  would be the wrong line on another distro). Absent (e.g. ollama's
       *  vendor-script recipe) ⇒ `command` is used as-is, untouched, on
       *  every family — no OS engine read at all. */
      packageKey?: 'llamacpp' }
  | { kind: 'docs-only';         // beta.5 §5.2 rev 3 (⑪): no verified install
      // source exists to compose a command from — guidance-only, a docs
      // link plus the endpoint Test affordance. Nothing executes ⇒ nothing
      // to the §5.2 source ledger.
      docsUrl: string };

export interface LocalInstallMode {
  recipe: InstallRecipe;
  /** Honesty label rendered on the card, e.g. 'clean one-script install' vs
   *  'manual install — needs your own build/hardware decisions'. */
  effort: 'one-script' | 'manual-guided';
  /** Model provisioning once the server is reachable (Ollama only in v1). */
  models?: { pull: 'ollama-api';
             defaults: { role: 'fim' | 'embedding'; model: string; settingKey: string }[] };
}

export interface RemoteMode {
  endpoint: EndpointField;
  auth: AuthSpec;
  probe: ProbeSpec;
}

export interface BackendDescriptor {
  id: string;
  kind: BackendKindTag;
  status: BackendStatus;          // 'coming-soon' ⇒ visible, disabled, stub-only
  displayName: string;
  description: string;            // one honest sentence for the card
  transport: 'stdio' | 'http';
  /** Static settings written on Apply (dynamic ones — hermesPath/pythonPath —
   *  come from the install result via SetupController). */
  settingsToActivate: Record<string, string>;
  remote?: RemoteMode;            // path A — co-equal, not an afterthought
  localInstall?: LocalInstallMode;// path B
  /** For FIM entries that can also serve dedicated-NEXT: how to map onto the
   *  nextEdit transport enum ('ollama' | 'openai-compat') — vllm/llamacpp ride
   *  'openai-compat' (§2.3 NEXT row). Absent ⇒ not offered in NEXT setup. */
  nextEditTransport?: 'ollama' | 'openai-compat';
  docsUrl?: string;
}
// Invariant (enforced by registry.test.ts): status==='available' ⇒ remote or
// localInstall present; 'coming-soon' ⇒ both absent.

export const HERMES_PIN = '0.18.2'; // ⚠ controller decision D10 — single source

/**
 * SecretStorage key every v1 FIM `apiKey` auth reuses — the string equals
 * `src/autocomplete/apiKey.ts` AUTOCOMPLETE_API_KEY_SECRET (drift-locked by
 * `registry.test.ts` (d); deliberately NOT imported so this module keeps
 * ZERO imports).
 */
const FIM_API_KEY_SECRET = 'talaria.autocomplete.apiKey';

/** Every FIM entry's endpoint lives under the one autocomplete endpoint key. */
const FIM_ENDPOINT_KEY = 'talaria.autocomplete.endpoint';

export const AGENT_BACKENDS: readonly BackendDescriptor[] = [
  {
    id: 'hermes',
    kind: 'agent',
    status: 'available',
    displayName: 'Hermes',
    description:
      'Open-source agent harness by Nous Research — installed from PyPI into an isolated pipx venv; talks ACP over stdio.',
    transport: 'stdio',
    settingsToActivate: { 'talaria.backend': 'acp' },
    localInstall: {
      recipe: {
        kind: 'pipx',
        // §2.1: bare `hermes-agent` yields a `hermes acp` that dies on
        // `import acp` — the [acp] extra is REQUIRED, never optional.
        packageSpec: `hermes-agent[acp]==${HERMES_PIN}`,
        pinnedVersion: HERMES_PIN,
        // pyproject `requires-python = ">=3.11,<3.14"` (upper bound
        // load-bearing: Rust transitives lack cp314 wheels).
        pythonRange: { minInclusive: '3.11', maxExclusive: '3.14' },
        // pyproject [project.scripts] console entry points.
        apps: { main: 'hermes', acpCheck: 'hermes-acp' },
        // `hermes-acp --check` → exit 0 + this marker (acp_adapter/entry.py).
        postCheck: { app: 'hermes-acp', args: ['--check'], expectStdoutIncludes: 'Hermes ACP check OK' },
      },
      effort: 'one-script',
    },
  },
  {
    id: 'openclaw',
    kind: 'agent',
    status: 'coming-soon',
    displayName: 'OpenClaw',
    description: 'Coming soon — not yet available in this release.',
    transport: 'stdio',
    settingsToActivate: {},
  },
  {
    id: 'talaria-ai',
    kind: 'agent',
    status: 'coming-soon',
    displayName: 'Talaria AI',
    description: 'Coming soon — not yet available in this release.',
    transport: 'http',
    settingsToActivate: {},
  },
];

export const FIM_BACKENDS: readonly BackendDescriptor[] = [
  {
    id: 'ollama',
    kind: 'fim',
    status: 'available',
    displayName: 'Ollama',
    description:
      'Local model runner with one-script install and in-panel model pulls; also serves the embedding model for the codebase index.',
    transport: 'http',
    settingsToActivate: { 'talaria.autocomplete.backend': 'ollama' },
    remote: {
      endpoint: {
        settingKey: FIM_ENDPOINT_KEY,
        defaultValue: 'http://127.0.0.1:11434',
        placeholder: 'http://127.0.0.1:11434',
      },
      auth: { kind: 'none' },
      probe: { kind: 'ollama-tags' },
    },
    localInstall: {
      recipe: {
        kind: 'guided-terminal',
        command: 'curl -fsSL https://ollama.com/install.sh | sh',
        docsUrl: 'https://ollama.com/download/linux',
      },
      effort: 'one-script',
      models: {
        pull: 'ollama-api',
        defaults: [
          // = config.ts DEFAULT_MODEL (drift-locked by registry.test.ts (f)).
          { role: 'fim', model: 'qwen2.5-coder:1.5b-base', settingKey: 'talaria.autocomplete.model' },
          // = package.json talaria.rag.embedModel default — the embedding
          // role rides this card because rag.embedEndpoint already defaults
          // to the same daemon (§2.4).
          { role: 'embedding', model: 'qwen3-embedding:0.6b', settingKey: 'talaria.rag.embedModel' },
        ],
      },
    },
    nextEditTransport: 'ollama',
  },
  {
    id: 'llamacpp',
    kind: 'fim',
    status: 'available',
    displayName: 'llama.cpp',
    description:
      'llama-server with native FIM — manual install (release binary, distro package, or your own build); we do not build it for you.',
    transport: 'http',
    settingsToActivate: { 'talaria.autocomplete.backend': 'llamacpp' },
    remote: {
      endpoint: {
        settingKey: FIM_ENDPOINT_KEY,
        defaultValue: 'http://127.0.0.1:8080',
        placeholder: 'http://127.0.0.1:8080',
      },
      auth: { kind: 'apiKey', required: false, secretKey: FIM_API_KEY_SECRET },
      probe: { kind: 'llamacpp-health' },
    },
    localInstall: {
      recipe: {
        kind: 'guided-terminal',
        // §4 table pins only "docs link" for llama.cpp (binary/dnf/build —
        // we don't build it); `packageKey: 'llamacpp'` (T6) hands command
        // resolution to the OS engine (`packageTable.ts`) for the detected
        // family — this static `command` is the Fedora value, owner-live-
        // verified on Fedora 44, and is used ONLY as the engine's own
        // fedora entry happens to equal it; every other family resolves
        // through the engine (or refuses fail-closed, never this line).
        command: 'sudo dnf install llama-cpp',
        docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
        packageKey: 'llamacpp',
      },
      effort: 'manual-guided',
    },
    nextEditTransport: 'openai-compat',
  },
  {
    id: 'vllm',
    kind: 'fim',
    status: 'available',
    displayName: 'vLLM',
    description:
      'High-throughput OpenAI-compatible server — manual install (multi-GB CUDA/torch download, hardware-bound).',
    transport: 'http',
    settingsToActivate: { 'talaria.autocomplete.backend': 'vllm' },
    remote: {
      endpoint: {
        settingKey: FIM_ENDPOINT_KEY,
        defaultValue: 'http://127.0.0.1:8000',
        placeholder: 'http://127.0.0.1:8000',
      },
      auth: { kind: 'apiKey', required: false, secretKey: FIM_API_KEY_SECRET },
      probe: { kind: 'openai-models' },
    },
    localInstall: {
      // §5.2 rev 3 (⑪): the beta.3 pip-based recipe (unpinned, PEP-668-
      // hostile, hardware-specific, "provisional" since beta.3) had no
      // verified source to compose a command from — deleted. docs.vllm.ai
      // is the authoritative path; the tab offers the docs link plus the
      // endpoint Test affordance only. Nothing executes ⇒ nothing to the
      // §5.2 source ledger.
      recipe: { kind: 'docs-only', docsUrl: 'https://docs.vllm.ai/' },
      effort: 'manual-guided',
    },
    // R-1a: `SetupController.projectBackend` (`SetupController.ts:963-979`)
    // projects only this DESCRIPTOR-level `docsUrl` onto the wire, never a
    // recipe-level one — without this the docs-only tab would render
    // linkless.
    docsUrl: 'https://docs.vllm.ai/',
    nextEditTransport: 'openai-compat',
  },
  {
    id: 'codestral',
    kind: 'fim',
    status: 'available',
    displayName: 'Codestral (Mistral)',
    description:
      'Mistral’s hosted FIM API — remote-only; requires an API key (stored in your OS keychain, never in settings).',
    transport: 'http',
    settingsToActivate: { 'talaria.autocomplete.backend': 'codestral' },
    remote: {
      endpoint: {
        settingKey: FIM_ENDPOINT_KEY,
        defaultValue: 'https://codestral.mistral.ai',
        placeholder: 'https://codestral.mistral.ai',
      },
      auth: { kind: 'apiKey', required: true, secretKey: FIM_API_KEY_SECRET },
      probe: { kind: 'none' },
    },
  },
  {
    id: 'openai-compat',
    kind: 'fim',
    status: 'available',
    displayName: 'OpenAI-compatible server',
    description:
      'Bring your own OpenAI-compatible endpoint — strictly-spec servers may reject Talaria’s extra fields; prefer the vllm/ollama/llamacpp entries when one fits.',
    transport: 'http',
    settingsToActivate: { 'talaria.autocomplete.backend': 'openai-compat' },
    remote: {
      endpoint: {
        settingKey: FIM_ENDPOINT_KEY,
        defaultValue: 'http://127.0.0.1:8000',
        placeholder: 'http://127.0.0.1:8000',
      },
      auth: { kind: 'apiKey', required: false, secretKey: FIM_API_KEY_SECRET },
      probe: { kind: 'openai-models' },
    },
    nextEditTransport: 'openai-compat',
  },
];

export function getBackend(id: string): BackendDescriptor | undefined {
  return (
    AGENT_BACKENDS.find((d) => d.id === id) ?? FIM_BACKENDS.find((d) => d.id === id)
  );
}
