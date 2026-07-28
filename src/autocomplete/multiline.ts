import { getSingleLineComment } from './languageInfo';

export interface MultilineInput {
  fullPrefix: string;
  fullSuffix: string;
  languageId: string;
  hasSelectedCompletionInfo: boolean;
}

export interface MultilineOptions {
  multiline: 'auto' | 'always' | 'never';
}

/**
 * Per `classification/shouldCompleteMultiline.ts` and how-to §2.5:
 * "always"/"never" force it; if the IntelliSense widget is open -> single-line;
 * if the current line is a single-line comment -> single-line; otherwise default
 * to multiline (language-specific heuristics are a later refinement — see how-to
 * §5 v1.1).
 *
 * Note: Continue's own source literally `return`s `true` (not `false`) for the
 * "IntelliSense widget open" branch despite the comment above it reading
 * "Always single-line" — that looks like an upstream quirk/bug. We follow the
 * how-to's explicit prose ("if the IntelliSense widget is open -> single-line")
 * since it is the authoritative spec here, not the possibly-buggy source line.
 */
export function shouldCompleteMultiline(
  input: MultilineInput,
  opts: MultilineOptions,
): boolean {
  if (opts.multiline === 'always') return true;
  if (opts.multiline === 'never') return false;

  if (input.hasSelectedCompletionInfo) {
    return false;
  }

  const lastLine = input.fullPrefix.split('\n').slice(-1)[0]?.trimStart() ?? '';
  const commentMarker = getSingleLineComment(input.languageId);
  if (commentMarker && lastLine.startsWith(commentMarker)) {
    return false;
  }

  return true;
}
