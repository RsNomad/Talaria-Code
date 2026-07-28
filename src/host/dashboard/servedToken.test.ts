import { describe, it, expect } from 'vitest';
import { extractInjectedDashboardToken, isForeignBackendToken } from './servedToken';

/**
 * Pure-logic contract tests (S3, CWE-306/346) mirroring Hermes desktop's
 * `apps/desktop/electron/dashboard-token.cjs` (`extractInjectedDashboardToken` +
 * `isForeignBackendToken`). No vscode/fs/network — the module and these tests are
 * headless string logic only.
 */

describe('extractInjectedDashboardToken', () => {
  it('extracts the token from a served window.__HERMES_SESSION_TOKEN__ assignment', () => {
    const html = '<script>window.__HERMES_SESSION_TOKEN__="abc123";</script>';
    expect(extractInjectedDashboardToken(html)).toBe('abc123');
  });

  it('returns null when the marker is absent', () => {
    const html = '<html><body>no token here</body></html>';
    expect(extractInjectedDashboardToken(html)).toBeNull();
  });

  it('returns null on malformed JSON inside the assignment (regex matches, JSON.parse throws)', () => {
    // `\x41` is a valid JS-string escape (matched by the mirrored regex's `\\.`
    // alternative) but NOT a valid JSON escape, so JSON.parse throws.
    const html = 'window.__HERMES_SESSION_TOKEN__="\\x41";';
    expect(extractInjectedDashboardToken(html)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractInjectedDashboardToken('')).toBeNull();
  });

  it('returns null when the assigned value parses but is an empty string', () => {
    const html = 'window.__HERMES_SESSION_TOKEN__="";';
    expect(extractInjectedDashboardToken(html)).toBeNull();
  });
});

describe('isForeignBackendToken — provenance rule (mirrors dashboard-token.cjs)', () => {
  it('served === spawn → ours, not foreign', () => {
    expect(
      isForeignBackendToken({ servedToken: 'tok', spawnToken: 'tok', childAlive: true }),
    ).toBe(false);
    expect(
      isForeignBackendToken({ servedToken: 'tok', spawnToken: 'tok', childAlive: false }),
    ).toBe(false);
  });

  it('served !== spawn AND child ALIVE → benign regeneration, not foreign', () => {
    expect(
      isForeignBackendToken({ servedToken: 'other', spawnToken: 'tok', childAlive: true }),
    ).toBe(false);
  });

  it('served !== spawn AND child DEAD → FOREIGN', () => {
    expect(
      isForeignBackendToken({ servedToken: 'other', spawnToken: 'tok', childAlive: false }),
    ).toBe(true);
  });

  it('null served token: FOREIGN iff the child is DEAD (a process we did not spawn answered while our child failed to bind)', () => {
    // Headless `hermes serve` (what we spawn) never emits the __HERMES_SESSION_TOKEN__
    // marker, so `null` is the NORMAL served value for our OWN healthy child. The
    // discriminator is therefore liveness: a null served token with our child ALIVE
    // is our own child (accept); a null served token with our child DEAD means a
    // squatter that held the port answered the health probe (refuse). This is a
    // DELIBERATE divergence from the reference (which coalesces null→spawnToken and
    // so can never catch a no-marker squatter) — do NOT re-add a `Boolean(served)`
    // guard here, it reintroduces the CWE-306/346 fail-open.
    expect(
      isForeignBackendToken({ servedToken: null, spawnToken: 'tok', childAlive: false }),
    ).toBe(true);
    expect(
      isForeignBackendToken({ servedToken: null, spawnToken: 'tok', childAlive: true }),
    ).toBe(false);
  });
});
