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
  choices?: { text?: string; delta?: { content?: string } }[];
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
 * Ollama's `/api/generate` streams newline-delimited JSON objects (one per line;
 * the final one carries `"done": true`) — see runner-apis-howto.md §1a.
 */
export async function* readNdjsonLines(
  response: StreamableResponse,
): AsyncGenerator<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
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
        throw new Error(`FIM stream exceeded ${MAX_STREAM_BYTES} bytes without completing`);
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
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Count RAW bytes BEFORE decode — see readNdjsonLines above for the
      // same rationale (delimiter-free garbage must still be bounded).
      received += value.byteLength;
      if (received > MAX_STREAM_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`FIM stream exceeded ${MAX_STREAM_BYTES} bytes without completing`);
      }
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield* emitEvent(rawEvent);
      }
    }
    if (buffer.trim()) {
      yield* emitEvent(buffer);
    }
  } finally {
    // F7 — see readNdjsonLines' identical finally block above for the full
    // rationale: cancel() on every exit path, not just releaseLock().
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
): AsyncGenerator<string> {
  for await (const data of readSseEvents(response)) {
    if (data === '[DONE]') return;
    const parsed = tryParseJson(data);
    if (typeof parsed !== 'object' || parsed === null) continue;
    const chunk = parsed as OpenAiSseChunk;
    if (chunk.error != null) {
      throw new BackendStreamError(`${label} reported an error mid-stream`);
    }
    const text = chunk.choices?.[0]?.text ?? chunk.choices?.[0]?.delta?.content;
    if (text) yield text;
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
): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];

  if (reader) {
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > cap) {
          await reader.cancel().catch(() => {});
          throw new Error(`FIM stream exceeded ${cap} bytes without completing`);
        }
        chunks.push(value);
      }
    } finally {
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
