/**
 * CF-19 / W4-T3 — the shared RECORDING-side scheme gate.
 *
 * GATE-4 (`nextedit/shell.vscode.ts`, mirrored in `provider.ts`'s trigger-side
 * scheme skip) already guards the TRIGGER side:
 * `document.uri.scheme === 'vscode-scm' || document.uri.scheme === 'output'`
 * stops both completion and next-edit from firing against a non-editable
 * document. Nothing guarded the three RECORDING subscriptions
 * (`contextService.vscode.ts`'s keystroke-clock bump, `editTrackerAdapter.ts`'s
 * edit-ring fold, `nextedit/shell.vscode.ts`'s own edit-burst arm site) — so
 * Output/SCM text still entered the edit ring, shipped as FIM `input_extra`,
 * starved the idle-completion gate, and armed next-edit even though nothing
 * would ever be triggered against it.
 *
 * This predicate is deliberately an ALLOWLIST, not a literal restatement of
 * GATE-4's two-scheme denylist: egress/hygiene discipline says a RECORDING
 * decision should fail toward NOT recording, so only the two schemes that
 * genuinely denote a real, user-owned editable document — `file` (on-disk)
 * and `untitled` (an unsaved new file) — are recordable. Every other scheme,
 * including GATE-4's own `vscode-scm`/`output` AND any scheme GATE-4 has
 * never heard of (`git`, `vscode-notebook-cell`, `search-editor`, …), is
 * denied. This still AGREES with GATE-4 on the two cases that matter (both
 * gates deny `vscode-scm` and `output`, so recording and triggering can never
 * disagree on those) while being strictly more conservative elsewhere — a
 * mismatch that can only ever mean "recorded less than GATE-4 would trigger
 * on", never the reverse.
 *
 * Pure: no `vscode`, no `Date.now()`/`Math.random()`. Not a secret-leak fix
 * and does not replace the secret scanner (`secretScanner.ts`), which still
 * applies downstream to whatever content this predicate does let through —
 * this is hygiene + correctness for WHICH documents ever reach the edit
 * ring/keystroke clock/next-edit arm at all.
 */
/**
 * §4 — GATE-4's trigger-side denylist (`provider.ts`, `nextedit/shell.vscode.ts`),
 * factored out as a predicate instead of two independently-hardcoded literal
 * comparisons: any scheme other than `vscode-scm` (source-control input box)
 * or `output` (Output panel) is triggerable. Same two-scheme denylist shape
 * as before — this function does not change what GATE-4 denies, it just
 * gives the comparison a name both call sites share.
 */
export function isTriggerableScheme(scheme: string): boolean {
  return scheme !== 'vscode-scm' && scheme !== 'output';
}

/**
 * §4 — the allowlist half of the old `isRecordableScheme` body: only `file`
 * (on-disk) and `untitled` (unsaved new file) denote a real, user-owned
 * editable document.
 */
export function isEditableUserDoc(scheme: string): boolean {
  return scheme === 'file' || scheme === 'untitled';
}

/**
 * §4 — now a composition, not an independently-maintained literal list:
 * "record ⊆ trigger" is a structural fact about AND-ing
 * {@link isTriggerableScheme} with {@link isEditableUserDoc}, not a
 * coincidence that has to be kept in sync by hand. Since `file`/`untitled`
 * are never in GATE-4's denylist, `isTriggerableScheme` is always `true` on
 * them, so this is behaviorally identical to the old
 * `scheme === 'file' || scheme === 'untitled'` body on every input.
 */
export function isRecordableScheme(scheme: string): boolean {
  return isTriggerableScheme(scheme) && isEditableUserDoc(scheme);
}
