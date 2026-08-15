/**
 * Cheap, dependency-free token-count estimate (~4 chars/token, the same
 * order-of-magnitude heuristic commonly used for a quick approximation of
 * English/code text). We deliberately avoid pulling in a real tokenizer
 * (tiktoken et al.) — it isn't in this zone's approved dependency list, and
 * precision doesn't matter here: the AST chunker only needs "is this chunk
 * roughly under the ~512-token budget", not an exact count.
 *
 * AU-36:R14 — plain `len/4` badly UNDERcounts CJK/emoji-heavy text (a
 * tokenizer typically spends ~1 token per CJK character or emoji code
 * point, not ~0.25), which let non-ASCII-heavy chunks silently sail past
 * `maxChunkTokens` and get truncated server-side. Every Unicode code point
 * (via `for...of`, which correctly groups UTF-16 surrogate pairs into one
 * step, unlike `.length`) is classified as ASCII (~4 chars/token, the
 * existing/still-correct estimate for English/code) or "other" (~1
 * token/char, the accepted rough floor for CJK/emoji) and the two counts
 * are combined. Over-counting a little (e.g. multi-code-point emoji
 * sequences) is safe — it only shrinks a chunk a bit; undercounting is the
 * bug this fixes.
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  let asciiChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      asciiChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(asciiChars / 4 + otherChars);
}
