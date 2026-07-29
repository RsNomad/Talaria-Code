import * as vscode from 'vscode';
import { isHttpUrl } from '../shared/url';
import type { FimBackendName } from './types';

/**
 * Config surface for this zone, read from `talaria.autocomplete.*`. The frozen
 * contract (Zone AC) names exactly: `enabled`, `backend`,
 * `endpoint`, `model`, `debounceMs`, `maxPromptTokens`, `temperature`. `apiKey` is
 * an extra key this zone needs for the optional cloud/remote backends (Codestral,
 * openai-compat with auth) — see the report's "open concerns" for what the
 * controller should add to `package.json`'s `contributes.configuration`.
 */
export interface HermesAutocompleteConfig {
  enabled: boolean;
  backend: FimBackendName;
  endpoint: string;
  model: string;
  debounceMs: number;
  maxPromptTokens: number;
  temperature: number;
  apiKey?: string;
  crossFile: CrossFileConfig;
}

/**
 * W5-T5 · `talaria.autocomplete.crossFile.*` (§4.5/B5). `prefixInjection` is
 * the RAW setting value — NOT yet loopback-gated. Callers must pass it
 * through `effectivePrefixInjection` (below) with the resolved endpoint's
 * loopback status before feeding it to `crossFileMode` (`context/mode.ts`).
 */
export interface CrossFileConfig {
  enabled: boolean;
  prefixInjection: boolean;
  prefixInjectionRemote: boolean;
  /** W5-T7 · `talaria.autocomplete.crossFile.warmUp` (default false, §2.4).
   *  Fires a llama.vim-style KV-cache warm-up on snapshot regeneration —
   *  only takes effect when the active backend implements `warmUp` (only
   *  `LlamaCppInfillBackend` this wave) and `egressPreconditionsMet()`
   *  holds. Default-off until Fedora P2 evidence decides default-on. */
  warmUp: boolean;
}

const DEFAULT_ENDPOINTS: Record<FimBackendName, string> = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
  vllm: 'http://127.0.0.1:8000',
  codestral: 'https://codestral.mistral.ai',
  'openai-compat': 'http://127.0.0.1:8000',
};

const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base';

function isFimBackendName(value: string): value is FimBackendName {
  return (
    value === 'ollama' ||
    value === 'llamacpp' ||
    value === 'vllm' ||
    value === 'codestral' ||
    value === 'openai-compat'
  );
}

export function readConfig(): HermesAutocompleteConfig {
  const cfg = vscode.workspace.getConfiguration('talaria.autocomplete');

  const rawBackend = cfg.get<string>('backend', 'ollama');
  const backend: FimBackendName = isFimBackendName(rawBackend)
    ? rawBackend
    : 'ollama';

  // Endpoint may be a REMOTE runner (by design) — we only reject a non-http(s)
  // scheme / garbage value and fall back to the backend default. No loopback
  // allow-listing (that would break the remote-runner architecture).
  //
  // The workspace-override vector is closed by `scope: "machine"` on EVERY
  // egress-DESTINATION key — `endpoint`, `apiKey`, AND (since audit C-4)
  // `backend`. `backend` was the hole: it SELECTS the endpoint via
  // DEFAULT_ENDPOINTS above, so a workspace that could set it could redirect
  // the buffer to `https://codestral.mistral.ai` without touching `endpoint`
  // at all.
  //
  // `model` is ALSO `scope: "machine"`, but for a DIFFERENT reason (review
  // I-1): a model NAME picks no network destination — see
  // `provider.test.ts`'s `restrictedConfigurations` comment, which makes
  // exactly this point for the separate trust-gate list. Locking `model`
  // guards against a workspace silently swapping WHICH model serves
  // completions (an integrity concern), not where bytes go. Keeping the two
  // rationales apart matters: conflating them here previously read as
  // asserting both "a model picks no destination" (true, provider.test.ts)
  // and "model is an egress-steering key" (this file, before this fix) at
  // once. Both lists are locked by `src/autocomplete/configScope.test.ts`
  // (`EGRESS_DESTINATION_PATTERN` and `MODEL_INTEGRITY_PATTERN`
  // respectively, both open-ended — not fixed lists).
  const rawEndpoint = cfg.get<string>('endpoint', '').trim();
  const endpoint = rawEndpoint && isHttpUrl(rawEndpoint) ? rawEndpoint : DEFAULT_ENDPOINTS[backend];
  const apiKey = cfg.get<string>('apiKey', '').trim();

  return {
    enabled: cfg.get<boolean>('enabled', true),
    backend,
    endpoint,
    model: cfg.get<string>('model', DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    debounceMs: cfg.get<number>('debounceMs', 350),
    maxPromptTokens: cfg.get<number>('maxPromptTokens', 1024),
    temperature: cfg.get<number>('temperature', 0.01),
    apiKey: apiKey || undefined,
    crossFile: {
      enabled: cfg.get<boolean>('crossFile.enabled', true),
      prefixInjection: cfg.get<boolean>('crossFile.prefixInjection', false),
      prefixInjectionRemote: cfg.get<boolean>('crossFile.prefixInjectionRemote', false),
      warmUp: cfg.get<boolean>('crossFile.warmUp', false),
    },
  };
}

/**
 * §4.5 / B5 — the LOOPBACK gate (pure). `crossFile.prefixInjection` alone
 * must not silently authorize sending workspace SNIPPETS (not just the
 * active file's prefix/suffix, which v1 already egresses) to whatever
 * REMOTE endpoint a comment-inject backend (Ollama/Codestral/openai-compat)
 * is configured against. Comment-injection is only effectively "on" when
 * EITHER the resolved endpoint is loopback OR the user has set the explicit
 * `prefixInjectionRemote` override — so enabling injection for a local
 * Ollama does not silently start egressing snippets the moment someone
 * repoints the endpoint at a cloud runner.
 *
 * `endpointIsLoopback` is the caller's already-resolved
 * `isLoopbackHost(new URL(endpoint).hostname)` result (`index.ts` already
 * computes this for S4.3's Restricted-Mode guard — reused here, not
 * duplicated).
 */
export function effectivePrefixInjection(
  cfg: Pick<CrossFileConfig, 'prefixInjection' | 'prefixInjectionRemote'>,
  endpointIsLoopback: boolean,
): boolean {
  return cfg.prefixInjection && (endpointIsLoopback || cfg.prefixInjectionRemote);
}
