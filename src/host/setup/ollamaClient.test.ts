import { describe, it, expect, vi } from 'vitest';
import { probeOllama, pullModel, StreamByteCapError, type OllamaStatus, type PullProgress } from './ollamaClient';

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

// WS-SU Task 6: probeOllama now reads the BODY stream (F2-15) — fixture carries one.
function jsonResponse(status: number, statusText: string, body: unknown): Response {
  const chunk = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    body: chunkedBody([chunk]),
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

describe('F2-15: probeOllama caps the /api/tags body read', () => {
  it('an over-cap body degrades to {running:false} with a cap-naming detail', async () => {
    const huge = new TextEncoder().encode(`{"models":[{"name":"${'x'.repeat(1_100_000)}","size":1}]}`);
    const response = { ok: true, status: 200, statusText: 'OK', body: chunkedBody([huge]) } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const status = await probeOllama(ENDPOINT, fetchImpl);
    expect(status.running).toBe(false);
    if (!status.running) expect(status.detail).toContain('exceeded');
  });
  it('stops reading once the running total crosses the cap — never drains the rest of the stream (M-T6b pin)', async () => {
    // The invariant the renamed test above cannot observe from a single
    // chunk: `readBodyBounded` returns BEFORE appending the over-cap chunk
    // and stops issuing read()s. Same read-call-count idiom as pullModel's
    // "bails out WHILE reading" test below. Six 512 KiB chunks are on offer
    // (3 MiB); the 1 MiB probe cap is first EXCEEDED on chunk 3 (1.5 MiB —
    // chunk 2's exact 1 MiB is not `>` the cap), so read() must be called at
    // most 3 times — draining all 6 (plus the terminal done-read) is the
    // regression this pins against.
    const chunk = new Uint8Array(512 * 1024).fill(97); // 'a' bytes; no newline needed — the probe body is one-shot JSON
    let calls = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn(async (): Promise<StreamReadResult> => {
        calls += 1;
        if (calls > 6) return { value: undefined, done: true };
        return { value: chunk, done: false };
      }),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = { ok: true, status: 200, statusText: 'OK', body: { getReader: () => reader } } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);

    const status = await probeOllama(ENDPOINT, fetchImpl);

    expect(status.running).toBe(false);
    if (!status.running) expect(status.detail).toContain('exceeded');
    expect(calls).toBeLessThanOrEqual(3); // the load-bearing assertion: bailed WHILE reading
    expect(cancel).toHaveBeenCalled(); // teardown sanity — the finally cancels on every exit path
  });
  it('a 200 with NO readable body degrades to {running:false} with a reason-naming detail (fail-closed, never a crash)', async () => {
    const response = { ok: true, status: 200, statusText: 'OK' } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const status = await probeOllama(ENDPOINT, fetchImpl);
    expect(status.running).toBe(false);
    // M-T6a: parity with the over-cap sibling — the detail names WHY, so the
    // failure is diagnosable. Pins readBodyBounded's stable template reason.
    if (!status.running) expect(status.detail).toContain('no readable body');
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

  // --- FIX 2 (final review wave, T6 M-1): unbounded NDJSON buffer -> OOM ----

  it('a stream exceeding the 4 MiB cap WITHOUT a newline rejects with a StreamByteCapError naming the cap', async () => {
    const MAX_STREAM_BYTES = 4 * 1024 * 1024;
    // Five 1 MiB chunks of newline-free garbage — same delimiter-free-flood
    // shape http.ts's own byte-cap tests exercise. Only chunk 5 pushes the
    // running total past the cap; earlier chunks must NOT throw early.
    const chunkSize = MAX_STREAM_BYTES / 4;
    const chunk = new Uint8Array(chunkSize).fill(97); // 'a' * 1 MiB, no '\n'
    const chunks = [chunk, chunk, chunk, chunk, chunk];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, body: chunkedBody(chunks) } as unknown as Response);
    const progress: PullProgress[] = [];

    let caught: unknown;
    try {
      await pullModel(ENDPOINT, 'm', fetchImpl, (p) => progress.push(p), new AbortController().signal);
    } catch (err) {
      caught = err;
    }

    // Asserted structurally (name/message/cap), not via `instanceof
    // StreamByteCapError` — an unexported class would make `instanceof`
    // with an `undefined` import silently vacuous. Also proves this is NOT
    // the pre-fix failure mode (a `JSON.parse` SyntaxError once the stream
    // ends with a non-JSON trailing buffer) — a real regression check, not
    // just "it threw something".
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('StreamByteCapError');
    expect((caught as Error).message).toContain(String(MAX_STREAM_BYTES));
    expect((caught as { cap?: number }).cap).toBe(MAX_STREAM_BYTES);
    expect(caught).toBeInstanceOf(StreamByteCapError);

    // No progress was ever parsed — the flood never contained a completed line.
    expect(progress).toEqual([]);
  });

  it('bails out WHILE reading (does not drain the whole stream first) — the actual unbounded-growth fix', async () => {
    // 20 MiB across twenty 1 MiB no-newline chunks — five times the 4 MiB
    // cap. A read-call-count assertion is robust independent of whichever
    // error type/import resolves: pre-fix, `pullModel` has no cap, so it
    // drains ALL 20 chunks (plus the terminal `done` read) before doing
    // anything with the (garbage) trailing buffer — 21 read() calls.
    // Post-fix, it must stop within a handful of reads, once the running
    // total first crosses MAX_STREAM_BYTES — proving the fix actually
    // bounds memory growth, not merely that *some* rejection eventually
    // happens once the stream ends.
    const TOTAL_CHUNKS = 20;
    const chunk = new Uint8Array(1024 * 1024).fill(97); // 1 MiB, no '\n'
    let calls = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn(async () => {
        calls += 1;
        if (calls > TOTAL_CHUNKS) return { value: undefined, done: true };
        return { value: chunk, done: false };
      }),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, body: { getReader: () => reader } } as unknown as Response);

    await expect(pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal)).rejects.toThrow();

    // 4 MiB / 1 MiB = 4 full chunks is still under the cap; the 5th chunk
    // (running total 5 MiB) is what crosses it — so read() must be called
    // AT MOST 5 times, nowhere near all 20 (let alone the 21st done-read).
    expect(calls).toBeLessThanOrEqual(5);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('F1-6: pull completion is REQUIRED, not assumed', () => {
  it('a stream that ends WITHOUT {"status":"success"} rejects PullIncompleteError', async () => {
    const lines = [
      JSON.stringify({ status: 'pulling manifest' }),
      JSON.stringify({ status: 'pulling sha256:aaa', total: 10, completed: 5 }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));
    const promise = pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal);
    await expect(promise).rejects.toThrow('pull stream ended before {"status":"success"} — incomplete');
    await expect(promise).rejects.toMatchObject({ name: 'PullIncompleteError' });
  });

  it('success arriving as the FINAL, un-newline-terminated trailing chunk still resolves', async () => {
    const chunk = new TextEncoder().encode(`${JSON.stringify({ status: 'pulling manifest' })}\n${JSON.stringify({ status: 'success' })}`);
    const response = { ok: true, body: chunkedBody([chunk]) } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);
    await expect(pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('an empty stream (immediate done) rejects PullIncompleteError', async () => {
    const response = { ok: true, body: chunkedBody([]) } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);
    await expect(pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: 'PullIncompleteError',
    });
  });
});

describe('F1-7: malformed NDJSON lines are counted + skipped, never fatal one-by-one', () => {
  it('one malformed line mid-stream is skipped; the pull still completes on the later success', async () => {
    const lines = [JSON.stringify({ status: 'pulling manifest' }), '{not json', JSON.stringify({ status: 'success' })];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));
    const seen: string[] = [];
    await expect(pullModel(ENDPOINT, 'm', fetchImpl, (p) => seen.push(p.status), new AbortController().signal)).resolves.toBeUndefined();
    expect(seen).toEqual(['pulling manifest', 'success']);
  });
  it('MORE than MAX_MALFORMED_PULL_LINES malformed lines fail the pull honestly', async () => {
    const lines = Array.from({ length: 21 }, () => '{not json');
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));
    await expect(pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: 'PullMalformedStreamError',
    });
  });
  it('EXACTLY MAX_MALFORMED_PULL_LINES (20) malformed lines are tolerated — the boundary itself, not just 21 (M-T5 pin)', async () => {
    // Pins the strict `>` in `malformedLines > MAX_MALFORMED_PULL_LINES`
    // (ollamaClient.ts): a silent regression to `>=` would still pass the
    // 21-line test above yet break the documented "20 tolerated" guarantee.
    // `streamingResponse` newline-terminates every line, so all 20 malformed
    // lines land in the inner parse loop before the success line does.
    const lines = [...Array.from({ length: 20 }, () => '{not json'), JSON.stringify({ status: 'success' })];
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));
    const seen: string[] = [];
    await expect(
      pullModel(ENDPOINT, 'm', fetchImpl, (p) => seen.push(p.status), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(['success']); // the malformed lines emitted no progress ticks
  });
  it('fail-closed interplay (F1-6×F1-7): a malformed SUCCESS line ends as PullIncompleteError, never silent success', async () => {
    const lines = [JSON.stringify({ status: 'pulling manifest' }), '{"status":"success"']; // truncated JSON
    const fetchImpl = vi.fn().mockResolvedValue(streamingResponse(lines));
    await expect(pullModel(ENDPOINT, 'm', fetchImpl, () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: 'PullIncompleteError',
    });
  });
});
