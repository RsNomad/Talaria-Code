import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ingestGguf, type GgufIngestIo, type TempWriteHandle } from './ggufIngest';
import type { GgufIngestSpec } from './SetupController';
import type { PullProgress } from './ollamaClient';

/**
 * ggufIngest.test.ts — T14 (beta5-setup-hardening-architecture.md §4.4.3d,
 * facts §0.3). Every network call `ingestGguf` makes routes through the
 * caller-injected `io.fetchImpl` seam, and every disk touch routes through
 * `io.createTempWrite`/`io.removeTemp`/`io.openTempRead` (in-memory fakes
 * here) — this suite never touches a real socket or the real filesystem,
 * same discipline `ollamaClient.test.ts`/`hfDigest.test.ts` establish one
 * module over. The REAL bindings (node fs/os/crypto/fetch) live in
 * `setupHost.vscode.ts`.
 */

const HF_REPO = 'SyntinalCo/sweep-next-edit-v2-7B-GGUF';
const GGUF_FILE = 'sweep-next-edit-v2-7B-Q4_K_M.gguf';
const ENDPOINT = 'http://127.0.0.1:11434';

const CONTENT = new TextEncoder().encode('fake gguf bytes for the T14 ingest suite — not a real model');
const PIN = createHash('sha256').update(CONTENT).digest('hex');

const SPEC: GgufIngestSpec = {
  gguf: {
    hfRepo: HF_REPO,
    file: GGUF_FILE,
    quant: 'Q4_K_M',
    sha256: PIN,
    approxBytes: CONTENT.byteLength * 100, // deliberately far from the real size — must fall back only when Content-Length is absent
    allowedRepoFiles: [GGUF_FILE, 'README.md', '.gitattributes'],
  },
  ollamaCreatedName: 'sweep-next-edit-v2-7B-Q4_K_M',
};

// --- in-memory io fake ------------------------------------------------------

function fakeIo(): {
  io: GgufIngestIo;
  removeTemp: ReturnType<typeof vi.fn>;
  tempStore: Map<string, Uint8Array[]>;
} {
  const tempStore = new Map<string, Uint8Array[]>();
  const removeTemp = vi.fn(async (path: string) => {
    tempStore.delete(path);
  });
  let counter = 0;
  const io: GgufIngestIo = {
    fetchImpl: vi.fn() as unknown as typeof fetch,
    createTempWrite: async (): Promise<TempWriteHandle> => {
      const path = `/tmp/gguf-ingest-${counter++}`;
      tempStore.set(path, []);
      return {
        path,
        write: async (chunk: Uint8Array) => {
          tempStore.get(path)!.push(chunk);
        },
        close: async () => {},
      };
    },
    removeTemp,
    openTempRead: async (path: string): Promise<AsyncIterable<Uint8Array>> => {
      const chunks = tempStore.get(path) ?? [];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
  return { io, removeTemp, tempStore };
}

// --- fetch response fakes ---------------------------------------------------

/** See ollamaClient.test.ts's identical alias: `ReadableStreamReadResult`
 *  isn't a global type name under this repo's `lib: ["ES2022"]` tsconfig. */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function chunkedBody(chunks: Uint8Array[]): { getReader: () => ReadableStreamDefaultReader<Uint8Array> } {
  let i = 0;
  const reader = {
    read: async (): Promise<StreamReadResult> => {
      const value = chunks[i];
      if (value === undefined) return { value: undefined, done: true };
      i += 1;
      return { value, done: false };
    },
    cancel: async () => {},
    releaseLock: () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { getReader: () => reader };
}

function downloadResponse(
  chunks: Uint8Array[],
  opts: { ok?: boolean; status?: number; statusText?: string; contentLength?: number } = {},
): Response {
  const { ok = true, status = 200, statusText = 'OK', contentLength } = opts;
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' && contentLength !== undefined ? String(contentLength) : null),
    },
    body: ok ? chunkedBody(chunks) : null,
  } as unknown as Response;
}

function plainResponse(status: number, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText } as unknown as Response;
}

/** A body whose reader's `read()` never resolves on its own — lets a test
 *  hold `ingestGguf` mid-download so it can assert abort behavior
 *  deterministically (identical shape to ollamaClient.test.ts's helper). */
function controllableReader(): { reader: ReadableStreamDefaultReader<Uint8Array> } {
  const reader = {
    read: (): Promise<StreamReadResult> => new Promise(() => {}),
    cancel: async () => {},
    releaseLock: () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { reader };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Routes `io.fetchImpl` calls by URL: HF download vs. the two Ollama
 *  endpoint calls, recording every URL seen so "zero endpoint calls" is
 *  assertable. */
function routedFetch(handlers: {
  download: (url: string) => Response;
  blob?: (url: string) => Response;
  create?: (url: string) => Response;
}): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://huggingface.co/')) return handlers.download(url);
    if (url.includes('/api/blobs/')) return (handlers.blob ?? (() => plainResponse(200)))(url);
    if (url.includes('/api/create')) return (handlers.create ?? (() => plainResponse(200)))(url);
    throw new Error(`unrouted fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// --- tests -------------------------------------------------------------------

describe('ingestGguf — digest-enforced GGUF ingest (T14, §4.4.3d)', () => {
  it('happy path: downloads the registry-pinned spec, and the blob POST URL + create body both carry sha256:{pin} verbatim', async () => {
    const { io, removeTemp } = fakeIo();
    const { fetchImpl, calls } = routedFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal);

    const downloadCall = calls.find((c) => c.url.startsWith('https://huggingface.co/'));
    expect(downloadCall?.url).toBe(`https://huggingface.co/${HF_REPO}/resolve/main/${GGUF_FILE}`);

    const blobCall = calls.find((c) => c.url.includes('/api/blobs/'));
    expect(blobCall?.url).toBe(`${ENDPOINT}/api/blobs/sha256:${PIN}`);

    const createCall = calls.find((c) => c.url.includes('/api/create'));
    expect(createCall?.url).toBe(`${ENDPOINT}/api/create`);
    expect(createCall?.init?.body).toBe(
      JSON.stringify({ model: SPEC.ollamaCreatedName, files: { [GGUF_FILE]: `sha256:${PIN}` } }),
    );

    // Temp file removed on the SUCCESS path too.
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a byte-mismatch download refuses BEFORE any Ollama call and removes the temp file', async () => {
    const { io, removeTemp } = fakeIo();
    const wrongBytes = new TextEncoder().encode('these are NOT the pinned bytes');
    const { fetchImpl, calls } = routedFetch({ download: () => downloadResponse([wrongBytes]) });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow();

    expect(calls.some((c) => c.url.includes('/api/blobs/') || c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx blob response refuses, removes the temp file, and never calls /api/create', async () => {
    const { io, removeTemp } = fakeIo();
    const { fetchImpl, calls } = routedFetch({
      download: () => downloadResponse([CONTENT]),
      blob: () => plainResponse(500, 'Internal Server Error'),
    });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/500/);

    expect(calls.some((c) => c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx create response refuses and removes the temp file', async () => {
    const { io, removeTemp } = fakeIo();
    const { fetchImpl } = routedFetch({
      download: () => downloadResponse([CONTENT]),
      create: () => plainResponse(400, 'Bad Request'),
    });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/400/);
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx HF download response refuses and removes the temp file, without calling the endpoint at all', async () => {
    const { io, removeTemp } = fakeIo();
    const { fetchImpl, calls } = routedFetch({ download: () => downloadResponse([], { ok: false, status: 404, statusText: 'Not Found' }) });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/404/);

    expect(calls.some((c) => c.url.includes('/api/blobs/') || c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('aborting mid-download rejects with an AbortError and removes the temp file', async () => {
    const { io, removeTemp } = fakeIo();
    const { reader } = controllableReader();
    io.fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://huggingface.co/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          body: { getReader: () => reader },
        } as unknown as Response;
      }
      throw new Error(`unrouted fetch: ${url}`);
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    const promise = ingestGguf(io, SPEC, ENDPOINT, () => {}, controller.signal);
    // Let ingestGguf reach its (permanently pending) reader.read() before aborting.
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('forwards progress events with monotonically increasing completedBytes across download chunks', async () => {
    const { io } = fakeIo();
    const half = Math.ceil(CONTENT.byteLength / 2);
    const chunkA = CONTENT.slice(0, half);
    const chunkB = CONTENT.slice(half);
    const { fetchImpl } = routedFetch({ download: () => downloadResponse([chunkA, chunkB]) });
    io.fetchImpl = fetchImpl;
    const progress: PullProgress[] = [];

    await ingestGguf(io, SPEC, ENDPOINT, (p) => progress.push(p), new AbortController().signal);

    const downloadEvents = progress.filter((p) => p.completedBytes !== undefined);
    expect(downloadEvents.length).toBeGreaterThanOrEqual(2);
    expect(downloadEvents[0]!.completedBytes).toBe(chunkA.byteLength);
    expect(downloadEvents[1]!.completedBytes).toBe(chunkA.byteLength + chunkB.byteLength);
    for (let i = 1; i < downloadEvents.length; i++) {
      expect(downloadEvents[i]!.completedBytes!).toBeGreaterThan(downloadEvents[i - 1]!.completedBytes!);
    }
    // No Content-Length on this fake response -> approxBytes is the total.
    expect(downloadEvents[0]!.totalBytes).toBe(SPEC.gguf.approxBytes);
  });

  it('uses the response Content-Length as the progress total when present, instead of approxBytes', async () => {
    const { io } = fakeIo();
    const { fetchImpl } = routedFetch({ download: () => downloadResponse([CONTENT], { contentLength: CONTENT.byteLength }) });
    io.fetchImpl = fetchImpl;
    const progress: PullProgress[] = [];

    await ingestGguf(io, SPEC, ENDPOINT, (p) => progress.push(p), new AbortController().signal);

    const downloadEvents = progress.filter((p) => p.completedBytes !== undefined);
    expect(downloadEvents[0]!.totalBytes).toBe(CONTENT.byteLength);
  });
});
