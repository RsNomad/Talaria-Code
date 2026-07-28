/**
 * T-19 (C1+C2, boundary move): `createIgnoreFilter`/`DEFAULT_IGNORE_PATTERNS`
 * moved to `src/shared/ignoreFilter.ts` — `src/host/checkpoints/CheckpointTracker.ts`
 * (outside `rag/`) needed `createIgnoreFilter`, which was a zone-crossing
 * edge (`host/checkpoints/` reaching into `rag/`). `toPosixRelative` stays
 * here — it is used only within `rag/` (`indexer.ts`), never outside it, so
 * it was never a zone-crossing edge.
 */

/** Normalizes an OS path separator to the POSIX form the `ignore` package requires. */
export function toPosixRelative(relPath: string): string {
  return relPath.split('\\').join('/');
}
