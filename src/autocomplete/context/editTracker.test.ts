import { describe, it, expect, vi } from 'vitest';
import { EditTracker, EDIT_TRACKER_CAP } from './editTracker';
import type { EditEvent } from './types';
import { must } from '../../testing/must';

/**
 * W5.1 adapter shadow-text tests — same `vi.mock('vscode', ...)` discipline
 * as `nextedit/config.test.ts`: a minimal fake `vscode` module, just enough
 * surface for `createEditTrackerAdapter` to run against synthetic events,
 * declared BEFORE the `vi.mock` call so its (hoisted) factory can close
 * over it, and the real adapter import AFTER the mock so it resolves
 * against the fake module.
 */
interface FakeEditor {
  document: { uri: { scheme: string; toString(): string }; getText(): string };
}
interface FakeChangeEvent {
  document: { uri: { scheme: string; toString(): string } };
  contentChanges: {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    text: string;
  }[];
}
interface FakeCloseDoc {
  uri: { toString(): string };
}

const adapterMockState: {
  visibleEditors: FakeEditor[];
  changeHandler?: (e: FakeChangeEvent) => void;
  closeHandler?: (doc: FakeCloseDoc) => void;
  /** T-6 sweep (LRU cap test infra): captures `onDidChangeVisibleTextEditors`'s
   *  callback the same way `changeHandler`/`closeHandler` already do, so a
   *  test can seed a document AFTER construction (the initial `visibleEditors`
   *  seed alone can't exercise "a NEW document seeded once the cache is
   *  already at capacity"). Unused by every pre-existing test — this file's
   *  own mock previously discarded the callback entirely. */
  visibilityHandler?: (editors: FakeEditor[]) => void;
} = { visibleEditors: [] };

vi.mock('vscode', () => ({
  window: {
    get visibleTextEditors() {
      return adapterMockState.visibleEditors;
    },
    onDidChangeVisibleTextEditors: (cb: (editors: FakeEditor[]) => void) => {
      adapterMockState.visibilityHandler = cb;
      return { dispose() {} };
    },
  },
  workspace: {
    onDidChangeTextDocument: (cb: (e: FakeChangeEvent) => void) => {
      adapterMockState.changeHandler = cb;
      return { dispose() {} };
    },
    onDidCloseTextDocument: (cb: (doc: FakeCloseDoc) => void) => {
      adapterMockState.closeHandler = cb;
      return { dispose() {} };
    },
    asRelativePath: (uri: { toString(): string }) => uri.toString(),
  },
}));

import { createEditTrackerAdapter, SHADOW_CACHE_CAP } from './editTrackerAdapter';

function makeFakeEditor(uri: string, text: string, scheme = 'file'): FakeEditor {
  return { document: { uri: { scheme, toString: () => uri }, getText: () => text } };
}

/** Builds a real `EditTrackerAdapter` (production code) wired to the fake
 *  `vscode` module above, seeded with `initialDocs` as its visible-editor
 *  shadow set, plus a synthetic `applyChange` to drive it without a real
 *  `vscode.TextDocumentChangeEvent`. */
function makeAdapterUnderTest(initialDocs: Record<string, string>) {
  adapterMockState.visibleEditors = Object.entries(initialDocs).map(([uri, text]) =>
    makeFakeEditor(uri, text),
  );
  adapterMockState.changeHandler = undefined;
  adapterMockState.closeHandler = undefined;
  adapterMockState.visibilityHandler = undefined;

  const adapter = createEditTrackerAdapter();

  return {
    tracker: adapter.tracker,
    getPreEditText: (uri: string) => adapter.getPreEditText(uri),
    /** T-6 sweep: seeds ONE new document via `onDidChangeVisibleTextEditors`,
     *  as opposed to `initialDocs` (seeded once, at construction). */
    openEditor(uri: string, text: string) {
      adapterMockState.visibilityHandler?.([makeFakeEditor(uri, text)]);
    },
    applyChange(uri: string, change: { startLine: number; endLine: number; newText: string; scheme?: string }) {
      adapterMockState.changeHandler?.({
        document: { uri: { scheme: change.scheme ?? 'file', toString: () => uri } },
        contentChanges: [
          {
            range: {
              start: { line: change.startLine, character: 0 },
              end: { line: change.endLine, character: Number.MAX_SAFE_INTEGER },
            },
            text: change.newText,
          },
        ],
      });
    },
    /** Fires a SINGLE `onDidChangeTextDocument` event carrying MULTIPLE
     *  `contentChanges`, in exactly the array order given — used to probe
     *  ordering assumptions, since VS Code gives no guarantee about the
     *  order of a multi-part `contentChanges` array. */
    applyMultiChange(
      uri: string,
      changes: { startLine: number; endLine: number; newText: string; startChar?: number; endChar?: number }[],
    ) {
      adapterMockState.changeHandler?.({
        document: { uri: { scheme: 'file', toString: () => uri } },
        contentChanges: changes.map((change) => ({
          range: {
            start: { line: change.startLine, character: change.startChar ?? 0 },
            end: { line: change.endLine, character: change.endChar ?? Number.MAX_SAFE_INTEGER },
          },
          text: change.newText,
        })),
      });
    },
    /** Character-precise change — the REAL VS Code event shape
     *  (@types/vscode index.d.ts:13424-13441: `range` is the exact range
     *  that got replaced). */
    applyCharChange(
      uri: string,
      change: { start: { line: number; character: number }; end: { line: number; character: number }; newText: string },
    ) {
      adapterMockState.changeHandler?.({
        document: { uri: { scheme: 'file', toString: () => uri } },
        contentChanges: [{ range: { start: change.start, end: change.end }, text: change.newText }],
      });
    },
    closeDoc(uri: string) {
      adapterMockState.closeHandler?.({ uri: { toString: () => uri } });
    },
  };
}

function makeEvent(overrides: Partial<EditEvent> = {}): EditEvent {
  return {
    uri: 'file:///repo/a.ts',
    filepath: 'a.ts',
    startLine: 0,
    endLine: 0,
    content: 'const a = 1;',
    ...overrides,
  };
}

describe('EditTracker (pure core)', () => {
  it('returns an empty array when no edits have been recorded', () => {
    const tracker = new EditTracker();

    expect(tracker.getRecentEdits()).toEqual([]);
  });

  it('returns a single recorded edit as a RecentEdit with the same fields', () => {
    const tracker = new EditTracker();
    const event = makeEvent({ startLine: 3, endLine: 5, content: 'const x = 2;' });

    tracker.record(event);

    expect(tracker.getRecentEdits()).toEqual([
      { uri: event.uri, filepath: event.filepath, startLine: 3, endLine: 5, content: 'const x = 2;' },
    ]);
  });

  it('orders edits most-recently-recorded first', () => {
    const tracker = new EditTracker();
    tracker.record(makeEvent({ startLine: 0, endLine: 0, content: 'first' }));
    tracker.record(makeEvent({ startLine: 10, endLine: 10, content: 'second' }));
    tracker.record(makeEvent({ startLine: 20, endLine: 20, content: 'third' }));

    const edits = tracker.getRecentEdits();

    expect(edits.map((e) => e.content)).toEqual(['third', 'second', 'first']);
  });

  it('replaces (does not append) an older same-uri entry whose range overlaps the new edit', () => {
    const tracker = new EditTracker();
    tracker.record(makeEvent({ startLine: 5, endLine: 10, content: 'old' }));
    tracker.record(makeEvent({ startLine: 8, endLine: 12, content: 'new' }));

    const edits = tracker.getRecentEdits();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ startLine: 8, endLine: 12, content: 'new' });
  });

  it('treats touching boundary lines as overlapping (shared line counts as overlap)', () => {
    const tracker = new EditTracker();
    tracker.record(makeEvent({ startLine: 0, endLine: 5, content: 'old' }));
    tracker.record(makeEvent({ startLine: 5, endLine: 9, content: 'new' }));

    expect(tracker.getRecentEdits()).toHaveLength(1);
  });

  it('keeps non-overlapping same-uri edits as separate entries', () => {
    const tracker = new EditTracker();
    tracker.record(makeEvent({ startLine: 0, endLine: 3, content: 'block-a' }));
    tracker.record(makeEvent({ startLine: 10, endLine: 13, content: 'block-b' }));

    const edits = tracker.getRecentEdits();

    expect(edits).toHaveLength(2);
    expect(edits.map((e) => e.content)).toEqual(['block-b', 'block-a']);
  });

  it('tracks two different uris independently even when their ranges overlap', () => {
    const tracker = new EditTracker();
    tracker.record(makeEvent({ uri: 'file:///repo/a.ts', filepath: 'a.ts', startLine: 5, endLine: 10, content: 'a-content' }));
    tracker.record(makeEvent({ uri: 'file:///repo/b.ts', filepath: 'b.ts', startLine: 5, endLine: 10, content: 'b-content' }));

    const edits = tracker.getRecentEdits();

    expect(edits).toHaveLength(2);
    expect(edits.map((e) => e.uri).sort()).toEqual(['file:///repo/a.ts', 'file:///repo/b.ts']);
  });

  it('caps the ring at EDIT_TRACKER_CAP (16), evicting the oldest entry on the 17th distinct edit', () => {
    const tracker = new EditTracker();
    expect(EDIT_TRACKER_CAP).toBe(16);

    // 17 non-overlapping edits (10-line gaps so none coalesce).
    for (let i = 0; i < 17; i++) {
      tracker.record(makeEvent({ startLine: i * 10, endLine: i * 10 + 1, content: `edit-${i}` }));
    }

    const edits = tracker.getRecentEdits();

    expect(edits).toHaveLength(16);
    // Most recent (edit-16) first; oldest surviving is edit-1 (edit-0 evicted).
    expect(edits[0]?.content).toBe('edit-16');
    expect(edits[15]?.content).toBe('edit-1');
    expect(edits.some((e) => e.content === 'edit-0')).toBe(false);
  });

  it('does not let the caller mutate internal state via the returned array', () => {
    const tracker = new EditTracker();
    tracker.record(makeEvent({ content: 'first' }));

    const edits = tracker.getRecentEdits();
    // `EditEvent` and `RecentEdit` are structurally identical (see types.ts),
    // so this assigns with no cast.
    edits.push(makeEvent({ content: 'injected' }));

    expect(tracker.getRecentEdits()).toHaveLength(1);
  });
});

describe('EditTracker diff-pairs ring (W5.1)', () => {
  const pair = (uri: string, s: number, e: number, before: string, after: string) =>
    ({ uri, filepath: uri, startLine: s, endLine: e, before, after });

  it('records pairs most-recent-first with defensive copies', () => {
    const t = new EditTracker();
    t.recordDiff(pair('file:///a.ts', 1, 2, 'old1', 'new1'));
    t.recordDiff(pair('file:///a.ts', 10, 11, 'old2', 'new2'));
    const diffs = t.getRecentDiffs();
    expect(diffs.map((d) => d.before)).toEqual(['old2', 'old1']);
    diffs.pop();
    expect(t.getRecentDiffs()).toHaveLength(2);
  });

  it('coalesces overlapping same-uri pairs: newer supersedes, keeping the OLDEST before and newest after', () => {
    const t = new EditTracker();
    t.recordDiff(pair('file:///a.ts', 5, 7, 'original text', 'mid text'));
    t.recordDiff(pair('file:///a.ts', 6, 8, 'mid text', 'final text'));
    const diffs = t.getRecentDiffs();
    expect(diffs).toHaveLength(1);
    const diff0 = must(diffs[0]);
    expect(diff0.before).toBe('original text'); // the pre-burst state survives coalescing
    expect(diff0.after).toBe('final text');
    expect(diff0.startLine).toBe(5);
    expect(diff0.endLine).toBe(8);
  });

  it('caps at EDIT_TRACKER_CAP', () => {
    const t = new EditTracker();
    for (let i = 0; i < 20; i++) t.recordDiff(pair('file:///a.ts', i * 100, i * 100 + 1, `b${i}`, `a${i}`));
    expect(t.getRecentDiffs()).toHaveLength(EDIT_TRACKER_CAP);
    expect(must(t.getRecentDiffs()[0]).before).toBe('b19');
  });
});

describe('editTrackerAdapter shadow text (W5.1)', () => {
  it('derives before from the shadow and exposes the pre-burst text', () => {
    const adapter = makeAdapterUnderTest({ 'file:///a.ts': 'line0\nline1\nline2\n' });
    adapter.applyChange('file:///a.ts', { startLine: 1, endLine: 1, newText: 'LINE-ONE\n' });
    expect(adapter.getPreEditText('file:///a.ts')).toBe('line0\nline1\nline2\n');
    const d = must(adapter.tracker.getRecentDiffs()[0]);
    expect(d.before).toBe('line1\n');
    expect(d.after).toBe('LINE-ONE\n');
  });

  it('returns undefined for a never-shadowed document and drops the shadow on close', () => {
    const adapter = makeAdapterUnderTest({});
    expect(adapter.getPreEditText('file:///never-seen.ts')).toBeUndefined();
  });

  it('drops the shadow when the document closes (the second half of the above test title)', () => {
    const adapter = makeAdapterUnderTest({ 'file:///b.ts': 'x\ny\n' });
    adapter.applyChange('file:///b.ts', { startLine: 0, endLine: 0, newText: 'X\n' });
    expect(adapter.getPreEditText('file:///b.ts')).toBe('x\ny\n');

    adapter.closeDoc('file:///b.ts');

    expect(adapter.getPreEditText('file:///b.ts')).toBeUndefined();
  });

  /**
   * Important finding (review of W5.1/T2): VS Code gives NO ordering
   * guarantee for a multi-part `contentChanges` array — microsoft/vscode
   * #11487 ("no guarantees about the sort order") and #88310 (an installed
   * extension reordered the array and broke exactly this kind of sequential
   * consumer). The adapter must process a multi-part event in strictly
   * descending document position (highest `range.start` first) regardless
   * of delivery order, because editing a higher line never shifts the line
   * numbers a lower, not-yet-processed change still needs.
   *
   * This test hands the adapter two non-overlapping changes in ASCENDING
   * (top-to-bottom) array order — the order that desyncs a naive
   * sequential-mutation implementation — on a 6-line document, and checks
   * both that each change's own recorded before/after is coherent AND that
   * the persistent shadow is not corrupted for a LATER, unrelated event.
   */
  it('processes a multi-part contentChanges event order-independently, regardless of the array order VS Code delivers', () => {
    const uri = 'file:///order.ts';
    const original = 'line0\nline1\nline2\nline3\nline4\nline5\n';
    const adapter = makeAdapterUnderTest({ [uri]: original });

    // Ascending array order: the earlier (lower-line) change first, exactly
    // as it would break a naive "mutate shadow in delivery order" adapter.
    adapter.applyMultiChange(uri, [
      { startLine: 0, endLine: 0, newText: 'A0\nA1\n' }, // line0: 1 line -> 2 lines
      { startLine: 3, endLine: 3, newText: 'B3\n' }, // line3: 1 line -> 1 line
    ]);

    const diffs = adapter.tracker.getRecentDiffs();
    const diffA = diffs.find((d) => d.startLine === 0);
    const diffB = diffs.find((d) => d.startLine === 3);

    // (a) each change's before/after must reflect the ORIGINAL document —
    // never a shadow already mutated by a sibling change from the same
    // batch.
    expect(diffA?.before).toBe('line0\n');
    expect(diffA?.after).toBe('A0\nA1\n');
    expect(diffB?.before).toBe('line3\n');
    expect(diffB?.after).toBe('B3\n');

    // (b) the persistent docShadow must not be corrupted for a FOLLOWING
    // event: line3 got replaced by "B3\n", and line0's extra inserted line
    // shifts everything below it down by one, so the untouched "line4" that
    // followed "B3" now sits where "B3\n" itself should read back from —
    // probing a range that does NOT overlap either change above (so this
    // recordDiff call can't coalesce with diffA/diffB and mask a stale
    // `before`) must see the coherent post-edit shadow, not a desynced one.
    adapter.applyMultiChange(uri, [{ startLine: 4, endLine: 4, newText: 'PROBE\n' }]);
    const diffProbe = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 4);
    expect(diffProbe?.before).toBe('B3\n');
  });

  it('an intra-line (character-range) edit keeps the shadow byte-accurate — typing must not corrupt later diffs', () => {
    const adapter = makeAdapterUnderTest({ 'file:///doc.ts': 'hello world\nsecond\n' });
    // Type "X" at line 0, column 5 — the event VS Code delivers for a keystroke.
    adapter.applyCharChange('file:///doc.ts', {
      start: { line: 0, character: 5 },
      end: { line: 0, character: 5 },
      newText: 'X',
    });
    const typed = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 0);
    expect(typed?.before).toBe('hello world\n');
    expect(typed?.after).toBe('helloX world\n');   // resulting WHOLE line (ADR-012), not the raw fragment

    // Probe a NON-overlapping line so recordDiff cannot coalesce and mask a stale shadow.
    adapter.applyChange('file:///doc.ts', { startLine: 1, endLine: 1, newText: 'SECOND\n' });
    const probe = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 1);
    expect(probe?.before).toBe('second\n');
  });

  it('two same-line cursors in ONE event are both applied exactly (closes the recorded line-granularity limitation)', () => {
    const adapter = makeAdapterUnderTest({ 'file:///mc.ts': 'aa bb cc\nend\n' });
    // Delivered ASCENDING (worst case) — the adapter must process right-to-left.
    adapter.applyMultiChange('file:///mc.ts', [
      { startLine: 0, endLine: 0, startChar: 3, endChar: 5, newText: 'XX' },  // 'bb' -> 'XX'
      { startLine: 0, endLine: 0, startChar: 6, endChar: 8, newText: 'YY' },  // 'cc' -> 'YY'
    ]);
    const line0 = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 0);
    expect(line0?.before).toBe('aa bb cc\n');   // oldest-before survives coalescing
    expect(line0?.after).toBe('aa XX YY\n');    // both cursors applied, character-exact

    // Line 1 must be untouched by any of it.
    adapter.applyChange('file:///mc.ts', { startLine: 1, endLine: 1, newText: 'END\n' });
    const probe = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 1);
    expect(probe?.before).toBe('end\n');
  });

  /**
   * Remediation Task 3 review finding: the committed suite drove
   * genuinely character-precise ranges only on a SINGLE line (the "typed
   * X" and "two cursors" tests above). The three tests below drive the
   * splice (editTrackerAdapter.ts ~:167-201) with genuinely
   * character-bearing MULTI-LINE ranges — never the `character:0` /
   * `Number.MAX_SAFE_INTEGER` whole-line emulation `applyChange` uses —
   * to close that gap. Each pins an exact expected shadow value, so any
   * regression to a wrong prefix/suffix computation, a dropped/duplicated
   * middle line, or a reversion to whole-line replacement fails loudly.
   */

  it('an intra-line deletion (character-precise range, text: "") shrinks the shadow exactly — not a whole-line drop', () => {
    const adapter = makeAdapterUnderTest({ 'file:///del.ts': 'hello\nsecond\n' });
    // Delete chars 3..5 of line 0 ("lo") — a real VS Code delete-selection event.
    adapter.applyCharChange('file:///del.ts', {
      start: { line: 0, character: 3 },
      end: { line: 0, character: 5 },
      newText: '',
    });
    expect(adapter.getPreEditText('file:///del.ts')).toBe('hello\nsecond\n');
    const deleted = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 0);
    expect(deleted?.before).toBe('hello\n');
    expect(deleted?.after).toBe('hel\n');

    // Probe a non-overlapping line: a splice that mis-sized the deletion
    // (e.g. dropped line0 entirely, or left a stale trailing char) would
    // desync the persistent shadow and this probe would read the wrong text.
    adapter.applyChange('file:///del.ts', { startLine: 1, endLine: 1, newText: 'SECOND\n' });
    const probe = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 1);
    expect(probe?.before).toBe('second\n');
  });

  it('a multi-line replacement (range spans line A char x .. line B char y) drops the stale middle line and stitches line A\'s prefix to line B\'s suffix — the highest-risk splice path', () => {
    const adapter = makeAdapterUnderTest({ 'file:///multi.ts': 'AAAA\nBBBB\nCCCC\n' });
    // Replace from line0 char2 through line2 char2 with 'zz': the middle
    // line (BBBB) is entirely inside the replaced range and must be
    // dropped, and the result must splice line0's PREFIX ('AA', NOT
    // line2's) with line2's SUFFIX ('CC', NOT line0's) — a splice that
    // used the wrong line's prefix/suffix, or kept BBBB verbatim, produces
    // a different string than 'AAzzCC\n'.
    adapter.applyCharChange('file:///multi.ts', {
      start: { line: 0, character: 2 },
      end: { line: 2, character: 2 },
      newText: 'zz',
    });
    expect(adapter.getPreEditText('file:///multi.ts')).toBe('AAAA\nBBBB\nCCCC\n');
    const replaced = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 0);
    expect(replaced?.before).toBe('AAAA\nBBBB\nCCCC\n');
    expect(replaced?.after).toBe('AAzzCC\n');
    expect(replaced?.endLine).toBe(2);
  });

  it('a newline insertion (text: "\\n" at a mid-line character) splits one line into two, preserving both halves', () => {
    const adapter = makeAdapterUnderTest({ 'file:///split.ts': 'hello world\nsecond\n' });
    // Insert a bare newline at line0 char5 (pressing Enter mid-line) — the
    // result must keep BOTH the head ('hello\n') and the tail (' world\n'),
    // not swallow one half the way a range-as-whole-line bug would.
    adapter.applyCharChange('file:///split.ts', {
      start: { line: 0, character: 5 },
      end: { line: 0, character: 5 },
      newText: '\n',
    });
    expect(adapter.getPreEditText('file:///split.ts')).toBe('hello world\nsecond\n');
    const split = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 0);
    expect(split?.before).toBe('hello world\n');
    expect(split?.after).toBe('hello\n world\n');

    // Probe: line0 became 2 lines, so the untouched 'second\n' now sits at
    // NEW index 2, not 1. A splice that failed to preserve both halves
    // would miscount lines and desync the persistent shadow, so this probe
    // would read the wrong text.
    adapter.applyChange('file:///split.ts', { startLine: 2, endLine: 2, newText: 'SECOND\n' });
    const probe = adapter.tracker.getRecentDiffs().find((d) => d.startLine === 2);
    expect(probe?.before).toBe('second\n');
  });
});

/**
 * CF-19 / W4-T3 — the edit-ring recording site (`editTrackerAdapter.ts`'s
 * `changeSubscription`, ~173) previously folded EVERY `onDidChangeTextDocument`
 * event into `EditTracker` regardless of scheme, so Output/SCM text entered
 * the edit ring, shipped as FIM `input_extra`, and armed next-edit. This now
 * gates on the shared `isRecordableScheme` predicate (mirrors GATE-4,
 * `nextedit/shell.vscode.ts`), matching `recordableScheme.test.ts`'s own
 * unit coverage of the predicate itself.
 */
describe('editTrackerAdapter scheme guard (CF-19)', () => {
  it('an "output"-scheme document change records NOTHING — neither ring, no shadow', () => {
    const adapter = makeAdapterUnderTest({});
    adapter.applyChange('output:extension-output-talaria', {
      startLine: 0,
      endLine: 0,
      newText: 'some log line\n',
      scheme: 'output',
    });

    expect(adapter.tracker.getRecentEdits()).toHaveLength(0);
    expect(adapter.tracker.getRecentDiffs()).toHaveLength(0);
  });

  it('a "vscode-scm"-scheme document change records NOTHING (GATE-4 parity)', () => {
    const adapter = makeAdapterUnderTest({});
    adapter.applyChange('vscode-scm:1234/input', {
      startLine: 0,
      endLine: 0,
      newText: 'commit message draft',
      scheme: 'vscode-scm',
    });

    expect(adapter.tracker.getRecentEdits()).toHaveLength(0);
    expect(adapter.tracker.getRecentDiffs()).toHaveLength(0);
  });

  it('control: an ordinary "file"-scheme change IS still recorded (the guard is not vacuous)', () => {
    const adapter = makeAdapterUnderTest({ 'file:///a.ts': 'line0\n' });
    adapter.applyChange('file:///a.ts', { startLine: 0, endLine: 0, newText: 'LINE0\n', scheme: 'file' });

    expect(adapter.tracker.getRecentEdits()).toHaveLength(1);
    expect(adapter.tracker.getRecentDiffs()).toHaveLength(1);
  });

  it('control: an "untitled"-scheme change IS still recorded to the edit ring', () => {
    const adapter = makeAdapterUnderTest({});
    adapter.applyChange('untitled:Untitled-1', {
      startLine: 0,
      endLine: 0,
      newText: 'draft text\n',
      scheme: 'untitled',
    });

    expect(adapter.tracker.getRecentEdits()).toHaveLength(1);
  });
});

/**
 * T-6 sweep pair: `editTrackerAdapter.ts`'s per-document shadow caches
 * (`docShadow`, `preEditShadow`) held one full-text entry per URI ever
 * observed, with no cap — closing a document evicts it (`onDidCloseTextDocument`),
 * but a long-running session that opens (and never explicitly closes, or is
 * slow to) many more than a handful of files would grow both maps without
 * bound. `SHADOW_CACHE_CAP` LRU-evicts the least-recently-touched uri once
 * either map exceeds it.
 */
describe('editTrackerAdapter shadow cache LRU cap (T-6 sweep)', () => {
  it('evicts the OLDEST-seeded document from docShadow once more than SHADOW_CACHE_CAP distinct uris have been seeded', () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i <= SHADOW_CACHE_CAP; i++) {
      docs[`file:///doc${i}.ts`] = `content ${i}\n`;
    }
    const adapter = makeAdapterUnderTest(docs);

    // doc0 was seeded FIRST, so it is the one LRU-evicted once the
    // (SHADOW_CACHE_CAP + 1)th distinct uri (docSHADOW_CACHE_CAP) was
    // seeded. An edit against an evicted uri has no shadow to derive
    // `before` from, so `recordDiff` is never called for it (`editTrackerAdapter.ts`'s
    // documented "never observed" no-op path) — observable via `getRecentDiffs()`.
    adapter.applyChange('file:///doc0.ts', { startLine: 0, endLine: 0, newText: 'x\n' });
    expect(adapter.tracker.getRecentDiffs().some((d) => d.uri === 'file:///doc0.ts')).toBe(false);

    // The MOST recently seeded uri survives (still within the cap): its
    // edit DOES produce a diff-pair.
    const survivorUri = `file:///doc${SHADOW_CACHE_CAP}.ts`;
    adapter.applyChange(survivorUri, { startLine: 0, endLine: 0, newText: 'y\n' });
    expect(adapter.tracker.getRecentDiffs().some((d) => d.uri === survivorUri)).toBe(true);
  });

  it('does NOT evict anything when exactly SHADOW_CACHE_CAP distinct uris are seeded (the cap is inclusive, not off-by-one)', () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < SHADOW_CACHE_CAP; i++) {
      docs[`file:///cap${i}.ts`] = `content ${i}\n`;
    }
    const adapter = makeAdapterUnderTest(docs);

    // The FIRST-seeded uri, which would be evicted if the cap were
    // off-by-one, must still be alive.
    adapter.applyChange('file:///cap0.ts', { startLine: 0, endLine: 0, newText: 'x\n' });
    expect(adapter.tracker.getRecentDiffs().some((d) => d.uri === 'file:///cap0.ts')).toBe(true);
  });

  it('touching (editing) an existing uri bumps its recency — it survives a LATER eviction that a same-age untouched uri would not', () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < SHADOW_CACHE_CAP; i++) {
      docs[`file:///bump${i}.ts`] = `content ${i}\n`;
    }
    const adapter = makeAdapterUnderTest(docs);

    // Touch the OLDEST-seeded uri (bump0) — this must move it to the END of
    // the recency order, ahead of bump1 (untouched, now the new oldest).
    adapter.applyChange('file:///bump0.ts', { startLine: 0, endLine: 0, newText: 'touched\n' });

    // Seed ONE more distinct uri — pushes the map 1 past the cap. If
    // recency were insertion-order-only (no bump), bump0 (seeded first)
    // would be evicted; since it was just touched, bump1 (untouched, now
    // the true oldest) is evicted instead.
    adapter.openEditor('file:///bumpNEW.ts', 'new content\n');

    adapter.applyChange('file:///bump0.ts', { startLine: 0, endLine: 0, newText: 'still here\n' });
    expect(
      adapter.tracker.getRecentDiffs().some((d) => d.uri === 'file:///bump0.ts'),
      'bump0 was touched (bumped) before the eviction and must have survived it',
    ).toBe(true);

    adapter.applyChange('file:///bump1.ts', { startLine: 0, endLine: 0, newText: 'gone\n' });
    expect(
      adapter.tracker.getRecentDiffs().some((d) => d.uri === 'file:///bump1.ts'),
      'bump1 was never touched and was the true oldest at eviction time — it must be gone',
    ).toBe(false);
  });

  it('preEditShadow (getPreEditText) is capped too, independently of docShadow: an edited-then-LRU-evicted uri stops returning its pre-edit text', () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < SHADOW_CACHE_CAP; i++) {
      docs[`file:///pe${i}.ts`] = `content ${i}\n`;
    }
    const adapter = makeAdapterUnderTest(docs);

    // Edit every seeded doc once, in order — preEditShadow fills to exactly
    // SHADOW_CACHE_CAP entries (pe0 oldest, pe(cap-1) newest), no overflow yet.
    for (let i = 0; i < SHADOW_CACHE_CAP; i++) {
      adapter.applyChange(`file:///pe${i}.ts`, { startLine: 0, endLine: 0, newText: `edited ${i}\n` });
    }
    expect(adapter.getPreEditText('file:///pe0.ts')).toBe('content 0\n');

    // Seed ONE more distinct, still-fresh document (via the post-construction
    // visibility path, so it lands in docShadow without disturbing the
    // uniform edit sweep above) and edit it — pushes preEditShadow's OWN
    // entry count 1 past the cap, independently of docShadow's current state.
    adapter.openEditor('file:///peNEW.ts', 'fresh content\n');
    adapter.applyChange('file:///peNEW.ts', { startLine: 0, endLine: 0, newText: 'edited new\n' });

    expect(
      adapter.getPreEditText('file:///pe0.ts'),
      'pe0 was the least-recently-touched entry in preEditShadow and must have been LRU-evicted',
    ).toBeUndefined();
    expect(adapter.getPreEditText('file:///peNEW.ts')).toBe('fresh content\n');
  });
});
