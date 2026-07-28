/**
 * Cheap, dependency-free token-count estimate (~4 chars/token, the same
 * order-of-magnitude heuristic commonly used for a quick approximation of
 * English/code text). We deliberately avoid pulling in a real tokenizer
 * (tiktoken et al.) — it isn't in this zone's approved dependency list, and
 * precision doesn't matter here: the AST chunker only needs "is this chunk
 * roughly under the ~512-token budget", not an exact count.
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
