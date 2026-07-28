import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import * as vscode from 'vscode';

// W6-FC (final-3way-arch.md I-6): import the pure classifier directly from
// `shared/secretPaths.ts` — the RAG indexer is an egress-only consumer, not
// a host-policy one.
import { isSecretForCompletion } from '../shared/secretPaths';
// T-19 (C1+C2): createIgnoreFilter moved to shared/ignoreFilter.ts; toPosixRelative stayed in ./gitignore.
import { createIgnoreFilter } from '../shared/ignoreFilter';
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
  /** Extra ignore globs beyond `.gitignore`/`.hermesignore` (e.g. `hermes.rag.excludeGlobs`). */
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
  // function's doc comment for the full policy (declared `hermes.rag.dims`,
  // OR the width observed and recorded by a previous build once the D-2
  // fingerprint still matches). This is the SOLE width-check site; nothing
  // else in this file re-checks vector width.
  const parser = new WebTreeSitterParser({
    grammarsDir:
      opts.grammarsDir ?? path.join(opts.workspaceRoot, 'node_modules', 'tree-sitter-wasms', 'out'),
  });

  const manifestPath = path.join(opts.indexDir, MANIFEST_FILE);
  let storeInitialized = false;
  let disposed = false;

  async function ensureStoreInitialized(): Promise<void> {
    if (storeInitialized) return;
    await fs.mkdir(opts.indexDir, { recursive: true });
    await store.init();
    storeInitialized = true;
  }

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
    schema: 1;
    embedModel: string;
    dims: number;
    /**
     * Task 14b: the OBSERVED width of vectors this build actually produced
     * (`vectors[0].length` of the first non-empty embed batch), not a
     * configured/declared value. Optional — absent on a first build (nothing
     * has been observed yet) and on a legacy sidecar written before this
     * field existed; both must still parse.
     *
     * This exists because `hermes.rag.dims` defaults to 0 ("let the server
     * decide"), and at dims=0 nothing else records what width the server
     * actually returned. Verified empirically (see embedder.ts's comment on
     * `expectedWidth`): LanceDB's `mergeInsert(...).execute()` does not
     * reject a wrong-width vector — it silently truncates or null-pads it —
     * so a same-name model swap that changes width would otherwise corrupt
     * the index with no error at all. Recording the width here lets the
     * NEXT build compare against it even when dims=0.
     */
    width?: number;
  }

  function currentMeta(): IndexMeta {
    return { schema: 1, embedModel: opts.embedModel, dims: opts.dims ?? 0 };
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
    return stored?.schema === 1 && stored.embedModel === want.embedModel && stored.dims === want.dims;
  }

  /**
   * Task 14b / final-review Finding 1: the single width-check site is
   * `HttpEmbedder.embed`'s `expectedWidth` parameter (embedder.ts) — this
   * function only DECIDES what value to pass it, it does not itself check
   * anything. The decision: prefer the width OBSERVED and stored on a
   * previous build, whenever one is on record; otherwise fall back to the
   * width the user explicitly declared via `hermes.rag.dims` (Task 14's
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
   * `hermes.rag.dims=0` on exactly a model-name change: `mergeInsert(...)`
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
    return createIgnoreFilter(gitignoreContents, opts.extraIgnoreGlobs ?? []);
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
      // truth). This is a PATH filter only; it does not scan content, and it
      // cannot be overridden by `.gitignore` negation (defense in depth).
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
   */
  async function reindexFiles(
    absPaths: string[],
    manifest: Record<string, string>,
    expectedWidth: number | undefined,
  ): Promise<number | undefined> {
    await ensureStoreInitialized();
    const pendingRecords: ChunkRecord[] = [];

    for (const absPath of absPaths) {
      const relPath = toPosixRelative(path.relative(opts.workspaceRoot, absPath));
      let buf: Buffer;
      try {
        buf = await fs.readFile(absPath);
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

      await store.deleteByPath(relPath);
      const chunks = await chunkFile({
        relPath,
        contents,
        languageId: languageId ?? extension,
        extension,
        parser: languageId ? parser : undefined,
        maxChunkTokens: opts.maxChunkTokens,
      });

      chunks.forEach((chunk, i) => {
        pendingRecords.push({
          id: createHash('sha256')
            .update(`${relPath}:${chunk.startLine}-${chunk.endLine}:${i}`)
            .digest('hex'),
          path: relPath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.headeredContent,
          contentHash,
          language: languageId,
          vector: [],
        });
      });

      manifest[relPath] = contentHash;
    }

    // Embed in batches (how-to §2.4: ~64-200 per request) and upsert.
    let observedWidth: number | undefined;
    for (let i = 0; i < pendingRecords.length; i += EMBED_BATCH_SIZE) {
      const batch = pendingRecords.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedder.embed(
        batch.map((r) => r.content),
        expectedWidth,
      );
      // Task 14b: record the width of the very first vector this build
      // actually produced, before any upsert — this is the value the NEXT
      // build's `computeEffectiveWidth` will enforce.
      if (observedWidth === undefined) {
        const first = vectors[0];
        if (first !== undefined) observedWidth = first.length;
      }
      batch.forEach((record, idx) => {
        record.vector = vectors[idx] ?? [];
      });
      await store.upsert(batch);
    }
    return observedWidth;
  }

  async function runBuild(): Promise<void> {
    await ensureStoreInitialized();
    const ignoreFilter = await loadIgnoreFilter();

    const absPaths: string[] = [];
    await walk(opts.workspaceRoot, ignoreFilter, absPaths);

    const current: Record<string, string> = {};
    for (const absPath of absPaths) {
      const relPath = toPosixRelative(path.relative(opts.workspaceRoot, absPath));
      try {
        const buf = await fs.readFile(absPath);
        if (buf.byteLength > MAX_FILE_BYTES || looksBinary(buf)) continue;
        current[relPath] = hashContent(buf.toString('utf8'));
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
    const toComputeAbs = toCompute.map((rel) => path.join(opts.workspaceRoot, rel));
    const effectiveWidth = computeEffectiveWidth(storedMeta);
    const observedWidth = await reindexFiles(toComputeAbs, manifest, effectiveWidth);

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
        // Task 14b: the incremental path shares the SAME embedder instance
        // as `runBuild`, so it must enforce the SAME effective width — an
        // in-place model swap can just as easily be observed on a single
        // file's change-event as on a full build. This only READS the
        // sidecar (via `computeEffectiveWidth`); only `runBuild` ever WRITES
        // it, matching the existing scope of `writeMeta`/`manifest.meta.json`
        // to full builds.
        const storedMeta = await readMeta();
        const effectiveWidth = computeEffectiveWidth(storedMeta);
        await reindexFiles([uri.fsPath], manifest, effectiveWidth);
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
