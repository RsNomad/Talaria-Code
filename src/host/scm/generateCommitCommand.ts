/**
 * W2 T5c — commit-gen orchestrator (`docs/research/wave-2/00-architecture-and-paths.md`
 * §3.4 "F-C Commit-message generation"). Wires the ALREADY-COMMITTED building
 * blocks — `GitPort` (T2d, `context/types.ts`/`gitPort.ts`), the pure message
 * pipeline (T5a, `commitMessage.ts`) + secret/budget units (§2d,
 * `context/sanitize.ts`), and the one-shot `UtilityModelPort` (T5b,
 * `utilityModel.ts`) — into one `Result`-typed, headlessly-testable flow. This
 * module is HEADLESS: zero `vscode` import, zero `fs`; `progress`/`token` are
 * tiny injected interfaces (structurally satisfied by `vscode.Progress`/
 * `vscode.CancellationToken`, but this file never imports `vscode` itself).
 * The `scm/title` `$(sparkle)` command glue (building the REAL ports,
 * `withProgress`, mapping the result to a notification) lives in
 * `generateCommitCommand.vscode.ts` — build-blind by design (§7: "every
 * element except the two thin ports is a pure, table-testable unit").
 *
 * Pipeline (§3.4, exactly as pinned): `GitPort` snapshot → `selectChanges`
 * (null ⇒ permanent `nothing-to-commit`, NO model call) → `excludeSecretFiles`
 * FIRST, then `truncateDiffToBudget` (order matters — a secret file must
 * never compete for/consume truncation budget) → `buildCommitPrompt` →
 * `UtilityModelPort.complete()` → `parseCommitMessage` → write back preserving
 * any existing box text (GitLens-style prepend).
 *
 * Error handling (typescript-error-handling applied, doc §3.4): `Result`-typed
 * end-to-end, no silent catches — every branch returns a typed
 * {@link GenerateResult}. `nothing-to-commit` (which also covers a
 * disabled/absent git extension: `GitPort`'s OWN contract — see `gitPort.ts`'s
 * header — degrades that to the same empty snapshot, `[]`/`''`, so this
 * orchestrator never needs a second `!`-asserted `getExtension` check of its
 * own) is classified `permanent`. A one-shot `error: 'timed out'` (the EXACT
 * sentinel `AcpBackend.oneShot`'s wall-clock deadline resolves with — see
 * {@link ONE_SHOT_TIMEOUT_ERROR}) is `transient` ("try again"); any other
 * model failure, or an empty/unusable parsed message, is `permanent`.
 *
 * Compare-and-swap revert (§7 B12): once the box is touched (a "generating…"
 * placeholder, composed the SAME way the final message is), every later
 * outcome — success, failure, or cancellation — writes through
 * {@link writeIfBoxUnchanged}, which only replaces the box if it still reads
 * back exactly what THIS call wrote. If the user edited the box themselves
 * while the model call was in flight, their text is left completely alone —
 * on failure (never clobber their draft with a revert) AND on success (never
 * clobber their draft with the generated message either — this feature must
 * never overwrite something a human is actively typing).
 *
 * Tier-2 T-11 (SCM-1/SCM-2/SCM-3 cheap half, `tier2-remediation-architecture.md`
 * §12.1): (SCM-1) `model.complete` is documented (`utilityModel.ts`) to
 * resolve `{ok:false}` on failure, never reject — but the real ACP-backed
 * port can still throw on an unexpected transport/session failure, and
 * before this fix that left the "Generating…" placeholder stuck in the box
 * forever (the CAS-revert below was never reached). The call is now
 * try/catch-wrapped: a thrown error is treated exactly like an `ok:false`
 * result — CAS-revert + a permanent `model-error`. (SCM-2, the OTHER half of
 * this fix, lives in `generateCommitCommand.vscode.ts`'s `presentResult`:
 * this module's `model-error` `message` may still carry the raw
 * provider/model detail — that is fine HERE, this is the headless/log-worthy
 * layer — the vscode-bound presenter is the one that must never echo it to
 * the user verbatim, Invariant #3.) (SCM-3 cheap half) a cancel used to only
 * revert the box once `model.complete` itself settled — for a mid-flight
 * one-shot that can be the model's own full wall-clock deadline away, so the
 * box looked stuck on "Generating…" long after the user clicked Cancel.
 * {@link CancellationLike.onCancellationRequested}, when the caller's token
 * provides it (the real `vscode.CancellationToken` always does), now lets
 * the CAS-revert fire the MOMENT cancellation is requested. The one-shot
 * call itself is NOT aborted by this — it still dies at its own deadline;
 * threading real cancellation through `UtilityModelPort.complete` is the
 * FULL seam, deferred to §12.2.
 */
import { excludeSecretFiles, truncateDiffToBudget } from '../context/sanitize';
import type { GitPort } from '../context/types';
import { buildCommitPrompt, parseCommitMessage, selectChanges } from './commitMessage';
import type { OneShotResult, UtilityModelPort } from './utilityModel';

/** Tiny injected progress-reporter shape — structurally satisfied by
 * `vscode.Progress<{message?: string}>` without importing `vscode` here. */
export interface ProgressReporter {
  report(value: { message?: string }): void;
}

/** Tiny injected cancellation shape — structurally satisfied by
 * `vscode.CancellationToken` without importing `vscode` here. */
export interface CancellationLike {
  isCancellationRequested: boolean;
  /**
   * SCM-3 cheap half (§12.1 T-11): OPTIONAL immediate-notification hook,
   * structurally satisfied by `vscode.CancellationToken.onCancellationRequested`
   * (vscode's own `Event` shape) without importing `vscode` here — a real VS
   * Code token always provides it; a hand-rolled fake in a test may omit it,
   * and every use below is optional-chained accordingly.
   */
  onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export interface GenerateCommitDeps {
  git: GitPort;
  model: UtilityModelPort;
  progress?: ProgressReporter;
  token?: CancellationLike;
}

export interface GenerateCommitSuccess {
  ok: true;
  message: string;
  source: 'staged' | 'working';
  /** Paths dropped by {@link excludeSecretFiles} (§2d point 1) — surfaced so
   * the glue can show a "N files skipped (secret-classified)" notice. */
  skippedFiles: string[];
  /** Paths dropped by {@link truncateDiffToBudget} to fit the diff cap. */
  droppedFiles: string[];
}

/** The two failure classes pinned by doc §3.4's error-handling contract.
 * `cancelled` rides the `permanent` channel (no retry makes sense for a
 * user-initiated cancel) rather than adding a third top-level kind. */
export type GenerateCommitPermanentReason = 'nothing-to-commit' | 'only-secret-files' | 'model-error' | 'cancelled';

export interface GenerateCommitPermanentFailure {
  ok: false;
  kind: 'permanent';
  reason: GenerateCommitPermanentReason;
  message: string;
}

export interface GenerateCommitTransientFailure {
  ok: false;
  kind: 'transient';
  message: string;
}

export type GenerateResult = GenerateCommitSuccess | GenerateCommitPermanentFailure | GenerateCommitTransientFailure;

/** The exact `OneShotResult.error` string `AcpBackend.oneShot`'s wall-clock
 * deadline resolves with (`AcpBackend.ts` `runOneShot`'s `timeoutHandle`) —
 * the ONE sentinel this orchestrator treats as transient/retryable. Every
 * other `error` string (refusal, teardown, "session is not started yet", …)
 * is a permanent model failure — composing the port's documented contract,
 * not re-deriving it. */
const ONE_SHOT_TIMEOUT_ERROR = 'timed out';

/** The "generating…" placeholder written into the commit box for the
 * duration of the model call — purely a live-feedback affordance (GitLens
 * shows the same kind of in-box status); its exact wording is never asserted
 * by a caller, only ever compared byte-for-byte against itself for the CAS
 * check below. */
const GENERATING_PLACEHOLDER = 'Generating commit message…';

function cancelledResult(): GenerateCommitPermanentFailure {
  return { ok: false, kind: 'permanent', reason: 'cancelled', message: 'Cancelled.' };
}

/** GitLens-style compose: `newText` on top, any pre-existing box text
 * preserved below it (never dropped) — a blank pre-existing box (or one that
 * is pure whitespace) contributes no empty trailing separator. */
function composeBoxText(newText: string, existing: string): string {
  return existing.trim() ? `${newText}\n\n${existing}` : newText;
}

export async function generateCommitMessage(deps: GenerateCommitDeps): Promise<GenerateResult> {
  const { git, model, progress, token } = deps;

  if (token?.isCancellationRequested) return cancelledResult();

  progress?.report({ message: 'Reading changes…' });
  const [stagedDiff, workingDiff, changedPaths, recentSubjects, userSubjects, template] = await Promise.all([
    git.stagedDiff(),
    git.workingDiff(),
    git.changedPaths(),
    git.recentSubjects(5),
    git.recentSubjects(5, 'user'),
    git.commitTemplate(),
  ]);

  if (token?.isCancellationRequested) return cancelledResult();

  const selected = selectChanges({ stagedDiff, workingDiff, changedPaths });
  if (!selected) {
    return {
      ok: false,
      kind: 'permanent',
      reason: 'nothing-to-commit',
      message: 'Nothing to commit — stage or make some changes first.',
    };
  }

  // Order matters (§3.4): exclude secret-classified files BEFORE budgeting,
  // so a secret file can never consume (or compete for) truncation budget
  // that real files need.
  const { diff: securedDiff, skippedFiles } = excludeSecretFiles(selected.diff);

  // M1 fix (review finding): a selection can be non-null yet still have
  // EVERY file dropped by secret-exclusion (e.g. the only staged file is
  // `.env`) — re-check for emptiness here, same early-out class as
  // `nothing-to-commit` above, so an effectively-empty diff never reaches
  // the model (which would otherwise hallucinate a plausible-but-fake
  // message from nothing). Distinct `reason` (rather than the bare
  // `nothing-to-commit` message) so the UI can explain WHY — the user DID
  // stage something, it just got secret-classified.
  if (securedDiff === '' && skippedFiles.length > 0) {
    return {
      ok: false,
      kind: 'permanent',
      reason: 'only-secret-files',
      message: `${skippedFiles.length} secret-classified file(s) skipped; nothing else to commit.`,
    };
  }

  const { diff: budgetedDiff, droppedFiles } = truncateDiffToBudget(securedDiff);

  const prompt = buildCommitPrompt({
    diff: budgetedDiff,
    recentSubjects,
    userSubjects,
    template,
  });

  if (token?.isCancellationRequested) return cancelledResult();

  // From here the box is about to be TOUCHED — capture the CAS baseline
  // (what's there right now) before writing the placeholder, so a later
  // outcome can tell "the user left it alone" from "the user edited it".
  const preWriteText = git.readInputBox();
  const writtenValue = composeBoxText(GENERATING_PLACEHOLDER, preWriteText);
  git.writeInputBox(writtenValue);

  /** Compare-and-swap write (§7 B12): only replaces the box if it STILL
   * reads back exactly what this call last wrote — otherwise the user
   * touched it themselves in the meantime and their text is left untouched,
   * on every outcome (revert-on-failure AND finalize-on-success alike). */
  const writeIfBoxUnchanged = (nextValue: string): void => {
    if (git.readInputBox() === writtenValue) git.writeInputBox(nextValue);
  };

  // SCM-3 cheap half: react to a cancel the MOMENT it's requested, not only
  // after `model.complete` settles below (see the class header comment).
  // `writeIfBoxUnchanged` is the same CAS-guarded write used everywhere else
  // in this function, so a mid-flight user edit is still never clobbered.
  const cancelSubscription = token?.onCancellationRequested?.(() => writeIfBoxUnchanged(preWriteText));

  progress?.report({ message: 'Generating commit message…' });
  let modelResult: OneShotResult;
  try {
    modelResult = await model.complete(prompt);
  } catch (err) {
    // SCM-1: `model.complete` threw instead of resolving `{ok:false}` — the
    // real ACP-backed port can do this on an unexpected transport/session
    // failure. Same CAS-revert + permanent model-error the ok:false branch
    // below gives, so the "Generating…" placeholder is never left stuck.
    cancelSubscription?.dispose();
    writeIfBoxUnchanged(preWriteText);
    if (token?.isCancellationRequested) return cancelledResult();
    return {
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  cancelSubscription?.dispose();

  if (token?.isCancellationRequested) {
    writeIfBoxUnchanged(preWriteText);
    return cancelledResult();
  }

  if (!modelResult.ok) {
    writeIfBoxUnchanged(preWriteText);
    if (modelResult.error === ONE_SHOT_TIMEOUT_ERROR) {
      return { ok: false, kind: 'transient', message: 'Generating the commit message timed out — try again.' };
    }
    return { ok: false, kind: 'permanent', reason: 'model-error', message: modelResult.error };
  }

  const parsed = parseCommitMessage(modelResult.text);
  if (!parsed) {
    writeIfBoxUnchanged(preWriteText);
    return {
      ok: false,
      kind: 'permanent',
      reason: 'model-error',
      message: 'The model did not return a usable commit message.',
    };
  }

  writeIfBoxUnchanged(composeBoxText(parsed, preWriteText));

  return { ok: true, message: parsed, source: selected.source, skippedFiles, droppedFiles };
}
