/**
 * W5-T2 · EditTracker's thin `vscode` adapter — the ONLY `vscode` code for
 * EditTracker (doc §2.1: "adapter only translates vscode events to
 * `EditEvent`"). All ring folding/dedup/cap logic (both the `RecentEdit`
 * ring and W5.1's `RecentDiff` ring) lives in the pure `./editTracker.ts`,
 * which this file does not duplicate or re-implement.
 *
 * W5.1 adds a per-document shadow-text cache here (visible editors only,
 * dropped on `onDidCloseTextDocument`): `TextDocumentContentChangeEvent`
 * carries only the NEW text and the replaced range, never the old text, so
 * `before` has to be derived from the last-known shadow + range, and the
 * shadow then refreshed from that same shadow + range + new text (never
 * from `document.getText()`, which already reflects the post-change state
 * by the time the event fires). This part IS unit-tested — via a mocked
 * `vscode` module (`editTracker.test.ts`'s `makeAdapterUnderTest`, the same
 * `vi.mock('vscode', ...)` discipline `nextedit/config.test.ts` uses) —
 * because the shadow-cache/coalescing behavior is exactly what W5.1 needs
 * proven, unlike the trivial, obviously-correct `toEditEvent` translation.
 */
import * as vscode from 'vscode';
import { EditTracker, rangesOverlap } from './editTracker';
import type { EditEvent } from './types';

/**
 * T-6 sweep pair: `docShadow`/`preEditShadow` below each hold one FULL
 * document's text per uri, keyed for as long as the document stays open
 * (`onDidCloseTextDocument` is the only eviction they had). A long-running
 * session that opens (or "Peek"s, previews, or otherwise briefly surfaces)
 * many more documents than are ever simultaneously visible — with no
 * guarantee about WHEN `onDidCloseTextDocument` fires for each
 * (microsoft/vscode gives none) — could otherwise grow both maps without
 * bound. Capped at this many distinct uris per map, LRU-evicted (see
 * {@link setLru}) — generous enough for a genuinely large number of
 * simultaneously-relevant tabs/recently-touched files, small enough to
 * bound worst-case memory for a session that has churned through hundreds
 * of files.
 */
export const SHADOW_CACHE_CAP = 50;

/**
 * Sets `key` → `value` in `map`, LRU-evicting the least-recently-touched
 * entry once size exceeds `cap`. `Map` iterates in INSERTION order, so
 * "recency" is maintained by deleting an existing key before re-inserting
 * it — a bare `map.set(existingKey, …)` would update the value WITHOUT
 * moving it in iteration order, which would silently defeat the "least
 * recently TOUCHED" (not "least recently inserted") contract this exists
 * for. The delete is a harmless no-op when `key` is new.
 */
function setLru<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

export interface EditTrackerAdapter extends vscode.Disposable {
  readonly tracker: EditTracker;
  /**
   * The full text of `uri`'s document as of just BEFORE its most recent
   * coalesced diff-pairs group (the same same-uri/overlap coalescing
   * `EditTracker.recordDiff` performs) — the pre-edit snapshot both
   * next-edit format modules render from (sweep-v2's `preEditRegion`,
   * Generic's `preEditDocText`). `undefined` when `uri` has no shadow:
   * never observed in a visible editor, or dropped on document close.
   */
  getPreEditText(uri: string): string | undefined;
}

/**
 * Workspace-relative POSIX path for `EditEvent.filepath` (R11 path hygiene,
 * doc §2.5). `templates.ts`'s `toRelativePath` is a private, non-exported
 * helper in that module, so it can't be imported here — this reuses
 * `vscode.workspace.asRelativePath`, the platform's own workspace-relative
 * API, normalized to POSIX separators for the Fedora/Linux target.
 */
function toWorkspaceRelativePosixPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).split('\\').join('/');
}

/**
 * Translates one `vscode.TextDocumentContentChangeEvent` into the pure
 * `EditEvent` shape. `startLine`/`endLine` describe the edited span in the
 * NEW document (post-edit) coordinate space: `change.range` is expressed in
 * the OLD document, so a multi-line insertion needs its inserted newline
 * count folded in rather than reusing `change.range.end.line` verbatim.
 */
function toEditEvent(
  document: vscode.TextDocument,
  change: vscode.TextDocumentContentChangeEvent,
): EditEvent {
  const startLine = change.range.start.line;
  const insertedNewlines = (change.text.match(/\n/g) ?? []).length;

  return {
    uri: document.uri.toString(),
    filepath: toWorkspaceRelativePosixPath(document.uri),
    startLine,
    endLine: startLine + insertedNewlines,
    content: change.text,
  };
}

/**
 * Splits `text` into whole lines, each carrying its own trailing `\n` (the
 * final line carries none when `text` has no trailing newline). Line N of
 * the returned array is exactly the span a `[startLine, endLine]` (0-based,
 * inclusive) range replaces, matching
 * `TextDocumentContentChangeEvent.range`'s convention where BOTH `start`
 * and `end` are expressed in the OLD/pre-change document.
 */
function splitKeepingNewlines(text: string): string[] {
  const parts = text.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    lines.push(`${parts[i]}\n`);
  }
  const last = parts[parts.length - 1];
  // `text.split('\n')` always yields at least one element, so `last` is
  // always present; the undefined branch is unreachable (kept for
  // totality/type safety, not a behavior change).
  if (last !== undefined && last !== '') {
    lines.push(last);
  }
  return lines;
}

/** The `[startLine, endLine]` (inclusive) span of `text`, newlines kept. */
function extractLines(text: string, startLine: number, endLine: number): string {
  return splitKeepingNewlines(text).slice(startLine, endLine + 1).join('');
}

/** `text` with its `[startLine, endLine]` (inclusive) span replaced by
 *  `replacement`; lines outside the span pass through unchanged. */
function replaceLines(text: string, startLine: number, endLine: number, replacement: string): string {
  const lines = splitKeepingNewlines(text);
  const before = lines.slice(0, startLine).join('');
  const after = lines.slice(endLine + 1).join('');
  return `${before}${replacement}${after}`;
}

/**
 * Subscribes to `vscode.workspace.onDidChangeTextDocument`, folds every
 * content change into a fresh `EditTracker` (both rings), maintains the
 * W5.1 shadow-text cache, and exposes the tracker, `getPreEditText`, and a
 * `dispose()` for all subscriptions.
 */
export function createEditTrackerAdapter(): EditTrackerAdapter {
  const tracker = new EditTracker();
  const docShadow = new Map<string, string>();
  const preEditShadow = new Map<string, string>();

  function seedShadow(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();
    if (!docShadow.has(uri)) {
      setLru(docShadow, uri, editor.document.getText(), SHADOW_CACHE_CAP);
    }
  }

  for (const editor of vscode.window.visibleTextEditors) {
    seedShadow(editor);
  }

  const visibilitySubscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
    for (const editor of editors) {
      seedShadow(editor);
    }
  });

  const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
    const uri = e.document.uri.toString();
    const filepath = toWorkspaceRelativePosixPath(e.document.uri);
    let shadow = docShadow.get(uri);

    // VS Code gives NO guarantee about the order of a multi-part
    // `contentChanges` array (microsoft/vscode#11487: "no guarantees about
    // the sort order"; #88310: an installed extension reordered the array
    // and broke exactly this kind of sequential consumer). Every
    // `change.range` below is expressed in the OLD/pre-change document, so
    // applying changes in delivery order is only safe if that order happens
    // to be bottom-to-top already — editing a HIGHER position never shifts
    // the line numbers a LOWER, not-yet-processed change still needs, so
    // sort strictly descending by start position (highest first) regardless
    // of delivery order. Copy before sorting: `contentChanges` is a
    // readonly array and must never be mutated in place.
    const orderedChanges = [...e.contentChanges].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    for (const change of orderedChanges) {
      tracker.record(toEditEvent(e.document, change));

      if (shadow === undefined) {
        // Never seeded (uri was never observed in a visible editor) —
        // nothing to derive `before` from; the RecentEdit ring above still
        // tracked it, but the diff-pairs ring and shadow stay untouched.
        continue;
      }

      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      // Character-precise splice (R-3, ADR-012): `change.range` is the EXACT
      // character range that got replaced (@types/vscode
      // index.d.ts:13424-13441) — the previous whole-line rewrite corrupted
      // the shadow on every intra-line edit. The RING's records stay
      // line-granular: `before`/`after` are both WHOLE-LINE spans of the
      // affected lines; only the splice arithmetic is character-exact.
      const span = extractLines(shadow, startLine, endLine);
      const spanLines = splitKeepingNewlines(span);
      const firstLine = spanLines[0] ?? '';
      const lastLine = spanLines[spanLines.length - 1] ?? '';
      const prefixEnd = Math.min(change.range.start.character, firstLine.length);
      const suffixStart = Math.min(span.length - lastLine.length + change.range.end.character, span.length);
      // start <= end is a vscode Range invariant; Math.max keeps totality if
      // a synthetic event ever violates it (suffix can never start before
      // the prefix ends).
      const newSpan = span.slice(0, prefixEnd) + change.text + span.slice(Math.max(prefixEnd, suffixStart));
      const before = span;
      const after = newSpan;

      // Would this change coalesce into the diff-pairs ring's existing
      // same-uri entry (the exact predicate `recordDiff` coalesces with)?
      // If so, the pre-burst snapshot already captured for this uri must
      // survive untouched; only a NEW (non-coalescing) group re-snapshots.
      const continuesBurst = tracker
        .getRecentDiffs()
        .some((d) => d.uri === uri && rangesOverlap(d.startLine, d.endLine, startLine, endLine));
      if (!continuesBurst) {
        setLru(preEditShadow, uri, shadow, SHADOW_CACHE_CAP);
      }

      // C-4: `startLine`/`endLine` here are `change.range`'s — i.e. OLD,
      // PRE-CHANGE document coordinates (0-based inclusive). They are NOT
      // re-based onto the post-change text, and nothing downstream re-bases
      // them either, so they age the moment the next edit lands. See
      // `RecentDiff`'s declaration (`nextedit/types.ts`) for the contract
      // consumers are held to.
      tracker.recordDiff({ uri, filepath, startLine, endLine, before, after });

      shadow = replaceLines(shadow, startLine, endLine, after);
      setLru(docShadow, uri, shadow, SHADOW_CACHE_CAP);
    }
  });

  const closeSubscription = vscode.workspace.onDidCloseTextDocument((doc) => {
    const uri = doc.uri.toString();
    docShadow.delete(uri);
    preEditShadow.delete(uri);
  });

  return {
    tracker,
    getPreEditText: (uri: string) => preEditShadow.get(uri),
    dispose: () => {
      changeSubscription.dispose();
      visibilitySubscription.dispose();
      closeSubscription.dispose();
    },
  };
}
