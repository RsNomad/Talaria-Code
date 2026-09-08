/**
 * httpStream.parity.lock.test.ts — FI-11 (WS-F8 F8-2, ADR-025-AI).
 *
 * `ggufIngest.ts` is a FROZEN file (ADR-FSU-02): it is never edited by this
 * refactor wave and keeps its OWN module-private copies of `StreamReadResult`
 * / `readWithAbort` / `abortError` / `joinUrl` (`:676/:683/:707/:719`),
 * rather than importing the shared `httpStream.ts` this task extracts from
 * `ollamaClient.ts`. That is a deliberate zero-touch choice, not an
 * oversight — but it means a future edit to the SHARED copies in
 * `httpStream.ts` could silently drift away from the frozen twins with
 * nothing to notice, the same "first fix lands in one place, not both"
 * failure `lineSplitDrift.lock.test.ts`/`diffEgressDrift.lock.test.ts` exist
 * to catch elsewhere in this codebase.
 *
 * MECHANISM (same STABLE-TEXT-MARKER extraction `secretPaths.freeze.test.ts`
 * uses, generalized to compare two live files instead of one file against a
 * pinned hash): each of the four symbols is extracted from BOTH
 * `httpStream.ts` and the frozen `ggufIngest.ts` by literal marker, the
 * shared side's leading `export ` token is stripped (the ONLY sanctioned
 * difference — `httpStream.ts` exports these for `ollamaClient.ts`/
 * `remoteProbe.ts` to import; the frozen twins are module-private), and the
 * two spans are asserted textually IDENTICAL. Doc comments are excluded by
 * construction (the markers start at the `type`/`function` keyword, never
 * above it), so this lock cares only about the code, not its surrounding
 * prose.
 *
 * `readBodyBounded` has NO frozen twin in scope: `hfDigest.ts`'s
 * `readTreeBodyBounded` differs BY DESIGN (its own reason strings, no
 * `label` param, a different byte cap) and is deliberately excluded from
 * this lock, not force-parity'd — see the dedicated test below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HTTP_STREAM_PATH = join(__dirname, 'httpStream.ts');
const GGUF_INGEST_PATH = join(__dirname, 'ggufIngest.ts');
const HF_DIGEST_PATH = join(__dirname, 'hfDigest.ts');

/**
 * Extracts the source span from `start` (a literal marker, matched via
 * `indexOf` so a doc comment mentioning the same words can never match
 * instead of the real declaration) through the first `close` marker found
 * AFTER it, inclusive of `close` itself.
 */
function extractSpan(source: string, start: string, close: string): string {
  const startIdx = source.indexOf(start);
  if (startIdx === -1) {
    throw new Error(`marker ${JSON.stringify(start)} not found — has the symbol been renamed or removed?`);
  }
  const closeIdx = source.indexOf(close, startIdx);
  if (closeIdx === -1) {
    throw new Error(`no closing marker ${JSON.stringify(close)} found after ${JSON.stringify(start)}`);
  }
  return source.slice(startIdx, closeIdx + close.length);
}

/** Strips a leading `export ` token — the ONE sanctioned difference between
 *  `httpStream.ts`'s exported primitives and `ggufIngest.ts`'s module-private
 *  twins. Every other byte must still match, including whitespace, so a
 *  genuine drift is still caught. */
function stripExport(span: string): string {
  return span.startsWith('export ') ? span.slice('export '.length) : span;
}

/** The four twins this lock covers, keyed by the frozen (non-exported)
 *  marker text — the shared side's marker is derived by prefixing `export `. */
const SYMBOLS: ReadonlyArray<{ name: string; start: string; close: string }> = [
  { name: 'StreamReadResult', start: 'type StreamReadResult =', close: ';\n' },
  { name: 'readWithAbort', start: 'function readWithAbort(reader:', close: '\n}\n' },
  { name: 'abortError', start: 'function abortError():', close: '\n}\n' },
  { name: 'joinUrl', start: 'function joinUrl(base:', close: '\n}\n' },
];

const httpStreamSource = readFileSync(HTTP_STREAM_PATH, 'utf-8');
const ggufIngestSource = readFileSync(GGUF_INGEST_PATH, 'utf-8');

describe('httpStream.ts — parity lock vs the frozen ggufIngest.ts twins (FI-11, ADR-025-AI)', () => {
  it.each(SYMBOLS)(
    '$name is textually identical (normalized) between httpStream.ts and the frozen ggufIngest.ts',
    ({ start, close }) => {
      const sharedSpan = stripExport(extractSpan(httpStreamSource, `export ${start}`, close));
      const frozenSpan = extractSpan(ggufIngestSource, start, close);
      expect(sharedSpan).toBe(frozenSpan);
    },
  );

  it('sanity: the extracted readWithAbort span really is the function (signature through its own closing brace, nothing more)', () => {
    const sharedSpan = stripExport(
      extractSpan(httpStreamSource, 'export function readWithAbort(reader:', '\n}\n'),
    );
    expect(sharedSpan.startsWith('function readWithAbort(reader:')).toBe(true);
    expect(sharedSpan.endsWith('\n}\n')).toBe(true);
    expect(sharedSpan).toContain('signal.addEventListener');
    // Must stop at readWithAbort's OWN closing brace — the next declaration
    // (readBodyBounded) must never be swallowed into the extracted span.
    expect(sharedSpan).not.toContain('readBodyBounded');
  });

  /**
   * RED-first proof (non-vacuity, same discipline `secretPaths.freeze.test.ts`
   * uses): a planted one-token divergence in the EXTRACTED span must stop
   * matching the frozen twin — demonstrating this lock would actually catch
   * real drift, not just always pass by construction.
   */
  it('RED-first proof: a planted one-token divergence in readWithAbort is caught (the lock is non-vacuous)', () => {
    const sharedSpan = stripExport(
      extractSpan(httpStreamSource, 'export function readWithAbort(reader:', '\n}\n'),
    );
    const frozenSpan = extractSpan(ggufIngestSource, 'function readWithAbort(reader:', '\n}\n');
    expect(sharedSpan).toBe(frozenSpan); // sanity: they agree before the plant

    const mutated = sharedSpan.replace('onAbort', 'onAbortX');
    expect(mutated).not.toBe(sharedSpan); // sanity: the replace actually changed something
    expect(mutated).not.toBe(frozenSpan);
  });

  it(
    "accepted divergence: hfDigest.ts's readTreeBodyBounded differs from readBodyBounded BY DESIGN " +
      '(excluded from this lock, not force-parity’d)',
    () => {
      const hfDigestSource = readFileSync(HF_DIGEST_PATH, 'utf-8');
      const sharedSpan = extractSpan(
        httpStreamSource,
        'export async function readBodyBounded(response: Response, maxBytes: number, label: string)',
        '\n}\n',
      );
      const frozenSpan = extractSpan(hfDigestSource, 'async function readTreeBodyBounded(', '\n}\n');

      expect(sharedSpan).not.toBe(frozenSpan);
      // The frozen twin carries no `label` param and its own reason strings
      // — this lock makes no parity claim over it (see this file's header).
      expect(frozenSpan).not.toContain('label');
      expect(frozenSpan).toContain('tree API');
    },
  );
});
