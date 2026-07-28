import { describe, it, expect } from 'vitest';
import {
  assertSecureAuthTransport,
  isLoopbackHost,
  InsecureTransportError,
} from './secureTransport';

describe('assertSecureAuthTransport (S4.2, CWE-319)', () => {
  it('throws when an apiKey is set and the endpoint is http to a remote host', () => {
    expect(() =>
      assertSecureAuthTransport('http://example.com:8000/v1/completions', true),
    ).toThrow(/cleartext/i);
  });

  it('throws an InsecureTransportError (A1 — required for A5 catch-site narrowing) with the byte-identical message text', () => {
    let caught: unknown;
    try {
      assertSecureAuthTransport('http://remote-host:8000/v1/completions', true);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InsecureTransportError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Refusing to send the autocomplete API key over cleartext http to a remote host (CWE-319). Use https, or a loopback endpoint.',
    );
  });

  it('allows http to 127.0.0.1/localhost/::1 with an apiKey (loopback carve-out)', () => {
    expect(() =>
      assertSecureAuthTransport('http://127.0.0.1:11434/v1/completions', true),
    ).not.toThrow();
    expect(() =>
      assertSecureAuthTransport('http://localhost:11434/v1/completions', true),
    ).not.toThrow();
    expect(() =>
      assertSecureAuthTransport('http://[::1]:11434/v1/completions', true),
    ).not.toThrow();
  });

  it('allows https to any host with an apiKey', () => {
    expect(() =>
      assertSecureAuthTransport('https://codestral.mistral.ai/v1/fim/completions', true),
    ).not.toThrow();
    expect(() =>
      assertSecureAuthTransport('https://example.com/v1/completions', true),
    ).not.toThrow();
  });

  it('allows http remote with NO apiKey (default Ollama path unaffected)', () => {
    expect(() =>
      assertSecureAuthTransport('http://example.com:8000/v1/completions', false),
    ).not.toThrow();
    expect(() =>
      assertSecureAuthTransport('http://127.0.0.1:11434/api/generate', false),
    ).not.toThrow();
  });
});

describe('security M-3 property lock: the thrown message never carries caller input', () => {
  it('an adversarial userinfo/query URL leaves NO fragment in the message (it reaches the output channel via provider.ts:405)', () => {
    const rawUrl = 'http://alice:sk-SECRET_KEY_MARKER@gpu.internal:8000/v1?key=leak';
    let caught: unknown;
    try {
      assertSecureAuthTransport(rawUrl, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsecureTransportError);
    const message = (caught as Error).message;
    for (const fragment of [rawUrl, 'gpu.internal', 'alice', 'sk-SECRET_KEY_MARKER', 'key=leak', '8000']) {
      expect(message).not.toContain(fragment);
    }
  });
});

describe('isLoopbackHost (shared single source of truth, reused by S4.3)', () => {
  it('recognizes 127.0.0.1, localhost, ::1, and [::1] as loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('does not classify a remote hostname as loopback', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });
});
