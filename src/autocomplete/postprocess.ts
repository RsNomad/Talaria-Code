/**
 * Cuts `text` at the earliest occurrence of any `stopTokens` entry. A client-side
 * safety net: backends are always sent `stop` (see `stopTokens.ts`), but not every
 * runner honors it identically (in particular the self-built vLLM prompt has no
 * server-side FIM support to fall back on), so we re-trim defensively.
 */
export function trimAtStopTokens(text: string, stopTokens: string[]): string {
  let cutAt = text.length;
  for (const token of stopTokens) {
    if (!token) continue;
    const idx = text.indexOf(token);
    if (idx !== -1 && idx < cutAt) {
      cutAt = idx;
    }
  }
  return text.slice(0, cutAt);
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Classic Levenshtein edit distance — small and dependency-free. */
function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  // dp always has a.length + 1 rows (indices 0..a.length), each with
  // b.length + 1 columns — every row/column access below is within those
  // bounds; the undefined branches are unreachable and kept for totality/
  // type safety (no non-null assertion), not a behavior change.
  const row0 = dp[0];
  if (row0 === undefined) {
    return 0;
  }
  for (let i = 0; i <= a.length; i++) {
    const row = dp[i];
    if (row === undefined) {
      continue;
    }
    row[0] = i;
  }
  for (let j = 0; j <= b.length; j++) row0[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = dp[i];
    const prevRow = dp[i - 1];
    if (row === undefined || prevRow === undefined) {
      continue;
    }
    for (let j = 1; j <= b.length; j++) {
      row[j] =
        a[i - 1] === b[j - 1]
          ? (prevRow[j - 1] ?? 0)
          : 1 + Math.min(prevRow[j] ?? 0, row[j - 1] ?? 0, prevRow[j - 1] ?? 0);
    }
  }
  const lastRow = dp[a.length];
  if (lastRow === undefined) {
    return 0;
  }
  return lastRow[b.length] ?? 0;
}

/** Near-duplicate check (>90% similar), ported from Continue's `lineIsRepeated`. */
function lineIsRepeated(a: string, b: string): boolean {
  if (a.length <= 4 || b.length <= 4) return false;
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (bTrim.length === 0) return false;
  return editDistance(aTrim, bTrim) / bTrim.length < 0.1;
}

/** Don't suggest a completion that just repeats the (non-blank) line above the cursor. */
function rewritesLineAbove(completion: string, prefix: string): boolean {
  const lineAbove = prefix
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-1)[0];
  if (!lineAbove) return false;

  const firstLineOfCompletion = completion
    .split('\n')
    .find((line) => line.trim().length > 0);
  if (!firstLineOfCompletion) return false;

  return lineIsRepeated(lineAbove, firstLineOfCompletion);
}

/**
 * Removes markdown code block delimiters from a completion: the first line if it
 * starts with backticks (with optional language name), and the last line if it
 * contains only backticks. Ported verbatim from Continue's `postprocessing/index.ts`.
 */
function removeBackticks(completion: string): string {
  const lines = completion.split('\n');
  if (lines.length === 0) return completion;

  let startIdx = 0;
  let endIdx = lines.length;

  // `split('\n')` always yields at least one element, so lines[0] and
  // lines[lines.length - 1] are always present; the undefined branches below
  // are unreachable (kept for totality/type safety, not a behavior change).
  const firstLine = lines[0];
  if (firstLine !== undefined && firstLine.trim().startsWith('```')) {
    startIdx = 1;
  }

  if (lines.length > startIdx) {
    const lastLine = lines[lines.length - 1];
    const lastLineTrimmed = lastLine !== undefined ? lastLine.trim() : '';
    if (lastLineTrimmed.length > 0 && /^`+$/.test(lastLineTrimmed)) {
      endIdx = lines.length - 1;
    }
  }

  if (startIdx > 0 || endIdx < lines.length) {
    return lines.slice(startIdx, endIdx).join('\n');
  }
  return completion;
}

export interface PostprocessArgs {
  completion: string;
  prefix: string;
  suffix: string;
  model: string;
  stop: string[];
}

/**
 * Filters and cleans up a raw completion before it is shown as ghost text. Ported
 * (simplified — no `diff`/tokenizer dependency) from Continue's
 * `core/autocomplete/postprocessing/index.ts`. Returns `undefined` when the
 * completion should not be shown at all.
 */
export function postprocessCompletion(
  args: PostprocessArgs,
): string | undefined {
  let completion = trimAtStopTokens(args.completion, args.stop);

  if (isBlank(completion)) {
    return undefined;
  }

  if (rewritesLineAbove(completion, args.prefix)) {
    return undefined;
  }

  if (args.model.toLowerCase().includes('qwen3')) {
    // Qwen3 emits thinking traces; strip them, we only want the completion text.
    completion = completion.replace(/<think>[\s\S]*?<\/think>/, '');
    completion = completion.replace(/<\/think>/, '');
    completion = completion.replace(/^\n+|\n+$/g, '');
    if (isBlank(completion)) {
      return undefined;
    }
  }

  if (args.prefix.endsWith(' ') && completion.startsWith(' ')) {
    completion = completion.slice(1);
  }

  completion = removeBackticks(completion);

  return completion;
}
