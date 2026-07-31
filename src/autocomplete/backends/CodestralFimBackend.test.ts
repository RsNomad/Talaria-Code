import { describe, it, expect, vi, afterEach } from 'vitest';
import { CodestralFimBackend, MissingApiKeyError } from './CodestralFimBackend';
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
    model: 'codestral-latest',
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

describe('CodestralFimBackend.streamFim — S4.2 transport guard (CWE-319)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call fetch (no Bearer leaves) when apiKey is set over remote http', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // Remote + http + apiKey: the exact combination S4.2 must refuse before
    // any network call — a user-misconfigured apiBase must never leak the key.
    const backend = new CodestralFimBackend({
      apiBase: 'http://example.com:8000',
      apiKey: 'secret-codestral-key',
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

  it('still calls fetch for the default https apiBase (unaffected by the guard)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    // No apiBase override -> defaults to https://codestral.mistral.ai (secure).
    const backend = new CodestralFimBackend({ apiKey: 'k' });
    // `FimBackend.streamFim` is typed `AsyncIterable<string>` (the contract, not
    // the concrete async-generator shape) — pull the iterator explicitly so
    // `.next()` is available without a cast.
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://codestral.mistral.ai/v1/fim/completions',
    );
  });
});

describe('CodestralFimBackend.streamFim — review C-1/M-1/M-2: refuses BEFORE fetch when the key is empty/whitespace', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws MissingApiKeyError before fetch when apiKey is the empty string', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: '' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(MissingApiKeyError);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  /**
   * M-2. `CodestralFimBackendOptions.apiKey` is typed `string` (not
   * optional), so a hand-built config satisfies the type with `'   '`.
   * `assertSecureAuthTransport(url, !!this.opts.apiKey)` treats `!!'   '` as
   * `true` ("a real key is present"), so without the `.trim()` in this
   * guard a whitespace-only key would sail past both checks and put a
   * literal `Bearer   ` header on the wire.
   */
  it('throws MissingApiKeyError for a whitespace-only apiKey too, not just empty', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: '   ' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(MissingApiKeyError);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('the refusal message never carries a key value or a response body', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const backend = new CodestralFimBackend({ apiKey: '' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    let caught: unknown;
    try {
      await iterator.next();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MissingApiKeyError);
    // No literal key value, no Authorization header fragment — the message
    // is fixed, actionable prose, never an echo of caller-supplied input.
    expect((caught as Error).message).not.toMatch(/sk-|Bearer /);
  });

  it('a non-whitespace key still works (control — the guard is not a blanket refusal)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: 'k' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    const { done } = await iterator.next();

    expect(done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CodestralFimBackend.streamFim — A1 typed HTTP errors', () => {
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

    const backend = new CodestralFimBackend({ apiKey: 'k' });

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

    const backend = new CodestralFimBackend({ apiKey: 'k' });

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

describe('CodestralFimBackend.streamFim — assertAllScanned egress backstop (B1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws fail-closed BEFORE fetch when req.context.snippets carries a forged/bypassed secret-bearing snippet, even though this backend never reads .snippets directly', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: 'k' });
    // Codestral has no cross-file channel of its own (no template render, no
    // input_extra) — this proves the backstop still guards the wire even for
    // a backend that never structurally touches req.context.snippets: the
    // check runs on the FimContext itself, not on however a given backend
    // happens to consume it.
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

    const backend = new CodestralFimBackend({ apiKey: 'k' });
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
 * `VllmFimBackend`/`OpenAICompatFimBackend` — Codestral's own chat-style
 * `choices[0].delta.content` shape is one of the two shapes the shared
 * drain understands, so this backend delegates to it too instead of its
 * private loop (which read only `.delta?.content` and silently `continue`d
 * on a mid-stream error frame).
 */
describe('CodestralFimBackend.streamFim — V-14: mid-stream SSE error frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a body-free BackendStreamError on a mid-stream error frame instead of resolving as an empty completion', async () => {
    const bodyMarker = 'CODESTRAL_INTERNAL_DETAIL_never_surfaced_9d3e';
    const fetchSpy = vi.fn().mockResolvedValue(
      sseResponse([
        `data: {"error":{"message":"${bodyMarker}","type":"InternalServerError"}}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: 'k' });
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

/**
 * F5 remainder (auth block, folded into T-5 alongside the V-14 drain half):
 * the OTHER two Bearer-sending backends (`VllmFimBackend`,
 * `OpenAICompatFimBackend`) both normalize `apiKey` via `.trim()` before it
 * ever reaches the `Authorization` header (the D2 pattern) — Codestral's
 * `MissingApiKeyError` guard already REJECTS a whitespace-only key, but
 * (unlike its siblings) never trimmed a key that passes that check, so a
 * key with incidental leading/trailing whitespace (e.g. pasted from a UI
 * that added a trailing newline) was sent VERBATIM as
 * `Bearer   sk-padded-key  ` — not a valid RFC 6750 §2.1 `b64token`.
 */
describe('CodestralFimBackend.streamFim — F5: trims apiKey before building the Authorization header', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a trimmed Bearer token when apiKey carries incidental leading/trailing whitespace', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: '  sk-padded-key  ' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-padded-key');
  });

  it('a key with no surrounding whitespace is unaffected (control)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: 'sk-clean-key' });
    const iterator = backend
      .streamFim(req(), new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-clean-key');
  });
});

/**
 * AUDIT-5 hygiene: this backend's `model` field precedence was inverted
 * relative to its three siblings (`OllamaFimBackend.ts:49`,
 * `OpenAICompatFimBackend.ts:53`, `VllmFimBackend.ts:40` — all
 * `req.model || this.opts.model`); this class alone read
 * `this.opts.model || req.model`. Behavior-neutral TODAY: `req.model`
 * (`FimEngine`'s `this.options.model`, `engine.ts`) and `this.opts.model`
 * (`cfg.model` via `backendFactory.ts`) both derive from the SAME
 * `talaria.autocomplete.model` config read, so no real request ever sees
 * them differ. This test pins the ALIGNED precedence explicitly (with
 * deliberately-differing dummy values, the only way to distinguish which
 * operand wins) so a future edit can't silently re-invert it — the wire
 * shape matches the sibling suites' own precedent.
 */
describe('CodestralFimBackend.streamFim — hygiene: model precedence aligned with siblings (AUDIT-5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends req.model on the wire, matching Ollama/OpenAICompat/Vllm precedence (req.model || opts.model)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyStreamResponse());
    vi.stubGlobal('fetch', fetchSpy);

    const backend = new CodestralFimBackend({ apiKey: 'k', model: 'cfg-model' });
    const iterator = backend
      .streamFim({ ...req(), model: 'req-model' }, new AbortController().signal)
      [Symbol.asyncIterator]();
    await iterator.next();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe('req-model');
  });
});
