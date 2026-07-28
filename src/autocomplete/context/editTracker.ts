/**
 * W5-T2 · EditTracker — pure core (doc §2.1's `editTracker.ts` row: "pure
 * core `(events: EditEvent[]) → RecentEdit[]`"). Folds a stream of edit
 * events into a capped, overlap-deduped ring of recently-edited ranges.
 * T3's ring-buffer / a future gather source consumes `getRecentEdits()`.
 *
 * W5.1 adds a second ring, `getRecentDiffs()`/`recordDiff()`: before/after
 * diff pairs (`RecentDiff`, `NextEditRequest.diffs`), coalesced the same
 * overlap/same-uri way as the ranges ring but MERGING on supersede — the
 * oldest superseded entry's `before` (the pre-burst snapshot) is kept
 * against the newest `after`, so a rapid burst of overlapping edits
 * collapses into one pair spanning start-of-burst to end-of-burst. Its
 * consumer is the sibling `editTrackerAdapter.ts`'s shadow-text cache
 * (`getPreEditText`), which next-edit's sweep-v2/Generic format modules
 * render from.
 *
 * Pure: zero `vscode`, zero `Date.now()`/`Math.random()`. Recency is
 * entirely positional — the order `record()` is called IS the recency
 * order, so no clock or counter is needed. The thin `vscode` adapter that
 * drives this from `onDidChangeTextDocument` lives in the sibling
 * `editTrackerAdapter.ts` (kept out of this file so the pure core needs no
 * `vscode` module resolution at all, not even a test-time mock).
 */
import type { EditEvent, RecentEdit } from './types';
import type { RecentDiff } from '../nextedit/types';

/** Ring cap — matches the recently-edited ring-buffer partition size (doc
 *  §2.1); T3's budgeter later takes only the top 3 of these 16. */
export const EDIT_TRACKER_CAP = 16;

/** Inclusive-line-range overlap: two ranges overlap iff they share at least
 *  one line number (touching at a shared boundary line counts). Exported so
 *  the sibling `editTrackerAdapter.ts` can ask "would this change coalesce
 *  into the diff-pairs ring's existing entry for this uri?" using the exact
 *  same predicate `recordDiff` coalesces with, instead of duplicating it. */
export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

export class EditTracker {
  private ring: RecentEdit[] = [];
  private diffRing: RecentDiff[] = [];

  /**
   * Fold one edit into the ring, most-recent-first.
   *
   * Dedup/coalesce by overlap: an existing same-`uri` entry whose
   * `[startLine, endLine]` overlaps the new event's range is SUPERSEDED —
   * removed and replaced by the new event — rather than the new event being
   * appended alongside it (llama.vim `chunk_sim`-style coalescing, doc
   * §2.1). Entries from a different `uri` are never touched, regardless of
   * line-range overlap.
   */
  record(event: EditEvent): void {
    const survivors = this.ring.filter(
      (entry) =>
        entry.uri !== event.uri ||
        !rangesOverlap(entry.startLine, entry.endLine, event.startLine, event.endLine),
    );

    const next: RecentEdit = {
      uri: event.uri,
      filepath: event.filepath,
      startLine: event.startLine,
      endLine: event.endLine,
      content: event.content,
    };

    this.ring = [next, ...survivors].slice(0, EDIT_TRACKER_CAP);
  }

  /** The current ring, most-recently-edited first, capped at
   *  `EDIT_TRACKER_CAP`. Returns a defensive copy — mutating the result
   *  never affects internal state. */
  getRecentEdits(): RecentEdit[] {
    return [...this.ring];
  }

  /**
   * Fold one before/after diff pair into the second ring (W5.1's
   * `RecentDiff` history, `NextEditRequest.diffs`). Same overlap/same-uri
   * coalescing predicate as `record()` (`rangesOverlap`), but the outcome
   * differs: instead of the newer entry replacing the older one outright,
   * every same-uri overlapping entry is SUPERSEDED by a MERGED entry that
   * keeps the OLDEST superseded entry's `before` (the pre-burst state), the
   * new pair's `after`, and the union of every superseded/new line range —
   * so a rapid burst of overlapping edits collapses into one pair spanning
   * "what the burst started from" to "what it ended at", never losing the
   * pre-burst snapshot. Entries from a different `uri` are never touched.
   */
  recordDiff(pair: RecentDiff): void {
    const superseded = this.diffRing.filter(
      (entry) =>
        entry.uri === pair.uri &&
        rangesOverlap(entry.startLine, entry.endLine, pair.startLine, pair.endLine),
    );
    const survivors = this.diffRing.filter((entry) => !superseded.includes(entry));

    // `diffRing` is most-recent-first, so the LAST superseded entry (if any)
    // is the OLDEST of the burst — its `before` is the pre-burst snapshot.
    const oldest = superseded.length > 0 ? superseded[superseded.length - 1] : undefined;
    const startLine = superseded.reduce((min, e) => Math.min(min, e.startLine), pair.startLine);
    const endLine = superseded.reduce((max, e) => Math.max(max, e.endLine), pair.endLine);

    const merged: RecentDiff = {
      uri: pair.uri,
      filepath: pair.filepath,
      startLine,
      endLine,
      before: oldest ? oldest.before : pair.before,
      after: pair.after,
    };

    this.diffRing = [merged, ...survivors].slice(0, EDIT_TRACKER_CAP);
  }

  /** The current diff-pairs ring, most-recently-recorded first, capped at
   *  `EDIT_TRACKER_CAP`. Returns a defensive copy — mutating the result
   *  never affects internal state. */
  getRecentDiffs(): RecentDiff[] {
    return [...this.diffRing];
  }
}
