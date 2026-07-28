import { joinUrl } from '../util';
import { BackendHttpError, readOpenAiSseText } from './http';
import { assertSecureAuthTransport } from './secureTransport';
import { assertAllScanned } from '../context/assertAllScanned';
import type { BackendCapabilities, FimBackend, FimRequest } from '../types';

export interface VllmFimBackendOptions {
  /** e.g. `http://127.0.0.1:8000` (default vLLM port). */
  apiBase: string;
  apiKey?: string;
  model: string;
}

/**
 * `POST /v1/completions` with a SELF-BUILT FIM prompt. Grounded in
 * runner-apis-howto.md §3a — this is the critical vLLM finding: `CompletionRequest`
 * *declares* a `suffix` field (completion/protocol.py:70) but the renderer
 * **400-rejects** it ("suffix is not currently supported",
 * vllm/renderers/online_renderer.py:236-238), and there is no `/infill` route
 * anywhere in vLLM. So unlike Ollama/llama.cpp, the model's literal
 * `<|fim_prefix|>...<|fim_suffix|>...<|fim_middle|>` tokens must be rendered
 * before we ever see the request and handed to us as a plain `prompt` string —
 * `capabilities.nativeFim` is `false` for this reason, which tells `FimEngine`
 * to populate `req.renderedPrompt` before calling us (enforced below).
 */
export class VllmFimBackend implements FimBackend {
  readonly name = 'vllm' as const;
  readonly capabilities: BackendCapabilities = {
    nativeFim: false,
    assemblesCrossFileServerSide: false,
    streaming: true,
  };

  constructor(private readonly opts: VllmFimBackendOptions) {}

  async *streamFim(
    req: FimRequest,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const model = req.model || this.opts.model;
    if (req.renderedPrompt === undefined) {
      throw new Error('VllmFimBackend: renderedPrompt missing — FimEngine must render for nativeFim:false backends (invariant)');
    }
    const prompt = req.renderedPrompt;

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
      model,
      prompt, // self-built FIM token string — vLLM has no server-side FIM.
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stop: req.stop,
      stream: true,
      // ADR-011, extended to FIM by audit F-1. vLLM's default is
      // `skip_special_tokens=True` (`vllm/sampling_params.py:295`) and stop
      // STRINGS are compared against ALREADY-DETOKENIZED text, so every
      // `<|…|>` stop we send — 9 of our 12 — is text-invisible there and can
      // never fire. The next-edit openai-compat transport has pinned this
      // since ADR-011 (`nextedit/backend.ts:202`); FIM was simply never
      // brought along. Ollama and llama.cpp ignore the unknown field, so one
      // body serves every runner.
      //
      // F-1a (round-2 refinement): the special-token blindness is shared by
      // ALL THREE runners; Ollama and llama.cpp are rescued by stopping on
      // token IDs (EOG), which vLLM's string-stop path does not do. The
      // practical defect is vLLM-only, but for that reason, not because the
      // other two are aware of special tokens.
      skip_special_tokens: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // §3.2 backstop (ratified W5 critic-pin B1): re-scan every snippet
    // immediately before the wire. `prompt` above already has snippet content
    // folded in — `FimEngine` renders it upstream (this backend's
    // `nativeFim: false` requires that; see the invariant check above) — the
    // check still runs on the source-of-truth `req.context.snippets` array,
    // so it catches a forged/bypassed snippet before the request that already
    // embeds it is ever sent.
    assertAllScanned(req.context.snippets);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `vLLM /v1/completions failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }
    // A missing body on an `ok` response isn't an HTTP-status failure — there's
    // no real status to report as the cause, so this stays a plain Error rather
    // than a fabricated BackendHttpError with an invented status.
    if (!response.body) {
      throw new Error(
        `vLLM /v1/completions failed: ${response.status} ${response.statusText}`,
      );
    }

    // V-14 (FIM-SSE-ERROR): the shared drain — see its doc comment in
    // http.ts. vLLM really does emit a mid-stream error as a `data:` frame
    // on this same 200 stream (serving.py:491-497), which this used to read
    // as "no text this round" and silently continue past.
    yield* readOpenAiSseText(response, 'vLLM');
  }
}
