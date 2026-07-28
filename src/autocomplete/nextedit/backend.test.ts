import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextEditHttpBackend } from './backend';
import { InsecureTransportError } from '../backends/secureTransport';
import { BackendHttpError } from '../backends/http';
import { mintScannedNextEditRequest } from './scan';
import type { NextEditRequest, NextEditTransportId, ScannedNextEditRequest } from './types';
import type { RenderedNextEditPrompt, StopReason } from './formats/types';

/** Task 11 brief §Ambiguity 1: the `/* ... *\/` placeholders in the brief's test
 * sketches are shorthand, not permission to skip — every test below is written
 * out in full. */

/** Finding 5: `model` here is kept in sync with `makeBackend`'s default
 * `opts.model` ('test-model') — `predict` now fail-closed-throws when
 * `req.model !== opts.model`, so every fixture that pairs `minted()` with a
 * `makeBackend(...)`-constructed backend must agree on the model id. The one
 * test that constructs a backend with a non-default `opts.model` passes a
 * matching `req` explicitly (see the guard-order test below). */
function cleanReq(): NextEditRequest {
  return {
    model: 'test-model',
    cursor: { uri: 'file:///a.ts', line: 5, character: 0 },
    region: { uri: 'file:///a.ts', filepath: 'file:///a.ts', startLine: 0, endLine: 10, content: 'const x = 1;\n' },
    preEditRegion: null,
    fileContext: 'context lines\n',
    docText: 'whole file\n',
    preEditDocText: null,
    changesAboveCursor: false,
    diffs: [],
    docVersion: 1,
  };
}

function minted(sentinels: readonly string[] = []): ScannedNextEditRequest {
  return mintScannedNextEditRequest(cleanReq(), sentinels);
}

function rendered(): RenderedNextEditPrompt {
  return {
    prompt: 'RENDERED PROMPT TEXT',
    prefill: '',
    stop: ['<|endoftext|>', '<|file_sep|>'],
    temperature: 0,
    maxTokens: 1024,
  };
}

/** D1: `predict` now reads its body via `readJsonBounded`
 *  (`response.body.getReader()`), not `response.json()` — fixtures must
 *  supply a real `ReadableStream` body, not a `json()` method. */
function jsonBodyStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: jsonBodyStream(body),
  } as unknown as Response;
}

function apiBaseFor(transport: NextEditTransportId): string {
  return transport === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8000';
}

function makeBackend(transport: NextEditTransportId, overrides: { apiKey?: string; apiBase?: string } = {}): NextEditHttpBackend {
  return new NextEditHttpBackend({
    transport,
    apiBase: overrides.apiBase ?? apiBaseFor(transport),
    apiKey: overrides.apiKey,
    model: 'test-model',
    sentinels: [],
  });
}

/** Captures the JSON body `fetch` was called with, replying with a
 * transport-appropriate ok response so `predict` completes normally. */
async function captureBody(transport: NextEditTransportId): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const okBody =
    transport === 'ollama'
      ? { response: 'txt', done: true, done_reason: 'stop' }
      : { choices: [{ text: 'txt', finish_reason: 'stop' }] };
  const fetchSpy = vi.fn((_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string) as Record<string, unknown>;
    return Promise.resolve(fakeOkResponse(okBody));
  });
  vi.stubGlobal('fetch', fetchSpy);

  const backend = makeBackend(transport);
  await backend.predict(minted(), rendered(), new AbortController().signal);
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NextEditHttpBackend.predict — pinned guard order (security)', () => {
  it('guard order: http + remote host + apiKey ⇒ InsecureTransportError and fetch is NEVER called', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const b = new NextEditHttpBackend({
      transport: 'openai-compat',
      apiBase: 'http://gpu.internal:8000',
      apiKey: 'k',
      model: 'test-model', // Finding 5: must match minted()'s req.model, or the (0) reconciliation check fires first.
      sentinels: [],
    });
    await expect(b.predict(minted(), rendered(), new AbortController().signal)).rejects.toThrow(InsecureTransportError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the wire-adjacent backstop trips on a cast-forged brand carrying a secret', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('ollama');
    const forged = {
      ...cleanReq(),
      docText: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    } as unknown as ScannedNextEditRequest;

    await expect(backend.predict(forged, rendered(), new AbortController().signal)).rejects.toThrow(/ruleId=/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /** Finding 3: pins the order between guard (1) `assertSecureAuthTransport`
   * and guard (2) the re-mint backstop. A request that would trip BOTH
   * (insecure transport params AND a forged/poisoned brand) must throw the
   * TRANSPORT error, not the scan error — proving (1) runs before (2). If
   * the two calls were ever swapped, the re-mint would throw its own
   * (ruleId=...) Error first, which is not an InsecureTransportError
   * instance, and this assertion would fail. */
  it('guard order is pinned: a request that would trip BOTH guards throws the transport error, not the scan error', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new NextEditHttpBackend({
      transport: 'openai-compat',
      apiBase: 'http://gpu.internal:8000', // insecure: remote host + apiKey, http
      apiKey: 'k',
      model: 'test-model',
      sentinels: [],
    });
    const forgedAndInsecure = {
      ...cleanReq(),
      docText: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    } as unknown as ScannedNextEditRequest; // would ALSO trip the re-mint backstop

    await expect(backend.predict(forgedAndInsecure, rendered(), new AbortController().signal)).rejects.toThrow(
      InsecureTransportError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** Finding 5 (controller-resolved contract gap): `NextEditRequest.model`
 * (`types.ts`) and `NextEditBackendOptions.model` are two independent
 * carriers of what should be the SAME value, and nothing upstream of
 * `predict` reconciled them — a future Task-12 shell that sets `req.model`
 * to one value while constructing the backend with a different `opts.model`
 * would silently send `opts.model` on the wire with no test noticing. */
describe('NextEditHttpBackend.predict — model reconciliation (req.model vs opts.model)', () => {
  it('throws (fail-closed) when req.model diverges from opts.model, before any guard/network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('ollama'); // opts.model: 'test-model'
    const divergent = mintScannedNextEditRequest({ ...cleanReq(), model: 'a-completely-different-model' }, []);

    await expect(backend.predict(divergent, rendered(), new AbortController().signal)).rejects.toThrow(
      /req\.model.*opts\.model|a-completely-different-model/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not throw when req.model matches opts.model (the existing fixtures already agree)', async () => {
    const captured = await captureBody('ollama');
    expect(captured.model).toBe('test-model');
  });
});

describe('NextEditHttpBackend.predict — Ollama body shape (raw:true, num_ctx NEVER present)', () => {
  it('ollama body shape: raw:true, stream:false, options carry ONLY temperature/num_predict/stop — NEVER num_ctx', async () => {
    const captured = await captureBody('ollama');
    expect(captured.raw).toBe(true);
    expect(captured.stream).toBe(false);
    const options = captured.options as Record<string, unknown>;
    expect(Object.keys(options).sort()).toEqual(['num_predict', 'stop', 'temperature']);
    expect(JSON.stringify(captured)).not.toContain('num_ctx');
  });

  it('ollama body carries the pinned model/prompt/keep_alive literals', async () => {
    const captured = await captureBody('ollama');
    expect(captured.model).toBe('test-model');
    expect(captured.prompt).toBe('RENDERED PROMPT TEXT');
    expect(captured.keep_alive).toBe('30m');
    const options = captured.options as Record<string, unknown>;
    expect(options.temperature).toBe(0);
    expect(options.num_predict).toBe(1024);
    expect(options.stop).toEqual(['<|endoftext|>', '<|file_sep|>']);
  });
});

describe('NextEditHttpBackend.predict — openai-compat body shape (skip_special_tokens:false, no raw/num_ctx)', () => {
  it('openai-compat body shape: max_tokens/temperature/stop/stream:false/skip_special_tokens:false, no num_ctx, no raw', async () => {
    const captured = await captureBody('openai-compat');
    expect(captured.max_tokens).toBe(1024);
    expect(captured.temperature).toBe(0);
    expect(captured.stop).toEqual(['<|endoftext|>', '<|file_sep|>']);
    expect(captured.stream).toBe(false);
    expect(captured.skip_special_tokens).toBe(false);
    expect('raw' in captured).toBe(false);
    expect(JSON.stringify(captured)).not.toContain('num_ctx');
  });

  it('sends Authorization: Bearer <key> when apiKey is set (loopback carve-out)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOkResponse({ choices: [{ text: 'txt', finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('openai-compat', { apiKey: 'secret-key' });
    await backend.predict(minted(), rendered(), new AbortController().signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
  });

  it('omits the Authorization header entirely when no apiKey is set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOkResponse({ choices: [{ text: 'txt', finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('openai-compat');
    await backend.predict(minted(), rendered(), new AbortController().signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  /**
   * D2 (widened — the third emitter): a truthiness-only `if
   * (this.opts.apiKey)` gate treats a whitespace-only string as "a real key
   * is present" (`!!'   '` is `true` in JS) — RFC 6750 §2.1's `b64token`
   * ABNF requires at least one token character and allows no whitespace, so
   * `Bearer    ` is not a valid bearer credential and must never reach the
   * wire.
   */
  it('omits the Authorization header when apiKey is whitespace-only (D2: currently sends "Bearer    ")', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOkResponse({ choices: [{ text: 'txt', finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('openai-compat', { apiKey: '   ' });
    await backend.predict(minted(), rendered(), new AbortController().signal);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });

  /**
   * D2: the transport guard (guard step 1, pinned above the openai-compat
   * describe block) must see the SAME normalized value as the header — a
   * whitespace-only apiKey must resolve `hasApiKey=false` in
   * `assertSecureAuthTransport`, so it must NOT be refused over remote http.
   */
  it('does not throw InsecureTransportError for a whitespace-only apiKey over remote http (transport decision uses the same normalized value as the header)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOkResponse({ choices: [{ text: 'txt', finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new NextEditHttpBackend({
      transport: 'openai-compat',
      apiBase: 'http://gpu.internal:8000',
      apiKey: '   ',
      model: 'test-model',
      sentinels: [],
    });

    await backend.predict(minted(), rendered(), new AbortController().signal);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('NextEditHttpBackend.predict — stop-reason normalization', () => {
  it.each([
    ['ollama', { response: 'txt', done: true, done_reason: 'stop' }, 'stop'],
    ['ollama', { response: 'txt', done: true, done_reason: 'length' }, 'length'],
    ['ollama', { response: 'txt', done: true }, 'unknown'],
    ['openai-compat', { choices: [{ text: 'txt', finish_reason: 'stop' }] }, 'stop'],
    ['openai-compat', { choices: [{ text: 'txt', finish_reason: 'length' }] }, 'length'],
    // Ambiguity 2 (task-11-brief.md's own load-bearing else-arm): a vLLM-only
    // finish_reason outside {stop,length} must land in the 'unknown' arm.
    ['openai-compat', { choices: [{ text: 'txt', finish_reason: 'abort' }] }, 'unknown'],
  ] as [NextEditTransportId, unknown, StopReason][])(
    'stop-reason normalization: %s %o -> %s',
    async (transport, body, expected) => {
      const fetchSpy = vi.fn().mockResolvedValue(fakeOkResponse(body));
      vi.stubGlobal('fetch', fetchSpy);
      const backend = makeBackend(transport);

      const out = await backend.predict(minted(), rendered(), new AbortController().signal);
      expect(out.stopReason).toBe(expected);
      expect(out.text).toBe('txt');
    },
  );
});

describe('NextEditHttpBackend.predict — A1 typed HTTP errors (status + statusText only, never the body)', () => {
  it('401 propagates as BackendHttpError with status only — the message never contains the response body', async () => {
    const poisonMarker = 'POISON_MARKER_SECRET_BODY_TEXT_sk-should-never-leak';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: poisonMarker }),
      text: () => Promise.resolve(poisonMarker),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('ollama');

    let caught: unknown;
    try {
      await backend.predict(minted(), rendered(), new AbortController().signal);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendHttpError);
    expect((caught as BackendHttpError).status).toBe(401);
    expect((caught as BackendHttpError).statusText).toBe('Unauthorized');
    expect((caught as Error).message).not.toContain(poisonMarker);
  });

  /** Finding 2: the sibling openai-compat transport is the one that
   * actually carries a `Bearer` API key on the wire (the Ollama transport
   * above never sends one) — so this path, not the Ollama one, is where a
   * response-body leak would be most damaging. Mirrors the Ollama 401
   * poison-marker test above exactly, plus an apiKey-leak assertion the
   * Ollama test has no reason to carry. */
  it('openai-compat: 401 propagates as BackendHttpError with status only — the message never contains the response body or the API key', async () => {
    const poisonMarker = 'POISON_MARKER_SECRET_BODY_TEXT_sk-should-never-leak';
    const apiKey = 'super-secret-openai-compat-api-key';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: poisonMarker }),
      text: () => Promise.resolve(poisonMarker),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('openai-compat', { apiKey });

    let caught: unknown;
    try {
      await backend.predict(minted(), rendered(), new AbortController().signal);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BackendHttpError);
    expect((caught as BackendHttpError).status).toBe(401);
    expect((caught as BackendHttpError).statusText).toBe('Unauthorized');
    expect((caught as Error).message).not.toContain(poisonMarker);
    expect((caught as Error).message).not.toContain(apiKey);
  });
});

describe('NextEditHttpBackend.predict — abort signal', () => {
  it('abort signal is honored (fetch receives the same signal)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(fakeOkResponse({ response: 'txt', done: true, done_reason: 'stop' }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('ollama');
    const controller = new AbortController();

    await backend.predict(minted(), rendered(), controller.signal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe('NextEditHttpBackend.predict — D1 bounded JSON body reads (unbounded-memory DoS hardening)', () => {
  /** 5 x 1 MiB chunks = 5 MiB, past the 4 MiB MAX_STREAM_BYTES cap. Neither
   *  transport's legitimate response body approaches this size (Ollama's
   *  `/api/generate` final object and vLLM's `/v1/completions` choice text
   *  are both sized to our own maxTokens budget). */
  function overCapResponse(): Response {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 5) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    return { ok: true, status: 200, statusText: 'OK', body } as unknown as Response;
  }

  it('ollama: rejects a well-over-4-MiB /api/generate response body instead of buffering it without limit', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(overCapResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('ollama');

    await expect(backend.predict(minted(), rendered(), new AbortController().signal)).rejects.toThrow(
      /FIM stream exceeded \d+ bytes without completing/,
    );
  });

  it('openai-compat: rejects a well-over-4-MiB /v1/completions response body instead of buffering it without limit', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(overCapResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const backend = makeBackend('openai-compat');

    await expect(backend.predict(minted(), rendered(), new AbortController().signal)).rejects.toThrow(
      /FIM stream exceeded \d+ bytes without completing/,
    );
  });
});
