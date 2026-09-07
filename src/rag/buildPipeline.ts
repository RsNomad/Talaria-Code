import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

// W6-FC (final-3way-arch.md I-6): import the pure classifier directly from
// `shared/secretPaths.ts` — the RAG indexer is an egress-only consumer, not
// a host-policy one.
import { isSecretForCompletion } from '../shared/secretPaths';
// SEC-1 (audit-3, RATIFIED): the path filter above (`isSecretForCompletion`
// in `walk()`) only stops a `.env`/`id_rsa`-class FILE from being indexed at
// all — it says nothing about a secret living INSIDE a normally-named file
// (e.g. an API key in `src/config.ts`). The completion/FIM path already runs
// this SAME content scanner before anything is sent to an inference
// endpoint; `reindexFiles` below now runs it too, per chunk, before that
// chunk is embedded and stored (AISVS 8.2.1: detect before embedding, since
// embedded content cannot be reliably redacted from the resulting index).
import { scanSnippetForSecrets } from '../autocomplete/context/secretScanner';
// T-19 (C1+C2): createIgnoreFilter moved to shared/ignoreFilter.ts; toPosixRelative stayed in ./gitignore.
import { createIgnoreFilter } from '../shared/ignoreFilter';
import { createConcurrencyPool } from '../mcp/lsp/toolPipeline';
import { chunkFile } from './chunker';
import { diffContentHashes, hashContent } from './contentHash';
import { toPosixRelative } from './gitignore';
import type { IndexerOptions, IndexMeta } from './indexer';
import type { Embedder } from './embedder';
import type { CodeParser } from './parser/CodeParser';
import type { ChunkRecord, VectorStore } from './store/VectorStore';
import type { MutationGate } from '../host/util/mutationGate';

const MAX_FILE_BYTES = 1_000_000; // matches Continue's shouldChunk cutoff
const EMBED_BATCH_SIZE = 64; // how-to §2.4: batch ~64-200
// RAG-02: bounded fan-out for the full-build directory descent — enough to
// overlap readdir latency without exhausting file descriptors on a big repo.
const WALK_CONCURRENCY = 8;

const EXTENSION_TO_LANGUAGE_ID: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
};

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * FI-20/FI-31 (F6-6): shared errno classifier for this file's read/readdir
 * catches (`walk`'s readdir + nested-ignore-file reads, and `runBuild`'s
 * hash-pass read) — mirrors `indexer.ts`'s inline `readManifest`/`readMeta`
 * idiom (`err.code === 'ENOENT'`), factored out once here since this file has
 * FOUR such catches where `indexer.ts` has two.
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

/** FI-20/FI-31: the log-safe name for an error — never the message (which
 * can carry filesystem/secret detail), mirroring `indexer.ts`'s `(${err.name})` idiom. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/**
 * TA-7 (AU-34) / INV-6: a nested per-directory ignore matcher scoped to
 * `dirRel` (POSIX-relative to `workspaceRoot`). `matches` is a
 * `createIgnoreFilter`-produced predicate built from that directory's OWN
 * `.gitignore`/`.hermesignore` contents.
 */
export interface NestedIgnoreEntry {
  dirRel: string;
  matches: (relToDir: string) => boolean;
}

/**
 * Tests `relPosixPath` against every nested matcher whose directory it falls
 * under, mirroring git's per-directory `.gitignore` scoping: a nested file's
 * rules govern only paths INSIDE its own directory, tested RELATIVE to that
 * directory — the `ignore` package's documented relative-path contract
 * (pinned by `shared/ignoreFilter.test.ts`). `relPosixPath === dirRel` (the
 * directory entry itself, as seen from its PARENT) is deliberately not
 * tested against that directory's own matcher — a nested ignore file governs
 * its directory's contents, not whether the directory itself is excluded
 * from its parent (that is the parent's/ancestor's/default-excludes' call).
 * Exact git precedence ACROSS multiple nested files (e.g. a child directory
 * re-including something an ancestor excluded) is intentionally NOT
 * replicated — each nested file's rules apply independently (TA-7's
 * rejected "full git-parity precedence engine" alternative — YAGNI for an
 * indexer).
 */
export function matchesNestedIgnore(entries: readonly NestedIgnoreEntry[], relPosixPath: string): boolean {
  for (const { dirRel, matches } of entries) {
    if (relPosixPath === dirRel) continue;
    if (relPosixPath.startsWith(`${dirRel}/`) && matches(relPosixPath.slice(dirRel.length + 1))) {
      return true;
    }
  }
  return false;
}

/**
 * B8 (FUNC-INDEXER): explicit deps bag threading everything `walk`,
 * `reindexFiles`, and `runBuild` used to close over inside `createIndexer`
 * (indexer.ts) — this module is no longer itself a closure of that factory,
 * so every closed-over value becomes an EXPLICIT field here instead.
 *
 * `fs` is deliberately NOT a field: the RAG test suite monkey-patches
 * `node:fs`'s promise methods (`fs.readdir`/`fs.readFile`/`fs.rename`) by
 * reassigning them on the shared `import { promises as fs } from 'node:fs'`
 * singleton, so this file (and `watchPipeline.ts`) import `fs` the SAME way
 * indexer.ts does rather than threading it through here — re-aliasing or
 * ctx-threading it would silently break that seam. `store`/`embedder` are
 * INSTANCES built inside `createIndexer` (not module imports), so unlike
 * `fs` they ARE closure values and must be threaded here — the `vi.mock`
 * factories back the classes those instances come from, so the mock still
 * applies as long as the instance itself is passed through.
 *
 * FI-18 (F6-4): this file's five functions each used to take the WHOLE bag
 * even though most touch only a handful of its ~18 members.
 * `IndexerContextBag` (below, module-private) names every member ONCE;
 * `IndexerStoreCtx` / `IndexerManifestCtx` / `IndexerIgnoreCtx` /
 * `IndexerLogCtx` are role-based `Pick`s of it, and the exported
 * `IndexerContext` is their intersection plus the residual members no
 * single role owns (`opts`/`parser`/`embedder`/`isDisposed`/
 * `recordFailedIncrementalReindex`) — structurally the SAME 18 members as
 * before, so `createIndexer`'s bag construction (indexer.ts) and
 * `watchPipeline.ts`'s `ctx: IndexerContext` params compile unchanged. Each
 * function below narrows its own `ctx` parameter to the intersection of
 * only the roles (and residual members) its body actually reads — grounded
 * by reading each function, not guessed; `tsc` is the arbiter that a
 * narrowed Pick still covers every field the function references.
 */
interface IndexerContextBag {
  opts: IndexerOptions;
  store: VectorStore;
  embedder: Embedder;
  gate: MutationGate;
  parser: CodeParser;
  /** F2-12: same injected log seam as `IndexerOptions.logger` (default `console.error`). */
  logger: (line: string) => void;
  isDisposed: () => boolean;
  ensureStoreInitialized: () => Promise<void>;
  readManifest: () => Promise<Record<string, string>>;
  writeManifest: (manifest: Record<string, string>) => Promise<void>;
  readMeta: () => Promise<IndexMeta | undefined>;
  writeMeta: (observedWidth: number | undefined) => Promise<void>;
  computeEffectiveWidth: (storedMeta: IndexMeta | undefined) => number | undefined;
  fingerprintMatches: (stored: IndexMeta | undefined) => boolean;
  loadIgnoreFilter: () => Promise<(relPosixPath: string) => boolean>;
  /** Invalidates the memoized ignore-filter predicate (indexer.ts's `cachedIgnoreFilter`). */
  invalidateIgnoreFilterCache: () => void;
  /** Records this build's freshly-discovered nested-ignore directories (indexer.ts's `knownNestedIgnoreDirs`). */
  setKnownNestedIgnoreDirs: (dirs: string[]) => void;
  /** F2-12: bumps indexer.ts's cumulative `failedIncrementalReindexesTotal` counter (watchPipeline.ts's `schedule()` catch). */
  recordFailedIncrementalReindex: () => void;
}

/** FI-18: the store-lifecycle role — `store`/`gate` and the async init that must precede touching either. */
export type IndexerStoreCtx = Pick<IndexerContextBag, 'store' | 'gate' | 'ensureStoreInitialized'>;
/** FI-18: the manifest/fingerprint-sidecar role — everything `runBuild` reads or writes to decide and record what changed. */
export type IndexerManifestCtx = Pick<
  IndexerContextBag,
  'readManifest' | 'writeManifest' | 'readMeta' | 'writeMeta' | 'computeEffectiveWidth' | 'fingerprintMatches'
>;
/** FI-18: the ignore-filter role — loading it, and invalidating/recording its nested-directory cache. */
export type IndexerIgnoreCtx = Pick<
  IndexerContextBag,
  'loadIgnoreFilter' | 'invalidateIgnoreFilterCache' | 'setKnownNestedIgnoreDirs'
>;
/** FI-18: the logging role — used only by `watchPipeline.ts`'s functions, not by anything in this file. */
export type IndexerLogCtx = Pick<IndexerContextBag, 'logger'>;

/**
 * FI-18: the full bag, unchanged in shape — the intersection of every role
 * above plus the residual members no role owns. `createIndexer`'s object
 * literal (indexer.ts) satisfies this exactly as it satisfied the
 * pre-refactor bag interface.
 */
export type IndexerContext = IndexerStoreCtx &
  IndexerManifestCtx &
  IndexerIgnoreCtx &
  IndexerLogCtx &
  Pick<IndexerContextBag, 'opts' | 'parser' | 'embedder' | 'isDisposed' | 'recordFailedIncrementalReindex'>;

export async function walk(
  // FI-18: `walk` reads `ctx.opts.workspaceRoot` — no store/manifest/
  // ignore-filter-role member. FI-20/FI-31 (F6-6): it now ALSO reads
  // `ctx.logger` — the readdir/nested-ignore-file catches below log a
  // non-ENOENT errno name; ENOENT itself stays silent (a missing/racing
  // directory mid-walk is ordinary, not an error).
  ctx: Pick<IndexerContextBag, 'opts'> & IndexerLogCtx,
  root: string,
  ignoreFilter: (p: string) => boolean,
  out: string[],
  ancestors: readonly NestedIgnoreEntry[] = [],
  discoveredNestedDirs?: string[],
): Promise<void> {
  // RAG-02: bounded-parallel BFS descent, reusing the same pool util as
  // LSP-01 (`createConcurrencyPool`). Deadlock-safety (pool re-entrancy
  // caveat, toolPipeline.ts): a pooled task must NEVER await a nested
  // `pool.run` on the SAME pool while holding a slot — `visitDir` below
  // schedules each child directory by pushing its `pool.run(...)` promise
  // onto `pending` (no await at schedule time), and this function alone
  // drains `pending` at the top level, so no task ever waits on the pool
  // that scheduled it.
  const pool = createConcurrencyPool(WALK_CONCURRENCY);
  const pending: Array<Promise<void>> = [];

  const visitDir = (dir: string, localAncestors: readonly NestedIgnoreEntry[]): void => {
    pending.push(
      pool.run(async () => {
        let entries: Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
          // FI-20/FI-31: ENOENT (a missing/racing directory) stays silent —
          // the ordinary case; any other errno (EACCES, EIO, ...) is logged
          // with err.name only, never the path.
          if (!isEnoent(err)) {
            ctx.logger(`hermes-codebase: directory read failed (${errName(err)})`);
          }
          return;
        }

        // TA-7 (AU-34) / INV-6: discover THIS directory's own nested
        // ignore file(s) fresh, live, on every full build — independent of
        // whatever `ignoreFilter`'s (possibly stale, prior-build) nested
        // knowledge already contains, so a brand-new nested `.gitignore`
        // is honored starting with the VERY build that walks past it. The
        // workspace ROOT is excluded here: its `.gitignore`/`.hermesignore`
        // are already folded into `ignoreFilter` via `loadIgnoreFilter()`,
        // so re-reading them here too would just be a redundant duplicate
        // check.
        let dirAncestors = localAncestors;
        if (dir !== ctx.opts.workspaceRoot) {
          const dirRel = toPosixRelative(path.relative(ctx.opts.workspaceRoot, dir));
          const dirContents: string[] = [];
          try {
            dirContents.push(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'));
          } catch (err) {
            // FI-20/FI-31: ENOENT ("no nested .gitignore here") stays
            // silent; any other read error is logged, err.name only.
            if (!isEnoent(err)) {
              ctx.logger(`hermes-codebase: nested .gitignore read failed (${errName(err)})`);
            }
          }
          try {
            dirContents.push(await fs.readFile(path.join(dir, '.hermesignore'), 'utf8'));
          } catch (err) {
            // FI-20/FI-31: same rule — ENOENT ("optional, not present") is
            // silent; any other read error is logged, err.name only.
            if (!isEnoent(err)) {
              ctx.logger(`hermes-codebase: nested .hermesignore read failed (${errName(err)})`);
            }
          }
          if (dirContents.length > 0) {
            dirAncestors = [...localAncestors, { dirRel, matches: createIgnoreFilter(dirContents) }];
            discoveredNestedDirs?.push(dirRel);
          }
        }

        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          const rel = toPosixRelative(path.relative(ctx.opts.workspaceRoot, abs));
          // Secret-path floor (W5-T6): a `.env`/`id_rsa`/`.aws/credentials`-
          // class file is skipped BEFORE it is ever read/chunked/embedded —
          // same classifier as the completion exfiltration gate (one
          // source of truth). This walk-time check is a PATH filter only;
          // it does not scan content, and it cannot be overridden by
          // `.gitignore` negation (defense in depth). SEC-1 (audit-3) adds
          // the missing CONTENT layer for files that pass this path filter
          // — see the `scanSnippetForSecrets` call in `reindexFiles` below,
          // the two layers together now mirror the completion path's
          // path+content gate.
          if (
            ignoreFilter(rel) ||
            isSecretForCompletion(rel) ||
            matchesNestedIgnore(dirAncestors, rel)
          ) {
            continue;
          }
          if (entry.isDirectory()) {
            visitDir(abs, dirAncestors); // schedules; does NOT await here
          } else if (entry.isFile()) {
            out.push(abs);
          }
        }
      }),
    );
  };

  visitDir(root, ancestors);
  // Drain: `pending` grows as directories are discovered; re-read its
  // (growing) length on every pass rather than snapshotting it up front.
  for (let i = 0; i < pending.length; i++) {
    await pending[i];
  }
}

/**
 * Embeds and upserts `absPaths`. `expectedWidth` is the effective width
 * this call must enforce (Task 14b's single check site lives inside
 * `embedder.embed` — see `computeEffectiveWidth`'s doc comment for how the
 * caller decides this value); a mismatch throws and NOTHING from this call
 * reaches `store.upsert`.
 *
 * Returns the OBSERVED width of the first vector produced by the first
 * non-empty batch, or `undefined` if this call embedded nothing (e.g. the
 * diff found no files to recompute) — the caller uses this to decide what
 * to persist into the D-2 sidecar.
 *
 * Stream-and-reread (FI-42): `runBuild`'s hash pass (`~:537-543`) reads each
 * candidate once already, but only to hash it and release the buffer — it
 * does not retain the bytes. This function re-reads every changed path's
 * bytes itself below, exactly like the single-target watch path
 * (`handleFsEvent`) always has; both callers read once for the hash/verify
 * step and once here for the embed step, unconditionally.
 */
/**
 * AUDIT-5 Task 11: one reindex target = the abs path whose BYTES are read,
 * decoupled from the POSIX rel key the result is stored under. The watch
 * path reads the realpath-CONFINED result of resolveWithinWorkspaceReal
 * (pathConfine's contract: "read exactly the returned path so the file
 * that was validated is the file that is read") while storing under the
 * ALIAS relPath its gate/secret/delete branches key on. runBuild passes
 * readAbsPath = join(workspaceRoot, rel) with storeRelPath = rel — the
 * identical pair the old single-argument shape derived, since walk() skips
 * symlinks and toCompute keys round-trip losslessly through path.join.
 */
export interface ReindexTarget {
  readAbsPath: string;
  storeRelPath: string;
}

/**
 * F6-3 (FI-08) / M-16: the phase-1/phase-2 hand-off shared between
 * `buildPendingRecords` and `embedAndSwap`. The MAP's identity is fixed the
 * moment `buildPendingRecords` returns it (typed `ReadonlyMap` at that
 * boundary — no `.set`/`.delete` afterward), but each VALUE stays a mutable
 * object so `embedAndSwap` can flip `deleted`/decrement `remaining` in
 * place as the swap progresses. That is what lets a
 * `Map<string, MutablePathState>` widen to
 * `ReadonlyMap<string, MutablePathState>` with no cast: only the container
 * is read-only, not what it points at.
 */
type MutablePathState = { contentHash: string; remaining: number; deleted: boolean };

/**
 * F6-3 (FI-08): phase 1 of `reindexFiles` — reads and chunks every target,
 * building the pending embed queue and its per-path swap bookkeeping.
 * Returns `{ disposed: true }` (never `undefined`) the moment either
 * `isDisposed` guard fires, so `reindexFiles` can tell "nothing to embed"
 * apart from "torn down mid-read" at the call site.
 */
async function buildPendingRecords(
  // FI-18: reads `ctx.isDisposed`, `ctx.gate`/`ctx.store` (the purge-and-bail
  // and zero-chunk branches), `ctx.parser`, and `ctx.opts.maxChunkTokens`.
  // FI-20/FI-31 (F6-6): also reads `ctx.logger`, threaded straight through to
  // `chunkFile`'s injected logger (`chunker.ts`'s AST-failure log).
  ctx: IndexerStoreCtx & IndexerLogCtx & Pick<IndexerContextBag, 'isDisposed' | 'parser' | 'opts'>,
  targets: ReindexTarget[],
  manifest: Record<string, string>,
): Promise<{ records: ChunkRecord[]; pathState: ReadonlyMap<string, MutablePathState> } | { disposed: true }> {
  // TA-5 (AU-23, Med) / INV-5: `ensureStoreInitialized` above is itself an
  // await — `dispose()` may have fired while it was pending (this function
  // is reached both from the watch-path debounce body below and from
  // `runBuild`, either of which can race a shutdown). Re-check here, at
  // this function's own entry, so no chunk from `targets` reaches
  // `store.deleteByPath`/`store.upsert` once disposed.
  if (ctx.isDisposed()) return { disposed: true };
  const pendingRecords: ChunkRecord[] = [];
  // TA-3 (AU-3, Rev-1 A3) / INV-3: "old rows for a path are deleted only
  // after their replacement vectors exist." Per-path swap bookkeeping for
  // the bounded per-BATCH embed-then-swap below: `deleted` flips true the
  // moment this path's stale rows are actually purged (at most once, at
  // its FIRST batch); `remaining` counts this path's records not yet
  // upserted and reaches 0 exactly when every one of its replacement
  // chunks is safely in the store — that is the ONLY moment
  // `manifest[relPath]` is written (below). A path that throws mid-swap
  // (deleted but remaining > 0) is scrubbed from `manifest` in the catch
  // below instead of being left to claim rows that are gone — HEAD's bug
  // was exactly that stale claim surviving a partial/transient failure.
  const pathState = new Map<string, MutablePathState>();

  for (const { readAbsPath, storeRelPath: relPath } of targets) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(readAbsPath);
    } catch {
      continue; // deleted between walk and read; the delete pass handles it.
    }
    if (buf.byteLength > MAX_FILE_BYTES || looksBinary(buf)) {
      // TA-6 (AU-24, Med) / INV-3: at HEAD this `continue` fired BEFORE any
      // purge — a previously-indexed file that grows past the size cap or
      // turns binary kept its OLD (now-wrong) chunks in the store, and its
      // manifest entry kept claiming it indexed, forever. The single-target
      // watch call has no diff pass to self-heal this the way `runBuild`
      // does (oversize/binary files simply drop out of `current`, and
      // `diff.toDelete` purges them there, `:539-549,585-588`). Purge this
      // path's stale rows and its manifest entry NOW, in the same op as the
      // bail — idempotent and harmless on the build path too (these rows
      // would be purged by the diff anyway).
      await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
      // TA-5 / INV-5: the purge above is an await — `dispose()` may have
      // fired while it was in flight. Re-check before the manifest mutation
      // that follows it (same discipline as every other await-then-mutate
      // site in this function); bail with no observed width yet, matching
      // this loop's own entry guard above (`if (disposed) return undefined;`).
      if (ctx.isDisposed()) return { disposed: true };
      delete manifest[relPath];
      continue;
    }
    const contents = buf.toString('utf8');
    const contentHash = hashContent(contents);
    const extension = path.extname(relPath).slice(1);
    const languageId = EXTENSION_TO_LANGUAGE_ID[extension];

    // TA-3 (AU-3): no delete here anymore — purging a path's stale rows is
    // now deferred to the embed-then-swap step below, so they survive
    // until THIS path's replacement vectors actually exist. HEAD deleted
    // here, unconditionally, before any embedding was even attempted — a
    // transient embed failure on a byte-identical watch re-save then left
    // the rows gone with no replacement and an unchanged manifest hash,
    // making the file invisible to search forever.
    const chunks = await chunkFile({
      relPath,
      contents,
      languageId: languageId ?? extension,
      extension,
      logger: ctx.logger,
      ...(languageId ? { parser: ctx.parser } : {}),
      ...(ctx.opts.maxChunkTokens !== undefined ? { maxChunkTokens: ctx.opts.maxChunkTokens } : {}),
    });

    let recordCount = 0;
    chunks.forEach((chunk, i) => {
      // SEC-1 (audit-3): Layer-2 CONTENT gate, mirroring the completion
      // path. Drop the POSITIVE CHUNK ONLY (not the whole file) so index
      // coverage survives — AISVS 8.2.1 "dropped based on policy". Silent
      // drop: the scanner's verdict is text-free (ruleId only) and NOTHING
      // is logged here.
      if (!scanSnippetForSecrets({ path: relPath, content: chunk.headeredContent }).allowed) return;
      pendingRecords.push({
        id: createHash('sha256')
          .update(`${relPath}:${chunk.startLine}-${chunk.endLine}:${i}`)
          .digest('hex'),
        path: relPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.headeredContent,
        contentHash,
        // TA-1 (AU-1, Critical): `language` must NEVER be undefined in a
        // ChunkRecord — an extension with no `EXTENSION_TO_LANGUAGE_ID`
        // entry (md/json/yml/txt/… — a docs-first repo's FIRST files in
        // walk order) used to leave every one of its chunks' `language`
        // undefined. A docs-first first upsert batch, all-undefined, makes
        // LanceDB's schema INFERENCE at `createTable` drop the `language`
        // column entirely (V1) — every later real-language upsert then
        // throws `Found field not in schema: language` and every
        // `hybridSearch` throws too, forever. `'text'` is also a better
        // retrieval value than absent: `hybridSearch`'s language filter
        // and `formatHitAsText`'s fence tag both consume it. Deliberately
        // `languageId` (the raw, possibly-undefined lookup) rather than a
        // defaulted variable — `chunkFile`'s `languageId`/`parser`
        // arguments just above keep their CURRENT semantics (unmapped
        // extensions still skip AST parsing) unaffected by this default.
        language: languageId ?? 'text',
        vector: [],
      });
      recordCount++;
    });

    if (recordCount === 0) {
      // TA-3: no chunk survived the content gate (or the file has no
      // indexable content) — there is nothing for a future batch to
      // replace, so this path never enters the deferred swap below. Purge
      // any stale rows now and record the hash immediately: this mirrors
      // HEAD's behavior for this exact case (which also never reaches the
      // embed step, so there is no failure window to protect against).
      await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
      manifest[relPath] = contentHash;
    } else {
      pathState.set(relPath, { contentHash, remaining: recordCount, deleted: false });
    }
  }

  return { records: pendingRecords, pathState };
}

/**
 * F6-3 (FI-08): phase 2 of `reindexFiles` — embeds `records` in bounded
 * batches and swaps each represented path's stale rows for its freshly
 * embedded ones, mutating `pathState`'s VALUE objects (never the map
 * itself, per M-16) and `manifest` in place as each path finalizes. Runs
 * the TA-3 catch-scrub on any embed/store failure before rethrowing.
 */
async function embedAndSwap(
  // FI-18: reads `ctx.embedder`, `ctx.isDisposed`, and `ctx.gate`/`ctx.store`
  // (the per-batch delete-before-upsert swap). No manifest/ignore/logger use.
  ctx: IndexerStoreCtx & Pick<IndexerContextBag, 'embedder' | 'isDisposed'>,
  records: ChunkRecord[],
  pathState: ReadonlyMap<string, MutablePathState>,
  manifest: Record<string, string>,
  expectedWidth: number | undefined,
): Promise<number | undefined> {
  // Embed in batches (how-to §2.4: ~64-200 per request); per batch, swap:
  // a path's stale rows are purged only once ITS replacement vectors exist
  // (this batch), then the batch is upserted. TA-3 (AU-3, Rev-1 A3):
  // bounded to ONE batch of pending vectors resident at a time — NOT an
  // all-batches-first buffer (which would hold every vector in memory,
  // 300+MB on a large repo).
  let observedWidth: number | undefined;
  try {
    for (let i = 0; i < records.length; i += EMBED_BATCH_SIZE) {
      const batch = records.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await ctx.embedder.embed(
        batch.map((r) => r.content),
        // TA-2 (AU-5, Rev-1 A2) / INV-2 (restated): "one BUILD = one width
        // once first observed". `expectedWidth` alone is only the width
        // DECLARED before this build started (`computeEffectiveWidth`) —
        // when that's undefined (first-ever build, dims=0), every batch used
        // to be called with `expectedWidth` unchanged, so batch 2 could
        // return a different-but-internally-consistent width than batch 1
        // and slip past `embedBatch`'s intra-batch check silently (V2's
        // corruption). Once batch 1's width has been OBSERVED (below), it
        // becomes the enforced width for every remaining batch of this same
        // build — `expectedWidth` (a real caller decision) still wins if the
        // caller declared one.
        expectedWidth ?? observedWidth,
      );
      // TA-5 (AU-23, Critical remediation) / INV-5: `embedder.embed` above
      // is a network await — `dispose()` may have fired while it was in
      // flight. Re-check before this batch's mutations
      // (`store.deleteByPath`/`store.upsert` below, and the manifest
      // writes in the per-record loop that follows them). Do NOT rely on
      // `requireDb()` throwing when the store is closed to catch this —
      // that's a different module's implementation detail, not this
      // function's contract. An earlier, already-embedded batch (if any)
      // already committed before dispose fired, which is fine — INV-5
      // only forbids mutations AFTER dispose. Bail with whatever width has
      // been observed so far, matching this function's real return
      // contract (`Promise<number | undefined>`).
      if (ctx.isDisposed()) return observedWidth;
      // Task 14b: record the width of the very first vector this build
      // actually produced, before any upsert — this is the value the NEXT
      // build's `computeEffectiveWidth` will enforce (and, per the above,
      // the value THIS build enforces on every later batch).
      if (observedWidth === undefined) {
        const first = vectors[0];
        if (first !== undefined) observedWidth = first.length;
      }
      batch.forEach((record, idx) => {
        // TA-2 (AU-5): `embedder.embed` already validated (parseEmbeddingsResponse's
        // count check + embedBatch's per-row shape check) that it returns
        // exactly one well-formed vector per input, in order — `vectors[idx]`
        // is therefore always defined here. The old `?? []` fallback let a
        // missing vector attach an empty one instead of failing loudly; that
        // silent path IS the bug (V2) and must die, not be preserved as a
        // defensive default.
        const vector = vectors[idx];
        if (vector === undefined) {
          throw new Error(
            'hermes-codebase: embedder returned fewer vectors than requested — refusing to upsert a record without a vector',
          );
        }
        record.vector = vector;
      });

      // TA-3 (AU-3) / INV-3: this batch's replacement vectors now exist —
      // safe to purge each represented path's stale rows, exactly once (a
      // path whose chunks span multiple batches is purged at its FIRST
      // batch only; `LanceDBStore.upsert`'s `mergeInsert('id')` keeps a
      // later batch's upsert idempotent — new ids insert, nothing to
      // update — against the now-emptied path).
      for (const relPath of new Set(batch.map((r) => r.path))) {
        const state = pathState.get(relPath);
        if (state && !state.deleted) {
          await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
          state.deleted = true;
        }
      }

      await ctx.gate.sink(() => ctx.store.upsert(batch));

      for (const record of batch) {
        const state = pathState.get(record.path);
        if (state) {
          state.remaining -= 1;
          // Every one of this path's replacement chunks is now safely in
          // the store — only NOW is it safe to claim it in the manifest.
          if (state.remaining === 0) {
            manifest[record.path] = state.contentHash;
          }
        }
        // Rev-1 A3 honest-memory note: release this record's (large)
        // vector now that the upsert has consumed it, so peak vector
        // residency stays ~one batch instead of the whole call.
        record.vector = [];
      }
    }
  } catch (err) {
    // TA-3 (AU-3) scrub: a path whose stale rows were already deleted but
    // whose replacement records did NOT all land must not keep (or gain) a
    // manifest entry — that would tell the next build's diff "no change,
    // skip" while its rows are gone/incomplete, exactly AU-3's
    // invisible-file bug. Paths this call never reached (delete never ran)
    // are left untouched here: their old rows are still intact, so
    // whatever `manifest` already held for them stays consistent.
    for (const [relPath, state] of pathState) {
      if (state.deleted && state.remaining > 0) {
        delete manifest[relPath];
      }
    }
    throw err;
  }
  return observedWidth;
}

export async function reindexFiles(
  // FI-18: `ctx.ensureStoreInitialized` directly, plus the union of what
  // `buildPendingRecords` and `embedAndSwap` need (both called with this
  // same `ctx`) — `IndexerStoreCtx` already covers `gate`/`store`/
  // `ensureStoreInitialized`; `isDisposed`/`parser`/`opts`/`embedder` are
  // the two callees' residual members. FI-20/FI-31 (F6-6): `IndexerLogCtx`
  // joins the Pick too — `buildPendingRecords` (called with this same `ctx`
  // below) now reads `ctx.logger`, so this function's own parameter type
  // must cover it for that call to typecheck.
  ctx: IndexerStoreCtx & IndexerLogCtx & Pick<IndexerContextBag, 'isDisposed' | 'parser' | 'opts' | 'embedder'>,
  targets: ReindexTarget[],
  manifest: Record<string, string>,
  expectedWidth: number | undefined,
): Promise<number | undefined> {
  await ctx.ensureStoreInitialized();
  const pending = await buildPendingRecords(ctx, targets, manifest);
  if ('disposed' in pending) return undefined;
  return embedAndSwap(ctx, pending.records, pending.pathState, manifest, expectedWidth);
}

export async function runBuild(
  // FI-18: reads the store role directly (`ensureStoreInitialized`/`gate`/
  // `store`), the full manifest role (`readManifest`/`writeManifest`/
  // `readMeta`/`writeMeta`/`computeEffectiveWidth`/`fingerprintMatches`) and
  // the full ignore role (`invalidateIgnoreFilterCache`/`loadIgnoreFilter`/
  // `setKnownNestedIgnoreDirs`) directly, plus `opts`/`isDisposed` directly
  // and `parser`/`embedder` transitively (passed on to `walk`/`reindexFiles`
  // below). FI-20/FI-31 (F6-6): `logger` is now used directly here too — the
  // hash-pass read catch (below) logs a non-ENOENT errno name via it,
  // mirroring `walk`'s own errno-name logging, and it's threaded on to
  // `walk`/`reindexFiles` (both now require it). `recordFailedIncrementalReindex`
  // remains `watchPipeline.ts`-only, correctly absent from this Pick.
  ctx: IndexerStoreCtx &
    IndexerManifestCtx &
    IndexerIgnoreCtx &
    IndexerLogCtx &
    Pick<IndexerContextBag, 'opts' | 'parser' | 'embedder' | 'isDisposed'>,
): Promise<void> {
  await ctx.ensureStoreInitialized();
  // AUDIT-5 Task 10: force a fresh ignore-filter read for every full
  // build, independent of whatever the watch path may already have
  // cached — a full build is exactly the point at which `.gitignore`/
  // `.hermesignore` edits made OUTSIDE the watcher (e.g. `git pull`, or
  // the file arriving before `watch()` was ever called) must be picked up.
  ctx.invalidateIgnoreFilterCache();
  const ignoreFilter = await ctx.loadIgnoreFilter();

  const absPaths: string[] = [];
  // TA-7 (AU-34) / INV-6: `walk()` discovers every nested
  // `.gitignore`/`.hermesignore` fresh as it descends this build (see its
  // own comment) — `discoveredNestedDirs` collects that discovery so the
  // watch path (which never calls `walk()`) can re-consult the SAME
  // directories on its own cache rebuilds until the next full build.
  const discoveredNestedDirs: string[] = [];
  await walk(ctx, ctx.opts.workspaceRoot, ignoreFilter, absPaths, [], discoveredNestedDirs);
  ctx.setKnownNestedIgnoreDirs(discoveredNestedDirs);

  const current: Record<string, string> = {};
  // RAG-01: stream the hash pass — read each candidate ONCE, hash it,
  // release the buffer, next. Peak memory during hashing is one file (not
  // the whole repo). Changed files are re-read by reindexFiles; the embed
  // working set is already one-batch bounded (TA-3), so overall peak
  // scales with the changed set, not the repo size.
  for (const absPath of absPaths) {
    const relPath = toPosixRelative(path.relative(ctx.opts.workspaceRoot, absPath));
    try {
      const buf = await fs.readFile(absPath);
      if (buf.byteLength > MAX_FILE_BYTES || looksBinary(buf)) continue;
      current[relPath] = hashContent(buf.toString('utf8'));
    } catch (err) {
      // FI-20/FI-31: ENOENT (deleted between walk and this read) stays
      // silent — the documented case; any other errno is logged, err.name
      // only, never the path.
      if (!isEnoent(err)) {
        ctx.logger(`hermes-codebase: hash read failed (${errName(err)})`);
      }
      continue;
    }
  }

  const stored = await ctx.readManifest();

  // TA-5 (AU-23, Critical remediation) / INV-5: `readManifest()` above is
  // an await — `dispose()` may have fired while it was pending. `runBuild`
  // is an equally-long HTTP-embedding op as the incremental watch path
  // (e.g. deactivation mid-initial-index can race it exactly the same
  // way), so it gets the same "re-check after every await, before the
  // next mutation" discipline. Re-check here, before the self-heal
  // purge's first `store.deleteByPath`.
  if (ctx.isDisposed()) return;

  // Self-heal purge (W5-T6): an index built BEFORE the secret-path filter
  // existed may still have a `.env`/`credentials`-class path embedded and
  // sitting in the manifest. Purge any such stored entry unconditionally
  // on the first post-upgrade build, independent of whether `walk()`'s
  // filter above already excluded it from `current` — the "no secret path
  // survives in the manifest" invariant must hold even if the diffing path
  // changes later. This reads the REAL stored manifest, not gated by the
  // embed fingerprint below — a stale secret entry must be purged even on
  // the very first build after upgrading (when there is no fingerprint
  // sidecar yet at all).
  for (const relPath of Object.keys(stored)) {
    if (isSecretForCompletion(relPath)) {
      await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
      delete stored[relPath];
    }
  }

  const diff = diffContentHashes(current, stored);

  // Audit D-2: a changed embedding model makes every stored vector
  // incomparable with a freshly embedded query vector, even though the
  // ON-DISK CONTENT hasn't changed — `diffContentHashes` alone can't see
  // that, since it only compares content hashes. So when the fingerprint
  // doesn't match, force every current path into the recompute set (a full
  // rebuild) regardless of what the ordinary diff found. `toDelete` is left
  // untouched: a file that no longer exists must be purged from the vector
  // store no matter which model embedded it, so that cleanup must not be
  // gated by the fingerprint either.
  const storedMeta = await ctx.readMeta();
  const fingerprintOk = ctx.fingerprintMatches(storedMeta);
  const toCompute = fingerprintOk ? diff.toCompute : Object.keys(current);

  // TA-5 (AU-23, Critical remediation) / INV-5: `readMeta()` above is
  // another await, and the self-heal purge loop above it ran its own
  // per-iteration `store.deleteByPath` awaits too — re-check before this
  // next purge's mutations.
  if (ctx.isDisposed()) return;

  for (const relPath of diff.toDelete) {
    await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
    delete stored[relPath];
  }

  const manifest = { ...stored };
  // AUDIT-5 Task 11: read-path == store-path on the build path by
  // construction (walk() skips symlinks), so the pair is the identity
  // round-trip of the old single-argument shape.
  const toComputeTargets = toCompute.map((rel) => ({
    readAbsPath: path.join(ctx.opts.workspaceRoot, rel),
    storeRelPath: rel,
  }));
  const effectiveWidth = ctx.computeEffectiveWidth(storedMeta);
  let observedWidth: number | undefined;
  try {
    observedWidth = await reindexFiles(ctx, toComputeTargets, manifest, effectiveWidth);
  } catch (err) {
    // TA-3 (AU-3): persist whatever scrub `reindexFiles` already applied
    // to `manifest` even though this build failed — otherwise a
    // partial-failure path's stale manifest entry (claiming rows that are
    // now gone) would survive on disk untouched until some LATER build
    // happens to recompute it, or forever if its content hash never
    // changes again. `writeMeta` is intentionally NOT called on this arm
    // — it records what THIS build observed, and this build did not
    // complete.
    //
    // TA-5 (AU-23, Critical remediation) / INV-5: `reindexFiles` above
    // awaits `embedder.embed` per batch — `dispose()` can fire mid-flight
    // and the embed loop bails cleanly, possibly after an earlier batch's
    // scrub already stripped a manifest entry. Writing that stripped
    // `manifest` to disk AFTER dispose is the same orphan/drift defect as
    // the incremental path's — skip the write, still propagate the error.
    if (ctx.isDisposed()) throw err;
    await ctx.gate.sink(() => ctx.writeManifest(manifest));
    throw err;
  }

  // TA-5 (AU-23, Critical remediation) / INV-5: same hazard as the catch
  // arm above, for the non-throwing (success) case.
  if (ctx.isDisposed()) return;
  await ctx.gate.sink(() => ctx.writeManifest(manifest));
  // Task 14b: if this build embedded nothing (nothing changed, or a
  // fingerprint mismatch found zero files to recompute), there is no NEW
  // observation to record — preserve whatever width the fingerprint-matched
  // sidecar already held rather than dropping it. Dropping it here would
  // silently re-open the dims=0 protection gap on the very next no-op
  // build, since `writeMeta` always overwrites the whole sidecar file.
  //
  // TA-5 (AU-23, Critical remediation) / INV-5: `writeManifest` above is
  // itself an await — re-check once more before this last mutation too.
  if (ctx.isDisposed()) return;
  await ctx.gate.sink(() => ctx.writeMeta(observedWidth ?? (fingerprintOk ? storedMeta?.width : undefined)));
}
