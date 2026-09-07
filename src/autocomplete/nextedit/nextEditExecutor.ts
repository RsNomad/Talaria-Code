/**
 * nextedit/nextEditExecutor.ts — WS-F3 F3-5 (FI-06): the effect-executor —
 * the FSM's effect sink — moved out of `shell.vscode.ts` VERBATIM (bodies +
 * doc comments), fourth of the `text/route/egress/executor/relay/
 * failureSurface/wiring` module map (ADR-FSU-08).
 *
 * REUSE MODULE, per `reuseLocks.test.ts`'s own named-list idiom (mirroring
 * `nextEditRoute.ts`'s/`nextEditEgress.ts`'s headers): a NEW leaf under
 * `nextedit/` that is not `*.vscode.ts` and not `*.test.ts`, so it is
 * discovered by both `reuseLocks.test.ts`'s network-call guard sweep and
 * `nextEditPurity.test.ts`'s pure/headless-boundary sweep. Named here — not
 * merely counted — for the same reason those locks name every file they
 * touch: it was looked at, and it is clean.
 *
 * VSCODE-FREE — NOT in `nextEditPurity.test.ts`'s `ADAPTER_ALLOW` (locked at
 * exactly 4 files: `config.ts`, `guard.ts`, `shell.vscode.ts`,
 * `nextEditNotice.vscode.ts`): this module never imports the `vscode`
 * package itself, in any form — not even `import type`. `NextEditExecutorHost`
 * below is the seam that keeps it that way: every method reads/returns only
 * LOCAL types (`NextEditContextKey`, or `AnchoredProposal`/`LineRange`/
 * `EditableRegion`/`ApplyExpectation` imported from `./types`), never a
 * `vscode.*` shape — the shell's own real host implementation (still in
 * `shell.vscode.ts`, unmoved) satisfies this port structurally.
 *
 * `makeExecutor` consumes already-reduced `NextEditEffect[]` batches — it
 * never calls `reduceNextEdit` itself, so this module does NOT import `./fsm`.
 * Its `noteOnce` effect carries only the raw `msgId` string to `host.note`;
 * the msgId → user-facing copy lookup (`NOTE_MESSAGES`) stays in
 * `shell.vscode.ts`, because its only reader is the shell CLASS's
 * vscode-bound `note:` host-implementation property (it calls
 * `vscode.window.showWarningMessage`) — the executor never touches that
 * table.
 *
 * `shell.vscode.ts` replaces the four moved bodies with
 * `import { makeExecutor, type NextEditContextKey, type NextEditExecutorHost, type NextEditExecutor } from './nextEditExecutor';`
 * plus `export { makeExecutor }; export type { NextEditContextKey, NextEditExecutorHost, NextEditExecutor };`
 * — a re-export per ADR-FSU-01's mechanics, so the shell's own export
 * surface (and `shell.vscode.test.ts`'s `import { makeExecutor, type
 * NextEditExecutorHost } from './shell.vscode'`) keeps resolving through
 * `./shell.vscode` with zero further edits.
 *
 * This module makes no network call of any kind and never spells the banned
 * network-call token, not even in a comment — `reuseLocks.test.ts`'s raw-
 * content sanity scan confirms that byte-for-byte on every run.
 */
import type { AnchoredProposal, ApplyExpectation, EditableRegion, LineRange, NextEditEffect } from './types';

/** The two context keys the executor owns — it is their ONLY writer. */
export type NextEditContextKey = 'talaria.nextEdit.jumpVisible' | 'talaria.nextEdit.jumped';

// ─────────────────────────────── the executor ────────────────────────────────

/**
 * The executor's host port. Every effect the FSM can emit lands on exactly
 * one method here, so the executor's own logic (ordering, the forced
 * clear-all, the jumped-locator re-render, the noteOnce dedup) is testable
 * against a mock host with no editor in sight.
 */
export interface NextEditExecutorHost {
  setContext(key: NextEditContextKey, value: boolean): void;
  /**
   * `jumped` selects the locator's verb — `Tab to jump` vs `Tab to accept`.
   *
   * Returns whether the paint actually reached the screen. F-1: a host whose
   * editor is gone (or is no longer the one this proposal belongs to) DECLINES
   * rather than painting, and a declined paint must clear the pair — see
   * property 1 below. A `void` return let a silent early return leave
   * `jumpVisible` up with nothing on screen.
   */
  showDecorations(p: AnchoredProposal, jumped: boolean): boolean;
  clearDecorations(): void;
  reveal(range: LineRange): void;
  /**
   * BHF-F3-15: `expected` is the dispatch-time freshness snapshot (see
   * `dispatch()`); the host MUST re-validate document.version and the
   * region's base text against it immediately before the WorkspaceEdit and
   * resolve `false` on ANY mismatch — that `false` is the FSM's
   * `applyResult` and routes to the existing dismiss+note path. `null`
   * (no live proposal at dispatch) MUST also resolve `false`.
   */
  applyEdit(region: EditableRegion, newText: string, expected: ApplyExpectation | null): Promise<boolean>;
  note(msgId: string): void;
}

export interface NextEditExecutor {
  run(effects: readonly NextEditEffect[]): void;
}

/**
 * Executes one FSM effect batch.
 *
 * Three properties this function owns, none of which the FSM can enforce on
 * its own because they are about the SIDE of the boundary where things can
 * fail:
 *
 *  1. **The invariant that replaced the deleted wall-clock timeout**: after
 *     every batch, `talaria.nextEdit.jumpVisible` is up if and only if
 *     decorations are on screen. The FSM guarantees the batches are
 *     well-formed; this function guarantees a THROWING host cannot leave the
 *     pair half-set — any exception mid-batch forces a full `clearAll`. A
 *     stuck `jumpVisible` with nothing on screen would silently steal Tab.
 *     F-1 closed the other half of that guarantee: a host that DECLINES to
 *     paint (returns `false` — a silent early return, not a throw) used to
 *     walk straight through the exception guard, which is precisely the
 *     failure this property names. A declined paint now forces the same
 *     `clearAll`, so the invariant holds for both failure shapes.
 *  2. **The jumped locator re-render**: `reduceNextEdit`'s `proposed×tabJump`
 *     batch is `[setContext jumped, reveal]` — deliberately no
 *     `showDecorations`, because the PROPOSAL did not change, only its
 *     presentation. The executor therefore re-renders the locator itself when
 *     the `jumped` key flips while a proposal is on screen.
 *  3. **`noteOnce` is once**: deduped per msgId for the life of the executor.
 *     (Distinct from the Guard's refusal alerts, which deliberately re-fire —
 *     a refusal answers a fresh user gesture, a note reports a condition.)
 *
 * NO TIMER anywhere in here: no proposal expires on a wall clock (`08` §7.6 —
 * the vendor lifetime enum is Accepted|Rejected|Ignored, there is no Timeout).
 */
export function makeExecutor(
  host: NextEditExecutorHost,
  onApplyResult: (ok: boolean) => void,
  /** BHF-F3-15 — read synchronously when an `applyEdit` effect executes;
   *  REQUIRED so forgetting it is a compile error, not a silent fail-open. */
  getApplyExpectation: () => ApplyExpectation | null,
): NextEditExecutor {
  let shownProposal: AnchoredProposal | null = null;
  let jumped = false;
  const noted = new Set<string>();

  function clearAll(): void {
    host.setContext('talaria.nextEdit.jumpVisible', false);
    host.setContext('talaria.nextEdit.jumped', false);
    host.clearDecorations();
    shownProposal = null;
    jumped = false;
  }

  function applyOne(effect: NextEditEffect): void {
    switch (effect.kind) {
      case 'setContext': {
        host.setContext(effect.key, effect.value);
        if (effect.key === 'talaria.nextEdit.jumped') {
          jumped = effect.value;
          // Property 2 above — re-render the locator's verb in place.
          if (shownProposal !== null && !host.showDecorations(shownProposal, jumped)) {
            clearAll();
          }
        }
        return;
      }
      case 'showDecorations': {
        if (!host.showDecorations(effect.p, jumped)) {
          // F-1: the paint was declined, so there is nothing on screen. Taking
          // the batch's `jumpVisible = true` at face value here is exactly the
          // stuck-context-key failure property 1 forbids.
          clearAll();
          return;
        }
        shownProposal = effect.p;
        return;
      }
      case 'reveal': {
        host.reveal(effect.range);
        return;
      }
      case 'applyEdit': {
        // The boolean comes back as the FSM's `applyResult` event. A REJECTED
        // `applyEdit` is reported as `false` (fail-closed: dismiss + note),
        // never left as an unhandled rejection. BHF-F3-15: the expectation is
        // read HERE, synchronously within this run — a later dispatch
        // overwriting the shell's snapshot cannot affect an apply already
        // dispatched.
        void host.applyEdit(effect.region, effect.newText, getApplyExpectation()).then(
          (ok) => onApplyResult(ok),
          () => onApplyResult(false),
        );
        return;
      }
      case 'clearAll': {
        clearAll();
        return;
      }
      case 'noteOnce': {
        if (noted.has(effect.msgId)) return;
        noted.add(effect.msgId);
        host.note(effect.msgId);
        return;
      }
    }
  }

  return {
    run(effects: readonly NextEditEffect[]): void {
      try {
        for (const effect of effects) {
          applyOne(effect);
        }
      } catch {
        // Property 1 above. `clearAll` itself touching a broken host would
        // throw out of `run`, which is the honest outcome — there is nothing
        // left to fall back to, and swallowing it would hide a dead executor.
        clearAll();
      }
    },
  };
}
