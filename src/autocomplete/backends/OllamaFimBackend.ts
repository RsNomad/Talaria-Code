import { joinUrl } from '../util';
import { BackendHttpError, BackendStreamError, readNdjsonLines } from './http';
import { assertAllScanned } from '../context/assertAllScanned';
import type { BackendCapabilities, FimBackend, FimRequest } from '../types';

export interface OllamaFimBackendOptions {
  /** e.g. `http://127.0.0.1:11434` (default Ollama port — runner-apis-howto.md §1). */
  apiBase: string;
  model: string;
  /** Default `"30m"` — avoids per-request model reloads (how-to §3.2). */
  keepAlive?: string;
}

interface OllamaGenerateChunk {
  response?: string;
  done?: boolean;
  error?: string;
}

/**
 * `POST /api/generate` with `{prompt, suffix}` (native server-side FIM — the model's
 * own Modelfile template fills the hole). Grounded in runner-apis-howto.md §1a:
 * - `suffix` requires the model's Insert capability; Ollama fills `{{.Prompt}}` /
 *   `{{.Suffix}}` in the model template server-side.
 * - We deliberately never send `raw: true` here — raw mode skips templating
 *   entirely (routes.go:510), which effectively disables `suffix`-based FIM
 *   (the old `routes.go:432` cite for this specific claim was stale —
 *   `suffix` isn't handled at that line — per audit-3 CA-1), so a `raw:true`
 *   + `suffix` combination would silently do nothing useful.
 * - Response is streamed as newline-delimited JSON; each chunk carries `.response`,
 *   the final one `"done": true`.
 */
export class OllamaFimBackend implements FimBackend {
  readonly name = 'ollama' as const;
  readonly capabilities: BackendCapabilities = {
    nativeFim: true,
    assemblesCrossFileServerSide: false,
    streaming: true,
  };

  constructor(private readonly opts: OllamaFimBackendOptions) {}

  async *streamFim(
    req: FimRequest,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const url = joinUrl(this.opts.apiBase, 'api/generate');
    const body = {
      model: req.model || this.opts.model,
      prompt: req.prefix,
      // T-D1 (closes V-13): Ollama only enters its FIM path when
      // `req.Suffix != ""` (routes.go:521-523; the else branch builds chat
      // `Messages` instead, :524-541), AND the template layer only renders
      // the FIM branch when `v.Prompt != "" && v.Suffix != ""`
      // (template.go `Execute`). Cursor-at-EOF produces suffix `''` (exactly
      // `constructPrefixSuffix`'s `text.slice(offset)` at end-of-document),
      // which used to silently degrade to a chat-wrapped or marker-less
      // completion. An omitted field would be indistinguishable from `''`
      // to `!= ""` — not a fix. A synthetic `'\n'` is the minimal value that
      // keeps the request in the INFILL branch of both files.
      // Mirror case NOT handled here: an empty prefix (BOF) with a
      // non-empty suffix also falls out of template.go's FIM branch — left
      // out of scope (rare cursor position, near-nil completion value).
      suffix: req.suffix === '' ? '\n' : req.suffix,
      stream: true,
      keep_alive: this.opts.keepAlive ?? '30m',
      options: {
        temperature: req.temperature,
        num_predict: req.maxTokens,
        stop: req.stop,
      },
    };

    // §3.2 backstop (ratified W5 critic-pin B1): re-scan every snippet
    // immediately before the wire — fail-closed against a forged/bypassed
    // snippet or a future any-typed laundering seam, even though this
    // backend has no cross-file channel of its own (matches the wire-
    // adjacent placement of the other backends' transport/content guards).
    assertAllScanned(req.context.snippets);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `Ollama /api/generate failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }
    // A missing body on an `ok` response isn't an HTTP-status failure — there's
    // no real status to report as the cause, so this stays a plain Error rather
    // than a fabricated BackendHttpError with an invented status.
    if (!response.body) {
      throw new Error(
        `Ollama /api/generate failed: ${response.status} ${response.statusText}`,
      );
    }

    for await (const raw of readNdjsonLines(response)) {
      const chunk = raw as OllamaGenerateChunk;
      if (chunk.error) {
        // Invariant #3 (T6, M6 + ARCH-2): `chunk.error` is runner-generated
        // text (can carry local filesystem paths / internal detail) — never
        // surface it verbatim. This path has no injected logger (unlike
        // HermesDashboardClient), so the body is dropped entirely rather
        // than logged.
        //
        // T-6 M-2 (carried forward from the T-5 review): this used to throw
        // a PLAIN `Error`, invisible to `provider.ts`'s typed catch chain —
        // it fell through the `BackendStreamError` arm T-5 added for the SSE
        // backends (vLLM/Codestral/openai-compat) straight to the silent
        // `return null`, so a mid-stream Ollama error produced no signal at
        // all. `BackendStreamError` is body-free by construction (no frame
        // message interpolated, matching `http.ts`'s `readOpenAiSseText`)
        // and reuses that same arm instead of inventing a second one.
        throw new BackendStreamError('Ollama /api/generate reported an error mid-stream');
      }
      if (chunk.response) {
        yield chunk.response;
      }
      if (chunk.done) {
        return;
      }
    }
  }
}
