import type { Embedder } from '../rag/embedder';
import type { SearchFilter, SearchHit, VectorStore } from '../rag/store/VectorStore';
import { compilePathGlobs, matchesCompiledPathGlobs } from './pathGlob';
import type { CodebaseSearchInput } from './toolSchema';

export interface CodebaseSearchDeps {
  embedder: Embedder;
  store: VectorStore;
}

export interface CodebaseSearchResult {
  hits: SearchHit[];
}

/**
 * Orchestrates one `codebase_search` call: embed the query, run the store's
 * fused hybrid search, then apply the `path_globs` filter that the store
 * itself doesn't understand. Kept independent of `@modelcontextprotocol/sdk`
 * and `@lancedb/lancedb` (both injected via interfaces) so it's testable
 * with a fake embedder/store — no network, no native module.
 */
export async function runCodebaseSearch(
  deps: CodebaseSearchDeps,
  input: CodebaseSearchInput,
): Promise<CodebaseSearchResult> {
  const k = input.k ?? 10;
  const [queryVector] = await deps.embedder.embed([input.query]);
  if (!queryVector) {
    return { hits: [] };
  }

  const filter: SearchFilter = {};
  if (input.language) filter.language = input.language;

  const hasPathGlobs = Boolean(input.path_globs && input.path_globs.length > 0);
  // Overfetch so filtering by path_globs afterward can still return k hits.
  const candidateK = hasPathGlobs ? Math.max(k * 3, 30) : k;

  const rawHits = await deps.store.hybridSearch(input.query, queryVector, candidateK, filter);
  // V-21 pathGlob amplifier fold-in: compile the glob set ONCE per call
  // (schema now also caps it at 16 globs / 256 chars each — toolSchema.ts),
  // then reuse the compiled regexes across every candidate hit, instead of
  // recompiling on every filter check (matchesPathGlobs' per-call compile).
  const compiledGlobs = hasPathGlobs ? compilePathGlobs(input.path_globs ?? []) : undefined;
  const filtered = compiledGlobs
    ? rawHits.filter((hit) => matchesCompiledPathGlobs(hit.path, compiledGlobs))
    : rawHits;

  return { hits: filtered.slice(0, k) };
}

/** Only a bare language identifier is allowed into the markdown fence's
 * info-string — V-21 (tier2-remediation-architecture.md §8): the fence
 * info-string is the one field the nonce-frame envelope alone doesn't make
 * cosmetically inert (it sits in the header the model reads as a syntax
 * hint, not inside the framed/neutralized body), so it gets its own
 * allowlist rather than relying on the envelope. */
const FENCE_LANGUAGE_PATTERN = /^[A-Za-z0-9_+-]{1,32}$/;

/** Renders one hit as an MCP `content` text block (how-to §7.1: path,
 * 1-based line range, fenced code with a best-effort language tag). */
export function formatHitAsText(hit: SearchHit): string {
  const rawLanguage = hit.language ?? '';
  const fence = FENCE_LANGUAGE_PATTERN.test(rawLanguage) ? rawLanguage : '';
  return `${hit.path}:${hit.startLine + 1}-${hit.endLine + 1}\n\`\`\`${fence}\n${hit.content}\n\`\`\``;
}
