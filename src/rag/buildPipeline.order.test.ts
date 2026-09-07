import { describe, expect, it } from 'vitest';

import { reindexFiles, type IndexerContext, type ReindexTarget } from './buildPipeline';
import { chunkByLines } from './chunk/lineWindowChunker';
import { hashContent } from './contentHash';
import type { Embedder } from './embedder';
import type { IndexerOptions } from './indexer';
import type { CodeParser } from './parser/CodeParser';
import type { VectorStore } from './store/VectorStore';
import type { MutationGate } from '../host/util/mutationGate';

/**
 * WS-F6 F6-1 — CHARACTERIZATION-FIRST golden bank for `reindexFiles`
 * (`buildPipeline.ts:275-516`, re-grounded against `f6d7b4f`). WS-F6
 * decomposes/cleans this function across F6-2..F6-9; this file pins TODAY's
 * observable behaviour — the ORDERED store-mutation sequence and the
 * resulting `manifest` — as a golden every one of those tasks must keep
 * 0-edit (Fable/GD.2 discipline). It PASSES against the UNTOUCHED
 * `buildPipeline.ts`; if a later task can't keep it green without editing
 * this file, that task changed observable behaviour (a defect), full stop.
 *
 * Scope note (re-grounded, not copied from the task brief): a grep of every
 * `ctx.<field>` reference inside `reindexFiles`'s own body (lines 275-516)
 * shows it touches only `ctx.ensureStoreInitialized`, `ctx.isDisposed`,
 * `ctx.store.{deleteByPath,upsert}`, `ctx.gate.sink`, `ctx.embedder.embed`,
 * and `ctx.opts.maxChunkTokens` — `ctx.writeManifest`/`ctx.writeMeta` (and
 * every other `IndexerContext` field) are `runBuild`-only seams
 * (`buildPipeline.ts:638/645/656`), never reached from inside `reindexFiles`
 * itself. So this golden characterizes `reindexFiles` ALONE (exactly what
 * F6-1's brief asks it to drive) and asserts those other members are never
 * touched, rather than fabricating a `runBuild`-tail-shaped wrapper around
 * the call — that would be testing hand-rolled harness glue, not the real
 * function under decomposition. `runBuild`'s own tail (the
 * guard-then-`writeManifest` pattern) is a separate function with its own
 * contract; it deserves its own future golden, not one borrowed here.
 *
 * Scenario (3 files / 2 embed batches at today's `EMBED_BATCH_SIZE = 64`,
 * `buildPipeline.ts:32`, batched at `:413`):
 *  - `zero.dat`  — whitespace-only content -> 0 chunks. Exercises the
 *    phase-1 `recordCount === 0` immediate purge+manifest branch
 *    (`:391-399`) — no `pathState` entry, no embed involvement at all.
 *  - `alpha.dat` — 50 chunks. Lands ENTIRELY inside embed batch 1
 *    (records 0-49) -> the "fully swapped in batch 1" shape.
 *  - `beta.dat`  — 20 chunks. Its records (50-69) SPAN the batch boundary:
 *    the first 14 (50-63) land in batch 1, the remaining 6 (64-69) land in
 *    batch 2 -> the "half swapped" shape the case-(b) scrub targets.
 *  Total pending records = 70 -> batch 1 = records[0..63] (64: all of
 *  alpha + beta's first 14), batch 2 = records[64..69] (6: beta's
 *  remainder) — the 2-batch split this golden pins.
 *
 * `alpha.dat`/`beta.dat` use an UNMAPPED extension (`.dat` is not in
 * `EXTENSION_TO_LANGUAGE_ID`) so `chunker.ts`'s AST path is never taken
 * (`languageId` is `undefined`, so `buildPipeline.ts:349`'s
 * `...(languageId ? { parser: ctx.parser } : {})` never even reads
 * `ctx.parser`) — chunking falls through to the plain 40-line/10-line-
 * overlap `chunkByLines` fallback, which this file also uses (the REAL
 * production function, not a reimplementation) to self-check the exact
 * chunk counts the synthetic fixtures below are relied on to produce.
 *
 * F6-7 forward-compatibility (critic M-7): F6-7 is planned to replace the
 * `EMBED_BATCH_SIZE` module constant with `ctx.embedder.batchSize` (default
 * 64). Today's `Embedder` interface (`embedder.ts:128-141`) has no
 * `batchSize` field, and adding one to the object literal below would trip
 * TypeScript's excess-property check on a fresh object literal assigned to
 * an `Embedder`-typed const — so this golden deliberately does NOT carry a
 * `batchSize` field now. It instead relies on today's `EMBED_BATCH_SIZE`
 * constant to produce the 2-batch (64 + 6) split. When F6-7 lands, it must
 * add `batchSize: 64` to `createFakeEmbedder` below (and widen its return
 * type's annotation to the extended `Embedder` shape) — that one declared
 * fixture edit is the ONLY change F6-7 may make to this file; the 2-batch
 * shape and every assertion here must otherwise stay byte-identical.
 */

const WORKSPACE_ROOT = '/fake-workspace';

function absPath(rel: string): string {
  return `${WORKSPACE_ROOT}/${rel}`;
}

const ZERO_REL = 'zero.dat';
const ALPHA_REL = 'alpha.dat';
const BETA_REL = 'beta.dat';

const ALPHA_LINES = 1510; // chunkByLines(window=40, overlap=10) -> 50 chunks
const BETA_LINES = 610; // chunkByLines(window=40, overlap=10) -> 20 chunks

/**
 * Builds `count` non-blank lines and self-checks (against the REAL
 * `chunkByLines`, not a reimplementation of its math) that they produce
 * exactly `expectedChunks` chunks — so a future change to
 * `lineWindowChunker.ts`'s window/overlap constants fails this fixture
 * loudly instead of silently shifting the batch boundary this golden pins.
 */
function linesProducingChunks(prefix: string, count: number, expectedChunks: number): string {
  const content = Array.from({ length: count }, (_, i) => `${prefix}-${i}`).join('\n');
  const actualChunks = chunkByLines(content).length;
  if (actualChunks !== expectedChunks) {
    throw new Error(
      `test fixture drift: ${count} '${prefix}' lines produced ${actualChunks} chunks, expected ${expectedChunks} — lineWindowChunker.ts's window/overlap constants changed underneath this golden`,
    );
  }
  return content;
}

interface Scenario {
  targets: ReindexTarget[];
  preloaded: Map<string, Buffer>;
  zeroHash: string;
  alphaHash: string;
  betaHash: string;
}

function buildScenario(): Scenario {
  const zeroContent = '   ';
  const alphaContent = linesProducingChunks('alpha', ALPHA_LINES, 50);
  const betaContent = linesProducingChunks('beta', BETA_LINES, 20);

  const targets: ReindexTarget[] = [
    { readAbsPath: absPath(ZERO_REL), storeRelPath: ZERO_REL },
    { readAbsPath: absPath(ALPHA_REL), storeRelPath: ALPHA_REL },
    { readAbsPath: absPath(BETA_REL), storeRelPath: BETA_REL },
  ];

  const preloaded = new Map<string, Buffer>([
    [absPath(ZERO_REL), Buffer.from(zeroContent, 'utf8')],
    [absPath(ALPHA_REL), Buffer.from(alphaContent, 'utf8')],
    [absPath(BETA_REL), Buffer.from(betaContent, 'utf8')],
  ]);

  return {
    targets,
    preloaded,
    zeroHash: hashContent(zeroContent),
    alphaHash: hashContent(alphaContent),
    betaHash: hashContent(betaContent),
  };
}

/** Every `IndexerContext` member `reindexFiles` never reaches (see the file
 * header's scope note) is wired to this — a `runBuild`-only seam accidentally
 * reached from inside `reindexFiles` fails the test immediately, loudly. */
function unexpected(name: string): never {
  throw new Error(`reindexFiles must not reach ctx.${name} — it is a runBuild-only seam`);
}

interface Harness {
  ctx: IndexerContext;
  /** Ordered log of every mutation this run performed, oldest first:
   * `ensureStoreInitialized`, `embed:<n texts>` (or `embed:<n>:throw`),
   * `deleteByPath:<relPath>`, `upsert:<n records>`. */
  calls: string[];
}

/**
 * `isDisposedSequence` gives the return value for the Nth call to
 * `ctx.isDisposed()` (0-indexed); calls past the end of the array repeat the
 * LAST entry. `reindexFiles` calls it exactly 3 times when nothing throws
 * and dispose never fires (entry `:289`, after batch 1's embed `:442`,
 * after batch 2's embed `:442`) — fewer if a batch throws before its own
 * `:442` check (case b) or dispose fires and short-circuits (case c).
 */
function buildHarness(opts: {
  isDisposedSequence: readonly boolean[];
  embedWidth: number;
  failOnEmbedCall?: number;
}): Harness {
  const calls: string[] = [];
  let isDisposedCallIndex = 0;
  let embedCallIndex = 0;

  const store: VectorStore = {
    init: () => unexpected('store.init'),
    upsert: async (records) => {
      calls.push(`upsert:${records.length}`);
    },
    deleteByPath: async (path) => {
      calls.push(`deleteByPath:${path}`);
    },
    listFileHashes: () => unexpected('store.listFileHashes'),
    hybridSearch: () => unexpected('store.hybridSearch'),
    close: () => unexpected('store.close'),
  };

  const embedder: Embedder = {
    embed: async (texts) => {
      embedCallIndex += 1;
      if (opts.failOnEmbedCall === embedCallIndex) {
        calls.push(`embed:${texts.length}:throw`);
        throw new Error(`embed: simulated /v1/embeddings failure (characterization case b, call ${embedCallIndex})`);
      }
      calls.push(`embed:${texts.length}`);
      return texts.map(() => Array.from({ length: opts.embedWidth }, () => 0.1));
    },
  };

  const parser: CodeParser = {
    supports: () => unexpected('parser.supports'),
    parse: () => unexpected('parser.parse'),
  };

  const gate: MutationGate = {
    sink: (op) => op(),
    close: () => unexpected('gate.close'),
    refusedCount: 0,
    closed: false,
  };

  const indexerOpts: IndexerOptions = {
    workspaceRoot: WORKSPACE_ROOT,
    indexDir: `${WORKSPACE_ROOT}/.hermes-index`,
    embedEndpoint: 'http://fake-embed.invalid',
    embedModel: 'fake-model',
  };

  const ctx: IndexerContext = {
    opts: indexerOpts,
    store,
    embedder,
    gate,
    parser,
    logger: () => unexpected('logger'),
    isDisposed: () => {
      const idx = Math.min(isDisposedCallIndex, opts.isDisposedSequence.length - 1);
      isDisposedCallIndex += 1;
      return opts.isDisposedSequence[idx] ?? false;
    },
    ensureStoreInitialized: async () => {
      calls.push('ensureStoreInitialized');
    },
    readManifest: () => unexpected('readManifest'),
    writeManifest: () => unexpected('writeManifest'),
    readMeta: () => unexpected('readMeta'),
    writeMeta: () => unexpected('writeMeta'),
    computeEffectiveWidth: () => unexpected('computeEffectiveWidth'),
    fingerprintMatches: () => unexpected('fingerprintMatches'),
    loadIgnoreFilter: () => unexpected('loadIgnoreFilter'),
    invalidateIgnoreFilterCache: () => unexpected('invalidateIgnoreFilterCache'),
    setKnownNestedIgnoreDirs: () => unexpected('setKnownNestedIgnoreDirs'),
    recordFailedIncrementalReindex: () => unexpected('recordFailedIncrementalReindex'),
  };

  return { ctx, calls };
}

describe('reindexFiles — spy-order golden bank (WS-F6 F6-1 characterization, buildPipeline.ts:275-516)', () => {
  it('(a) success: full ordered swap sequence + every path lands in the final manifest', async () => {
    const { targets, preloaded, zeroHash, alphaHash, betaHash } = buildScenario();
    const { ctx, calls } = buildHarness({ isDisposedSequence: [false], embedWidth: 3 });
    const manifest: Record<string, string> = {};

    const observedWidth = await reindexFiles(ctx, targets, manifest, undefined, preloaded);

    expect(observedWidth).toBe(3);
    expect(calls).toEqual([
      'ensureStoreInitialized',
      // phase 1 (:307-403): zero.dat's 0 surviving chunks purge+manifest
      // immediately (:391-399) — alpha/beta produce records instead
      // (:401), deferred to the phase-2 swap below.
      'deleteByPath:zero.dat',
      // phase 2, batch 1 (records 0-63 = alpha's 50 + beta's first 14):
      // embed, THEN delete each newly-represented path's stale rows
      // (:474-480), THEN upsert (:482) — delete-before-upsert per path is
      // the swap invariant (TA-3).
      'embed:64',
      'deleteByPath:alpha.dat',
      'deleteByPath:beta.dat',
      'upsert:64',
      // phase 2, batch 2 (records 64-69 = beta's remaining 6): beta was
      // already purged at batch 1 (`state.deleted` true) — TA-3's "purge
      // each path's stale rows exactly once" — so this batch has no
      // `deleteByPath` call at all, only the embed + upsert.
      'embed:6',
      'upsert:6',
    ]);
    expect(manifest).toEqual({
      'zero.dat': zeroHash,
      'alpha.dat': alphaHash,
      'beta.dat': betaHash,
    });
  });

  it('(b) throw in embed batch 2: the scrub deletes the half-swapped path, keeps the fully-swapped ones', async () => {
    const { targets, preloaded, zeroHash, alphaHash, betaHash } = buildScenario();
    const { ctx, calls } = buildHarness({ isDisposedSequence: [false], embedWidth: 3, failOnEmbedCall: 2 });
    // beta.dat already has a manifest entry equal to its CURRENT content
    // hash — models the fingerprint-mismatch full-rebuild path
    // (`runBuild`'s `toCompute = Object.keys(current)` branch), where a
    // file's on-disk content is unchanged but is recomputed anyway. This is
    // the scenario TA-3's scrub actually protects: if this run's partial
    // swap fails and the scrub did NOT run, this ALREADY-matching entry
    // would sit there unmolested, hiding the fact that beta.dat's store
    // rows are now gone/incomplete. `zero.dat`/`alpha.dat` start with no
    // entry at all (irrelevant to the scrub either way).
    const manifest: Record<string, string> = { 'beta.dat': betaHash };

    const pending = reindexFiles(ctx, targets, manifest, undefined, preloaded);
    await expect(pending).rejects.toThrow('embed: simulated /v1/embeddings failure');

    // Ordered calls up to (and including) the throw: batch 1 completes in
    // full (embed, swap-delete both paths, upsert); batch 2's embed call
    // itself throws before reaching the delete/upsert step (:442 is never
    // reached this batch) so nothing else follows it.
    expect(calls).toEqual([
      'ensureStoreInitialized',
      'deleteByPath:zero.dat',
      'embed:64',
      'deleteByPath:alpha.dat',
      'deleteByPath:beta.dat',
      'upsert:64',
      'embed:6:throw',
    ]);
    // The catch-scrub (:501-513): alpha.dat was fully swapped in batch 1
    // (`deleted && remaining === 0`) -> kept (freshly SET, not merely left
    // alone — it had no prior entry). beta.dat's stale rows were deleted in
    // batch 1 but its remaining 6 records never landed (`deleted &&
    // remaining > 0`) -> its PRE-EXISTING, already-matching manifest entry
    // is actively deleted by the scrub. zero.dat never entered `pathState`
    // at all (its 0-chunk purge is a separate phase-1 branch) -> untouched
    // by the scrub, freshly set to its own current hash.
    expect(manifest).toEqual({
      'zero.dat': zeroHash,
      'alpha.dat': alphaHash,
    });
    expect(manifest).not.toHaveProperty('beta.dat');
  });

  it('(c) dispose mid-embed (after batch 1): batch 2 never upserts, its path is never finalized', async () => {
    const { targets, preloaded, zeroHash, alphaHash } = buildScenario();
    const { ctx, calls } = buildHarness({
      isDisposedSequence: [false, false, true],
      embedWidth: 3,
    });
    // A STALE value (deliberately NOT betaHash), unlike case (b)'s
    // already-matching fixture: dispose short-circuits at `:442` with NO
    // throw, so the catch-scrub (`:500-513`) never runs at all — the only
    // way to prove beta.dat's entry is genuinely left ALONE (neither
    // finalized to the new hash NOR scrubbed to absent) is to start it at a
    // value distinguishable from both outcomes and assert it survives
    // byte-identical.
    const manifest: Record<string, string> = { 'beta.dat': 'stale-hash-from-a-prior-build' };

    const observedWidth = await reindexFiles(ctx, targets, manifest, undefined, preloaded);

    // The :442 guard fires right after batch 2's embed call resolves —
    // batch 2's embed IS called (unlike case b, nothing throws), but its
    // delete/upsert/manifest-write never run; `reindexFiles` returns
    // whatever width batch 1 already observed.
    expect(observedWidth).toBe(3);
    expect(calls).toEqual([
      'ensureStoreInitialized',
      'deleteByPath:zero.dat',
      'embed:64',
      'deleteByPath:alpha.dat',
      'deleteByPath:beta.dat',
      'upsert:64',
      'embed:6',
    ]);
    // beta.dat's stale rows were purged in batch 1 (deleted=true) but its
    // remaining 6 replacement records never reached `store.upsert`, and —
    // unlike case (b) — no throw ever runs the catch-scrub either: dispose
    // is a plain early return (`:442`), not an exception. So beta.dat's
    // manifest entry is neither finalized to `betaHash` NOR scrubbed to
    // absent — it survives completely UNTOUCHED at whatever it held before
    // this call, which is exactly the asymmetry between the throw path
    // (case b, active scrub) and the dispose path (case c, silent no-op)
    // that a decomposition must not blur.
    expect(manifest).toEqual({
      'zero.dat': zeroHash,
      'alpha.dat': alphaHash,
      'beta.dat': 'stale-hash-from-a-prior-build',
    });
  });
});
