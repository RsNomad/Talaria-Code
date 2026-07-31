import { describe, it, expect } from 'vitest';
import {
  BackendHttpError,
  BackendStreamError,
  StreamByteCapError,
  readNdjsonLines,
  readSseEvents,
  readOpenAiSseText,
  MAX_STREAM_BYTES,
  readJsonBounded,
} from './http';

describe('BackendHttpError', () => {
  it('is instanceof both BackendHttpError and Error, preserves .status, and sets .name (A1 — required for A5 catch-site narrowing)', () => {
    const err = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401);

    expect(err).toBeInstanceOf(BackendHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.name).toBe('BackendHttpError');
    expect(err.message).toBe('vLLM /v1/completions failed: 401 Unauthorized');
  });

  // F-C: provider.ts's surfaced-message copy needs "401 Unauthorized" rather
  // than a bare "(401)" — invariant 5 permits status + statusText, but only
  // `.status` was ever exposed as a field (statusText lived only inside the
  // free-text `.message`). Threaded through as its own field, mirroring
  // `.status`, so a catch site can read it without parsing `.message`.
  it('preserves .statusText when constructed with a third argument, defaulting to empty string when omitted (back-compat)', () => {
    const withStatusText = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401, 'Unauthorized');
    expect(withStatusText.statusText).toBe('Unauthorized');

    const withoutStatusText = new BackendHttpError('vLLM /v1/completions failed: 401 Unauthorized', 401);
    expect(withoutStatusText.statusText).toBe('');
  });
});

function streamFromChunks(chunks: string[]): { body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/**
 * D1: a stream with NO delimiter ('\n' for NDJSON, '\n\n' for SSE, or any
 * JSON-closing byte for readJsonBounded) that keeps supplying
 * `chunkBytes`-sized chunks forever on every `pull` — simulates a hostile
 * or misbehaving server that never terminates the response. Tracks whether
 * the consumer ever called `reader.cancel()`: per MDN, cancel() is the
 * loss-of-interest signal that discards any queued chunks and tears the
 * underlying source down (https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/cancel) —
 * without it, a hostile server keeps filling the socket/OS buffers even
 * after our reader stops calling read().
 */
function endlessGarbageStream(chunkBytes = 1024 * 1024): {
  body: ReadableStream<Uint8Array>;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  const chunk = new Uint8Array(chunkBytes).fill(0x41); // 'A' repeated — no '\n' anywhere
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, wasCancelled: () => cancelled };
}

describe('readNdjsonLines', () => {
  it('parses one JSON object per line', async () => {
    const res = streamFromChunks([
      '{"response":"a","done":false}\n{"response":"b","done":true}\n',
    ]);
    const objs = await collect(readNdjsonLines(res));
    expect(objs).toEqual([
      { response: 'a', done: false },
      { response: 'b', done: true },
    ]);
  });

  it('reassembles a JSON line split across multiple chunks', async () => {
    const res = streamFromChunks(['{"resp', 'onse":"hel', 'lo"}\n']);
    const objs = await collect(readNdjsonLines(res));
    expect(objs).toEqual([{ response: 'hello' }]);
  });

  it('yields a trailing line with no final newline', async () => {
    const res = streamFromChunks(['{"response":"a"}\n{"response":"b"}']);
    const objs = await collect(readNdjsonLines(res));
    expect(objs).toEqual([{ response: 'a' }, { response: 'b' }]);
  });

  it('skips blank lines and malformed JSON without throwing', async () => {
    const res = streamFromChunks(['\n{"response":"a"}\n\nnot json\n{"response":"b"}\n']);
    const objs = await collect(readNdjsonLines(res));
    expect(objs).toEqual([{ response: 'a' }, { response: 'b' }]);
  });

  it('yields nothing for a null body', async () => {
    const objs = await collect(readNdjsonLines({ body: null }));
    expect(objs).toEqual([]);
  });
});

describe('readSseEvents', () => {
  it('extracts the data payload from each SSE event', async () => {
    const res = streamFromChunks([
      'data: {"choices":[{"text":"a"}]}\n\ndata: {"choices":[{"text":"b"}]}\n\n',
    ]);
    const events = await collect(readSseEvents(res));
    expect(events).toEqual([
      '{"choices":[{"text":"a"}]}',
      '{"choices":[{"text":"b"}]}',
    ]);
  });

  it('reassembles an SSE event split across multiple chunks', async () => {
    const res = streamFromChunks([
      'data: {"choi',
      'ces":[{"text":"b"}]}\n\n',
    ]);
    const events = await collect(readSseEvents(res));
    expect(events).toEqual(['{"choices":[{"text":"b"}]}']);
  });

  it('passes through the [DONE] sentinel as a plain string', async () => {
    const res = streamFromChunks(['data: [DONE]\n\n']);
    const events = await collect(readSseEvents(res));
    expect(events).toEqual(['[DONE]']);
  });

  it('ignores non-"data:" lines (e.g. event:/id:) within an event', async () => {
    const res = streamFromChunks(['event: message\ndata: {"a":1}\n\n']);
    const events = await collect(readSseEvents(res));
    expect(events).toEqual(['{"a":1}']);
  });

  it('yields nothing for a null body', async () => {
    const events = await collect(readSseEvents({ body: null }));
    expect(events).toEqual([]);
  });
});

// D1 — 4 MiB total-received-byte cap (unbounded-memory DoS hardening).
// Ratified against the runner wire contracts: every request we send carries
// an explicit token bound, so the legitimate worst case (~1 MB llama.cpp
// prompt echo, tens-to-hundreds of KB Ollama NDJSON `context`) sits well
// under this cap. OWASP API4:2023: "Define and enforce a maximum size of
// data on all incoming parameters and payloads" —
// https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/
describe('readNdjsonLines — MAX_STREAM_BYTES cap (D1)', () => {
  it('rejects a delimiter-free stream once received bytes exceed MAX_STREAM_BYTES, without hanging, and the underlying reader observed cancel()', async () => {
    const { body, wasCancelled } = endlessGarbageStream();
    const iterator = readNdjsonLines({ body })[Symbol.asyncIterator]();

    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamByteCapError);
    expect((caught as Error).message).toBe(
      `response exceeded ${MAX_STREAM_BYTES} bytes without completing`,
    );
    expect(wasCancelled()).toBe(true);
  });

  it('still yields every event of a delimited stream comfortably under the cap (guard — no false positive)', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `{"response":"chunk-${i}"}`).join('\n') + '\n';
    const objs = await collect(readNdjsonLines(streamFromChunks([lines])));
    expect(objs).toHaveLength(10);
  });
});

describe('readSseEvents — MAX_STREAM_BYTES cap (D1)', () => {
  it('rejects a delimiter-free stream once received bytes exceed MAX_STREAM_BYTES, without hanging, and the underlying reader observed cancel()', async () => {
    const { body, wasCancelled } = endlessGarbageStream();
    const iterator = readSseEvents({ body })[Symbol.asyncIterator]();

    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamByteCapError);
    expect((caught as Error).message).toBe(
      `response exceeded ${MAX_STREAM_BYTES} bytes without completing`,
    );
    expect(wasCancelled()).toBe(true);
  });

  it('still yields every event of a delimited stream comfortably under the cap (guard — no false positive)', async () => {
    const events = Array.from({ length: 10 }, (_, i) => `data: {"choices":[{"text":"c${i}"}]}\n\n`).join('');
    const out = await collect(readSseEvents(streamFromChunks([events])));
    expect(out).toHaveLength(10);
  });
});

/**
 * F7: a FINITE, delimited stream (unlike `endlessGarbageStream`, which never
 * terminates) that still tracks whether `cancel()` was ever observed —
 * proves the reader.cancel() call independently of the D1 over-cap path,
 * for the "consumer stops pulling before the stream naturally ends" case
 * (e.g. a single-line completion accepted mid-generation).
 */
function trackedDelimitedStream(chunks: string[]): {
  body: ReadableStream<Uint8Array>;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, wasCancelled: () => cancelled };
}

// F7: "http.ts readers call reader.cancel() (not just releaseLock()) when
// the consumer exits early — stops local runners generating to max_tokens
// after a single-line accept (parity with the over-cap path)." Today only
// the D1 over-cap path calls cancel(); a consumer that simply stops
// iterating (the `for await...of` `break`/early-`return` case, modeled here
// via the async iterator protocol's own `.return()`) only ever hit
// `reader.releaseLock()` — the underlying HTTP connection, and whatever
// local runner is still generating tokens on the other end of it, kept
// running.
describe('readSseEvents — F7: reader.cancel() on early consumer exit (not just releaseLock)', () => {
  it('calls reader.cancel() when the consumer stops after the FIRST event of a multi-event stream', async () => {
    // Two SEPARATE `enqueue()` calls (not one combined chunk): a single
    // chunk would let ONE `reader.read()` drain the whole queue, at which
    // point the stream auto-transitions to 'closed' (it was already
    // `close()`d with an empty queue) — and cancel() on an ALREADY-closed
    // stream is a spec-defined no-op that never reaches the underlying
    // source's own cancel() callback. Keeping event "b" queued and unread
    // means the stream is still 'readable' when we bail after event "a",
    // so cancel() actually has something to tear down.
    const { body, wasCancelled } = trackedDelimitedStream([
      'data: {"choices":[{"text":"a"}]}\n\n',
      'data: {"choices":[{"text":"b"}]}\n\n',
    ]);
    const iterator = readSseEvents({ body })[Symbol.asyncIterator]();

    const { value } = await iterator.next();
    expect(value).toBe('{"choices":[{"text":"a"}]}');

    // Simulates a `for await...of` `break` — the async-iteration protocol
    // calls `.return()` on early exit (IteratorClose), which resumes the
    // generator at its `finally` block.
    await iterator.return?.(undefined);

    expect(wasCancelled()).toBe(true);
  });

  it('is a no-op (still safe) when the consumer exits AFTER the stream already completed naturally', async () => {
    const { body } = trackedDelimitedStream(['data: {"choices":[{"text":"a"}]}\n\n']);
    const iterator = readSseEvents({ body })[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next(); // done: true — stream already exhausted

    // cancel() on an already-closed stream is a documented no-op per the
    // Streams spec — this must not throw, and cancel() may or may not have
    // fired the underlying source's own cancel() callback (it already
    // closed on its own), so this test only asserts no throw occurred.
    await expect(iterator.return?.(undefined)).resolves.toBeDefined();
  });
});

describe('readNdjsonLines — F7: reader.cancel() on early consumer exit (not just releaseLock)', () => {
  it('calls reader.cancel() when the consumer stops after the FIRST line of a multi-line stream', async () => {
    // Two separate `enqueue()` calls — see the readSseEvents test above for
    // why a single combined chunk would defeat this test (the stream would
    // already be 'closed' by the time cancel() runs).
    const { body, wasCancelled } = trackedDelimitedStream([
      '{"response":"a","done":false}\n',
      '{"response":"b","done":true}\n',
    ]);
    const iterator = readNdjsonLines({ body })[Symbol.asyncIterator]();

    const { value } = await iterator.next();
    expect(value).toEqual({ response: 'a', done: false });

    await iterator.return?.(undefined);

    expect(wasCancelled()).toBe(true);
  });
});

/**
 * V-14 (FIM-SSE-ERROR): the runner really does emit errors as `data:`
 * frames on an otherwise-200 SSE stream (vLLM `serving.py:491-497`
 * `create_streaming_error_response`, both the `GenerationError` and generic
 * exception arms). Today every SSE-consuming FIM backend reads only
 * `choices?.[0]?.text` and silently `continue`s on anything else — the
 * error frame is read as "no text this round", and the stream then ends
 * with `[DONE]` looking exactly like an empty (but successful) completion.
 * `readOpenAiSseText` is the ONE shared drain all three SSE backends adopt.
 */
describe('readOpenAiSseText — V-14 shared OpenAI-style SSE drain', () => {
  it('yields choices[0].text (vLLM/OpenAI-compat delta shape)', async () => {
    const res = streamFromChunks([
      'data: {"choices":[{"text":"a"}]}\n\ndata: {"choices":[{"text":"b"}]}\n\ndata: [DONE]\n\n',
    ]);
    const out: string[] = [];
    for await (const text of readOpenAiSseText(res, 'vLLM')) out.push(text);
    expect(out).toEqual(['a', 'b']);
  });

  it('yields choices[0].delta.content (Codestral shape)', async () => {
    const res = streamFromChunks([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n',
    ]);
    const out: string[] = [];
    for await (const text of readOpenAiSseText(res, 'Codestral')) out.push(text);
    expect(out).toEqual(['a', 'b']);
  });

  it('stops at [DONE] without yielding it', async () => {
    const res = streamFromChunks(['data: {"choices":[{"text":"a"}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"text":"never"}]}\n\n']);
    const out: string[] = [];
    for await (const text of readOpenAiSseText(res, 'vLLM')) out.push(text);
    expect(out).toEqual(['a']);
  });

  it('skips a malformed-JSON frame without throwing (matches the pre-refactor per-backend behavior)', async () => {
    const res = streamFromChunks(['data: not-json\n\ndata: {"choices":[{"text":"a"}]}\n\ndata: [DONE]\n\n']);
    const out: string[] = [];
    for await (const text of readOpenAiSseText(res, 'vLLM')) out.push(text);
    expect(out).toEqual(['a']);
  });

  it('skips an empty-string text/delta without yielding an empty chunk', async () => {
    const res = streamFromChunks(['data: {"choices":[{"text":""}]}\n\ndata: {"choices":[{"text":"a"}]}\n\ndata: [DONE]\n\n']);
    const out: string[] = [];
    for await (const text of readOpenAiSseText(res, 'vLLM')) out.push(text);
    expect(out).toEqual(['a']);
  });

  // RED test #1 (spec §6): a mid-stream error frame throws BODY-FREE — the
  // T-D1 idiom: plant a marker in the frame's own error text and assert it
  // NEVER reaches the thrown message. Today this is read as "no text" and
  // the drain silently continues (resolves as an empty completion) — RED.
  it('throws a body-free BackendStreamError on a mid-stream {"error":…} frame — never leaks the frame message text', async () => {
    const bodyMarker = 'RUNNER_INTERNAL_DETAIL_never_surfaced_7c2a';
    const res = streamFromChunks([
      `data: {"error":{"message":"${bodyMarker}","type":"InternalServerError"}}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const iterator = readOpenAiSseText(res, 'vLLM')[Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendStreamError);
    expect((caught as Error).message).not.toContain(bodyMarker);
  });

  // RED test #2 (spec §6): the false-positive pin. vLLM's final usage chunk
  // legitimately carries `choices: []` when `stream_options.include_usage`
  // is set (serving.py:474-486) — an empty `choices` array must NEVER be
  // mistaken for an error. The detector keys ONLY on a top-level `error`
  // member, nothing else.
  it('does NOT throw on a usage-only frame with an empty choices array (false-positive pin)', async () => {
    const res = streamFromChunks([
      'data: {"id":"x","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const text of readOpenAiSseText(res, 'vLLM')) out.push(text);
      })(),
    ).resolves.toBeUndefined();
    expect(out).toEqual([]);
  });

  // Review T-5 M-1: truthiness, not mere presence. Some openai-compat proxies
  // emit an always-present `error: null` slot on SUCCESS frames — presence-only
  // (`'error' in chunk`) would wrongly throw and break FIM entirely; truthiness
  // ignores a benign null while still catching every real (non-null) error.
  it('does NOT throw on a success frame carrying an explicit error:null — yields its text (truthiness, not presence)', async () => {
    const res = streamFromChunks([
      'data: {"id":"x","choices":[{"text":"hello"}],"error":null}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out: string[] = [];
    for await (const text of readOpenAiSseText(res, 'vLLM')) out.push(text);
    expect(out).toEqual(['hello']);
  });

  it('yields nothing for a null body (parity with readSseEvents)', async () => {
    const out: string[] = [];
    for await (const text of readOpenAiSseText({ body: null }, 'vLLM')) out.push(text);
    expect(out).toEqual([]);
  });
});

describe('BackendStreamError', () => {
  it('is instanceof both BackendStreamError and Error, and sets .name', () => {
    const err = new BackendStreamError('vLLM reported an error mid-stream');
    expect(err).toBeInstanceOf(BackendStreamError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BackendStreamError');
    expect(err.message).toBe('vLLM reported an error mid-stream');
  });
});

// §6: the ONE class every byte-cap throw-site (readNdjsonLines,
// readSseEvents, readJsonBounded) constructs — covering all four real
// consumers (llama.cpp FIM, next-edit ollama, next-edit openai-compat,
// embeddings). The message is neutral: it carries the cap number and
// nothing else — never the word "FIM" (a label that lied for the
// embeddings consumer), never a backend name, URL, or body fragment.
describe('StreamByteCapError', () => {
  it('is instanceof both StreamByteCapError and Error, sets .name, carries .cap, and the message contains only the cap number — never "FIM"', () => {
    const err = new StreamByteCapError(MAX_STREAM_BYTES);

    expect(err).toBeInstanceOf(StreamByteCapError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StreamByteCapError');
    expect(err.cap).toBe(MAX_STREAM_BYTES);
    expect(err.message).toBe(`response exceeded ${MAX_STREAM_BYTES} bytes without completing`);
    expect(err.message).not.toContain('FIM');
  });
});

describe('readJsonBounded — bounded non-streaming JSON body reads (D1)', () => {
  it('parses a normal, well-under-cap JSON body', async () => {
    const data = await readJsonBounded(streamFromChunks([JSON.stringify({ content: 'hello' })]));
    expect(data).toEqual({ content: 'hello' });
  });

  it('rejects an over-cap body without hanging, and the underlying reader observed cancel()', async () => {
    const { body, wasCancelled } = endlessGarbageStream();
    let caught: unknown;
    try {
      await readJsonBounded({ body });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamByteCapError);
    expect((caught as Error).message).toBe(
      `response exceeded ${MAX_STREAM_BYTES} bytes without completing`,
    );
    expect(wasCancelled()).toBe(true);
  });

  it('honors a custom cap override', async () => {
    const res = streamFromChunks(['x'.repeat(100)]);
    let caught: unknown;
    try {
      await readJsonBounded(res, 10);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StreamByteCapError);
    expect((caught as Error).message).toBe('response exceeded 10 bytes without completing');
  });

  it('rejects (does not silently succeed) on a null body — matches response.json() throwing on an empty body', async () => {
    await expect(readJsonBounded({ body: null })).rejects.toThrow();
  });
});

// AUDIT-5 hygiene: `readJsonBounded`'s `finally` only called
// `reader.releaseLock()` — unlike `readNdjsonLines`/`readSseEvents` above
// (the F7 discipline: `cancel()` BEFORE `releaseLock()` on every exit path),
// it never told the source to drop the connection when the exit was an
// ERROR path other than the explicit over-cap throw (which already calls
// cancel() itself, inline, before rethrowing). A plain `reader.read()`
// rejection — the shape a dropped connection or a malformed-stream error
// actually takes — hit the `finally` without ever calling `cancel()`.
describe('readJsonBounded — F7: reader.cancel() in finally on every exit path (AUDIT-5 hygiene)', () => {
  it('calls reader.cancel() (not just releaseLock()) when reader.read() itself rejects mid-stream', async () => {
    let readCalls = 0;
    let cancelCalls = 0;
    let releaseLockCalls = 0;
    const encoder = new TextEncoder();
    const fakeReader = {
      read: async () => {
        readCalls++;
        if (readCalls === 1) {
          return { value: encoder.encode('{"partial":'), done: false };
        }
        throw new Error('simulated connection drop mid-read');
      },
      cancel: async () => {
        cancelCalls++;
      },
      releaseLock: () => {
        releaseLockCalls++;
      },
    };
    const fakeBody = {
      getReader: () => fakeReader,
    } as unknown as ReadableStream<Uint8Array>;

    await expect(readJsonBounded({ body: fakeBody })).rejects.toThrow(
      'simulated connection drop mid-read',
    );

    expect(cancelCalls).toBe(1);
    expect(releaseLockCalls).toBe(1);
  });
});
