/**
 * DOM-level tests for the Checkpoints panel (G-11, task 23).
 *
 * Scope: restoring a checkpoint REWRITES THE USER'S WORKING TREE. The Restore
 * button used to be a bare `onClick={() => restore(cp.id)}` — no
 * confirmation, no in-flight lock, no success acknowledgement. These tests
 * prove all three: (1) the first click asks, it does not act; (2) a second
 * click while the round trip is in flight cannot fire a second restore; (3) a
 * successful restore is acknowledged on screen, not left to silent inference.
 *
 * Reuses the `setup(jsx)` idiom from `SettingsPanel.dom.test.tsx` (userEvent
 * instance created BEFORE render) and the `checkpoint()` fixture pattern from
 * `CheckpointsPanel.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Checkpoint, CheckpointRedoState, CheckpointRestoreResult, CheckpointsData } from '../protocol';
import { CheckpointsPanel } from './CheckpointsPanel';

/** Documented shape: invoke `userEvent.setup()` BEFORE rendering, and use the
 *  returned instance rather than the direct API. */
function setup(jsx: ReactElement) {
  return { user: userEvent.setup(), ...render(jsx) };
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'ckpt-1',
    label: 'Before turn 1',
    age: '2m ago',
    timestamp: '2026-07-14T00:00:00Z',
    ...overrides,
  };
}

/** A no-op redo prop for tests that only exercise restore — `data.redo` is
 *  absent in {@link renderPanel}'s fixture, so neither Redo control ever
 *  renders and these are never actually invoked. */
const neverRedo = async () => ({ restored: true as const, filesChanged: 0, changedPaths: [] });

function renderPanel(config: {
  onRestore: (id: string, force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
}) {
  const data: CheckpointsData = { checkpoints: [checkpoint()] };
  return (
    <CheckpointsPanel data={data} onRestore={config.onRestore} onRedo={neverRedo} onRedoAll={neverRedo} />
  );
}

/**
 * W4-T6 (UI#8, state-parity): every OTHER data panel with an emptyable list
 * renders `EmptyPanel` at zero rows (`SessionsPanel.tsx`: "No past sessions
 * yet.", `SubagentsPanel.tsx`: "No delegations yet — ..."). `CheckpointsPanel`
 * was the one exception — at `data.checkpoints.length === 0` it fell through
 * to `PanelShell` with a bare, empty `<ol>` (no hint text, nothing for a
 * screen reader to announce). This does NOT touch the W3-T7 redo/restore
 * logic — it only adds the same empty-state branch the other panels already
 * have, gated strictly on the list being empty (the `data.available === false`
 * "unavailable" branch above it is untouched and still takes precedence).
 */
describe('W4-T6 (UI#8): CheckpointsPanel renders an EmptyPanel at 0 checkpoints (parity with the other panels)', () => {
  it('renders an empty-state hint, not a bare empty timeline, when data.checkpoints is []', () => {
    const data: CheckpointsData = { checkpoints: [] };
    render(
      <CheckpointsPanel
        data={data}
        onRestore={async () => ({ restored: true, filesChanged: 0, changedPaths: [] })}
        onRedo={neverRedo}
        onRedoAll={neverRedo}
      />,
    );

    expect(screen.getByText(/no checkpoints/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('the redo affordance still wins over the empty-state branch when checkpoints is [] but data.redo is present', () => {
    // CF-12/W3-T7: the anchored-redo target can outlive every tracked
    // checkpoint row (mirrors App.dom.test.tsx's `openCheckpointsWithRedo`
    // fixture) — an empty list must NOT hide a genuinely actionable redo.
    const data: CheckpointsData = {
      checkpoints: [],
      redo: { anchorId: 'anchor-1', cursorId: 'cursor-1' },
    };
    render(
      <CheckpointsPanel
        data={data}
        onRestore={async () => ({ restored: true, filesChanged: 0, changedPaths: [] })}
        onRedo={neverRedo}
        onRedoAll={neverRedo}
      />,
    );

    expect(screen.getByRole('button', { name: 'Redo' })).toBeInTheDocument();
    expect(screen.queryByText(/no checkpoints/i)).not.toBeInTheDocument();
  });

  it('the unavailable branch still wins over the empty-state branch when data.available is false', () => {
    const data: CheckpointsData = {
      checkpoints: [],
      available: false,
      unavailableReason: 'git not found on PATH',
    };
    render(
      <CheckpointsPanel
        data={data}
        onRestore={async () => ({ restored: true, filesChanged: 0, changedPaths: [] })}
        onRedo={neverRedo}
        onRedoAll={neverRedo}
      />,
    );

    expect(screen.getByText('Checkpoints unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/no checkpoints/i)).not.toBeInTheDocument();
  });
});

describe('G-11: restoring the workspace is confirmed, locked and acknowledged', () => {
  it('the first click asks for confirmation and restores NOTHING', async () => {
    const restores: string[] = [];
    const { user } = setup(
      renderPanel({
        onRestore: async (id) => {
          restores.push(id);
          return { restored: true, filesChanged: 1, changedPaths: ['a.txt'] };
        },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(restores).toEqual([]);
    expect(screen.getByText(/overwrite your working tree/i)).toBeInTheDocument();
  });

  it('confirming restores exactly once, and a second click while in flight does nothing', async () => {
    const restores: string[] = [];
    let release: ((v: CheckpointRestoreResult) => void) | undefined;
    const { user } = setup(
      renderPanel({
        onRestore: async (id) => {
          restores.push(id);
          return new Promise((r) => {
            release = r;
          });
        },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    const confirm = screen.getByRole('button', { name: 'Restore workspace' });
    await user.click(confirm);
    await user.click(confirm);

    expect(restores).toHaveLength(1);
    release?.({ restored: true, filesChanged: 1, changedPaths: ['a.txt'] });
  });

  /**
   * The test above clicks the SAME "Restore workspace" node twice, but that
   * node does not survive the first click: `confirmRestore` synchronously
   * clears `confirming`, so the row's ternary swaps branches and React
   * unmounts that button (verified empirically — `.isConnected` is `false`
   * immediately after the first click). A second click on a detached node
   * can never reach a handler regardless of any guard, so on its own the
   * test above would still pass even with the `if (restoringId !==
   * undefined) return;` line deleted from `confirmRestore` — confirmed by
   * actually deleting it and re-running (see task-23-report.md's plant log).
   * jsdom was also confirmed (via a throwaway diagnostic against a bare
   * `disabled` button) to never invoke a click handler on a disabled native
   * button at all, via either `fireEvent.click` or `userEvent.click` — so
   * the OTHER lock mechanism (the `disabled` attribute on the plain
   * "Restore" button) is equally unable to make that line observable.
   *
   * The line is not dead: the `blocked` branch's "Restore anyway" button
   * routes through the same `confirmRestore`, is NOT `disabled`-gated on
   * `restoringId`, and — because `restore()` only clears `blocked` when
   * `force` is false — stays mounted, visible and enabled with its
   * `blocked` prompt still showing for the entire duration of a force
   * retry. That is a real, reachable double-fire surface, and this is the
   * one test in the file that actually exercises the guard: deleting it
   * turns this test red (2 calls become 3); the test above stays green
   * regardless.
   */
  it('a second "Restore anyway" click while the force-retry is in flight fires no extra restore', async () => {
    const calls: Array<{ id: string; force?: boolean }> = [];
    let releaseRetry: ((v: CheckpointRestoreResult) => void) | undefined;
    const { user } = setup(
      renderPanel({
        onRestore: async (id, force) => {
          calls.push({ id, force });
          if (!force) {
            return { restored: false, reason: 'Uncommitted changes would be overwritten.' };
          }
          return new Promise((r) => {
            releaseRetry = r;
          });
        },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Restore workspace' }));
    const retry = await screen.findByRole('button', { name: 'Restore anyway' });

    await user.click(retry);

    // Not native `disabled` — that would drop focus mid-request (the exact
    // F-8 regression `Toggle.tsx` documents) and, incidentally, would also
    // make the second click below unable to reach the handler at all,
    // masking whatever the guard itself does. `aria-disabled` mirrors
    // `Toggle.tsx`'s own "stays focusable, marked non-interactive" posture
    // while leaving the click reachable so the guard below is what's
    // actually proven.
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).not.toBeDisabled();

    await user.click(retry);

    expect(calls).toHaveLength(2); // the refused first attempt + exactly ONE force retry
    releaseRetry?.({ restored: true, filesChanged: 1, changedPaths: [] });
  });

  it('Cancel abandons the restore', async () => {
    const restores: string[] = [];
    const { user } = setup(
      renderPanel({
        onRestore: async (id) => {
          restores.push(id);
          return { restored: true, filesChanged: 1, changedPaths: ['a.txt'] };
        },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(restores).toEqual([]);
    expect(screen.queryByText(/overwrite your working tree/i)).not.toBeInTheDocument();
  });

  it('a successful restore is acknowledged in the UI', async () => {
    const { user } = setup(
      renderPanel({
        onRestore: async () => ({ restored: true, filesChanged: 1, changedPaths: ['a.txt'] }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Restore workspace' }));
    expect(await screen.findByText(/Workspace restored/i)).toBeInTheDocument();
  });

  /**
   * T-C2 (closes audit V-17): the host used to be able to resolve `onRestore`
   * with a bare `undefined` on two refusal paths (no tracker / malformed
   * request) — the panel's `if (result && !result.restored)` sent `undefined`
   * down the ELSE branch, so it rendered "Workspace restored." on a restore
   * that never happened. The host no longer produces `undefined` (T-C2's
   * host half), but the panel stays defensive: `undefined` must NEVER read as
   * success.
   */
  it('T-C2 (closes V-17): onRestore resolving undefined is treated as a failure, never as "Workspace restored"', async () => {
    const { user } = setup(
      renderPanel({
        onRestore: async () => undefined,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Restore workspace' }));

    expect(await screen.findByText(/Restore failed — the host returned no result/i)).toBeInTheDocument();
    expect(screen.queryByText(/Workspace restored/i)).not.toBeInTheDocument();
  });

  /**
   * CF-12 review fix, IMP-3: the tracker fills `skippedPaths` for TWO
   * unrelated causes — the symlink-escape guard AND a per-path I/O failure
   * (ENOSPC/EACCES/EROFS/a since-pruned blob, `CheckpointTracker.ts`
   * ~668-711) — but the panel's copy used to claim "a symlink pointed
   * outside the workspace" for every skipped path regardless of which
   * actually happened. This had NO test before this task (grep
   * `skippedPaths` across every webview test file: 0 hits), so the false
   * claim shipped unverified. The fix drops the specific cause claim; this
   * proves the honest, cause-agnostic copy renders and the paths still list.
   */
  it('the skipped-paths notice uses honest, cause-agnostic copy — never a false "symlink" claim', async () => {
    const { user } = setup(
      renderPanel({
        onRestore: async () => ({
          restored: true,
          filesChanged: 1,
          changedPaths: ['a.txt'],
          skippedPaths: ['b.txt'],
        }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Restore workspace' }));

    expect(await screen.findByText(/1 file could not be updated/i)).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(screen.queryByText(/symlink/i)).not.toBeInTheDocument();
  });
});

/**
 * Tier-2 T-15, F6. `restoringId`/`restored`'s "Restoring…"/"Workspace
 * restored to this checkpoint." spans carried `aria-live="polite"` (and, for
 * the restored span, `role="status"`) directly on themselves — but both
 * spans only ever enter the DOM once their text is already there (`{cond &&
 * <span aria-live>text</span>}`), which is the Finding-7 unreliable-
 * announcement pattern (MDN Live_regions, fetched live for this task:
 * "Start with an empty live region, then – in a separate step – change the
 * content inside the region",
 * https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions).
 * `restoringId`/`restored` are single scalar state (not per-row), so at most
 * one row is ever mid-restore/just-restored at a time — one panel-level,
 * permanently-mounted `LiveRegion` carries the announcement for whichever
 * row that is, same pattern as `Composer.tsx`'s `attachNotice`.
 */
describe('F6: checkpoint restore progress/success is carried by a permanently-mounted LiveRegion', () => {
  it('the status live region is present — and empty — before any restore is requested', () => {
    render(
      renderPanel({
        onRestore: async () => ({ restored: true, filesChanged: 1, changedPaths: ['a.txt'] }),
      }),
    );

    // RED today: neither the "Restoring…" nor the "restored" span exists in
    // the DOM at all yet — no role="status" element to find.
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('');
  });

  it('a successful restore updates the SAME mounted region rather than mounting a fresh one', async () => {
    const { user } = setup(
      renderPanel({
        onRestore: async () => ({ restored: true, filesChanged: 1, changedPaths: ['a.txt'] }),
      }),
    );

    const before = screen.getByRole('status');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(screen.getByRole('button', { name: 'Restore workspace' }));
    const after = await screen.findByText(/Workspace restored to this checkpoint/i);

    // RED today: the success span is a brand-new node conditionally mounted
    // once `restored === cp.id` — not the same node that was present before.
    expect(after).toBe(before);
  });
});

/**
 * CF-12 (W3-T7): the host-side anchored-redo path (`CheckpointRedoState`,
 * `ControlDispatcher.redoCheckpoint`, `CheckpointTracker.redo()`/`.redoAll()`)
 * has existed since W2-F2 Phase 1, but the panel never read `data.redo` (grep
 * `redo` in this file: 0 hits before this task) — so after a mistaken restore
 * there was no UI to recover. `checkpoint.redo`/`checkpoint.redoAll` are
 * host-dispatcher special-cases (`ControlDispatcher.ts`) taking `{force?,
 * rootId?}` over the CORRELATED `control.request` path — no checkpoint `id`,
 * unlike restore: redo/redoAll act on the tracker's own stored cursor/anchor.
 *
 * CF-12 REVIEW FIX (this task): the panel originally fired
 * `checkpoint.redo`/`checkpoint.redoAll` directly over a dynamically-imported
 * `bridge` — the review found that dropped the tab-close cleanup tag AND the
 * `rootId` restore already carries (IMP-2), left the redo notices with no
 * reset when `data.redo` changes under a tab/root switch (IMP-1), and forced
 * a dynamic `import('../bridge')` hazard. The fix wires `onRedo`/`onRedoAll`
 * as CALLBACK PROPS from `App.tsx`, exactly mirroring `onRestore` — so these
 * tests now spy the PROPS, not `bridge.request` directly (App.dom.test.tsx
 * covers the App.tsx wiring itself: rootId + tab tag).
 */
describe('CF-12: Redo/Redo-all render from data.redo and invoke the onRedo/onRedoAll props', () => {
  const defaultRedoResult: CheckpointRestoreResult = { restored: true, filesChanged: 0, changedPaths: [] };

  function redoPanel(
    config: {
      redo?: CheckpointRedoState;
      checkpoints?: Checkpoint[];
      onRedo?: (force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
      onRedoAll?: (force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
    } = {},
  ): ReactElement {
    const data: CheckpointsData = {
      checkpoints: config.checkpoints ?? [checkpoint()],
      redo: config.redo,
    };
    return (
      <CheckpointsPanel
        data={data}
        onRestore={async () => ({ restored: true, filesChanged: 0, changedPaths: [] })}
        onRedo={config.onRedo ?? (async () => defaultRedoResult)}
        onRedoAll={config.onRedoAll ?? (async () => defaultRedoResult)}
      />
    );
  }

  function renderWithRedo(config: Parameters<typeof redoPanel>[0] = {}) {
    return render(redoPanel(config));
  }

  it('renders no Redo controls when data.redo is absent (no dead affordance)', () => {
    renderWithRedo();

    expect(screen.queryByRole('button', { name: 'Redo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redo all' })).not.toBeInTheDocument();
  });

  it('renders Redo and Redo all when data.redo is present, and clicking Redo calls onRedo() (no id, per the host special-case)', async () => {
    const calls: Array<boolean | undefined> = [];
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1', anchorTurnOrdinal: 3 },
      onRedo: async (force) => {
        calls.push(force);
        return defaultRedoResult;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(calls).toEqual([undefined]);
  });

  it('clicking Redo all calls onRedoAll()', async () => {
    const calls: Array<boolean | undefined> = [];
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedoAll: async (force) => {
        calls.push(force);
        return defaultRedoResult;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Redo all' }));

    expect(calls).toEqual([undefined]);
  });

  it('disables both Redo buttons while a request is in flight (honest pending state, no double-fire)', async () => {
    let release: ((v: CheckpointRestoreResult) => void) | undefined;
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: () =>
        new Promise((r) => {
          release = r;
        }),
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo all' })).toBeDisabled();

    release?.({ restored: true, filesChanged: 0, changedPaths: [] });
  });

  it('a refused redo surfaces its reason and a force retry, mirroring the restore block/"anyway" pattern', async () => {
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: async () => ({ restored: false, reason: 'A turn is still running — wait for it to finish.' }),
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(await screen.findByText('A turn is still running — wait for it to finish.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Redo anyway' })).toBeInTheDocument();
  });

  it('a successful redo is acknowledged in the UI', async () => {
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: async () => ({ restored: true, filesChanged: 2, changedPaths: ['a.txt', 'b.txt'] }),
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(await screen.findByText(/redone/i)).toBeInTheDocument();
  });

  it('renders the before/after/anchor phase label for rows that carry a phase (folds Minor m-9)', () => {
    renderWithRedo({
      checkpoints: [
        checkpoint({ id: 'c1', phase: 'before' }),
        checkpoint({ id: 'c2', phase: 'after' }),
        checkpoint({ id: 'c3', phase: 'anchor' }),
      ],
    });

    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(screen.getByText('Anchor')).toBeInTheDocument();
  });

  it('renders no phase label for a legacy row that carries none', () => {
    renderWithRedo({ checkpoints: [checkpoint({ id: 'c-legacy' })] });

    expect(screen.queryByText('Before')).not.toBeInTheDocument();
    expect(screen.queryByText('After')).not.toBeInTheDocument();
    expect(screen.queryByText('Anchor')).not.toBeInTheDocument();
  });

  /**
   * IMP-4 gap #1 (review): the force-retry path — clicking "Redo anyway"
   * after a refusal — was exercised by NOTHING before this task; nothing
   * proved the retry actually re-invokes with `force: true` rather than
   * silently repeating the same (doomed-to-refuse-again) plain call.
   */
  it('IMP-4: clicking "Redo anyway" retries with force: true', async () => {
    const calls: Array<boolean | undefined> = [];
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: async (force) => {
        calls.push(force);
        if (!force) {
          return { restored: false, reason: 'A turn is still running — wait for it to finish.' };
        }
        return { restored: true, filesChanged: 0, changedPaths: [] };
      },
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    const retry = await screen.findByRole('button', { name: 'Redo anyway' });
    await user.click(retry);

    expect(calls).toEqual([undefined, true]);
    expect(await screen.findByText(/redone/i)).toBeInTheDocument();
  });

  /**
   * IMP-4 gap #4 (review): mirrors `CheckpointsPanel.dom.test.tsx`'s restore
   * suite's dedicated double-click guard test (the "a second 'Restore
   * anyway' click..." test above) — the retry button uses `aria-disabled`
   * (not native `disabled`), so unlike the idle "Redo"/"Redo all" buttons it
   * stays REACHABLE to a second click while the retry is in flight, and only
   * `runRedo`'s `if (redoPending !== undefined) return;` guard stops a
   * second fire.
   */
  it('IMP-4: a second "Redo anyway" click while the force-retry is in flight fires no extra redo', async () => {
    const calls: Array<boolean | undefined> = [];
    let releaseRetry: ((v: CheckpointRestoreResult) => void) | undefined;
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: async (force) => {
        calls.push(force);
        if (!force) {
          return { restored: false, reason: 'A turn is still running — wait for it to finish.' };
        }
        return new Promise((r) => {
          releaseRetry = r;
        });
      },
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    const retry = await screen.findByRole('button', { name: 'Redo anyway' });

    await user.click(retry);

    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).not.toBeDisabled();

    await user.click(retry);

    expect(calls).toHaveLength(2); // the refused first attempt + exactly ONE force retry
    releaseRetry?.({ restored: true, filesChanged: 0, changedPaths: [] });
  });

  /**
   * IMP-4 gap #2 (review): nothing before this task rendered `redoSkipped` —
   * a redo result carrying `skippedPaths` never had DOM coverage. Also
   * proves IMP-3's honest, cause-agnostic copy for the redo notice (the
   * tracker fills `skippedPaths` for a symlink escape AND a per-path I/O
   * failure alike — see the restore-side twin test above for the same
   * claim against `CheckpointTracker.ts`).
   */
  it('IMP-4: renders the skipped-paths notice with honest, cause-agnostic copy when the redo result carries skippedPaths', async () => {
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: async () => ({
        restored: true,
        filesChanged: 1,
        changedPaths: ['a.txt'],
        skippedPaths: ['b.txt', 'c.txt'],
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(await screen.findByText(/2 files could not be updated/i)).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(screen.getByText('c.txt')).toBeInTheDocument();
    expect(screen.queryByText(/symlink/i)).not.toBeInTheDocument();
  });

  /**
   * IMP-4 gap #3 (review): mirrors the restore suite's `T-C2 (closes V-17)`
   * test above — `onRedo` resolving a bare `undefined` must never read as a
   * successful "Workspace redone" acknowledgement.
   */
  it('IMP-4 (mirrors T-C2/V-17): onRedo resolving undefined is treated as a failure, never "Workspace redone"', async () => {
    const user = userEvent.setup();
    renderWithRedo({
      redo: { anchorId: 'ckpt-a', cursorId: 'ckpt-1' },
      onRedo: async () => undefined,
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));

    expect(await screen.findByText(/Redo failed — the host returned no result/i)).toBeInTheDocument();
    expect(screen.queryByText(/redone/i)).not.toBeInTheDocument();
  });

  /**
   * IMP-1 (review): the panel is NOT remounted on a tab/root switch — a
   * single mounted instance can be fed a DIFFERENT root's `data.redo` (e.g.
   * the active chat tab switches to one bound to a different workspace
   * root). Before this fix, none of `redoBlocked`/`redoDone`/`redoSkipped`
   * ever reset on that transition, so a stale notice for a redo the user on
   * the NEW root never asked for kept showing. The fix: a `useEffect` keyed
   * on `data.redo`'s identity (`anchorId`+`cursorId`) clears all three
   * (+`redoPending`) whenever that identity changes.
   */
  describe('IMP-1: stale redo state resets when data.redo switches to a different root', () => {
    it('a success notice from one root does not survive a switch to a DIFFERENT root\'s data.redo', async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithRedo({ redo: { anchorId: 'root-x-anchor', cursorId: 'root-x-cursor' } });

      await user.click(screen.getByRole('button', { name: 'Redo' }));
      expect(await screen.findByText(/redone/i)).toBeInTheDocument();

      rerender(redoPanel({ redo: { anchorId: 'root-y-anchor', cursorId: 'root-y-cursor' } }));

      expect(screen.queryByText(/redone/i)).not.toBeInTheDocument();
    });

    it('a blocked-redo refusal notice from one root does not survive a switch to a DIFFERENT root\'s data.redo', async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithRedo({
        redo: { anchorId: 'root-x-anchor', cursorId: 'root-x-cursor' },
        onRedo: async () => ({ restored: false, reason: 'A turn is still running — wait for it to finish.' }),
      });

      await user.click(screen.getByRole('button', { name: 'Redo' }));
      expect(await screen.findByText('A turn is still running — wait for it to finish.')).toBeInTheDocument();

      rerender(redoPanel({ redo: { anchorId: 'root-y-anchor', cursorId: 'root-y-cursor' } }));

      expect(screen.queryByText('A turn is still running — wait for it to finish.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Redo anyway' })).not.toBeInTheDocument();
    });

    it('a skipped-paths notice from one root does not survive a switch to a DIFFERENT root\'s data.redo', async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithRedo({
        redo: { anchorId: 'root-x-anchor', cursorId: 'root-x-cursor' },
        onRedo: async () => ({
          restored: true,
          filesChanged: 1,
          changedPaths: ['a.txt'],
          skippedPaths: ['b.txt'],
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Redo' }));
      expect(await screen.findByText(/could not be updated/i)).toBeInTheDocument();

      rerender(redoPanel({ redo: { anchorId: 'root-y-anchor', cursorId: 'root-y-cursor' } }));

      expect(screen.queryByText(/could not be updated/i)).not.toBeInTheDocument();
    });

    it('the in-flight pending lock from one root does not survive a switch to a DIFFERENT root\'s data.redo', async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithRedo({
        redo: { anchorId: 'root-x-anchor', cursorId: 'root-x-cursor' },
        onRedo: () => new Promise<CheckpointRestoreResult>(() => {}), // never resolves
      });

      await user.click(screen.getByRole('button', { name: 'Redo' }));
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();

      rerender(redoPanel({ redo: { anchorId: 'root-y-anchor', cursorId: 'root-y-cursor' } }));

      expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled();
    });
  });
});
