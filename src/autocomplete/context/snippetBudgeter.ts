/**
 * W5-T3 · `snippetBudgeter.ts` — priority ladder → dedup → per-mode budget →
 * line-aligned skip-not-crop → most-relevant-LAST → frozen snapshot.
 *
 * Pure: no `vscode`, no `fs`, no `Date.now()`/`Math.random()`, no `any`. This
 * module never mints a `ScannedSnippet` from scratch — it only ever narrows
 * (drops) or derives a content-truncated COPY of an already-branded
 * `ScannedSnippet` it was handed (via object spread, which TypeScript proves
 * preserves the unexported `unique symbol` brand without a cast — see
 * `w5-t3-report.md` for the empirical proof). `ringBuffer.ts` remains the
 * only module that mints from an unscanned candidate.
 */
import type { CrossFileSnippetKind } from '../types';
import type { CrossFileMode, ScannedSnippet, SnippetSnapshot } from './types';

/** §2.6 — per-assembly-mode total budget, chars. `none` gathers nothing. */
const MODE_BUDGET_CHARS: Record<CrossFileMode, number> = {
  'input-extra': 2048,
  template: 1024,
  'comment-inject': 512,
  none: 0,
};

export function snippetBudgetChars(mode: CrossFileMode): number {
  return MODE_BUDGET_CHARS[mode];
}

/** §2.2 — priority ladder, descending. `rag` rung is reserved (§2.7,
 *  deferred to v2.1 — no source produces `rag` candidates this wave, so it
 *  is deliberately not listed here; adding it later is a one-line ladder
 *  entry). Index 0 = highest priority = fills FIRST and dedup-wins ties, but
 *  emits LAST in the final most-relevant-LAST ordering (see `buildSnapshot`). */
interface Rung {
  readonly kind: CrossFileSnippetKind;
  readonly maxCount: number;
}

const LADDER: readonly Rung[] = [
  { kind: 'recently-edited', maxCount: 3 },
  { kind: 'recently-opened', maxCount: 5 },
];

/** Per-snippet char cap within a rung (the "× 500 chars" in §2.2's "cap 3
 *  snippets × 500 chars" / "cap 5 × 500 chars"). */
const PER_SNIPPET_CAP_CHARS = 500;

/** Inclusive-line-range overlap — identical semantics to `editTracker.ts`'s
 *  local helper (kept duplicated: both are small, module-local, and pure —
 *  no shared-utility file exists for this one three-line predicate yet). */
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

/**
 * A4 (security-load-bearing) — caps `content` to at most `maxChars` WITHOUT
 * ever bisecting a line: keeps only whole lines, in original order, up to
 * the budget. Returns the original string unchanged when it already fits.
 * Returns `null` when NOT EVEN THE FIRST LINE fits within `maxChars` — the
 * caller must then skip the snippet entirely rather than emit a partial
 * line or an empty string standing in for one (skip-not-crop applies at
 * this boundary too: a snippet that cannot be represented by at least one
 * whole line within budget carries no safely-extractable content).
 */
function takeWholeLinesWithinBudget(content: string, maxChars: number): string | null {
  if (content.length <= maxChars) {
    return content;
  }

  const lines = content.split('\n');
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const addedChars = kept.length === 0 ? line.length : line.length + 1; // +1 for the '\n' joiner
    if (used + addedChars > maxChars) {
      break;
    }
    kept.push(line);
    used += addedChars;
  }

  return kept.length === 0 ? null : kept.join('\n');
}

interface AcceptedRange {
  readonly uri: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Produces the frozen, KV-stable snapshot the provider consumes (§2.4).
 *
 * `activeUri` is optional belt-and-braces: `ringBuffer.ingest` already drops
 * active-document candidates at ingest (§2.1 step 2), so in the normal path
 * this parameter is redundant defense-in-depth, not the primary gate.
 */
export function buildSnapshot(
  scanned: readonly ScannedSnippet[],
  mode: CrossFileMode,
  activeUri?: string,
): SnippetSnapshot {
  const totalBudget = snippetBudgetChars(mode);
  if (totalBudget === 0) {
    return Object.freeze({ snippets: Object.freeze([]) });
  }

  const acceptedRanges: AcceptedRange[] = [];
  let usedChars = 0;
  const rungSurvivors: ScannedSnippet[][] = [];

  for (const rung of LADDER) {
    const survivors: ScannedSnippet[] = [];
    let takenForRung = 0;

    for (const candidate of scanned) {
      if (candidate.kind !== rung.kind) {
        continue;
      }
      if (takenForRung >= rung.maxCount) {
        break; // this rung is full — no benefit scanning further for it
      }
      if (activeUri !== undefined && candidate.uri === activeUri) {
        continue; // belt-and-braces (§2.2 — ingest already drops these)
      }
      if (
        acceptedRanges.some(
          (r) =>
            r.uri === candidate.uri &&
            rangesOverlap(r.startLine, r.endLine, candidate.startLine, candidate.endLine),
        )
      ) {
        continue; // dedup — a higher- or equal-priority survivor already covers this range
      }

      const trimmedContent = takeWholeLinesWithinBudget(candidate.content, PER_SNIPPET_CAP_CHARS);
      if (trimmedContent === null) {
        continue; // not even one whole line fits the per-snippet cap — skip, never crop to a partial line
      }
      if (usedChars + trimmedContent.length > totalBudget) {
        continue; // skip-not-crop (A4): doesn't fit the remaining MODE budget — never crop further
      }

      // Content unchanged -> emit the original (already-scanned, still
      // correctly branded) object as-is. Content trimmed -> derive a copy
      // via spread; TypeScript keeps the brand from `candidate`'s static
      // type (proven empirically — no unsafe cast to the branded type is
      // needed or used here).
      const emitted: ScannedSnippet =
        trimmedContent === candidate.content ? candidate : { ...candidate, content: trimmedContent };

      survivors.push(emitted);
      acceptedRanges.push({
        uri: candidate.uri,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
      });
      usedChars += trimmedContent.length;
      takenForRung += 1;
    }

    rungSurvivors.push(survivors);
  }

  // Most-relevant-LAST (§2.5): LADDER is descending priority (index 0 =
  // highest), so the final array reverses rung order — the highest-priority
  // survivors end up as the LAST elements. Correct for BOTH llama.cpp
  // `input_extra` (server keeps the TAIL on overflow, so the tail must be
  // the most relevant) and the qwen repo-FIM template (the LAST block sits
  // adjacent to the current-file `<|file_sep|>` block, nearest the cursor).
  const ordered: ScannedSnippet[] = [];
  for (let i = rungSurvivors.length - 1; i >= 0; i--) {
    const survivors = rungSurvivors[i];
    if (survivors === undefined) {
      // Unreachable: rungSurvivors has exactly one entry per LADDER rung
      // (pushed unconditionally in the loop above), and i ranges over
      // [0, rungSurvivors.length - 1] here.
      continue;
    }
    ordered.push(...survivors);
  }

  return Object.freeze({ snippets: Object.freeze(ordered) });
}
