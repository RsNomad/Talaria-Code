export interface SingleLineResult {
  completionText: string;
  /** Character offsets on the current line; set only when the replace range must
   * be extended past the cursor (past what's already on the line). */
  range?: { start: number; end: number };
}

/**
 * Decides what to actually insert/replace for a single-line completion, given what
 * (if anything) already follows the cursor on that line.
 *
 * This is a dependency-free simplification of Continue's
 * `util/processSingleLineCompletion.ts`, which classifies a word-level diff (via
 * the `diff` npm package) between the model's line and the existing text. Adding a
 * word-diff dependency wasn't warranted for the two cases that matter in practice:
 *
 *  1. The model's suggestion is already fully present after the cursor (a common
 *     side-effect of feeding the suffix into the prompt) -> suggest nothing.
 *  2. The model regenerated the tail of the line, including text that already
 *     exists after the cursor -> replace through that existing text so accepting
 *     doesn't duplicate it.
 *  3. Otherwise -> plain insertion at the cursor, existing suffix untouched.
 */
export function processSingleLineCompletion(
  completionLine: string,
  currentLineSuffix: string,
  cursorCharacter: number,
): SingleLineResult | undefined {
  if (completionLine.length === 0) {
    return undefined;
  }

  if (currentLineSuffix.length === 0) {
    return { completionText: completionLine };
  }

  if (currentLineSuffix.startsWith(completionLine)) {
    return undefined;
  }

  if (completionLine.endsWith(currentLineSuffix)) {
    return {
      completionText: completionLine,
      range: {
        start: cursorCharacter,
        end: cursorCharacter + currentLineSuffix.length,
      },
    };
  }

  return { completionText: completionLine };
}
