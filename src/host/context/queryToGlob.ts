/**
 * Pure `context.searchFiles` query → `workspace.findFiles` include-glob
 * builder (§2e: "query treated as a plain substring, never a user-supplied
 * glob"). The webview-typed `query` is UNTRUSTED-ISH input (§2a) — every
 * minimatch metacharacter it contains is backslash-escaped so it can never
 * widen the search past a literal substring match (e.g. embedding `**` to
 * broaden traversal, or `{a,b}`/`[abc]` to enumerate alternatives the caller
 * didn't type). This is a defensive escape, not a VS Code-documented
 * guarantee (the glob engine's escape handling isn't part of the Context7
 * API surface) — the load-bearing security boundaries are the ones that
 * ARE pinned: `findFiles` only ever returns paths inside opened workspace
 * folders by construction, and `searchFilesResponse.ts` secret-filters and
 * hard-caps the results downstream.
 */
const GLOB_SPECIAL = /[\\*?[\]{}()!+@]/g;

function escapeGlob(raw: string): string {
  return raw.replace(GLOB_SPECIAL, '\\$&');
}

/** `''`/whitespace-only ⇒ `'**​/*'` (match everything); otherwise a
 * `**​/*<escaped query>*` substring-match include glob. */
export function queryToGlob(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '**/*';
  return `**/*${escapeGlob(trimmed)}*`;
}
