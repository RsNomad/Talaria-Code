import ignore, { type Ignore } from 'ignore';

/**
 * Default excludes applied even without a `.gitignore` (how-to §6: "skip
 * binaries/lockfiles/minified/node_modules/.git, cap oversized files").
 *
 * T-19 (C1+C2, boundary move): moved from `src/rag/gitignore.ts` to
 * `src/shared/`, together with {@link createIgnoreFilter} (the only thing
 * that reads this constant). `src/host/checkpoints/CheckpointTracker.ts`
 * (outside `rag/`) needed `createIgnoreFilter`, which was a zone-crossing
 * edge (`host/checkpoints/` reaching into `rag/`). `toPosixRelative` stayed
 * behind in `rag/gitignore.ts` — it is used only within `rag/` (`indexer.ts`),
 * so it was never a zone-crossing edge and moving it would be churn, not a
 * fix. Byte-identical bodies; only the file's location changed.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  '.hermes',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.lock',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.webp',
  '*.bmp',
  '*.pdf',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.7z',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.bin',
  '*.wasm',
];

/**
 * Builds a path-ignore predicate from `.gitignore`-style file contents (one
 * string per discovered ignore file), plus the default excludes above, plus
 * any user-configured extra patterns (`talaria.rag.excludeGlobs`). The
 * returned predicate expects **POSIX-relative** paths from the workspace
 * root (see `toPosixRelative` in `src/rag/gitignore.ts`) — that's what the
 * `ignore` package itself expects.
 *
 * CONTRACT (AUDIT-5 F-6): `relPosixPath` MUST be an in-root
 * `path.relative()`'d posix path — exactly what node-ignore documents.
 * Out-of-scope input ('', '.', '..', '../…', absolute) THROWS a RangeError
 * from ignore@7 BY DESIGN (loud, like ripgrep's matcher assert and git's
 * "outside repository" fatal): scope validation is the CALLER's job — use
 * `isPathValid` from 'ignore' at the boundary (see rag/indexer.ts's
 * handleFsEvent). Deliberately NOT swallowed here: a silent "ignored"
 * answer for out-of-scope input would mask caller bugs. Pinned by
 * ignoreFilter.test.ts.
 */
export function createIgnoreFilter(
  gitignoreContents: readonly string[],
  extraPatterns: readonly string[] = [],
): (relPosixPath: string) => boolean {
  const ig: Ignore = ignore();
  ig.add([...DEFAULT_IGNORE_PATTERNS]);
  for (const contents of gitignoreContents) {
    ig.add(contents);
  }
  if (extraPatterns.length > 0) {
    ig.add([...extraPatterns]);
  }
  return (relPosixPath: string): boolean => (relPosixPath === '' ? false : ig.ignores(relPosixPath));
}
