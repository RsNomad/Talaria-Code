import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { describeError, isAuthRequiredError, redactHomePath } from './errorText';

/**
 * T1 (beta.5 setup-hardening, §2.3 B3 "[object Object]", killed at the
 * root) — the case table below is the RED-first spec for the shared,
 * webview-safe error-serialization module. `describeError`'s resolution
 * order is LOCKED by these tests: (1) `Error` -> `.message` (+ allowlisted
 * `.data` keys); (2) plain object with a string `.message` (the
 * `acp.js:886` raw JSON-RPC-error shape); (3) string/primitive -> `String`;
 * (4) else `JSON.stringify` capped at 300 chars, failure -> 'Unknown
 * error.'. Every branch's output passes through `redactHomePath`.
 *
 * `os.homedir()` is imported here ONLY (test file, never bundled into the
 * webview) to derive a real, environment-correct home path to assert
 * against — the module under test itself must stay Node-API-free so it
 * stays importable from `webview/src/` (precedent: `webview/src/protocol.ts:26-27`).
 */

describe('describeError', () => {
  it('Error -> .message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('Error with .data.details merges the allowlisted detail', () => {
    class DataError extends Error {
      code = -32603;
      data = { details: 'no pipx on PATH' };
    }
    expect(describeError(new DataError('Install failed'))).toBe(
      'Install failed (no pipx on PATH)',
    );
  });

  it('Error with .data.method merges the allowlisted method', () => {
    class MethodError extends Error {
      code = -32601;
      data = { method: 'setup.install' };
    }
    expect(describeError(new MethodError('Method not found'))).toBe(
      'Method not found (setup.install)',
    );
  });

  it('Error with both allowlisted data keys joins them', () => {
    class BothError extends Error {
      code = -32603;
      data = { details: 'timed out', method: 'setup.install' };
    }
    expect(describeError(new BothError('Internal error'))).toBe(
      'Internal error (timed out; setup.install)',
    );
  });

  it('Error .data keys NOT on the allowlist are ignored (no stack/trace leakage)', () => {
    class StrayError extends Error {
      code = -32603;
      data = { stack: 'at foo (bar.ts:1:1)', extra: 'ignore me' };
    }
    expect(describeError(new StrayError('Internal error'))).toBe('Internal error');
  });

  it('Error with non-object .data is ignored, not stringified', () => {
    class WeirdError extends Error {
      data = 'not-an-object';
    }
    expect(describeError(new WeirdError('boom'))).toBe('boom');
  });

  it('plain {code,message,data} (the acp.js:886 shape): authRequired, merged detail', () => {
    const err = { code: -32000, message: 'Authentication required', data: { details: 'no provider configured' } };
    expect(describeError(err)).toBe('Authentication required (no provider configured)');
    expect(isAuthRequiredError(err)).toBe(true);
  });

  it('plain {code,message,data} with a DIFFERENT code: isAuthRequiredError is false', () => {
    const err = { code: -32603, message: 'Internal error', data: { details: 'boom' } };
    expect(isAuthRequiredError(err)).toBe(false);
    expect(describeError(err)).toBe('Internal error (boom)');
  });

  it('plain object with string message and no data', () => {
    expect(describeError({ message: 'connection refused' })).toBe('connection refused');
  });

  it('object without a usable .message falls back to capped JSON', () => {
    const err = { code: 42, payload: 'x'.repeat(400) };
    const result = describeError(err);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result.startsWith('{"code":42,"payload":"xxx')).toBe(true);
    expect(result).not.toBe('[object Object]');
  });

  it('circular object -> "Unknown error." (JSON.stringify throws)', () => {
    const circular: Record<string, unknown> = { code: 1 };
    circular.self = circular;
    expect(describeError(circular)).toBe('Unknown error.');
  });

  it('string passes through unchanged', () => {
    expect(describeError('already a string')).toBe('already a string');
  });

  it('number passes through via String()', () => {
    expect(describeError(42)).toBe('42');
  });

  it('boolean passes through via String()', () => {
    expect(describeError(false)).toBe('false');
  });

  it('null passes through via String()', () => {
    expect(describeError(null)).toBe('null');
  });

  it('undefined passes through via String()', () => {
    expect(describeError(undefined)).toBe('undefined');
  });

  it('redacts the real home directory embedded in an Error message', () => {
    const home = homedir();
    const err = new Error(`spawn failed: ${home}/.local/bin/pipx not found`);
    expect(describeError(err)).toBe('spawn failed: ~/.local/bin/pipx not found');
  });

  it('global property: never returns the literal "[object Object]" for any object-shaped input', () => {
    const home = homedir();
    const shapes: unknown[] = [
      new Error('e'),
      { message: 'm' },
      { code: -32000, message: 'auth', data: { details: 'd' } },
      { code: 1, weird: true },
      { toString: () => '[object Object]' }, // adversarial: explicit toString override
      { nested: { deep: { value: home } } },
      [],
      [1, 2, 3],
      new Map([['a', 1]]),
      new Date(0),
    ];
    for (const shape of shapes) {
      expect(describeError(shape)).not.toBe('[object Object]');
    }
  });
});

describe('describeError — T8 folded hardening T1-M2: the JSON fallback redacts BEFORE the 300-char cap', () => {
  it('a home path straddling the char-300 boundary is fully redacted — no partial fragment survives the cut', () => {
    const home = '/home/alice';
    // `JSON.stringify({payload: …})` opens with the 12-char prefix
    // `{"payload":"`. pad=283 places the 11-char home path at raw-JSON
    // indices 295..305 — STRADDLING index 300. Under the buggy
    // slice-then-redact order, `slice(0, 300)` cuts mid-path and the
    // surviving fragment `/home` no longer matches the full home string,
    // so redaction misses it. Redact-then-slice collapses the whole path
    // to `~` first — nothing partial can ever survive the cap.
    const pad = 283;
    const err = { payload: 'A'.repeat(pad) + `${home}/x` };
    const result = describeError(err, home);
    expect(result).not.toContain('/home');
    expect(result).toContain('~/x');
    expect(result.length).toBeLessThanOrEqual(300);
  });
});

describe('errorText — T8 folded hardening S-3: host-threaded home makes redaction env-independent', () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  });
  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    else delete process.env.USERPROFILE;
  });

  it('redactHomePath(text, home) redacts with BOTH $HOME and %USERPROFILE% unset', () => {
    expect(redactHomePath('/home/alice/proj/a.py', '/home/alice')).toBe('~/proj/a.py');
  });

  it('describeError(err, home) redacts an Error message with $HOME unset (the host call-site contract)', () => {
    const err = new Error('spawn failed: /home/alice/.venvs/hermes/bin/hermes');
    expect(describeError(err, '/home/alice')).toBe('spawn failed: ~/.venvs/hermes/bin/hermes');
  });

  it('no-arg redactHomePath stays a harmless no-op when no env home exists (webview parity preserved)', () => {
    expect(redactHomePath('/home/alice/proj/a.py')).toBe('/home/alice/proj/a.py');
  });

  it('an explicit home param wins over the env home', () => {
    process.env.HOME = '/wrong/env/home';
    expect(redactHomePath('/home/alice/x and /wrong/env/home/y', '/home/alice')).toBe(
      '~/x and /wrong/env/home/y',
    );
  });
});

describe('isAuthRequiredError', () => {
  it('true only for JSON-RPC code -32000', () => {
    expect(isAuthRequiredError({ code: -32000, message: 'Authentication required' })).toBe(true);
  });

  it('false for -32603 (internal error)', () => {
    expect(isAuthRequiredError({ code: -32603, message: 'Internal error' })).toBe(false);
  });

  it('false for -32000 as a string, not a number (strict type check)', () => {
    expect(isAuthRequiredError({ code: '-32000', message: 'Authentication required' })).toBe(false);
  });

  it('false for a plain Error (no .code)', () => {
    expect(isAuthRequiredError(new Error('boom'))).toBe(false);
  });

  it('false for non-object input', () => {
    expect(isAuthRequiredError('boom')).toBe(false);
    expect(isAuthRequiredError(42)).toBe(false);
    expect(isAuthRequiredError(null)).toBe(false);
    expect(isAuthRequiredError(undefined)).toBe(false);
  });

  it('true when carried by an Error subclass with .code (RequestError shape)', () => {
    class RequestErrorLike extends Error {
      code = -32000;
    }
    expect(isAuthRequiredError(new RequestErrorLike('Authentication required'))).toBe(true);
  });
});

describe('redactHomePath', () => {
  it('replaces the real home directory with ~', () => {
    const home = homedir();
    expect(redactHomePath(`${home}/project/file.py`)).toBe('~/project/file.py');
  });

  it('replaces every occurrence of the home directory', () => {
    const home = homedir();
    expect(redactHomePath(`${home}/a and again ${home}/b`)).toBe('~/a and again ~/b');
  });

  it('leaves text with no home-dir substring unchanged', () => {
    expect(redactHomePath('no path in here')).toBe('no path in here');
  });

  it('leaves an empty string unchanged', () => {
    expect(redactHomePath('')).toBe('');
  });
});
