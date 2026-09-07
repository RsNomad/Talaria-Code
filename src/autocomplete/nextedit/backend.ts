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
import {
  BackendHttpError,
  readJsonBounded,
  armStreamDeadlines,
  raceWithDeadline,
  MAX_STREAM_BYTES,
  type StreamDeadlines,
} from '../backends/http';
import { assertSecureAuthTransport } from '../backends/secureTransport';
import { mintScannedNextEditRequest } from './scan';
import { isRecord } from '../../shared/typeGuards';
import { OnceRegistry } from '../onceRegistry';
import type { NextEditTransportId, ScannedNextEditRequest } from './types';
import type { NextEditModelOutput, RenderedNextEditPrompt, StopReason } from './formats/types';

export interface NextEditBackendOptions {
  transport: NextEditTransportId;
  apiBase: string;
  apiKey?: string;
  model: string;
  /** For the wire-adjacent re-mint — the format module's own sentinel list. */
  sentinels: readonly string[];
  /**
   * FI-26 (FSU §5 Q4) — task F10-2b (3rd site closeout): the
   * {@link OnceRegistry} `predict`'s own `warnOnce` dedupes against.
   * REQUIRED, no module-level fallback: `shell.vscode.ts`'s `NextEditShell`
   * holds ONE stable `OnceRegistry` field (constructed once per activation,
   * alongside its other per-activation state) and passes that SAME instance
   * to every per-prediction `new NextEditHttpBackend({...})` it constructs —
   * so dedup spans predictions within an activation (warn-once-per-activation)
   * with no module-level dedup state and no hidden test dependency. This
   * module stays vscode-free (the registry arrives as a plain constructor
   * param; this file never reaches into vscode to obtain one).
   */
  registry: OnceRegistry;
}

/** Ollama `/api/generate` (non-streaming) response shape — only the fields
 *  this backend reads. `done_reason` is optional: Ollama's own empty-string
 *  `done_reason` case (`08` §5.3) is covered by the same `undefined`/
 *  not-'stop'/not-'length' fallthrough as a genuinely absent field. */
interface OllamaGenerateResponse {
  response?: string | null;
  done?: boolean | null;
  done_reason?: string | null;
}

/** openai-compat `/v1/completions` (non-streaming) response shape — only
 *  the fields this backend reads, from `choices[0]`. */
interface OpenAiCompletionResponse {
  choices?: { text?: string | null; finish_reason?: string | null }[] | null;
}

/** WS-BG (SYN-BOUNDARY): shallow ingress guards — exactly the fields the
 *  two predict paths read, at the depth they read them (ADR-BG). `null` is
 *  tolerated wherever the downstream `??` read already tolerates it. */
function isOllamaGenerateResponse(x: unknown): x is OllamaGenerateResponse {
  return (
    isRecord(x) &&
    (x.response == null || typeof x.response === 'string') &&
    (x.done_reason == null || typeof x.done_reason === 'string')
  );
}

function isOpenAiCompletionResponse(x: unknown): x is OpenAiCompletionResponse {
  if (!isRecord(x)) return false;
  const choices = x.choices;
  if (choices == null) return true;
  if (!Array.isArray(choices)) return false;
  const first: unknown = choices[0];
  if (first === undefined) return true;
  if (!isRecord(first)) return false;
  return (
    (first.text == null || typeof first.text === 'string') &&
    (first.finish_reason == null || typeof first.finish_reason === 'string')
  );
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
  private readonly registry: OnceRegistry;

  constructor(private readonly opts: NextEditBackendOptions) {
    this.registry = opts.registry;
  }

  /**
   * CF-24 / L6 I-15: mirrors `../backendFactory.ts`'s own dedup discipline —
   * same `console.warn` (never `vscode.window` — this module deliberately
   * never imports `vscode`, which is what keeps `predict` callable from a
   * plain unit test). `backendFactory.ts`'s F4 arm already solved this exact
   * problem for the FIM `ollama` backend (which has no `apiKey` field at
   * all); this is the same fix for next-edit's `ollama` transport, which has
   * the identical no-auth-story shape (see `predict`'s key-drop below). See
   * {@link NextEditBackendOptions.registry}'s doc comment for the
   * activation-scoped dedup discipline `this.registry` implements.
   */
  private warnOnce(key: string, message: string): void {
    if (this.registry.has(key)) return;
    this.registry.add(key);
    console.warn(`[talaria.nextEdit] ${message}`);
  }

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
    const trimmedApiKey = this.opts.apiKey?.trim() || undefined;

    // CF-24 / L6 I-15 — parity with `../backendFactory.ts`'s own `ollama`
    // arm (F4, mirrored via this class's own `warnOnce`/`registry` above):
    // Ollama's `/api/generate` has no auth story this codebase speaks to here either
    // — `predictOllama` below never reads `apiKey` at all, so a leftover key
    // is DROPPED for this transport (warn-once, never the key value) instead
    // of being treated as "present" by `assertSecureAuthTransport`. Without
    // this, a perfectly reachable, intended http Ollama endpoint that would
    // NEVER actually see the key throws a FALSE `InsecureTransportError` the
    // moment a leftover key (e.g. inherited from FIM's credential via the
    // `generic` next-edit route, `shell.vscode.ts`'s `resolveRoute`) happens
    // to be set and the endpoint is a non-loopback host — a documented,
    // supported Ollama deployment shape (`OllamaFimBackend.ts`'s own
    // "loopback-or-remote-runner" comment). Does NOT weaken the
    // openai-compat transport below, which DOES put the key on the wire
    // (`predictOpenAiCompat`'s `Authorization` header) and so must keep
    // refusing exactly as before — this is parity, not a removed protection.
    if (this.opts.transport === 'ollama' && trimmedApiKey !== undefined) {
      this.warnOnce(
        'nextedit-ollama-key-dropped',
        'An apiKey is configured, but the next-edit ollama transport has no authentication of its own — the key will never be sent. Clear the key, or switch talaria.nextEdit.backend to a transport that supports one.',
      );
    }
    const apiKey = this.opts.transport === 'ollama' ? undefined : trimmedApiKey;

    // (1) S4.2 (CWE-319): refuse to send the Bearer key over cleartext http
    // to a remote host — before touching the network.
    assertSecureAuthTransport(url, apiKey !== undefined);

    // (2) The wire-adjacent backstop — re-mint from the SAME sentinels the
    // caller already minted with. Discards the (already-typed) return
    // value; the call itself is the check (throws fail-closed on anything
    // a cast/`any` seam let through).
    mintScannedNextEditRequest(req, this.opts.sentinels);

    // ADR-R2-06 (L2-CA-05, C-1-redesigned): armed immediately BEFORE fetch()
    // (in either transport arm below) so the first-byte deadline spans the
    // fetch() await AND the reader's first read() — see http.ts's doc
    // comments for the full design.
    const dl = armStreamDeadlines(signal);

    return this.opts.transport === 'ollama'
      ? this.predictOllama(url, rendered, dl)
      : this.predictOpenAiCompat(url, rendered, dl, apiKey);
  }

  private async predictOllama(
    url: string,
    rendered: RenderedNextEditPrompt,
    dl: StreamDeadlines,
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

    try {
      const response = await raceWithDeadline(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: dl.signal,
        }),
        dl,
      );

      if (!response.ok) {
        dl.dispose();
        throw new BackendHttpError(
          `Next-edit Ollama /api/generate failed: ${response.status} ${response.statusText}`,
          response.status,
          response.statusText,
        );
      }
      // CA-5 (audit-3): a missing body on an `ok` response isn't an
      // HTTP-status failure — there's no real status to report as the cause,
      // so this stays a plain Error rather than a fabricated BackendHttpError
      // with an invented status. Mirrors every FIM backend's identical named
      // guard (e.g. `OllamaFimBackend.ts`) — without it, `readJsonBounded`
      // falls through to `JSON.parse('')` on a null body, which DOES throw,
      // but an opaque `SyntaxError: Unexpected end of JSON input` that never
      // names next-edit or the Ollama transport.
      if (!response.body) {
        dl.dispose();
        throw new Error(
          `Next-edit Ollama /api/generate failed: ${response.status} ${response.statusText}`,
        );
      }

      // D1: bounded read (4 MiB cap), not the unbounded response.json() —
      // Ollama's non-streaming /api/generate body is bounded by our own
      // num_predict, but a hostile/misconfigured server is free to send
      // anything; readJsonBounded caps it.
      const raw = await readJsonBounded(response, MAX_STREAM_BYTES, dl);
      if (!isOllamaGenerateResponse(raw)) {
        // WS-BG: an ok-status body that isn't the documented response shape is
        // a misbehaving/misconfigured server — refuse loudly. Status-only
        // message, NEVER body content (C-5 hygiene).
        throw new Error(
          `Next-edit Ollama /api/generate returned an unrecognized response shape: ${response.status} ${response.statusText}`,
        );
      }
      return { text: raw.response ?? '', stopReason: normalizeStopReason(raw.done_reason ?? undefined) };
    } catch (err) {
      // R1-7-fix (review Minor #1): dl.dispose() is idempotent (clear()
      // no-ops once the timer is already undefined) — this covers the ONE
      // path the guards above don't reach: raceWithDeadline(fetch) itself
      // rejecting (fast network failure, keystroke cancel) before any
      // response ever exists, which used to leave the 300s first-byte timer
      // dangling.
      dl.dispose();
      throw err;
    }
  }

  private async predictOpenAiCompat(
    url: string,
    rendered: RenderedNextEditPrompt,
    dl: StreamDeadlines,
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

    try {
      const response = await raceWithDeadline(
        fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: dl.signal,
        }),
        dl,
      );

      if (!response.ok) {
        dl.dispose();
        throw new BackendHttpError(
          `Next-edit openai-compat /v1/completions failed: ${response.status} ${response.statusText}`,
          response.status,
          response.statusText,
        );
      }
      // CA-5 (audit-3): same missing-body guard as predictOllama above — see
      // its comment for the full rationale (mirrors every FIM backend's
      // identical named guard).
      if (!response.body) {
        dl.dispose();
        throw new Error(
          `Next-edit openai-compat /v1/completions failed: ${response.status} ${response.statusText}`,
        );
      }

      // D1: bounded read (4 MiB cap), not the unbounded response.json() —
      // same rationale as predictOllama above.
      const raw = await readJsonBounded(response, MAX_STREAM_BYTES, dl);
      if (!isOpenAiCompletionResponse(raw)) {
        // WS-BG: same refusal posture as predictOllama above (C-5 hygiene:
        // status only, never body content).
        throw new Error(
          `Next-edit openai-compat /v1/completions returned an unrecognized response shape: ${response.status} ${response.statusText}`,
        );
      }
      const choice = raw.choices?.[0];
      return { text: choice?.text ?? '', stopReason: normalizeStopReason(choice?.finish_reason ?? undefined) };
    } catch (err) {
      // R1-7-fix (review Minor #1): dl.dispose() is idempotent (clear()
      // no-ops once the timer is already undefined) — this covers the ONE
      // path the guards above don't reach: raceWithDeadline(fetch) itself
      // rejecting (fast network failure, keystroke cancel) before any
      // response ever exists, which used to leave the 300s first-byte timer
      // dangling.
      dl.dispose();
      throw err;
    }
  }
}
