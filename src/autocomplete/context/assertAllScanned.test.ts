import { describe, it, expect, vi } from 'vitest';
import { assertAllScanned } from './assertAllScanned';
import { scanSnippetForSecrets } from './secretScanner';
import { scannedSnippetForTest } from './scannedSnippetTestFactory';
import type { ScannedSnippet } from './types';

/**
 * Same fail-closed-mock pattern as `ringBuffer.test.ts` (W2-F1-style): wrap
 * the REAL scanner in a `vi.fn` so one test can override it once
 * (`mockImplementationOnce`) to simulate a throw, while every other test in
 * this file exercises the real scanner end to end.
 */
vi.mock('./secretScanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secretScanner')>();
  return { ...actual, scanSnippetForSecrets: vi.fn(actual.scanSnippetForSecrets) };
});

/**
 * §3.2 — the wire-adjacent `assertAllScanned` egress backstop (ratified W5
 * critic-pin B1: `docs/research/_critic-pins.md`, `docs/research/wave-5/
 * 00-architecture-and-paths.md` §3.2 "Wire-adjacent backstop"). Recovered
 * from `final-3way-arch.md` finding I-5, which flags it as the ONLY layer
 * that catches "cast-free `any`-laundering" — a snippet that reaches
 * `FimContext.snippets` without ever passing through `ringBuffer.ingest`'s
 * `scanSnippetForSecrets` choke point.
 *
 * These tests use the SANCTIONED test-only factory (`scannedSnippetForTest`)
 * to build exactly that scenario: a `ScannedSnippet`-typed value that never
 * actually passed a scan — i.e. the "bypassed the choke-point" case, which
 * in production could only arise via an unsafe cast/`@ts-expect-error`/
 * `any`-typed seam (this factory is that same sanctioned mint site, reused
 * here as the test-only stand-in for a real forgery — see W5-T0's
 * `scannedSnippetTestFactory.ts` header comment). No fixture below is a real
 * secret value — same PEM/AKIA/generic-conjunction fixtures already used
 * throughout `secretScanner.test.ts`/`ringBuffer.test.ts`.
 */
function scanned(overrides: Partial<Parameters<typeof scannedSnippetForTest>[0]> = {}): ScannedSnippet {
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

describe('assertAllScanned — no-op on the legitimate/clean path', () => {
  it('is a silent no-op for an empty snippet array', () => {
    expect(() => assertAllScanned([])).not.toThrow();
  });

  it('is a silent no-op when every snippet re-scans clean', () => {
    const snippets = [
      scanned({ content: 'const a = 1;' }),
      scanned({ filepath: 'b.ts', content: 'const b = 2;' }),
    ];
    expect(() => assertAllScanned(snippets)).not.toThrow();
  });
});

describe('assertAllScanned — fail-closed on a forged/bypassed snippet (RED-first: the choke-point-skip scenario)', () => {
  it('throws when a snippet in the array would fail a re-scan (PEM header, provider detector)', () => {
    const snippets = [scanned({ content: '-----BEGIN PRIVATE KEY-----' })];
    expect(() => assertAllScanned(snippets)).toThrow(/ruleId=pem/);
  });

  it('throws when a snippet would fail the path layer on re-scan', () => {
    const snippets = [scanned({ filepath: '.env', content: 'harmless on its own' })];
    expect(() => assertAllScanned(snippets)).toThrow(/ruleId=path/);
  });

  it('throws when a snippet would fail the generic conjunction rule on re-scan', () => {
    // Same 32-char high-entropy fixture used throughout secretScanner.test.ts.
    const HIGH_ENTROPY_32 = 'aB3xQ9zM1kP7wRtY0sLf8nJc2hV5dGq1';
    const snippets = [scanned({ content: `const api_key = "${HIGH_ENTROPY_32}";` })];
    expect(() => assertAllScanned(snippets)).toThrow(/ruleId=generic/);
  });

  it('throws on the FIRST offending snippet — one bad snippet fails the whole batch (fails toward LESS egress)', () => {
    const snippets = [
      scanned({ filepath: 'a.ts', content: 'const a = 1;' }),
      scanned({ filepath: 'b.ts', content: '-----BEGIN PRIVATE KEY-----' }),
      scanned({ filepath: 'c.ts', content: 'const c = 3;' }),
    ];
    expect(() => assertAllScanned(snippets)).toThrow();
  });

  it('never includes the matched secret text in the thrown message (ruleId-only contract, mirrors SecretScanVerdict)', () => {
    const secretValue = 'aB3xQ9zM1kP7wRtY0sLf8nJc2hV5dGq1';
    const snippets = [scanned({ content: `const api_key = "${secretValue}";` })];

    let thrown: unknown;
    try {
      assertAllScanned(snippets);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(secretValue);
    expect(message).toMatch(/ruleId=generic/);
  });
});

describe('assertAllScanned — scanner-throw is ALSO fail-closed (mirrors ringBuffer.ingest\'s throw-is-reject)', () => {
  it('treats a scanSnippetForSecrets throw as reject, not as pass-through', () => {
    vi.mocked(scanSnippetForSecrets).mockImplementationOnce(() => {
      throw new Error('scanner exploded');
    });

    const snippets = [scanned({ content: 'anything at all' })];
    expect(() => assertAllScanned(snippets)).toThrow();
  });
});
