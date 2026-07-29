import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RingBuffer } from './ringBuffer';
import { scanSnippetForSecrets } from './secretScanner';
import { collectNonTestTsSources } from '../../host/purityScan';
import type { IngestCandidate } from './ringBuffer';
import type { Anchor } from './types';
import type { ScannableSource } from '../../host/purityScan';

/**
 * W2-F1-style fail-closed mock: wrap the REAL scanner in a `vi.fn` so a
 * single test can override it once (`mockImplementationOnce`) to simulate a
 * throw, while every other test in this file exercises the real scanner end
 * to end. Deliberately no import-failure fallback — if `./secretScanner`
 * ever failed to import, the suite must fail loudly, not silently swap in a
 * hand-rolled stand-in that could drift from the real detector.
 */
vi.mock('./secretScanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secretScanner')>();
  return { ...actual, scanSnippetForSecrets: vi.fn(actual.scanSnippetForSecrets) };
});

const DEFAULT_ANCHOR: Anchor = { uri: 'file:///cursor.ts', line: 0 };
const ACTIVE_URI = 'file:///active.ts';

function candidate(overrides: Partial<IngestCandidate> = {}): IngestCandidate {
  return {
    uri: 'file:///default.ts',
    filepath: 'default.ts',
    content: 'const a = 1;',
    kind: 'recently-edited',
    startLine: 0,
    endLine: 0,
    anchor: DEFAULT_ANCHOR,
    ...overrides,
  };
}

describe('RingBuffer.ingest — stale-anchor drop', () => {
  it('drops a candidate whose anchor no longer matches the current anchor', () => {
    const rb = new RingBuffer();

    rb.ingest(
      candidate({ anchor: { uri: 'file:///old.ts', line: 5 } }),
      ACTIVE_URI,
      { uri: 'file:///new.ts', line: 10 },
    );

    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });

  it('accepts a candidate whose anchor matches the current anchor exactly', () => {
    const rb = new RingBuffer();

    rb.ingest(candidate({ anchor: DEFAULT_ANCHOR }), ACTIVE_URI, DEFAULT_ANCHOR);

    expect(rb.allScanned()).toHaveLength(1);
  });
});

describe('RingBuffer.ingest — active-document drop', () => {
  it('drops a candidate whose uri equals the active document', () => {
    const rb = new RingBuffer();

    rb.ingest(candidate({ uri: ACTIVE_URI }), ACTIVE_URI, DEFAULT_ANCHOR);

    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });
});

describe('RingBuffer.ingest — path hygiene', () => {
  it('normalizes backslash path separators to POSIX at ingest', () => {
    const rb = new RingBuffer();

    rb.ingest(candidate({ filepath: 'src\\nested\\file.ts' }), ACTIVE_URI, DEFAULT_ANCHOR);

    expect(rb.allScanned()[0]?.filepath).toBe('src/nested/file.ts');
  });
});

describe('RingBuffer.ingest — quarantine (strict, uri-scoped, fail-closed — §3.3 item 4 / P7)', () => {
  it('quarantines the uri on a secret verdict, and drops ALL later candidates from that uri (canonical split-secret case)', () => {
    const rb = new RingBuffer();
    const secretUri = 'file:///secret.env';

    // Window 1: carries a PEM header -> rejected, uri quarantined.
    rb.ingest(
      candidate({
        uri: secretUri,
        filepath: 'secret.env',
        content: '-----BEGIN PRIVATE KEY-----',
        startLine: 0,
        endLine: 0,
      }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);

    // Window 2: SAME uri, a DIFFERENT window, content that is INNOCUOUS on
    // its own — a per-window scanner would let this through (the exact
    // split-secret bypass §3.3 item 4 closes). It must still be dropped
    // because the uri itself is quarantined.
    rb.ingest(
      candidate({
        uri: secretUri,
        filepath: 'secret.env',
        content: 'totally innocuous body text, no secret here',
        startLine: 1,
        endLine: 1,
      }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });

  it('does NOT auto-clear when the offending window itself is resubmitted edited-clean — no window content lifts the quarantine', () => {
    const rb = new RingBuffer();
    const uri = 'file:///was-secret.env';

    rb.ingest(
      candidate({ uri, filepath: 'was-secret.env', content: 'AKIAABCDEFGHIJKLMNOP', startLine: 0, endLine: 0 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);

    // The EXACT offending window, resubmitted with edited, individually
    // clean content. Under the strict design this must NOT clear the
    // quarantine — no window's content is ever a "the file changed" signal;
    // only an explicit clearQuarantine(uri) call is.
    rb.ingest(
      candidate({
        uri,
        filepath: 'was-secret.env',
        content: 'clean content now, nothing sensitive',
        startLine: 0,
        endLine: 0,
      }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });

  it('the clear-then-resubmit sibling window closure: an edited-clean offending window does NOT re-expose a sibling secret window (Opus count=2 leak)', () => {
    const rb = new RingBuffer();
    const uri = 'file:///split-secret.env';

    // Header window: rejects, quarantines the uri.
    rb.ingest(
      candidate({ uri, filepath: 'split-secret.env', content: '-----BEGIN PRIVATE KEY-----', startLine: 0, endLine: 0 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);

    // Sibling window (different lines), individually innocuous — dropped
    // because the uri is quarantined.
    rb.ingest(
      candidate({ uri, filepath: 'split-secret.env', content: 'base64-body-fragment-one', startLine: 5, endLine: 5 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);

    // The header window is resubmitted, edited clean.
    rb.ingest(
      candidate({ uri, filepath: 'split-secret.env', content: 'header now clean', startLine: 0, endLine: 0 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]); // must NOT auto-clear

    // The sibling window resubmitted, UNCHANGED — under the OLD flawed
    // window-scoped design this would now be accepted (the count=2 leak
    // Opus verified). Under the strict design it MUST still drop: only
    // clearQuarantine(uri) lifts the quarantine.
    rb.ingest(
      candidate({ uri, filepath: 'split-secret.env', content: 'base64-body-fragment-one', startLine: 5, endLine: 5 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });

  it('clearQuarantine(uri) re-enables ingestion of a clean window from that uri', () => {
    const rb = new RingBuffer();
    const uri = 'file:///was-secret-2.env';

    rb.ingest(
      candidate({ uri, filepath: 'was-secret-2.env', content: 'AKIAABCDEFGHIJKLMNOP', startLine: 0, endLine: 0 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);

    rb.clearQuarantine(uri);

    rb.ingest(
      candidate({
        uri,
        filepath: 'was-secret-2.env',
        content: 'clean content, nothing sensitive',
        startLine: 0,
        endLine: 0,
      }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toHaveLength(1);
    expect(rb.allScanned()[0]?.content).toBe('clean content, nothing sensitive');
    expect(rb.currentEpoch()).toBe(1);
  });

  it('a still-secret file re-quarantines after clearQuarantine(uri) — the clear grants no amnesty beyond "scan again"', () => {
    const rb = new RingBuffer();
    const uri = 'file:///still-secret.env';

    rb.ingest(
      candidate({ uri, filepath: 'still-secret.env', content: '-----BEGIN PRIVATE KEY-----', startLine: 0, endLine: 0 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);

    rb.clearQuarantine(uri);

    // Still secret on re-ingest -> rejects again, re-quarantines.
    rb.ingest(
      candidate({ uri, filepath: 'still-secret.env', content: '-----BEGIN PRIVATE KEY-----', startLine: 0, endLine: 0 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);

    // Prove re-quarantine took effect: a DIFFERENT, individually-innocuous
    // window from the same uri is also dropped without another clear.
    rb.ingest(
      candidate({ uri, filepath: 'still-secret.env', content: 'innocuous body', startLine: 3, endLine: 3 }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });
});

describe('RingBuffer.ingest — overlap-dedup replaces, does not append', () => {
  it('replaces an overlapping same-kind same-uri entry with the newer one', () => {
    const rb = new RingBuffer();

    rb.ingest(
      candidate({ uri: 'file:///a.ts', kind: 'recently-edited', startLine: 0, endLine: 5, content: 'old body' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    rb.ingest(
      candidate({ uri: 'file:///a.ts', kind: 'recently-edited', startLine: 3, endLine: 8, content: 'new body' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );

    const editedRing = rb.allScanned().filter((s) => s.kind === 'recently-edited');
    expect(editedRing).toHaveLength(1);
    expect(editedRing[0]?.content).toBe('new body');
  });

  it('appends (does not replace) a same-uri entry whose range does not overlap', () => {
    const rb = new RingBuffer();

    rb.ingest(
      candidate({ uri: 'file:///a.ts', kind: 'recently-edited', startLine: 0, endLine: 5, content: 'first' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    rb.ingest(
      candidate({ uri: 'file:///a.ts', kind: 'recently-edited', startLine: 20, endLine: 25, content: 'second' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );

    const editedRing = rb.allScanned().filter((s) => s.kind === 'recently-edited');
    expect(editedRing).toHaveLength(2);
  });
});

describe('RingBuffer.ingest — per-source ring partitions + cap', () => {
  it('caps recently-edited at 16, evicting the oldest, WITHOUT touching recently-opened', () => {
    const rb = new RingBuffer();

    rb.ingest(
      candidate({ uri: 'file:///opened.ts', kind: 'recently-opened' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );

    for (let i = 0; i < 17; i++) {
      rb.ingest(
        candidate({
          uri: `file:///edited-${i}.ts`,
          kind: 'recently-edited',
          startLine: i,
          endLine: i,
        }),
        ACTIVE_URI,
        DEFAULT_ANCHOR,
      );
    }

    const editedRing = rb.allScanned().filter((s) => s.kind === 'recently-edited');
    expect(editedRing).toHaveLength(16);
    expect(editedRing.some((s) => s.uri === 'file:///edited-0.ts')).toBe(false); // oldest evicted
    expect(editedRing.some((s) => s.uri === 'file:///edited-16.ts')).toBe(true); // newest present

    const openedRing = rb.allScanned().filter((s) => s.kind === 'recently-opened');
    expect(openedRing).toHaveLength(1); // the high-volume edit stream never evicts open-tab context
    expect(openedRing[0]?.uri).toBe('file:///opened.ts');
  });
});

describe('RingBuffer.ingest — epoch bumps only on accept', () => {
  it('never bumps epoch on any of the drop paths, only on an accepted mutation', () => {
    const rb = new RingBuffer();
    expect(rb.currentEpoch()).toBe(0);

    // stale-anchor drop
    rb.ingest(
      candidate({ anchor: { uri: 'file:///other.ts', line: 9 } }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.currentEpoch()).toBe(0);

    // active-doc drop
    rb.ingest(candidate({ uri: ACTIVE_URI }), ACTIVE_URI, DEFAULT_ANCHOR);
    expect(rb.currentEpoch()).toBe(0);

    // secret-reject drop
    rb.ingest(
      candidate({ uri: 'file:///s.env', content: '-----BEGIN PRIVATE KEY-----' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.currentEpoch()).toBe(0);

    // accepted mint
    rb.ingest(candidate({ uri: 'file:///ok.ts', content: 'fine, nothing sensitive' }), ACTIVE_URI, DEFAULT_ANCHOR);
    expect(rb.currentEpoch()).toBe(1);

    // accepted replace (overlap) — a second accepted mutation.
    rb.ingest(
      candidate({ uri: 'file:///ok.ts', content: 'fine, still nothing sensitive, v2' }),
      ACTIVE_URI,
      DEFAULT_ANCHOR,
    );
    expect(rb.currentEpoch()).toBe(2);
  });
});

describe('RingBuffer.ingest — scanner-throw fail-closed', () => {
  it('treats a scanner throw as reject: fail-closed, drops, quarantines, does not bump epoch', () => {
    const uri = 'file:///throws.ts';
    vi.mocked(scanSnippetForSecrets).mockImplementationOnce(() => {
      throw new Error('scanner exploded');
    });

    const rb = new RingBuffer();
    rb.ingest(candidate({ uri, content: 'anything at all' }), ACTIVE_URI, DEFAULT_ANCHOR);

    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);

    // The mock only throws once (mockImplementationOnce) — the scanner is
    // back to its real self now. The uri must STILL be dropped for the SAME
    // content, because the throw quarantined it exactly like a real reject.
    rb.ingest(candidate({ uri, content: 'anything at all' }), ACTIVE_URI, DEFAULT_ANCHOR);
    expect(rb.allScanned()).toEqual([]);
    expect(rb.currentEpoch()).toBe(0);
  });
});

describe('RingBuffer.ingest — allScanned() accessor', () => {
  it('returns an empty array before any ingest call', () => {
    const rb = new RingBuffer();
    expect(rb.allScanned()).toEqual([]);
  });

  it('flattens across partitions', () => {
    const rb = new RingBuffer();
    rb.ingest(candidate({ uri: 'file:///e.ts', kind: 'recently-edited' }), ACTIVE_URI, DEFAULT_ANCHOR);
    rb.ingest(candidate({ uri: 'file:///o.ts', kind: 'recently-opened' }), ACTIVE_URI, DEFAULT_ANCHOR);

    expect(rb.allScanned()).toHaveLength(2);
  });
});

/**
 * W6-FD (final-3way-arch.md I-5) — the scan root for BOTH brand guards
 * below, widened from `context/`-only to ALL of `src/autocomplete/`
 * (RECURSIVE). Rationale: brand CONSUMERS live outside `context/` too
 * (`engine.ts`, `index.ts`, every file under `backends/`) — a non-recursive,
 * `context/`-scoped scan could never see an unsafe cast or brand-preserving
 * spread introduced in any of those files, which is exactly where a future
 * regression is most likely to land (this task's own new
 * `context/assertAllScanned.ts` and `backends/*.ts` egress wiring are
 * examples of code added OUTSIDE `context/` that legitimately touches
 * `ScannedSnippet`).
 */
const AUTOCOMPLETE_ROOT = join(__dirname, '..');

/**
 * P7-N8 (final-3way-2-arch.md I-6a): the file-walk used to be a hand-rolled
 * `readdirSync`/`statSync` recursion HERE (independently of the near-identical
 * one `scannedSnippetTestFactory.test.ts` also hand-rolled) — exactly the
 * N=2-survivors gap the review found against W6-FK's "extracted ONCE" claim.
 * Both describe blocks below now call the shared `src/host/purityScan.ts`
 * helper (`collectNonTestTsSources`) instead — behavior-preserving: same
 * recursive walk (`readdirSync(root, { recursive: true })`), same `.ts`/
 * non-`.test.ts` filter, same POSIX-relative `file` paths, only returning
 * `{ file, absPath, content }` records (content pre-read) rather than bare
 * path strings a caller had to `readFileSync` itself.
 */

/**
 * §3.2 — the by-construction gate, mechanised. `ScannedSnippet` is
 * unforgeable outside `types.ts`'s unexported `unique symbol`; the ONLY way
 * to legitimately produce one from a plain `CrossFileSnippet` shape is the
 * cast in `ringBuffer.ts`'s `ingest`, mirrored ONLY by the sanctioned
 * test-only factory. This test proves that invariant mechanically rather
 * than by convention (see `policyAcpPurity.test.ts` for the precedent of a
 * headless-vitest-as-guard pattern in this codebase).
 */
describe('the mint is the only ScannedSnippet source', () => {
  const CAST_RE = /\bas\s+ScannedSnippet\b/;
  // context/ringBuffer.ts: the one sanctioned production mint site.
  // context/scannedSnippetTestFactory.ts: the one sanctioned test-only mint site.
  // context/types.ts: T0's type-declaration file (defines `ScannedSnippet`
  // itself, not this task's file to edit) — its own doc-comment mentions the
  // phrase in prose ("No `as ScannedSnippet` anywhere else"), not as a real
  // cast. (Note: `as unknown as ScannedSnippet` is ALREADY caught by this
  // regex — the second `as ScannedSnippet` substring still matches — so no
  // widening of CAST_RE itself is needed, only of the file set below.)
  const SANCTIONED_FILES = new Set([
    'context/ringBuffer.ts',
    'context/scannedSnippetTestFactory.ts',
    'context/types.ts',
  ]);

  function collectTsFiles(): ScannableSource[] {
    return collectNonTestTsSources(AUTOCOMPLETE_ROOT);
  }

  it('no `as ScannedSnippet` cast exists outside ringBuffer.ts and the sanctioned test factory, anywhere under src/autocomplete/', () => {
    const offenders = collectTsFiles()
      .filter((f) => !SANCTIONED_FILES.has(f.file))
      .filter((f) => CAST_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('ringBuffer.ts DOES contain the sanctioned mint cast (the site actually exists)', () => {
    const text = readFileSync(join(AUTOCOMPLETE_ROOT, 'context/ringBuffer.ts'), 'utf-8');
    expect(CAST_RE.test(text)).toBe(true);
  });

  /**
   * H6-B9: converted from a `writeFileSync`-into-`backends/` probe to
   * race-free in-memory injection — same fix already applied to
   * `assertAllScannedLock.test.ts` (N7) and `purityScan.test.ts` (N8) for
   * the identical parallel-scan disk race (backlog B9: a concurrent test
   * file's recursive `readdirSync` walk of `backends/` could observe this
   * probe's `writeFileSync`d file and then race its `finally`-block
   * `unlinkSync`, throwing ENOENT out of an UNRELATED test). The original
   * single disk-write test proved two things at once — split into two
   * race-free assertions carrying the SAME proof:
   *  (A) reach — the real, already-on-disk recursive walk genuinely
   *      descends into the sibling `backends/` directory (read-only);
   *  (B) predicate — the SAME `CAST_RE` filter this suite's real assertion
   *      uses flags a synthetic in-memory offender shaped exactly like a
   *      collected source, with zero filesystem I/O.
   */
  it('I-5 reach proof: the recursive walk reaches the sibling backends/ directory (read-only, real on-disk file list, no probe write)', () => {
    // Before W6-FD, `collectTsFiles` only read `context/` non-recursively —
    // a cast planted in `backends/` would have been INVISIBLE to the old
    // guard. This proves the widened scan actually reaches into a sibling
    // directory, purely by observing the real committed tree.
    const files = collectTsFiles().map((f) => f.file);
    expect(files.some((f) => f.includes('backends/'))).toBe(true);
  });

  it('I-5 predicate proof: CAST_RE flags a forged cast injected into a synthetic backends/ entry (in-memory, zero disk I/O)', () => {
    const withInjectedViolation: ScannableSource[] = [
      ...collectTsFiles(),
      { file: 'backends/__cast_probe__.ts', content: 'const forged = someValue as ScannedSnippet;\n' },
    ];
    const offenders = withInjectedViolation
      .filter((f) => !SANCTIONED_FILES.has(f.file))
      .filter((f) => CAST_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toContain('backends/__cast_probe__.ts');
  });

  it('does NOT flag the same synthetic backends/ entry once its content is clean (negative control — proves the predicate is not just "flag every injected file")', () => {
    const withCleanEntry: ScannableSource[] = [
      ...collectTsFiles(),
      { file: 'backends/__cast_probe__.ts', content: 'const clean = someValue;\n' },
    ];
    const offenders = withCleanEntry
      .filter((f) => !SANCTIONED_FILES.has(f.file))
      .filter((f) => CAST_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).not.toContain('backends/__cast_probe__.ts');
  });
});

/**
 * §3.2 (fix-pass #2): a SECOND, independently-verified way to produce a
 * `ScannedSnippet`-shaped value without an `as` cast — TypeScript preserves
 * the brand through an object SPREAD of an already-branded value
 * (`{ ...scanned, content: trimmed }`, used by `snippetBudgeter.ts`'s
 * line-truncation, §2.6, verified SAFE because the emitted content is
 * always a byte-exact PREFIX of the already-scanned source — see
 * `snippetBudgeter.test.ts`'s prefix-invariant test). The `CAST_RE` guard
 * above cannot see this producer at all: a FUTURE unsafe spread elsewhere
 * (one that replaces `content` with UNSCANNED bytes instead of a verified
 * prefix) would slip past it silently. This block extends the mechanised
 * guard to also flag brand-preserving spreads outside the sanctioned sites.
 */
describe('no brand-preserving spread produces a ScannedSnippet outside the sanctioned sites', () => {
  // Matches an object literal that OPENS with a spread of a plain
  // identifier (or dotted path) followed by at least one more field —
  // exactly the "derive a modified copy of an already-branded value" shape
  // (`{ ...x, content: y }`) that preserves a TS brand through spread
  // without a cast. A bare `{ ...x }` clone (no overridden field) is not
  // flagged: it cannot introduce different/unscanned content.
  const SPREAD_RE = /\{\s*\.\.\.[A-Za-z_$][\w$.]*\s*,/;
  // context/ringBuffer.ts: the mint site (does not currently spread, but is
  // the choke point itself — sanctioned by construction).
  // context/snippetBudgeter.ts: the one sanctioned safe subset-derivation
  // (its spread's emitted `content` is always a byte-exact PREFIX of the
  // already-scanned `candidate.content` — see snippetBudgeter.test.ts).
  // index.ts / engine.ts (I-5 widening, W6-FD): the recursive scan now also
  // reaches these two — reviewed line-by-line, both are false positives of
  // this deliberately blunt regex, NOT new mint sites: `index.ts`'s
  // `{ ...cfg, apiKey }` (buildEngine) spreads `HermesAutocompleteConfig`,
  // never a `ScannedSnippet`; `engine.ts`'s `{ ...ctx, prefix, suffix }`
  // spreads the `FimContext` CONTAINER to override `prefix`/`suffix` only —
  // `ctx.snippets` (the branded array) passes through by reference,
  // untouched and never re-derived, so no new/unscanned content is ever
  // introduced under the brand.
  const SANCTIONED_SPREAD_FILES = new Set([
    'context/ringBuffer.ts',
    'context/snippetBudgeter.ts',
    'index.ts',
    'engine.ts',
  ]);

  function collectTsFiles(): ScannableSource[] {
    return collectNonTestTsSources(AUTOCOMPLETE_ROOT);
  }

  it('the guard regex actually catches a hypothetical unsafe spread (sanity check on the mechanism itself)', () => {
    // A hypothetical FUTURE unsafe site: spreads an already-scanned snippet
    // but overrides content with attacker-controlled/unscanned bytes
    // instead of a verified prefix. Proves SPREAD_RE is not a no-op that
    // would rubber-stamp any file.
    const hypotheticalUnsafeSite = 'const forged = { ...scanned, content: attackerControlledBytes };';
    expect(SPREAD_RE.test(hypotheticalUnsafeSite)).toBe(true);

    // A bare clone with no overridden field is NOT flagged — it cannot
    // introduce different content, so it carries none of the risk this
    // guard exists to catch.
    const bareClone = 'const copy = { ...scanned };';
    expect(SPREAD_RE.test(bareClone)).toBe(false);
  });

  it('no brand-preserving object-spread exists outside the sanctioned sites, anywhere under src/autocomplete/', () => {
    const offenders = collectTsFiles()
      .filter((f) => !SANCTIONED_SPREAD_FILES.has(f.file))
      .filter((f) => SPREAD_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('snippetBudgeter.ts DOES contain the sanctioned truncation spread (the site actually exists)', () => {
    const text = readFileSync(join(AUTOCOMPLETE_ROOT, 'context/snippetBudgeter.ts'), 'utf-8');
    expect(SPREAD_RE.test(text)).toBe(true);
  });

  /**
   * H6-B9: same conversion as the CAST_RE probe above — race-free in-memory
   * injection instead of `writeFileSync`ing into the concurrently-scanned
   * `backends/` directory. See that probe's doc comment for the full
   * backlog-B9 rationale (mirrors N7/N8).
   */
  it('I-5 reach proof: the recursive walk reaches the sibling backends/ directory (read-only, real on-disk file list, no probe write)', () => {
    // Same recursion/breadth proof as the CAST_RE probe above, for the
    // spread guard: a brand-preserving spread planted in a sibling
    // directory (backends/) would have been invisible to the old
    // context/-only, non-recursive walk.
    const files = collectTsFiles().map((f) => f.file);
    expect(files.some((f) => f.includes('backends/'))).toBe(true);
  });

  it('I-5 predicate proof: SPREAD_RE flags a brand-preserving spread injected into a synthetic backends/ entry (in-memory, zero disk I/O)', () => {
    const withInjectedViolation: ScannableSource[] = [
      ...collectTsFiles(),
      {
        file: 'backends/__spread_probe__.ts',
        content: 'const forged = { ...scanned, content: attackerControlledBytes };\n',
      },
    ];
    const offenders = withInjectedViolation
      .filter((f) => !SANCTIONED_SPREAD_FILES.has(f.file))
      .filter((f) => SPREAD_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).toContain('backends/__spread_probe__.ts');
  });

  it('does NOT flag the same synthetic backends/ entry when it is a bare clone (negative control — proves the predicate is not just "flag every injected file")', () => {
    const withCleanEntry: ScannableSource[] = [
      ...collectTsFiles(),
      { file: 'backends/__spread_probe__.ts', content: 'const copy = { ...scanned };\n' },
    ];
    const offenders = withCleanEntry
      .filter((f) => !SANCTIONED_SPREAD_FILES.has(f.file))
      .filter((f) => SPREAD_RE.test(f.content))
      .map((f) => f.file);

    expect(offenders).not.toContain('backends/__spread_probe__.ts');
  });
});

/**
 * Remediation R-1a: the
 * SIBLING cast-forgery guard for the REQUEST-level brand.
 * `ScannedNextEditRequest` (nextedit/types.ts:21) is minted ONLY by
 * `mintScannedNextEditRequest` (nextedit/scan.ts:171) — the request-level
 * analogue of `ScannedSnippet`'s ingest mint. The CAST_RE block above names
 * the OTHER brand and cannot see a forged request-brand cast, so until this
 * block landed such a forgery anywhere under src/autocomplete/ was caught by
 * nothing. Same walker, same in-memory H6-B9 probe discipline as its sibling.
 */
describe('the mint is the only ScannedNextEditRequest source', () => {
  const NEXT_CAST_RE = /\bas\s+ScannedNextEditRequest\b/;
  // nextedit/scan.ts: the one sanctioned mint site. No test-only factory
  // exists for this brand, and nextedit/types.ts declares it via an
  // intersection type, not a cast — so exactly ONE file is sanctioned.
  const NEXT_SANCTIONED_FILES = new Set(['nextedit/scan.ts']);

  it('no `as ScannedNextEditRequest` cast exists outside nextedit/scan.ts, anywhere under src/autocomplete/', () => {
    const offenders = collectNonTestTsSources(AUTOCOMPLETE_ROOT)
      .filter((f) => !NEXT_SANCTIONED_FILES.has(f.file))
      .filter((f) => NEXT_CAST_RE.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('nextedit/scan.ts DOES contain the sanctioned mint cast (the site actually exists)', () => {
    const text = readFileSync(join(AUTOCOMPLETE_ROOT, 'nextedit/scan.ts'), 'utf-8');
    expect(NEXT_CAST_RE.test(text)).toBe(true);
  });

  it('reach proof: the recursive walk reaches the nextedit/ directory (read-only, real on-disk file list)', () => {
    const files = collectNonTestTsSources(AUTOCOMPLETE_ROOT).map((f) => f.file);
    expect(files.some((f) => f.includes('nextedit/'))).toBe(true);
  });

  it('predicate proof: NEXT_CAST_RE flags a forged cast injected into a synthetic entry (in-memory, zero disk I/O)', () => {
    const withInjectedViolation: ScannableSource[] = [
      ...collectNonTestTsSources(AUTOCOMPLETE_ROOT),
      { file: 'backends/__next_cast_probe__.ts', content: 'const forged = req as unknown as ScannedNextEditRequest;\n' },
    ];
    const offenders = withInjectedViolation
      .filter((f) => !NEXT_SANCTIONED_FILES.has(f.file))
      .filter((f) => NEXT_CAST_RE.test(f.content))
      .map((f) => f.file);
    expect(offenders).toContain('backends/__next_cast_probe__.ts');
  });

  it('negative control: a clean synthetic entry is not flagged (the predicate is not "flag every injected file")', () => {
    const withCleanEntry: ScannableSource[] = [
      ...collectNonTestTsSources(AUTOCOMPLETE_ROOT),
      { file: 'backends/__next_cast_probe__.ts', content: 'const clean = buildNextEditRequest();\n' },
    ];
    const offenders = withCleanEntry
      .filter((f) => !NEXT_SANCTIONED_FILES.has(f.file))
      .filter((f) => NEXT_CAST_RE.test(f.content))
      .map((f) => f.file);
    expect(offenders).not.toContain('backends/__next_cast_probe__.ts');
  });
});
