import { describe, it, expect, vi, afterEach } from 'vitest';
import { VllmFimBackend } from './VllmFimBackend';
import { BackendHttpError, BackendStreamError } from './http';
import { InsecureTransportError } from './secureTransport';
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
    // nativeFim is false for vLLM — engine.ts always populates renderedPrompt
    // before dispatching; mirrored here since this test bypasses the engine.
    renderedPrompt: '<|fim_prefix|>const x = <|fim_suffix|><|fim_middle|>',
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

/** A `fetch` resolution whose body is a stream that closes immediately (no deltas). */
function emptyStreamResponse(): Response {
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
  } as unknown as Response;
}

/** A `fetch` resolution whose SSE body is a sequence of raw `data:` events
 *  (caller supplies the already-formatted event strings, e.g.
 *  `'data: {...}\n\n'`), used for the V-14 mid-stream-error-frame tests
 *  below. */
function sseResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
  } as unknown as Response;
}

/**
 * A2 — vLLM auth: optional `apiKey`, conditional Bearer header, and the S4.2
 * transport guard (CWE-319) at the pinned pre-fetch site. Mirrors
 * `OpenAICompatFimBackend.test.ts`'s transport-guard block verbatim in shape.
 */
describe('VllmFimBackend.streamFim — S4.2 transport guard (CWE-319) + Bearer header', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends Authorization: Bearer <key> (and keeps Content-Type) when apiKey is set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      apiKey: 'secret-vllm-key',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-vllm-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the Authorization header entirely when no apiKey is set (not empty, not "Bearer undefined")', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  /**
   * D2 (widened): a truthiness-only `if (this.opts.apiKey)` gate treats a
   * whitespace-only string as "a real key is present" (`!!'   '` is `true`
   * in JS) — RFC 6750 §2.1's `b64token` ABNF (`1*( ALPHA / DIGIT / "-" /
   * "." / "_" / "~" / "+" / "/" ) *"="`) requires at least one token
   * character and allows no whitespace, so `Bearer    ` is not a valid
   * bearer credential and must never reach the wire.
   */
  it('omits the Authorization header when apiKey is whitespace-only (D2: currently sends "Bearer    ")', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      apiKey: '   ',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  /**
   * D2: the transport guard must see the SAME normalized value as the
   * header — a whitespace-only apiKey must resolve `hasApiKey=false` in
   * `assertSecureAuthTransport`, so it must NOT be refused over remote http
   * (there is nothing secret to protect once the key is normalized away).
   */
  it('does not throw InsecureTransportError for a whitespace-only apiKey over remote http (transport decision uses the same normalized value as the header)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({
      apiBase: 'http://gpu-box.lan:8000',
      apiKey: '   ',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws InsecureTransportError and never calls fetch when apiKey is set over remote http', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // Remote + http + apiKey: must be refused before any network call — the
    // "fetch never called" assertion is the load-bearing half of this test.
    const backend = new VllmFimBackend({
      apiBase: 'http://gpu-box.lan:8000',
      apiKey: 'secret-vllm-key',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(InsecureTransportError);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('allows an apiKey over loopback http (carve-out) — fetch IS called', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      apiKey: 'local-key',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('allows an apiKey over https to a remote host', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({
      apiBase: 'https://gpu-box.example.com:8000',
      apiKey: 'remote-key',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * W6-FD (§3.2, ratified W5 critic-pin B1) — the wire-adjacent
 * `assertAllScanned` backstop, wired into every FIM backend. This is the
 * only test coverage this backend has at all; scoped narrowly to the
 * backstop this task adds.
 */
describe('VllmFimBackend.streamFim — assertAllScanned egress backstop (B1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws fail-closed BEFORE fetch when req.context.snippets carries a forged/bypassed secret-bearing snippet', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });
    const forged = [snippet({ content: '-----BEGIN PRIVATE KEY-----' })];

    const iterator = backend
      .streamFim(req(forged), new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/assertAllScanned/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('does not affect a clean request with only legitimately-scanned snippets', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });
    const clean = [snippet({ content: 'const a = 1;' })];

    const iterator = backend
      .streamFim(req(clean), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * D-2 (A6) — the `?? getTemplateForModel(...)` fallback was a live second writer
 * of the FIM prompt (a different token rendering than the engine's, no
 * comment-injection handling, mismatched stop-list). `FimEngine` always
 * populates `renderedPrompt` for a `nativeFim: false` backend (engine.ts:124-126),
 * so a missing `renderedPrompt` here can only mean the invariant was violated —
 * fail closed instead of silently re-rendering a second, disagreeing prompt.
 */
describe('VllmFimBackend.streamFim — D-2 fail-closed invariant: renderedPrompt required', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws the invariant error and never calls fetch when req.renderedPrompt is undefined', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });
    const badReq: FimRequest = { ...req(), renderedPrompt: undefined };

    const iterator = backend
      .streamFim(badReq, new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(
      'VllmFimBackend: renderedPrompt missing — FimEngine must render for nativeFim:false backends (invariant)',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('uses req.renderedPrompt verbatim as the `prompt` body field when present', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { prompt: string };
    expect(body.prompt).toBe('<|fim_prefix|>const x = <|fim_suffix|><|fim_middle|>');
  });
});

describe('VllmFimBackend.streamFim — A1 typed HTTP errors', () => {
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

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });

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

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });

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
 * V-14 (FIM-SSE-ERROR): vLLM really does emit a mid-stream error as a
 * `data:` frame on an otherwise-200 SSE response (`serving.py:491-497`
 * `create_streaming_error_response`) — the pre-refactor private drain here
 * read only `choices?.[0]?.text` and silently `continue`d on it, so the
 * error surfaced as an empty (but "successful") completion. This backend
 * now delegates to the shared `readOpenAiSseText` drain in `http.ts`.
 */
describe('VllmFimBackend.streamFim — V-14: mid-stream SSE error frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a body-free BackendStreamError on a mid-stream error frame instead of resolving as an empty completion', async () => {
    const bodyMarker = 'VLLM_INTERNAL_DETAIL_never_surfaced_4e91';
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse([
        `data: {"error":{"message":"${bodyMarker}","type":"InternalServerError"}}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });
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
    expect((caught as Error).message).not.toContain(bodyMarker);
  });

  /**
   * The false-positive pin, backend-integration level: vLLM's own final
   * usage chunk (`stream_options.include_usage`) legitimately carries
   * `choices: []` with no `error` key at all (`serving.py:474-486`) — this
   * must resolve as a normal (if textless) completion, never throw.
   */
  it('does NOT throw on a trailing usage-only frame with an empty choices array', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"text":"partial"}]}\n\n',
        'data: {"id":"x","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new VllmFimBackend({ apiBase: 'http://127.0.0.1:8000', model: 'qwen2.5-coder:1.5b-base' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();

    const out: string[] = [];
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      out.push(value);
    }

    expect(out).toEqual(['partial']);
  });
});
