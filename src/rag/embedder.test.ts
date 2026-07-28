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
    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      }) as unknown as Response;

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
    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [
            { index: 0, embedding: [1, 2, 3] },
            { index: 1, embedding: [1, 2] },
          ],
        }),
      }) as unknown as Response;

    const embedder = new HttpEmbedder({
      endpoint: 'http://127.0.0.1:11434',
      model: 'm',
      fetchImpl,
    });
    await expect(embedder.embed(['x', 'y'], 3)).rejects.toThrow('embedding width mismatch');
  });
});
