/**
 * Minimal per-language table, keyed directly on VS Code's `TextDocument.languageId`
 * (not file extension — we always have the languageId already, so no path-sniffing
 * needed like Continue's `languageForFilepath`). Used by `shouldCompleteMultiline`
 * to detect "cursor is in a line comment" (single-line comments shouldn't trigger a
 * multiline completion) and available for future stop-token/heuristic tuning.
 */

const SLASH_SLASH = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'java',
  'c',
  'cpp',
  'csharp',
  'go',
  'rust',
  'kotlin',
  'swift',
  'php',
  'scala',
  'dart',
  'groovy',
  'objective-c',
  'objective-cpp',
];

const HASH = [
  'python',
  'ruby',
  'shellscript',
  'yaml',
  'toml',
  'dockerfile',
  'makefile',
  'perl',
  'r',
  'powershell',
];

const DASH_DASH = ['sql', 'lua', 'haskell'];

export function getSingleLineComment(languageId: string): string | undefined {
  if (SLASH_SLASH.includes(languageId)) return '//';
  if (HASH.includes(languageId)) return '#';
  if (DASH_DASH.includes(languageId)) return '--';
  return undefined;
}
