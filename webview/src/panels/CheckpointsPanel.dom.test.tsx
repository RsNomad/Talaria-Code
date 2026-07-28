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
import type { Checkpoint, CheckpointRestoreResult, CheckpointsData } from '../protocol';
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

function renderPanel(config: {
  onRestore: (id: string, force?: boolean) => Promise<CheckpointRestoreResult | undefined>;
}) {
  const data: CheckpointsData = { checkpoints: [checkpoint()] };
  return <CheckpointsPanel data={data} onRestore={config.onRestore} />;
}

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
