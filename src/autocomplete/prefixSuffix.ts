/**
 * Minimal IDE-agnostic subset of `vscode.TextDocument`/`vscode.Position` — just
 * enough to compute prefix/suffix without importing `vscode`, so this stays unit
 * testable with a plain fake object (see `prefixSuffix.test.ts`).
 */
export interface PositionLike {
  line: number;
  character: number;
}

export interface TextDocumentLike {
  getText(): string;
  offsetAt(position: PositionLike): number;
}

/**
 * We have to handle a few edge cases in getting the entire prefix/suffix for the
 * current file. This is entirely prior to finding snippets from other files.
 * (`core/autocomplete/templating/constructPrefixSuffix.ts` in Continue.)
 */
export function constructPrefixSuffix(
  doc: TextDocumentLike,
  pos: PositionLike,
): { prefix: string; suffix: string } {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  return {
    prefix: text.slice(0, offset),
    suffix: text.slice(offset),
  };
}

/**
 * Approximate token count at ~4 chars/token. We deliberately do NOT pull in a real
 * tokenizer (e.g. tiktoken) — it would be a new dependency, and every runner in play
 * (Ollama/llama.cpp/vLLM) uses a different model/tokenizer anyway, so an exact count
 * isn't meaningful across backends. This heuristic only needs to be good enough to
 * keep prompts inside a generous budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Prunes prefix/suffix to the configured token budget (how-to §2.2: prefix 30% /
 * suffix 20% of `maxPromptTokens`, default 1024). The prefix keeps its END (closest
 * to the cursor) and the suffix keeps its START (closest to the cursor) — the part
 * furthest from the cursor is the least relevant to the completion.
 */
export function pruneToBudget(
  prefix: string,
  suffix: string,
  opts: {
    maxPromptTokens: number;
    prefixPercentage: number;
    maxSuffixPercentage: number;
  },
): { prefix: string; suffix: string } {
  const prefixCharBudget =
    Math.floor(opts.maxPromptTokens * opts.prefixPercentage) * 4;
  const suffixCharBudget =
    Math.floor(opts.maxPromptTokens * opts.maxSuffixPercentage) * 4;

  const prunedPrefix =
    prefix.length > prefixCharBudget
      ? prefix.slice(prefix.length - prefixCharBudget)
      : prefix;
  const prunedSuffix =
    suffix.length > suffixCharBudget ? suffix.slice(0, suffixCharBudget) : suffix;

  return { prefix: prunedPrefix, suffix: prunedSuffix };
}
