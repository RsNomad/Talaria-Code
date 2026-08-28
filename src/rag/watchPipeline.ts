import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as vscode from 'vscode';

// W6-FC (final-3way-arch.md I-6): import the pure classifier directly from
// `shared/secretPaths.ts` — the RAG indexer is an egress-only consumer, not
// a host-policy one.
import { isSecretForCompletion } from '../shared/secretPaths';
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
import { reindexFiles, type IndexerContext } from './buildPipeline';
import { toPosixRelative } from './gitignore';

/**
 * B8 (FUNC-INDEXER): the `watch()` body, moved verbatim out of
 * `createIndexer` — see `buildPipeline.ts`'s `IndexerContext` doc comment
 * for why `fs` stays a direct `node:fs` import here rather than a ctx field.
 */
export function createWatch(
  ctx: IndexerContext,
  serialize: (run: () => Promise<void>) => Promise<void>,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const debounceMs = ctx.opts.debounceMs ?? 500;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function handleFsEvent(uri: vscode.Uri, kind: 'change' | 'delete'): Promise<void> {
    if (ctx.isDisposed()) return;
    const relPath = toPosixRelative(path.relative(ctx.opts.workspaceRoot, uri.fsPath));
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
      ctx.invalidateIgnoreFilterCache();
    }
    const ignoreFilter = await ctx.loadIgnoreFilter();
    if (ignoreFilter(relPath)) return;

    await ctx.ensureStoreInitialized();

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
      if (ctx.isDisposed()) return;
      const manifest = await ctx.readManifest();
      if (kind === 'delete') {
        // TA-5 (AU-23, Med) / INV-5: `readManifest()` above is an await —
        // `dispose()` may have fired while it was pending. Re-check right
        // before this branch's first mutation so a post-dispose
        // continuation neither calls `store.deleteByPath` (a no-op on the
        // by-then-closed store, `LanceDBStore.ts:362-364`) NOR removes this
        // path's manifest entry — the exact orphan-row/manifest-drift
        // AU-23 named.
        if (ctx.isDisposed()) return;
        await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
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
            await ctx.gate.sink(() => ctx.store.deleteByPath(key));
            delete manifest[key];
          }
        }
        // AU-23 re-review (TA-5 completion) / INV-5: the loop above awaits
        // `store.deleteByPath` per swept key — `dispose()` can fire during
        // any one of those awaits, same hazard as every other await in
        // this function. The entry guard above only covers what precedes
        // the loop; re-check once more, after it, right before the write.
        if (ctx.isDisposed()) return;
        await ctx.gate.sink(() => ctx.writeManifest(manifest));
        return;
      }
      if (isSecretForCompletion(relPath)) {
        // TA-5 (AU-23, Med) / INV-5: see the delete-kind branch above —
        // same re-check, same reason.
        if (ctx.isDisposed()) return;
        // A newly-created/changed secret-path file (e.g. a fresh `.env`)
        // must never be indexed. Best-effort purge in case it was somehow
        // already stored (mirrors build()'s self-heal purge pass).
        await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
        delete manifest[relPath];
        // AU-23 re-review (TA-5 completion) / INV-5: the entry guard above
        // covers what precedes `store.deleteByPath`, not the await itself
        // — re-check once more before the write.
        if (ctx.isDisposed()) return;
        await ctx.gate.sink(() => ctx.writeManifest(manifest));
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
          : await resolveWithinWorkspaceReal(uri.fsPath, [ctx.opts.workspaceRoot]);
      } catch {
        confined = null; // fail closed
      }
      if (confined === null) {
        // TA-5 (AU-23, Med) / INV-5: `fs.lstat`/`resolveWithinWorkspaceReal`
        // above both await — same re-check, same reason as the two
        // branches above.
        if (ctx.isDisposed()) return;
        await ctx.gate.sink(() => ctx.store.deleteByPath(relPath));
        delete manifest[relPath];
        // AU-23 re-review (TA-5 completion) / INV-5: the entry guard above
        // covers what precedes `store.deleteByPath`, not the await itself
        // — re-check once more before the write.
        if (ctx.isDisposed()) return;
        await ctx.gate.sink(() => ctx.writeManifest(manifest));
        return;
      }
      // Task 14b: the incremental path shares the SAME embedder instance
      // as `runBuild`, so it must enforce the SAME effective width — an
      // in-place model swap can just as easily be observed on a single
      // file's change-event as on a full build. This only READS the
      // sidecar (via `computeEffectiveWidth`); only `runBuild` ever WRITES
      // it, matching the existing scope of `writeMeta`/`manifest.meta.json`
      // to full builds.
      const storedMeta = await ctx.readMeta();
      const effectiveWidth = ctx.computeEffectiveWidth(storedMeta);
      // TA-5 (AU-23, Med) / INV-5: `readMeta()` above is an await too —
      // re-check once more before entering `reindexFiles`. This only
      // covers `reindexFiles`'s OWN entry point (and, since the CRITICAL
      // remediation below, its internal embed-batch loop too) — it says
      // nothing about dispose state once `reindexFiles` returns back HERE,
      // so the two `writeManifest` calls that follow are each re-checked
      // independently right below, not assumed covered by this one.
      if (ctx.isDisposed()) return;
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
        if (ctx.isDisposed()) throw err;
        await ctx.gate.sink(() => ctx.writeManifest(manifest));
        throw err;
      }
      // TA-5 (AU-23, Critical remediation) / INV-5: same hazard as the
      // catch arm above, for the non-throwing (success) case — dispose()
      // firing during reindexFiles's embed await must not let this
      // continuation write `manifest` afterward.
      if (ctx.isDisposed()) return;
      await ctx.gate.sink(() => ctx.writeManifest(manifest));
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
          ctx.recordFailedIncrementalReindex();
          // F2-12 hygiene fix: the OLD line passed the raw `err` object to
          // `console.error` — an fs error's `.message` embeds the absolute
          // workspace path it failed on, leaking it into the log on every
          // failure. Errno-name idiom only (never `String(err)`/`.message`).
          ctx.logger(
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
