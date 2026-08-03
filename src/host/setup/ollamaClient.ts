/**
 * Ollama client — daemon detection + streaming model pull
 * (onboarding-backend-setup-architecture.md §2.4, Task 6 of the
 * onboarding/backend-setup plan).
 *
 * PURE LOGIC — no `vscode` import. Every network call is routed through the
 * caller-injected `fetchImpl` (typed `typeof fetch`), so unit tests never
 * touch a real socket — same discipline `pipxInstaller.ts`/`pipxLocator.ts`
 * apply to subprocess I/O one module over (`ollamaClient.test.ts`).
 *
 * Shapes grounded via Context7 `/ollama/ollama` (docs/api.md, api/types.go,
 * docs/api/errors.mdx), re-verified 2026-08-04:
 *   - `GET {endpoint}/api/tags` → `200 {"models":[{name, model,
 *     modified_at, size, digest, details, capabilities}]}`
 *     (`ListResponse`/`ListModelResponse` in api/types.go). Connection
 *     refused, a timeout, or a non-200 status all mean "not running" —
 *     none of these are treated specially; only the `detail` text differs.
 *   - `POST {endpoint}/api/pull` body `{"model":<model>}` streams
 *     `application/x-ndjson` by default: `{"status":"pulling manifest"}` →
 *     `{"status":"pulling <digest>","digest":…,"total":N,"completed":M}`
 *     (repeated per layer) → `{"status":"verifying sha256 digest"}` /
 *     `{"status":"writing manifest"}` → `{"status":"success"}`. An
 *     `{"error":"…"}` chunk can appear mid-stream on an otherwise-200
 *     response (docs/api/errors.mdx: "the response status code will not
 *     change") — that text is Ollama's own runner-generated message (not
 *     the Codestral/vLLM/etc. untrusted-remote threat model the FIM
 *     backends' body-free `BackendStreamError` convention exists for), so
 *     it is surfaced verbatim, matching the brief's literal
 *     `reject(new Error(e))` contract.
 */

export interface OllamaModel {
  name: string;
  sizeBytes: number;
}

export type OllamaStatus = { running: true; models: OllamaModel[] } | { running: false; detail: string };

export interface PullProgress {
  status: string;
  totalBytes?: number;
  completedBytes?: number;
}

/** §2.4: local daemon default — but the endpoint itself is always caller-
 *  supplied; this constant only sizes the probe's abort timer. */
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

interface TagsResponseModel {
  name: string;
  size: number;
}

interface TagsResponseBody {
  models?: TagsResponseModel[];
}

/**
 * `GET {endpoint}/api/tags`. Resolves — never rejects — with a discriminated
 * `OllamaStatus`: `{running:true, models}` on a 200 whose `models[]` maps to
 * `{name, sizeBytes: model.size}`; `{running:false, detail}` for a
 * connection failure, a timeout (enforced by an internally-owned
 * `AbortController`, default {@link DEFAULT_PROBE_TIMEOUT_MS}), or any
 * non-200 status.
 */
export async function probeOllama(
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<OllamaStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(joinUrl(endpoint, 'api/tags'), { signal: controller.signal });
    if (!response.ok) {
      return {
        running: false,
        detail: `Ollama /api/tags responded ${response.status} ${response.statusText}`,
      };
    }
    const body = (await response.json()) as TagsResponseBody;
    const models: OllamaModel[] = (body.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size }));
    return { running: true, models };
  } catch (err) {
    return { running: false, detail: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

interface PullResponseChunk {
  status?: string;
  error?: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/**
 * `POST {endpoint}/api/pull` with body `{"model":model}`. Streams NDJSON
 * lines (buffered across chunk boundaries — a JSON line split mid-write by
 * the transport is held until its newline arrives), forwarding each parsed
 * line to `onProgress`. Rejects on a non-2xx response, on a mid-stream
 * `{"error":e}` chunk (`new Error(e)`), or when `signal` aborts (an
 * `AbortError` `DOMException`, interrupting even an in-flight read).
 * Resolves as soon as a `{"status":"success"}` chunk is observed.
 */
export async function pullModel(
  endpoint: string,
  model: string,
  fetchImpl: typeof fetch,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const response = await fetchImpl(joinUrl(endpoint, 'api/pull'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/pull failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`Ollama /api/pull failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await readWithAbort(reader, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        if (handlePullChunkLine(line, onProgress)) return;
      }
    }
    const trailing = buffer.trim();
    if (trailing) {
      handlePullChunkLine(trailing, onProgress);
    }
  } finally {
    // F7 discipline (this codebase's `readNdjsonLines`/`readSseEvents`
    // convention, http.ts): cancel() on every exit path — success,
    // mid-stream error, or abort — not just releaseLock(), so the
    // underlying connection is torn down rather than merely orphaned.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// --- internals ---------------------------------------------------------

/** Parses one NDJSON line, forwards it as a {@link PullProgress}, and
 *  returns `true` once the stream has reached its terminal
 *  `"status":"success"`. Throws the runner's own message verbatim (never
 *  redacted — see module doc) on an `{"error":…}` chunk. */
function handlePullChunkLine(line: string, onProgress: (p: PullProgress) => void): boolean {
  const chunk = JSON.parse(line) as PullResponseChunk;
  if (chunk.error) {
    throw new Error(chunk.error);
  }
  if (chunk.status) {
    onProgress({ status: chunk.status, totalBytes: chunk.total, completedBytes: chunk.completed });
    if (chunk.status === 'success') return true;
  }
  return false;
}

/**
 * Races a single `reader.read()` against `signal`'s `abort` event. Needed
 * because the caller-injected `fetchImpl` in unit tests is a stub that never
 * itself observes `signal` the way a real `fetch` implementation does — an
 * abort fired while a `read()` is already in flight (e.g. waiting on the
 * next network chunk) must still interrupt it immediately rather than wait
 * for that read to settle on its own (which, for a stalled/hostile server,
 * might never happen).
 */
/** `ReadableStreamReadResult<Uint8Array>` isn't a global type name under
 *  this repo's `lib: ["ES2022"]` tsconfig (no DOM lib) — derived structurally
 *  from `ReadableStreamDefaultReader.read`'s own return type instead, since
 *  that interface (unlike the free-standing result-type alias) IS resolved
 *  globally via `@types/node`'s `stream/web` augmentation. */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

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
 *  (`pipxInstaller.ts`, `rag/embedder.ts`, `autocomplete/nextedit/*.test.ts`). */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Joins a base URL to a relative path without losing an existing subpath
 *  on the base and without doubling slashes — same normalization
 *  `autocomplete/util.ts`'s `joinUrl` applies, kept as a local copy here so
 *  this module stays self-contained (matching `registry.ts`'s own
 *  zero-cross-feature-import discipline one directory over). */
function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}
