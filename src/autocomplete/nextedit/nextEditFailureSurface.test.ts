import { describe, it, expect, vi } from 'vitest';

// `nextEditFailureSurface.ts` imports `endpointLabel` (a runtime value) from
// `./nextEditRoute`, which itself imports `readNextEditConfig` from
// `./config` — a real `vscode.workspace.getConfiguration` reader
// (`nextEditRoute.test.ts` mocks the same module for the identical reason).
// This file never calls `resolveRoute`/`readNextEditConfig` at all, so the
// stub's shape is irrelevant — it exists only so importing the chain above
// never pulls the real `vscode` module into a file that has no other need
// of it.
vi.mock('./config', () => ({
  readNextEditConfig: () => ({ backend: 'ollama', endpoint: '', model: '' }),
}));

import { describeTriggerFailure } from './nextEditFailureSurface';
import { BackendHttpError, StreamIdleTimeoutError, StreamByteCapError, BackendStreamError } from '../backends/http';
import { InsecureTransportError } from '../backends/secureTransport';
import { MissingApiKeyError } from '../backends/CodestralFimBackend';
import { NextEditMintRejectionError } from './scan';
import { sweepV2Format } from './formats/sweepV2';
import type { NextEditRoute } from './nextEditRoute';

/**
 * WS-F3 F3-7 (FI-13) — the DIRECT pin for the newly-exported
 * `describeTriggerFailure`, mirroring `nextEditRoute.test.ts`'s/
 * `nextEditEgress.test.ts`'s precedent for a symbol F3-7 newly exports.
 * `nextedit.golden.pure.test.ts`'s Part D already proves the shell's OUTPUT
 * (toast text) is unaffected end-to-end — this file additionally proves the
 * two facts that golden cannot see through the shell's private dedup:
 * (1) the exact `key`/`channel` shape this function hands its caller
 * (`shell.vscode.ts`'s thin `surfaceTriggerFailure`), and (2) that
 * `missing-key`/`stream` — kinds next-edit never surfaced distinctly before
 * this task — now reach `describeTriggerFailure` at all and fall through to
 * the byte-identical `unreachable` copy, not merely "whatever the fallback
 * happened to produce".
 */
function makeRoute(): NextEditRoute {
  return {
    format: sweepV2Format,
    transport: 'ollama',
    apiBase: 'http://example.test:8000',
    model: 'qwen2.5-coder:7b',
    remote: false,
  };
}

describe('describeTriggerFailure (WS-F3 F3-7, FI-13) — pure copy builder', () => {
  it('InsecureTransportError -> toast, byte-exact copy, never echoes the throw site', () => {
    const result = describeTriggerFailure(
      new InsecureTransportError('CWE-319: refusing http://example.test'),
      makeRoute(),
      'next',
    );
    expect(result).toEqual({
      key: 'ollama|example.test:8000|insecure-transport',
      message:
        'Next Edit is paused: refusing to send credentials over cleartext HTTP to a remote host. Use https, or point the endpoint at a loopback address (127.0.0.1/localhost).',
      channel: 'toast',
    });
  });

  it('BackendHttpError 404 -> toast, names the model + the mode-specific model setting ("next" mode)', () => {
    const result = describeTriggerFailure(
      new BackendHttpError('not found', 404, 'Not Found'),
      makeRoute(),
      'next',
    );
    expect(result).toEqual({
      key: 'ollama|example.test:8000|model',
      message:
        'Next Edit is paused: the ollama server at example.test:8000 does not serve the model "qwen2.5-coder:7b" (404). Check "talaria.nextEdit.model".',
      channel: 'toast',
    });
  });

  it('BackendHttpError 404 -> the endpoint/model setting names change under "generic" mode', () => {
    const result = describeTriggerFailure(
      new BackendHttpError('not found', 404, 'Not Found'),
      makeRoute(),
      'generic',
    );
    expect(result.message).toContain('Check "talaria.autocomplete.model".');
  });

  it('BackendHttpError 401 -> toast, auth copy naming the endpoint setting', () => {
    const result = describeTriggerFailure(
      new BackendHttpError('unauthorized', 401, 'Unauthorized'),
      makeRoute(),
      'next',
    );
    expect(result).toEqual({
      key: 'ollama|example.test:8000|auth',
      message:
        'Next Edit is paused: the ollama server at example.test:8000 rejected the request (401 Unauthorized). Check that "talaria.nextEdit.endpoint" points at a server this machine is authorized to use.',
      channel: 'toast',
    });
  });

  it('BackendHttpError 403 -> toast, same auth arm as 401', () => {
    const result = describeTriggerFailure(
      new BackendHttpError('forbidden', 403, 'Forbidden'),
      makeRoute(),
      'next',
    );
    expect(result.key).toBe('ollama|example.test:8000|auth');
    expect(result.message).toContain('403 Forbidden');
  });

  it('BackendHttpError 400 -> toast, dialect/context-length copy', () => {
    const result = describeTriggerFailure(
      new BackendHttpError('bad request', 400, 'Bad Request'),
      makeRoute(),
      'next',
    );
    expect(result).toEqual({
      key: 'ollama|example.test:8000|dialect',
      message:
        "Next Edit is paused: the server at example.test:8000 rejected the request (400 Bad Request). This usually means the configured transport doesn't match the server's API dialect — it can also mean the prompt exceeded the server's context length.",
      channel: 'toast',
    });
  });

  it('BackendHttpError other status -> toast, generic HTTP copy', () => {
    const result = describeTriggerFailure(
      new BackendHttpError('server error', 500, 'Internal Server Error'),
      makeRoute(),
      'next',
    );
    expect(result).toEqual({
      key: 'ollama|example.test:8000|http',
      message: 'Next Edit is paused: the ollama server at example.test:8000 returned 500 Internal Server Error. Check "talaria.nextEdit.endpoint".',
      channel: 'toast',
    });
  });

  it('NextEditMintRejectionError -> log channel ONLY, ruleId-keyed dedup, never a toast, never the matched content', () => {
    const result = describeTriggerFailure(new NextEditMintRejectionError('secret'), makeRoute(), 'next');
    expect(result).toEqual({
      key: 'ollama|example.test:8000|mint|secret',
      message: 'Next Edit skipped for this file: its content cannot be sent safely (rule: secret). No request was sent.',
      channel: 'log',
    });
  });

  it('a DIFFERENT ruleId produces a DIFFERENT mint key (independent per-rule dedup)', () => {
    const result = describeTriggerFailure(new NextEditMintRejectionError('oversize'), makeRoute(), 'next');
    expect(result.key).toBe('ollama|example.test:8000|mint|oversize');
  });

  it('MissingApiKeyError -> the SAME unreachable copy as the generic fallback (FI-13: next-edit never surfaced this distinctly)', () => {
    const missingKey = describeTriggerFailure(
      new MissingApiKeyError('codestral requires an API key'),
      makeRoute(),
      'next',
    );
    const fallback = describeTriggerFailure(new Error('ECONNREFUSED'), makeRoute(), 'next');
    expect(missingKey).toEqual(fallback);
    expect(missingKey.channel).toBe('toast');
  });

  it('BackendStreamError -> the SAME unreachable copy as the generic fallback (FI-13: next-edit had no stream arm before this task)', () => {
    const stream = describeTriggerFailure(
      new BackendStreamError('vLLM reported an error mid-stream'),
      makeRoute(),
      'next',
    );
    const fallback = describeTriggerFailure(new Error('ECONNREFUSED'), makeRoute(), 'next');
    expect(stream).toEqual(fallback);
  });

  it('StreamIdleTimeoutError (R1-7) falls into the unreachable fallback — never misdiagnosed as a mint rejection', () => {
    const result = describeTriggerFailure(new StreamIdleTimeoutError(), makeRoute(), 'next');
    expect(result).toEqual({
      key: 'ollama|example.test:8000|unreachable',
      message:
        'Next Edit is paused: the request to the ollama server at example.test:8000 failed. Check "talaria.nextEdit.endpoint", and that the server is running.',
      channel: 'toast',
    });
  });

  it('StreamByteCapError also falls into the unreachable fallback', () => {
    const result = describeTriggerFailure(new StreamByteCapError(4 * 1024 * 1024), makeRoute(), 'next');
    expect(result.key).toBe('ollama|example.test:8000|unreachable');
    expect(result.channel).toBe('toast');
  });

  it('a bare unrecognised Error falls into the same unreachable fallback', () => {
    const result = describeTriggerFailure(new Error('ECONNREFUSED'), makeRoute(), 'next');
    expect(result).toEqual({
      key: 'ollama|example.test:8000|unreachable',
      message:
        'Next Edit is paused: the request to the ollama server at example.test:8000 failed. Check "talaria.nextEdit.endpoint", and that the server is running.',
      channel: 'toast',
    });
  });

  it('the endpoint setting in the unreachable copy also honours mode', () => {
    const result = describeTriggerFailure(new Error('ECONNREFUSED'), makeRoute(), 'generic');
    expect(result.message).toContain('Check "talaria.autocomplete.endpoint"');
  });
});
