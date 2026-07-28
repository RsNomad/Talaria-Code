import { describe, it, expect } from 'vitest';

import { generateCommitMessage } from './generateCommitCommand';
import type { CancellationLike } from './generateCommitCommand';
import type { GitPort } from '../context/types';
import type { OneShotResult, UtilityModelPort } from './utilityModel';

/* ------------------------------------------------------------------ *
 * Fakes — COMPLETE implementations of the real `GitPort`/`UtilityModelPort`
 * contracts (never a partial stub), so a test can never pass because a
 * method the orchestrator actually calls was silently missing.
 * ------------------------------------------------------------------ */

interface FakeGitPortInit {
  stagedDiff?: string;
  workingDiff?: string;
  changedPaths?: { path: string; staged: boolean }[];
  recentSubjects?: string[];
  userSubjects?: string[];
  commitTemplate?: string;
  inputBox?: string;
  /** Fired (if given) on every async call — used to simulate a cancel or a
   * user edit racing the orchestrator's own snapshot/model-call window. */
  onCall?: () => void;
}

interface FakeGitPort extends GitPort {
  /** Every value `writeInputBox` was ever called with, in order. */
  writes: string[];
  calls: { stagedDiff: number; workingDiff: number; changedPaths: number; recentSubjects: number; commitTemplate: number };
}

function makeGitPort(init: FakeGitPortInit = {}): FakeGitPort {
  let box = init.inputBox ?? '';
  const writes: string[] = [];
  const calls = { stagedDiff: 0, workingDiff: 0, changedPaths: 0, recentSubjects: 0, commitTemplate: 0 };
  return {
    writes,
    calls,
    async stagedDiff() {
      calls.stagedDiff++;
      init.onCall?.();
      return init.stagedDiff ?? '';
    },
    async workingDiff() {
      calls.workingDiff++;
      init.onCall?.();
      return init.workingDiff ?? '';
    },
    async changedPaths() {
      calls.changedPaths++;
      init.onCall?.();
      return init.changedPaths ?? [];
    },
    async recentSubjects(_n: number, author?: 'user') {
      calls.recentSubjects++;
      init.onCall?.();
      return author === 'user' ? (init.userSubjects ?? []) : (init.recentSubjects ?? []);
    },
    readInputBox() {
      return box;
    },
    writeInputBox(text: string) {
      box = text;
      writes.push(text);
    },
    async commitTemplate() {
      calls.commitTemplate++;
      init.onCall?.();
      return init.commitTemplate;
    },
  };
}

interface FakeModel extends UtilityModelPort {
  prompts: string[];
}

function makeModel(handler: (prompt: string) => OneShotResult | Promise<OneShotResult>): FakeModel {
  const prompts: string[] = [];
  return {
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      return handler(prompt);
    },
  };
}

/** One unified-diff file section (mirrors `sanitize.test.ts`'s local helper). */
function makeDiffSection(path: string, char: string, len: number): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -1 +1 @@\n` +
    `-old\n` +
    `+${char.repeat(len)}\n`
  );
}

function neverCalledToken(): CancellationLike {
  return { isCancellationRequested: false };
}

describe('generateCommitMessage — nothing-to-commit (also covers a degraded/absent GitPort, which yields the same empty snapshot)', () => {
  it('returns a permanent nothing-to-commit result and never calls the model', async () => {
    const git = makeGitPort({ changedPaths: [] });
    const model = makeModel(() => {
      throw new Error('model.complete must not be called when there is nothing to commit');
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: false,
      kind: 'permanent',
      reason: 'nothing-to-commit',
      message: expect.any(String),
    });
    expect(model.prompts).toHaveLength(0);
    expect(git.writes).toHaveLength(0); // the box is never touched for this early-out
  });
});

describe('generateCommitMessage — happy path', () => {
  it('writes the parsed message, prepended above any existing box text, and wires subjects/template into the prompt', async () => {
    const diff = makeDiffSection('src/feature.ts', 'x', 20);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/feature.ts', staged: true }],
      recentSubjects: ['fix: repo subject one'],
      userSubjects: ['feat: my own subject'],
      commitTemplate: '<type>(<scope>): <subject>',
      inputBox: 'pre-existing GitLens text',
    });
    const model = makeModel((prompt) => {
      expect(prompt).toContain(diff);
      expect(prompt).toContain('fix: repo subject one');
      expect(prompt).toContain('feat: my own subject');
      expect(prompt).toContain('<type>(<scope>): <subject>');
      return { ok: true, text: '```\nfeat: add feature\n```' };
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: true,
      message: 'feat: add feature',
      source: 'staged',
      skippedFiles: [],
      droppedFiles: [],
    });
    expect(model.prompts).toHaveLength(1);

    const finalBox = git.readInputBox();
    expect(finalBox).toContain('feat: add feature');
    expect(finalBox).toContain('pre-existing GitLens text');
    // the generated message comes first (GitLens-style prepend)
    expect(finalBox.indexOf('feat: add feature')).toBeLessThan(finalBox.indexOf('pre-existing GitLens text'));
  });

  it('with no pre-existing box text, writes just the parsed message (no blank prepend)', async () => {
    const diff = makeDiffSection('src/a.ts', 'y', 10);
    const git = makeGitPort({
      workingDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: false }],
      inputBox: '',
    });
    const model = makeModel(() => ({ ok: true, text: 'chore: tidy' }));

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result.ok).toBe(true);
    expect(git.readInputBox()).toBe('chore: tidy');
  });
});

describe('generateCommitMessage — model timeout ⇒ transient, CAS-revert restores the box', () => {
  it('reverts the box to its pre-write value when nothing else changed it meanwhile', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'my draft message',
    });
    const model = makeModel(() => ({ ok: false, error: 'timed out' }));

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({ ok: false, kind: 'transient', message: expect.any(String) });
    // box was touched (a "generating…" placeholder) and then reverted, since
    // nothing else changed it in between.
    expect(git.writes.length).toBeGreaterThanOrEqual(2);
    expect(git.readInputBox()).toBe('my draft message');
  });

  it('a non-timeout model failure is permanent (not transient), and also reverts the box', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: '',
    });
    const model = makeModel(() => ({ ok: false, error: 'a turn is already running' }));

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: 'a turn is already running',
    });
    expect(git.readInputBox()).toBe('');
  });

  it('an empty/unusable parsed message is a permanent model-error and reverts the box', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'kept',
    });
    const model = makeModel(() => ({ ok: true, text: '   \n   ' }));

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: expect.any(String),
    });
    expect(git.readInputBox()).toBe('kept');
  });
});

describe('generateCommitMessage — CAS revert never clobbers text the user typed during generation', () => {
  it('box changed mid-generation (simulated: the model handler edits the box before resolving) ⇒ NOT reverted, user text kept', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'original text',
    });
    const model = makeModel(() => {
      // Simulate the user typing their own message into the box WHILE the
      // one-shot call is in flight — the box no longer equals what the
      // feature wrote, so a subsequent failure must never overwrite it.
      git.writeInputBox('the user typed this while waiting');
      return { ok: false, error: 'timed out' };
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({ ok: false, kind: 'transient', message: expect.any(String) });
    expect(git.readInputBox()).toBe('the user typed this while waiting');
  });

  it('also holds on the SUCCESS path: a mid-generation user edit is not clobbered by the generated message', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'original text',
    });
    const model = makeModel(() => {
      git.writeInputBox('the user typed this while waiting');
      return { ok: true, text: 'feat: generated message' };
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: true,
      message: 'feat: generated message',
      source: 'staged',
      skippedFiles: [],
      droppedFiles: [],
    });
    // The message WAS generated (the result says so) but the box — which the
    // user was actively editing — is left exactly as the user left it.
    expect(git.readInputBox()).toBe('the user typed this while waiting');
  });
});

describe('generateCommitMessage — secret-exclusion runs BEFORE budgeting', () => {
  it('a secret file never crowds a real file out of the truncation budget: it is excluded first, freeing the whole cap for real content', async () => {
    // Both sections score identically under truncateDiffToBudget's GitLens
    // priority (neither is a lockfile/generated/binary/test path), so if
    // budgeting ran BEFORE exclusion, stable-sort-by-original-order would
    // keep the (first, secret) section and DROP the real file — the wrong
    // outcome. Sized so the combined diff exceeds the default 30_000-char
    // cap, but the real file alone comfortably fits once the secret section
    // is excluded first.
    const secretSection = makeDiffSection('.env', 'S', 20_000);
    const realSection = makeDiffSection('src/real.ts', 'R', 15_000);
    const diff = secretSection + realSection;
    expect(diff.length).toBeGreaterThan(30_000);

    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [
        { path: '.env', staged: true },
        { path: 'src/real.ts', staged: true },
      ],
    });
    const model = makeModel((prompt) => {
      expect(prompt).not.toContain('S'.repeat(100));
      expect(prompt).toContain('R'.repeat(100));
      return { ok: true, text: 'feat: add real feature' };
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.skippedFiles).toEqual(['.env']);
    // Nothing had to be DROPPED by budgeting — exclusion alone freed enough
    // room for the (much smaller) real file to fit whole.
    expect(result.droppedFiles).toEqual([]);
  });

  it('surfaces files dropped by budgeting (independent of secret-exclusion) in droppedFiles', async () => {
    const bigA = makeDiffSection('src/a.ts', 'A', 20_000);
    const bigB = makeDiffSection('src/b.ts', 'B', 20_000);
    const diff = bigA + bigB;
    expect(diff.length).toBeGreaterThan(30_000);

    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [
        { path: 'src/a.ts', staged: true },
        { path: 'src/b.ts', staged: true },
      ],
    });
    const model = makeModel(() => ({ ok: true, text: 'feat: a' }));

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.skippedFiles).toEqual([]);
    expect(result.droppedFiles).toEqual(['src/b.ts']); // second section, dropped to fit the cap
  });
});

describe('generateCommitMessage — secret exclusion empties the diff entirely', () => {
  it('returns a permanent only-secret-files result, never calls the model, and leaves the box untouched', async () => {
    // The only changed file is secret-classified, so excludeSecretFiles drops
    // it and leaves an empty diff. Before the fix, the empty diff was still
    // sent to the model — which can hallucinate a plausible-but-fake commit
    // message from nothing. This must instead take the same early-out class
    // as nothing-to-commit, WITHOUT calling the model or touching the box,
    // and it must say WHY (not a bare "nothing to commit") since the user did
    // stage a file.
    const diff = makeDiffSection('.env', 'S', 20);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: '.env', staged: true }],
    });
    const model = makeModel(() => {
      throw new Error('model.complete must not be called when secret exclusion empties the diff');
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: false,
      kind: 'permanent',
      reason: 'only-secret-files',
      message: '1 secret-classified file(s) skipped; nothing else to commit.',
    });
    expect(model.prompts).toHaveLength(0);
    expect(git.writes).toHaveLength(0); // the box is never touched for this early-out
  });
});

describe('generateCommitMessage — SCM-1: model.complete THROWS instead of resolving {ok:false}', () => {
  it('CAS-reverts the placeholder and returns a permanent model-error result', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'my draft',
    });
    const model = makeModel(() => {
      throw new Error('ECONNRESET: raw provider transport detail');
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: expect.any(String),
    });
    // box was touched (placeholder) then reverted, since nothing else
    // changed it in between — same CAS-revert contract as an ok:false result.
    expect(git.writes.length).toBeGreaterThanOrEqual(2);
    expect(git.readInputBox()).toBe('my draft');
  });

  it('does not clobber box text the user typed while the (throwing) call was in flight', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'original text',
    });
    const model = makeModel(() => {
      // Simulate the user typing into the box WHILE the one-shot call is in
      // flight, same as the existing ok:false CAS-guard tests above.
      git.writeInputBox('the user typed this while waiting');
      throw new Error('boom');
    });

    const result = await generateCommitMessage({ git, model, token: neverCalledToken() });

    expect(result).toEqual({
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: expect.any(String),
    });
    expect(git.readInputBox()).toBe('the user typed this while waiting');
  });
});

describe('generateCommitMessage — SCM-3 cheap half: a cancel reverts the placeholder immediately, not only after the one-shot settles', () => {
  /** Yields to the microtask/macrotask queue so every `await` already inside
   * `generateCommitMessage` (the git snapshot `Promise.all`, then the
   * placeholder write + cancellation-listener registration) has a chance to
   * run before the test drives the cancellation token — without this, the
   * assertions below would race the orchestrator's own setup. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('reverts the box the moment onCancellationRequested fires, before model.complete resolves', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'my draft',
    });

    let cancelListener: (() => void) | undefined;
    let requested = false;
    const token = {
      get isCancellationRequested() {
        return requested;
      },
      onCancellationRequested(listener: () => void) {
        cancelListener = listener;
        return { dispose(): void {} };
      },
    };

    let releaseModel: ((r: OneShotResult) => void) | undefined;
    const model = makeModel(
      () =>
        new Promise<OneShotResult>((resolve) => {
          releaseModel = resolve;
        }),
    );

    const resultPromise = generateCommitMessage({ git, model, token });
    await flush();

    expect(cancelListener).toBeDefined();
    expect(git.readInputBox()).not.toBe('my draft'); // placeholder is in the box now

    requested = true;
    cancelListener?.();

    // Reverted RIGHT NOW, synchronously from the listener — model.complete
    // has not resolved yet (it's still pending; releaseModel hasn't fired).
    expect(git.readInputBox()).toBe('my draft');

    releaseModel?.({ ok: false, error: 'timed out' });
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, kind: 'permanent', reason: 'cancelled', message: expect.any(String) });
  });

  it('does NOT revert if the box was already overtyped before the cancellation fires (CAS guard still holds)', async () => {
    const diff = makeDiffSection('src/a.ts', 'z', 10);
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      inputBox: 'my draft',
    });

    let cancelListener: (() => void) | undefined;
    let requested = false;
    const token = {
      get isCancellationRequested() {
        return requested;
      },
      onCancellationRequested(listener: () => void) {
        cancelListener = listener;
        return { dispose(): void {} };
      },
    };

    let releaseModel: ((r: OneShotResult) => void) | undefined;
    const model = makeModel(
      () =>
        new Promise<OneShotResult>((resolve) => {
          releaseModel = resolve;
        }),
    );

    const resultPromise = generateCommitMessage({ git, model, token });
    await flush();
    expect(cancelListener).toBeDefined(); // proves the listener is really wired, not a vacuous no-op

    git.writeInputBox('user typed something else entirely');

    requested = true;
    cancelListener?.();

    expect(git.readInputBox()).toBe('user typed something else entirely'); // left alone

    releaseModel?.({ ok: false, error: 'timed out' });
    await resultPromise;
  });
});

describe('generateCommitMessage — cancellation via the token', () => {
  it('an already-cancelled token short-circuits before touching git or the model', async () => {
    const git = makeGitPort({
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      onCall: () => {
        throw new Error('GitPort must not be called once the token is already cancelled');
      },
    });
    const model = makeModel(() => {
      throw new Error('model.complete must not be called once the token is already cancelled');
    });

    const result = await generateCommitMessage({ git, model, token: { isCancellationRequested: true } });

    expect(result).toEqual({ ok: false, kind: 'permanent', reason: 'cancelled', message: expect.any(String) });
  });

  it('a cancel that lands right after the git snapshot skips the model call entirely', async () => {
    const diff = makeDiffSection('src/a.ts', 'x', 10);
    const token = { isCancellationRequested: false };
    const git = makeGitPort({
      stagedDiff: diff,
      changedPaths: [{ path: 'src/a.ts', staged: true }],
      onCall: () => {
        token.isCancellationRequested = true; // flips mid-snapshot, observed after Promise.all resolves
      },
    });
    const model = makeModel(() => {
      throw new Error('model.complete must not be called once cancelled');
    });

    const result = await generateCommitMessage({ git, model, token });

    expect(result).toEqual({ ok: false, kind: 'permanent', reason: 'cancelled', message: expect.any(String) });
    expect(model.prompts).toHaveLength(0);
  });
});
