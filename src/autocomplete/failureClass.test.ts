import { describe, it, expect } from 'vitest';
import { classifyBackendFailure } from './failureClass';
import { BackendHttpError, BackendStreamError, StreamIdleTimeoutError, StreamByteCapError } from './backends/http';
import { InsecureTransportError } from './backends/secureTransport';
import { MissingApiKeyError } from './backends/CodestralFimBackend';
import { NextEditMintRejectionError } from './nextedit/scan';

/**
 * WS-F3 F3-7 (FI-13) — the DIRECT whole-mapping pin for the new shared
 * classifier. Ground-truthed against BOTH surfaces' CURRENT `instanceof`
 * ladders (`provider.ts`'s `surfaceCompletionFailure`, pre-this-task;
 * `nextedit/shell.vscode.ts`'s `surfaceTriggerFailure`, pre-this-task) —
 * every row below reproduces a real branch one or both surfaces already
 * take. The indirect goldens (`nextedit.golden.pure.test.ts`'s Part D,
 * `provider.test.ts`'s failure-surfacing suites) prove the two surfaces'
 * OUTPUT copy is unaffected by this task; this file proves the shared
 * function's own INPUT→`kind` mapping directly, one class at a time.
 */
describe('classifyBackendFailure (WS-F3 F3-7, FI-13) — the shared 9-member kind mapping', () => {
  it('InsecureTransportError -> insecure-transport', () => {
    expect(classifyBackendFailure(new InsecureTransportError('refusing http'))).toEqual({
      statusClass: 'insecure-transport',
      kind: 'insecure-transport',
    });
  });

  it('MissingApiKeyError -> missing-key (FIM-only today; next-edit never throws it)', () => {
    expect(classifyBackendFailure(new MissingApiKeyError('codestral requires an API key'))).toEqual({
      statusClass: 'missing-key',
      kind: 'missing-key',
    });
  });

  it('NextEditMintRejectionError -> mint (next-edit-only)', () => {
    expect(classifyBackendFailure(new NextEditMintRejectionError('secret'))).toEqual({
      statusClass: 'mint',
      kind: 'mint',
    });
  });

  it('BackendHttpError 404 -> model', () => {
    expect(classifyBackendFailure(new BackendHttpError('not found', 404, 'Not Found'))).toEqual({
      statusClass: 'model',
      kind: 'model',
    });
  });

  it('BackendHttpError 401 -> auth', () => {
    expect(classifyBackendFailure(new BackendHttpError('unauthorized', 401, 'Unauthorized'))).toEqual({
      statusClass: 'auth',
      kind: 'auth',
    });
  });

  it('BackendHttpError 403 -> auth (both 401 and 403 share the arm)', () => {
    expect(classifyBackendFailure(new BackendHttpError('forbidden', 403, 'Forbidden'))).toEqual({
      statusClass: 'auth',
      kind: 'auth',
    });
  });

  it('BackendHttpError 400 -> dialect', () => {
    expect(classifyBackendFailure(new BackendHttpError('bad request', 400, 'Bad Request'))).toEqual({
      statusClass: 'dialect',
      kind: 'dialect',
    });
  });

  it('BackendHttpError 500 (or any other status) -> http', () => {
    expect(classifyBackendFailure(new BackendHttpError('server error', 500, 'Internal Server Error'))).toEqual({
      statusClass: 'http',
      kind: 'http',
    });
  });

  it('BackendHttpError 501 -> http (the FIM-hint status; classification itself does not special-case it)', () => {
    expect(classifyBackendFailure(new BackendHttpError('not implemented', 501, 'Not Implemented'))).toEqual({
      statusClass: 'http',
      kind: 'http',
    });
  });

  it('BackendStreamError -> stream (a mid-stream SSE error frame — the ONLY class this kind covers)', () => {
    expect(classifyBackendFailure(new BackendStreamError('vLLM reported an error mid-stream'))).toEqual({
      statusClass: 'stream',
      kind: 'stream',
    });
  });

  it('StreamIdleTimeoutError -> unreachable, NOT stream (ground-truth: provider.test.ts pins this stays silent on FIM; folding it into stream would toast where today nothing does)', () => {
    expect(classifyBackendFailure(new StreamIdleTimeoutError())).toEqual({
      statusClass: 'unreachable',
      kind: 'unreachable',
    });
  });

  it('StreamByteCapError -> unreachable, NOT stream (same transport-hardening class as the idle timeout, not a backend-reported error)', () => {
    expect(classifyBackendFailure(new StreamByteCapError(4 * 1024 * 1024))).toEqual({
      statusClass: 'unreachable',
      kind: 'unreachable',
    });
  });

  it('a bare unrecognised Error -> unreachable', () => {
    expect(classifyBackendFailure(new Error('ECONNREFUSED'))).toEqual({
      statusClass: 'unreachable',
      kind: 'unreachable',
    });
  });

  it('a non-Error thrown value -> unreachable (never throws itself)', () => {
    expect(classifyBackendFailure('a string throw')).toEqual({ statusClass: 'unreachable', kind: 'unreachable' });
    expect(classifyBackendFailure(undefined)).toEqual({ statusClass: 'unreachable', kind: 'unreachable' });
  });
});
