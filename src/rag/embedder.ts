/**
 * `POST {endpoint}/v1/embeddings` client — the OpenAI-shaped batch endpoint
 * shared by Ollama, llama.cpp (started with `--embeddings`, non-`none`
 * pooling), and vLLM (runner-apis-howto §5: "A single OpenAI-style
 * /v1/embeddings code path covers all three"). Request/response mapping is
 * split into pure functions so it's testable without a network call; the
 * `HttpEmbedder` class is the thin fetch-touching wrapper.
 */

export interface EmbeddingsRequestBody {
  model: string;
  input: string[];
  dimensions?: number;
}

export interface EmbeddingsResponseDatum {
  index: number;
  embedding: number[];
}

export interface EmbeddingsResponse {
  data: EmbeddingsResponseDatum[];
}

/**
 * Builds the request body. Audit D-1: `dimensions` (the OpenAI-shaped
 * Matryoshka truncation width) is omitted entirely — not sent as
 * `undefined`, and not sent as `0` — unless the caller explicitly configured
 * a positive value. See the inline comment below for why a blind default is
 * dangerous.
 */
export function buildEmbeddingsRequestBody(
  model: string,
  input: string[],
  dimensions?: number,
): EmbeddingsRequestBody {
  const body: EmbeddingsRequestBody = { model, input };
  // Audit D-1: `dimensions` is honoured by exactly ONE of the three runners we
  // support. llama.cpp has zero occurrences of `dimensions` under
  // `tools/server/`; Ollama truncates only when `0 < dims < len`
  // (`server/routes.go:981-982`); vLLM raises ValueError for a non-Matryoshka
  // model (`vllm/pooling_params.py:166-173`) — an HTTP 400 that kills the
  // whole index build. So we send it only when the user explicitly asked for
  // it (`hermes.rag.dims` > 0), and never as a silent default.
  if (dimensions !== undefined && dimensions > 0) {
    body.dimensions = dimensions;
  }
  return body;
}

/**
 * Parses the OpenAI-shaped `/v1/embeddings` response
 * (`{ data: [{ index, embedding }] }`) back into an array of vectors
 * **aligned to the original input order** — `data`'s wire order is not
 * contractually guaranteed to match input order, so this sorts by `index`.
 * Throws if the returned vector count doesn't match the batch size sent.
 */
export function parseEmbeddingsResponse(
  response: EmbeddingsResponse,
  expectedCount: number,
): number[][] {
  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  if (sorted.length !== expectedCount) {
    throw new Error(
      `/v1/embeddings response returned ${sorted.length} vectors, expected ${expectedCount}`,
    );
  }
  return sorted.map((d) => d.embedding);
}

/**
 * V-16 RAG-2: per-batch `/v1/embeddings` request deadline. Every sibling
 * subsystem already has one (resolveHermes 10 s, JsonRpcStdio 120 s, FIM
 * readers byte-capped) — without this, a stalled embeddings server hangs
 * `embedBatch` forever, and since `indexer.ts` funnels every file through
 * one serialized build chain, that one stalled request freezes ALL
 * incremental indexing behind it.
 */
export const EMBED_TIMEOUT_MS = 60_000;

export interface Embedder {
  /**
   * Embeds a batch of texts, returning one vector per input, in input order.
   *
   * `expectedWidth` (Task 14b) is the vector width this call must enforce —
   * a mismatch is refused (thrown), never stored. It is a per-call parameter
   * rather than constructor state because the effective expected width is
   * BUILD-TIME state (it depends on the D-2 fingerprint sidecar, which
   * changes between builds), not something fixed when the embedder is
   * constructed. This is the single width-check site; callers must not
   * duplicate it.
   */
  embed(texts: string[], expectedWidth?: number): Promise<number[][]>;
}

export interface HttpEmbedderOptions {
  /** Base URL of the runner, e.g. `http://127.0.0.1:11434` — `/v1/embeddings` is appended. */
  endpoint: string;
  model: string;
  /**
   * OPTIONAL Matryoshka truncation width, forwarded as the OpenAI
   * `dimensions` field. Audit D-1: this is NOT "the schema" and is NOT
   * universally supported — omitted from the body unless > 0. See
   * `buildEmbeddingsRequestBody`.
   */
  dimensions?: number;
  /** Max texts per HTTP request (how-to §2.4: batch ~64-200). */
  batchSize?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class HttpEmbedder implements Embedder {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly dimensions: number | undefined;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpEmbedderOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.batchSize = opts.batchSize ?? 64;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], expectedWidth?: number): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      vectors.push(...(await this.embedBatch(batch, expectedWidth)));
    }
    return vectors;
  }

  private async embedBatch(batch: string[], expectedWidth: number | undefined): Promise<number[][]> {
    const body = buildEmbeddingsRequestBody(this.model, batch, this.dimensions);
    // V-16 RAG-2: AbortController + a manually-managed timer, NOT
    // `AbortSignal.timeout()` — deliberately, so this deadline is
    // exercisable with `vi.useFakeTimers()` in tests (Node's
    // `AbortSignal.timeout` is implemented below the JS-visible `setTimeout`
    // vitest's fake timers patch, so it would not fire under fake timers).
    // unref'd so a pending embed request never keeps the process alive.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, EMBED_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    let json: EmbeddingsResponse;
    try {
      const res = await this.fetchImpl(`${this.endpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Global Constraint: error messages carry status + statusText ONLY —
        // never a response body, never a key. Audit C-5: this used to
        // interpolate `await res.text()`, and that text travels to the user's
        // log AND to the model (SDK `mcp.js:141` -> Hermes
        // `mcp_tool.py:3947-3956` -> `{"error": …}` in the model's context).
        throw new Error(`/v1/embeddings request failed: ${res.status} ${res.statusText}`);
      }
      // V-16 RAG-2 (review M-1): the deadline stays armed THROUGH the body
      // read — a server that returns 200 + headers then stalls the response
      // body would otherwise re-open the exact "one stalled request freezes
      // all incremental indexing" freeze this task targets. `res.json()` is
      // inside the timed try so the abort signal covers it too.
      json = (await res.json()) as EmbeddingsResponse;
    } catch (err) {
      // V-16 RAG-2 (review M-2): a deadline abort surfaces a self-explanatory,
      // body-free message (the indexer log then names the embeddings deadline)
      // instead of the bare "The operation was aborted." AbortError. Any other
      // failure (network, non-2xx) rethrows unchanged.
      if (timedOut) {
        throw new Error(`/v1/embeddings request timed out after ${EMBED_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const vectors = parseEmbeddingsResponse(json, batch.length);
    // Audit D-1 / Task 14b: the LanceDB schema has a FIXED vector width.
    // Verified empirically against the installed @lancedb/lancedb: a
    // wrong-width upsert via `mergeInsert(...).execute()` does NOT error —
    // it silently truncates (wider->narrower) or null-pads (narrower->wider).
    // Refuse loudly instead, before this reaches `store.upsert` — the name of
    // the setting is in the message so the user can act on it, and no
    // response body is included. `expectedWidth` is the caller's per-build
    // decision (see indexer.ts's `computeEffectiveWidth`), not fixed at
    // construction, because it depends on the D-2 fingerprint sidecar, which
    // changes between builds. Task 14 fix-wave, Minor: check every vector in
    // the batch, not just the first — a batch whose first vector happens to
    // be correct-width but a later one isn't must still be refused
    // wholesale, not partially stored.
    if (expectedWidth !== undefined) {
      const mismatched = vectors.find((v) => v.length !== expectedWidth);
      if (mismatched !== undefined) {
        throw new Error(
          `embedding width mismatch: server returned ${mismatched.length}, index schema expects ${expectedWidth}. Set hermes.rag.dims to match your model, or delete the index directory and rebuild.`,
        );
      }
    }
    return vectors;
  }
}
