import type { Embedder } from '../rag/embedder';
import type { SearchFilter, SearchHit, VectorStore } from '../rag/store/VectorStore';
import { CONTROL_CHAR_PATTERN } from './lsp/frameSanitize';
import { compilePathGlobs, matchesCompiledPathGlobs } from './pathGlob';
import type { CodebaseSearchInput } from './toolSchema';

export interface CodebaseSearchDeps {
  embedder: Embedder;
  store: VectorStore;
  /** Configured embedder id, e.g. `qwen3-embedding:0.6b` (Ollama tag) or
   * `Qwen/Qwen3-Embedding-8B` (HF repo id). Optional — absent means the
   * caller didn't wire it (or the composition root couldn't determine it),
   * and `buildEmbeddingQueryText` then leaves the query raw. Clear this by
   * KEY OMISSION, never `= undefined` (exactOptionalPropertyTypes). */
  embedModel?: string;
}

export interface CodebaseSearchResult {
  hits: SearchHit[];
}

/**
 * A-05: Qwen3-Embedding is an instruction-aware retrieval model. Its HF card
 * and the QwenLM/Qwen3-Embedding repo (`get_detailed_instruct`) document that
 * QUERIES get an `Instruct: {task}\nQuery:{query}` prefix while DOCUMENTS stay
 * bare — asymmetric usage, so changing the instruction needs no re-index. We
 * apply the prefix ONLY when the configured embedder id is a Qwen3-Embedding
 * variant (e.g. `qwen3-embedding:0.6b`, `Qwen/Qwen3-Embedding-8B`); every
 * other model (nomic/bge/e5/...) embeds the raw query.
 */
const QWEN3_EMBEDDING_ID = /qwen3-embedding/i;
const CODE_SEARCH_INSTRUCTION =
  'Given a code search query, retrieve relevant code snippets that satisfy it.';

export function buildEmbeddingQueryText(rawQuery: string, embedModel: string | undefined): string {
  if (embedModel !== undefined && QWEN3_EMBEDDING_ID.test(embedModel)) {
    return `Instruct: ${CODE_SEARCH_INSTRUCTION}\nQuery:${rawQuery}`;
  }
  return rawQuery;
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
  const embedText = buildEmbeddingQueryText(input.query, deps.embedModel);
  const [queryVector] = await deps.embedder.embed([embedText]);
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
  // LSP-02 (DiD): strip C0 controls + DEL from the untrusted snippet, exactly
  // as the LSP tool outputs are sanitized. CR/LF/tab are intentionally kept
  // (CONTROL_CHAR_PATTERN excludes them) — they are legitimate in a fenced
  // code block and pose no framing risk.
  const safeContent = hit.content.replace(CONTROL_CHAR_PATTERN, '');
  return `${hit.path}:${hit.startLine + 1}-${hit.endLine + 1}\n\`\`\`${fence}\n${safeContent}\n\`\`\``;
}
