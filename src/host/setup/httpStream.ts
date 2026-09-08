/**
 * httpStream — shared HTTP-stream primitives (FI-11, WS-F8 F8-2).
 *
 * Moved VERBATIM out of `ollamaClient.ts` (the only behaviour change is
 * {@link readBodyBounded} gaining a `label` parameter — see its own doc
 * comment): `joinUrl`, `readWithAbort` + `StreamReadResult`, `readBodyBounded`,
 * `abortError`. `ollamaClient.ts` and `remoteProbe.ts` both import from here
 * now instead of each carrying their own copy.
 *
 * The frozen `ggufIngest.ts` keeps its OWN, textually-identical copies of
 * `StreamReadResult`/`readWithAbort`/`abortError`/`joinUrl` (ADR-FSU-02's
 * frozen-zone discipline — that file is not touched by this task) —
 * `httpStream.parity.lock.test.ts` enforces that those two sets of four stay
 * in source-parity, so a future edit to this module cannot silently drift
 * from the frozen twin without failing that lock. `hfDigest.ts`'s
 * `readTreeBodyBounded` is a DELIBERATE divergence (different reason
 * strings, no `label` param) and is out of scope for both this module and
 * that lock — see the lock file's own header.
 */

/** `ReadableStreamReadResult<Uint8Array>` isn't a global type name under
 *  this repo's `lib: ["ES2022"]` tsconfig (no DOM lib) — derived structurally
 *  from `ReadableStreamDefaultReader.read`'s own return type instead, since
 *  that interface (unlike the free-standing result-type alias) IS resolved
 *  globally via `@types/node`'s `stream/web` augmentation. */
export type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/**
 * Races a single `reader.read()` against `signal`'s `abort` event. Needed
 * because a caller-injected `fetchImpl` in unit tests is often a stub that
 * never itself observes `signal` the way a real `fetch` implementation does
 * — an abort fired while a `read()` is already in flight (e.g. waiting on
 * the next network chunk) must still interrupt it immediately rather than
 * wait for that read to settle on its own (which, for a stalled/hostile
 * server, might never happen).
 */
export function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<StreamReadResult> {
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

export type BoundedBodyResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Reads a fetch `Response` body through `getReader()` with a byte ceiling —
 * cancels the reader on every exit path (F7 discipline: success, an
 * over-cap bail, or a missing body). `label` names the caller's own resource
 * in the two failure reasons (`"${label} had no readable body"` /
 * `"${label} exceeded ${maxBytes} bytes without completing"`) so each
 * caller's pre-extraction wording survives byte-for-byte — `ollamaClient.ts`
 * passes `'response'`, reproducing its own original
 * `'response exceeded ${maxBytes} bytes without completing'` /
 * `'response had no readable body'` text exactly.
 */
export async function readBodyBounded(response: Response, maxBytes: number, label: string): Promise<BoundedBodyResult> {
  if (!response.body) {
    return { ok: false, reason: `${label} had no readable body` };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        return { ok: false, reason: `${label} exceeded ${maxBytes} bytes without completing` };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Matches this codebase's established abort-rejection shape
 *  (`pipxInstaller.ts`, `rag/embedder.ts`, `autocomplete/nextedit/*.test.ts`). */
export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Joins a base URL to a relative path without losing an existing subpath
 *  on the base and without doubling slashes — a relative path whose FIRST
 *  segment contains no colon is never mistaken for a URL scheme by `URL`'s
 *  resolution. */
export function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}
