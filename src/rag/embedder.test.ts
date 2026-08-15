import { describe, expect, it, vi } from 'vitest';

import {
  buildEmbeddingsRequestBody,
  EMBED_TIMEOUT_MS,
  HttpEmbedder,
  parseEmbeddingsResponse,
  type EmbeddingsResponse,
} from './embedder';
import { must } from '../testing/must';

describe('buildEmbeddingsRequestBody', () => {
  it('omits dimensions entirely when not provided', () => {
    const body = buildEmbeddingsRequestBody('qwen3-embedding:0.6b', ['a', 'b']);
    expect(body).toEqual({ model: 'qwen3-embedding:0.6b', input: ['a', 'b'] });
    expect('dimensions' in body).toBe(false);
  });

  it('includes dimensions when provided', () => {
    const body = buildEmbeddingsRequestBody('qwen3-embedding:0.6b', ['a'], 768);
    expect(body).toEqual({ model: 'qwen3-embedding:0.6b', input: ['a'], dimensions: 768 });
  });
});

describe('parseEmbeddingsResponse', () => {
  it('sorts data by index to realign with input order', () => {
    const response: EmbeddingsResponse = {
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] },
      ],
    };
    expect(parseEmbeddingsResponse(response, 2)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('throws when the vector count does not match the batch size', () => {
    const response: EmbeddingsResponse = { data: [{ index: 0, embedding: [1] }] };
    expect(() => parseEmbeddingsResponse(response, 2)).toThrow(/expected 2/);
  });

  // TA-2 (AU-5) / AU-36:R11: a duplicate or out-of-range `index` currently
  // sorts/aligns silently (the count check above passes, and Array#sort's
  // ties keep wire order) — the caller then mis-attributes one embedding to
  // the wrong input text, or a legitimate row is dropped in favor of a
  // duplicate, with no error at all.
  it('throws on a duplicate index instead of silently misaligning rows', () => {
    const response: EmbeddingsResponse = {
      data: [
        { index: 0, embedding: [1, 1] },
        { index: 0, embedding: [2, 2] },
      ],
    };
    expect(() => parseEmbeddingsResponse(response, 2)).toThrow(/duplicate index/i);
  });

  it('throws on an index at or beyond expectedCount', () => {
    const response: EmbeddingsResponse = {
      data: [
        { index: 0, embedding: [1, 1] },
        { index: 5, embedding: [2, 2] },
      ],
    };
    expect(() => parseEmbeddingsResponse(response, 2)).toThrow(/invalid index/i);
  });

  it('throws on a negative index', () => {
    const response: EmbeddingsResponse = {
      data: [
        { index: 0, embedding: [1, 1] },
        { index: -1, embedding: [2, 2] },
      ],
    };
    expect(() => parseEmbeddingsResponse(response, 2)).toThrow(/invalid index/i);
  });
});

describe('HttpEmbedder', () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => EmbeddingsResponse) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init: init as RequestInit });
      const body = handler(urlStr, init as RequestInit);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('posts to {endpoint}/v1/embeddings with the batch input', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3, 0.4] },
      ],
    }));
    const embedder = new HttpEmbedder({
      endpoint: 'http://127.0.0.1:11434/',
      model: 'qwen3-embedding:0.6b',
      dimensions: 768,
      fetchImpl,
    });

    const vectors = await embedder.embed(['chunk one', 'chunk two']);

    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(calls).toHaveLength(1);
    const call0 = must(calls[0]);
    expect(call0.url).toBe('http://127.0.0.1:11434/v1/embeddings');
    const sentBody = JSON.parse(call0.init.body as string);
    expect(sentBody).toEqual({
      model: 'qwen3-embedding:0.6b',
      input: ['chunk one', 'chunk two'],
      dimensions: 768,
    });
  });

  it('splits input into multiple requests once batchSize is exceeded', async () => {
    const { fetchImpl, calls } = fakeFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return { data: body.input.map((_t, i) => ({ index: i, embedding: [i] })) };
    });
    const embedder = new HttpEmbedder({
      endpoint: 'http://127.0.0.1:11434',
      model: 'm',
      batchSize: 2,
      fetchImpl,
    });

    const vectors = await embedder.embed(['a', 'b', 'c']);

    expect(calls).toHaveLength(2);
    expect(vectors).toEqual([[0], [1], [0]]);
  });

  it('returns [] without calling fetch for empty input', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ data: [] }));
    const embedder = new HttpEmbedder({ endpoint: 'http://x', model: 'm', fetchImpl });

    expect(await embedder.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws with status info when the response is not ok', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500, statusText: 'Internal Error' }),
    ) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: 'http://x', model: 'm', fetchImpl });

    await expect(embedder.embed(['a'])).rejects.toThrow(/500/);
  });
});

describe('TA-2 (AU-5): per-row embedding vector validation at the embedder seam', () => {
  // V2 (reproduced): `mergeInsert` silently accepts an empty or wrong-width
  // vector into an existing fixed-width LanceDB table, and every later
  // `nearestTo` query on the WHOLE table then throws — one bad row kills all
  // vector search. These assert the seam refuses BEFORE that point, matching
  // HEAD's actual behavior first (must resolve, not reject) so the failure
  // is provably about the missing validation and nothing else.

  it('rejects an empty embedding vector instead of silently letting it reach store.upsert', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), { status: 200 });
    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/malformed embedding vector/i);
  });

  it('rejects a non-numeric element in an embedding vector', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: ['x'] }] }), { status: 200 });
    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/malformed embedding vector/i);
  });

  it('rejects a non-finite element (Infinity via wire numeric overflow) in an embedding vector', async () => {
    // Raw wire text, not JSON.stringify of a JS object: `JSON.stringify`
    // itself special-cases Infinity/NaN to `null` before serialization, so
    // this constructs the literal JSON-number-overflow case a real server's
    // response bytes could contain (`JSON.parse('1e400')` === `Infinity`).
    const fetchImpl = async () =>
      new Response('{"data":[{"index":0,"embedding":[1,1e400,2]}]}', { status: 200 });
    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/malformed embedding vector/i);
  });

  it('enforces intra-batch width consistency when expectedWidth is undefined (first build, dims=0)', async () => {
    // Rev-1 A2 premise: on a first build nothing has been DECLARED to
    // enforce, but the two rows of the SAME batch must still agree with each
    // other — otherwise `observedWidth` (indexer.ts) records whichever width
    // happened to come first and the other row corrupts the table silently.
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 2, 3] },
            { index: 1, embedding: [1, 2, 3, 4] },
          ],
        }),
        { status: 200 },
      );
    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });
    await expect(embedder.embed(['x', 'y'])).rejects.toThrow(/embedding width mismatch/i);
  });
});

describe('C-5/D-1: the embedder never leaks a body and never sends dimensions blind', () => {
  it('a failing response produces status + statusText ONLY — never the body', async () => {
    // The thrown message reaches the user's log AND the model, via
    // mcp.js:141 createToolError(error.message) -> Hermes mcp_tool.py:3947.
    // Global Constraint: error messages never carry a response body or a key.
    const fetchImpl = async () =>
      ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'SECRET_BODY_TOKEN model does not support matryoshka representation',
      }) as unknown as Response;

    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });
    await expect(embedder.embed(['x'])).rejects.toThrow('400 Bad Request');
    await expect(embedder.embed(['x'])).rejects.not.toThrow('SECRET_BODY_TOKEN');
  });

  it('omits `dimensions` entirely when it is not explicitly configured', () => {
    expect(buildEmbeddingsRequestBody('m', ['x'], undefined)).toEqual({ model: 'm', input: ['x'] });
    expect(buildEmbeddingsRequestBody('m', ['x'], 0)).toEqual({ model: 'm', input: ['x'] });
  });

  it('sends `dimensions` only when the user set a positive value', () => {
    expect(buildEmbeddingsRequestBody('m', ['x'], 768)).toEqual({
      model: 'm',
      input: ['x'],
      dimensions: 768,
    });
  });

  it('refuses a vector whose width does not match the index schema, instead of storing it', async () => {
    // CF-21: `embedBatch` now reads its body via `readJsonBounded`
    // (`response.body.getReader()`), not `response.json()` — this fixture
    // must supply a real `ReadableStream` body, matching the LlamaCpp/
    // next-edit backends' identical D1 fixtures.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 });

    const embedder = new HttpEmbedder({
      endpoint: 'http://127.0.0.1:11434',
      model: 'm',
      fetchImpl,
    });
    await expect(embedder.embed(['x'], 768)).rejects.toThrow('embedding width mismatch');
  });

  it('rejects a stalled embeddings request at the RAG-2 timeout deadline instead of hanging forever', async () => {
    // Models a stalled embeddings server: the fetch promise never settles on
    // its own. A real `fetch`/`AbortController` rejects the in-flight
    // request once its signal is aborted — this fake reproduces exactly that
    // contract so the test exercises HttpEmbedder's own deadline wiring
    // (AbortController + timer), not a stand-in that resolves for free.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }) as unknown as typeof fetch;

      const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });

      const pending = embedder.embed(['x']);
      // review M-2: the deadline surfaces a self-explanatory timeout message
      // (naming the deadline) rather than a bare "operation was aborted".
      const assertion = expect(pending).rejects.toThrow(/timed out after/i);

      await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abort a request that completes well before the RAG-2 timeout deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }),
      ) as unknown as typeof fetch;

      const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });

      await expect(embedder.embed(['x'])).resolves.toEqual([[1, 2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses when a LATER vector in the batch mismatches, even if the first one matches', async () => {
    // Task 14 fix-wave, Minor: the guard must not check only vectors[0] — a
    // batch whose first vector happens to be correct-width but a later one
    // isn't must still be refused, not partially stored.
    // CF-21: same body-stream fixture requirement as the test above.
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 2, 3] },
            { index: 1, embedding: [1, 2] },
          ],
        }),
        { status: 200 },
      );

    const embedder = new HttpEmbedder({
      endpoint: 'http://127.0.0.1:11434',
      model: 'm',
      fetchImpl,
    });
    await expect(embedder.embed(['x', 'y'], 3)).rejects.toThrow('embedding width mismatch');
  });
});

describe('CF-21: bounded read (4 MiB cap) on the embeddings response', () => {
  it('rejects a well-over-4-MiB /v1/embeddings response body instead of buffering it without limit', async () => {
    // 5 x 1 MiB chunks = 5 MiB, past the 4 MiB MAX_STREAM_BYTES cap —
    // mirrors LlamaCppInfillBackend.test.ts's identical D1 over-cap proof
    // ("rejects a well-over-4-MiB /infill response body...").
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulls = 0;
    const overCapBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 5) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    // Deliberately body-only (no `.json()` method): the OLD unbounded
    // `res.json()` call has nothing to read from this fixture, while the
    // NEW `readJsonBounded(res)` call reads via `.body.getReader()` and
    // must reject once the 4 MiB cap is exceeded — proving today's read is
    // unbounded and tomorrow's is capped, in one fixture.
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, statusText: 'OK', body: overCapBody }) as unknown as Response,
    ) as unknown as typeof fetch;

    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });

    await expect(embedder.embed(['x'])).rejects.toThrow(
      /response exceeded \d+ bytes without completing/,
    );
  });

  it('cancels the underlying read once the 4 MiB cap is exceeded, instead of draining a hostile/misbehaving server to completion', async () => {
    // Mirrors http.test.ts's `endlessGarbageStream`: a stream that NEVER
    // terminates on its own (the delimiter-free-garbage / never-closes
    // threat model D1 targets), so cancellation must be driven by
    // `readJsonBounded`'s own cap check — not race against the stream's
    // natural close, which a self-closing fixture would (verified: a
    // finite 5-chunk fixture flaked on this assertion because its own
    // `controller.close()` could win the race against `reader.cancel()`).
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(0x61); // 'a' repeated — no JSON-closing byte anywhere
    const overCapBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, statusText: 'OK', body: overCapBody }) as unknown as Response,
    ) as unknown as typeof fetch;

    const embedder = new HttpEmbedder({ endpoint: 'http://127.0.0.1:11434', model: 'm', fetchImpl });

    await expect(embedder.embed(['x'])).rejects.toThrow(
      /response exceeded \d+ bytes without completing/,
    );
    expect(cancelled).toBe(true);
  });
});
