import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import * as vscode from 'vscode';

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
import { chunkFile } from './chunker';
import { diffContentHashes, hashContent } from './contentHash';
import { HttpEmbedder } from './embedder';
import { toPosixRelative } from './gitignore';
import { WebTreeSitterParser } from './parser/WebTreeSitterParser';
import { LanceDBStore } from './store/LanceDBStore';
import type { ChunkRecord, VectorStore } from './store/VectorStore';

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
}

export interface Indexer {
  build(): Promise<void>;
  watch(): vscode.Disposable;
  dispose(): void;
}

const MANIFEST_FILE = 'manifest.json';
const MAX_FILE_BYTES = 1_000_000; // matches Continue's shouldChunk cutoff
const EMBED_BATCH_SIZE = 64; // how-to §2.4: batch ~64-200
// SEC-1 (audit-3) / F-3b: bump this when secretScanner.ts's rules change so
// every workspace re-scans its whole index on upgrade — see `IndexMeta.
// scannerVersion` and `fingerprintMatches` below. A rule-set change can only
// make MORE content newly-detected as a secret; an index built under an
// older, narrower rule set may still hold content that the current rules
// would now drop, and there is no other signal that would ever force that
// content back through the (now-stricter) content gate.
const SCANNER_VERSION = 1;

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
  const store: VectorStore = new LanceDBStore(opts.indexDir);
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

  async function readManifest(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async function writeManifest(manifest: Record<string, string>): Promise<void> {
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  }

  const metaPath = path.join(opts.indexDir, 'manifest.meta.json');

  interface IndexMeta {
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
    // AUDIT-5 ARCH-1: fold the indexDir self-exclusion into the ONE filter
    // both runBuild's walk() and handleFsEvent already share.
    const filter = (relPosixPath: string): boolean => isUnderIndexDir(relPosixPath) || base(relPosixPath);
    cachedIgnoreFilter = filter;
    return filter;
  }

  async function walk(
    dir: string,
    ignoreFilter: (p: string) => boolean,
    out: string[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosixRelative(path.relative(opts.workspaceRoot, abs));
      // Secret-path floor (W5-T6): a `.env`/`id_rsa`/`.aws/credentials`-class
      // file is skipped BEFORE it is ever read/chunked/embedded — same
      // classifier as the completion exfiltration gate (one source of
      // truth). This walk-time check is a PATH filter only; it does not
      // scan content, and it cannot be overridden by `.gitignore` negation
      // (defense in depth). SEC-1 (audit-3) adds the missing CONTENT layer
      // for files that pass this path filter — see the `scanSnippetForSecrets`
      // call in `reindexFiles` below, the two layers together now mirror the
      // completion path's path+content gate.
      if (ignoreFilter(rel) || isSecretForCompletion(rel)) continue;
      if (entry.isDirectory()) {
        await walk(abs, ignoreFilter, out);
      } else if (entry.isFile()) {
        out.push(abs);
      }
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
   * AUDIT-5 Task 10: `preloaded` is an optional readAbsPath -> Buffer map.
   * When the caller already has a path's bytes in hand (`runBuild`'s hash
   * pass reads every candidate once already), pass them here instead of
   * letting this function `fs.readFile` the same path a second time. The
   * watch path (`handleFsEvent`) has no such buffer and passes nothing — it
   * keeps its original single read.
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
  interface ReindexTarget {
    readAbsPath: string;
    storeRelPath: string;
  }

  async function reindexFiles(
    targets: ReindexTarget[],
    manifest: Record<string, string>,
    expectedWidth: number | undefined,
    preloaded?: Map<string, Buffer>,
  ): Promise<number | undefined> {
    await ensureStoreInitialized();
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
    const pathState = new Map<string, { contentHash: string; remaining: number; deleted: boolean }>();

    for (const { readAbsPath, storeRelPath: relPath } of targets) {
      let buf: Buffer;
      try {
        buf = preloaded?.get(readAbsPath) ?? (await fs.readFile(readAbsPath));
      } catch {
        continue; // deleted between walk and read; the delete pass handles it.
      }
      if (buf.byteLength > MAX_FILE_BYTES || looksBinary(buf)) {
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
        parser: languageId ? parser : undefined,
        maxChunkTokens: opts.maxChunkTokens,
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
        await store.deleteByPath(relPath);
        manifest[relPath] = contentHash;
      } else {
        pathState.set(relPath, { contentHash, remaining: recordCount, deleted: false });
      }
    }

    // Embed in batches (how-to §2.4: ~64-200 per request); per batch, swap:
    // a path's stale rows are purged only once ITS replacement vectors exist
    // (this batch), then the batch is upserted. TA-3 (AU-3, Rev-1 A3):
    // bounded to ONE batch of pending vectors resident at a time — NOT an
    // all-batches-first buffer (which would hold every vector in memory,
    // 300+MB on a large repo).
    let observedWidth: number | undefined;
    try {
      for (let i = 0; i < pendingRecords.length; i += EMBED_BATCH_SIZE) {
        const batch = pendingRecords.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await embedder.embed(
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
            await store.deleteByPath(relPath);
            state.deleted = true;
          }
        }

        await store.upsert(batch);

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

  async function runBuild(): Promise<void> {
    await ensureStoreInitialized();
    // AUDIT-5 Task 10: force a fresh ignore-filter read for every full
    // build, independent of whatever the watch path may already have
    // cached — a full build is exactly the point at which `.gitignore`/
    // `.hermesignore` edits made OUTSIDE the watcher (e.g. `git pull`, or
    // the file arriving before `watch()` was ever called) must be picked up.
    cachedIgnoreFilter = undefined;
    const ignoreFilter = await loadIgnoreFilter();

    const absPaths: string[] = [];
    await walk(opts.workspaceRoot, ignoreFilter, absPaths);

    const current: Record<string, string> = {};
    // AUDIT-5 Task 10: read each candidate's bytes ONCE here for the hash
    // pass, and hand the same buffer to reindexFiles's embed pass below via
    // `preloaded` — the pre-Task-10 shape read every candidate file twice on
    // every full build (once here, again inside reindexFiles for whichever
    // paths ended up in `toCompute`), even though the content cannot have
    // changed between the two passes within one build.
    const preloaded = new Map<string, Buffer>();
    for (const absPath of absPaths) {
      const relPath = toPosixRelative(path.relative(opts.workspaceRoot, absPath));
      try {
        const buf = await fs.readFile(absPath);
        if (buf.byteLength > MAX_FILE_BYTES || looksBinary(buf)) continue;
        current[relPath] = hashContent(buf.toString('utf8'));
        preloaded.set(absPath, buf);
      } catch {
        continue;
      }
    }

    const stored = await readManifest();

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
        await store.deleteByPath(relPath);
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
    const storedMeta = await readMeta();
    const fingerprintOk = fingerprintMatches(storedMeta);
    const toCompute = fingerprintOk ? diff.toCompute : Object.keys(current);

    for (const relPath of diff.toDelete) {
      await store.deleteByPath(relPath);
      delete stored[relPath];
    }

    const manifest = { ...stored };
    // AUDIT-5 Task 11: read-path == store-path on the build path by
    // construction (walk() skips symlinks), so the pair is the identity
    // round-trip of the old single-argument shape.
    const toComputeTargets = toCompute.map((rel) => ({
      readAbsPath: path.join(opts.workspaceRoot, rel),
      storeRelPath: rel,
    }));
    const effectiveWidth = computeEffectiveWidth(storedMeta);
    let observedWidth: number | undefined;
    try {
      observedWidth = await reindexFiles(toComputeTargets, manifest, effectiveWidth, preloaded);
    } catch (err) {
      // TA-3 (AU-3): persist whatever scrub `reindexFiles` already applied
      // to `manifest` even though this build failed — otherwise a
      // partial-failure path's stale manifest entry (claiming rows that are
      // now gone) would survive on disk untouched until some LATER build
      // happens to recompute it, or forever if its content hash never
      // changes again. `writeMeta` is intentionally NOT called on this arm
      // — it records what THIS build observed, and this build did not
      // complete.
      await writeManifest(manifest);
      throw err;
    }

    await writeManifest(manifest);
    // Task 14b: if this build embedded nothing (nothing changed, or a
    // fingerprint mismatch found zero files to recompute), there is no NEW
    // observation to record — preserve whatever width the fingerprint-matched
    // sidecar already held rather than dropping it. Dropping it here would
    // silently re-open the dims=0 protection gap on the very next no-op
    // build, since `writeMeta` always overwrites the whole sidecar file.
    await writeMeta(observedWidth ?? (fingerprintOk ? storedMeta?.width : undefined));
  }

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
    return serialize(runBuild);
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
      // AUDIT-5 Task 10: the cached ignore filter goes stale the moment one
      // of the ignore files itself changes (edit OR delete) — invalidate
      // BEFORE this event's own loadIgnoreFilter() call so this event, and
      // every event after it, sees the new rules immediately.
      if (relPath === '.gitignore' || relPath === '.hermesignore') {
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
        const manifest = await readManifest();
        if (kind === 'delete') {
          await store.deleteByPath(relPath);
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
              await store.deleteByPath(key);
              delete manifest[key];
            }
          }
          await writeManifest(manifest);
          return;
        }
        if (isSecretForCompletion(relPath)) {
          // A newly-created/changed secret-path file (e.g. a fresh `.env`)
          // must never be indexed. Best-effort purge in case it was somehow
          // already stored (mirrors build()'s self-heal purge pass).
          await store.deleteByPath(relPath);
          delete manifest[relPath];
          await writeManifest(manifest);
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
          await store.deleteByPath(relPath);
          delete manifest[relPath];
          await writeManifest(manifest);
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
          await writeManifest(manifest);
          throw err;
        }
        await writeManifest(manifest);
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
          void handleFsEvent(uri, kind).catch((err) =>
            console.error('hermes-codebase: incremental reindex failed', err),
          );
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
    void store.close();
  }

  return { build, watch, dispose };
}
