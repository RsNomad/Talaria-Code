import type { DiffHunk } from '../../../shared/protocol';

/**
 * Build display-oriented unified-diff hunks from an old/new text pair.
 *
 * ACP hands us the edit as a plain `{oldText, newText}` pair (`tool_diff_content`
 * in `acp_adapter/tools.py` / `edit_approval.py` — Hermes never sends
 * pre-computed hunks), so the extension has to diff it locally to render the
 * per-hunk review UI (spec §3.6). This is a **display** diff — hunk headers
 * only need to be readable, not machine-reappliable.
 *
 * `buildDiffHunks` has exactly one caller chain (`extractDiffs`,
 * `contentBlocks.ts`), which serves TWO paths: (a) `tool_call`/
 * `tool_call_update` rendering — a POST-APPLY display of an edit Hermes
 * already made or was allowed to make, where "Hermes has already applied the
 * edit by the time we see it" is literally true; and (b) the PRE-EXEC
 * `session/request_permission` ask-path card (`permission.ts`), where the
 * gate is pre-exec by construction (a fail-closed deny leaves the file
 * untouched) — this comment's original wording described only (a) and
 * predates W2-F1's client-side policy engine. For BOTH paths, though, this
 * function's hunks are a **display-only derivation**: W2 T4's read-only diff
 * preview (`EditPreviewRegistry`/`DiffPreviewProvider`) deliberately does NOT
 * go through this derivation — it serves the RAW wire `{oldText, newText}`
 * texts verbatim, straight off the same `AcpDiffContent` block, never the
 * on-disk file. That is what keeps the preview correct under either timing:
 * whether Hermes has or hasn't applied the edit yet when a human opens it.
 *
 * Implementation: classic O(n*m) line-level LCS + a context-line window
 * merge. Fine for typical source files; swap for a proper Myers/`diff`
 * (npm `diff`) implementation if this ever needs to handle huge files.
 *
 * `oldText == null` means the file did not previously exist (write_file to a
 * new path) — every line is an addition.
 */
export function buildDiffHunks(
  oldText: string | null | undefined,
  newText: string,
  contextLines = 3,
): DiffHunk[] {
  const oldLines = oldText != null ? splitLines(oldText) : [];
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines, newLines);
  return groupIntoHunks(ops, contextLines);
}

interface LineOp {
  sign: ' ' | '+' | '-';
  text: string;
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Longest-common-subsequence line diff, backtracked into a flat op list. */
function diffLines(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    if (row === undefined || nextRow === undefined) {
      // Unreachable: dp has n+1 rows (indices 0..n), fully populated above;
      // i and i+1 both stay within [0, n] throughout this loop.
      continue;
    }
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i];
    const bj = b[j];
    const rowI = dp[i];
    const rowI1 = dp[i + 1];
    if (ai === undefined || bj === undefined || rowI === undefined || rowI1 === undefined) {
      // Unreachable: i < n and j < m keep every one of these reads in
      // bounds (a has length n, b has length m; dp bounds as above).
      break;
    }
    if (ai === bj) {
      ops.push({ sign: ' ', text: ai });
      i++;
      j++;
    } else if ((rowI1[j] ?? 0) >= (rowI[j + 1] ?? 0)) {
      ops.push({ sign: '-', text: ai });
      i++;
    } else {
      ops.push({ sign: '+', text: bj });
      j++;
    }
  }
  while (i < n) {
    const ai = a[i];
    if (ai === undefined) {
      // Unreachable: i < n keeps the index within a's bounds.
      break;
    }
    ops.push({ sign: '-', text: ai });
    i++;
  }
  while (j < m) {
    const bj = b[j];
    if (bj === undefined) {
      // Unreachable: j < m keeps the index within b's bounds.
      break;
    }
    ops.push({ sign: '+', text: bj });
    j++;
  }
  return ops;
}

/** Positions (0-based) BEFORE each op is applied, in the old and new files. */
function computePositions(ops: LineOp[]): { oldBefore: number[]; newBefore: number[] } {
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (const op of ops) {
    oldBefore.push(oldPos);
    newBefore.push(newPos);
    if (op.sign !== '+') oldPos++;
    if (op.sign !== '-') newPos++;
  }
  return { oldBefore, newBefore };
}

function groupIntoHunks(ops: LineOp[], context: number): DiffHunk[] {
  const changedIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.sign !== ' ') changedIdx.push(idx);
  });
  if (changedIdx.length === 0) return [];

  // Merge each changed line's context window into non-overlapping windows.
  const windows: [number, number][] = [];
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
    }
  }

  const { oldBefore, newBefore } = computePositions(ops);

  return windows.map(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((o) => o.sign !== '+').length;
    const newCount = slice.filter((o) => o.sign !== '-').length;
    const firstNonAdd = slice.findIndex((o) => o.sign !== '+');
    const firstNonDel = slice.findIndex((o) => o.sign !== '-');
    // oldBefore/newBefore have exactly ops.length entries (one per op, from
    // computePositions above). `start` is clamped into [0, ops.length - 1]
    // when the window was built; when oldCount/newCount > 0, findIndex is
    // guaranteed to have found a match (not -1), so start+firstNonAdd /
    // start+firstNonDel are also in bounds. The `?? 0` fallback is therefore
    // unreachable — kept for totality/type safety, not a behavior change.
    const oldStart = oldCount > 0 ? (oldBefore[start + firstNonAdd] ?? 0) + 1 : (oldBefore[start] ?? 0);
    const newStart = newCount > 0 ? (newBefore[start + firstNonDel] ?? 0) + 1 : (newBefore[start] ?? 0);
    return {
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: slice.map((op) => ({ sign: op.sign, text: op.text })),
    };
  });
}
