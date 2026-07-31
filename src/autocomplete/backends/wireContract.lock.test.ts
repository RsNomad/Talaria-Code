import { describe, it, expect, vi, afterEach } from 'vitest';
import { readOpenAiSseText, BackendStreamError } from './http';
import { OllamaFimBackend } from './OllamaFimBackend';
import { LlamaCppInfillBackend } from './LlamaCppInfillBackend';
import type { FimRequest } from '../types';

/**
 * §2 (docs_claude/fim-backend-contract-and-followups-architecture.md) — the
 * authoritative wire-contract table, pinned as ONE readable artifact. Every
 * fixture below is a literal (or realistically-shaped) wire payload, not an
 * invented shape: each carries a source comment naming the runner@version +
 * file:line (from §2's own triple-sourced grounding) or, for Codestral, the
 * Context7 query that grounds it.
 *
 * This file does NOT make live HTTP calls and does NOT duplicate the
 * existing D1 byte-cap tests (http.test.ts) — it pins exactly what §2 pins:
 * the READ field/frame/edge-case contract of the three parsing surfaces
 * (ollama NDJSON via OllamaFimBackend, llama.cpp single-JSON via
 * LlamaCppInfillBackend, and the shared OpenAI-style SSE drain
 * `readOpenAiSseText` used verbatim by vLLM/openai-compat/Codestral — grep
 * confirms all three backends do nothing but `yield* readOpenAiSseText(...)`,
 * so exercising the shared drain directly IS the complete SSE contract).
 * Ollama/llama.cpp are exercised through their real backend classes (mocked
 * `fetch` only — no network) rather than a re-implemented parser, so a
 * regression in either backend's own `response`/`done`/`error`/`content`
 * reading logic — not just in http.ts's shared readers — reds this file.
 *
 * Runner versions (§2 table): ollama v0.32.0-rc0 @82f905c · llama.cpp
 * master@4f37f51 · vLLM main@ed908cf.
 */

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/** Minimal-but-complete `StreamableResponse`-compatible fixture for the
 *  SSE drain — a local copy of http.test.ts's `streamFromChunks` (kept
 *  minimal per the brief: reused by import would touch a frozen test file,
 *  so it is copied rather than imported). */
function streamFromChunks(chunks: string[]): { body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

/** A minimal valid `FimRequest` — empty `snippets` so `assertAllScanned`
 *  (called by every real backend immediately before `fetch`, §3.2) is a
 *  trivial no-op, keeping these fixtures focused on the read side only. */
function minimalReq(): FimRequest {
  return {
    model: 'qwen2.5-coder:1.5b-base',
    prefix: 'const x = ',
    suffix: '',
    stop: [],
    temperature: 0.01,
    maxTokens: 128,
    context: {
      filepath: 'file:///a.ts',
      languageId: 'typescript',
      prefix: 'const x = ',
      suffix: '',
      workspaceUris: [],
      snippets: [],
    },
  };
}

describe('wire-contract lock (§2) — ollama NDJSON response/done/error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Source: OllamaFimBackend.ts:14-18,104-129 (our code, read whole file);
   *  ollama v0.32.0-rc0 @82f905c: api/types.go:902-940 (`response` field
   *  :916, `done` field :923), server/routes.go:2093-2122 (mid-stream
   *  `{"error": e}` on an unchanged 200). */
  function ndjsonResponse(body: string): Response {
    return {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  it('happy path: 3 response deltas plus a final done:true carrying response:"" concatenate exactly', async () => {
    const lines =
      '{"response":"const "}\n' +
      '{"response":"x = "}\n' +
      '{"response":"1;"}\n' +
      '{"response":"","done":true}\n';
    const fetchSpy = vi.fn().mockResolvedValue(ndjsonResponse(lines));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });

    const out = await collect(backend.streamFim(minimalReq(), new AbortController().signal));

    expect(out.join('')).toBe('const x = 1;');
  });

  it('a mid-stream {"error": "..."} line on an otherwise-200 response throws BackendStreamError with a FIXED text — the runner body never surfaces', async () => {
    const marker = 'RUNNER_INTERNAL_ollama_7f3a_never_surfaced';
    const line = JSON.stringify({ error: `disk full: /home/user/.ollama/models/${marker}` }) + '\n';
    const fetchSpy = vi.fn().mockResolvedValue(ndjsonResponse(line));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });

    let caught: unknown;
    try {
      await collect(backend.streamFim(minimalReq(), new AbortController().signal));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendStreamError);
    const message = (caught as Error).message;
    expect(message).toBe('Ollama /api/generate reported an error mid-stream');
    expect(message).not.toContain(marker);
  });
});

describe('wire-contract lock (§2) — llama.cpp single-JSON content extraction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Source: LlamaCppInfillBackend.ts:22-29,133-141 (our code, read whole
   *  file); llama.cpp master@4f37f51: tools/server/server-task.cpp:364-387
   *  (non-stream JSON body: `content`, literal `{"stop": true}` :370,
   *  `stop_type` :378 — the real completion-reason discriminator, unread by
   *  us on purpose per audit-3 CA-1). */
  function infillJsonResponse(value: unknown): Response {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  it('a full realistic /infill response (content + stop:true + stop_type + tokens + timings) yields ONLY content', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      infillJsonResponse({
        content: 'hello world',
        stop: true,
        stop_type: 'eos',
        tokens: [101, 202, 303],
        timings: { prompt_n: 5, predicted_n: 3, predicted_per_second: 42.0 },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const out = await collect(backend.streamFim(minimalReq(), new AbortController().signal));

    expect(out).toEqual(['hello world']);
  });

  it('a response with no content field at all yields an empty result without throwing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      infillJsonResponse({
        stop: true,
        stop_type: 'eos',
        tokens: [],
        timings: {},
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const out = await collect(backend.streamFim(minimalReq(), new AbortController().signal));

    expect(out).toEqual([]);
  });
});

describe('wire-contract lock (§2) — vLLM / openai-compat / Codestral shared SSE drain (readOpenAiSseText)', () => {
  /** Source: http.ts `readOpenAiSseText`; vLLM main@ed908cf
   *  entrypoints/openai/completion/protocol.py:601-628 (stream chunk shape
   *  `choices[].text` — the same shape the generic openai-compat backend's
   *  `/v1/completions` reads). */
  it('vLLM/openai-compat frames carry choices[0].text', async () => {
    const res = streamFromChunks([
      'data: {"choices":[{"text":"const "}]}\n\n',
      'data: {"choices":[{"text":"x = 1;"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out = await collect(readOpenAiSseText(res, 'vLLM'));
    expect(out).toEqual(['const ', 'x = 1;']);
  });

  /**
   * Source: Context7 (`/llmstxt/mistral_ai_llms-full_txt`, queried
   * 2026-07-31, 3 targeted lookups) — PARTIAL confirmation, recorded
   * honestly rather than overclaimed:
   *   - CONFIRMED: `POST /v1/fim/completions`'s own request-body doc
   *     describes its `stream` parameter as sending "partial message
   *     deltas" (the exact phrase also used for `/v1/chat/completions`) —
   *     i.e. FIM streaming is documented to use the SAME delta mechanics as
   *     chat, not a distinct shape.
   *   - CONFIRMED (but for the chat endpoint specifically, same doc corpus):
   *     the literal SSE frame shape is `choices[0].delta.content`
   *     (`data: {"choices": [{"delta": {"content": "..."}, ...}]}`, chat's
   *     `CompletionEvent`/`chat.completion.chunk` example).
   *   - NOT FOUND: a frame example explicitly labeled as a FIM stream chunk
   *     (e.g. an `object: "fim.completion.chunk"` example) — the corpus does
   *     not carry one.
   * Net: `choices[0].delta.content` is Context7-grounded via the shared
   * `stream` semantics + the chat-endpoint's literal example, not via a
   * FIM-labeled example itself. This corroborates (does not fully replace)
   * `CodestralFimBackend.ts:34-37`'s prior "confirmed via Continue" note.
   */
  it('Codestral frames carry choices[0].delta.content (Context7-grounded — see comment for exactly what was/was not confirmed)', async () => {
    const res = streamFromChunks([
      'data: {"choices":[{"delta":{"content":"const "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"x = 1;"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out = await collect(readOpenAiSseText(res, 'Codestral'));
    expect(out).toEqual(['const ', 'x = 1;']);
  });

  /** Source: vLLM main@ed908cf entrypoints/openai/completion/serving.py:474-486
   *  — the final usage chunk emitted when `stream_options.include_usage` is
   *  set legitimately carries `choices: []` with no `error` key at all. */
  it('a usage-only chunk (choices: [] and no error key) does NOT throw and yields no text', async () => {
    const res = streamFromChunks([
      'data: {"id":"x","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out = await collect(readOpenAiSseText(res, 'vLLM'));
    expect(out).toEqual([]);
  });

  /** Source: http.ts:263 (`chunk.error != null` — truthiness, not `in`;
   *  review T-5 M-1). Some openai-compat proxies emit an always-present
   *  `error: null` slot on SUCCESS frames — presence-only detection would
   *  wrongly throw on every successful frame from such a proxy. */
  it('error:null on an otherwise-successful frame does NOT throw — its text still yields', async () => {
    const res = streamFromChunks([
      'data: {"id":"x","choices":[{"text":"hello"}],"error":null}\n\n',
      'data: [DONE]\n\n',
    ]);
    const out = await collect(readOpenAiSseText(res, 'vLLM'));
    expect(out).toEqual(['hello']);
  });

  /** Source: vLLM main@ed908cf entrypoints/openai/completion/serving.py:491-497
   *  (`create_streaming_error_response` — a genuine mid-stream error is a
   *  `data:` frame carrying a non-null `error` on an otherwise-200 stream,
   *  followed by `data: [DONE]`). */
  it('a genuine {"error": {...}} frame on a 200 stream throws BackendStreamError — the frame text never surfaces', async () => {
    const marker = 'RUNNER_INTERNAL_vllm_9c1d_never_surfaced';
    const res = streamFromChunks([
      `data: {"error":{"message":"${marker}","type":"InternalServerError"}}\n\n`,
      'data: [DONE]\n\n',
    ]);

    let caught: unknown;
    try {
      await collect(readOpenAiSseText(res, 'vLLM'));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendStreamError);
    expect((caught as Error).message).not.toContain(marker);
  });

  /** Source: vLLM main@ed908cf .../serving.py:497 — the literal `data:
   *  [DONE]\n\n` sentinel terminates the stream; the drain must stop reading
   *  right there. */
  it('data: [DONE] terminates the stream — anything sent after it is never read', async () => {
    const res = streamFromChunks([
      'data: {"choices":[{"text":"a"}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"text":"never"}]}\n\n',
    ]);
    const out = await collect(readOpenAiSseText(res, 'vLLM'));
    expect(out).toEqual(['a']);
  });
});
