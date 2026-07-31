import { describe, it, expect, vi, afterEach } from 'vitest';
import { LlamaCppInfillBackend } from './LlamaCppInfillBackend';
import { BackendHttpError } from './http';
import { InsecureTransportError } from './secureTransport';
import { scannedSnippetForTest } from '../context/scannedSnippetTestFactory';
import type { ScannedSnippet } from '../context/types';
import type { FimRequest } from '../types';

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

/** A `fetch` resolution that satisfies `Response` well enough for `warmUp`,
 *  which never reads the body (§2.4 — warm-up only primes KV, no parsing). */
function okResponse(): Response {
  return { ok: true } as Response;
}

/** D1: `streamFim` now reads its body via `readJsonBounded` (`response.body`
 *  `.getReader()`), not `response.json()` — fixtures must supply a real
 *  `ReadableStream` body, not a `json()` method. */
function jsonBodyStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function okJsonResponse(value: unknown): Response {
  return { ok: true, body: jsonBodyStream(value) } as unknown as Response;
}

describe('LlamaCppInfillBackend.warmUp — §2.4 llama.vim-style KV warm-up', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /infill with EMPTY input_prefix/input_suffix, snippets as input_extra, and n_predict/t_max_prompt_ms/t_max_predict_ms all 1', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });
    const snippets = [snippet({ filepath: 'a.ts', content: 'const a = 1;' })];

    backend.warmUp(snippets, new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/infill');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      input_prefix: '',
      input_suffix: '',
      input_extra: [{ filename: 'a.ts', text: 'const a = 1;' }],
      prompt: '',
      n_predict: 1,
      t_max_prompt_ms: 1,
      t_max_predict_ms: 1,
      stream: false,
    });
  });

  it('never carries active-file prefix/suffix content — input_extra reflects ONLY the passed snippets', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });
    const snippets = [
      snippet({ filepath: 'a.ts', content: 'const a = 1;' }),
      snippet({ filepath: 'b.ts', content: 'const b = 2;' }),
    ];

    backend.warmUp(snippets, new AbortController().signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input_extra: unknown[] };
    expect(body.input_extra).toEqual([
      { filename: 'a.ts', text: 'const a = 1;' },
      { filename: 'b.ts', text: 'const b = 2;' },
    ]);
  });

  it('sends an empty input_extra for an empty snippet set (still fires, still empty prefix/suffix)', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    backend.warmUp([], new AbortController().signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input_extra: unknown[] };
    expect(body.input_extra).toEqual([]);
  });

  it('passes the AbortSignal through to fetch so the caller can cancel', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });
    const controller = new AbortController();

    backend.warmUp([snippet()], controller.signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('returns void synchronously — fire-and-forget, not a Promise the caller is expected to await', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const result = backend.warmUp([snippet()], new AbortController().signal);

    expect(result).toBeUndefined();
  });

  it('swallows a fetch rejection (network error) without throwing or producing an unhandled rejection', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      expect(() => backend.warmUp([snippet()], new AbortController().signal)).not.toThrow();
      // Let the rejected fetch promise's microtask (and the .catch that
      // swallows it) actually run, then one real macrotask tick — Node's
      // unhandledRejection detection fires on a later macrotask, not merely
      // after more microtasks (same pattern as contextService.test.ts's
      // gather-failure resilience suite).
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toEqual([]);
  });

  it('swallows a non-ok HTTP response without throwing (best-effort — no parsing/streaming of the result)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' } as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    expect(() => backend.warmUp([snippet()], new AbortController().signal)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('assertAllScanned backstop (B1): a forged/bypassed secret-bearing snippet is dropped fail-closed BEFORE fetch, without throwing (warmUp\'s own "never surface" contract stays intact)', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });
    // A snippet that never actually passed a scan — simulates a forgery that
    // bypassed ringBuffer.ingest's choke point (only reachable in production
    // via an unsafe cast / any-typed laundering seam). Not a real secret —
    // the same fixture provider-detector shape used across secretScanner.test.ts.
    const forged = [snippet({ content: '-----BEGIN PRIVATE KEY-----' })];

    expect(() => backend.warmUp(forged, new AbortController().signal)).not.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe('LlamaCppInfillBackend.streamFim — assertAllScanned egress backstop (B1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function forgedReq(): FimRequest {
    // Same "bypassed the choke-point" simulation as the warmUp suite above —
    // a ScannedSnippet-typed value that never actually passed a scan.
    const forged = snippet({ content: '-----BEGIN PRIVATE KEY-----' });
    return {
      model: 'qwen2.5-coder:1.5b-base',
      prefix: 'const x = ',
      suffix: '',
      stop: [],
      temperature: 0.01,
      maxTokens: 128,
      context: {
        filepath: 'file:///a.ts',
        languageId: 'typescript',
        prefix: 'const x = ',
        suffix: '',
        workspaceUris: [],
        snippets: [forged],
      },
    };
  }

  it('throws fail-closed BEFORE fetch when req.context.snippets carries a forged/bypassed secret-bearing snippet (llama.cpp input_extra channel)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const iterator = backend
      .streamFim(forgedReq(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/assertAllScanned/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('does not affect a clean request — fetch still fires normally with only legitimately-scanned snippets', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJsonResponse({ content: '' }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const req: FimRequest = {
      model: 'qwen2.5-coder:1.5b-base',
      prefix: 'const x = ',
      suffix: '',
      stop: [],
      temperature: 0.01,
      maxTokens: 128,
      context: {
        filepath: 'file:///a.ts',
        languageId: 'typescript',
        prefix: 'const x = ',
        suffix: '',
        workspaceUris: [],
        snippets: [snippet({ content: 'const a = 1;' })],
      },
    };

    const iterator = backend.streamFim(req, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('LlamaCppInfillBackend.streamFim — A1 typed HTTP errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function cleanReq(): FimRequest {
    return {
      model: 'qwen2.5-coder:1.5b-base',
      prefix: 'const x = ',
      suffix: '',
      stop: [],
      temperature: 0.01,
      maxTokens: 128,
      context: {
        filepath: 'file:///a.ts',
        languageId: 'typescript',
        prefix: 'const x = ',
        suffix: '',
        workspaceUris: [],
        snippets: [snippet({ content: 'const a = 1;' })],
      },
    };
  }

  it('throws a BackendHttpError with .status preserved when fetch resolves !response.ok', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const iterator = backend
      .streamFim(cleanReq(), new AbortController().signal)
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
});

describe('LlamaCppInfillBackend.streamFim — D1 bounded JSON body reads (unbounded-memory DoS hardening)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function cleanReq(): FimRequest {
    return {
      model: 'qwen2.5-coder:1.5b-base',
      prefix: 'const x = ',
      suffix: '',
      stop: [],
      temperature: 0.01,
      maxTokens: 128,
      context: {
        filepath: 'file:///a.ts',
        languageId: 'typescript',
        prefix: 'const x = ',
        suffix: '',
        workspaceUris: [],
        snippets: [snippet({ content: 'const a = 1;' })],
      },
    };
  }

  it('rejects a well-over-4-MiB /infill response body instead of buffering it without limit', async () => {
    // 5 x 1 MiB chunks = 5 MiB, past the legitimate ~1 MB prompt-echo
    // ceiling AND past the 4 MiB MAX_STREAM_BYTES cap.
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulls = 0;
    const overCapBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 5) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, body: overCapBody } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const iterator = backend.streamFim(cleanReq(), new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(
      /response exceeded \d+ bytes without completing/,
    );
  });
});

/**
 * T-6 F5 remainder: the Codestral half of F5 (trim-normalized auth) already
 * landed locally in `CodestralFimBackend.ts`; this is the missing
 * LlamaCpp half — an explicit, named guard for a missing `response.body` on
 * an `ok` /infill response, mirroring every other backend's identical
 * `if (!response.body) throw new Error(...)` arm (`OllamaFimBackend.ts`,
 * `VllmFimBackend.ts`, `OpenAICompatFimBackend.ts`, `CodestralFimBackend.ts`).
 * Without it, `readJsonBounded` falls through to `JSON.parse('')` on a null
 * body, which DOES throw — but an opaque `SyntaxError: Unexpected end of
 * JSON input` that never names llama.cpp or `/infill`, unlike every sibling
 * backend's guard.
 */
describe('LlamaCppInfillBackend.streamFim — F5: missing response.body guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function cleanReq(): FimRequest {
    return {
      model: 'qwen2.5-coder:1.5b-base',
      prefix: 'const x = ',
      suffix: '',
      stop: [],
      temperature: 0.01,
      maxTokens: 128,
      context: {
        filepath: 'file:///a.ts',
        languageId: 'typescript',
        prefix: 'const x = ',
        suffix: '',
        workspaceUris: [],
        snippets: [snippet({ content: 'const a = 1;' })],
      },
    };
  }

  it('a missing response.body on an ok response is NOT a BackendHttpError (no real HTTP-status failure to report)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const iterator = backend
      .streamFim(cleanReq(), new AbortController().signal)
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

  it('names llama.cpp /infill and the real status/statusText, not an opaque JSON.parse SyntaxError', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const iterator = backend
      .streamFim(cleanReq(), new AbortController().signal)
      [Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect((caught as Error).message).toBe('llama.cpp /infill failed: 200 OK');
  });
});

/**
 * T-6 F4: `LlamaCppInfillBackend` gains an optional `apiKey` — the vLLM
 * pattern verbatim (`VllmFimBackend.test.ts`'s identical block): trim-
 * normalized so a whitespace-only key never reaches the wire nor trips the
 * transport guard, `assertSecureAuthTransport` refuses an insecure remote
 * http+key combination before any fetch, and the `Authorization` header is
 * present iff a real (post-trim) key was configured.
 */
describe('LlamaCppInfillBackend.streamFim — F4: optional apiKey (S4.2 transport guard + Bearer header)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function cleanReq(): FimRequest {
    return {
      model: 'qwen2.5-coder:1.5b-base',
      prefix: 'const x = ',
      suffix: '',
      stop: [],
      temperature: 0.01,
      maxTokens: 128,
      context: {
        filepath: 'file:///a.ts',
        languageId: 'typescript',
        prefix: 'const x = ',
        suffix: '',
        workspaceUris: [],
        snippets: [snippet({ content: 'const a = 1;' })],
      },
    };
  }

  it('sends Authorization: Bearer <key> (and keeps Content-Type) when apiKey is set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJsonResponse({ content: '' }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({
      apiBase: 'http://127.0.0.1:8080',
      apiKey: 'secret-llamacpp-key',
    });

    const iterator = backend.streamFim(cleanReq(), new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-llamacpp-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the Authorization header entirely when no apiKey is set (not empty, not "Bearer undefined")', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJsonResponse({ content: '' }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080' });

    const iterator = backend.streamFim(cleanReq(), new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  it('omits the Authorization header when apiKey is whitespace-only (D2 normalization)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJsonResponse({ content: '' }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({ apiBase: 'http://127.0.0.1:8080', apiKey: '   ' });

    const iterator = backend.streamFim(cleanReq(), new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  it('throws InsecureTransportError and never calls fetch when apiKey is set over remote http', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({
      apiBase: 'http://gpu-box.lan:8080',
      apiKey: 'secret-llamacpp-key',
    });

    const iterator = backend.streamFim(cleanReq(), new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(InsecureTransportError);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('allows an apiKey over loopback http (carve-out) — fetch IS called', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okJsonResponse({ content: '' }));
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new LlamaCppInfillBackend({
      apiBase: 'http://127.0.0.1:8080',
      apiKey: 'local-key',
    });

    const iterator = backend.streamFim(cleanReq(), new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * T-6 F4 (warmUp half): the KV-cache warm-up fetch hits the SAME `/infill`
 * endpoint as `streamFim` — an apiKey-protected llama.cpp server rejects an
 * unauthenticated warm-up too, so the same normalized key/header/transport
 * treatment applies here. `warmUp`'s own contract ("never surface or
 * throw") means an insecure-transport refusal must be swallowed exactly
 * like the existing `assertAllScanned` backstop above — proven by the
 * "fetch never called" assertion below rather than a rejection assertion
 * (warmUp returns `void`, not a rejecting promise).
 */
describe('LlamaCppInfillBackend.warmUp — F4: optional apiKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends Authorization: Bearer <key> on the warm-up request when apiKey is set', () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({
      apiBase: 'http://127.0.0.1:8080',
      apiKey: 'secret-llamacpp-key',
    });

    backend.warmUp([snippet()], new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-llamacpp-key');
  });

  it('never calls fetch (swallowed, not thrown) when apiKey is set over remote http — warmUp\'s "never surface or throw" contract holds', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new LlamaCppInfillBackend({
      apiBase: 'http://gpu-box.lan:8080',
      apiKey: 'secret-llamacpp-key',
    });

    expect(() => backend.warmUp([snippet()], new AbortController().signal)).not.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
