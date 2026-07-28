/**
 * W2 T4 — F-D (§3.5): the pure half of the editor-title Accept/Reject
 * commands — resolving WHICH pending edit-approval a `talaria-diff:` diff tab
 * belongs to. The vscode-touching shell (`instanceof TabInputTextDiff`
 * narrowing, command registration, `tabGroups` closing) lives in
 * `diffDecision.vscode.ts`, mirroring `editorActions.ts`/`editorActions.vscode.ts`'s
 * split — this file stays headless-testable.
 */
import { parseDiffUri, type DiffUriLike } from '../preview/parseDiffUri';

/** The two URIs a `vscode.TabInputTextDiff` carries, structurally. */
export interface DiffTabInputLike {
  original?: DiffUriLike;
  modified?: DiffUriLike;
}

/** The `(sessionId, toolId)` compound a `talaria-diff:` diff tab's URIs
 * encode (W4-T3b — the URI now carries `sessionId` too, since
 * `EditPreviewRegistry`/`AcpBackend.resolveDiff` are both session-scoped). */
export interface DiffTabIdentity {
  sessionId: string;
  toolId: string;
}

/**
 * The `(sessionId, toolId)` a diff tab's `talaria-diff:` URIs encode, or
 * `undefined` when the tab isn't one of ours (an ordinary file-compare tab,
 * missing input) — or, defensively, when the two sides disagree (a shape
 * neither `HermesViewProvider.openDiffPreview` nor `DiffPreviewProvider`
 * ever produces; fail closed rather than guess which side to trust). Prefers
 * the `modified` (after) side, since that's the one VS Code keeps
 * focused/dirty, falling back to `original` when only it is present.
 *
 * W4-T3b (resolves the S0 "no active-session source" placeholder,
 * `diffDecision.vscode.ts`'s prior `DIFF_DECISION_SESSION_PLACEHOLDER`):
 * `AcpBackend.resolveDiff`/`acceptWholeFileDiff` are session-scoped, and the
 * editor-title Accept/Reject commands have no OTHER session-identity source
 * of their own (they resolve off the active EDITOR TAB, not a chat tab) — so
 * the sessionId embedded in the tab's OWN `talaria-diff:` URI is the correct,
 * and only available, source.
 */
export function diffIdentityFromDiffTabInput(input: DiffTabInputLike | undefined): DiffTabIdentity | undefined {
  if (!input) return undefined;
  const original = input.original ? parseDiffUri(input.original) : undefined;
  const modified = input.modified ? parseDiffUri(input.modified) : undefined;
  if (original && modified) {
    return original.sessionId === modified.sessionId && original.toolId === modified.toolId
      ? { sessionId: modified.sessionId, toolId: modified.toolId }
      : undefined;
  }
  const only = modified ?? original;
  return only ? { sessionId: only.sessionId, toolId: only.toolId } : undefined;
}
