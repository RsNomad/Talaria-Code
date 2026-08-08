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
 *
 * --- beta.6 T3 split (beta6-unified-local-model-onboarding-architecture.md
 * §2.4 / §2.2.8 / §7 line 509) ------------------------------------------------
 * The digest-verified download loop above ({@link downloadToTemp}) is now
 * shared by a SECOND sink, {@link downloadGgufToStore}: the atomic, same-
 * filesystem file placer for the llama.cpp store path (`modelStore.ts`, T4
 * is the reader of what this writes). Its pipeline, EXACT order:
 *  1. digest-shape assert on `spec.gguf.sha256` (SC-A-8 defense-in-depth —
 *     `hfDigest.ts`'s `resolveLfsOid`/`verifyHfDigest` already shape-assert
 *     upstream; this is a second, independent gate at the placement layer)
 *     — BEFORE any fs/network touch.
 *  2. `io.ensureDir(destDir)` then `io.createStoreTempWrite(destDir)` — the
 *     `.part` temp file is opened INSIDE `destDir` (never `os.tmpdir()`,
 *     {@link GgufIngestIo.createTempWrite}'s own binding — SC-4: a cross-
 *     filesystem tmpfs→destDir rename would EXDEV on Fedora for a multi-
 *     gigabyte GGUF). `dirname(handle.path) === destDir` is asserted
 *     immediately — a contract violation refuses before any network call.
 *  3. `downloadToTemp` (shared, unchanged) — digest mismatch / HTTP error /
 *     abort / size-ceiling all refuse via one shared `catch` that removes
 *     the `.part` and rethrows; `renameTemp` is never reached on any of
 *     these paths.
 *  4. `io.renameTemp(tempPath, destPath)` — reached ONLY after the digest
 *     compare passed (spy-order tested, §7 line 509). ANY rejection (EXDEV
 *     or otherwise) refuses + removes the `.part` — there is no copy-
 *     fallback method on {@link GgufStoreIo} for this engine to even reach
 *     for; a copy would leave a partial file at the final name.
 *  5. `io.writeSidecar` — reached ONLY after a successful rename; writes
 *     `<destPath>.talaria.json` = {@link GgufStoreSidecar} (`catalogId`,
 *     `sha256`, `bytes` = the actually-downloaded byte count, `verifiedAt`).
 *     Never written on any failure path — a `.part` never gets a sidecar.
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

/**
 * The T3 file-sink seam — `setupHost.vscode.ts` binds these on the SAME
 * object it already returns for {@link GgufIngestIo} (structurally, one
 * bound object satisfies both interfaces — "io gains" these members, per
 * the architecture doc's own phrasing, §2.4). `fetchImpl` is shared with
 * {@link GgufIngestIo}; unit tests inject an independent in-memory fake.
 */
export interface GgufStoreIo {
  fetchImpl: typeof fetch;
  /** `fs.mkdir(dir, {recursive:true})` — called before `createStoreTempWrite`
   *  so the `.part` file always has somewhere to land. */
  ensureDir(dir: string): Promise<void>;
  /** Opens `<destDir>/<random>.part` — INSIDE `destDir`, never `os.tmpdir()`
   *  ({@link GgufIngestIo.createTempWrite}'s own binding) — SC-4. */
  createStoreTempWrite(destDir: string): Promise<TempWriteHandle>;
  /** Same contract as {@link GgufIngestIo.removeTemp} (never rejects on the
   *  real binding — ENOENT swallowed); shared by both interfaces. */
  removeTemp(path: string): Promise<void>;
  /** `fs.rename(tempPath, destPath)` — same-directory, therefore atomic on
   *  POSIX. Rejects (EXDEV or otherwise) exactly as `fs.rename` does; this
   *  engine never catches a rejection here to retry with a copy. */
  renameTemp(tempPath: string, destPath: string): Promise<void>;
  /** Writes the post-rename attestation file verbatim (the engine already
   *  serialized `content` to JSON) — `fs.writeFile(sidecarPath, content)`. */
  writeSidecar(sidecarPath: string, content: string): Promise<void>;
}

/**
 * The store-sink counterpart of `SetupController.ts`'s {@link
 * GgufIngestSpec} — same registry-pinned-artifact trust discipline (never
 * webview-derived), but shaped for the file-placement path: no
 * `ollamaCreatedName` (nothing is created in Ollama on this path); it
 * carries `catalogId` (`modelCatalog.ts` `CatalogModel.id`) instead, which
 * `GgufIngestSpec` has no use for — {@link downloadGgufToStore} writes it
 * into the post-rename sidecar verbatim.
 */
export interface GgufStoreSpec {
  catalogId: string;
  gguf: {
    hfRepo: string;
    file: string;
    quant: string;
    sha256: string;
    approxBytes: number;
    /** Optional — this engine (the placement sink) never reads it. Exact-
     *  file-set enforcement, when it applies, happens UPSTREAM of this sink:
     *  `verifyHfDigest` (`hfDigest.ts`), called by the controller in pinned
     *  mode BEFORE `downloadGgufToStore` ever runs — NOT here. This field
     *  exists only for shape parity with `GgufIngestSpec.gguf.allowedRepoFiles`
     *  (also optional, T3) so a `GgufStoreSpec` literal can carry it; a
     *  caller must not read its presence on THIS type as "the sink enforces
     *  the exact file set." */
    allowedRepoFiles?: readonly string[];
  };
}

/**
 * `<destPath>.talaria.json`'s exact shape (§2.2.8) — written ONLY after a
 * successful rename. `modelStore.ts`'s presence scan (T4) is the reader:
 * presence = sidecar exists ∧ well-formed ∧ `fs.stat(destPath).size ===
 * sidecar.bytes`. T4 should IMPORT this type rather than redeclare it, so
 * the writer and reader can never drift apart.
 */
export interface GgufStoreSidecar {
  catalogId: string;
  sha256: string;
  bytes: number;
  verifiedAt: string;
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

/** SC-A-8 defense-in-depth (T3): the expected digest handed to {@link
 *  downloadGgufToStore} doesn't match the required 64-lowercase-hex-char
 *  SHA-256 shape — refuses before any fs/network touch. Named so a caller
 *  (or a test) can distinguish it from a byte-mismatch refusal. */
export class GgufDigestShapeError extends Error {
  constructor(value: string) {
    super(`expected digest "${value}" does not match the required sha256 shape (64 lowercase hex chars) — refusing`);
    this.name = 'GgufDigestShapeError';
  }
}

/** SC-4 (T3): {@link GgufStoreIo.createStoreTempWrite} returned a temp file
 *  outside the destination directory it was asked to write into — a
 *  contract violation in the io binding itself (never expected from the
 *  real fs binding; guards a future or test-double regression). */
export class GgufStorePlacementError extends Error {
  constructor(tempDir: string, destDir: string) {
    super(`temp file directory "${tempDir}" does not match the destination directory "${destDir}" — refusing to place`);
    this.name = 'GgufStorePlacementError';
  }
}

/** §2.2.8 (T3): EXDEV or ANY OTHER `renameTemp` failure — refuses and
 *  removes the `.part`. There is deliberately no copy-fallback path: a copy
 *  would place a partial (unrenamed-but-present) file at the final name,
 *  exactly what the atomic same-directory rename exists to prevent. The
 *  original rejection is preserved as `.cause` for diagnostics. */
export class GgufStoreRenameError extends Error {
  constructor(destPath: string, cause: unknown) {
    super(`failed to place the downloaded GGUF at "${destPath}" — refusing (no copy fallback)`, { cause });
    this.name = 'GgufStoreRenameError';
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
  // final-fixwave Fix 1: normalize the registry pin to lowercase at point of
  // use — `hash.digest('hex')` (below) is already lowercase, so the only
  // case-mismatch risk is a manually-pasted, mis-cased `spec.gguf.sha256`.
  // `'' → ''` is unchanged (empty-pin fail-closed behavior is untouched).
  const pin = spec.gguf.sha256.toLowerCase();
  const handle = await io.createTempWrite();
  try {
    const { digest } = await downloadToTemp(io, handle, spec, onProgress, signal);
    if (digest !== pin) {
      throw new GgufDigestMismatchError(pin, digest);
    }
    await putBlob(io, handle, spec, endpoint, signal);
    await createModel(io, spec, endpoint, signal);
  } finally {
    // Every exit path — success, any refusal above, or an abort — removes
    // the transient temp file exactly once.
    await io.removeTemp(handle.path);
  }
}

/**
 * The T3 file-sink counterpart of {@link ingestGguf} (see this module's own
 * top doc comment, "beta.6 T3 split", for the full 5-step pipeline). Places
 * a digest-verified GGUF at `<destDir>/<destFile>` atomically (same-
 * filesystem temp + rename) and writes its post-rename sidecar attestation.
 *
 * `spec.catalogId` is ALWAYS `modelCatalog.ts`'s `CatalogModel.id` for the
 * row being downloaded — never anything webview-derived (same trust
 * discipline `GgufIngestSpec` documents one type up).
 *
 * Rejects on any failure (digest-shape assert, digest mismatch, HTTP error,
 * abort, size ceiling, or a rename failure of ANY kind, EXDEV included) —
 * every failure removes the `.part` first, and NEVER writes a sidecar. An
 * `AbortError` rejection = user cancel, matching `ingestGguf`'s own
 * convention.
 */
export async function downloadGgufToStore(
  io: GgufStoreIo,
  spec: GgufStoreSpec,
  destDir: string,
  destFile: string,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  // SC-A-8: shape-assert BEFORE any fs/network touch — a malformed expected
  // digest never reaches ensureDir/createStoreTempWrite/fetchImpl.
  assertDigestShape(spec.gguf.sha256);
  const pin = spec.gguf.sha256.toLowerCase();
  const normalizedDestDir = normalizeDir(destDir);
  const destPath = joinStorePath(normalizedDestDir, destFile);

  await io.ensureDir(destDir);
  const handle = await io.createStoreTempWrite(destDir);
  // SC-4: the temp file MUST live in the exact same directory as the final
  // destination — a contract violation (a buggy io binding returning a path
  // elsewhere) refuses before any network call, and still cleans up
  // whatever `createStoreTempWrite` already created on disk. CR-1 (defense-
  // in-depth): close the handle's fd on THIS exit path too — matching the
  // close-on-every-exit-path discipline `downloadToTemp` already applies —
  // so a leaked fd (and, on POSIX, the disk blocks behind it) never
  // outlives this refusal.
  if (dirnameOf(handle.path) !== normalizedDestDir) {
    await handle.close().catch(() => {});
    await io.removeTemp(handle.path);
    throw new GgufStorePlacementError(dirnameOf(handle.path), normalizedDestDir);
  }
  // CR-2 (defense-in-depth): symmetrically assert the COMPOSED FINAL
  // destination path also resolves inside `normalizedDestDir` — a
  // traversing `destFile` (e.g. '../x') would otherwise rename the
  // verified file to a sibling OUTSIDE the intended <owner>/<repo> folder,
  // even though the temp file itself landed in the right place. Same
  // failure shape as the guard above: close the handle, remove the `.part`,
  // refuse — all still strictly before any network work.
  if (dirnameOf(destPath) !== normalizedDestDir) {
    await handle.close().catch(() => {});
    await io.removeTemp(handle.path);
    throw new GgufStorePlacementError(dirnameOf(destPath), normalizedDestDir);
  }

  let digest: string;
  let bytes: number;
  try {
    const result = await downloadToTemp(io, handle, spec, onProgress, signal);
    if (result.digest !== pin) {
      throw new GgufDigestMismatchError(pin, result.digest);
    }
    digest = result.digest;
    bytes = result.completedBytes;
  } catch (err) {
    // Every download-phase failure — mismatch, HTTP error, abort, size
    // ceiling — removes the `.part` before propagating. `renameTemp` is
    // never reached on any of these paths (proven by the RED suite).
    await io.removeTemp(handle.path);
    throw err;
  }

  try {
    await io.renameTemp(handle.path, destPath);
  } catch (err) {
    // EXDEV or ANY OTHER rename failure ⇒ refuse + cleanup, NEVER a copy
    // fallback (a copy would leave a partial file at the final name) — this
    // engine has no copy method to even reach for.
    await io.removeTemp(handle.path);
    throw new GgufStoreRenameError(destPath, err);
  }

  // Reached ONLY after a successful rename — a `.part` never gets a sidecar.
  const sidecar: GgufStoreSidecar = {
    catalogId: spec.catalogId,
    sha256: digest,
    bytes,
    verifiedAt: new Date().toISOString(),
  };
  await io.writeSidecar(`${destPath}.talaria.json`, JSON.stringify(sidecar));
}

// --- pipeline steps ----------------------------------------------------------

/** The minimal shape {@link downloadToTemp} needs from either sink's spec —
 *  structurally satisfied by both `GgufIngestSpec.gguf` (imported) and
 *  {@link GgufStoreSpec.gguf} (this module) without either caller adapting
 *  its own spec shape (T3 split — this is the "shared core" §2.4 names). */
interface GgufDownloadSource {
  gguf: { hfRepo: string; file: string; approxBytes: number };
}

/** Step 1 (§4.4.3d.i): stream-download, hashing + forwarding progress
 *  incrementally. Returns the lower-hex SHA-256 of the received bytes (the
 *  caller compares it against the pin — `ingestGguf`'s step 2, §4.4.3d.ii;
 *  `downloadGgufToStore`'s own compare) AND the total byte count actually
 *  written (T3: `downloadGgufToStore`'s sidecar needs the real downloaded
 *  size, not the code-pinned `approxBytes` estimate). `io` is typed to the
 *  minimal `fetchImpl`-only shape both {@link GgufIngestIo} and {@link
 *  GgufStoreIo} satisfy — this function never touches either interface's
 *  sink-specific members. */
async function downloadToTemp(
  io: { fetchImpl: typeof fetch },
  handle: TempWriteHandle,
  spec: GgufDownloadSource,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<{ digest: string; completedBytes: number }> {
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
    return { digest: hash.digest('hex'), completedBytes };
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
  const pin = spec.gguf.sha256.toLowerCase(); // final-fixwave Fix 1 — see ingestGguf's own comment.
  const body = await io.openTempRead(handle.path);
  try {
    const url = joinUrl(endpoint, `api/blobs/sha256:${pin}`);
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
  const pin = spec.gguf.sha256.toLowerCase(); // final-fixwave Fix 1 — see ingestGguf's own comment.
  const url = joinUrl(endpoint, 'api/create');
  const response = await io.fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: spec.ollamaCreatedName,
      files: { [spec.gguf.file]: `sha256:${pin}` },
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

// --- T3 store-sink internals --------------------------------------------------

/** Fedora/Linux target — POSIX forward-slash paths only; deliberately no
 *  `node:path` import (this module's own no-ambient-fs/os discipline: every
 *  path here is a plain string the caller handed in, never resolved against
 *  the real filesystem). Returns `'.'` for a bare filename with no
 *  separator, mirroring `path.dirname`'s own convention. */
function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '.' : path.slice(0, idx);
}

/** Strips exactly one trailing '/' (never reduces a bare `'/'` to `''`) so
 *  a caller-supplied `destDir` with or without a trailing slash compares
 *  equal to {@link dirnameOf}'s always-trailing-slash-free output. */
function normalizeDir(dir: string): string {
  return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
}

function joinStorePath(dir: string, file: string): string {
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`;
}

/** HF's own `lfs.oid` shape, re-asserted at the placement layer (SC-A-8,
 *  defense-in-depth): lowercase-normalized SHA-256 hex, always 64 chars.
 *  `hfDigest.ts`'s `resolveLfsOid`/`verifyHfDigest` already assert this
 *  upstream — this is a SECOND, independent gate, so a future caller that
 *  bypasses those (or a resolver bug) still can't hand this engine a
 *  malformed "verified" digest to trust. */
function assertDigestShape(sha256: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha256.toLowerCase())) {
    throw new GgufDigestShapeError(sha256);
  }
}
