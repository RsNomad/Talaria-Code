import { describe, it, expect, vi } from 'vitest';

/**
 * FINAL REVIEW — FINDING 7. The filter↔mint agreement lock.
 *
 * `diffMayEgress` (`shell.vscode.ts`) claims, in a comment, to run "exactly
 * what `scan.ts` runs for a `diffs[]` entry, in the same order (sentinel
 * guard, then `scanSnippetForSecrets`, throw-is-reject), against the SAME
 * `diff.filepath` string the mint will use".
 *
 * That is an IDENTITY between two separately-written code paths, and until
 * this file it was held by prose. Behavioural tests existed for the filter
 * (`shell.vscode.test.ts`'s F-3 block) and for the mint (`scan.test.ts`), but
 * nothing compared their VERDICTS — so the two could drift apart and both
 * test suites would stay green.
 *
 * WHY DRIFT HERE IS SEVERE, and why it is the fail-closed direction that
 * hurts. The dangerous half is a diff the filter KEEPS but the mint REJECTS:
 * the first reject aborts the WHOLE mint, the trigger's catch reports nothing,
 * and every next-edit request in every file dies silently until the 16-entry
 * ring evicts the offender. That is exactly the bug F-3 was written to fix —
 * so a drift would reintroduce it while `partitionEgressableDiffs` still looks
 * like it is doing its job. (The other half — the filter dropping a diff the
 * mint would have accepted — is merely lost context, and visible.)
 *
 * This is the same shape as the five duplicated line-splitters before
 * `lineSplitDrift.lock.test.ts`: "the first fix must land in two places and
 * nothing fails when it lands in one." This file is the thing that fails.
 *
 * MECHANISM. Not a source scan and not a re-implementation: the REAL
 * `diffMayEgress` and the REAL `mintScannedNextEditRequest` are both invoked
 * on the same corpus, and their verdicts are required to agree. A lock that
 * restated either predicate would drift with them.
 */

/**
 * `shell.vscode.ts` imports `vscode` at module scope, so it needs a stub to be
 * importable at all. Only module-load needs to succeed here — `diffMayEgress`
 * itself touches no `vscode` API (it is pure over `scanSnippetForSecrets`),
 * which is precisely why it can be locked this cheaply.
 */
vi.mock('vscode', () => ({
  Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose: () => items.forEach((i) => i.dispose()) }) },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  Range: class {
    constructor(
      public a: unknown,
      public b: unknown,
      public c?: unknown,
      public d?: unknown,
    ) {}
  },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  MarkdownString: class {},
  WorkspaceEdit: class {
    replace() {}
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() },
  window: {
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showWarningMessage: () => Promise.resolve(undefined),
    activeTextEditor: undefined,
    visibleTextEditors: [],
  },
  workspace: {
    onDidChangeTextDocument: () => ({ dispose() {} }),
    getConfiguration: () => ({ get: <T>(_k: string, d: T): T => d }),
    applyEdit: () => Promise.resolve(true),
    asRelativePath: (p: unknown) => String(p),
    workspaceFolders: undefined,
    get isTrusted() {
      return true;
    },
  },
}));

import { diffMayEgress } from './shell.vscode';
import { mintScannedNextEditRequest } from './scan';
import type { NextEditRequest, RecentDiff } from './types';

/** A benign request skeleton: every content field except `diffs` is clean, so
 *  the mint's verdict below is decided by the diff and nothing else. */
function requestWith(diffs: readonly RecentDiff[]): NextEditRequest {
  return {
    model: 'sweep-next-edit-v2-7B',
    cursor: { uri: 'file:///w/a.ts', line: 0, character: 0 },
    region: {
      uri: 'file:///w/a.ts',
      filepath: 'a.ts',
      startLine: 0,
      endLine: 1,
      content: 'const a = 1;\n',
    },
    preEditRegion: null,
    fileContext: 'const a = 1;\n',
    docText: 'const a = 1;\n',
    preEditDocText: null,
    changesAboveCursor: false,
    diffs,
  } as NextEditRequest;
}

/** Would the REAL mint accept a request carrying exactly this one diff? */
function mintAccepts(diff: RecentDiff, sentinels: readonly string[]): boolean {
  try {
    mintScannedNextEditRequest(requestWith([diff]), sentinels);
    return true;
  } catch {
    return false;
  }
}

function makeDiff(over: Partial<RecentDiff>): RecentDiff {
  return { filepath: 'a.ts', before: 'const a = 1;\n', after: 'const a = 2;\n', startLine: 0, endLine: 1, ...over } as RecentDiff;
}

const SENTINELS = ['<|next|>', '<|editable_region_start|>'] as const;

/**
 * The corpus. Every row is a (diff, sentinels) pair the two paths must agree
 * on, chosen to hit each branch `diffMayEgress` has: clean, sentinel in
 * `before`, sentinel in `after`, a secret-bearing path, secret-bearing
 * content, and the empty-content edge.
 *
 * `expectedEgress` is stated INDEPENDENTLY of both implementations. Without
 * it, the agreement assertion alone would be satisfied by two paths that are
 * both wrong in the same direction (e.g. both reject everything).
 */
const CORPUS: ReadonlyArray<{
  name: string;
  diff: RecentDiff;
  sentinels: readonly string[];
  expectedEgress: boolean;
}> = [
  {
    name: 'ordinary source diff',
    diff: makeDiff({}),
    sentinels: SENTINELS,
    expectedEgress: true,
  },
  {
    name: 'sentinel in `before`',
    diff: makeDiff({ before: 'x <|next|> y' }),
    sentinels: SENTINELS,
    expectedEgress: false,
  },
  {
    name: 'sentinel in `after` (the second half of the pair must be reached too)',
    diff: makeDiff({ after: 'x <|editable_region_start|> y' }),
    sentinels: SENTINELS,
    expectedEgress: false,
  },
  {
    name: 'a .env path — the cross-document poisoning F-3 fixed',
    diff: makeDiff({ filepath: '.env' }),
    sentinels: SENTINELS,
    expectedEgress: false,
  },
  {
    name: 'secret-bearing CONTENT in an ordinary path',
    diff: makeDiff({ after: 'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"\n' }),
    sentinels: SENTINELS,
    expectedEgress: false,
  },
  {
    name: 'empty before/after',
    diff: makeDiff({ before: '', after: '' }),
    sentinels: SENTINELS,
    expectedEgress: true,
  },
  {
    name: 'no sentinels configured at all (the guard must not invent one)',
    diff: makeDiff({}),
    sentinels: [],
    expectedEgress: true,
  },
];

describe('FINDING 7: diffMayEgress and the mint agree, diff for diff', () => {
  it('reach: the corpus is non-empty and exercises BOTH verdicts', () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    // A corpus that was all-accept or all-reject would let a constant
    // predicate pass. Both verdicts must be represented.
    expect(CORPUS.some((c) => c.expectedEgress)).toBe(true);
    expect(CORPUS.some((c) => !c.expectedEgress)).toBe(true);
  });

  it.each(CORPUS)(
    'the filter and the mint return the same verdict for: $name',
    ({ diff, sentinels, expectedEgress }) => {
      const filterVerdict = diffMayEgress(diff, sentinels);
      const mintVerdict = mintAccepts(diff, sentinels);

      // Both are pinned to the INDEPENDENT expectation first, so "they agree"
      // can never be satisfied by two paths that are wrong together.
      expect(filterVerdict, 'the shell filter disagrees with the stated expectation').toBe(expectedEgress);
      expect(mintVerdict, 'the mint disagrees with the stated expectation').toBe(expectedEgress);
      expect(
        filterVerdict,
        'DRIFT: the caller-side filter and the mint no longer agree about this diff. If the filter KEEPS ' +
          'what the mint REJECTS, the first reject aborts the whole mint and next-edit dies silently in ' +
          'every file until the ring evicts the entry — the exact F-3 bug.',
      ).toBe(mintVerdict);
    },
  );

  /**
   * The ONE sanctioned divergence, pinned so it stays deliberate. An empty
   * sentinel is a caller-contract bug (`ruleId=empty-sentinel`): the mint
   * rejects the whole REQUEST for it, while the filter deliberately declines
   * to treat it as a per-diff content verdict — quietly dropping every diff
   * would hide the bug. `shell.vscode.ts`'s own comment states this; here it
   * is asserted rather than described.
   */
  it('the empty-sentinel divergence is deliberate, and is the ONLY one', () => {
    const diff = makeDiff({});
    expect(diffMayEgress(diff, ['']), 'the filter must not turn a contract bug into a silent per-diff drop').toBe(
      true,
    );
    expect(mintAccepts(diff, ['']), 'the mint must reject the whole request, loudly').toBe(false);
  });

  /**
   * RED-first proof that the agreement assertion can actually fail. A
   * deliberately drifted filter — one that normalises the path before scanning,
   * which is the single most plausible "improvement" someone would make, and
   * the one `shell.vscode.ts`'s comment explicitly warns against ("normalizing
   * the path here … would let a diff pass this filter and still abort the
   * mint") — must be caught.
   */
  it('RED-first proof: a filter that normalises the path away is caught disagreeing with the mint', () => {
    const drifted = (diff: RecentDiff, sentinels: readonly string[]): boolean =>
      diffMayEgress({ ...diff, filepath: 'harmless.ts' }, sentinels);

    const envDiff = makeDiff({ filepath: '.env' });
    // The drifted filter says "safe to send"...
    expect(drifted(envDiff, SENTINELS)).toBe(true);
    // ...while the mint still aborts on the real path. This is the silent-kill.
    expect(mintAccepts(envDiff, SENTINELS)).toBe(false);
    // Which is exactly the comparison the corpus runs — so it would go RED.
    expect(drifted(envDiff, SENTINELS)).not.toBe(mintAccepts(envDiff, SENTINELS));
  });

  /**
   * Non-vacuity for the mint side: `mintAccepts` must be capable of returning
   * true. A skeleton that rejected for an unrelated reason (a bad field, a
   * missing key) would make every `expectedEgress: false` row pass for the
   * wrong reason and every `true` row fail loudly — but a subtler skeleton
   * fault could make the whole corpus reject silently in agreement.
   */
  it('control: the benign skeleton itself mints cleanly with no diffs at all', () => {
    expect(() => mintScannedNextEditRequest(requestWith([]), SENTINELS)).not.toThrow();
  });
});
