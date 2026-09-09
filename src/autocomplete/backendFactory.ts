import { OllamaFimBackend } from './backends/OllamaFimBackend';
import { LlamaCppInfillBackend } from './backends/LlamaCppInfillBackend';
import { VllmFimBackend } from './backends/VllmFimBackend';
import { CodestralFimBackend } from './backends/CodestralFimBackend';
import { OpenAICompatFimBackend } from './backends/OpenAICompatFimBackend';
import { DEFAULT_ENDPOINTS } from './endpoints';
import type { FimBackend } from './types';
// Type-only import: erased at compile time (isolatedModules), so this module never
// actually pulls in `vscode` at runtime — keeps it usable from a plain unit test.
import type { HermesAutocompleteConfig } from './config';
import { OnceRegistry } from './onceRegistry';

/**
 * T-6 F4/F6: construction-time warnings for self-documented-broken
 * configurations `createBackend` can detect WITHOUT making a single request
 * — a configured key `createBackend` will never send (F4) and a
 * backend/endpoint or backend/model pairing this codebase's OWN backend doc
 * comments already document as broken (F6). `createBackend` itself must
 * NEVER throw (see the `codestral` arm's own comment below) — these are
 * warn-only, no behavior/egress change.
 *
 * `console.warn`, not `vscode.window.showWarningMessage`: this module
 * deliberately imports no `vscode` (only a type-only import, erased at
 * compile time — see above), which is what keeps `createBackend` "usable
 * from a plain unit test" and safe to call SYNCHRONOUSLY during
 * `activate()`, before SecretStorage's async load resolves (the codestral
 * arm's own comment explains why that matters). Routing this through
 * `vscode.window` would reintroduce exactly the dependency that property
 * exists to avoid.
 *
 * FI-26 (FSU §5 Q4): dedup now runs through the second, optional
 * `registry` parameter below (an {@link OnceRegistry} — `index.ts`'s
 * `buildEngine` threads its ONE activation-scoped instance through here),
 * not a bare module-level `Set`. `defaultRegistry` exists only so every
 * existing direct caller of `createBackend` (this module's own tests
 * included) that omits the parameter keeps working unchanged — production
 * (`index.ts`) always passes the real instance explicitly. Because the
 * registry now outlives an engine rebuild by construction, `index.ts` no
 * longer re-arms these warnings per rebuild (see its own `rebuild()` for
 * the FSU §5 Q4 lifetime note); {@link clearBackendFactoryWarnings} is kept
 * as the reset primitive for `defaultRegistry`, which only test callers
 * that omit `registry` ever observe.
 */
const defaultRegistry = new OnceRegistry();

/** Resets {@link defaultRegistry} — the fallback `createBackend` uses when
 *  called without an explicit `registry` argument. See that parameter's own
 *  doc comment for why production no longer calls this on every rebuild. */
export function clearBackendFactoryWarnings(): void {
  defaultRegistry.reset();
}

/** F6: vLLM's OWN default port, derived from the pure leaf's single source of
 *  truth (`endpoints.ts`'s `DEFAULT_ENDPOINTS.vllm`) rather than restated as
 *  a literal — FI-22: this file now imports the leaf directly instead of
 *  duplicating its rows. */
const VLLM_DEFAULT_PORT = new URL(DEFAULT_ENDPOINTS.vllm).port;

/** CA-8 (audit-3): `DEFAULT_ENDPOINTS['openai-compat']` — this backend's OWN
 *  shipped default happens to sit on vLLM's default port too, so without this
 *  the F6 vLLM-port heuristic below fires on a completely untouched,
 *  freshly-installed openai-compat config — the extension warning about its
 *  own default. Does NOT change the default port/endpoint value; only
 *  suppresses the self-warning for it. */
const OPENAI_COMPAT_DEFAULT_ENDPOINT = DEFAULT_ENDPOINTS['openai-compat'];

/** `undefined` on anything `URL` can't parse — `cfg.endpoint` is normally
 *  already `isHttpUrl`-validated by `config.ts:readConfig`, but a hand-built
 *  config (this function is exported and callable directly, not only via
 *  `readConfig`) can pass anything, and this warning must never throw. */
function endpointPort(rawEndpoint: string): string | undefined {
  try {
    return new URL(rawEndpoint).port;
  } catch {
    return undefined;
  }
}

/** Slash/canonicalization-tolerant, never-throw endpoint equality —
 *  `cfg.endpoint` may now be stored WHATWG-canonical (`'…:8000/'`) after
 *  `setup.applyFim` normalization (beta.6 L1-I-1,
 *  `src/host/setup/remoteProbe.ts`'s `validateEndpointUrl`), while
 *  `OPENAI_COMPAT_DEFAULT_ENDPOINT` below is authority-only (never
 *  re-canonicalized — see that constant's own doc comment for why). Same
 *  no-throw contract as {@link endpointPort} above. */
function sameEndpoint(a: string, b: string): boolean {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
}

/**
 * Builds the configured `FimBackend` from `talaria.autocomplete.*` settings.
 *
 * FI-26: `registry` is the {@link OnceRegistry} `warnOnce` below dedupes
 * against — optional, defaulting to {@link defaultRegistry}, so every
 * existing caller that omits it (this module's own tests) keeps its
 * pre-existing per-call-site-shared-default behavior unchanged; `index.ts`'s
 * `buildEngine` always passes its ONE real activation-scoped instance.
 */
export function createBackend(cfg: HermesAutocompleteConfig, registry: OnceRegistry = defaultRegistry): FimBackend {
  const warnOnce = (key: string, message: string): void => {
    if (registry.has(key)) return;
    registry.add(key);
    console.warn(`[talaria.autocomplete] ${message}`);
  };

  switch (cfg.backend) {
    case 'ollama':
      // F4: `OllamaFimBackendOptions` has no `apiKey` field at all —
      // `/api/generate` has no auth story this codebase speaks to, so a
      // configured key is silently dropped on the floor here with no
      // signal anywhere else (this backend never even sees `cfg.apiKey`).
      if (cfg.apiKey && cfg.apiKey.trim().length > 0) {
        warnOnce(
          'ollama-key-dropped',
          'talaria.autocomplete.apiKey is set, but backend=ollama has no authentication of its own — the key will never be sent. Clear the key, or switch to a backend that supports one.',
        );
      }
      return new OllamaFimBackend({ apiBase: cfg.endpoint, model: cfg.model });
    case 'llamacpp':
      return new LlamaCppInfillBackend({ apiBase: cfg.endpoint, ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}) });
    case 'vllm':
      // F6: vLLM serves models by their own repo id / `--served-model-name`,
      // never Ollama's `name:tag` convention — audit finding F-B: this is
      // true of `config.ts`'s own DEFAULT_MODEL, so a fresh, untouched vLLM
      // config hits this on the very first build.
      if (cfg.model.includes(':')) {
        warnOnce(
          'vllm-ollama-style-model',
          `talaria.autocomplete.model ("${cfg.model}") looks like an Ollama-style "name:tag" — vLLM serves models by their own repo id/served-name and will likely 404 on this exact string. Set "talaria.autocomplete.model" to the name your vLLM server actually serves.`,
        );
      }
      return new VllmFimBackend({ apiBase: cfg.endpoint, model: cfg.model, ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}) });
    case 'codestral':
      // Review C-1 (was audit C-4's fix): this function must NEVER throw.
      // `index.ts`'s `buildEngine` calls `createBackend` SYNCHRONOUSLY at
      // activation, before SecretStorage's async load has resolved — so the
      // FIRST call any activation makes always sees `cfg.apiKey === undefined`
      // even for the correct, documented "key lives in SecretStorage"
      // configuration, and runs whether or not autocomplete is even enabled
      // (`buildEngine` runs before any `cfg.enabled` check). A throw here
      // previously escaped `activate()` itself (`extension.ts` has no
      // try/catch around `registerTalariaAutocomplete`), killing every zone
      // registered after autocomplete (RAG, the LSP/MCP lib server, the
      // dashboard, ...).
      //
      // The refusal now lives on the dangerous REQUEST path instead —
      // `CodestralFimBackend.streamFim` — which only ever runs when a
      // completion is actually attempted, by which point the async key load
      // has long since resolved (or the zone was never asked to complete at
      // all). Egress guards still fail toward LESS egress: the request-side
      // guard fires before `assertSecureAuthTransport`/`fetch`, so a
      // genuinely keyless build still makes ZERO network calls — it just
      // doesn't throw at CONSTRUCTION time anymore. See
      // `activationDoesNotThrow.test.ts` for the real-activation regression
      // proof and `CodestralFimBackend.ts` for the request-side guard.
      return new CodestralFimBackend({ apiBase: cfg.endpoint, apiKey: cfg.apiKey ?? '', model: cfg.model });
    case 'openai-compat':
      // F6: `OpenAICompatFimBackend`'s own doc comment already says not to
      // point it at vLLM (400-rejects the `suffix` field this backend
      // sends) — vLLM's DEFAULT port is the one signal available here
      // without a request, so an endpoint on that exact port is worth a
      // heads-up. CA-8 (audit-3): EXCEPT when `cfg.endpoint` is exactly this
      // backend's own shipped default — that endpoint is what a fresh,
      // untouched openai-compat config already has, and warning about it
      // was the extension flagging its own default as broken. A DIFFERENT
      // host on port 8000 still gets the heads-up (it's ambiguous whether
      // that's really a vLLM server), only the exact-default case is silent.
      if (!sameEndpoint(cfg.endpoint, OPENAI_COMPAT_DEFAULT_ENDPOINT) && endpointPort(cfg.endpoint) === VLLM_DEFAULT_PORT) {
        warnOnce(
          'openai-compat-vllm-port',
          `talaria.autocomplete.endpoint (${cfg.endpoint}) uses vLLM's default port with backend=openai-compat — vLLM 400-rejects the "suffix" field this backend sends. If this endpoint really is a vLLM server, switch "talaria.autocomplete.backend" to "vllm" instead.`,
        );
      }
      return new OpenAICompatFimBackend({
        apiBase: cfg.endpoint,
        ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
        model: cfg.model,
      });
    default: {
      // F-1: fail closed, not wrong. `readConfig()` validates via
      // `isFimBackendName` (config.ts:66-69), so this branch is unreachable
      // through the normal path — reachable only by a hand-built config that
      // bypasses that validation. It must never silently coerce to Ollama:
      // that would speak the Ollama dialect to whatever foreign endpoint the
      // user configured, with no signal to the user that anything is wrong.
      // `exhausted: never` also makes this compiler-visible — if
      // `FimBackendName` gains a member and a case is missed, check-types fails.
      const exhausted: never = cfg.backend;
      throw new Error(`Unknown autocomplete backend: ${String(exhausted)}`);
    }
  }
}
