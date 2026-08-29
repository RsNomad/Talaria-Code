import type { RestoreResult } from '../../checkpoints/CheckpointTracker';
import type { CheckpointTrackerLike } from '../../checkpoints/trackerContract';
import type { RootCoordinator } from '../../checkpoints/RootCoordinator';
import type { ControlDispatcherHostPort } from './ControlDispatcher';

/**
 * WS-GD.2a A8: the narrowed slice of {@link ControlDispatcherHostPort} the
 * checkpoints domain actually reads — every member `restoreCheckpoint`/
 * `redoCheckpoint`/`warmCheckpointBaseline` (and the private methods they
 * route to) touches, and nothing else.
 */
export type CheckpointActionPort = Pick<
  ControlDispatcherHostPort,
  'logger' | 'rootRegistry' | 'resolveRootCoordinator' | 'getConnectionCwd'
>;

/**
 * WS-GD.2a A8: the checkpoints domain — pure move off `ControlDispatcher`
 * behind the same `ControlDispatcherHostPort` slice ({@link
 * CheckpointActionPort}) and a `fetchPanelData` callback bound to the
 * dispatcher's `PanelDataCoordinator.fetchPanelData`. Zero behavior change —
 * see each member's own doc (moved verbatim) for the full rationale.
 */
export class CheckpointActionHandler {
  /**
   * T-C1 (closes audit V-2): mints a unique synthetic lease-holder id per
   * `restoreCheckpoint`/`redoCheckpoint` invocation — verbatim pattern from
   * {@link ../oneshot/OneShotRunner.OneShotRunner.oneShot}'s own
   * `leaseCounter`/`leaseHolder`. Restore/redo used to only CHECK
   * `root.anyLiveTurn()` before calling into the tracker, never HOLD the
   * root's turn lease for the (possibly multi-second) duration of that
   * call — so a `sendPrompt`, a one-shot, or a SECOND restore/redo could be
   * admitted mid-restore and interleave agent writes with the shadow-git
   * apply loop. Restore/redo now acquire this SAME root turn lease (the one
   * `SessionController.sendPrompt`/`OneShotRunner.oneShot` already contend
   * on) under a synthetic `checkpoint-restore-N` holder, for the whole call.
   */
  private restoreLeaseCounter = 0;

  constructor(
    private readonly port: CheckpointActionPort,
    private readonly fetchPanelData: (panel: 'checkpoints', params: { rootId: string }) => Promise<unknown>,
  ) {}

  /**
   * Zone CKPT / C1: baseline-only snapshot helper. Moved verbatim off
   * `AcpBackend.snapshotCheckpoint` (the connection-level sibling — see the
   * original doc for how it differs from `SessionController`'s OWN
   * per-turn barrier of the same name). FAIL-OPEN — never rejects.
   */
  private async snapshotCheckpoint(
    tracker: CheckpointTrackerLike,
    turnOrdinal: number,
    promptText: string,
    rootId: string,
  ): Promise<void> {
    const label = truncateCheckpointLabel(promptText);
    try {
      await tracker.snapshot(turnOrdinal, label);
    } catch (err) {
      this.port.logger?.append(
        `[AcpBackend] checkpoint snapshot failed — turn ${turnOrdinal} proceeds WITHOUT a checkpoint (unprotected): ${errorMessage(err)}`,
      );
      return;
    }
    void this.fetchPanelData('checkpoints', { rootId }).catch((err: unknown) => {
      this.port.logger?.append(`[AcpBackend] post-snapshot checkpoints refresh failed: ${errorMessage(err)}`);
    });
  }

  /**
   * Zone CKPT / C1: fire the session-baseline snapshot from `AcpBackend
   * .start`/`ConnectionSupervisor.establishInitialSession`. Moved verbatim
   * off `AcpBackend.warmCheckpointBaseline` — fire-and-forget, see the
   * original doc for the full warm-index rationale (unchanged).
   */
  warmCheckpointBaseline(): void {
    const root = this.port.resolveRootCoordinator(this.port.getConnectionCwd() ?? '');
    const tracker = root.tracker;
    if (!tracker) return;
    const ordinal = root.nextBaselineOrdinal();
    void this.snapshotCheckpoint(tracker, ordinal, 'Session start', root.rootId);
  }

  /**
   * Zone CKPT: the Checkpoints panel's "Restore"/"Restore anyway" action.
   * Moved verbatim off `AcpBackend.restoreCheckpoint` — see the original
   * method's doc for the full W4-T2 Deliverable 5 rootId-routing rationale
   * (unchanged).
   */
  async restoreCheckpoint(params: unknown): Promise<RestoreResult> {
    const { id, force, rootId } = extractRestoreParams(params);
    const root = this.resolveRestoreTargetRoot(rootId);
    if (root === AMBIGUOUS_ROOT) return UNKNOWN_ROOT_RESTORE_REFUSAL;
    if (!root || !root.tracker) return NO_TRACKER_RESTORE_REFUSAL;
    // T-C1 (V-2): HOLD the root turn lease for the whole restore, not just
    // check it — see {@link restoreLeaseCounter}'s doc.
    const holder = `checkpoint-restore-${++this.restoreLeaseCounter}`;
    if (!root.tryAcquireTurnLease(holder)) return TURN_ACTIVE_RESTORE_REFUSAL;
    try {
      if (!id) {
        this.port.logger?.append('[AcpBackend] checkpoint.restore: missing id in params');
        return MALFORMED_RESTORE_REFUSAL;
      }
      const result = await root.tracker.restore(id, { ...(force !== undefined ? { force } : {}) });
      if (result.restored) {
        await this.fetchPanelData('checkpoints', { rootId: root.rootId }).catch((err: unknown) => {
          this.port.logger?.append(`[AcpBackend] post-restore checkpoints refresh failed: ${errorMessage(err)}`);
        });
      }
      return result;
    } catch (err) {
      return { restored: false, reason: errorMessage(err) };
    } finally {
      root.releaseTurnLease(holder);
    }
  }

  /**
   * W2-F2 Phase 1: the Checkpoints panel's Redo / Redo All actions. Moved
   * verbatim off `AcpBackend.redoCheckpoint` — mirrors {@link
   * restoreCheckpoint} exactly, including the rootId routing + interlock.
   */
  async redoCheckpoint(method: 'checkpoint.redo' | 'checkpoint.redoAll', params: unknown): Promise<RestoreResult> {
    const { force, rootId } = extractRestoreParams(params);
    const root = this.resolveRestoreTargetRoot(rootId);
    if (root === AMBIGUOUS_ROOT) return UNKNOWN_ROOT_RESTORE_REFUSAL;
    if (!root || !root.tracker) return NO_TRACKER_RESTORE_REFUSAL;
    // T-C1 (V-2): HOLD the root turn lease for the whole redo, not just
    // check it — mirrors {@link restoreCheckpoint} exactly (same shared
    // counter/holder prefix — restore and redo contend on the SAME lease).
    const holder = `checkpoint-restore-${++this.restoreLeaseCounter}`;
    if (!root.tryAcquireTurnLease(holder)) return TURN_ACTIVE_RESTORE_REFUSAL;
    try {
      const result =
        method === 'checkpoint.redo'
          ? await root.tracker.redo({ ...(force !== undefined ? { force } : {}) })
          : await root.tracker.redoAll({ ...(force !== undefined ? { force } : {}) });
      if (result.restored) {
        await this.fetchPanelData('checkpoints', { rootId: root.rootId }).catch((err: unknown) => {
          this.port.logger?.append(`[AcpBackend] post-redo checkpoints refresh failed: ${errorMessage(err)}`);
        });
      }
      return result;
    } catch (err) {
      return { restored: false, reason: errorMessage(err) };
    } finally {
      root.releaseTurnLease(holder);
    }
  }

  /**
   * W4-T2 Deliverable 5: resolve the checkpoint-action TARGET root. Moved
   * verbatim off `AcpBackend.resolveRestoreTargetRoot` — see the original
   * method's doc for the full ambiguity-refusal rationale (unchanged).
   */
  private resolveRestoreTargetRoot(rootId: string | undefined): RootCoordinator | undefined | typeof AMBIGUOUS_ROOT {
    if (rootId) return this.port.rootRegistry.get(rootId) ?? AMBIGUOUS_ROOT;
    const all = [...this.port.rootRegistry.values()];
    if (all.length === 1) return all[0];
    if (all.length === 0) return undefined;
    return AMBIGUOUS_ROOT;
  }
}

/**
 * P3 (arch A3): pinned refusal returned by {@link CheckpointActionHandler
 * .restoreCheckpoint}/{@link CheckpointActionHandler.redoCheckpoint} while a turn
 * is live. Moved verbatim — the exact string is a cross-zone contract, do
 * not reword without updating the panel.
 */
const TURN_ACTIVE_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'A turn is still running — wait for it to finish (or cancel it) before restoring or redoing a checkpoint.',
};

/**
 * W4-T2 Deliverable 5: the tri-state sentinel {@link CheckpointActionHandler
 * .resolveRestoreTargetRoot} returns when the checkpoint action's target
 * root could not be determined. Moved verbatim.
 */
const AMBIGUOUS_ROOT = Symbol('ambiguous-root');

/**
 * Zone CKPT (W4-T2, data-safety): pinned refusal for a `checkpoint.restore`/
 * `redo`/`redoAll` whose target root could not be determined. Moved verbatim.
 */
const UNKNOWN_ROOT_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'Could not determine which workspace this checkpoint action targets — refusing to restore against the wrong worktree.',
};

/**
 * T-C2 (closes audit V-17): pinned refusal for {@link CheckpointActionHandler
 * .restoreCheckpoint}/{@link CheckpointActionHandler.redoCheckpoint} when the
 * target root has no checkpoint tracker (checkpoints unavailable for this
 * workspace). This used to be a bare `undefined`, which `CheckpointsPanel`'s
 * `if (result && !result.restored)` sent down the success branch — an
 * affirmative "Workspace restored." on a restore that never ran. `undefined`
 * is never success.
 */
const NO_TRACKER_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'Checkpoints are not available for this workspace — nothing was restored.',
};

/**
 * T-C2 (closes audit V-17): pinned refusal for {@link CheckpointActionHandler
 * .restoreCheckpoint} when the request is missing the checkpoint `id` — same
 * bare-`undefined` false-success hazard as {@link NO_TRACKER_RESTORE_REFUSAL}.
 */
const MALFORMED_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'Malformed restore request (missing checkpoint id) — nothing was restored.',
};

/**
 * Zone CKPT: pull `{id, force, rootId}` out of `checkpoint.restore`'s
 * params. Moved verbatim.
 */
function extractRestoreParams(params: unknown): { id?: string; force?: boolean; rootId?: string } {
  if (!params || typeof params !== 'object') return {};
  const p = params as { id?: unknown; force?: unknown; rootId?: unknown };
  const id = typeof p.id === 'string' ? p.id : undefined;
  const force = typeof p.force === 'boolean' ? p.force : undefined;
  const rootId = typeof p.rootId === 'string' ? p.rootId : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(force !== undefined ? { force } : {}),
    ...(rootId !== undefined ? { rootId } : {}),
  };
}

/** Max length of a checkpoint label before truncation (Zone CKPT). Moved verbatim. */
const CHECKPOINT_LABEL_MAX_LEN = 80;

/**
 * Zone CKPT: the checkpoint `label` is the user's prompt text, truncated so
 * a pasted essay doesn't blow out the Checkpoints panel's timeline row.
 * Moved verbatim.
 */
function truncateCheckpointLabel(promptText: string): string {
  const collapsed = promptText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CHECKPOINT_LABEL_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, CHECKPOINT_LABEL_MAX_LEN - 1).trimEnd()}…`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
