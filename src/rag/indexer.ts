import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as vscode from 'vscode';

// W6-FC (final-3way-arch.md I-6): import the pure classifier directly from
// `shared/secretPaths.ts` — the RAG indexer is an egress-only consumer, not
// a host-policy one.
import { isSecretForCompletion } from '../shared/secretPaths';
import { isRecord } from '../shared/typeGuards';
// T-19 (C1+C2): createIgnoreFilter moved to shared/ignoreFilter.ts; toPosixRelative stayed in ./gitignore.
import { createIgnoreFilter } from '../shared/ignoreFilter';
// AUDIT-5 ARCH-2: the SAME symlink-aware containment primitive every other
// content-ingestion channel uses (readTextFile, attachments, mentions,
// checkpoints). Imported from its frozen home rather than relocated to
// shared/ — pathConfine.ts is sha256-frozen-adjacent policy code (do not
// modify/move), is pure Node (no vscode import), and host/checkpoints +
// host/context already import it cross-subzone the same way.
import { resolveWithinWorkspaceReal } from '../host/backend/acp/pathConfine';
// AUDIT-5 ARCH-3 (F-6): node-ignore's OWN exported path validator — the
// library's documented contract is that out-of-scope input (absolute,
// '../…', '', '.') THROWS since 5.0.0, and callers pre-filter with
// isPathValid (README "Upgrade 4.x -> 5.x": `.filter(isPathValid)`).
// Same division of labor as ripgrep (the walker guarantees scope; the
// matcher asserts) — see the F-6 fork record + Appendix 8/P5.
import { isPathValid } from 'ignore';
// B8 (FUNC-INDEXER): `runBuild`/`reindexFiles`/`walk` (+ the nested-ignore
// helpers `loadIgnoreFilter` below still needs) now live in their own
// module — this factory builds the `IndexerContext` bag and delegates.
import {
  matchesNestedIgnore,
  reindexFiles,
  runBuild,
  type IndexerContext,
  type NestedIgnoreEntry,
} from './buildPipeline';
import { HttpEmbedder } from './embedder';
import { toPosixRelative } from './gitignore';
import { WebTreeSitterParser } from './parser/WebTreeSitterParser';
import { LanceDBStore } from './store/LanceDBStore';
import type { VectorStore } from './store/VectorStore';
import { createMutationGate } from '../host/util/mutationGate';

export interface IndexerOptions {
  workspaceRoot: string;
  indexDir: string;
  embedEndpoint: string;
  embedModel: string;
  /**
   * Optional Matryoshka truncation width. `0`/undefined = "let the server
   * decide", which is the default: audit D-1 showed llama.cpp ignores the
   * field, Ollama truncates, and vLLM answers 400 for a non-Matryoshka model,
   * killing the whole build. The LanceDB schema width is a separate concept,
   * enforced per-build via `computeEffectiveWidth` (Task 14b) — it also
   * catches a same-name model swap at `dims=0`, not just a declared `dims`
   * mismatch.
   */
  dims?: number;
  maxChunkTokens?: number;
  /** File-watcher debounce, ms (how-to §6: ~300-800ms). */
  debounceMs?: number;
  /** Extra ignore globs beyond `.gitignore`/`.hermesignore` (e.g. `talaria.rag.excludeGlobs`). */
  extraIgnoreGlobs?: string[];
  /**
   * Directory containing the `tree-sitter-*.wasm` grammar files. Must resolve
   * to the *extension's own* `node_modules/tree-sitter-wasms/out` (via
   * `context.asAbsolutePath(...)` in `extension.ts`), NOT the user's
   * workspace — the workspace may not have `tree-sitter-wasms` installed at
   * all. Defaults to `<workspaceRoot>/node_modules/tree-sitter-wasms/out` for
   * back-compat with existing callers/tests that don't pass it.
   */
  grammarsDir?: string;
  /**
   * F2-12: injected log seam for this indexer's own failure lines (the
   * incremental-reindex-failed line below) AND threaded through to the
   * `LanceDBStore` it constructs. Default `console.error` — behavior-
   * identical where unwired.
   */
  logger?: (line: string) => void;
}

export interface Indexer {
  build(): Promise<void>;
  watch(): vscode.Disposable;
  dispose(): void;
  /**
   * F2-12: CUMULATIVE count of incremental (debounced watch-path) reindex
   * failures over this indexer's lifetime. Exposed as a getter so a caller
   * (today: nothing reads it directly — the OutputChannel line IS the
   * user-visible surface; tomorrow: a RAG panel, none exists at HEAD) can
   * surface it.
   */
  readonly failedIncrementalReindexes: () => number;
}

const MANIFEST_FILE = 'manifest.json';
// SEC-1 (audit-3) / F-3b: bump this when secretScanner.ts's rules change so
// every workspace re-scans its whole index on upgrade — see `IndexMeta.
// scannerVersion` and `fingerprintMatches` below. A rule-set change can only
// make MORE content newly-detected as a secret; an index built under an
// older, narrower rule set may still hold content that the current rules
// would now drop, and there is no other signal that would ever force that
// content back through the (now-stricter) content gate.
const SCANNER_VERSION = 1;

/**
 * B8 (FUNC-INDEXER): hoisted from a local declaration inside `createIndexer`
 * to module scope (and exported) so `buildPipeline.ts`'s `IndexerContext`
 * can name it too — a pure, zero-runtime-effect relocation (types are erased
 * at compile time; this changes nothing at runtime).
 */
export interface IndexMeta {
  /**
   * TA-1 (AU-1, Critical): bumped 1 -> 2 for the pinned-Arrow-schema +
   * init-time self-heal fix. A stored sidecar with the pre-bump value
   * (including a legacy sidecar predating this field's existence, which
   * `JSON.parse`s to `undefined !== 2`) makes `fingerprintMatches` fail
   * exactly once, forcing a full recompute of every current path — the
   * same established `scannerVersion` one-time-full-re-embed precedent
   * below. This is required, not cosmetic: `LanceDBStore.init()`'s
   * self-heal drops a legacy language-less table on disk, and without
   * this bump an intact manifest would keep claiming those paths are
   * indexed while the recreated table is actually empty.
   */
  schema: 2;
  embedModel: string;
  dims: number;
  /**
   * Task 14b: the OBSERVED width of vectors this build actually produced
   * (`vectors[0].length` of the first non-empty embed batch), not a
   * configured/declared value. Optional — absent on a first build (nothing
   * has been observed yet) and on a legacy sidecar written before this
   * field existed; both must still parse.
   *
   * This exists because `talaria.rag.dims` defaults to 0 ("let the server
   * decide"), and at dims=0 nothing else records what width the server
   * actually returned. Verified empirically (see embedder.ts's comment on
   * `expectedWidth`): LanceDB's `mergeInsert(...).execute()` does not
   * reject a wrong-width vector — it silently truncates or null-pads it —
   * so a same-name model swap that changes width would otherwise corrupt
   * the index with no error at all. Recording the width here lets the
   * NEXT build compare against it even when dims=0.
   */
  width?: number;
  /**
   * SEC-1 (audit-3) / F-3b: the `SCANNER_VERSION` this build's index was
   * written under. Optional — like `width?`, a legacy sidecar written
   * before this field existed still `JSON.parse`s and casts cleanly, and
   * simply reads back as `undefined` here.
   *
   * Folding this into the SAME fingerprint `writeMeta`/`fingerprintMatches`
   * already use for `embedModel`/`dims` reuses the existing "mismatch ->
   * force a full recompute of every current path" machinery (see
   * `fingerprintMatches` and its caller in `runBuild`) to also cover a
   * secret-scanner upgrade: content embedded under an older/absent scanner
   * may still hold a secret the CURRENT rules would now catch, and nothing
   * else would ever re-examine already-unchanged file content to find that
   * out. An `undefined === 1` comparison on a legacy sidecar deliberately
   * evaluates to `false` (mismatch), forcing exactly one full re-embed the
   * first time a workspace opens under this fix.
   */
  scannerVersion?: number;
}

/**
 * Extension-host indexer: owns the workspace walk, file watcher, chunking,
 * embedding calls, and `VectorStore` writes (how-to §6/§7 — "the extension
 * host owns indexing ... the MCP process only queries"). All native/HTTP
 * surface is behind `CodeParser`/`HttpEmbedder`/`VectorStore`; this file is
 * orchestration glue (mirrors Continue's `CodebaseIndexer.ts`) rather than a
 * unit-tested pure module — every pure decision it delegates to
 * (`diffContentHashes`, `chunkFile`, `createIgnoreFilter`) has its own
 * co-located tests.
 */
export function createIndexer(opts: IndexerOptions): Indexer {
  // F2-12: default `console.error` — behavior-identical for every caller
  // that doesn't pass `logger` (unchanged today outside `extension.ts`).
  const logger: (line: string) => void = opts.logger ?? ((line) => console.error(line));
  const store: VectorStore = new LanceDBStore(opts.indexDir, { logger });
  const embedder = new HttpEmbedder({
    endpoint: opts.embedEndpoint,
    model: opts.embedModel,
    // Audit D-1: no silent default here either — 0/undefined means "don't
    // send the field", matching `buildEmbeddingsRequestBody`'s own floor.
    dimensions: opts.dims ?? 0,
  });
  // Task 14b: the width-refusal guard (embedder.ts) is now armed PER BUILD via
  // `computeEffectiveWidth`, not once here at construction — see that
  // function's doc comment for the full policy (declared `talaria.rag.dims`,
  // OR the width observed and recorded by a previous build once the D-2
  // fingerprint still matches). This is the SOLE width-check site; nothing
  // else in this file re-checks vector width.
  const parser = new WebTreeSitterParser({
    grammarsDir:
      opts.grammarsDir ?? path.join(opts.workspaceRoot, 'node_modules', 'tree-sitter-wasms', 'out'),
  });

  const manifestPath = path.join(opts.indexDir, MANIFEST_FILE);
  // AUDIT-5 ARCH-1: the index's own directory must never be walked, watched,
  // or indexed — the '**/*' watcher sees the manifest/meta/LanceDB writes,
  // and the manifest stores its own content hash, so without this a custom
  // in-workspace `talaria.rag.indexDir` becomes a permanent re-embed loop
  // (the default `.hermes/index` was protected only by the coincidental
  // literal `.hermes` in DEFAULT_IGNORE_PATTERNS — executed ignore@7 probe).
  // An explicit string-prefix predicate, NOT an appended ignore pattern:
  // glob metacharacters in a user-chosen dir name would silently break a
  // pattern-based exclusion (probe: pattern '/my [index]/' does not match
  // the literal 'my [index]/' path). Degenerate `indexDir == workspaceRoot`
  // (relIndexDir === '') adds no exclusion — excluding '' would exclude the
  // whole workspace; that config keeps today's (broken-by-config) behavior.
  const relIndexDir = toPosixRelative(path.relative(opts.workspaceRoot, opts.indexDir));
  const indexDirInsideWorkspace =
    relIndexDir !== '' && relIndexDir !== '..' && !relIndexDir.startsWith('../') && !path.isAbsolute(relIndexDir);
  function isUnderIndexDir(relPosixPath: string): boolean {
    return (
      indexDirInsideWorkspace &&
      (relPosixPath === relIndexDir || relPosixPath.startsWith(`${relIndexDir}/`))
    );
  }

  let disposed = false;
  // WS-R2 (FUNC-DISPOSED-ROOT): the structural disposed-guard. Every
  // store/manifest mutation routes through gate.sink(); dispose() flips it
  // (A4). The existing `if (disposed)` early-outs stay as harmless
  // optimizations — the CLASS (post-dispose mutation) dies at these four
  // sink families regardless of body-level vigilance.
  const gate = createMutationGate();
  // F2-12: cumulative count of `schedule()`'s catch firing — see the
  // `Indexer.failedIncrementalReindexes` doc comment.
  let failedIncrementalReindexesTotal = 0;

  // AUDIT-5 CR-B: memoized single-flight init — same idiom as
  // CheckpointTracker.init (CheckpointTracker.ts:289-297). The old
  // check-then-act flag (`if (storeInitialized) return; ... await
  // store.init(); storeInitialized = true;`) let a watcher event racing the
  // first build() run LanceDBStore.init() twice: the second connect()
  // reassigned this.db and orphaned the first native Connection un-closed.
  // A failed init clears the memo so the next caller retries — preserving
  // the old flag's "failures are retried" semantics exactly.
  let initPromise: Promise<void> | undefined;
  function ensureStoreInitialized(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        await fs.mkdir(opts.indexDir, { recursive: true });
        await store.init();
      })().catch((err: unknown) => {
        initPromise = undefined;
        throw err;
      });
    }
    return initPromise;
  }

  // AUDIT-5 Task 10 (perf): a `**/*` watcher fires `handleFsEvent` once per
  // saved file, and the pre-Task-10 shape re-read + re-parsed `.gitignore`/
  // `.hermesignore` from disk on EVERY one of those events even though the
  // ignore rules themselves almost never change between saves. Cached here
  // and invalidated (not just cleared once) at the two points the rules
  // actually can change: the start of every full build (`runBuild` — picks
  // up edits made outside the watcher, e.g. `git pull`), and any watch event
  // whose own path IS one of the ignore files (see `handleFsEvent`).
  let cachedIgnoreFilter: ((relPosixPath: string) => boolean) | undefined;

  // TA-7 (AU-34) / INV-6: directories (POSIX-relative to `workspaceRoot`,
  // excluding the root itself) that `walk()` found to contain their own
  // `.gitignore`/`.hermesignore` during the LAST completed full build.
  // `loadIgnoreFilter()` re-reads each of these fresh from disk on every
  // rebuild (same discipline as the root files below), so an EDIT to an
  // ALREADY-known nested ignore file is honored immediately on the watch
  // path — `walk()` itself never relies on this list (it discovers nested
  // ignore files live, on every full build, independent of what a PRIOR
  // build knew). A nested ignore file created in a directory NOT yet in
  // this list only takes effect starting with the NEXT full build (bounded
  // staleness — walk() will discover it then); this is the documented,
  // accepted YAGNI-scoped tradeoff (TA-7's rejected "shell out to `git
  // check-ignore` per event" alternative would close this gap at the cost
  // of a subprocess per watch event and breaking non-git workspaces).
  let knownNestedIgnoreDirs: string[] = [];

  async function readManifest(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch (err) {
      // F2-13: ENOENT is the ordinary "no index yet" case — fresh {}
      // SILENTLY. Any other read error (EACCES, EIO) is logged, then
      // treated as empty so the build recovers rather than throwing the
      // whole indexer down.
      if (!(err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT')) {
        logger(`hermes-codebase: manifest read failed (${err instanceof Error ? err.name : 'unknown'}) — rebuilding`);
      }
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // WV3-MIN-SYN: a manifest whose root is not a record of string hashes
      // is corrupt — treat it exactly like a missing manifest (full rebuild)
      // instead of letting junk masquerade as path→hash entries.
      if (!isRecord(parsed)) {
        logger('hermes-codebase: manifest is corrupt (not a record) — rebuilding');
        return {};
      }
      for (const value of Object.values(parsed)) {
        if (typeof value !== 'string') {
          logger('hermes-codebase: manifest is corrupt (non-string entry) — rebuilding');
          return {};
        }
      }
      return parsed as Record<string, string>;
    } catch {
      // F2-13: parse failure = corruption; NEVER a silent {}. The empty
      // return forces the diff to recompute every current path (full
      // rebuild) rather than masquerading as an ordinary first run.
      logger('hermes-codebase: manifest is corrupt (parse error) — rebuilding');
      return {};
    }
  }

  async function writeManifest(manifest: Record<string, string>): Promise<void> {
    // F2-13: crash-safe atomic replace — write the full JSON to a same-directory
    // temp file, then fs.rename(2), which is atomic on the target filesystem
    // (Linux), never leaving a torn/partial manifest a concurrent readManifest
    // could parse.
    const tmpPath = `${manifestPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf8');
    await fs.rename(tmpPath, manifestPath);
  }

  const metaPath = path.join(opts.indexDir, 'manifest.meta.json');

  function currentMeta(): IndexMeta {
    return { schema: 2, embedModel: opts.embedModel, dims: opts.dims ?? 0, scannerVersion: SCANNER_VERSION };
  }

  async function readMeta(): Promise<IndexMeta | undefined> {
    try {
      return JSON.parse(await fs.readFile(metaPath, 'utf8')) as IndexMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Audit D-2: the manifest is path -> contentHash and nothing else, and
   * `indexDir` does not depend on the embedding model or its width. Change the
   * model and every stored vector becomes incomparable with every new query
   * vector — search degrades silently and permanently, because content hashes
   * still match and nothing is recomputed. The fingerprint (`fingerprintMatches`
   * above) makes that detectable.
   *
   * This intentionally reports a MISMATCH (not a match) only — it does not
   * hand back a manifest to use. An earlier version of this fix discarded the
   * whole stored manifest (`return {}`) on a mismatch, which silently starved
   * BOTH the self-heal secret-purge loop below (W5-T6: it iterates the stored
   * manifest to find and delete stale secret-path vector rows) and the
   * ordinary deleted-file cleanup (`diffContentHashes`'s `toDelete`, which
   * also needs the real stored path set) on every first post-upgrade build —
   * caught by the existing B-10 regression test. So `runBuild` below reads
   * the real, un-gated manifest for purge/delete purposes and uses the
   * fingerprint flag ONLY to decide whether stored content hashes (and the
   * stored width) may still be trusted.
   */
  function fingerprintMatches(stored: IndexMeta | undefined): boolean {
    const want = currentMeta();
    return (
      stored?.schema === 2 &&
      stored.embedModel === want.embedModel &&
      stored.dims === want.dims &&
      stored.scannerVersion === want.scannerVersion
    );
  }

  /**
   * Task 14b / final-review Finding 1: the single width-check site is
   * `HttpEmbedder.embed`'s `expectedWidth` parameter (embedder.ts) — this
   * function only DECIDES what value to pass it, it does not itself check
   * anything. The decision: prefer the width OBSERVED and stored on a
   * previous build, whenever one is on record; otherwise fall back to the
   * width the user explicitly declared via `talaria.rag.dims` (Task 14's
   * existing D-1 arming, unchanged); otherwise there is nothing to enforce
   * yet (first build, dims=0 — bootstrapping).
   *
   * The stored width is used UNCONDITIONALLY — not only when the D-2
   * fingerprint (model name + dims) still matches. The LanceDB table's
   * vector width is fixed at `createTable` time and `LanceDBStore.init()`
   * only OPENS an existing table, it never recreates one — a fingerprint
   * MISMATCH (e.g. the embedModel NAME changed) already forces every file
   * back into the recompute set, but that recompute still upserts into the
   * SAME fixed-width table. Gating the width check on the fingerprint (the
   * previous behaviour) left this refusal disarmed at the default
   * `talaria.rag.dims=0` on exactly a model-name change: `mergeInsert(...)`
   * does not reject a wrong-width row, it silently truncates or null-pads it
   * (Task 14b's embedder.ts comment) — so a new model with a different
   * native width would have corrupted the index with no error at all. This
   * function no longer needs the fingerprint flag; the caller still uses it
   * separately to decide whether to force a full recompute.
   */
  function computeEffectiveWidth(storedMeta: IndexMeta | undefined): number | undefined {
    if (typeof storedMeta?.width === 'number' && storedMeta.width > 0) {
      return storedMeta.width;
    }
    return opts.dims && opts.dims > 0 ? opts.dims : undefined;
  }

  async function writeMeta(observedWidth: number | undefined): Promise<void> {
    const meta = currentMeta();
    if (observedWidth !== undefined) {
      meta.width = observedWidth;
    }
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');
  }

  async function loadIgnoreFilter(): Promise<(relPosixPath: string) => boolean> {
    // AUDIT-5 Task 10: serve the cached predicate when one is live — see the
    // `cachedIgnoreFilter` declaration above for the invalidation contract.
    if (cachedIgnoreFilter) return cachedIgnoreFilter;
    const gitignoreContents: string[] = [];
    try {
      gitignoreContents.push(await fs.readFile(path.join(opts.workspaceRoot, '.gitignore'), 'utf8'));
    } catch {
      // no .gitignore — defaults still apply.
    }
    try {
      gitignoreContents.push(await fs.readFile(path.join(opts.workspaceRoot, '.hermesignore'), 'utf8'));
    } catch {
      // optional
    }
    const base = createIgnoreFilter(gitignoreContents, opts.extraIgnoreGlobs ?? []);

    // TA-7 (AU-34) / INV-6: layer in nested per-directory ignore files
    // discovered during the LAST full build's walk (`knownNestedIgnoreDirs`
    // above) — re-read fresh from disk on every rebuild of this predicate so
    // an edit to an already-known nested `.gitignore`/`.hermesignore` is
    // honored immediately on the watch path (handleFsEvent never calls
    // walk(), so this is the ONLY place the watch path learns nested rules).
    const nested: NestedIgnoreEntry[] = [];
    for (const dirRel of knownNestedIgnoreDirs) {
      const nestedContents: string[] = [];
      try {
        nestedContents.push(await fs.readFile(path.join(opts.workspaceRoot, dirRel, '.gitignore'), 'utf8'));
      } catch {
        // deleted since the last build — fall through to .hermesignore/empty.
      }
      try {
        nestedContents.push(
          await fs.readFile(path.join(opts.workspaceRoot, dirRel, '.hermesignore'), 'utf8'),
        );
      } catch {
        // optional
      }
      if (nestedContents.length === 0) continue;
      nested.push({ dirRel, matches: createIgnoreFilter(nestedContents) });
    }

    // AUDIT-5 ARCH-1: fold the indexDir self-exclusion into the ONE filter
    // both runBuild's walk() and handleFsEvent already share.
    const filter = (relPosixPath: string): boolean =>
      isUnderIndexDir(relPosixPath) || base(relPosixPath) || matchesNestedIgnore(nested, relPosixPath);
    cachedIgnoreFilter = filter;
    return filter;
  }

  // B8 (FUNC-INDEXER): the explicit deps bag `buildPipeline.ts`'s
  // `runBuild`/`reindexFiles`/`walk` (and `watchPipeline.ts`'s
  // `createWatch`) receive instead of closing over this factory directly.
  // `fs` is deliberately NOT a field here — see `IndexerContext`'s doc
  // comment in buildPipeline.ts for why.
  const ctx: IndexerContext = {
    opts,
    store,
    embedder,
    gate,
    parser,
    isDisposed: () => disposed,
    ensureStoreInitialized,
    readManifest,
    writeManifest,
    readMeta,
    writeMeta,
    computeEffectiveWidth,
    fingerprintMatches,
    loadIgnoreFilter,
    invalidateIgnoreFilterCache: () => {
      cachedIgnoreFilter = undefined;
    },
    setKnownNestedIgnoreDirs: (dirs) => {
      knownNestedIgnoreDirs = dirs;
    },
  };

  // Audit D-5: `build()` is a read-modify-write over one manifest file and is
  // driven by DEBOUNCED filesystem events, so two overlapping runs could
  // interleave their reads and writes and lose entries. A single promise chain
  // makes overlapping calls queue instead of race. No locking primitive is
  // needed: this is one process, one factory instance.
  let buildChain: Promise<void> = Promise.resolve();
  function serialize(run: () => Promise<void>): Promise<void> {
    buildChain = buildChain.then(run, run);
    return buildChain;
  }

  function build(): Promise<void> {
    return serialize(() => runBuild(ctx));
  }

  function watch(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const debounceMs = opts.debounceMs ?? 500;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    async function handleFsEvent(uri: vscode.Uri, kind: 'change' | 'delete'): Promise<void> {
      if (disposed) return;
      const relPath = toPosixRelative(path.relative(opts.workspaceRoot, uri.fsPath));
      // AUDIT-5 ARCH-3 (F-6): a STRING glob watcher spans ALL workspace
      // folders ("Providing a string as globPattern is a convenience for
      // watching all opened workspace folders" — VS Code API doc), but this
      // indexer serves exactly one root (B-13: folder [0] only). A
      // sibling-folder event relativizes to '../…' (or an absolute path on a
      // cross-drive Windows dev box), which ignore@7 rejects with RangeError
      // BY DOCUMENTED DESIGN — and ships isPathValid for exactly this
      // caller-side pre-check (executed probe: rejects '', '.', '..',
      // '../…', '/abs', 'C:/abs'). Not ours — return. Do NOT swallow
      // out-of-scope paths inside createIgnoreFilter instead: the shared
      // filter's loud throw is its contract (pinned in ignoreFilter.test.ts).
      if (!isPathValid(relPath)) return;
      // AUDIT-5 Task 10 (extended by TA-7/AU-34): the cached ignore filter
      // goes stale the moment one of the ignore files itself changes (edit
      // OR delete) — invalidate BEFORE this event's own loadIgnoreFilter()
      // call so this event, and every event after it, sees the new rules
      // immediately. Originally root-only; TA-7 extends this to any NESTED
      // `.gitignore`/`.hermesignore` too (INV-6) — `loadIgnoreFilter()`
      // re-reads every directory in `knownNestedIgnoreDirs` fresh on rebuild,
      // so this correctly picks up an edit to an already-known nested ignore
      // file. A nested ignore file in a directory NOT yet known (never
      // walked) is a no-op here either way — see `knownNestedIgnoreDirs`'s
      // own comment for the documented bounded staleness.
      if (
        relPath === '.gitignore' ||
        relPath === '.hermesignore' ||
        relPath.endsWith('/.gitignore') ||
        relPath.endsWith('/.hermesignore')
      ) {
        cachedIgnoreFilter = undefined;
      }
      const ignoreFilter = await loadIgnoreFilter();
      if (ignoreFilter(relPath)) return;

      await ensureStoreInitialized();

      // Audit D-5: this is the same manifest-file read-modify-write hazard as
      // `build()` — a DIFFERENT file's debounced event can fire while this one
      // is still mid-flight (each key in `timers` debounces independently),
      // so two `handleFsEvent` calls (or one of these and a manual `build()`)
      // could otherwise interleave their read/write of `manifest.json` and
      // lose an entry. Route through the SAME `serialize()` queue as `build()`
      // so every manifest mutation, incremental or full, is totally ordered.
      await serialize(async () => {
        // TA-5 (AU-23, Med) / INV-5: this callback runs on the shared
        // `buildChain` — it may sit queued for a while after `serialize()`
        // enqueues it (a prior build/event may still be running), so
        // `disposed` can already be true by the time this body actually
        // starts. Bail before even reading the manifest.
        if (disposed) return;
        const manifest = await readManifest();
        if (kind === 'delete') {
          // TA-5 (AU-23, Med) / INV-5: `readManifest()` above is an await —
          // `dispose()` may have fired while it was pending. Re-check right
          // before this branch's first mutation so a post-dispose
          // continuation neither calls `store.deleteByPath` (a no-op on the
          // by-then-closed store, `LanceDBStore.ts:362-364`) NOR removes this
          // path's manifest entry — the exact orphan-row/manifest-drift
          // AU-23 named.
          if (disposed) return;
          await gate.sink(() => store.deleteByPath(relPath));
          delete manifest[relPath];
          // AUDIT-5 ARCH-5 (F-1 final): delete-event granularity is platform/
          // watcher-dependent — a directory delete may arrive as ONE event
          // for the dir with no per-file events, which used to leave every
          // row/manifest entry under it stale until the next full build. The
          // manifest enumerates every indexed path, so sweep it by prefix —
          // exact-match store deletes per swept key, no LIKE-predicate
          // escaping needed, idempotent when per-file events also arrive.
          for (const key of Object.keys(manifest)) {
            if (key.startsWith(`${relPath}/`)) {
              await gate.sink(() => store.deleteByPath(key));
              delete manifest[key];
            }
          }
          // AU-23 re-review (TA-5 completion) / INV-5: the loop above awaits
          // `store.deleteByPath` per swept key — `dispose()` can fire during
          // any one of those awaits, same hazard as every other await in
          // this function. The entry guard above only covers what precedes
          // the loop; re-check once more, after it, right before the write.
          if (disposed) return;
          await gate.sink(() => writeManifest(manifest));
          return;
        }
        if (isSecretForCompletion(relPath)) {
          // TA-5 (AU-23, Med) / INV-5: see the delete-kind branch above —
          // same re-check, same reason.
          if (disposed) return;
          // A newly-created/changed secret-path file (e.g. a fresh `.env`)
          // must never be indexed. Best-effort purge in case it was somehow
          // already stored (mirrors build()'s self-heal purge pass).
          await gate.sink(() => store.deleteByPath(relPath));
          delete manifest[relPath];
          // AU-23 re-review (TA-5 completion) / INV-5: the entry guard above
          // covers what precedes `store.deleteByPath`, not the await itself
          // — re-check once more before the write.
          if (disposed) return;
          await gate.sink(() => writeManifest(manifest));
          return;
        }
        // AUDIT-5 ARCH-2: watch/build symmetry + containment. runBuild's
        // walk() never indexes a symlink (Dirent.isFile()/isDirectory() are
        // lstat-semantics — both false for a link), but this incremental path
        // used to fs.readFile straight through one: a workspace-internal link
        // to $HOME/… got its TARGET chunked, POSTed to the embed endpoint,
        // and stored agent-searchable. Rule: lstat-refuse a leaf link, then
        // realpath-confine the path with the same primitive every other
        // ingestion channel uses; anything unconfinable is skipped AND purged
        // (mirrors the secret-path branch above). lstat ENOENT (vanished
        // between event and check) also lands here — purging a gone path is
        // the correct outcome. Accepted residual: a REGULAR file reached
        // through an in-workspace dir-symlink alias may index under the alias
        // relPath until the next full build drops it — benign and
        // self-healing; since Task 11 the BYTES embedded for it are
        // guaranteed to be the confined canonical target's (reindexFiles
        // reads `confined`, not the alias path), so only the alias KEY
        // remains, not a readable race.
        let confined: string | null = null;
        try {
          const leaf = await fs.lstat(uri.fsPath);
          confined = leaf.isSymbolicLink()
            ? null
            : await resolveWithinWorkspaceReal(uri.fsPath, [opts.workspaceRoot]);
        } catch {
          confined = null; // fail closed
        }
        if (confined === null) {
          // TA-5 (AU-23, Med) / INV-5: `fs.lstat`/`resolveWithinWorkspaceReal`
          // above both await — same re-check, same reason as the two
          // branches above.
          if (disposed) return;
          await gate.sink(() => store.deleteByPath(relPath));
          delete manifest[relPath];
          // AU-23 re-review (TA-5 completion) / INV-5: the entry guard above
          // covers what precedes `store.deleteByPath`, not the await itself
          // — re-check once more before the write.
          if (disposed) return;
          await gate.sink(() => writeManifest(manifest));
          return;
        }
        // Task 14b: the incremental path shares the SAME embedder instance
        // as `runBuild`, so it must enforce the SAME effective width — an
        // in-place model swap can just as easily be observed on a single
        // file's change-event as on a full build. This only READS the
        // sidecar (via `computeEffectiveWidth`); only `runBuild` ever WRITES
        // it, matching the existing scope of `writeMeta`/`manifest.meta.json`
        // to full builds.
        const storedMeta = await readMeta();
        const effectiveWidth = computeEffectiveWidth(storedMeta);
        // TA-5 (AU-23, Med) / INV-5: `readMeta()` above is an await too —
        // re-check once more before entering `reindexFiles`. This only
        // covers `reindexFiles`'s OWN entry point (and, since the CRITICAL
        // remediation below, its internal embed-batch loop too) — it says
        // nothing about dispose state once `reindexFiles` returns back HERE,
        // so the two `writeManifest` calls that follow are each re-checked
        // independently right below, not assumed covered by this one.
        if (disposed) return;
        // AUDIT-5 Task 11 (Task-1 review): read the path resolveWithinWorkspaceReal
        // VALIDATED (pathConfine contract: "read exactly the returned path so the
        // file that was validated is the file that is read") — a parent-dir
        // symlink re-pointed outside the workspace between the check above and
        // this read can no longer swap out-of-workspace bytes into the embed;
        // the read hits the CAPTURED canonical target instead. Store under the
        // alias relPath: the gate/secret/delete/dir-sweep branches all key on
        // it, so a canonical key here would orphan the row from every purge.
        try {
          await reindexFiles(
            ctx,
            [{ readAbsPath: confined, storeRelPath: relPath }],
            manifest,
            effectiveWidth,
          );
        } catch (err) {
          // TA-3 (AU-3): persist the scrub `reindexFiles` already applied to
          // `manifest` even though this incremental reindex failed — see
          // `runBuild`'s matching catch arm for the full rationale. Without
          // this write, a transient failure on a byte-identical re-save
          // would otherwise leave rows gone and the on-disk manifest
          // unchanged (same hash) — the file would look "unchanged, no
          // recompute needed" forever.
          //
          // TA-5 (AU-23, Critical remediation) / INV-5: `reindexFiles` above
          // AWAITS `embedder.embed` per batch — `dispose()` can fire while
          // that network call is in flight. If it does, TA-3's scrub above
          // may already have deleted this path's manifest entry (its stale
          // rows were purged but the replacement never fully landed).
          // Writing that stripped `manifest` to disk AFTER dispose is the
          // exact orphan/drift defect AU-23 named — on the commonest path
          // (every ordinary file change). Skip the write, still propagate.
          if (disposed) throw err;
          await gate.sink(() => writeManifest(manifest));
          throw err;
        }
        // TA-5 (AU-23, Critical remediation) / INV-5: same hazard as the
        // catch arm above, for the non-throwing (success) case — dispose()
        // firing during reindexFiles's embed await must not let this
        // continuation write `manifest` afterward.
        if (disposed) return;
        await gate.sink(() => writeManifest(manifest));
      });
    }

    const schedule = (uri: vscode.Uri, kind: 'change' | 'delete'): void => {
      const key = uri.fsPath;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          void handleFsEvent(uri, kind).catch((err: unknown) => {
            failedIncrementalReindexesTotal += 1;
            // F2-12 hygiene fix: the OLD line passed the raw `err` object to
            // `console.error` — an fs error's `.message` embeds the absolute
            // workspace path it failed on, leaking it into the log on every
            // failure. Errno-name idiom only (never `String(err)`/`.message`).
            logger(
              `hermes-codebase: incremental reindex failed: ${err instanceof Error ? err.name : 'unknown'}`,
            );
          });
        }, debounceMs),
      );
    };

    const subs = [
      watcher.onDidCreate((uri) => schedule(uri, 'change')),
      watcher.onDidChange((uri) => schedule(uri, 'change')),
      watcher.onDidDelete((uri) => schedule(uri, 'delete')),
      watcher,
      {
        // RAG-4: `disposed` (the top-level Indexer.dispose() flag) guards
        // handleFsEvent, but it is a SEPARATE lifecycle from disposing just
        // this watch()-returned Disposable (e.g. VS Code tearing down
        // context.subscriptions on deactivate while the Indexer object
        // itself survives). Without this, a debounce timer already scheduled
        // via schedule() keeps counting down and fires handleFsEvent after
        // the caller believed watching had stopped.
        dispose(): void {
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
        },
      },
    ];

    return vscode.Disposable.from(...subs);
  }

  function dispose(): void {
    disposed = true;
    // TA-5 (AU-23, Med) / INV-5: symmetry with `ensureStoreInitialized`'s own
    // clear-on-reject (`:191-194` above). Without this, a resolved
    // `initPromise` from before this dispose() memo-hits forever — any later
    // call that still reaches `ensureStoreInitialized()` would silently skip
    // `store.init()` instead of genuinely reinitializing against a fresh
    // (post-close) store.
    initPromise = undefined;
    // F3-11: flip the gate (sinks refused synchronously), await the in-flight
    // buildChain tail bounded by the drain deadline, THEN close the store — no
    // more closing under an active chain. gate.close never rejects/wedges.
    void gate.close(buildChain).finally(() => {
      void store.close();
    });
    // AU-35 (TA-9): the parser's cached `Parser`/`Tree` native handles were
    // never freed on indexer teardown before this — deferred here from
    // TA-5. Optional per `CodeParser` (a test stand-in owns no native
    // resources to free).
    parser.dispose?.();
  }

  return {
    build,
    watch,
    dispose,
    failedIncrementalReindexes: () => failedIncrementalReindexesTotal,
  };
}
