/**
 * W2 T4 — F-D (§3.5): the `hermes.acceptDiff`/`hermes.rejectDiff` editor-title
 * commands (`package.json`'s `editor/title` menu, `when: resourceScheme ==
 * hermes-diff`). Build-blind (compile-checked + Fedora-verified) —
 * deliberately thin: resolve the active diff tab's toolId (pure,
 * `diffDecision.ts`), delegate into the EXISTING `resolveDiff` seam (no new
 * resolution path — Reject denies whole-file, Accept walks every tracked
 * hunk via `AcpBackend.acceptWholeFileDiff`), then close every `hermes-diff:`
 * tab for that toolId (Cline's diff-tab lifecycle pattern: the registry
 * clearing itself, at the `resolveDiff`/`respondApproval` removal sites, is
 * what makes `DiffPreviewProvider` start serving the placeholder — this just
 * also tidies up the now-stale tab).
 */
import * as vscode from 'vscode';
import type { AgentBackend } from '../backend/AgentBackend';
import type { DiffAction } from '../../shared/protocol';
import { diffIdentityFromDiffTabInput, type DiffTabIdentity } from './diffDecision';

/** Structural capability check — only the real `AcpBackend` implements the
 * whole-file accept helper (mirrors the reach-for-it-when-present, no-op-
 * otherwise posture `HermesViewProvider.ts` applies to `AgentBackend`'s
 * optional members, P7-N12 · I-8). */
interface WholeFileAcceptCapable {
  acceptWholeFileDiff(sessionId: string, toolId: string): void;
}

function wholeFileAcceptCapable(backend: AgentBackend): backend is AgentBackend & WholeFileAcceptCapable {
  return typeof (backend as Partial<WholeFileAcceptCapable>).acceptWholeFileDiff === 'function';
}

/** The `(sessionId, toolId)` the given tab's `hermes-diff:` URIs encode, or
 * `undefined` if it isn't one of ours. The one `instanceof TabInputTextDiff`
 * narrowing point — everything past it is the pure `diffIdentityFromDiffTabInput`. */
function diffTabIdentity(tab: vscode.Tab | undefined): DiffTabIdentity | undefined {
  if (!tab || !(tab.input instanceof vscode.TabInputTextDiff)) return undefined;
  return diffIdentityFromDiffTabInput({ original: tab.input.original, modified: tab.input.modified });
}

/** Every open tab, across every tab group. */
function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

/** Close every `hermes-diff:` diff tab for `(sessionId, toolId)` (there can
 * be more than one — e.g. the same preview opened in a split view). Scoped
 * by BOTH — a different session's tab sharing the same toolId string must
 * never be closed as a side effect (W4-T3b, the same collision class the
 * registry's compound key removes). */
function closeDiffTabsForIdentity(identity: DiffTabIdentity): void {
  const tabs = allTabs().filter((tab) => {
    const id = diffTabIdentity(tab);
    return id?.sessionId === identity.sessionId && id.toolId === identity.toolId;
  });
  if (tabs.length > 0) void vscode.window.tabGroups.close(tabs);
}

function resolveActiveDiff(getBackend: () => AgentBackend, action: DiffAction): void {
  const identity = diffTabIdentity(vscode.window.tabGroups.activeTabGroup.activeTab);
  if (!identity) return;
  const { sessionId, toolId } = identity;

  const backend = getBackend();
  if (action === 'reject') {
    // Any reject denies the whole edit — the wire truth (ACP edit-approval is
    // whole-file); hunkIndex is irrelevant on the reject branch of resolveDiff.
    backend.resolveDiff(sessionId, toolId, 0, 'reject');
  } else if (wholeFileAcceptCapable(backend)) {
    backend.acceptWholeFileDiff(sessionId, toolId);
  }

  closeDiffTabsForIdentity(identity);
}

/**
 * Register the two editor-title commands. `getBackend` is a thunk (not a
 * snapshot) so the trust-upgrade mock→real backend swap in `extension.ts` is
 * always reflected at invocation time — same posture as `startRagIfEligible`'s
 * `backend` closure read.
 */
export function registerDiffDecisionCommands(
  context: vscode.ExtensionContext,
  getBackend: () => AgentBackend,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hermes.acceptDiff', () => resolveActiveDiff(getBackend, 'accept')),
    vscode.commands.registerCommand('hermes.rejectDiff', () => resolveActiveDiff(getBackend, 'reject')),
  );
}
