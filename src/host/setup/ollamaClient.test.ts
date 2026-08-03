import { describe, it, expect, vi } from 'vitest';
import { probeOllama, pullModel, type OllamaStatus, type PullProgress } from './ollamaClient';

/**
 * ollamaClient.test.ts — Task 6 (onboarding-backend-setup-architecture.md
 * §2.4). Every network call `probeOllama`/`pullModel` makes routes through
 * the caller-injected `fetchImpl` seam, so this suite never touches a real
 * socket — same discipline `pipxInstaller.test.ts`/`pipxLocator.test.ts`
 * establish for subprocess I/O one module over.
 *
 * Shapes grounded via Context7 `/ollama/ollama` (docs/api.md, api/types.go,
 * docs/api/errors.mdx), re-verified 2026-08-04 — see ollamaClient.ts's own
 * header for the citations.
 */

const ENDPOINT = 'http://127.0.0.1:11434';

/** See ollamaClient.ts's identical alias: `ReadableStreamReadResult` isn't a
 *  global type name under this repo's `lib: ["ES2022"]` tsconfig. */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

// --- shared fetch-response fakes ----------------------------------------

function jsonResponse(status: number, statusText: string, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

/** A fake `ReadableStream<Uint8Array>`-shaped body backed by a fixed list of
 *  already-encoded chunks, delivered one per `read()` call in order. */
function chunkedBody(chunks: Uint8Array[]): { getReader: () => ReadableStreamDefaultReader<Uint8Array> } {
  let i = 0;
  const reader = {
    read: async (): Promise<StreamReadResult> => {
      const value = chunks[i];
      if (value === undefined) {
        return { value: undefined, done: true };
      }
      i += 1;
      return { value, done: false };
    },
    cancel: async () => {},
    releaseLock: () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { getReader: () => reader };
}

/** A streaming 200 response whose body is every `lines` entry newline-joined
 *  and delivered as ONE chunk (the boundary-split behavior gets its own
 *  dedicated test below). */
function streamingResponse(lines: string[]): Response {
  const text = lines.map((l) => `${l}\n`).join('');
  const chunk = new TextEncoder().encode(text);
  return { ok: true, body: chunkedBody([chunk]) } as unknown as Response;
}

/** A body whose reader's `read()` never resolves on its own — the caller
 *  must `push()` a chunk to resolve the currently-pending read. Lets a test
 *  hold `pullModel` mid-stream so it can assert abort behavior deterministically. */
function controllableReader(): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  push: (chunk: Uint8Array) => void;
} {
  let resolveNext: ((r: StreamReadResult) => void) | undefined;
  const reader = {
    read: (): Promise<StreamReadResult> =>
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
    cancel: async () => {},
    releaseLock: () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return {
    reader,
    push: (chunk: Uint8Array) => resolveNext?.({ value: chunk, done: false }),
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- probeOllama ----------------------------------------------------------

describe('probeOllama — GET /api/tags (§2.4)', () => {
  it('200 tags fixture maps models[] to {name, sizeBytes} and reports running:true', async () => {
    const fixture = {
      models: [
        {
          name: 'qwen2.5-coder:1.5b-base',
          model: 'qwen2.5-coder:1.5b-base',
          modified_at: '2026-01-01T00:00:00Z',
          size: 986_000_000,
          digest: 'sha256:aaa',
          details: {},
        },
        {
          name: 'qwen3-embedding:0.6b',
          model: 'qwen3-embedding:0.6b',
          modified_at: '2026-01-01T00:00:00Z',
          size: 600_000_000,
          digest: 'sha256:bbb',
          details: {},
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, 'OK', fixture));

    const result = await probeOllama(ENDPOINT, fetchImpl);

    expect(result).toEqual<OllamaStatus>({
      running: true,
      models: [
        { name: 'qwen2.5-coder:1.5b-base', sizeBytes: 986_000_000 },
        { name: 'qwen3-embedding:0.6b', sizeBytes: 600_000_000 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('a connection-refused-style fetch rejection reports {running:false}', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }));

    const result = await probeOllama(ENDPOINT, fetchImpl);

    expect(result.running).toBe(false);
    expect((result as { running: false; detail: string }).detail).toContain('ECONNREFUSED');
  });

  it('a non-200 response reports {running:false} with a status-carrying detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, 'Internal Server Error', {}));

    const result = await probeOllama(ENDPOINT, fetchImpl);

    expect(result).toEqual({ running: false, detail: expect.stringContaining('500') });
  });

  it('aborts via an AbortController once timeoutMs elapses without the fetch settling', async () => {
    const fetchImpl = vi.fn((_url: string, opts: { signal: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const result = await probeOllama(ENDPOINT, fetchImpl as unknown as typeof fetch, 5);

    expect(result.running).toBe(false);
  });
});

// --- pullModel --------------------------------------------------------------

describe('pullModel — POST /api/pull streaming NDJSON (§2.4)', () => {
  it('happy path: manifest -> two progress chunks with totals -> success resolves and reports byte fields', async () => {
    const lines = [
      JSON.stringify({ status: 'pulling manifest' }),
      JSON.stringify({ status: 'pulling sha256:aaa', digest: 'sha256:aaa', total: 1000, completed: 200 }),
      JSON.stringify({ status: 'pulling sha256:aaa', digest: 'sha256:aaa', total: 1000, completed: 1000 }),
      JSON.stringify({ status: 'success' }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));
    const progress: PullProgress[] = [];

    await pullModel(
      ENDPOINT,
      'qwen2.5-coder:1.5b-base',
      fetchImpl,
      (p) => progress.push(p),
      new AbortController().signal,
    );

    expect(progress).toEqual([
      { status: 'pulling manifest', totalBytes: undefined, completedBytes: undefined },
      { status: 'pulling sha256:aaa', totalBytes: 1000, completedBytes: 200 },
      { status: 'pulling sha256:aaa', totalBytes: 1000, completedBytes: 1000 },
      { status: 'success', totalBytes: undefined, completedBytes: undefined },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/pull',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'qwen2.5-coder:1.5b-base' }),
      }),
    );
  });

  it('an {"error"} chunk rejects with that exact message', async () => {
    const lines = [JSON.stringify({ status: 'pulling manifest' }), JSON.stringify({ error: 'disk full' })];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));

    await expect(
      pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal),
    ).rejects.toThrow('disk full');
  });

  it('a non-2xx response rejects', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', body: null } as unknown as Response);

    await expect(
      pullModel(ENDPOINT, 'missing-model', fetchImpl, () => {}, new AbortController().signal),
    ).rejects.toThrow(/404/);
  });

  it('aborting mid-stream rejects with an AbortError', async () => {
    const { reader } = controllableReader();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } } as unknown as Response);
    const controller = new AbortController();

    const promise = pullModel(ENDPOINT, 'm', fetchImpl, () => {}, controller.signal);
    // Let pullModel reach its (permanently pending) reader.read() before aborting.
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('parses an NDJSON line split across two stream chunk boundaries exactly once', async () => {
    const splitLine = JSON.stringify({ status: 'pulling sha256:split', digest: 'sha256:split', total: 500, completed: 250 });
    const splitAt = Math.floor(splitLine.length / 2);
    const encoder = new TextEncoder();
    const part1 = encoder.encode(splitLine.slice(0, splitAt));
    const part2 = encoder.encode(`${splitLine.slice(splitAt)}\n${JSON.stringify({ status: 'success' })}\n`);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, body: chunkedBody([part1, part2]) } as unknown as Response);
    const progress: PullProgress[] = [];

    await pullModel(ENDPOINT, 'm', fetchImpl, (p) => progress.push(p), new AbortController().signal);

    expect(progress).toEqual([
      { status: 'pulling sha256:split', totalBytes: 500, completedBytes: 250 },
      { status: 'success', totalBytes: undefined, completedBytes: undefined },
    ]);
  });
});
