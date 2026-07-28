/**
 * nextedit/fsm.ts — Job B Task 10 · the pure next-edit state-machine reducer.
 *
 * Source-agnostic: the FSM never knows whether a proposal came from NEXT or
 * Generic (`08-jobB-final-architecture.md` §7.6). Pure: same input ⇒ same
 * output, no side effects, no `Date.now()`/randomness, no `vscode` import —
 * the shell (a later task) is the one thing allowed to execute the effects
 * this function returns.
 *
 * There is deliberately **no `timeout` event** — no product expires a
 * proposal on a wall clock; the vendor lifetime enum is
 * `Accepted|Rejected|Ignored`, no `Timeout` (`08` §7.6, `02` §2.1). There is
 * deliberately **no suppression/cool-down state** — `esc` is exactly
 * `idle + clearAll` and nothing else (`08` §7.6, `02` §2.2).
 *
 * `fimVisibility` is a first-class input (R2, `08` §7.2): FIM always wins —
 * `fimVisibility(true)` clears next-edit from ANY state, never the reverse.
 * `fimVisibility(false)` never disturbs a live proposal.
 *
 * The deleted wall-clock timer is replaced by a strictly stronger invariant,
 * proved exhaustively in `fsm.test.ts`: after every effect batch the
 * `hermes.nextEdit.jumpVisible` context key and the decorations are never
 * left half-set — either both up (`proposed`/`jumped`) or both down
 * (`idle`). Every transition NOT named in the table below (an "unmodeled
 * combination") falls through to the same safe default: `idle + clearAll`.
 */
import type {
  NextEditFsmState,
  NextEditFsmEvent,
  NextEditEffect,
  AnchoredProposal,
  EditableRegion,
  LineRange,
} from './types';

const CLEAR_ALL: NextEditEffect = { kind: 'clearAll' };
const IDLE: NextEditFsmState = { kind: 'idle' };

function cleared(effects: readonly NextEditEffect[] = [CLEAR_ALL]): { state: NextEditFsmState; effects: readonly NextEditEffect[] } {
  return { state: IDLE, effects };
}

/**
 * Re-anchors `p` at `remapped` — only the region's line span moves; every
 * other field (including `region.content`, which the shell re-supplies on
 * the NEXT `proposalReady`, not mid-flight) is carried over unchanged.
 * Field-by-field construction, no object-spread-with-override (the
 * `ringBuffer.test.ts` brand-preserving-spread guard's shape).
 */
function reanchor(p: AnchoredProposal, remapped: LineRange): AnchoredProposal {
  const region: EditableRegion = {
    uri: p.region.uri,
    filepath: p.region.filepath,
    startLine: remapped.startLine,
    endLine: remapped.endLine,
    content: p.region.content,
  };
  return { region, newText: p.newText, docVersion: p.docVersion, cursorLine: p.cursorLine };
}

export function reduceNextEdit(
  s: NextEditFsmState,
  e: NextEditFsmEvent,
): { state: NextEditFsmState; effects: readonly NextEditEffect[] } {
  // --- ANY-state rows (order-independent — none of these event shapes
  // overlaps another event kind, so checking them ahead of the per-state
  // switch is equivalent to guarding every state arm individually). ---

  // fimVisibility(false): never disturbs anything, from any state.
  if (e.kind === 'fimVisibility' && !e.visible) {
    return { state: s, effects: [] };
  }
  // fimVisibility(true): FIM always wins (R2) — clears from any state.
  if (e.kind === 'fimVisibility' && e.visible) {
    return cleared();
  }
  if (e.kind === 'focusLost' || e.kind === 'editorChanged') {
    return cleared();
  }
  if (e.kind === 'docChanged' && e.remapped === null) {
    return cleared();
  }
  if (e.kind === 'applyResult' && !e.ok) {
    return cleared([CLEAR_ALL, { kind: 'noteOnce', msgId: 'apply-failed' }]);
  }
  // esc: exactly idle + clearAll, from any state — no suppression, no
  // cool-down (`08` §7.6). Also covers idle×esc (unmodeled ⇒ safe default,
  // which happens to coincide with this same clause).
  if (e.kind === 'esc') {
    return cleared();
  }

  switch (s.kind) {
    case 'idle': {
      if (e.kind === 'proposalReady') {
        return {
          state: { kind: 'proposed', p: e.p },
          effects: [
            { kind: 'setContext', key: 'hermes.nextEdit.jumpVisible', value: true },
            { kind: 'showDecorations', p: e.p },
          ],
        };
      }
      if (e.kind === 'applyResult' /* && e.ok, the !ok case already handled above */) {
        return { state: IDLE, effects: [] };
      }
      // unmodeled in idle (tabJump, tabAccept, docChanged(non-null)): safe default.
      return cleared();
    }
    case 'proposed': {
      if (e.kind === 'tabJump') {
        return {
          state: { kind: 'jumped', p: s.p },
          effects: [
            { kind: 'setContext', key: 'hermes.nextEdit.jumped', value: true },
            { kind: 'reveal', range: { startLine: s.p.region.startLine, endLine: s.p.region.endLine } },
          ],
        };
      }
      if (e.kind === 'docChanged' && e.remapped !== null) {
        const p = reanchor(s.p, e.remapped);
        return { state: { kind: 'proposed', p }, effects: [{ kind: 'showDecorations', p }] };
      }
      // unmodeled in proposed (proposalReady, tabAccept, applyResult(ok:true)): safe default.
      return cleared();
    }
    case 'jumped': {
      if (e.kind === 'tabAccept') {
        return {
          state: IDLE,
          effects: [{ kind: 'applyEdit', region: s.p.region, newText: s.p.newText }, CLEAR_ALL],
        };
      }
      if (e.kind === 'docChanged' && e.remapped !== null) {
        const p = reanchor(s.p, e.remapped);
        return { state: { kind: 'jumped', p }, effects: [{ kind: 'showDecorations', p }] };
      }
      // unmodeled in jumped (proposalReady, tabJump, applyResult(ok:true)): safe default.
      return cleared();
    }
  }
}
