import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatFimBackend } from './OpenAICompatFimBackend';
import { BackendHttpError, BackendStreamError } from './http';
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

/** A `fetch` resolution whose SSE body is a sequence of raw `data:` events —
 *  used for the V-14 mid-stream-error-frame test below. */
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

describe('OpenAICompatFimBackend.streamFim — S4.2 transport guard (CWE-319)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call fetch (no Bearer leaves) when apiKey is set over remote http', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // Remote + http + apiKey (the optional key IS set here): must be refused
    // before any network call.
    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://example.com:8000',
      apiKey: 'secret-openai-compat-key',
      model: 'qwen2.5-coder:1.5b-base',
    });

    // `FimBackend.streamFim` is typed `AsyncIterable<string>` (the contract, not
    // the concrete async-generator shape) — pull the iterator explicitly so
    // `.next()` is available without a cast.
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/cleartext/i);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('allows an apiKey over loopback http (carve-out) — fetch IS called', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    // Local authed openai-compat shim: 127.0.0.1 never crosses a network, so
    // an apiKey here is allowed over http per the controller-decided carve-out.
    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      apiKey: 'local-key',
      model: 'qwen2.5-coder:1.5b-base',
    });

    // `FimBackend.streamFim` is typed `AsyncIterable<string>` (the contract, not
    // the concrete async-generator shape) — pull the iterator explicitly so
    // `.next()` is available without a cast.
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the default no-apiKey loopback path working (default Ollama-style path unaffected)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });

    // `FimBackend.streamFim` is typed `AsyncIterable<string>` (the contract, not
    // the concrete async-generator shape) — pull the iterator explicitly so
    // `.next()` is available without a cast.
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * D2 (widened): a truthiness-only `if (this.opts.apiKey)` gate treats a
   * whitespace-only string as "a real key is present" (`!!'   '` is `true`
   * in JS) — RFC 6750 §2.1's `b64token` ABNF requires at least one token
   * character and allows no whitespace, so `Bearer    ` is not a valid
   * bearer credential and must never reach the wire.
   */
  it('omits the Authorization header when apiKey is whitespace-only (D2: currently sends "Bearer    ")', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OpenAICompatFimBackend({
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
   * `assertSecureAuthTransport`, so it must NOT be refused over remote http.
   */
  it('does not throw InsecureTransportError for a whitespace-only apiKey over remote http (transport decision uses the same normalized value as the header)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://example.com:8000',
      apiKey: '   ',
      model: 'qwen2.5-coder:1.5b-base',
    });

    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAICompatFimBackend.streamFim — A1 typed HTTP errors', () => {
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

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });

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

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });

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

describe('OpenAICompatFimBackend.streamFim — assertAllScanned egress backstop (B1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws fail-closed BEFORE fetch when req.context.snippets carries a forged/bypassed secret-bearing snippet', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });
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

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });
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
 * V-14 (FIM-SSE-ERROR): same shared `readOpenAiSseText` drain as
 * `VllmFimBackend`/`CodestralFimBackend` — this backend now delegates to it
 * instead of a private loop that read only `choices?.[0]?.text` and
 * silently `continue`d on a mid-stream error frame.
 */
describe('OpenAICompatFimBackend.streamFim — V-14: mid-stream SSE error frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a body-free BackendStreamError on a mid-stream error frame instead of resolving as an empty completion', async () => {
    const bodyMarker = 'OPENAI_COMPAT_INTERNAL_DETAIL_never_surfaced_2b7f';
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse([
        `data: {"error":{"message":"${bodyMarker}","type":"InternalServerError"}}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new OpenAICompatFimBackend({
      apiBase: 'http://127.0.0.1:8000',
      model: 'qwen2.5-coder:1.5b-base',
    });
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
});
