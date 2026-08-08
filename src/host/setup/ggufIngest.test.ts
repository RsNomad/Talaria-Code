import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  ingestGguf,
  downloadGgufToStore,
  GgufDigestShapeError,
  GgufStorePlacementError,
  GgufStoreRenameError,
  type GgufIngestIo,
  type GgufStoreIo,
  type GgufStoreSpec,
  type TempWriteHandle,
} from './ggufIngest';
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
  closeSpy: ReturnType<typeof vi.fn>;
  destroySpy: ReturnType<typeof vi.fn>;
  tempStore: Map<string, Uint8Array[]>;
} {
  const tempStore = new Map<string, Uint8Array[]>();
  const removeTemp = vi.fn(async (path: string) => {
    tempStore.delete(path);
  });
  // Findings 1/2 (T14 review): spies that prove the write handle's `close`
  // and the read handle's `destroy` are actually invoked on every exit path
  // — not just the normal-completion one. A single shared spy per `fakeIo()`
  // call is safe because every test here calls `ingestGguf` (and therefore
  // `createTempWrite`/`openTempRead`) exactly once.
  const closeSpy = vi.fn(async () => {});
  const destroySpy = vi.fn();
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
        close: closeSpy,
      };
    },
    removeTemp,
    openTempRead: async (path: string): Promise<AsyncIterable<Uint8Array> & { destroy?(): void }> => {
      const chunks = tempStore.get(path) ?? [];
      const gen = (async function* () {
        for (const c of chunks) yield c;
      })() as AsyncGenerator<Uint8Array> & { destroy?(): void };
      gen.destroy = destroySpy;
      return gen;
    },
  };
  return { io, removeTemp, closeSpy, destroySpy, tempStore };
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
    const { io, removeTemp, closeSpy, destroySpy } = fakeIo();
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
    // Finding 1: the write handle's fd is released on success too.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Finding 2: the blob-upload read stream is destroyed after a successful POST too.
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('normalizes an UPPERCASE registry sha256 pin to lowercase — digest compare, blob URL, and create body all use the lowercase pin (final-fixwave Fix 1)', async () => {
    const { io, removeTemp } = fakeIo();
    const upperPin = PIN.toUpperCase();
    expect(upperPin).not.toBe(PIN); // sanity: PIN carries letters, so this really differs
    const upperSpec: GgufIngestSpec = { ...SPEC, gguf: { ...SPEC.gguf, sha256: upperPin } };
    const { fetchImpl, calls } = routedFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await ingestGguf(io, upperSpec, ENDPOINT, () => {}, new AbortController().signal);

    const blobCall = calls.find((c) => c.url.includes('/api/blobs/'));
    expect(blobCall?.url).toBe(`${ENDPOINT}/api/blobs/sha256:${PIN}`); // lowercase, never the uppercase pin verbatim
    const createCall = calls.find((c) => c.url.includes('/api/create'));
    expect(createCall?.init?.body).toBe(
      JSON.stringify({ model: upperSpec.ollamaCreatedName, files: { [GGUF_FILE]: `sha256:${PIN}` } }),
    );
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a byte-mismatch download refuses BEFORE any Ollama call and removes the temp file', async () => {
    const { io, removeTemp, closeSpy } = fakeIo();
    const wrongBytes = new TextEncoder().encode('these are NOT the pinned bytes');
    const { fetchImpl, calls } = routedFetch({ download: () => downloadResponse([wrongBytes]) });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow();

    expect(calls.some((c) => c.url.includes('/api/blobs/') || c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
    // Finding 1: the download itself completed normally before the digest
    // compare, so the write handle must already be closed.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx blob response refuses, removes the temp file, and never calls /api/create', async () => {
    const { io, removeTemp, closeSpy, destroySpy } = fakeIo();
    const { fetchImpl, calls } = routedFetch({
      download: () => downloadResponse([CONTENT]),
      blob: () => plainResponse(500, 'Internal Server Error'),
    });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/500/);

    expect(calls.some((c) => c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Finding 2: the blob-upload read stream is destroyed on a non-2xx blob response.
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx create response refuses and removes the temp file', async () => {
    const { io, removeTemp, closeSpy, destroySpy } = fakeIo();
    const { fetchImpl } = routedFetch({
      download: () => downloadResponse([CONTENT]),
      create: () => plainResponse(400, 'Bad Request'),
    });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/400/);
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // The blob POST succeeded before /api/create failed — its read stream must still be destroyed.
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx HF download response refuses and removes the temp file, without calling the endpoint at all', async () => {
    const { io, removeTemp, closeSpy } = fakeIo();
    const { fetchImpl, calls } = routedFetch({ download: () => downloadResponse([], { ok: false, status: 404, statusText: 'Not Found' }) });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, SPEC, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/404/);

    expect(calls.some((c) => c.url.includes('/api/blobs/') || c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
    // Finding 1 (IMPORTANT): the HTTP-error throw happens BEFORE the old
    // unconditional `handle.close()` call site — pre-fix this is a fd leak.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('aborting mid-download rejects with an AbortError and removes the temp file', async () => {
    const { io, removeTemp, closeSpy } = fakeIo();
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
    // Finding 1 (IMPORTANT): abort throws from inside the download loop,
    // BEFORE the old unconditional `handle.close()` call site — pre-fix
    // this leaks the write-stream fd (and the disk blocks behind it) for
    // the lifetime of the extension host.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('aborting mid-blob-upload destroys the read stream and rejects with AbortError (Finding 2)', async () => {
    const { io, removeTemp, closeSpy, destroySpy } = fakeIo();
    const controller = new AbortController();
    io.fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('https://huggingface.co/')) return downloadResponse([CONTENT]);
      if (url.includes('/api/blobs/')) {
        // Never resolves on its own — mirrors how a real in-flight fetch
        // reacts to the caller's AbortController#abort() firing mid-POST.
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal ?? controller.signal;
          sig.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
        });
      }
      throw new Error(`unrouted fetch: ${url}`);
    }) as unknown as typeof fetch;

    const promise = ingestGguf(io, SPEC, ENDPOINT, () => {}, controller.signal);
    // Let the download complete and the blob POST start (both are
    // microtask-only — no real I/O — so a single macrotask tick suffices).
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // Finding 2 (MINOR): the read stream to the full ~4.7 GB temp must be
    // destroyed on an abort mid-blob-POST, not left open until process exit.
    expect(destroySpy).toHaveBeenCalledTimes(1);
    // The download phase itself completed normally before the abort landed.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('rejects once the download exceeds the size ceiling (approxBytes*1.1), aborts, and calls zero endpoints (Finding 3)', async () => {
    const { io, removeTemp, closeSpy } = fakeIo();
    // approxBytes=100 -> ceiling = ceil(100*1.1) = 110 bytes. The fake
    // Content-Length LIES (says 50, well under the ceiling) to prove the
    // ceiling is derived from the pinned `approxBytes`, never a trusted
    // response header — a hostile responder controls Content-Length too.
    const smallSpec: GgufIngestSpec = { ...SPEC, gguf: { ...SPEC.gguf, approxBytes: 100 } };
    const oversizedChunk = new Uint8Array(200).fill(7);
    const { fetchImpl, calls } = routedFetch({
      download: () => downloadResponse([oversizedChunk], { contentLength: 50 }),
    });
    io.fetchImpl = fetchImpl;

    await expect(ingestGguf(io, smallSpec, ENDPOINT, () => {}, new AbortController().signal)).rejects.toThrow(/size/i);

    expect(calls.some((c) => c.url.includes('/api/blobs/') || c.url.includes('/api/create'))).toBe(false);
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
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

// --- downloadGgufToStore (beta.6 T3, §2.4/§2.2.8/§7 line 509) --------------

const STORE_CATALOG_ID = 'sweep-next';
const DEST_DIR = '/store/SyntinalCo/sweep-next-edit-v2-7B-GGUF';
const DEST_FILE = GGUF_FILE;
const DEST_PATH = `${DEST_DIR}/${DEST_FILE}`;

const STORE_SPEC: GgufStoreSpec = {
  catalogId: STORE_CATALOG_ID,
  gguf: {
    hfRepo: HF_REPO,
    file: GGUF_FILE,
    quant: 'Q4_K_M',
    sha256: PIN,
    approxBytes: CONTENT.byteLength * 100,
  },
};

/** In-memory fake of {@link GgufStoreIo} — mirrors `fakeIo()`'s own
 *  discipline one describe-block up. `order` records the RELATIVE order of
 *  every write/rename/sidecar/cleanup call so tests can prove
 *  rename-strictly-after-digest and sidecar-strictly-after-rename by spy
 *  order, not just by call counts. `tempDir` defaults to the SAME directory
 *  `downloadGgufToStore` is asked to write into — a test overrides it to
 *  simulate a `createStoreTempWrite` binding that (incorrectly) placed the
 *  temp file elsewhere (the SC-4 contract-violation case). */
function fakeStoreIo(opts: { tempDir?: string } = {}): {
  io: GgufStoreIo;
  ensureDir: ReturnType<typeof vi.fn>;
  removeTemp: ReturnType<typeof vi.fn>;
  renameTemp: ReturnType<typeof vi.fn>;
  writeSidecar: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
  order: string[];
} {
  const tempStore = new Map<string, Uint8Array[]>();
  const order: string[] = [];
  const tempDir = opts.tempDir ?? DEST_DIR;
  const ensureDir = vi.fn(async (_dir: string) => {});
  const removeTemp = vi.fn(async (path: string) => {
    tempStore.delete(path);
    order.push('removeTemp');
  });
  const renameTemp = vi.fn(async (_tempPath: string, _destPath: string) => {
    order.push('renameTemp');
  });
  const writeSidecar = vi.fn(async (_sidecarPath: string, _content: string) => {
    order.push('writeSidecar');
  });
  const closeSpy = vi.fn(async () => {});
  let counter = 0;
  const io: GgufStoreIo = {
    fetchImpl: vi.fn() as unknown as typeof fetch,
    ensureDir,
    createStoreTempWrite: async (_destDir: string): Promise<TempWriteHandle> => {
      const path = `${tempDir}/gguf-store-${counter++}.part`;
      tempStore.set(path, []);
      return {
        path,
        write: async (chunk: Uint8Array) => {
          tempStore.get(path)!.push(chunk);
          order.push('write');
        },
        close: closeSpy,
      };
    },
    removeTemp,
    renameTemp,
    writeSidecar,
  };
  return { io, ensureDir, removeTemp, renameTemp, writeSidecar, closeSpy, order };
}

/** Routes `io.fetchImpl` to the single HF download URL the store sink ever
 *  calls — no Ollama endpoints exist on this path (no blob POST, no
 *  create), so anything else is a test bug. */
function storeFetch(handlers: { download: (url: string) => Response }): {
  fetchImpl: typeof fetch;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push({ url });
    if (url.startsWith('https://huggingface.co/')) return handlers.download(url);
    throw new Error(`unrouted fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('downloadGgufToStore — atomic same-dir file sink (beta.6 T3, §2.4/§2.2.8)', () => {
  it('happy path: downloads, renames strictly after the digest passes, then writes the sidecar strictly after the rename (spy order)', async () => {
    const { io, ensureDir, removeTemp, renameTemp, writeSidecar, closeSpy, order } = fakeStoreIo();
    const { fetchImpl, calls } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal);

    expect(calls[0]?.url).toBe(`https://huggingface.co/${HF_REPO}/resolve/main/${GGUF_FILE}`);
    expect(ensureDir).toHaveBeenCalledWith(DEST_DIR);
    expect(renameTemp).toHaveBeenCalledTimes(1);
    const renameCall = renameTemp.mock.calls[0] as [string, string];
    expect(renameCall[1]).toBe(DEST_PATH);
    expect(writeSidecar).toHaveBeenCalledTimes(1);
    const sidecarCall = writeSidecar.mock.calls[0] as [string, string];
    expect(sidecarCall[0]).toBe(`${DEST_PATH}.talaria.json`);
    const sidecar = JSON.parse(sidecarCall[1]) as { catalogId: string; sha256: string; bytes: number; verifiedAt: string };
    expect(sidecar.catalogId).toBe(STORE_CATALOG_ID);
    expect(sidecar.sha256).toBe(PIN);
    expect(sidecar.bytes).toBe(CONTENT.byteLength);
    expect(typeof sidecar.verifiedAt).toBe('string');
    expect(Number.isNaN(Date.parse(sidecar.verifiedAt))).toBe(false);

    // Spy-order proof: rename happens strictly AFTER every download write
    // (i.e. after the digest was fully computed), and the sidecar strictly
    // AFTER the rename — never before either.
    const lastWriteIdx = order.lastIndexOf('write');
    const renameIdx = order.indexOf('renameTemp');
    const sidecarIdx = order.indexOf('writeSidecar');
    expect(lastWriteIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(lastWriteIdx);
    expect(sidecarIdx).toBeGreaterThan(renameIdx);
    expect(removeTemp).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('normalizes an UPPERCASE expected digest to lowercase in the sidecar sha256', async () => {
    const { io, writeSidecar } = fakeStoreIo();
    const upperSpec: GgufStoreSpec = { ...STORE_SPEC, gguf: { ...STORE_SPEC.gguf, sha256: PIN.toUpperCase() } };
    const { fetchImpl } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await downloadGgufToStore(io, upperSpec, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal);

    const sidecarCall = writeSidecar.mock.calls[0] as [string, string];
    const sidecar = JSON.parse(sidecarCall[1]) as { sha256: string };
    expect(sidecar.sha256).toBe(PIN); // lowercase, never the uppercase value verbatim
  });

  it('refuses when createStoreTempWrite returns a path outside destDir — before any fetch — and cleans up the misplaced temp (SC-4)', async () => {
    const { io, ensureDir, removeTemp } = fakeStoreIo({ tempDir: '/somewhere/else' });
    const { fetchImpl, calls } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(GgufStorePlacementError);

    expect(ensureDir).toHaveBeenCalledTimes(1); // ensureDir still runs before the temp-write contract is checked
    expect(calls.length).toBe(0); // never reached the network
    expect(removeTemp).toHaveBeenCalledTimes(1); // still cleans up whatever createStoreTempWrite created
  });

  it('a byte-mismatch download refuses BEFORE renaming, removes the .part, and never writes a sidecar', async () => {
    const { io, removeTemp, renameTemp, writeSidecar, closeSpy } = fakeStoreIo();
    const wrongBytes = new TextEncoder().encode('these are NOT the pinned bytes at all');
    const { fetchImpl } = storeFetch({ download: () => downloadResponse([wrongBytes]) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(/digest mismatch/i);

    expect(renameTemp).not.toHaveBeenCalled();
    expect(writeSidecar).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('EXDEV on rename refuses, cleans up the .part, preserves the original error as .cause, and NEVER writes a sidecar — no copy fallback', async () => {
    const { io, removeTemp, writeSidecar } = fakeStoreIo();
    const { fetchImpl } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    io.renameTemp = vi.fn(async () => {
      throw exdev;
    });

    let caught: unknown;
    try {
      await downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GgufStoreRenameError);
    expect((caught as GgufStoreRenameError).cause).toBe(exdev);
    // The io seam this engine is given has no copy/write-at-dest method at
    // all — structurally, there is nothing for a "copy fallback" to call.
    expect(writeSidecar).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a non-EXDEV rename failure is refused identically — cleanup, no sidecar, no copy fallback', async () => {
    const { io, removeTemp, writeSidecar } = fakeStoreIo();
    const { fetchImpl } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;
    io.renameTemp = vi.fn(async () => {
      throw new Error('EPERM: operation not permitted');
    });

    await expect(
      downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(GgufStoreRenameError);
    expect(writeSidecar).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1);
  });

  it('a non-2xx HF download response refuses, removes the .part, and closes the write handle', async () => {
    const { io, removeTemp, renameTemp, closeSpy } = fakeStoreIo();
    const { fetchImpl } = storeFetch({
      download: () => downloadResponse([], { ok: false, status: 404, statusText: 'Not Found' }),
    });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(/404/);

    expect(renameTemp).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('aborting mid-download rejects with AbortError, removes the .part, and closes the write handle', async () => {
    const { io, removeTemp, renameTemp, closeSpy } = fakeStoreIo();
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

    const promise = downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, controller.signal);
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(renameTemp).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects once the download exceeds the size ceiling, removes the .part, closes the handle, and never renames', async () => {
    const { io, removeTemp, renameTemp, closeSpy } = fakeStoreIo();
    const smallSpec: GgufStoreSpec = { ...STORE_SPEC, gguf: { ...STORE_SPEC.gguf, approxBytes: 100 } };
    const oversizedChunk = new Uint8Array(200).fill(7);
    const { fetchImpl } = storeFetch({ download: () => downloadResponse([oversizedChunk], { contentLength: 50 }) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, smallSpec, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(/size/i);

    expect(renameTemp).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed expected digest BEFORE touching ensureDir/createStoreTempWrite/fetch (SC-A-8 shape assert, defense-in-depth)', async () => {
    const { io, ensureDir } = fakeStoreIo();
    const badSpec: GgufStoreSpec = { ...STORE_SPEC, gguf: { ...STORE_SPEC.gguf, sha256: 'not-a-valid-sha256' } };
    const { fetchImpl, calls } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, badSpec, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(GgufDigestShapeError);

    expect(ensureDir).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it('refuses an empty expected digest (unpublished pin) via the same shape assert', async () => {
    const { io, ensureDir } = fakeStoreIo();
    const emptySpec: GgufStoreSpec = { ...STORE_SPEC, gguf: { ...STORE_SPEC.gguf, sha256: '' } };
    const { fetchImpl, calls } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, emptySpec, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(GgufDigestShapeError);

    expect(ensureDir).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it('closes the write handle on the SC-4 placement-violation refusal path (CR-1 defense-in-depth)', async () => {
    const { io, removeTemp, closeSpy } = fakeStoreIo({ tempDir: '/somewhere/else' });
    const { fetchImpl, calls } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, () => {}, new AbortController().signal),
    ).rejects.toThrow(GgufStorePlacementError);

    expect(calls.length).toBe(0); // never reached the network
    expect(removeTemp).toHaveBeenCalledTimes(1); // .part still cleaned up
    // CR-1: the write handle's fd must also be released on this exit path —
    // pre-fix, only removeTemp ran and the fd (plus, on POSIX, the disk
    // blocks behind an unlinked-but-still-open partial file) leaked.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a traversing destFile whose composed dest path escapes destDir — before any network work (CR-2 symmetric guard)', async () => {
    const { io, ensureDir, removeTemp, renameTemp, writeSidecar, closeSpy } = fakeStoreIo();
    const { fetchImpl, calls } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;

    await expect(
      downloadGgufToStore(io, STORE_SPEC, DEST_DIR, '../escape.gguf', () => {}, new AbortController().signal),
    ).rejects.toThrow(GgufStorePlacementError);

    expect(ensureDir).toHaveBeenCalledTimes(1); // ensureDir still runs before the destPath guard
    expect(calls.length).toBe(0); // never reached the network — refused BEFORE any download
    expect(renameTemp).not.toHaveBeenCalled();
    expect(writeSidecar).not.toHaveBeenCalled();
    expect(removeTemp).toHaveBeenCalledTimes(1); // .part cleaned up
    expect(closeSpy).toHaveBeenCalledTimes(1); // handle closed, same failure shape as CR-1
  });

  it('forwards progress events through to the caller during the store download too', async () => {
    const { io } = fakeStoreIo();
    const { fetchImpl } = storeFetch({ download: () => downloadResponse([CONTENT]) });
    io.fetchImpl = fetchImpl;
    const progress: PullProgress[] = [];

    await downloadGgufToStore(io, STORE_SPEC, DEST_DIR, DEST_FILE, (p) => progress.push(p), new AbortController().signal);

    const downloadEvents = progress.filter((p) => p.completedBytes !== undefined);
    expect(downloadEvents.length).toBeGreaterThanOrEqual(1);
    expect(downloadEvents.at(-1)!.completedBytes).toBe(CONTENT.byteLength);
  });
});
