import { createHash } from 'node:crypto';
import type { GgufIngestSpec } from './SetupController';
import type { PullProgress } from './ollamaClient';

/**
 * ggufIngest — the digest-enforced GGUF ingest engine (beta5-setup-hardening-
 * architecture.md §4.4.3d, facts §0.3; Task 14 of the beta.5 plan).
 *
 * PURE — no `vscode` import (the `src/host/setup/` directory purity scan
 * applies), no ambient `fetch`/`fs`/`os`: every disk touch and every network
 * call is routed through the caller-injected {@link GgufIngestIo} seam, so
 * unit tests never touch a real socket or the real filesystem — the same
 * discipline `ollamaClient.ts`/`hfDigest.ts` apply one module over. The REAL
 * binding (node `fetch`/`fs`/`os`/`node:crypto`-backed temp file) lives in
 * `setupHost.vscode.ts`, which is deliberately NOT under `src/host/setup/`.
 *
 * `spec` is ALWAYS the registry-pinned artifact the controller resolved
 * (`SetupControllerDeps.ingestGguf`'s own doc: never anything
 * webview-derived) — this module trusts it structurally but re-derives
 * nothing from it beyond the four values the pipeline actually needs
 * (`hfRepo`, `file`, `sha256`, `approxBytes`, `ollamaCreatedName`).
 *
 * Pipeline, EXACT order (§4.4.3d.i-iv):
 *  1. stream-download `https://huggingface.co/{hfRepo}/resolve/main/{file}`
 *     to a temp file via `io.createTempWrite`, hashing the received bytes
 *     incrementally with `node:crypto` (`createHash('sha256')`) and
 *     forwarding `onProgress` per chunk — `totalBytes` prefers the
 *     response's `Content-Length` header when present, falling back to
 *     `spec.gguf.approxBytes` otherwise; abortable via `signal` (an abort
 *     mid-read rejects with an `AbortError` `DOMException`, matching
 *     `ollamaClient.ts pullModel`'s own convention).
 *  2. computed digest !== `spec.gguf.sha256` -> `io.removeTemp` + reject —
 *     ZERO Ollama calls: the mismatch is caught strictly BEFORE either
 *     `POST` below is ever issued, so no unverified byte reaches Ollama.
 *  3. `POST {endpoint}/api/blobs/sha256:{pin}` with the temp file re-opened
 *     via `io.openTempRead` as the request body (Ollama RE-VERIFIES the
 *     same digest server-side at ingest — docs/api.md) — non-2xx ->
 *     `removeTemp` + reject.
 *  4. `POST {endpoint}/api/create {model, files:{file:'sha256:'+pin}}` ->
 *     non-2xx (or a request-construction/stream error) -> `removeTemp` +
 *     reject; success -> falls through to the shared cleanup below.
 *
 * `io.removeTemp` runs on EVERY exit path (success, any refusal, or abort)
 * via a single `finally` wrapping the whole pipeline — there is exactly one
 * temp file per call and exactly one place that ever deletes it.
 */

/** One open temp-file write handle — {@link GgufIngestIo.createTempWrite}
 *  returns a fresh one per {@link ingestGguf} call. `path` is opaque to this
 *  module (only ever handed back to `removeTemp`/`openTempRead` verbatim);
 *  `write` appends bytes in call order; `close` flushes and releases the
 *  underlying handle. `close` MUST be safe to call exactly once and MUST be
 *  idempotent-safe from the caller's side (`downloadToTemp` always wraps it
 *  in `.catch(() => {})`) — it is invoked from a `finally` on EVERY exit
 *  from the download phase (success, HTTP-error, digest irrelevant here,
 *  or abort), so the underlying fd (and the disk blocks behind an unlinked-
 *  but-still-open partial file, POSIX) is never held past that point. */
export interface TempWriteHandle {
  readonly path: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** A temp-file read stream, as handed back by {@link GgufIngestIo.openTempRead}.
 *  Plain `AsyncIterable<Uint8Array>` is all `putBlob` NEEDS to hand to
 *  `fetchImpl`'s `BodyInit` (see the doc comment below), but Finding 2 (T14
 *  review) requires the fd behind it to be released on every exit from the
 *  blob-POST step — so the real binding's stream (`fs.ReadStream`, which
 *  already has `.destroy()`) is allowed to expose that optional method, and
 *  `putBlob` calls it unconditionally in a `finally`. */
export type TempReadStream = AsyncIterable<Uint8Array> & { destroy?(): void };

/**
 * Injected seams — `setupHost.vscode.ts` binds `fetchImpl` to
 * `globalThis.fetch` and the temp-file trio to `node:fs`/`node:os`; unit
 * tests inject in-memory fakes for all four so this module's own suite
 * never touches disk or a socket.
 *
 * `openTempRead` returns an `AsyncIterable<Uint8Array>` (not a Web
 * `ReadableStream`) deliberately — undici's `BodyInit` union accepts an
 * async-iterable body directly (Node.js docs, undici README: "Fetch with an
 * async iterable body"), and a Node `fs.createReadStream` result already
 * satisfies that shape via native async iteration, so the real binding
 * needs no `stream/web` conversion.
 */
export interface GgufIngestIo {
  fetchImpl: typeof fetch;
  createTempWrite(): Promise<TempWriteHandle>;
  removeTemp(path: string): Promise<void>;
  openTempRead(path: string): Promise<TempReadStream>;
}

/** Thrown when the incrementally-hashed downloaded bytes do not equal the
 *  code-pinned digest — the byte-mismatch refusal (§4.4.3d.ii). Named so a
 *  caller (or a test) can distinguish it from a network/HTTP-status
 *  refusal without string-matching the message. */
export class GgufDigestMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`downloaded GGUF digest mismatch (expected sha256:${expected}, got sha256:${actual}) — refusing to ingest`);
    this.name = 'GgufDigestMismatchError';
  }
}

/** Finding 3 (T14 review, defense-in-depth): the digest is only checked
 *  AFTER the full stream drains, so a hostile responder (compromised HF
 *  account / swapped artifact — exactly the threat the pin defends
 *  against) could otherwise stream unbounded bytes to disk before the
 *  mismatch is ever caught. Thrown by {@link downloadToTemp} once
 *  `completedBytes` exceeds {@link sizeCeilingBytes}'s margin over the
 *  code-pinned `approxBytes` — deliberately NEVER derived from a
 *  response's `Content-Length` header, which the same hostile responder
 *  also controls. */
export class GgufSizeExceededError extends Error {
  constructor(limitBytes: number, completedBytes: number) {
    super(
      `downloaded GGUF exceeded the size ceiling (${completedBytes} bytes > ${limitBytes} byte limit) — refusing to ingest`,
    );
    this.name = 'GgufSizeExceededError';
  }
}

/** The hard download-size ceiling, computed from the code-pinned
 *  `approxBytes` — NEVER from a response header. A 10% margin absorbs
 *  legitimate rounding between the registry's pinned estimate and the
 *  artifact's actual byte count without meaningfully weakening the cap. */
function sizeCeilingBytes(approxBytes: number): number {
  return Math.ceil(approxBytes * 1.1);
}

export async function ingestGguf(
  io: GgufIngestIo,
  spec: GgufIngestSpec,
  endpoint: string,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const handle = await io.createTempWrite();
  try {
    const digest = await downloadToTemp(io, handle, spec, onProgress, signal);
    if (digest !== spec.gguf.sha256) {
      throw new GgufDigestMismatchError(spec.gguf.sha256, digest);
    }
    await putBlob(io, handle, spec, endpoint, signal);
    await createModel(io, spec, endpoint, signal);
  } finally {
    // Every exit path — success, any refusal above, or an abort — removes
    // the transient temp file exactly once.
    await io.removeTemp(handle.path);
  }
}

// --- pipeline steps ----------------------------------------------------------

/** Step 1 (§4.4.3d.i): stream-download, hashing + forwarding progress
 *  incrementally. Returns the lower-hex SHA-256 of the received bytes —
 *  the caller compares it against the pin (step 2, §4.4.3d.ii). */
async function downloadToTemp(
  io: GgufIngestIo,
  handle: TempWriteHandle,
  spec: GgufIngestSpec,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  try {
    const url = `https://huggingface.co/${spec.gguf.hfRepo}/resolve/main/${spec.gguf.file}`;
    const response = await io.fetchImpl(url, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`GGUF download failed: ${response.status} ${response.statusText}`);
    }

    const totalBytes = parseContentLength(response) ?? spec.gguf.approxBytes;
    // Finding 3: the ceiling is derived from the code-pinned `approxBytes`
    // ONLY — never from `totalBytes` above, which may itself have been
    // taken from an untrusted `Content-Length` header.
    const limitBytes = sizeCeilingBytes(spec.gguf.approxBytes);
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let completedBytes = 0;
    try {
      for (;;) {
        const { value, done } = await readWithAbort(reader, signal);
        if (done) break;
        completedBytes += value.byteLength;
        if (completedBytes > limitBytes) {
          throw new GgufSizeExceededError(limitBytes, completedBytes);
        }
        hash.update(value);
        await handle.write(value);
        onProgress({ status: 'downloading', totalBytes, completedBytes });
      }
    } finally {
      // F7 discipline (`ollamaClient.ts pullModel`'s own convention): cancel()
      // on every exit path, not just releaseLock(), so the underlying
      // connection is torn down rather than merely orphaned.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return hash.digest('hex');
  } finally {
    // Finding 1 (IMPORTANT, T14 review): release the write handle's fd on
    // EVERY exit from this function — normal completion, the HTTP-error
    // throw above (before the inner try), a size-ceiling refusal, or an
    // abort mid-loop. Pre-fix, `handle.close()` sat only after the try/
    // finally above and was skipped whenever this function threw, leaking
    // the temp file's fd (and, on POSIX, its disk blocks) past the
    // `removeTemp` unlink in `ingestGguf`'s own `finally` until the
    // extension host next exited. `.catch` makes this swallow a close
    // failure rather than mask whatever error is already propagating.
    await handle.close().catch(() => {});
  }
}

/** Step 3 (§4.4.3d.iii): `POST {endpoint}/api/blobs/sha256:{pin}` with the
 *  temp file re-opened as the request body. `duplex: 'half'` is required by
 *  the WHATWG fetch spec (and undici, concretely) whenever the body is a
 *  stream/async-iterable rather than a buffered value. */
async function putBlob(
  io: GgufIngestIo,
  handle: TempWriteHandle,
  spec: GgufIngestSpec,
  endpoint: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const body = await io.openTempRead(handle.path);
  try {
    const url = joinUrl(endpoint, `api/blobs/sha256:${spec.gguf.sha256}`);
    const response = await io.fetchImpl(url, { method: 'POST', body, duplex: 'half', signal });
    if (!response.ok) {
      throw new Error(`Ollama blob upload failed: ${response.status} ${response.statusText}`);
    }
  } finally {
    // Finding 2 (MINOR, T14 review): release the read stream's fd on EVERY
    // exit from this step — success, a non-2xx response, or an abort mid-
    // POST — not just implicitly whenever `fetchImpl` happens to fully
    // drain it. `destroy()` on an already-exhausted stream is a documented
    // no-op (Node `Readable`), so calling it unconditionally here is safe.
    body.destroy?.();
  }
}

/** Step 4 (§4.4.3d.iv): `POST {endpoint}/api/create` naming the just-verified
 *  blob by digest — Ollama resolves it from the blob store step 3 primed,
 *  never re-reading the (already-deleted-by-then-in-spirit, but still
 *  present-until-`finally`) temp file. */
async function createModel(io: GgufIngestIo, spec: GgufIngestSpec, endpoint: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const url = joinUrl(endpoint, 'api/create');
  const response = await io.fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: spec.ollamaCreatedName,
      files: { [spec.gguf.file]: `sha256:${spec.gguf.sha256}` },
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Ollama model create failed: ${response.status} ${response.statusText}`);
  }
}

// --- internals ---------------------------------------------------------------

/** `undefined` when the header is absent, non-numeric, or negative — the
 *  caller falls back to `spec.gguf.approxBytes` in every such case. */
function parseContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** `ReadableStreamReadResult<Uint8Array>` isn't a global type name under
 *  this repo's `lib: ["ES2022"]` tsconfig (no DOM lib) — derived
 *  structurally from `ReadableStreamDefaultReader.read`'s own return type
 *  instead, identical to `ollamaClient.ts`'s own local alias. */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/** Races a single `reader.read()` against `signal`'s `abort` event —
 *  identical in shape and purpose to `ollamaClient.ts`'s own
 *  `readWithAbort` (duplicated locally per that module's established
 *  self-contained-module discipline, not imported: these are unexported
 *  internals one module over). */
function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<StreamReadResult> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/** Matches this codebase's established abort-rejection shape
 *  (`ollamaClient.ts`, `pipxInstaller.ts`, `rag/embedder.ts`). */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Joins a base URL to a relative path without losing an existing subpath
 *  on the base and without doubling slashes — a local copy of
 *  `ollamaClient.ts`'s identical `joinUrl` (that module's own doc comment
 *  explains why it isn't imported: "registry.ts's own zero-cross-feature-
 *  import discipline one directory over"). A relative path whose FIRST
 *  segment (`api`) contains no colon is never mistaken for a URL scheme by
 *  `URL`'s resolution, so `api/blobs/sha256:<hex>` resolves as a path with a
 *  literal `sha256:` segment, not as a `sha256:` scheme. */
function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}
