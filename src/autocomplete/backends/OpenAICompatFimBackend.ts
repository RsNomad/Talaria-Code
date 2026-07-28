import { joinUrl } from '../util';
import { BackendHttpError, readOpenAiSseText } from './http';
import { assertSecureAuthTransport } from './secureTransport';
import { assertAllScanned } from '../context/assertAllScanned';
import type { BackendCapabilities, FimBackend, FimRequest } from '../types';

export interface OpenAICompatFimBackendOptions {
  apiBase: string;
  apiKey?: string;
  model: string;
}

/**
 * Generic OpenAI-compatible `/v1/completions` with a `suffix` field — this is
 * Ollama's OpenAI-compat surface (`CompletionRequest.Suffix` maps straight to
 * `GenerateRequest.Suffix`, openai.go:153,782 — runner-apis-howto.md §1a) and any
 * other server that documents native `suffix` support on the legacy completions
 * endpoint.
 *
 * IMPORTANT: do NOT point this backend at llama.cpp — its `/v1/completions` throws
 * "Unsupported param: suffix" (server-common.cpp:810-814); use
 * `LlamaCppInfillBackend` (`/infill`) for that runner instead. Also do not use it
 * for vLLM — vLLM **400-rejects** `suffix` there (post-A5 this now fails
 * *visibly* via that 400 surfacing, not silently); use `VllmFimBackend`.
 */
export class OpenAICompatFimBackend implements FimBackend {
  readonly name = 'openai-compat' as const;
  readonly capabilities: BackendCapabilities = {
    nativeFim: true,
    assemblesCrossFileServerSide: false,
    streaming: true,
  };

  constructor(private readonly opts: OpenAICompatFimBackendOptions) {}

  async *streamFim(
    req: FimRequest,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const url = joinUrl(this.opts.apiBase, 'v1/completions');
    // D2: normalize ONCE so the transport guard and the header see the SAME
    // truth. `!!this.opts.apiKey` alone is a truthiness-only gate — a
    // whitespace-only string is JS-truthy but is not a valid bearer
    // credential (RFC 6750 §2.1's b64token ABNF allows no whitespace and
    // requires at least one token character), so an untrimmed check here
    // would let `assertSecureAuthTransport` treat "   " as "a real key is
    // present" while the header below would send `Bearer    ` verbatim.
    const apiKey = this.opts.apiKey?.trim() || undefined;
    // S4.2 (CWE-319): refuse to send the Bearer key over cleartext http to a
    // remote host — before touching the network.
    assertSecureAuthTransport(url, apiKey !== undefined);
    const body = {
      model: req.model || this.opts.model,
      prompt: req.prefix,
      suffix: req.suffix,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stop: req.stop,
      stream: true,
      // ADR-011, extended to FIM by audit F-1 (same pin as VllmFimBackend.ts).
      // This backend's own doc comment above says not to point it at vLLM
      // (400-rejects `suffix`) or llama.cpp (400-rejects `suffix` on
      // `/v1/completions`), but it IS a generic `/v1/completions` surface —
      // any other OpenAI-compatible server behind it may share vLLM's
      // `skip_special_tokens=True` default and detokenized-text stop
      // matching. Ollama (its primary target) ignores the unknown field.
      //
      // Review m-1: NOT unconditionally free. `createBackend`
      // (`backendFactory.ts`) builds this class from a user-configured
      // `cfg.endpoint`, so it can be pointed at a strict server (e.g.
      // `api.openai.com`) that 400-rejects unrecognized body arguments — this
      // field would break that configuration. The field stays anyway
      // (sibling parity with vLLM's pin, ruled in deliberately) because the
      // failure mode there is loud and safe: `BackendHttpError` surfaces only
      // `status`/`statusText` (`http.ts`), never the response body or the key.
      skip_special_tokens: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // §3.2 backstop (ratified W5 critic-pin B1): re-scan every snippet
    // immediately before the wire — the runtime analogue of
    // assertSecureAuthTransport's placement above, fail-closed against a
    // forged/bypassed snippet or a future any-typed laundering seam.
    assertAllScanned(req.context.snippets);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `OpenAI-compat /v1/completions failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }
    // A missing body on an `ok` response isn't an HTTP-status failure — there's
    // no real status to report as the cause, so this stays a plain Error rather
    // than a fabricated BackendHttpError with an invented status.
    if (!response.body) {
      throw new Error(
        `OpenAI-compat /v1/completions failed: ${response.status} ${response.statusText}`,
      );
    }

    // V-14 (FIM-SSE-ERROR): the shared drain — see its doc comment in
    // http.ts. Same runner error-as-data-frame convention as vLLM (this
    // backend's own doc comment above already warns not to point it AT
    // vLLM/llama.cpp, but the class of server behind it can still emit the
    // same OpenAI-style `{"error": …}` frame shape mid-stream).
    yield* readOpenAiSseText(response, 'OpenAI-compat');
  }
}
