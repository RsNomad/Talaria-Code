import { describe, it, expect, vi } from 'vitest';
import { probeRemote, validateEndpointUrl, type ProbeOutcome } from './remoteProbe';
import type { ProbeSpec } from './registry';

/**
 * remoteProbe.test.ts — Task 7 (onboarding-backend-setup-architecture.md
 * §2.5). `probeRemote` routes every network call through the
 * caller-injected `fetchImpl` seam — same discipline `ollamaClient.test.ts`
 * establishes one module over — so this suite never touches a real socket.
 *
 * Shapes grounded via Context7 `/ggml-org/llama.cpp` (tools/server/README.md:
 * `GET /health` → `200 {"status":"ok"}` / `503
 * {"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}`)
 * and vLLM docs (`/v1/models` → `{"object":"list","data":[{"id":…}]}`,
 * `Authorization: Bearer <key>` only when a key is configured), re-verified
 * 2026-08-04.
 */

const ENDPOINT_OLLAMA = 'http://127.0.0.1:11434';
const ENDPOINT_LLAMACPP = 'http://127.0.0.1:8080';
const ENDPOINT_OPENAI = 'http://127.0.0.1:8000';

function jsonResponse(status: number, statusText: string, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

const OLLAMA_SPEC: ProbeSpec = { kind: 'ollama-tags' };
const LLAMACPP_SPEC: ProbeSpec = { kind: 'llamacpp-health' };
const OPENAI_SPEC: ProbeSpec = { kind: 'openai-models' };
const NONE_SPEC: ProbeSpec = { kind: 'none' };

// --- probeRemote: ollama-tags ----------------------------------------------

describe('probeRemote — ollama-tags (§2.5, reuses probeOllama)', () => {
  it('reachable daemon reports ok:true with model names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, 'OK', {
        models: [
          { name: 'qwen2.5-coder:1.5b-base', size: 986_000_000 },
          { name: 'qwen3-embedding:0.6b', size: 600_000_000 },
        ],
      }),
    );

    const result = await probeRemote(OLLAMA_SPEC, ENDPOINT_OLLAMA, undefined, fetchImpl);

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen2.5-coder:1.5b-base', 'qwen3-embedding:0.6b']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('unreachable daemon (connection refused) reports ok:false', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }));

    const result = await probeRemote(OLLAMA_SPEC, ENDPOINT_OLLAMA, undefined, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
    expect(result.models).toBeUndefined();
  });
});

// --- probeRemote: llamacpp-health ------------------------------------------

describe('probeRemote — llamacpp-health (§2.5) GET /health', () => {
  it('200 {"status":"ok"} reports ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, 'OK', { status: 'ok' }));

    const result = await probeRemote(LLAMACPP_SPEC, ENDPOINT_LLAMACPP, undefined, fetchImpl);

    expect(result).toEqual<ProbeOutcome>(expect.objectContaining({ ok: true }));
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8080/health', expect.anything());
  });

  it('503 (model still loading) reports ok:false with a "model loading" detail', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(503, 'Service Unavailable', { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }),
      );

    const result = await probeRemote(LLAMACPP_SPEC, ENDPOINT_LLAMACPP, undefined, fetchImpl);

    expect(result.ok).toBe(false);
    // Surfaces the server's own `error.message` verbatim ("Loading model")
    // rather than inventing fixed text — same "runtime's own message wins"
    // convention `ollamaClient.ts` documents for its `{"error":…}` chunks.
    expect(result.detail.toLowerCase()).toContain('loading');
    expect(result.detail.toLowerCase()).toContain('model');
  });

  it('a thrown fetch (connection refused) reports ok:false, never throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8080'));

    const result = await probeRemote(LLAMACPP_SPEC, ENDPOINT_LLAMACPP, undefined, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });
});

// --- probeRemote: openai-models ---------------------------------------------

describe('probeRemote — openai-models (§2.5) GET /v1/models', () => {
  it('200 with a data[] fixture reports ok:true with model ids, no Authorization header when apiKey is undefined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, 'OK', {
        object: 'list',
        data: [
          { id: 'meta-llama/Llama-3.2-3B-Instruct', object: 'model' },
          { id: 'sql-lora', object: 'model' },
        ],
      }),
    );

    const result = await probeRemote(OPENAI_SPEC, ENDPOINT_OPENAI, undefined, fetchImpl);

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['meta-llama/Llama-3.2-3B-Instruct', 'sql-lora']);
    const [, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('attaches "Authorization: Bearer <apiKey>" only when apiKey is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, 'OK', { object: 'list', data: [] }));

    await probeRemote(OPENAI_SPEC, ENDPOINT_OPENAI, 'sk-test-123', fetchImpl);

    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/models');
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-123');
  });

  it('401 reports ok:false with "unauthorized — check API key"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, 'Unauthorized', {
        error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
      }),
    );

    const result = await probeRemote(OPENAI_SPEC, ENDPOINT_OPENAI, 'sk-bad', fetchImpl);

    expect(result).toEqual({ ok: false, detail: 'unauthorized — check API key' });
  });

  it('a thrown fetch (connection refused) reports ok:false, never throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000'));

    const result = await probeRemote(OPENAI_SPEC, ENDPOINT_OPENAI, undefined, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });
});

// --- probeRemote: none -------------------------------------------------------

describe('probeRemote — none (§2.5, codestral: no unauthenticated probe)', () => {
  it('resolves ok:true with a fixed detail and makes NO network call', async () => {
    const fetchImpl = vi.fn();

    const result = await probeRemote(NONE_SPEC, 'https://codestral.mistral.ai', undefined, fetchImpl);

    expect(result).toEqual({ ok: true, detail: 'no probe for this backend' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// --- validateEndpointUrl -----------------------------------------------------

describe('validateEndpointUrl (reuses isHttpUrl discipline from src/shared/url.ts)', () => {
  it('accepts a well-formed http URL, returned WHATWG-canonical (trailing slash)', () => {
    expect(validateEndpointUrl('http://127.0.0.1:11434')).toEqual({ ok: true, url: 'http://127.0.0.1:11434/' });
  });

  it('accepts a well-formed https URL, returned WHATWG-canonical (trailing slash)', () => {
    expect(validateEndpointUrl('https://codestral.mistral.ai')).toEqual({
      ok: true,
      url: 'https://codestral.mistral.ai/',
    });
  });

  it('rejects a non-http(s) scheme', () => {
    const result = validateEndpointUrl('file:///etc/passwd');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBeTruthy();
  });

  it('rejects garbage / non-URLs', () => {
    const result = validateEndpointUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('normalizes a newline embedded in the input to the canonical URL (L1-I-1)', () => {
    // Local escape, no raw control char in source — the WHATWG parser strips
    // C0 controls (tab/CR/LF) from the input before serializing.
    const result = validateEndpointUrl('http://127.0.0.1\n:11434');
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:11434/' });
  });

  it('percent-encodes a bidi override character in the path rather than passing it through raw (L1-I-1)', () => {
    // Local escape (U+202E RIGHT-TO-LEFT OVERRIDE) — never a raw glyph in source.
    const bidi = String.fromCharCode(0x202e);
    const result = validateEndpointUrl(`http://127.0.0.1:11434/${bidi}evil`);
    expect(result.ok).toBe(true);
    const url = (result as { ok: true; url: string }).url;
    expect(url).toContain('%E2%80%AE');
    expect(url).not.toContain(bidi);
  });

  it('refuses a URL carrying embedded username:password@ userinfo (L1-I-1)', () => {
    const result = validateEndpointUrl('http://user:pass@127.0.0.1:11434');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBeTruthy();
  });

  it('refuses a bidi override character embedded in the host (WHATWG throws on parse) (L1-I-1)', () => {
    const bidi = String.fromCharCode(0x202e);
    const result = validateEndpointUrl(`http://exam${bidi}ple.com`);
    expect(result.ok).toBe(false);
  });

  it('refuses a non-http(s) scheme that is otherwise well-formed (L1-I-1)', () => {
    const result = validateEndpointUrl('ws://127.0.0.1:11434');
    expect(result.ok).toBe(false);
  });
});
