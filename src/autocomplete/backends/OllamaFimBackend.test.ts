import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaFimBackend } from './OllamaFimBackend';
import { BackendHttpError, BackendStreamError, StreamIdleTimeoutError, STREAM_IDLE_TIMEOUT_MS } from './http';
import { scannedSnippetForTest } from '../context/scannedSnippetTestFactory';
import type { FimContext, FimRequest } from '../types';
import type { ScannedSnippet } from '../context/types';

function fimContext(snippets: readonly ScannedSnippet[] = []): FimContext {
  return {
    filepath: 'file:///a.ts',
    languageId: 'typescript',
    prefix: 'const x = ',
    suffix: '',
    workspaceUris: [],
    snippets,
  };
}

function req(snippets: readonly ScannedSnippet[] = []): FimRequest {
  return {
    model: 'qwen2.5-coder:1.5b-base',
    prefix: 'const x = ',
    suffix: '',
    stop: [],
    temperature: 0.01,
    maxTokens: 128,
    context: fimContext(snippets),
  };
}

function snippet(overrides: Partial<Parameters<typeof scannedSnippetForTest>[0]> = {}): ScannedSnippet {
  return scannedSnippetForTest({
    uri: 'file:///other.ts',
    filepath: 'other.ts',
    content: 'export function helper() {}',
    kind: 'recently-edited',
    startLine: 0,
    endLine: 0,
    ...overrides,
  });
}

/** A `fetch` resolution whose body streams a single ndjson `done` line. */
function doneNdjsonResponse(): Response {
  const line = JSON.stringify({ response: '', done: true }) + '\n';
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(line));
        controller.close();
      },
    }),
  } as unknown as Response;
}

/**
 * W6-FD (§3.2, ratified W5 critic-pin B1) — the wire-adjacent
 * `assertAllScanned` backstop, wired into every FIM backend, not just the
 * ones that structurally read `req.context.snippets`. This is the only test
 * coverage this backend has at all; scoped narrowly to the backstop this
 * task adds.
 */
describe('OllamaFimBackend.streamFim — assertAllScanned egress backstop (B1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws fail-closed BEFORE fetch when req.context.snippets carries a forged/bypassed secret-bearing snippet', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const forged = [snippet({ content: '-----BEGIN PRIVATE KEY-----' })];

    const iterator = backend
      .streamFim(req(forged), new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/assertAllScanned/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('does not affect a clean request with only legitimately-scanned snippets', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(doneNdjsonResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const clean = [snippet({ content: 'const a = 1;' })];

    const iterator = backend
      .streamFim(req(clean), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OllamaFimBackend.streamFim — A1 typed HTTP errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a BackendHttpError with .status preserved when fetch resolves !response.ok', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendHttpError);
    expect((caught as BackendHttpError).status).toBe(401);
  });

  it('a missing response.body on an ok response is NOT a BackendHttpError (no real HTTP-status failure to report)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(BackendHttpError);
  });
});

/**
 * T6 (final-review remediation, M6 + ARCH-2) — a mid-stream `{"error": ...}`
 * ndjson chunk used to be re-thrown VERBATIM (`throw new Error(chunk.error)`),
 * so whatever the Ollama runner put in that field (a filesystem path, an
 * internal stack fragment) reached the user-facing autocomplete error.
 * Invariant #3: the thrown message is a FIXED, body-free string.
 */
/**
 * T-D1 (closes V-13, folded into T-D1's remediation of V-15). Ollama only
 * enters its FIM path when `req.Suffix != ""` (routes.go:521-523) AND the
 * template layer only renders the FIM branch when both
 * `v.Prompt != "" && v.Suffix != ""` (template.go `Execute`) — so cursor-at-
 * EOF (an empty suffix, exactly what `constructPrefixSuffix` produces at
 * end-of-document) used to silently degrade to a chat-wrapped or marker-less
 * completion instead of a real infill. A synthetic `'\n'` is the minimal
 * value that keeps the request in the INFILL branch of both files.
 */
describe('OllamaFimBackend.streamFim — V-13: synthetic suffix for EOF infill', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function captureBody(request: FimRequest): Promise<Record<string, unknown>> {
    const fetchSpy = vi.fn().mockResolvedValue(doneNdjsonResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const iterator = backend.streamFim(request, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('req.suffix === "" (cursor at EOF) posts a synthetic "\\n" suffix, not the empty string that skips Ollama\'s FIM path entirely (routes.go:521)', async () => {
    const body = await captureBody(req()); // req() above defaults to suffix: ''
    expect(body.suffix).toBe('\n');
  });

  it('a non-empty req.suffix is sent unchanged', async () => {
    const nonEmpty = req();
    nonEmpty.suffix = 'x';
    const body = await captureBody(nonEmpty);
    expect(body.suffix).toBe('x');
  });

  // Global Constraint reinforcement: `fimRequestBody.test.ts:113-114` already
  // pins "FIM never sends raw" for a NON-empty suffix. This is a second,
  // local guard scoped to exactly the EOF path this fix touches, so the V-13
  // fix can never drift toward the `raw:true` alternative the fork rejected
  // (that would require overturning the pinned Global Constraint — out of
  // scope, see the architecture doc's fork note for T-D1).
  it('the synthetic-suffix fix does not introduce `raw` into the body (Global Constraint, reinforced)', async () => {
    const body = await captureBody(req());
    expect(body.raw).toBeUndefined();
  });
});

describe('OllamaFimBackend.streamFim — mid-stream {error} chunk (T6, invariant #3 / ARCH-2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a fixed body-free message, never the raw runner error text', async () => {
    const line = JSON.stringify({ error: 'model blew up: /home/user/.ollama/models/secret-internal-path' }) + '\n';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(line));
          controller.close();
        },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe('Ollama /api/generate reported an error mid-stream');
    expect(message).not.toMatch(/blew up/);
    expect(message).not.toMatch(/secret-internal-path/);
  });

  /**
   * T-6 M-2 (carried forward from the T-5 review): a mid-stream `chunk.error`
   * used to throw a PLAIN `Error`, which is invisible to `provider.ts`'s
   * typed catch chain (`BackendStreamError`-specific arm added by T-5 for
   * the SSE backends) — it fell through every arm to the silent
   * `return null` at the bottom, so a mid-stream Ollama runner error
   * produced NO user-facing signal at all, unlike vLLM/Codestral/
   * openai-compat which all surface via that same arm. `BackendStreamError`
   * reuses the existing arm instead of inventing a second one.
   */
  it('throws a BackendStreamError (not a plain Error) so provider.ts\'s typed catch chain can surface it like the SSE backends', async () => {
    const line = JSON.stringify({ error: 'model blew up' }) + '\n';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(line));
          controller.close();
        },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendStreamError);
  });
});

describe('OllamaFimBackend.streamFim — WS-BG NDJSON chunk ingress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ndjsonBodyStream(lines: unknown[]): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function collect(lines: unknown[]): Promise<string[]> {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: ndjsonBodyStream(lines) } as unknown as Response),
    );
    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const parts: string[] = [];
    for await (const t of backend.streamFim(req(), new AbortController().signal)) parts.push(t);
    return parts;
  }

  it('non-record NDJSON lines are skipped, not dotted into', async () => {
    expect(await collect([42, 'noise', ['x'], { response: 'ok' }, { done: true }])).toEqual(['ok']);
  });

  it('a non-string response field is dropped, never yielded as fake completion text', async () => {
    expect(await collect([{ response: 7 }, { response: 'real' }, { done: true }])).toEqual(['real']);
  });

  it('a mid-stream error chunk still throws BackendStreamError (unchanged)', async () => {
    await expect(collect([{ error: 'boom' }])).rejects.toThrow(BackendStreamError);
  });
});

/**
 * WS-R1 R1-7 (ADR-R2-06, L2-CA-05, C-1-redesigned): proves this backend
 * actually threads `armStreamDeadlines`/`raceWithDeadline` end to end — a
 * mid-stream stall (fetch resolves fast with a first chunk, then goes
 * silent) is reaped as `StreamIdleTimeoutError` once the 120s inter-chunk
 * idle elapses, not left to hang until VS Code cancels or the runtime's own
 * 300s default.
 */
describe('OllamaFimBackend.streamFim — ADR-R2-06 stream deadlines (L2-CA-05)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reaps a mid-stream stall as StreamIdleTimeoutError once the 120s inter-chunk idle elapses', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ response: 'a', done: false }) + '\n'));
        // Deliberately never enqueue again, never close.
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body } as unknown as Response));

    const backend = new OllamaFimBackend({ apiBase: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:1.5b-base' });
    const iterator = backend.streamFim(req(), new AbortController().signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toBe('a');

    // Attach the rejection expectation BEFORE advancing timers (vitest's own
    // idiom for this exact shape — see embedder.test.ts's RAG-2 deadline
    // test) so nothing ever observes `pending` as unhandled mid-advance.
    const assertion = expect(iterator.next()).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    await assertion;
  });
});
