/**
 * Remote-endpoint probes + URL validation for the FIM backends the user
 * connects to by endpoint (onboarding-backend-setup-architecture.md §2.5,
 * Task 7 of the onboarding/backend-setup plan — final task of Phase 1).
 *
 * PURE LOGIC — no `vscode` import (drift-locked by `registry.test.ts` (h)'s
 * `purityScan` sweep over every non-test module under `src/host/setup/`,
 * which already covers this file with zero changes needed there). Every
 * network call is routed through the caller-injected `fetchImpl` (typed
 * `typeof fetch`), so unit tests never touch a real socket — same
 * discipline `ollamaClient.ts` applies one module over.
 *
 * Shapes grounded via Context7, re-verified 2026-08-04:
 *   - `ollama-tags`: reuses {@link probeOllama} (`GET {endpoint}/api/tags`,
 *     §2.4) rather than re-deriving `/api/tags` here — one source of truth
 *     for that shape, matching this module's own DRY brief.
 *   - `llamacpp-health` (`/ggml-org/llama.cpp` tools/server/README.md):
 *     `GET {endpoint}/health` → `200 {"status":"ok"}` once the model is
 *     loaded; `503 {"error":{"code":503,"message":"Loading
 *     model","type":"unavailable_error"}}` while it isn't. Public — no API
 *     key ever attached.
 *   - `openai-models` (vLLM docs, OpenAI-compatible listing): `GET
 *     {endpoint}/v1/models` → `200 {"object":"list","data":[{"id":…,
 *     "object":"model",…}]}`; `Authorization: Bearer <apiKey>` attached
 *     ONLY when a key is configured (vLLM's own disaggregated-serving
 *     example applies the identical "attach iff present" rule). A `401`
 *     means the key was rejected — surfaced as a fixed, honest detail
 *     rather than leaking the provider's own error body.
 *   - `none` (codestral): remote SaaS with no unauthenticated probe (§2.5)
 *     — resolves immediately with a fixed detail and makes NO network call.
 */

import type { ProbeSpec } from './registry';
import { probeOllama } from './ollamaClient';

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
  models?: string[];
}

/** Same probe-timeout default `ollamaClient.ts`'s `probeOllama` uses —
 *  reachability checks are best-effort, not something a user should wait
 *  seconds for. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/**
 * Best-effort reachability probe for a remote FIM endpoint. NEVER throws —
 * every failure mode (connection refused, timeout, non-2xx, unparseable
 * body) resolves to `{ok:false, detail}` rather than rejecting, so a caller
 * can render a probe result unconditionally.
 */
export async function probeRemote(
  spec: ProbeSpec,
  endpoint: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ProbeOutcome> {
  switch (spec.kind) {
    case 'ollama-tags':
      return probeOllamaTags(endpoint, fetchImpl);
    case 'llamacpp-health':
      return probeLlamaCppHealth(endpoint, fetchImpl);
    case 'openai-models':
      return probeOpenAiModels(endpoint, apiKey, fetchImpl);
    case 'none':
      // §2.5: codestral has no unauthenticated probe — no network call.
      return { ok: true, detail: 'no probe for this backend' };
  }
}

/**
 * Shape-only validation that a user-typed endpoint is a well-formed
 * `http(s)` URL — deliberately host-agnostic (a legitimately remote endpoint
 * is not an error), rejecting only malformed input and non-http(s) schemes.
 *
 * beta.6 L1-I-1 (security): this is the ONE chokepoint every `showModal`
 * confirmation site reads (`SetupController.ts`'s `applyFim`,
 * `setNextEdit`, `saveAgentModel`, `setRag`, and the three `provisionOllama`
 * arms) — it MUST return the WHATWG-parser's own canonical serialization
 * (`parsed.toString()`), never the raw input string. The raw string can
 * carry control/bidi-override characters (forged modal text, or a host that
 * *displays* as `127.0.0.1` while a bidi override makes it *resolve*
 * elsewhere) — re-serializing through `new URL()` is forge-proof by
 * construction (percent-encodes controls/bidi, punycodes homograph hosts)
 * rather than depending on a hand-maintained unsafe-character blocklist.
 * Userinfo (`user:pass@host`) is explicitly REFUSED, not silently stripped:
 * `.toString()` preserves it (verified), and silently dropping it would
 * change the endpoint's meaning behind the user's back — credentials belong
 * in the dedicated keychain-backed API-key field, not the address.
 */
export function validateEndpointUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'Enter a valid http:// or https:// URL.' };
  }
  // Same scheme discipline as isHttpUrl (kept as the single source for its
  // other callers — src/autocomplete/config.ts, rag); inlined here so we can
  // return the parser's canonical serialization rather than the raw input.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Enter a valid http:// or https:// URL.' };
  }
  // Userinfo policy: refuse credentials-in-URL. .toString() PRESERVES them
  // (verified), they would be written to a plaintext setting AND shown in a
  // modal, and API keys already have a dedicated keychain-backed field.
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      reason: 'Remove the username:password@ part of the URL — credentials go in the API-key field, not the address.',
    };
  }
  // Canonical serialization: forge-proof by construction (see grounding below).
  return { ok: true, url: parsed.toString() };
}

// --- internals ---------------------------------------------------------

/** `ollama-tags`: adapts {@link probeOllama}'s `OllamaStatus` into a
 *  `ProbeOutcome` — `models` become plain names, dropping the byte sizes
 *  that outcome shape has no field for. */
async function probeOllamaTags(endpoint: string, fetchImpl: typeof fetch): Promise<ProbeOutcome> {
  const status = await probeOllama(endpoint, fetchImpl);
  if (status.running) {
    const names = status.models.map((m) => m.name);
    return { ok: true, detail: `Ollama reachable — ${names.length} model(s) found`, models: names };
  }
  return { ok: false, detail: status.detail };
}

interface LlamaCppHealthBody {
  status?: string;
  error?: { code?: number; message?: string; type?: string };
}

/** `llamacpp-health`: `GET {endpoint}/health`. */
async function probeLlamaCppHealth(endpoint: string, fetchImpl: typeof fetch): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(joinUrl(endpoint, 'health'), { signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as LlamaCppHealthBody;
    if (response.status === 503) {
      return { ok: false, detail: body.error?.message ?? 'model loading' };
    }
    if (!response.ok) {
      return { ok: false, detail: `llama.cpp /health responded ${response.status} ${response.statusText}` };
    }
    if (body.status === 'ok') {
      return { ok: true, detail: 'llama.cpp server ready' };
    }
    return { ok: false, detail: `llama.cpp /health responded with an unexpected body: ${JSON.stringify(body)}` };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

interface OpenAiModelsBody {
  data?: { id: string }[];
}

/** `openai-models`: `GET {endpoint}/v1/models`, `Authorization: Bearer
 *  <apiKey>` attached only when `apiKey` is a non-empty string. */
async function probeOpenAiModels(
  endpoint: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await fetchImpl(joinUrl(endpoint, 'v1/models'), { headers, signal: controller.signal });
    if (response.status === 401) {
      return { ok: false, detail: 'unauthorized — check API key' };
    }
    if (!response.ok) {
      return { ok: false, detail: `/v1/models responded ${response.status} ${response.statusText}` };
    }
    const body = (await response.json()) as OpenAiModelsBody;
    const models = (body.data ?? []).map((m) => m.id);
    return { ok: true, detail: `${models.length} model(s) found`, models };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Joins a base URL to a relative path without losing an existing subpath
 *  on the base and without doubling slashes — same normalization
 *  `ollamaClient.ts`'s local `joinUrl` applies, kept as a local copy here so
 *  this module stays self-contained (matching `registry.ts`'s and
 *  `ollamaClient.ts`'s own zero-cross-feature-import discipline). */
function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}
