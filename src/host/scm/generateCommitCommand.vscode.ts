/**
 * W2 T5c — F-C (§3.4): the `talaria.generateCommitMessage` command behind the
 * `scm/title` `$(sparkle)` button (`package.json`'s `menus.scm/title`, `when:
 * "scmProvider == git && talaria.ready"`). Build-blind (compile-checked +
 * Fedora-verified) — deliberately thin: build the real `GitPort` (T2d,
 * `gitPort.ts`) + a `UtilityModelPort` bound to the backend's `oneShot`
 * (T5b), run the headless {@link generateCommitMessage} (`generateCommitCommand.ts`)
 * under `withProgress` + a `CancellationToken`, and map its `Result` to a
 * notification. ALL decision logic stays in the headless orchestrator — this
 * file only wires vscode's imperative surface to it, mirroring
 * `diffDecision.vscode.ts`'s split (pure/headless core + a thin `vscode`
 * shell) and its structural-capability-check posture
 * (`WholeFileAcceptCapable`/`wholeFileAcceptCapable`).
 *
 * SCM-2 (§12.1 T-11): `presentResult` takes a `Logger` (the SAME minimal
 * `{append(line)}` shape `JsonRpcStdio.ts` defines and
 * `HermesDashboardManager`/`HermesDashboardClient` already thread the
 * "Talaria Code" `vscode.OutputChannel` through as) so a `model-error`'s raw
 * provider/model detail — which may originate straight from
 * `AcpBackend.oneShot`'s `error` string, or from SCM-1's caught-exception
 * message — has somewhere honest to go OTHER than the toast (Invariant #3;
 * the identical posture `HermesDashboardClient.ts`'s `json()` already
 * documents for an HTTP error body).
 */
import * as vscode from 'vscode';

import type { AgentBackend } from '../backend/AgentBackend';
import type { Logger } from '../transport/JsonRpcStdio';
import { createGitPort } from './gitPort';
import { generateCommitMessage, type GenerateResult } from './generateCommitCommand';
import type { OneShotResult, UtilityModelPort } from './utilityModel';

/** Structural capability check — only the real `AcpBackend` implements the
 * one-shot utility-model surface (§2c); the mock backend does not, so the
 * command degrades to an explicit warning rather than a `!`-assert or a
 * silent no-op.
 *
 * W6-FG (3-way ARCH I-2 fix): `cwd` is now a REQUIRED field on `opts` —
 * `AcpBackend.oneShot` derives its F1 turn-lease root from THIS, never from
 * its own ambient connection `cwd` (which, under multi-root, need not be
 * this repo's root at all). */
interface OneShotCapable {
  oneShot(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<OneShotResult>;
}

function oneShotCapable(backend: AgentBackend): backend is AgentBackend & OneShotCapable {
  return typeof (backend as Partial<OneShotCapable>).oneShot === 'function';
}

/** Map a settled {@link GenerateResult} to a notification. Success without
 * any skipped/dropped files stays silent (the box update speaks for itself —
 * matching GitLens/Copilot's "no toast on the happy path" posture); a
 * cancelled result is the user's own action and never surfaces a warning.
 *
 * SCM-2: a `model-error` never echoes `result.message` into the toast — that
 * field can carry a raw provider/model error body (Invariant #3). The user
 * gets one fixed, generic notice; `output` (the "Talaria Code" output channel)
 * gets the real detail, for anyone who goes looking. Exported for direct
 * unit testing (`generateCommitCommand.vscode.test.ts`) against a narrow
 * `vi.mock('vscode')`, same discipline `gitPort.test.ts` uses. */
export function presentResult(result: GenerateResult, output: Logger): void {
  if (result.ok) {
    const notes: string[] = [];
    if (result.skippedFiles.length > 0) {
      notes.push(`${result.skippedFiles.length} file(s) skipped (secret-classified)`);
    }
    if (result.droppedFiles.length > 0) {
      notes.push(`${result.droppedFiles.length} file(s) dropped (over the diff budget)`);
    }
    if (notes.length > 0) {
      void vscode.window.showInformationMessage(`Talaria: commit message generated — ${notes.join(', ')}.`);
    }
    return;
  }

  if (result.kind === 'transient') {
    void vscode.window.showWarningMessage(`Talaria: ${result.message}`);
    return;
  }

  if (result.reason === 'cancelled') return; // user-initiated — nothing to report

  if (result.reason === 'model-error') {
    // Invariant #3: never surface a raw provider/model error body to the
    // user — it goes to the output channel only; the toast stays fixed.
    output.append(`[commit message] generation failed: ${result.message}`);
    void vscode.window.showWarningMessage(
      'Talaria: could not generate a commit message — see the "Talaria Code" output channel for details.',
    );
    return;
  }

  void vscode.window.showWarningMessage(`Talaria: ${result.message}`);
}

async function runGenerateCommitMessage(getBackend: () => AgentBackend, output: Logger): Promise<void> {
  const backend = getBackend();
  if (!oneShotCapable(backend)) {
    void vscode.window.showWarningMessage('Talaria: commit-message generation needs the real Hermes backend (hermes.backend = "acp").');
    return;
  }

  const git = createGitPort();
  // W6-FG (3-way ARCH I-2 fix): resolve the ACTUAL target root ONCE, up
  // front — the SCM repo this commit-message call is for — and bind it into
  // the `complete` closure below. `UtilityModelPort.complete`'s own shape
  // stays untouched (the pinned §2c contract; the headless orchestrator
  // never needs a cwd), so this is a `.vscode.ts`-local capture, not a
  // protocol change. `?? ''` mirrors `resolveRootCoordinator`'s own
  // documented degenerate-empty-cwd handling (falls back to the first
  // workspace root) for the (unreachable in practice — `model.complete` is
  // only ever invoked after a real diff was found, which implies a real
  // repository resolved) case where no repository is available.
  const cwd = (await git.repositoryRoot()) ?? '';
  // §2c: `AcpBackend.oneShot` IS the `UtilityModelPort.complete` shape
  // verbatim — bind it, never reimplement it (T5b's documented fallback:
  // swapping this ONE binding is the only change a future direct-HTTP
  // one-shot implementation would need).
  const model: UtilityModelPort = { complete: (prompt, opts) => backend.oneShot(prompt, { ...opts, cwd }) };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Talaria: generating commit message…',
      cancellable: true,
    },
    async (progress, token) => {
      const result = await generateCommitMessage({ git, model, progress, token });
      presentResult(result, output);
    },
  );
}

/**
 * Register the `scm/title` command. `getBackend` is a thunk (not a snapshot)
 * so the trust-upgrade mock→real backend swap in `extension.ts` is always
 * reflected at invocation time — same posture as `registerDiffDecisionCommands`.
 * `output` is the shared "Talaria Code" output channel (`extension.ts`'s single
 * `vscode.window.createOutputChannel('Talaria Code')`) — SCM-2's landing spot for
 * a `model-error`'s raw detail.
 */
export function registerGenerateCommitMessageCommand(
  context: vscode.ExtensionContext,
  getBackend: () => AgentBackend,
  output: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('talaria.generateCommitMessage', () => runGenerateCommitMessage(getBackend, output)),
  );
}
