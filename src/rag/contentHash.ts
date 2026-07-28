import { createHash } from 'node:crypto';

/**
 * sha256 hex digest of a file's full contents — the per-file cache key used
 * for incremental re-indexing (how-to §6, "content-hash invalidation":
 * "content_hash = sha256(fileContents) per file ... on startup, diff current
 * file hashes vs stored").
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ContentHashDiff {
  /** Paths that are new, or whose content changed since the last index, and
   * must be (re)chunked + (re)embedded. */
  toCompute: string[];
  /** Paths that were indexed before but no longer exist (or are now
   * ignored/deleted) and must be purged from the store. */
  toDelete: string[];
}

/**
 * Pure diff between the current on-disk file hashes and the last-persisted
 * manifest. Unchanged files are omitted from both lists entirely, so an
 * unchanged file costs zero re-embedding work (how-to §6: "Only changed
 * files are re-embedded").
 */
export function diffContentHashes(
  current: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, string>>,
): ContentHashDiff {
  const toCompute: string[] = [];
  const toDelete: string[] = [];

  for (const path of Object.keys(current)) {
    if (current[path] !== stored[path]) {
      toCompute.push(path);
    }
  }
  for (const path of Object.keys(stored)) {
    if (!(path in current)) {
      toDelete.push(path);
    }
  }

  return { toCompute, toDelete };
}
