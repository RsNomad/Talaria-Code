/*
 * Checkpoints panel: a vertical timeline of restore points, backed by the
 * extension-side shadow-git `CheckpointTracker` (NOT Hermes' own rollback
 * system) — snapshots at each ACP prompt-turn boundary: before the turn and,
 * since W2-F2 Phase 0, after it settles (tree-hash-deduped, so read-only
 * turns add no row; the after-snapshot is what makes undoing the last turn
 * force-free). Restoring preserves
 * the tracker's dirty-worktree guard: a blocked restore surfaces its reason
 * inline and offers an explicit "Restore anyway" (re-invokes with
 * `force: true`) rather than ever silently retrying — the data-loss guard
 * the tracker's own review fought for must not be bypassed from the UI.
 */
import { useEffect, useState } from 'react';
import type { Checkpoint, CheckpointPhase, CheckpointRestoreResult, CheckpointsData } from '../protocol';
import { busyInteraction } from '../components/busyInteraction';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill } from '../components/Pill';
import { EmptyPanel, PanelShell } from './PanelShell';

/** CF-12/m-9: human label for a checkpoint row's {@link Checkpoint.phase}. */
const PHASE_LABELS: Record<CheckpointPhase, string> = {
  before: 'Before',
  after: 'After',
  anchor: 'Anchor',
};

/** Which redo action a pending/blocked/completed redo state refers to. */
type RedoKind = 'redo' | 'redoAll';

/**
 * W4-T5b: the muted `· <label>` suffix for a checkpoint row's meta line —
 * `cp.sessionLabel` verbatim when present, `undefined` (render nothing, row
 * layout unchanged) when absent (legacy rows / rows no controller supplied
 * a label for). DISPLAY-ONLY (R8): purely a rendering decision, never a
 * correlation key. Pure so the present/absent behavior is unit-testable
 * without a DOM.
 */
export function checkpointSessionLabelSuffix(cp: Pick<Checkpoint, 'sessionLabel'>): string | undefined {
  return cp.sessionLabel || undefined;
}

interface CheckpointsPanelProps {
  data: CheckpointsData;
  /**
   * Correlated `checkpoint.restore` round trip (Part A2). Resolves with the
   * tracker's {@link CheckpointRestoreResult} — `restored:false` means the
   * dirty-worktree guard refused and its `reason` must be surfaced with an
   * explicit "Restore anyway". Replaced the old `checkpoint.restoreResult`
   * PUSH the panel used to listen for directly.
   */
  onRestore: (id: string, force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
  /**
   * CF-12 review fix (W3-T7): correlated `checkpoint.redo`/`checkpoint.redoAll`
   * round trips, threaded from `App.tsx` exactly like `onRestore` — App.tsx
   * carries BOTH the params (`rootId`, multi-root parity with restore) AND
   * the `bridge.request` tab tag (so `bridge.rejectTab` rejects an in-flight
   * redo promptly on tab close, instead of hanging until RPC timeout). This
   * replaced an earlier draft that fired `bridge.request` directly from this
   * panel via a dynamic `import('../bridge')` — that draft had neither the
   * tag nor `rootId`, and forced the dynamic-import hazard so this file
   * could stay importable from the PURE, `environment: 'node'`
   * `CheckpointsPanel.test.ts`. Threading these as props removes the bridge
   * dependency from this file entirely, so no dynamic import is needed.
   */
  onRedo: (force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
  onRedoAll: (force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
}

/** A restore that the tracker's dirty-worktree guard refused, pending user confirmation. */
interface BlockedRestore {
  id: string;
  reason: string;
}

/**
 * A completed restore that left some files untouched (see {@link
 * CheckpointRestoreResult.skippedPaths}). The restore still succeeded for
 * every other file — this is a notice, not a failure.
 *
 * CF-12 review fix, IMP-3: `skippedPaths` is filled by TWO unrelated causes
 * host-side (`CheckpointTracker.ts`) — the symlink-escape guard AND a
 * per-path I/O failure (ENOSPC/EACCES/EROFS, or `git show` dying on a
 * since-pruned blob) — and the array does not disambiguate which happened
 * for which path. The rendered copy must stay cause-agnostic; do not name a
 * specific cause here.
 */
interface SkippedNotice {
  id: string;
  paths: string[];
}

export function CheckpointsPanel({ data, onRestore, onRedo, onRedoAll }: CheckpointsPanelProps) {
  const [blocked, setBlocked] = useState<BlockedRestore | undefined>(undefined);
  const [skipped, setSkipped] = useState<SkippedNotice | undefined>(undefined);

  /**
   * Audit G-11: restoring rewrites the user's working tree, and the control was
   * a bare onClick with no confirmation, no in-flight lock and no success
   * message. Three separate pieces of state, deliberately per-checkpoint-id so
   * a prompt on one row cannot be answered by a click on another:
   *  - `confirming`: which row is asking
   *  - `restoringId`: which row is in flight (blocks a double click)
   *  - `restored`: which row just succeeded (the acknowledgement)
   * The inline two-button grammar mirrors the `blocked` branch below, which
   * already renders "Restore anyway"/"Cancel" — no modal is introduced.
   */
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [restoringId, setRestoringId] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState<string | undefined>(undefined);

  /**
   * CF-12 (W3-T7): the Redo / Redo-all affordance for {@link
   * CheckpointsData.redo} — mirrors the row-level restore state above
   * (`redoPending` = in-flight lock, `redoBlocked` = the dirty-worktree
   * guard's refusal + force-retry, `redoDone`/`redoSkipped` = the success
   * acknowledgement and its partial-rollback notice), one instance for the
   * whole panel since a redo target is not a per-row action — it targets the
   * tracker's own stored cursor/anchor (`CheckpointRedoState.cursorId`/
   * `.anchorId`), never a checkpoint id the panel picks.
   */
  const [redoPending, setRedoPending] = useState<RedoKind | undefined>(undefined);
  const [redoBlocked, setRedoBlocked] = useState<{ kind: RedoKind; reason: string } | undefined>(undefined);
  const [redoDone, setRedoDone] = useState<RedoKind | undefined>(undefined);
  const [redoSkipped, setRedoSkipped] = useState<{ kind: RedoKind; paths: string[] } | undefined>(undefined);

  /**
   * CF-12 review fix, IMP-1: this panel is NOT remounted on a tab/root
   * switch (App.tsx keeps one instance mounted while `activePanel ===
   * 'checkpoints'`), so switching the active chat tab to one bound to a
   * DIFFERENT workspace root feeds this SAME mounted panel a different
   * `data.redo` — while a stale `redoDone`/`redoBlocked`/`redoSkipped`
   * notice from the PREVIOUS root's redo still showed, for a target the
   * user on the new root never acted on. `data.redo`'s identity
   * (`anchorId`+`cursorId`, both possibly `undefined`) is the tracker's own
   * redo pointer for whichever root is currently feeding this panel — any
   * change to it (including becoming absent) means "this is a different
   * redo target than the one the state above was about", so every piece of
   * that state (including the in-flight lock) is stale and must clear.
   */
  useEffect(() => {
    setRedoPending(undefined);
    setRedoBlocked(undefined);
    setRedoDone(undefined);
    setRedoSkipped(undefined);
  }, [data.redo?.anchorId, data.redo?.cursorId]);

  if (data.available === false) {
    return (
      <PanelShell title="Checkpoints">
        <div className="flex flex-col items-center gap-2 px-1 py-6 text-center">
          <Icon name="warning" size={20} className="text-faint" />
          <div className="text-xs text-faint">Checkpoints unavailable</div>
          {data.unavailableReason && (
            <div className="max-w-[26rem] font-mono text-2xs text-faint">{data.unavailableReason}</div>
          )}
        </div>
      </PanelShell>
    );
  }

  // W4-T6 (UI#8, state-parity): every other data panel with an emptyable
  // list renders `EmptyPanel` at zero rows (`SessionsPanel.tsx`,
  // `SubagentsPanel.tsx`, ...) — this was the one exception, falling through
  // to a bare, empty `<ol>` with no hint text. Strictly AFTER the
  // `available === false` branch above: an unavailable tracker still takes
  // precedence over "genuinely empty" (git works, but no checkpoints have
  // been captured yet). ALSO gated on `!data.redo`: an empty `checkpoints`
  // list with a live `data.redo` target (CF-12/W3-T7 — the anchored-redo
  // state can outlive every tracked checkpoint row) still has real,
  // actionable content — the Redo/Redo all affordance below — so it must
  // render that, not a bare "nothing here" hint that would hide it.
  if (data.checkpoints.length === 0 && !data.redo) {
    return (
      <PanelShell title="Checkpoints">
        <EmptyPanel hint="No checkpoints yet — they appear here after each turn." />
      </PanelShell>
    );
  }

  /**
   * Returns the round-trip promise (rather than firing-and-forgetting it) so
   * `confirmRestore` below can key the in-flight lock off the REQUEST
   * actually settling, not off `restore`'s own synchronous return. An
   * earlier draft wrapped `restore`'s (always-`undefined`) synchronous
   * return in `Promise.resolve(...).finally(...)` — that resolved on the
   * very next microtask regardless of how long `onRestore` actually took, so
   * the "Restoring…" lock cleared almost instantly instead of for the
   * duration of the request. Caught by a diagnostic DOM test that polled the
   * button's `disabled` state across several microtask flushes while the
   * round trip was deliberately left unresolved — see task-23-report.md.
   */
  const restore = (id: string, force?: boolean) => {
    if (!force) setBlocked((prev) => (prev?.id === id ? undefined : prev));
    // Drop any prior skipped-paths notice for this row before re-attempting.
    setSkipped((prev) => (prev?.id === id ? undefined : prev));
    return onRestore(id, force).then(
      (result) => {
        // T-C2 (closes audit V-17): `undefined` is never success — the host
        // can no longer produce it (its refusal paths are pinned
        // RestoreResults now), but this branch stays as defense in depth.
        if (!result) {
          setBlocked({ id, reason: 'Restore failed — the host returned no result.' });
        } else if (!result.restored) {
          // A dirty-worktree-guard refusal comes back as restored:false + reason;
          // surface it (with the "Restore anyway" affordance) rather than retrying.
          setBlocked({ id, reason: result.reason || 'Restore was refused.' });
        } else {
          setBlocked((prev) => (prev?.id === id ? undefined : prev));
          setRestored(id);
          // The restore succeeded, but the tracker may have refused/failed to
          // touch some files (symlink escape OR a per-path I/O failure — see
          // `SkippedNotice`'s doc). Surface them so "restored" doesn't hide a
          // partial rollback.
          if (result.skippedPaths && result.skippedPaths.length > 0) {
            setSkipped({ id, paths: result.skippedPaths });
          }
        }
      },
      (err: unknown) => {
        setBlocked({ id, reason: err instanceof Error ? err.message : 'Restore failed.' });
      },
    );
  };

  const requestRestore = (id: string) => {
    setConfirming(id);
    setRestored(undefined);
  };

  const confirmRestore = (id: string, force?: boolean) => {
    if (restoringId !== undefined) return; // in flight — ignore repeat clicks
    setConfirming(undefined);
    setRestoringId(id);
    setRestored(undefined);
    void restore(id, force).finally(() => setRestoringId(undefined));
  };

  /**
   * CF-12 (W3-T7), review-fixed: fires the correlated `checkpoint.redo`/
   * `checkpoint.redoAll` request through the `onRedo`/`onRedoAll` CALLBACK
   * PROPS — exactly mirroring how `restore` above calls `onRestore` — rather
   * than the original direct-`bridge`-via-dynamic-`import` design (see
   * `CheckpointsPanelProps.onRedo`'s doc for why that draft existed and why
   * it was replaced). `App.tsx`'s implementation of these props supplies
   * `rootId` (multi-root parity with restore) and tags the request with the
   * owning tab's id, so this file no longer imports `bridge` at all —
   * `CheckpointsPanel.test.ts` (the PURE, `environment: 'node'` sibling
   * suite) needs no special-casing for it.
   */
  const runRedo = (kind: RedoKind, force?: boolean) => {
    if (redoPending !== undefined) return; // in flight — ignore repeat clicks
    setRedoPending(kind);
    setRedoDone(undefined);
    if (!force) setRedoBlocked(undefined);
    setRedoSkipped(undefined);
    const action = kind === 'redo' ? onRedo : onRedoAll;
    void action(force)
      .then(
        (result) => {
          // Mirrors T-C2 (V-17) above: `undefined` is never success.
          if (!result) {
            setRedoBlocked({ kind, reason: 'Redo failed — the host returned no result.' });
          } else if (!result.restored) {
            setRedoBlocked({ kind, reason: result.reason || 'Redo was refused.' });
          } else {
            setRedoBlocked(undefined);
            setRedoDone(kind);
            if (result.skippedPaths && result.skippedPaths.length > 0) {
              setRedoSkipped({ kind, paths: result.skippedPaths });
            }
          }
        },
        (err: unknown) => {
          setRedoBlocked({ kind, reason: err instanceof Error ? err.message : 'Redo failed.' });
        },
      )
      .finally(() => setRedoPending(undefined));
  };

  /**
   * AU-40: shared by every Redo/Redo-all/"Redo anyway" button below —
   * `redoPending` is a single panel-scoped state (not per-row), and every
   * one of these three buttons already disabled on it, so ONE computed
   * posture covers all three mutually-exclusive branches. Purely in-flight —
   * nothing genuinely-indefinite gates redo.
   */
  const redoInteraction = busyInteraction(false, redoPending !== undefined);
  /**
   * AU-40: shared by every "Restore anyway"/"Restore workspace"/"Restore"
   * button across EVERY row below — `restoringId` is a single panel-scoped
   * state, and a row NOT being restored still bounded-in-flight-disables its
   * own Restore controls while another row's restore is running (the brief's
   * own call-out: focus preservation matters most exactly on the non-clicked
   * rows). Purely in-flight — nothing genuinely-indefinite gates restore.
   */
  const restoreInteraction = busyInteraction(false, restoringId !== undefined);

  const redoStatusText = redoBlocked
    ? ''
    : redoPending
      ? redoPending === 'redo'
        ? 'Redoing…'
        : 'Redoing all…'
      : redoDone
        ? redoDone === 'redo'
          ? 'Workspace redone to the next checkpoint.'
          : 'Workspace redone to the latest state.'
        : '';

  return (
    <PanelShell title="Checkpoints" meta={`${data.checkpoints.length} saved`}>
      {data.redo && (
        <div className="mb-3 rounded-card border border-border bg-surface px-3 py-2">
          <div className="flex items-start gap-1.5 text-2xs text-fg">
            <Icon name="info" size={12} className="mt-0.5 flex-none text-faint" />
            <span>
              {data.redo.anchorTurnOrdinal !== undefined
                ? `A checkpoint was undone — redo is available back to turn ${data.redo.anchorTurnOrdinal}.`
                : 'A checkpoint was undone — redo is available.'}
            </span>
          </div>

          {redoBlocked ? (
            <div className="mt-1.5 rounded border border-warn bg-warn-soft px-2 py-1.5">
              <div className="flex items-start gap-1.5 text-2xs text-fg">
                <Icon name="warning" size={12} className="mt-0.5 flex-none text-warn" />
                <span>{redoBlocked.reason}</span>
              </div>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  disabled={redoInteraction.nativeDisabled}
                  aria-disabled={redoInteraction.ariaDisabled}
                  aria-busy={redoInteraction.ariaBusy}
                  onClick={() => {
                    // AU-40: belt-and-suspenders — `runRedo` already guards
                    // `if (redoPending !== undefined) return;` itself.
                    if (!redoInteraction.interactive) return;
                    runRedo(redoBlocked.kind, true);
                  }}
                  className="rounded border border-warn px-2 py-0.5 font-mono text-2xs text-warn hover:bg-overlay aria-disabled:cursor-default aria-disabled:opacity-50"
                >
                  {redoBlocked.kind === 'redo' ? 'Redo anyway' : 'Redo all anyway'}
                </button>
                <button
                  type="button"
                  onClick={() => setRedoBlocked(undefined)}
                  className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                disabled={redoInteraction.nativeDisabled}
                aria-disabled={redoInteraction.ariaDisabled}
                aria-busy={redoInteraction.ariaBusy}
                onClick={() => {
                  if (!redoInteraction.interactive) return;
                  runRedo('redo');
                }}
                className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50"
              >
                Redo
              </button>
              <button
                type="button"
                disabled={redoInteraction.nativeDisabled}
                aria-disabled={redoInteraction.ariaDisabled}
                aria-busy={redoInteraction.ariaBusy}
                onClick={() => {
                  if (!redoInteraction.interactive) return;
                  runRedo('redoAll');
                }}
                className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50"
              >
                Redo all
              </button>
            </div>
          )}

          <LiveRegion text={redoStatusText} className={redoStatusText ? 'mt-1.5 text-2xs text-fg' : ''} />

          {redoSkipped && (
            <div className="mt-1.5 rounded border border-border bg-overlay px-2 py-1.5">
              <div className="flex items-start gap-1.5 text-2xs text-fg">
                <Icon name="info" size={12} className="mt-0.5 flex-none text-faint" />
                <span>
                  Redone. {redoSkipped.paths.length} file{redoSkipped.paths.length === 1 ? '' : 's'} could not
                  be updated.
                </span>
              </div>
              <ul className="mt-1 list-none space-y-0.5 pl-[18px]">
                {redoSkipped.paths.map((p) => (
                  <li key={p} className="truncate font-mono text-2xs text-faint">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <ol className="relative m-0 list-none p-0">
        {data.checkpoints.map((cp, i) => {
          const last = i === data.checkpoints.length - 1;
          const latest = i === 0;
          const block = blocked?.id === cp.id ? blocked : undefined;
          const skip = skipped?.id === cp.id ? skipped : undefined;
          /**
           * T-15/F6: the row's restoring/restored status text, unified into
           * ONE value so it can drive a single, permanently-mounted
           * `LiveRegion` below instead of two separately-conditioned spans
           * that each carried `aria-live`/`role="status"` directly on
           * themselves — both only ever entered the DOM once their text was
           * already there, the Finding-7 unreliable-announcement pattern
           * (MDN Live_regions, fetched live for this task: "Start with an
           * empty live region, then – in a separate step – change the
           * content inside the region",
           * https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions).
           * The two states are mutually exclusive by construction (a row is
           * never simultaneously `restoringId` and `restored`), so a single
           * text/className pair is lossless.
           *
           * Gated on `!block` — matches the ORIGINAL spans' implicit
           * gating (they only ever lived in the idle branch below, never
           * the blocked one): a "Restore anyway" force-retry can have
           * `restoringId === cp.id` while `block` is STILL set (`restore()`
           * only clears `blocked` when NOT force), and this row never
           * showed a "Restoring…" text during that wait before — this keeps
           * it that way. `confirming` needs no separate check: `confirmRestore`
           * clears it in the SAME state batch that sets `restoringId`, so by
           * the time `restoringId === cp.id` can be true, `confirming` has
           * already moved on.
           */
          const rowStatusText = block
            ? ''
            : restoringId === cp.id
              ? 'Restoring…'
              : restored === cp.id && restoringId === undefined
                ? 'Workspace restored to this checkpoint.'
                : '';
          const rowStatusClass = restoringId === cp.id ? 'text-2xs text-muted' : 'text-2xs text-fg';
          return (
            <li key={cp.id} className="relative flex gap-3 pb-3">
              {/* timeline rail */}
              <div className="flex flex-none flex-col items-center">
                <Icon
                  name={latest ? 'circle-filled' : 'circle-outline'}
                  size={12}
                  className={latest ? 'text-accent' : 'text-faint'}
                />
                {!last && <span className="mt-1 w-px flex-1 bg-border" />}
              </div>

              <div className="min-w-0 flex-1 rounded-card border border-border bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[12.5px] font-semibold text-fg">
                    {cp.label}
                  </span>
                  {latest && (
                    <span className="ml-auto flex-none">
                      {/*
                       * Not "Latest": a checkpoint snapshots the turn-START state
                       * (the workspace BEFORE that turn ran), so "Latest" misread
                       * as "your current state". "Newest" honestly marks the most
                       * recent restore point without implying it's the live state.
                       */}
                      <Pill tone="accent">Newest</Pill>
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-2xs text-faint">
                  <span>{cp.age}</span>
                  {cp.phase && (
                    <>
                      <span>·</span>
                      <span className="truncate">{PHASE_LABELS[cp.phase]}</span>
                    </>
                  )}
                  {cp.filesChanged !== undefined && (
                    <>
                      <span>·</span>
                      <span>{cp.filesChanged} files</span>
                    </>
                  )}
                  <span>·</span>
                  <span className="truncate">{cp.timestamp}</span>
                  {checkpointSessionLabelSuffix(cp) && (
                    <>
                      <span>·</span>
                      <span className="truncate">{checkpointSessionLabelSuffix(cp)}</span>
                    </>
                  )}
                </div>

                {block ? (
                  <div className="mt-2 rounded border border-warn bg-warn-soft px-2 py-1.5">
                    <div className="flex items-start gap-1.5 text-2xs text-fg">
                      <Icon name="warning" size={12} className="mt-0.5 flex-none text-warn" />
                      <span>{block.reason}</span>
                    </div>
                    <div className="mt-1.5 flex gap-2">
                      <button
                        type="button"
                        disabled={restoreInteraction.nativeDisabled}
                        aria-disabled={restoreInteraction.ariaDisabled}
                        aria-busy={restoreInteraction.ariaBusy}
                        onClick={() => {
                          // AU-40: belt-and-suspenders — `confirmRestore`
                          // already guards `if (restoringId !== undefined)
                          // return;` itself.
                          if (!restoreInteraction.interactive) return;
                          confirmRestore(cp.id, true);
                        }}
                        className="rounded border border-warn px-2 py-0.5 font-mono text-2xs text-warn hover:bg-overlay aria-disabled:cursor-default aria-disabled:opacity-50"
                      >
                        Restore anyway
                      </button>
                      <button
                        type="button"
                        onClick={() => setBlocked(undefined)}
                        className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : confirming === cp.id ? (
                  <div className="mt-2 rounded border border-warn bg-warn-soft px-2 py-1.5">
                    <div className="flex items-start gap-1.5 text-2xs text-fg">
                      <Icon name="warning" size={12} className="mt-0.5 flex-none text-warn" />
                      <span>
                        This will overwrite your working tree with the files as they were at this
                        checkpoint. Uncommitted changes made since then are lost.
                      </span>
                    </div>
                    <div className="mt-1.5 flex gap-2">
                      <button
                        type="button"
                        disabled={restoreInteraction.nativeDisabled}
                        aria-disabled={restoreInteraction.ariaDisabled}
                        aria-busy={restoreInteraction.ariaBusy}
                        onClick={() => {
                          if (!restoreInteraction.interactive) return;
                          confirmRestore(cp.id);
                        }}
                        className="rounded border border-warn px-2 py-0.5 font-mono text-2xs text-warn hover:bg-overlay disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50"
                      >
                        Restore workspace
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(undefined)}
                        className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={restoreInteraction.nativeDisabled}
                      aria-disabled={restoreInteraction.ariaDisabled}
                      aria-busy={restoreInteraction.ariaBusy}
                      onClick={() => {
                        // AU-40: unlike confirmRestore, requestRestore has no
                        // internal guard of its own — this is the ONLY thing
                        // stopping a click from opening a confirm prompt for
                        // a different row while another row's restore is in
                        // flight.
                        if (!restoreInteraction.interactive) return;
                        requestRestore(cp.id);
                      }}
                      className="rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50"
                    >
                      Restore
                    </button>
                  </div>
                )}

                {/* T-15/F6: a STABLE sibling of the block/confirming/idle
                    ternary above — not nested inside any one of its
                    branches. Nesting it inside the idle branch (as an
                    earlier draft did) meant the confirm dialog's own branch
                    unmounted it, so it re-mounted WITH `restoringId` already
                    set the moment the user confirmed — reproducing the exact
                    mount-with-content problem this fix exists to close.
                    Kept mounted across every branch, it only ever swaps
                    `text` (Finding-7 discipline). */}
                <LiveRegion
                  text={rowStatusText}
                  className={rowStatusText ? `mt-2 ${rowStatusClass}` : ''}
                />

                {skip && (
                  <div className="mt-2 rounded border border-border bg-overlay px-2 py-1.5">
                    <div className="flex items-start gap-1.5 text-2xs text-fg">
                      <Icon name="info" size={12} className="mt-0.5 flex-none text-faint" />
                      <span>
                        Restored. {skip.paths.length} file{skip.paths.length === 1 ? '' : 's'}{' '}
                        could not be updated.
                      </span>
                    </div>
                    <ul className="mt-1 list-none space-y-0.5 pl-[18px]">
                      {skip.paths.map((p) => (
                        <li key={p} className="truncate font-mono text-2xs text-faint">
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </PanelShell>
  );
}
