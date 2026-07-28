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
