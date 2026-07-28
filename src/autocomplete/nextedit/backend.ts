// nextedit/backend.ts — Job B Task 11 · the next-edit HTTP transport.
//
// Two non-streaming transports (`talaria.nextEdit.backend: 'ollama' |
// 'openai-compat'` — ADR-009, `09-jobB-final-plan.md` Global Constraints
// "Two transports only"). `predict` runs a PINNED order, every step a
// security or correctness invariant from the Global Constraints:
//
//   0. `req.model === opts.model` (fail-closed) — `NextEditRequest.model`
//      and `NextEditBackendOptions.model` are two independent carriers of
//      what must be the SAME value; nothing upstream reconciles them, so a
//      divergent pair is refused here rather than silently sending
//      `opts.model` while the caller believed `req.model` was authoritative.
//   1. `assertSecureAuthTransport(url, !!apiKey)` — CWE-319, refuse to put
//      a Bearer key on cleartext http to a remote host, before any network
//      call (`../backends/secureTransport.ts:43-51`).
//   2. Re-mint `mintScannedNextEditRequest(req, sentinels)` — the
//      wire-adjacent backstop. `req` already carries the request-level
//      brand by the time it reaches this module, but the brand is only as
//      strong as the ONE sanctioned mint site (`scan.ts`) — a caller that
//      forged the brand via an unsafe double cast (the exact shape a
//      sibling repo-wide guard hunts for elsewhere in the tree) would sail
//      through a type-only check. Calling the REAL mint again here,
//      immediately before the wire, re-scans every content field for real
//      and throws (ruleId-only message, never the matched text) if anything
//      slipped through. The re-mint's return value is intentionally unused
//      beyond this throw-or-don't check — the wire body is built from
//      `rendered` (already-rendered prompt text), not from `req`'s own
//      fields.
//   3. One non-streaming POST (`stream: false` on both transports — no
//      NDJSON/SSE parsing needed here, unlike the FIM backends).
//   4. `!response.ok` ⇒ `BackendHttpError(status, statusText)` — the
//      message NEVER carries the response body or the API key (Global
//      Constraints: "Error messages never carry the response body or the
//      API key — status + statusText only"). The body is never even read
//      on the error path, so there is nothing to leak by construction.
//   5. Normalize the stop reason (`normalizeStopReason`, shared by both
//      transports — `08` §5.3's `else ⇒ 'unknown'` arm is load-bearing on
//      the openai-compat side: vLLM's extra `"abort"|"error"|"repetition"`
//      finish reasons must NOT be misread as `'stop'`).
//
// `raw` polarity (Global Constraints, verbatim): "FIM never sends `raw`;
// the next-edit Ollama transport ALWAYS sends `raw: true`." This is the
// OPPOSITE of `OllamaFimBackend.ts:20-31`'s own comment, which is correct
// only for FIM (native server-side templating via `suffix`) — next-edit
// renders its OWN complete prompt (`RenderedNextEditPrompt.prompt`) and
// must bypass Ollama's chat/instruct templating entirely, which is exactly
// what `raw: true` does (routes.go:510). Do not "fix" this to match FIM.
//
// `num_ctx` NEVER appears in this file's body construction — "No Hermes
// code ever sends `num_ctx`" (Global Constraints; locked repo-wide by
// `reuseLocks.test.ts`'s source-scan below). The server-side context
// window is an out-of-band runner setting (`OLLAMA_CONTEXT_LENGTH`), never
// a per-request body field here.
//
// `skip_special_tokens: false` is pinned on the openai-compat body (ADR-011,
// `08` §5.4): every runner matches stop STRINGS against detokenized text,
// and vLLM's default (`skip_special_tokens=True`) makes a special-token
// stop (genericInstruct's backup `<|im_end|>`) text-invisible — the stop
// could never fire. vLLM honors this key; llama.cpp ignores unknown
// fields, so one body serves both runners.
//
// Field-by-field object construction only, no spread — this file lives
// under `src/autocomplete/` and is in scope for `ringBuffer.test.ts`'s
// repo-wide `SPREAD_RE`/`CAST_RE` purity guards. This module never casts to
// `ScannedNextEditRequest` — it obtains (and re-verifies) the brand purely
// by CALLING `mintScannedNextEditRequest`, the one sanctioned mint.
import { joinUrl } from '../util';
import { BackendHttpError, readJsonBounded } from '../backends/http';
import { assertSecureAuthTransport } from '../backends/secureTransport';
import { mintScannedNextEditRequest } from './scan';
import type { NextEditTransportId, ScannedNextEditRequest } from './types';
import type { NextEditModelOutput, RenderedNextEditPrompt, StopReason } from './formats/types';

export interface NextEditBackendOptions {
  transport: NextEditTransportId;
  apiBase: string;
  apiKey?: string;
  model: string;
  /** For the wire-adjacent re-mint — the format module's own sentinel list. */
  sentinels: readonly string[];
}

/** Ollama `/api/generate` (non-streaming) response shape — only the fields
 *  this backend reads. `done_reason` is optional: Ollama's own empty-string
 *  `done_reason` case (`08` §5.3) is covered by the same `undefined`/
 *  not-'stop'/not-'length' fallthrough as a genuinely absent field. */
interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
  done_reason?: string;
}

/** openai-compat `/v1/completions` (non-streaming) response shape — only
 *  the fields this backend reads, from `choices[0]`. */
interface OpenAiCompletionResponse {
  choices?: { text?: string; finish_reason?: string }[];
}

/**
 * `'stop'` iff the raw reason is exactly `'stop'`, `'length'` iff exactly
 * `'length'`, else `'unknown'` — shared by both transports (`08` §5.3).
 * Covers Ollama's empty-string/absent `done_reason` AND vLLM's
 * `"abort"|"error"|"repetition"` `finish_reason` values identically: this
 * `else` arm is load-bearing, not a defensive afterthought — every parser
 * downstream fail-closed-dismisses anything that isn't `'stop'`.
 */
function normalizeStopReason(raw: string | undefined): StopReason {
  if (raw === 'stop') return 'stop';
  if (raw === 'length') return 'length';
  return 'unknown';
}

export class NextEditHttpBackend {
  constructor(private readonly opts: NextEditBackendOptions) {}

  async predict(
    req: ScannedNextEditRequest,
    rendered: RenderedNextEditPrompt,
    signal: AbortSignal,
  ): Promise<NextEditModelOutput> {
    // (0) Fail-closed model reconciliation (controller finding, Task 11
    // fix-wave): `req.model` and `this.opts.model` are two independent
    // carriers of what should be the SAME value — nothing upstream
    // reconciles them. A model id is not a secret, so it is safe to name
    // both in the message; kept short per the same discipline as every
    // other guard in this file. This check runs BEFORE the guards below —
    // it is a caller-contract check, not a security check, but it still
    // must never let a silently-mismatched request reach the wire.
    if (req.model !== this.opts.model) {
      throw new Error(
        `NextEditHttpBackend.predict: req.model (${req.model}) !== opts.model (${this.opts.model})`,
      );
    }

    const path = this.opts.transport === 'ollama' ? 'api/generate' : 'v1/completions';
    const url = joinUrl(this.opts.apiBase, path);

    // D2: normalize ONCE so the transport guard here and the header built
    // in `predictOpenAiCompat` see the SAME truth. `!!this.opts.apiKey`
    // alone is a truthiness-only gate — a whitespace-only string is
    // JS-truthy but is not a valid bearer credential (RFC 6750 §2.1's
    // b64token ABNF allows no whitespace and requires at least one token
    // character), so an untrimmed check here would let
    // `assertSecureAuthTransport` treat "   " as "a real key is present"
    // while the header downstream would send `Bearer    ` verbatim.
    const apiKey = this.opts.apiKey?.trim() || undefined;

    // (1) S4.2 (CWE-319): refuse to send the Bearer key over cleartext http
    // to a remote host — before touching the network.
    assertSecureAuthTransport(url, apiKey !== undefined);

    // (2) The wire-adjacent backstop — re-mint from the SAME sentinels the
    // caller already minted with. Discards the (already-typed) return
    // value; the call itself is the check (throws fail-closed on anything
    // a cast/`any` seam let through).
    mintScannedNextEditRequest(req, this.opts.sentinels);

    return this.opts.transport === 'ollama'
      ? this.predictOllama(url, rendered, signal)
      : this.predictOpenAiCompat(url, rendered, signal, apiKey);
  }

  private async predictOllama(
    url: string,
    rendered: RenderedNextEditPrompt,
    signal: AbortSignal,
  ): Promise<NextEditModelOutput> {
    const body = {
      model: this.opts.model,
      prompt: rendered.prompt,
      raw: true,
      stream: false,
      keep_alive: '30m',
      options: {
        temperature: 0,
        num_predict: rendered.maxTokens,
        stop: rendered.stop,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `Next-edit Ollama /api/generate failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }

    // D1: bounded read (4 MiB cap), not the unbounded response.json() —
    // Ollama's non-streaming /api/generate body is bounded by our own
    // num_predict, but a hostile/misconfigured server is free to send
    // anything; readJsonBounded caps it.
    const data = (await readJsonBounded(response)) as OllamaGenerateResponse;
    return { text: data.response ?? '', stopReason: normalizeStopReason(data.done_reason) };
  }

  private async predictOpenAiCompat(
    url: string,
    rendered: RenderedNextEditPrompt,
    signal: AbortSignal,
    apiKey: string | undefined,
  ): Promise<NextEditModelOutput> {
    const body = {
      model: this.opts.model,
      prompt: rendered.prompt,
      max_tokens: rendered.maxTokens,
      temperature: 0,
      stop: rendered.stop,
      stream: false,
      skip_special_tokens: false,
    };

    // D2: `apiKey` here is the SAME normalized value `predict` already
    // passed to `assertSecureAuthTransport` above — never re-read
    // `this.opts.apiKey` directly, or the guard and the header could
    // diverge again.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new BackendHttpError(
        `Next-edit openai-compat /v1/completions failed: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
      );
    }

    // D1: bounded read (4 MiB cap), not the unbounded response.json() —
    // same rationale as predictOllama above.
    const data = (await readJsonBounded(response)) as OpenAiCompletionResponse;
    const choice = data.choices?.[0];
    return { text: choice?.text ?? '', stopReason: normalizeStopReason(choice?.finish_reason) };
  }
}
