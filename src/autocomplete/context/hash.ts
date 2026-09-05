import { createHash } from 'node:crypto';

/** Fixed 16-hex-char output for an empty snippet set, so v1 (no cross-file
 *  gathering — always an empty set) produces a bit-stable cache key identical
 *  to pre-W5 behavior. */
const EMPTY_SET_HASH = '0000000000000000';

/** Structural input: any object shaped like a snippet's identity + content.
 *  Deliberately NOT typed as `ScannedSnippet` — both the host-side budgeter
 *  and the engine (which only ever sees `ScannedSnippet[]`) call this. */
export interface HashableSnippet {
  uri: string;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Cache-key hash for a set of cross-file snippets (§2.6). Order-sensitive by
 * design: reordering the input changes the hash, matching KV reality (the
 * assembled prompt differs when snippet order differs). Pure, deterministic,
 * no `vscode`.
 */
export function snippetSetHash(snippets: readonly HashableSnippet[]): string {
  if (snippets.length === 0) {
    return EMPTY_SET_HASH;
  }

  const canonical = snippets
    .map((s) => `${s.uri}:${s.startLine}-${s.endLine}:${sha256(s.content)}`)
    .join('\n');

  return sha256(canonical).slice(0, 16);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * CA-07 fixed-width context discriminator for the completion-cache key: two
 * requests with identical pruned prefixes but a different suffix, file, or
 * language must never share a cache partition (a wrong-context completion
 * served silently). Hashed as one 16-hex token (sha256-truncated, the same
 * cost class as snippetSetHash) so the cache key keeps its fixed-width head
 * ahead of the variable-length prefix.
 *
 * The three fields are joined with a NUL byte, not a plain space: filepath
 * can legitimately contain spaces, so space-joining would let two distinct
 * triples collide, e.g. ('ts', 'a b', 'x') vs ('ts', 'a', 'b x') -- exactly
 * the wrong-context hit this hash exists to prevent. languageId and a
 * stringified document URI never carry a raw NUL, and suffix is the final
 * field, so every boundary stays unambiguous.
 */
export function fimContextHash(languageId: string, filepath: string, suffix: string): string {
  const NUL = String.fromCharCode(0);
  return sha256(languageId + NUL + filepath + NUL + suffix).slice(0, 16);
}
