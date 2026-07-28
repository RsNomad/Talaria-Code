import { describe, it, expect } from 'vitest';
import { httpFailureMessage } from './httpFailure';

/**
 * ARCH-2 (final-review remediation §4) — the ONE constructor for user-facing
 * HTTP failure strings. Invariant #3: operation + status + statusText ONLY,
 * never a response body, never a header, never a key.
 */
describe('httpFailureMessage', () => {
  it('formats op + status + statusText', () => {
    expect(httpFailureMessage('GET /api/skills', 500, 'Internal Server Error')).toBe(
      'GET /api/skills failed: 500 Internal Server Error',
    );
  });

  it('omits the trailing space when statusText is empty', () => {
    expect(httpFailureMessage('GET /x', 500, '')).toBe('GET /x failed: 500');
  });

  it('never includes anything beyond op/status/statusText — no way to smuggle a body through this constructor', () => {
    // The function signature itself has no body/header/key parameter; this
    // test documents that guarantee at the call surface: passing a
    // maliciously long statusText is the worst case, and it lands verbatim
    // (the caller's job to only ever pass the real statusText, never body
    // text, into this argument — this helper cannot silently swallow it).
    const msg = httpFailureMessage('PUT /x', 400, 'Bad Request');
    expect(msg).toBe('PUT /x failed: 400 Bad Request');
    expect(msg.split(':').length).toBeLessThanOrEqual(2); // "op failed" : " status statusText" — one colon only
  });
});
