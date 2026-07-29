/**
 * The untrusted-context policy (§2d "Untrusted-context handling — one
 * policy"). Pure —
 * zero `vscode`, zero I/O — enforced by the resolver (T2b) and, later, the
 * commit-gen orchestrator (T5).
 */

import { isSecretForCompletion } from '../backend/policy/editPolicy';

/** Budget constants for resolved context text, pinned verbatim per §2d. */
export const CONTEXT_BUDGET = {
  perItemChars: 24_000, // ~6K tokens per resolved item
  totalChars: 48_000, // aggregate across all mentions in one prompt
  diagnosticsMax: 50, // Roo's cap, grouped by file
  terminalLines: 200,
  diffChars: 30_000, // commit-gen / @git, before priority truncation
} as const;

/** The read-more notice inserted between the kept head/tail lines. */
function readMoreNotice(shown: number, total: number): string {
  return `\n… Showing ${shown} of ${total} lines; ask to read the file for more …\n`;
}

/** Fallback notice for a single line/no-newline text too long to keep whole. */
const CHAR_ELISION_NOTICE = '\n… (truncated — ask to read the file for more) …\n';

/**
 * Clamp `text` to `cap` characters with head/tail elision and a Roo-style
 * read-more notice, when over cap. Returns the text unchanged
 * (`truncated: false`) when already within cap — including the empty
 * string.
 */
export function clampText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };

  const lines = text.split('\n');
  const total = lines.length;

  if (total === 1) {
    // T2a review Minor M1: when `cap` is at or below the elision notice's own
    // length, head+notice+tail (or the notice alone) would overflow `cap` —
    // fall back to a hard slice so the result can never exceed `cap`.
    if (cap <= CHAR_ELISION_NOTICE.length) {
      return { text: text.slice(0, Math.max(0, cap)), truncated: true };
    }
    const half = Math.max(0, Math.floor((cap - CHAR_ELISION_NOTICE.length) / 2));
    const head = text.slice(0, half);
    const tail = half > 0 ? text.slice(text.length - half) : '';
    return { text: `${head}${CHAR_ELISION_NOTICE}${tail}`, truncated: true };
  }

  const halfBudget = cap / 2;

  let headEnd = 0;
  let headLen = 0;
  while (headEnd < total) {
    const line = lines[headEnd];
    if (line === undefined) {
      // Unreachable: headEnd < total === lines.length keeps this in bounds.
      break;
    }
    const lineLen = line.length + 1; // +1 for the newline
    if (headLen + lineLen > halfBudget) break;
    headLen += lineLen;
    headEnd++;
  }

  let tailStart = total;
  let tailLen = 0;
  while (tailStart > headEnd) {
    const line = lines[tailStart - 1];
    if (line === undefined) {
      // Unreachable: tailStart > headEnd >= 0 and tailStart <= total keep
      // tailStart - 1 within [0, total - 1] === [0, lines.length - 1].
      break;
    }
    const lineLen = line.length + 1;
    if (tailLen + lineLen > halfBudget) break;
    tailLen += lineLen;
    tailStart--;
  }

  const shown = headEnd + (total - tailStart);
  const notice = readMoreNotice(shown, total);
  const headText = lines.slice(0, headEnd).join('\n');
  const tailText = lines.slice(tailStart).join('\n');

  return { text: `${headText}${notice}${tailText}`, truncated: true };
}

/**
 * Secret-egress floor for resolved context (§2d point 1). A thin delegate to
 * {@link isSecretForCompletion} — the deliberately-broader autocomplete
 * egress superset — NOT a reimplementation.
 */
export function isSecretPath(path: string): boolean {
  return isSecretForCompletion(path);
}

// T5 (commit-gen): truncateDiffToBudget lives here

/** One `diff --git` file section of a unified diff, plus its +/- line counts. */
export interface DiffFileSection {
  path: string;
  body: string;
  added: number;
  removed: number;
}

/** Matches a `diff --git ` header LINE — used only to find file-SECTION
 * BOUNDARIES in {@link splitDiffByFile}. The path itself is never taken from
 * this match; see {@link extractSectionPath}. The header's `a/<path>
 * b/<path>` shape is ambiguous whenever `<path>` itself contains a literal
 * `" b/"` substring — a greedy `a\/(.*) b\/(.*)` capture then backtracks to
 * the WRONG split point (T5a review finding: this used to defeat
 * {@link excludeSecretFiles}'s secret gate for such a path). */
const DIFF_GIT_HEADER_START_RE = /^diff --git /gm;

/** The unambiguous per-file marker lines inside a section body (T5a fix):
 * each takes the WHOLE rest of its line as the path, so a literal `" b/"`
 * inside the path is harmless there — unlike the two-path `diff --git`
 * header line, these lines carry exactly one path each. */
const RENAME_TO_RE = /^rename to (.+)$/m;
const PLUS_PLUS_PLUS_B_RE = /^\+\+\+ b\/(.+)$/m;
const MINUS_MINUS_MINUS_A_RE = /^--- a\/(.+)$/m;
/** The `diff --git` header line, prefix-stripped to its `a/` remainder —
 * used ONLY by {@link extractSectionPath}'s last-resort fallback below. */
const DIFF_GIT_HEADER_A_PREFIX_RE = /^diff --git a\/(.*)$/m;

/**
 * For a `diff --git a/<X> b/<Y>` header's already-prefix-stripped remainder
 * `"<X> b/<Y>"`, resolve `<X>` assuming a NON-rename (`X === Y`) by finding
 * the split point that makes both halves equal — the `" b/"` separator is
 * exactly 3 chars, so `<X>` is the first `(len - 3) / 2` chars. Returns
 * `null` if the halves don't match (unexpected shape) or don't divide
 * evenly, so the caller can fall back further.
 */
function equalHalvesPath(remainder: string): string | null {
  const sepLen = 3; // " b/"
  if ((remainder.length - sepLen) % 2 !== 0) return null;
  const half = (remainder.length - sepLen) / 2;
  const x = remainder.slice(0, half);
  const sep = remainder.slice(half, half + sepLen);
  const y = remainder.slice(half + sepLen);
  return sep === ' b/' && x === y ? x : null;
}

/**
 * Extract one `diff --git` section's file path from its body (T5a fix). The
 * `diff --git a/<path> b/<path>` header is ambiguous when `<path>` contains
 * a literal `" b/"` substring — see {@link DIFF_GIT_HEADER_START_RE}'s
 * comment. Instead, take the path from the section's unambiguous per-file
 * lines, in priority order:
 *  1. `rename to <path>` — authoritative for renames.
 *  2. `+++ b/<path>` (post-image path, `<path>` !== `/dev/null`) — normal
 *     add/modify.
 *  3. `--- a/<path>` (`<path>` !== `/dev/null`) — deletion, where `+++` is
 *     `/dev/null`.
 *  4. Fallback for binary/mode-only sections with none of the above: parse
 *     the header itself assuming a non-rename via {@link equalHalvesPath};
 *     if that assumption doesn't hold (unexpected — believed impossible for
 *     real git output), fall back to the old greedy `a/(.*) b/(.*)` parse as
 *     a last resort. A binary secret file hitting this narrow residual is
 *     rare, and scores ~0 in `priorityScore`'s budgeting either way.
 */
export function extractSectionPath(body: string): string {
  // Every group accessed below is a non-optional capture (`(.+)`/`(.*)`,
  // no alternation) in its pattern, so whenever the enclosing `match` call
  // succeeds the group has always participated and captured a real string
  // — the `undefined` branches are unreachable, kept for totality/type
  // safety (no non-null assertion), not a behavior change.
  const renameMatch = body.match(RENAME_TO_RE);
  const renamePath = renameMatch?.[1];
  if (renamePath !== undefined) return renamePath;

  const plusMatch = body.match(PLUS_PLUS_PLUS_B_RE);
  const plusPath = plusMatch?.[1];
  if (plusPath !== undefined && plusPath !== '/dev/null') return plusPath;

  const minusMatch = body.match(MINUS_MINUS_MINUS_A_RE);
  const minusPath = minusMatch?.[1];
  if (minusPath !== undefined && minusPath !== '/dev/null') return minusPath;

  const headerMatch = body.match(DIFF_GIT_HEADER_A_PREFIX_RE);
  const remainder = headerMatch?.[1]; // "<X> b/<Y>" — still ambiguous here.
  if (remainder === undefined) return '';

  const equalHalves = equalHalvesPath(remainder);
  if (equalHalves !== null) return equalHalves;

  const greedyMatch = remainder.match(/^(.*) b\/(.*)$/);
  return greedyMatch?.[2] ?? '';
}

function countChangedLines(body: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/**
 * Parse a unified diff (as `GitPort.stagedDiff()`/`workingDiff()` return it)
 * into one section per file, split on `diff --git` header lines. Each
 * section's `body` is the verbatim slice of the original diff text — the
 * concatenation of all sections' bodies, in order, reconstructs the input
 * exactly. `added`/`removed` count `+`/`-` hunk lines, excluding the
 * `+++`/`---` file-header lines themselves.
 */
export function splitDiffByFile(diff: string): DiffFileSection[] {
  if (!diff) return [];

  const starts: number[] = [];
  for (const match of diff.matchAll(DIFF_GIT_HEADER_START_RE)) {
    starts.push(match.index);
  }
  if (starts.length === 0) return [];

  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : diff.length;
    const body = diff.slice(start, end);
    const { added, removed } = countChangedLines(body);
    return { path: extractSectionPath(body), body, added, removed };
  });
}

/**
 * Secret-egress floor for a diff (§2d point 1, applied to commit-gen per
 * §3.4/doc 04 §6.3): drop every file section whose path is
 * {@link isSecretPath}-classified BEFORE budgeting runs, so a secret file
 * never competes for (or consumes) truncation budget. Returns the remaining
 * diff (sections re-joined in original order) plus the dropped paths, for
 * the "N files skipped (secret-classified)" notice.
 */
export function excludeSecretFiles(diff: string): { diff: string; skippedFiles: string[] } {
  const sections = splitDiffByFile(diff);
  if (sections.length === 0) return { diff, skippedFiles: [] };

  const kept: string[] = [];
  const skippedFiles: string[] = [];
  for (const section of sections) {
    if (isSecretPath(section.path)) skippedFiles.push(section.path);
    else kept.push(section.body);
  }
  return { diff: kept.join(''), skippedFiles };
}

/** Lockfiles across common ecosystems — near-zero commit-message signal
 * (auto-generated, huge, not authored). Compared against the section's
 * basename. */
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'pipfile.lock',
]);

/** Path segments that mark generated/vendored/build output — never authored
 * by hand, so a diff under one of these carries ~0 commit-message signal. */
const GENERATED_PATH_SEGMENTS = new Set(['dist', 'build', 'node_modules', 'out', 'vendor', '.next']);

function isLockfilePath(path: string): boolean {
  const basename = path.toLowerCase().split('/').at(-1) ?? '';
  return LOCKFILE_BASENAMES.has(basename);
}

function isGeneratedPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.split('/').some((seg) => GENERATED_PATH_SEGMENTS.has(seg))) return true;
  return /\.min\.(?:js|css)$/.test(lower) || lower.endsWith('.map');
}

function isBinaryDiffBody(body: string): boolean {
  return /^Binary files .* differ/m.test(body) || body.includes('GIT binary patch');
}

function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return /(^|\/)(__tests__|tests?)(\/|$)/.test(lower) || /\.(?:test|spec)\.[jt]sx?$/.test(lower);
}

/**
 * GitLens' priority score: source files score high; lockfiles/generated/dist/minified/binary
 * score near-zero (so they never crowd out real code, regardless of their
 * byte size); test files are deprioritized to 0.6x their base score. Used
 * only for ORDERING (which files `truncateDiffToBudget` keeps), never
 * surfaced directly.
 */
function priorityScore(section: DiffFileSection): number {
  const base = isLockfilePath(section.path) || isGeneratedPath(section.path) || isBinaryDiffBody(section.body) ? 1 : 100;
  return isTestPath(section.path) ? base * 0.6 : base;
}

/** `# Files changed:` fallback (§2d/doc 04 §6.1) for when even the single
 * highest-priority file's diff doesn't fit the cap — a file-list summary
 * costs far fewer tokens than any real diff content. */
function fileListFallback(sections: DiffFileSection[]): string {
  const lines = sections.map((s) => `${s.path} (+${s.added}/-${s.removed})`);
  return `# Files changed:\n${lines.join('\n')}`;
}

/**
 * Truncate a diff to fit `cap` characters using GitLens' algorithm
 * (§2d/doc 04 §6.1): score every file section by {@link priorityScore},
 * sort descending (stable — ties keep original diff order), then
 * binary-search the largest priority-ordered PREFIX whose joined body size
 * fits within `cap` (the cumulative size of a growing prefix is monotonic,
 * so binary search is valid). If even the single highest-priority file
 * doesn't fit — prefix length 0 — emit the {@link fileListFallback} instead
 * of an empty diff. Already-within-cap input is returned unchanged
 * (`truncated: false`).
 */
export function truncateDiffToBudget(
  diff: string,
  cap: number = CONTEXT_BUDGET.diffChars,
): { diff: string; truncated: boolean; droppedFiles: string[] } {
  if (diff.length <= cap) return { diff, truncated: false, droppedFiles: [] };

  const sections = splitDiffByFile(diff);
  if (sections.length === 0) {
    // Not a parseable unified diff (or diff.length > cap for some other
    // reason) — a defensive hard clamp so the result can never exceed cap.
    return { diff: diff.slice(0, cap), truncated: true, droppedFiles: [] };
  }

  const byPriority = sections
    .map((section) => ({ section, score: priorityScore(section) }))
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.section);

  const prefixFits = (n: number): boolean =>
    byPriority.slice(0, n).reduce((sum, s) => sum + s.body.length, 0) <= cap;

  let lo = 0;
  let hi = byPriority.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prefixFits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const keepCount = lo;

  if (keepCount === 0) {
    return { diff: fileListFallback(sections), truncated: true, droppedFiles: sections.map((s) => s.path) };
  }

  const keptPaths = new Set(byPriority.slice(0, keepCount).map((s) => s.path));
  const keptBodies = sections.filter((s) => keptPaths.has(s.path)).map((s) => s.body);
  const droppedFiles = sections.filter((s) => !keptPaths.has(s.path)).map((s) => s.path);

  return { diff: keptBodies.join(''), truncated: true, droppedFiles };
}
