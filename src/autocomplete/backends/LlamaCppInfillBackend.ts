import { joinUrl } from '../util';
import { BackendHttpError, readJsonBounded } from './http';
import { assertSecureAuthTransport } from './secureTransport';
import { assertAllScanned } from '../context/assertAllScanned';
import type { BackendCapabilities, FimBackend, FimRequest } from '../types';
import type { ScannedSnippet } from '../context/types';

export interface LlamaCppInfillBackendOptions {
  /** e.g. `http://127.0.0.1:8080` (default llama.cpp server port). */
  apiBase: string;
  /**
   * T-6 F4: llama.cpp's server supports `--api-key` (`server-http.cpp:199-224`
   * — checks `Authorization: Bearer <key>` or `X-Api-Key`, applied to every
   * route via `set_pre_routing_handler`, so `/infill` is gated too when
   * configured). Optional — most llama.cpp deployments are an unauthenticated
   * loopback process. Same trim-normalized-Bearer + `assertSecureAuthTransport`
   * gate as `VllmFimBackend`/`OpenAICompatFimBackend` (D2/S4.2), verbatim.
   */
  apiKey?: string;
}

interface LlamaCppInfillResponse {
  content?: string;
  /** dead: constant `true` in the local llama.cpp snapshot, never the real
   * completion-reason discriminator — that's `stop_type` (unread here, and
   * unread by anything downstream). Kept typed but never consulted below
   * (`:133-136` reads `content` only). Per audit-3 CA-1. */
  stop?: boolean;
}

/**
 * `POST /infill` — llama.cpp builds the FIM token sequence natively
 * (`[FIM_PRE]prefix[FIM_SUF]suffix[FIM_MID]`) from `input_prefix`/`input_suffix`,
 * grounded in runner-apis-howto.md §2a (server-common.cpp:1441-1540,
 * server-context.cpp:4571-4625):
 * - `input_prefix`/`input_suffix` are REQUIRED; `input_extra` (repo-context chunks)
 *   and `prompt` are optional and default to `[]`/`""`.
 * - `prompt` is NOT a "middle seed" (audit G-12): the server appends its tokens
 *   to the END OF THE PREFIX, before `FIM_SUF` —
 *   `tools/server/server-common.cpp:1522`:
 *   `tokens_prefix.insert(tokens_prefix.end(), tokens_prompt.begin(), tokens_prompt.end());`
 *   The "middle seed" wording came from llama.cpp's own README, which
 *   contradicts its own code. Harmless while we send `''`; wrong for anyone who
 *   trusts the old comment and puts text there.
 * - We request non-streaming (`stream: false`): the source grounds the exact
 *   non-stream response shape (`{content, tokens, stop, ...}`); the streaming SSE
 *   frame shape for `/infill` specifically isn't shown in the pinned source excerpt,
 *   so we don't speculate on it here (flagged as an open concern in the report).
 * - NEVER send `suffix` to `/completion` or `/v1/completions` on llama.cpp — the
 *   OAI param filter rejects it outright (server-common.cpp:810-814). `/infill` is
 *   the only FIM-capable route on this runner.
 */
export class LlamaCppInfillBackend implements FimBackend {
  readonly name = 'llamacpp' as const;
  readonly capabilities: BackendCapabilities = {
    nativeFim: true,
    assemblesCrossFileServerSide: true,
    streaming: false,
  };

  constructor(private readonly opts: LlamaCppInfillBackendOptions) {}

  async *streamFim(
    req: FimRequest,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    const url = joinUrl(this.opts.apiBase, 'infill');
    // D2 (verbatim, see VllmFimBackend.ts/OpenAICompatFimBackend.ts): normalize
    // ONCE so the transport guard and the header see the SAME truth — a
    // whitespace-only apiKey is JS-truthy but not a valid RFC 6750 §2.1
    // b64token, so an untrimmed check would let `assertSecureAuthTransport`
    // treat "   " as "a real key is present" while the header below would
    // send `Bearer    ` verbatim.
    const apiKey = this.opts.apiKey?.trim() || undefined;
    // S4.2 (CWE-319): refuse to send the Bearer key over cleartext http to a
    // remote host — before touching the network.
    assertSecureAuthTransport(url, apiKey !== undefined);
    const inputExtra = req.context.snippets.map((s) => ({
      filename: s.filepath,
      text: s.content,
    }));
    const body = {
      input_prefix: req.prefix,
      input_suffix: req.suffix,
      input_extra: inputExtra,
      prompt: '',
      n_predict: req.maxTokens,
      temperature: req.temperature,
      stop: req.stop,
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // §3.2 backstop (ratified W5 critic-pin B1): re-scan every snippet
    // immediately before the wire — this is the primary `input_extra`
    // egress channel the backstop exists for (§3.2's enumeration item 1).
    assertAllScanned(req.context.snippets);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `llama.cpp /infill failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }
    // T-6 F5 remainder (the Codestral half of F5 already lands locally in
    // CodestralFimBackend.ts): a missing body on an `ok` response isn't an
    // HTTP-status failure — there's no real status to report as the cause,
    // so this stays a plain Error rather than a fabricated BackendHttpError
    // with an invented status. Without this guard, `readJsonBounded` falls
    // through to `JSON.parse('')` on a null body, which throws too, but an
    // opaque `SyntaxError` that never names llama.cpp or `/infill` —
    // unlike every sibling backend's identical named guard.
    if (!response.body) {
      throw new Error(
        `llama.cpp /infill failed: ${response.status} ${response.statusText}`,
      );
    }

    // D1: bounded read (4 MiB cap), not the unbounded response.json() —
    // llama.cpp's stream:false /infill body is a single JSON blob whose
    // realistic legitimate ceiling is ~1 MB (own-context-bounded prompt
    // echo); readJsonBounded caps it against a hostile/misconfigured server.
    const data = (await readJsonBounded(response)) as LlamaCppInfillResponse;
    if (data.content) {
      yield data.content;
    }
  }

  /**
   * §2.4 llama.vim-style KV-cache warm-up. Fire-and-forget: the caller
   * (`CrossFileContextService`) never awaits this and holds no reference to
   * the underlying request, so any failure here (network error, non-2xx,
   * abort) must never surface or throw — swallowed internally, matching the
   * `FimBackend.warmUp` contract. This is a best-effort latency optimization,
   * not a real completion request, so the response is never parsed.
   *
   * `input_prefix`/`input_suffix` are ALWAYS empty — this carries the
   * snippet set ONLY, never active-file content (finding 2/R14): that is
   * what keeps warm-up from becoming a second, unguarded active-file egress
   * channel. `n_predict`/`t_max_prompt_ms`/`t_max_predict_ms` are all pinned
   * to 1, mirroring llama.vim's own warm-up request shape — but per audit-3
   * CA-1, `t_max_prompt_ms`/`t_max_predict_ms` are DEAD in the local
   * llama.cpp snapshot (schema registration commented out), so those two
   * time caps don't actually apply. Net effect today is beneficial: warm-up
   * ends up doing the full `input_extra` KV-cache priming rather than
   * stopping at 1 ms. If llama.cpp re-enables the parameter, warm-up would
   * silently start under-priming instead — no error, just a latency
   * regression.
   */
  warmUp(snippets: readonly ScannedSnippet[], signal: AbortSignal): void {
    const url = joinUrl(this.opts.apiBase, 'infill');
    // T-6 F4: same normalized apiKey as streamFim — warm-up hits the SAME
    // `/infill` endpoint, so an api-key-protected llama.cpp server needs the
    // same credential here too, or the warm-up itself just 401s uselessly.
    const apiKey = this.opts.apiKey?.trim() || undefined;

    // §3.2 backstop (ratified W5 critic-pin B1) — egress path 4 (warm-up
    // reuses the same already-scanned snapshot, never re-gathers, but is
    // still gated here for defense in depth). S4.2 (CWE-319) joins the same
    // try/catch: both are refusals that must be SWALLOWED, not re-thrown —
    // warmUp's contract (above) is "never surface or throw", so an insecure-
    // transport refusal here just means "skip this warm-up, wait for the
    // next real completion," exactly like the assertAllScanned case.
    try {
      assertAllScanned(snippets);
      assertSecureAuthTransport(url, apiKey !== undefined);
    } catch {
      return;
    }

    const inputExtra = snippets.map((s) => ({
      filename: s.filepath,
      text: s.content,
    }));
    const body = {
      input_prefix: '',
      input_suffix: '',
      input_extra: inputExtra,
      prompt: '',
      n_predict: 1,
      t_max_prompt_ms: 1,
      t_max_predict_ms: 1,
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }).catch(() => {
      // Best-effort: a warm-up failure must never surface or throw. The
      // next real completion simply hits a cold KV cache, same as if
      // warm-up were disabled.
    });
  }
}
