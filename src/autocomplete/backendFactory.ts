import { OllamaFimBackend } from './backends/OllamaFimBackend';
import { LlamaCppInfillBackend } from './backends/LlamaCppInfillBackend';
import { VllmFimBackend } from './backends/VllmFimBackend';
import { CodestralFimBackend } from './backends/CodestralFimBackend';
import { OpenAICompatFimBackend } from './backends/OpenAICompatFimBackend';
import type { FimBackend } from './types';
// Type-only import: erased at compile time (isolatedModules), so this module never
// actually pulls in `vscode` at runtime — keeps it usable from a plain unit test.
import type { HermesAutocompleteConfig } from './config';

/**
 * T-6 F4/F6: construction-time, once-per-rebuild warnings for
 * self-documented-broken configurations `createBackend` can detect WITHOUT
 * making a single request — a configured key `createBackend` will never
 * send (F4) and a backend/endpoint or backend/model pairing this codebase's
 * OWN backend doc comments already document as broken (F6). `createBackend`
 * itself must NEVER throw (see the `codestral` arm's own comment below) —
 * these are warn-only, no behavior/egress change.
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
 * Deduped by a fixed per-warning key, re-armed by
 * {@link clearBackendFactoryWarnings} — `index.ts`'s `rebuild()` calls it on
 * every `hermes.autocomplete.*` config change, the SAME re-arm discipline
 * `provider.ts`'s `clearSurfacedAutocompleteFailures` already uses for its
 * own (request-time) warnings — so a user who fixes (or re-breaks) their
 * config gets a fresh signal on the very next build instead of either
 * spamming every rebuild or going silent forever.
 */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[hermes.autocomplete] ${message}`);
}

/** Re-arms every construction-time warning `createBackend` can emit — see
 *  {@link warnOnce}'s doc comment for the re-arm discipline this exists for. */
export function clearBackendFactoryWarnings(): void {
  warnedOnce.clear();
}

/** F6: vLLM's OWN default port (`config.ts`'s unexported `DEFAULT_ENDPOINTS.vllm`,
 *  `'http://127.0.0.1:8000'`) — duplicated as a literal rather than exporting
 *  that constant, so this file's dependency surface stays exactly what it was. */
const VLLM_DEFAULT_PORT = '8000';

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

/** Builds the configured `FimBackend` from `hermes.autocomplete.*` settings. */
export function createBackend(cfg: HermesAutocompleteConfig): FimBackend {
  switch (cfg.backend) {
    case 'ollama':
      // F4: `OllamaFimBackendOptions` has no `apiKey` field at all —
      // `/api/generate` has no auth story this codebase speaks to, so a
      // configured key is silently dropped on the floor here with no
      // signal anywhere else (this backend never even sees `cfg.apiKey`).
      if (cfg.apiKey && cfg.apiKey.trim().length > 0) {
        warnOnce(
          'ollama-key-dropped',
          'hermes.autocomplete.apiKey is set, but backend=ollama has no authentication of its own — the key will never be sent. Clear the key, or switch to a backend that supports one.',
        );
      }
      return new OllamaFimBackend({ apiBase: cfg.endpoint, model: cfg.model });
    case 'llamacpp':
      return new LlamaCppInfillBackend({ apiBase: cfg.endpoint, apiKey: cfg.apiKey });
    case 'vllm':
      // F6: vLLM serves models by their own repo id / `--served-model-name`,
      // never Ollama's `name:tag` convention — audit finding F-B: this is
      // true of `config.ts`'s own DEFAULT_MODEL, so a fresh, untouched vLLM
      // config hits this on the very first build.
      if (cfg.model.includes(':')) {
        warnOnce(
          'vllm-ollama-style-model',
          `hermes.autocomplete.model ("${cfg.model}") looks like an Ollama-style "name:tag" — vLLM serves models by their own repo id/served-name and will likely 404 on this exact string. Set "hermes.autocomplete.model" to the name your vLLM server actually serves.`,
        );
      }
      return new VllmFimBackend({ apiBase: cfg.endpoint, model: cfg.model, apiKey: cfg.apiKey });
    case 'codestral':
      // Review C-1 (was audit C-4's fix): this function must NEVER throw.
      // `index.ts`'s `buildEngine` calls `createBackend` SYNCHRONOUSLY at
      // activation, before SecretStorage's async load has resolved — so the
      // FIRST call any activation makes always sees `cfg.apiKey === undefined`
      // even for the correct, documented "key lives in SecretStorage"
      // configuration, and runs whether or not autocomplete is even enabled
      // (`buildEngine` runs before any `cfg.enabled` check). A throw here
      // previously escaped `activate()` itself (`extension.ts` has no
      // try/catch around `registerHermesAutocomplete`), killing every zone
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
      // heads-up even though it is ALSO this backend's own default.
      if (endpointPort(cfg.endpoint) === VLLM_DEFAULT_PORT) {
        warnOnce(
          'openai-compat-vllm-port',
          `hermes.autocomplete.endpoint (${cfg.endpoint}) uses vLLM's default port with backend=openai-compat — vLLM 400-rejects the "suffix" field this backend sends. If this endpoint really is a vLLM server, switch "hermes.autocomplete.backend" to "vllm" instead.`,
        );
      }
      return new OpenAICompatFimBackend({
        apiBase: cfg.endpoint,
        apiKey: cfg.apiKey,
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
