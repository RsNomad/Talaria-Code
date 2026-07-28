import { joinUrl } from '../util';
import { BackendHttpError, readOpenAiSseText } from './http';
import { assertSecureAuthTransport } from './secureTransport';
import { assertAllScanned } from '../context/assertAllScanned';
import type { BackendCapabilities, FimBackend, FimRequest } from '../types';

export interface CodestralFimBackendOptions {
  /** `https://codestral.mistral.ai` (Codestral key) or `https://api.mistral.ai` (standard key). */
  apiBase?: string;
  apiKey: string;
  model?: string;
}

/**
 * Review C-1/M-1. Thrown by {@link CodestralFimBackend.streamFim} when
 * `opts.apiKey` is empty or whitespace-only. Construction (`createBackend`,
 * `backendFactory.ts`) must NEVER throw — that call runs SYNCHRONOUSLY
 * during `activate()`, before SecretStorage's async load has resolved, for
 * a config that may well have a key waiting there a moment later. The
 * request path is the correct, minimal choke point instead: a keyless build
 * still makes ZERO egress (this check runs before `assertSecureAuthTransport`
 * and before `fetch`), and `provider.ts`'s catch block narrows on this exact
 * type to surface a `Set API Key` action instead of letting the completion
 * fail silently.
 */
export class MissingApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingApiKeyError';
  }
}

/**
 * `POST /v1/fim/completions` — Mistral's native FIM endpoint. Field naming per
 * runner-apis-howto.md §"Codestral": `prompt` = the PREFIX, `suffix` = the suffix —
 * the endpoint assembles `[SUFFIX]...[PREFIX]...` server-side, so we never build
 * that string ourselves. SSE response; Continue reads `choices[0].delta.content`.
 */
export class CodestralFimBackend implements FimBackend {
  readonly name = 'codestral' as const;
  readonly capabilities: BackendCapabilities = {
    nativeFim: true,
    assemblesCrossFileServerSide: false,
    streaming: true,
  };

  constructor(private readonly opts: CodestralFimBackendOptions) {}

  async *streamFim(
    req: FimRequest,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    // Review C-1/M-1: refuse HERE, not at construction (see
    // `MissingApiKeyError`'s doc comment and `backendFactory.ts`'s codestral
    // arm for why). M-2: `.trim()`, not a bare length check —
    // `CodestralFimBackendOptions.apiKey` is typed `string` (not optional),
    // so a hand-built config (this class is exported and constructible with
    // an arbitrary options object, not only via `createBackend`) can pass
    // `'   '`. `!!'   '` is `true`, so `assertSecureAuthTransport` below
    // would treat that as "a real key is present" and let a whitespace
    // `Bearer` header reach the wire.
    if (this.opts.apiKey.trim().length === 0) {
      throw new MissingApiKeyError(
        'talaria.autocomplete.backend=codestral requires an API key. Run "Talaria: Set Autocomplete API Key", or choose a local backend.',
      );
    }
    // F5 (D2 parity): the guard above already proves this is non-empty
    // after trimming — use THAT trimmed value for the header too, mirroring
    // VllmFimBackend/OpenAICompatFimBackend's own `.trim()` normalization.
    // Untrimmed, a key with incidental leading/trailing whitespace (e.g.
    // pasted with a trailing newline) would sail past the guard above
    // (`.trim().length > 0`) but still put a padded, invalid `Bearer`
    // credential on the wire (RFC 6750 §2.1's b64token ABNF allows no
    // whitespace).
    const trimmedApiKey = this.opts.apiKey.trim();
    const base = this.opts.apiBase || 'https://codestral.mistral.ai';
    const url = joinUrl(base, 'v1/fim/completions');
    // S4.2 (CWE-319): refuse to send the Bearer key over cleartext http to a
    // remote host — before touching the network.
    assertSecureAuthTransport(url, true);
    const body = {
      // Audit G-13: the `|| 'codestral-latest'` tail was unreachable —
      // `config.ts:102` coerces an empty model to DEFAULT_MODEL, so
      // `this.opts.model` is always truthy by the time a backend exists. A
      // fallback that cannot fire is a claim about behaviour that does not
      // happen.
      model: this.opts.model || req.model,
      prompt: req.prefix,
      suffix: req.suffix,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stop: req.stop,
      stream: true,
    };

    // §3.2 backstop (ratified W5 critic-pin B1): re-scan every snippet
    // immediately before the wire — the runtime analogue of
    // assertSecureAuthTransport's placement above, fail-closed against a
    // forged/bypassed snippet or a future any-typed laundering seam.
    assertAllScanned(req.context.snippets);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedApiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `Codestral FIM failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }
    // A missing body on an `ok` response isn't an HTTP-status failure — there's
    // no real status to report as the cause, so this stays a plain Error rather
    // than a fabricated BackendHttpError with an invented status.
    if (!response.body) {
      throw new Error(
        `Codestral FIM failed: ${response.status} ${response.statusText}`,
      );
    }

    // V-14 (FIM-SSE-ERROR): the shared drain — see its doc comment in
    // http.ts. Handles both this backend's `choices[0].delta.content` shape
    // and the mid-stream error-frame case this used to read as "no delta
    // this round" and silently continue past.
    yield* readOpenAiSseText(response, 'Codestral');
  }
}
