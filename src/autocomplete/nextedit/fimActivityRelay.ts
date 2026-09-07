/**
 * nextedit/fimActivityRelay.ts — WS-F3 F3-6 (FI-06): the FIM-activity relay
 * moved out of `shell.vscode.ts` VERBATIM (bodies + doc comments), fifth of
 * the `text/route/egress/executor/relay/failureSurface/wiring` module map
 * (ADR-FSU-08).
 *
 * REUSE MODULE, per `reuseLocks.test.ts`'s own named-list idiom (mirroring
 * `nextEditExecutor.ts`'s/`nextEditRoute.ts`'s/`nextEditEgress.ts`'s
 * headers): a NEW leaf under `nextedit/` that is not `*.vscode.ts` and not
 * `*.test.ts`, so it is discovered by both `reuseLocks.test.ts`'s
 * network-call guard sweep and `nextEditPurity.test.ts`'s pure/headless-
 * boundary sweep. Named here — not merely counted — for the same reason
 * those locks name every file they touch: it was looked at, and it is
 * clean.
 *
 * VSCODE-FREE — NOT in `nextEditPurity.test.ts`'s `ADAPTER_ALLOW` (locked at
 * exactly 4 files: `config.ts`, `guard.ts`, `shell.vscode.ts`,
 * `nextEditNotice.vscode.ts`): this module never imports the `vscode`
 * package itself, in any form — not even `import type`. `import type {
 * FimActivityListener } from '../provider'` does NOT trip the ban (it
 * matches only the exact `'vscode'` specifier), and `FimActivityListener`
 * itself is a plain 4-callback shape with no `vscode.*` type in it.
 *
 * The module-level `currentFimActivity` slot is KEPT BY DESIGN — it is the
 * fixed forwarding address that decouples `provider.ts` from the shell's
 * swappable listener (see `fimActivityRelay`'s own doc below), and it is
 * FI-26's future home (task F10-2). This move only relocates it, unchanged,
 * into a module of its own; nothing about its lifecycle or ownership
 * changes.
 *
 * `shell.vscode.ts` replaces the moved bodies with
 * `import { fimActivityRelay, attachFimActivity, detachFimActivity } from './fimActivityRelay';`
 * plus `export { fimActivityRelay };` — a re-export per ADR-FSU-01's
 * mechanics, so the shell's own export surface (and `provider.ts`'s /
 * `index.ts`'s `import { fimActivityRelay, ... } from './nextedit/shell.vscode'`,
 * plus `shell.vscode.test.ts`'s and `nextedit.golden.shell.test.ts`'s own
 * `import { fimActivityRelay, ... } from './shell.vscode'`) keep resolving
 * through `./shell.vscode` with zero further edits.
 */
import type { FimActivityListener } from '../provider';

// ──────────────────────────────── the FIM seam ───────────────────────────────

const NO_OP_FIM_ACTIVITY: FimActivityListener = {
  requestStarted: () => {},
  resultShown: () => {},
  accepted: () => {},
  acceptCommandId: () => undefined,
};

let currentFimActivity: FimActivityListener = NO_OP_FIM_ACTIVITY;

/**
 * The stable object `index.ts` hands to `TalariaInlineCompletionProvider`.
 *
 * Composition-order problem it solves: the provider is constructed by
 * `registerTalariaAutocomplete`, the listener's real implementation by
 * `registerTalariaNextEdit`, and neither can hold the other's result at
 * construction time — while `registerTalariaNextEdit`'s signature is pinned to
 * return a bare `Disposable`. This relay is a fixed forwarding address: it is
 * a no-op until the shell attaches (so a build with next-edit unregistered
 * behaves exactly as before), and reverts to a no-op on dispose.
 *
 * Observation-only in BOTH directions of the R2 rule: FIM tells next-edit
 * what it is doing; next-edit holds no handle that could cancel FIM.
 */
export const fimActivityRelay: FimActivityListener = {
  requestStarted: () => currentFimActivity.requestStarted(),
  resultShown: (hasItem: boolean) => currentFimActivity.resultShown(hasItem),
  accepted: () => currentFimActivity.accepted(),
  // Forwarded, never answered here: the relay must report what the CURRENTLY
  // attached registration has registered — `undefined` while none is.
  acceptCommandId: () => currentFimActivity.acceptCommandId(),
};

/** ATTACH — point the relay at this registration's listener. (Was the shell's
 *  `currentFimActivity = this.fimActivity` at the attach-last site.) */
export function attachFimActivity(listener: FimActivityListener): void {
  currentFimActivity = listener;
}

/** DETACH — return the relay to the no-op ONLY if `listener` is still the
 *  current one. A registration that was already replaced must NOT point the
 *  relay back at the no-op (it belongs to the newer registration now). (Was the
 *  shell's `if (currentFimActivity === this.fimActivity) currentFimActivity = NO_OP_FIM_ACTIVITY`.)
 *
 *  BF-B's liveness idiom (`SessionController.ts`'s `disposed` re-check),
 *  applied to a MODULE-level slot: clear the relay only while THIS
 *  registration still owns it. Disposing a registration that a newer one
 *  already replaced must not point the relay back at the no-op — that would
 *  silently disarm R2 for the shell that is actually live.
 */
export function detachFimActivity(listener: FimActivityListener): void {
  if (currentFimActivity === listener) {
    currentFimActivity = NO_OP_FIM_ACTIVITY;
  }
}
