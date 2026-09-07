import { isRecord } from '../../shared/typeGuards';

/**
 * The subset of `fetch`'s `Response` these parsers need — just enough to be unit
 * testable against a synthetic `ReadableStream` without a real HTTP round-trip.
 */
export interface StreamableResponse {
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Thrown by a FIM backend when `fetch` resolves with a non-2xx `response`.
 * Carries `status` (and `statusText`) so a catch site (A5) can narrow on it
 * and build a user-facing message without parsing `.message` — the message
 * text itself never carries the response body or the API key, only status +
 * statusText (jobA-common.md invariant 5).
 */
export class BackendHttpError extends Error {
  readonly status: number;
  /** F-C: e.g. `'Unauthorized'` for a 401. Defaults to `''` for a caller
   *  that only ever passed `status` (back-compat; every real construction
   *  site below passes `response.statusText`). */
  readonly statusText: string;

  constructor(message: string, status: number, statusText: string = '') {
    super(message);
    this.name = 'BackendHttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * V-14 (FIM-SSE-ERROR): thrown by {@link readOpenAiSseText} when an
 * otherwise-200 SSE stream carries a top-level `error` member on a `data:`
 * frame — the runner's real error-as-data-frame convention (vLLM
 * `entrypoints/openai/completion/serving.py:491-497`:
 * `create_streaming_error_response`, both the `GenerationError` and generic
 * exception arms yield `data: {…error…}\n\n` then `data: [DONE]\n\n` on a
 * 200 stream). BODY-FREE by construction (Invariant #3 — the
 * `OllamaFimBackend.ts` NDJSON precedent, which already does this right for
 * its `chunk.error` case): the message is a FIXED template naming only the
 * backend `label`, never the frame's own `.error.message` — that text is
 * runner-generated and can carry local filesystem paths or other internal
 * detail that must never reach a UI toast.
 */
export class BackendStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendStreamError';
  }
}

/** The subset of an OpenAI-style SSE `data:` frame {@link readOpenAiSseText}
 *  reads. `choices[0].text` is the vLLM/OpenAI-compat completions shape;
 *  `choices[0].delta.content` is Codestral's chat-style delta shape — one
 *  drain serves all three SSE backends. `error`'s presence (not its value)
 *  is the ONLY signal `readOpenAiSseText` keys on — see its doc comment. */
interface OpenAiSseChunk {
  error?: unknown;
  choices?: { text?: string | null; delta?: { content?: string | null } | null }[] | null;
}

/**
 * D1 — hard cap on total bytes received from a FIM/next-edit runner
 * response before we tear the connection down (unbounded-memory DoS
 * hardening). Ratified against the actual runner wire contracts: every
 * request we send carries an explicit token bound, so the legitimate
 * worst case sits far under this — ~1 MB for llama.cpp's own-context-
 * bounded `/infill` prompt echo, tens-to-hundreds of KB for Ollama's
 * NDJSON `context` array at our budgets. OWASP API4:2023: "Define and
 * enforce a maximum size of data on all incoming parameters and payloads"
 * (https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/).
 * Applied at the consuming edge because the user-configured server
 * controls what is sent, not us.
 */
export const MAX_STREAM_BYTES = 4 * 1024 * 1024;

/**
 * F1-9: an SSE event boundary is a blank line — the spec permits CRLF, LF,
 * or a mix, so `\r?\n\r?\n` with the EARLIEST match wins. The per-line
 * `data:` extraction in {@link readSseEvents} already tolerates a trailing
 * `\r` (`line.slice(5).trim()`), so only the boundary needed fixing. Hoisted
 * to module scope: a `g`-less regex is stateless (no `lastIndex` to leak
 * across calls), so reuse here is safe.
 */
const SSE_EVENT_BOUNDARY = /\r?\n\r?\n/;

/**
 * §6: the ONE class every byte-cap throw-site below constructs
 * (`readNdjsonLines`, `readSseEvents`, `readJsonBounded`) — covering all
 * four real consumers of the cap (llama.cpp FIM, next-edit ollama,
 * next-edit openai-compat, embeddings). Replaces a per-call string that
 * hardcoded the word "FIM" even on the embeddings path, where it was a
 * lying label (the underlying cause — "exceeded the limit" — was honest;
 * only the name was wrong). The message is a FIXED template naming only
 * the byte cap itself — never a backend label, endpoint, or response body
 * — so a shared class can't become a second per-path place to leak detail
 * into free text.
 */
export class StreamByteCapError extends Error {
  readonly cap: number;

  constructor(cap: number) {
    super(`response exceeded ${cap} bytes without completing`);
    this.name = 'StreamByteCapError';
    this.cap = cap;
  }
}

/**
 * ADR-R2-06 (L2-CA-05, C-1-redesigned): ONE first-byte deadline, EQUAL to
 * undici's own default (`headersTimeout`/`bodyTimeout` = 300 s each —
 * `@vscode/proxy-agent`'s Agent carries no override), spanning the caller's
 * `fetch` await AND the reader's first `read()` call. NEVER tighter than
 * the runtime for the first byte: a CPU-only Ollama box writes nothing at
 * all — not even response headers — until the model is loaded and the first
 * token is ready (model load + prefill sit inside that very `fetch` await;
 * cline#6549 / ollama#7685's failure class). A separate, tighter
 * "headers deadline" was the ORIGINAL design here and was rejected for
 * exactly this reason (critic C-1) — do not reintroduce one.
 */
export const STREAM_FIRST_BYTE_MS = 300_000;

/**
 * The ONE genuine behavioural delta this task makes (everything else is
 * already covered by VS Code's own per-keystroke cancellation or the
 * runtime's 300 s default): once a stream has produced its first byte, a
 * gap this long before the NEXT one is treated as a dead connection —
 * tighter than the runtime default, on the theory that a runner already
 * mid-response and then silent for two minutes is stuck, not merely slow to
 * start.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Thrown via the `AbortSignal` {@link armStreamDeadlines} hands to the
 * caller's own `fetch` call and to the reader, once either the first-byte
 * or the inter-chunk-idle deadline elapses. Egress hygiene (mandatory —
 * reviewed): name and message carry NO url, host, endpoint, or API key;
 * either failure ladder (`provider.ts`, `shell.vscode.ts`) supplies any
 * user-facing wording.
 */
export class StreamIdleTimeoutError extends Error {
  constructor() {
    super('stream exceeded its deadline without producing data');
    this.name = 'StreamIdleTimeoutError';
  }
}

/** What {@link armStreamDeadlines} hands back. */
export interface StreamDeadlines {
  /** Pass to the caller's own `fetch` call as `init.signal`, AND to the
   *  reader (which threads it into every `reader.read()` via
   *  {@link raceWithDeadline}). */
  readonly signal: AbortSignal;
  /** Call once, the moment the FIRST `read()` call settles (with data or an
   *  immediate `done`) — clears the first-byte deadline and arms the
   *  tighter idle one in its place. */
  firstByte(): void;
  /** Call after every read() from the second one on — re-arms the idle
   *  deadline against the NEXT gap. */
  chunk(): void;
  /** Clears any still-pending timer. Idempotent — safe to call more than
   *  once, or on a deadline that already fired. */
  dispose(): void;
}

/**
 * `AbortSignal.any` where available (Node >= 20.3); a manual once-listener
 * bridge on older hosts so the repo's `engines.node >= 18` floor stays
 * truthful. Mirrors `host/dashboard/HermesDashboardClient.ts`'s own
 * `anySignal` helper verbatim in shape — deliberately NOT imported from
 * there: `autocomplete/backends/` is a host-independent leaf (its own
 * `assertAllScannedLock.test.ts`/`authGuardLock.test.ts` pin exactly which
 * files live here), so it must not gain a dependency on `host/`.
 */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const anyImpl = (AbortSignal as unknown as { any?: (s: readonly AbortSignal[]) => AbortSignal }).any;
  if (anyImpl) return anyImpl.call(AbortSignal, signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/**
 * ADR-R2-06 (L2-CA-05, C-1-redesigned) — see {@link STREAM_FIRST_BYTE_MS} /
 * {@link STREAM_IDLE_TIMEOUT_MS} for why these two numbers, not one, and why
 * the first is never tighter than the runtime. Arms the first-byte deadline
 * IMMEDIATELY (the caller must call this BEFORE its own `fetch` call, so the
 * deadline is already live for the whole of that await); `firstByte()`/
 * `chunk()` swap it for the idle deadline once data starts moving. Both
 * numbers are constants, not settings — there is no `talaria.*` knob for
 * either (ADR-R2-06 Q10).
 */
export function armStreamDeadlines(signal: AbortSignal | undefined): StreamDeadlines {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (ms: number): void => {
    clear();
    timer = setTimeout(() => {
      ac.abort(new StreamIdleTimeoutError());
    }, ms);
    timer.unref?.();
  };
  arm(STREAM_FIRST_BYTE_MS);
  return {
    signal: signal ? anySignal([signal, ac.signal]) : ac.signal,
    firstByte(): void {
      arm(STREAM_IDLE_TIMEOUT_MS);
    },
    chunk(): void {
      arm(STREAM_IDLE_TIMEOUT_MS);
    },
    dispose(): void {
      clear();
    },
  };
}

/**
 * Races `promise` against `dl`'s own deadline signal so a deadline reap is
 * deterministic — independent of whatever a synthetic test double (or even
 * a real but slow-to-notice transport) would otherwise do on its own. A
 * no-op passthrough when `dl` is omitted, so every existing call site that
 * never threads a deadline is byte-for-byte unchanged (golden reader
 * semantics, 0 edits). On an abort win, rejects with the abort reason —
 * {@link StreamIdleTimeoutError} when OUR OWN timer fired; whatever the
 * caller's own upstream signal carries when THEY cancelled first (preserving
 * existing cancellation behavior unchanged). Exported so every FIM/next-edit
 * backend can apply the identical treatment to its own `fetch` call, not
 * only the readers below to their `reader.read()` calls.
 */
export function raceWithDeadline<T>(promise: Promise<T>, dl: StreamDeadlines | undefined): Promise<T> {
  if (!dl) return promise;
  const { signal } = dl;
  const abortError = (): Error => {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? reason : new Error(String(reason));
  };
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Ollama's `/api/generate` streams newline-delimited JSON objects (one per line;
 * the final one carries `"done": true`) — see runner-apis-howto.md §1a.
 */
export async function* readNdjsonLines(
  response: StreamableResponse,
  dl?: StreamDeadlines,
): AsyncGenerator<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  let sawFirstByte = false;
  try {
    for (;;) {
      // ADR-R2-06: races the read itself against the deadline (rather than
      // trusting a synthetic/mocked transport, or even a real one, to error
      // the stream on its own) so `reader.cancel()` below still runs against
      // a still-'readable' stream — required for the F7 cancel-on-exit
      // discipline to actually reach the underlying source's own cancel().
      const { value, done } = await raceWithDeadline(reader.read(), dl);
      if (sawFirstByte) {
        dl?.chunk();
      } else {
        sawFirstByte = true;
        dl?.firstByte();
      }
      if (done) break;
      // Count RAW bytes BEFORE decode, so delimiter-free garbage counts
      // too — a hostile/misbehaving server that never emits a '\n' must
      // not be able to grow `buffer` unboundedly.
      received += value.byteLength;
      if (received > MAX_STREAM_BYTES) {
        // Loss of interest: cancel() discards any chunks already queued
        // and tears the underlying source down (MDN
        // ReadableStreamDefaultReader/cancel) — without this the hostile
        // firehose keeps filling the socket while the error propagates.
        await reader.cancel().catch(() => {});
        throw new StreamByteCapError(MAX_STREAM_BYTES);
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          const parsed = tryParseJson(line);
          if (parsed !== undefined) yield parsed;
        }
      }
    }
    const trailing = buffer.trim();
    if (trailing) {
      const parsed = tryParseJson(trailing);
      if (parsed !== undefined) yield parsed;
    }
  } finally {
    // F7: cancel() (not just releaseLock()) on EVERY exit path — natural
    // completion (no-op: the source is already exhausted), the D1 over-cap
    // throw above (already explicit, so this is a harmless second call —
    // cancel() on an already-cancelled stream resolves immediately per the
    // Streams spec), AND the path this used to miss: the CONSUMER simply
    // stopping early (a `for await...of` `break`/`return`, which drives
    // `.return()` on this generator and resumes it here). Without this, a
    // local runner kept generating to `max_tokens` after e.g. a single-line
    // completion was accepted mid-stream — the HTTP connection was only
    // ever released, never torn down.
    dl?.dispose();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * OpenAI-style `text/event-stream` (vLLM, Codestral, generic OpenAI-compat
 * `/v1/completions`) — NOT llama.cpp. Doc nit (T-6): this comment used to
 * list "llama.cpp SSE" as a consumer, but `LlamaCppInfillBackend` requests
 * `/infill` with `stream: false` and reads the single JSON body via
 * `readJsonBounded` below; it never calls this reader. Yields the raw
 * `data:` payload of each event (a JSON string, or the literal `[DONE]`
 * sentinel) — parsing is left to the caller since the payload shape differs
 * per backend (`choices[0].text` vs `.delta.content`).
 */
export async function* readSseEvents(
  response: StreamableResponse,
  dl?: StreamDeadlines,
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  const emitEvent = function* (rawEvent: string): Generator<string> {
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
  };

  let received = 0;
  let sawFirstByte = false;
  try {
    for (;;) {
      // ADR-R2-06 — see readNdjsonLines above for the full rationale.
      const { value, done } = await raceWithDeadline(reader.read(), dl);
      if (sawFirstByte) {
        dl?.chunk();
      } else {
        sawFirstByte = true;
        dl?.firstByte();
      }
      if (done) break;
      // Count RAW bytes BEFORE decode — see readNdjsonLines above for the
      // same rationale (delimiter-free garbage must still be bounded).
      received += value.byteLength;
      if (received > MAX_STREAM_BYTES) {
        await reader.cancel().catch(() => {});
        throw new StreamByteCapError(MAX_STREAM_BYTES);
      }
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const m = SSE_EVENT_BOUNDARY.exec(buffer);
        if (m === null) break;
        const rawEvent = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        yield* emitEvent(rawEvent);
      }
    }
    if (buffer.trim()) {
      yield* emitEvent(buffer);
    }
  } finally {
    // F7 — see readNdjsonLines' identical finally block above for the full
    // rationale: cancel() on every exit path, not just releaseLock().
    dl?.dispose();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * V-14 (FIM-SSE-ERROR) — the ONE shared drain for every OpenAI-style
 * `text/event-stream` FIM backend (vLLM, the generic openai-compat backend,
 * Codestral). Wraps {@link readSseEvents} (which already owns the byte cap
 * and F7 cancel-on-exit behavior) and adds the parsing + error-detection
 * step every one of those backends used to duplicate privately — the
 * "arch F5 drift class" the duplication itself was named for.
 *
 * `label` names the backend in the thrown {@link BackendStreamError}'s
 * message only (e.g. `'vLLM'`) — never anything from the frame itself.
 *
 * Detector: a frame is an error iff it carries a NON-NULL top-level `error`
 * member (`chunk.error != null`) — truthiness, not mere presence (review
 * T-5 M-1): some openai-compat proxies emit an always-present `error: null`
 * slot on SUCCESS frames, and presence-only (`'error' in chunk`) would
 * wrongly throw on those and break FIM entirely. A genuine runner error is
 * always a non-null object, so truthiness catches every real error while
 * ignoring a benign null. Deliberately narrow either way: vLLM's final usage
 * chunk (when `stream_options.include_usage` is set) legitimately carries
 * `choices: []` with no `error` key at all (`serving.py:474-486`) and MUST
 * NOT throw —
 * every other shape (empty choices, absent choices, malformed JSON) is
 * treated as "no text this round", exactly as each backend's own
 * pre-refactor loop already did for non-error frames.
 */
export async function* readOpenAiSseText(
  response: StreamableResponse,
  label: string,
  dl?: StreamDeadlines,
): AsyncGenerator<string> {
  for await (const data of readSseEvents(response, dl)) {
    if (data === '[DONE]') return;
    const parsed = tryParseJson(data);
    // WS-BG (SYN-BOUNDARY): record-shaped frames only — `isRecord` also
    // excludes arrays, which the old typeof-object check let through (they
    // behaved as "no text" anyway; now the skip is uniform and total).
    if (!isRecord(parsed)) continue;
    const chunk = parsed as OpenAiSseChunk;
    if (chunk.error != null) {
      throw new BackendStreamError(`${label} reported an error mid-stream`);
    }
    const text = chunk.choices?.[0]?.text ?? chunk.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) yield text;
  }
}

/**
 * D1 — bounded read of a full (non-streaming) response body, then
 * `JSON.parse`. Same total-byte cap and cancel-on-exceed behavior as the
 * streaming readers above; adopted at the FIM/next-edit backends' non-
 * streaming `response.json()` sites, which face the identical threat
 * class (a user-configured server is free to send anything on the wire).
 * A `reader`-less (null) body falls through to `JSON.parse('')`, which
 * throws — matching `response.json()`'s own behavior on an empty body.
 */
export async function readJsonBounded(
  response: StreamableResponse,
  cap: number = MAX_STREAM_BYTES,
  dl?: StreamDeadlines,
): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];

  if (reader) {
    let received = 0;
    let sawFirstByte = false;
    try {
      for (;;) {
        // ADR-R2-06 — see readNdjsonLines above for the full rationale.
        const { value, done } = await raceWithDeadline(reader.read(), dl);
        if (sawFirstByte) {
          dl?.chunk();
        } else {
          sawFirstByte = true;
          dl?.firstByte();
        }
        if (done) break;
        received += value.byteLength;
        if (received > cap) {
          await reader.cancel().catch(() => {});
          throw new StreamByteCapError(cap);
        }
        chunks.push(value);
      }
    } finally {
      // F7 discipline (AUDIT-5 hygiene): cancel BEFORE releaseLock so an
      // error-path exit (read() rejection, cap throw) tells the source to
      // drop the connection instead of leaving the body half-consumed —
      // matches readNdjsonLines/readSseEvents above. Cancel on an
      // already-closed/cancelled stream (e.g. the explicit cancel() the D1
      // over-cap throw above already issued) resolves harmlessly.
      dl?.dispose();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  const decoder = new TextDecoder();
  let text = '';
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}
