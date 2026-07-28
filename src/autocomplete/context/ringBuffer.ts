/**
 * W5-T3 · `ringBuffer.ts` — the security choke point of Wave 5 cross-file
 * autocomplete. `ingest()` is the ONLY write path into snippet state.
 * `docs/research/wave-5/00-architecture-and-paths.md` §2.1/§2.2/§2.4/§3.2/§3.3.
 *
 * Per-source ring PARTITIONS (critic-A finding 3 — NOT one shared FIFO): the
 * high-volume `recently-edited` stream can never evict `recently-opened`
 * open-tab context, because they live in separate capped rings. `rag` is
 * reserved (§2.7, deferred to v2.1 — no source produces it this wave).
 *
 * `ingest`'s order (brief §1, exact):
 *   1. stale-anchor drop
 *   2. active-document drop
 *   3. path hygiene (defensive POSIX normalization)
 *   4. quarantine check
 *   5. SECRET SCAN — the choke point (fail-closed on throw)
 *   6. overlap-dedup (replace, not append)
 *   7. MINT the branded `ScannedSnippet` — ONLY here, ONLY after an allowed verdict
 *   8. epoch bump — ONLY on an accepted mutation (mint or replace), never on a drop
 *
 * Pure: no `vscode`, no `fs` (besides the scanner's own zero-dep design), no
 * `Date.now()`/`Math.random()`. Epoch is a monotonic counter, not a
 * timestamp. `currentAnchor`/`activeUri` are caller-supplied per call — the
 * shell (T5) owns editor state and feeds it in.
 */
import type { Anchor, ScannedSnippet, SnippetCandidate } from './types';
import type { CrossFileSnippetKind } from '../types';
import { scanSnippetForSecrets } from './secretScanner';

/**
 * The shape `ingest` accepts: a `SnippetCandidate` (T0) plus the `Anchor` it
 * was gathered for (stale-async drop, §2.4). Kept as a LOCAL extension of
 * T0's shared `SnippetCandidate` rather than modifying `context/types.ts`
 * itself — `types.ts` is a shared, multi-consumer file (T1/T2/T4 all import
 * it), so it is not this module's to widen.
 */
export interface IngestCandidate extends SnippetCandidate {
  readonly anchor: Anchor;
}

/** Partition kinds this wave actually rings. `import-def`/`lsp-def`/`diff`/
 *  `rag` are deferred (§2.2/§2.7) — a candidate of one of those kinds is
 *  dropped (no ring exists for it yet), same fail-safe posture as any other
 *  unrecognized input. */
const PARTITION_CAPS: Partial<Record<CrossFileSnippetKind, number>> = {
  'recently-edited': 16,
  'recently-opened': 16,
};

function anchorsEqual(a: Anchor, b: Anchor): boolean {
  return a.uri === b.uri && a.line === b.line;
}

/** Inclusive-line-range overlap — same semantics as `editTracker.ts`'s and
 *  `snippetBudgeter.ts`'s local copies of this predicate. */
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

/**
 * Strict, uri-scoped quarantine (§3.3 item 4 / P7 hard-fail gate). A plain
 * set of quarantined uris — NOT window-scoped, NOT content-hash-scoped.
 *
 * Why strict rather than "clear when the offending window's content
 * changes": a `SnippetCandidate` carries a per-WINDOW excerpt, not the whole
 * file, so no candidate this module ever receives is a trustworthy "the
 * FILE changed" signal — only a trustworthy "this WINDOW changed" signal.
 * A window-scoped auto-clear (clearing the whole-uri quarantine the moment
 * the exact previously-rejected window is resubmitted with different bytes)
 * was tried and found unsound: resubmitting the OFFENDING window
 * edited-clean cleared the quarantine for the ENTIRE uri, re-exposing any
 * sibling window of the same file that still carried secret material and
 * had never itself been re-verified (the split-secret/windowing bypass this
 * quarantine exists to close, verified as an actual `count=2` leak in
 * independent review). A single rejected window must not be able to vouch
 * for the rest of a file it never saw.
 *
 * The only sound clear condition is therefore an explicit, whole-file
 * signal from OUTSIDE this module — see `clearQuarantine` below.
 */
export class RingBuffer {
  private readonly partitions = new Map<CrossFileSnippetKind, ScannedSnippet[]>();
  /** Quarantined uris — see the class doc-comment above (§3.3 item 4 / P7). */
  private readonly quarantine = new Set<string>();
  private epoch = 0;

  /**
   * The ONLY mutator. See the module doc-comment for the exact 8-step order.
   */
  ingest(candidate: IngestCandidate, activeUri: string, currentAnchor: Anchor): void {
    // 1. Stale-async drop — a gather that resolved after the cursor moved
    // cannot pollute the buffer.
    if (!anchorsEqual(candidate.anchor, currentAnchor)) {
      return;
    }

    // 2. Active-doc drop, AT INGEST (not at fill) — the prefix/suffix
    // already carry the active file; dropping here keeps the dominant edit
    // stream from churning the epoch (A3).
    if (candidate.uri === activeUri) {
      return;
    }

    // 3. Path hygiene (R11) — defensive POSIX normalization. The source is
    // expected to already hand us a workspace-relative path; this only
    // guards against a stray backslash making it through.
    const filepath = candidate.filepath.replace(/\\/g, '/');

    // 4. Quarantine check — strict, uri-scoped (§3.3 item 4 / P7). No window
    // comparison, no content hash: every candidate from a quarantined uri
    // drops until an explicit `clearQuarantine(uri)` call (see the class
    // doc-comment for why window-content-based clearing is unsound).
    if (this.quarantine.has(candidate.uri)) {
      return;
    }

    // 5. SECRET SCAN — the choke point. A throw is treated as a reject
    // (fail-closed): no snippet reaches a ring without an explicit `allowed`
    // verdict.
    let allowed: boolean;
    try {
      allowed = scanSnippetForSecrets({ path: filepath, content: candidate.content }).allowed;
    } catch {
      allowed = false;
    }

    if (!allowed) {
      // Quarantine the WHOLE uri (not just drop this window) — closes the
      // split-secret/windowing bypass (§3.3 item 4): every candidate from
      // this uri drops until an explicit `clearQuarantine(uri)` call.
      this.quarantine.add(candidate.uri);
      return; // drop — do NOT mint
    }

    // 6. Overlap-dedup, within the SAME-KIND ring only: an existing entry
    // whose {uri,[startLine,endLine]} overlaps this candidate's is REPLACED
    // (llama.vim `chunk_sim`-style), not appended alongside.
    const cap = PARTITION_CAPS[candidate.kind];
    if (cap === undefined) {
      return; // unsupported kind this wave (rag/import-def/lsp-def/diff) — no ring exists yet
    }

    const ring = this.partitions.get(candidate.kind) ?? [];
    const survivors = ring.filter(
      (existing) =>
        !(
          existing.uri === candidate.uri &&
          rangesOverlap(existing.startLine, existing.endLine, candidate.startLine, candidate.endLine)
        ),
    );

    // 7. MINT — the ONLY place `ScannedSnippet` is minted in the whole
    // codebase, and only reachable after an explicit `allowed` verdict.
    const minted = {
      uri: candidate.uri,
      filepath,
      content: candidate.content,
      kind: candidate.kind,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
    } as ScannedSnippet;

    // Most-recent-first (mirrors `editTracker.ts`'s convention): prepend,
    // then cap by dropping the OLDEST (tail) entries past `cap`.
    this.partitions.set(candidate.kind, [minted, ...survivors].slice(0, cap));

    // 8. Epoch bump — ONLY on this accepted mutation path (mint or
    // replace); every drop above returned before reaching here.
    this.epoch += 1;
  }

  /**
   * The ONLY way a quarantined uri re-enters scanning (§3.3 item 4 / P7).
   * A whole-file "the content changed" signal, sourced from OUTSIDE this
   * module — the shell (T5) calls this on a whole-file change event
   * (`onDidSaveTextDocument`), which is a real, editor-observed signal that
   * no per-window `SnippetCandidate` can provide on its own (see the class
   * doc-comment for why inferring this from window content is unsound).
   *
   * This grants no amnesty beyond "scan again": a uri that is still secret
   * simply re-quarantines on its very next `ingest` call (the offending
   * window re-rejects). It is not a bypass — it only removes the "skip the
   * scan" short-circuit for this uri.
   */
  clearQuarantine(uri: string): void {
    this.quarantine.delete(uri);
  }

  /** Monotonic — bumped only on an accepted `ingest` mutation. */
  currentEpoch(): number {
    return this.epoch;
  }

  /** Flattened, immutable read across all partitions (for the budgeter). */
  allScanned(): readonly ScannedSnippet[] {
    const all: ScannedSnippet[] = [];
    for (const ring of this.partitions.values()) {
      all.push(...ring);
    }
    return all;
  }
}
