/**
 * WS-CK-A6 ship gate (spec req 8): while false, NOTHING multi-root runs — the
 * single primary-root tracker path is byte-identical to pre-A6, non-primary
 * roots keep the honest NO_TRACKER_RESTORE_REFUSAL, and neither the
 * CheckpointTrackerRegistry nor the onDidChangeWorkspaceFolders subscription
 * is constructed. Flipped to true ONLY by the final A6 gate commit, after the
 * per-root suite (registry + reconcile + isolation + INV-A6-GITDIR +
 * dispose-durability + promotion) is green.
 */
export const MULTI_ROOT_CHECKPOINTS = false;
