const BRACKETS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
const BRACKETS_REVERSE: Record<string, string> = {
  ')': '(',
  '}': '{',
  ']': '[',
};

/**
 * Truncates `completion` at the first closing bracket that doesn't have a matching
 * opener — either one opened earlier in the completion itself, or one implied by
 * the `suffix` (text already in the file right after the cursor, which the model
 * is allowed to "reuse" as its own closer without repeating it).
 *
 * A synchronous, whole-string simplification of Continue's streaming
 * `BracketMatchingService.stopOnUnmatchedClosingBracket` (`filtering/BracketMatchingService.ts`)
 * — we post-process the fully-accumulated completion rather than filtering a live
 * token stream, since `FimEngine` already buffers the full text before
 * postprocessing (see how-to §5 v1.1).
 */
export function balanceBrackets(
  completion: string,
  _prefix: string,
  suffix: string,
): string {
  const stack: string[] = [];

  // Seed the stack with the opening brackets implied by what already follows the
  // cursor in the file, so the model isn't forced to re-close something the file
  // will close for it. Stop at the first non-whitespace, non-bracket character.
  for (const ch of suffix) {
    if (ch === ' ' || ch === '\t') continue;
    const openBracket = BRACKETS_REVERSE[ch];
    if (!openBracket) break;
    stack.unshift(openBracket);
  }

  let result = '';
  for (const ch of completion) {
    if (ch in BRACKETS) {
      stack.push(ch);
      result += ch;
    } else if (ch in BRACKETS_REVERSE) {
      const top = stack.pop();
      if (top === undefined || BRACKETS[top] !== ch) {
        return result;
      }
      result += ch;
    } else {
      result += ch;
    }
  }
  return result;
}
