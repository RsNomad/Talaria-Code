import { SessionController } from './SessionController';
import type { SessionHostPort } from './types';

/**
 * W4-T1a Deliverable 3 — `Map<sessionId, SessionController>` + the small,
 * pure lifecycle API `AcpBackend` (the router) drives it through. Headless
 * (no `vscode` import), independently unit-testable.
 */
export class SessionRegistry {
  private readonly controllers = new Map<string, SessionController>();

  /**
   * CA-M04b: optional per-session teardown hook — fired synchronously with
   * the closing session's id at EVERY `close(sessionId)` entry
   * (UNCONDITIONALLY — including a no-op close of an id this registry no
   * longer holds, preserving the unconditional semantics of the explicit
   * `AcpBackend.closeTabInternal` prune this replaces) and, per
   * formerly-registered id, after `disposeAll()`'s dispose loop.
   * Deliberately NOT fired by `open()`'s W6-FB same-sessionId collision
   * branch: that path REBINDS the id to a fresh controller — the id stays
   * live, and per-id ancillary state keyed on it (`ControlDispatcher
   * .panelFetchSeq`'s T-12 staleness tokens) must survive the re-mint.
   * Contract: the hook is cheap, never throws, never re-enters this
   * registry. Single writer: `ControlDispatcher`'s constructor.
   */
  private onClosed: ((sessionId: string) => void) | undefined = undefined;

  setOnClosed(hook: (sessionId: string) => void): void {
    this.onClosed = hook;
  }

  /**
   * Mint and register a new controller for `sessionId`, owned by `tabId`
   * (W4-T5a deliverable 1 — omit to default to `BOOTSTRAP_TAB_ID`, keeping
   * every pre-T5a single-tab caller unchanged).
   *
   * W6-FB (3-way CODE Important — same `sessionId` loaded into two
   * DIFFERENT tabs leaks a controller + mis-routes): enforces "at most one
   * live controller per `sessionId`" AT THE REGISTRY — the single choke
   * point every `open()` caller mints through (`openSession`,
   * `recoverOneSession`, `loadSessionIntoTab`), so the invariant holds no
   * matter which one collides, with no caller-side duplication. Mirrors
   * `close`'s own F6 remove-before-dispose choreography verbatim:
   * any controller ALREADY registered under this exact `sessionId` is removed
   * from the map FIRST, synchronously, THEN disposed — BEFORE the new
   * controller is minted and takes its slot. `dispose()` clears the stale
   * controller's `replay` (no-emit) and settles its pendingApprovals/turn,
   * so a belated in-flight `loadReplayOutcome` call on it trips ITS OWN `this.replay
   * !== replay` supersede-guard the instant it resumes — the exact
   * mechanism the same-TAB C1 fix already relies on (`AcpBackend
   * .loadSessionIntoTab`'s doc), now also covering the same-SESSION-
   * different-TAB case. `openSession` mints a FRESH, server-assigned
   * `sessionId` every call, so `existing` is always `undefined` on that
   * path — this is purely ADDITIVE (behavior-preserving) there.
   */
  open(sessionId: string, cwd: string, port: SessionHostPort, tabId?: string): SessionController {
    const existing = this.controllers.get(sessionId);
    if (existing) {
      this.controllers.delete(sessionId);
      existing.dispose();
    }
    const controller = new SessionController(sessionId, cwd, port, tabId);
    this.controllers.set(sessionId, controller);
    return controller;
  }

  get(sessionId: string): SessionController | undefined {
    return this.controllers.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /**
   * W4-T5a deliverable 1: the controller currently bound to `tabId`, or
   * `undefined` for a tabId nothing is registered under (a still-unbound
   * tab, or one this registry has never seen). Linear scan — bounded by
   * `MAX_TABS` (8), so a per-lookup scan is cheaper than maintaining a
   * second, always-in-sync `tabId -> sessionId` index.
   */
  getByTabId(tabId: string): SessionController | undefined {
    for (const controller of this.controllers.values()) {
      if (controller.tabId === tabId) return controller;
    }
    return undefined;
  }

  /** Every registered sessionId (crash fan-out / bulk iteration). */
  ids(): IterableIterator<string> {
    return this.controllers.keys();
  }

  /** Every registered controller (crash fan-out / bulk iteration). */
  values(): IterableIterator<SessionController> {
    return this.controllers.values();
  }

  get size(): number {
    return this.controllers.size;
  }

  /**
   * F6 (data-safety / fail-closed): remove `sessionId` from the map FIRST,
   * synchronously, THEN dispose its controller — a `request_permission`
   * racing this call can never find a controller mid-teardown; by the time
   * `dispose()` runs (settling ITS approvals as cancelled), a router lookup
   * for this id already returns `undefined`. A no-op if `sessionId` isn't
   * registered.
   */
  close(sessionId: string): void {
    this.onClosed?.(sessionId); // CA-M04b: unconditional — see the hook's doc
    const controller = this.controllers.get(sessionId);
    if (!controller) return;
    this.controllers.delete(sessionId);
    controller.dispose();
  }

  /**
   * F6, bulk form: remove EVERY controller from the map before disposing
   * any of them (an even stronger form of the same remove-before-settle
   * guarantee `close` gives one controller). Used by `AcpBackend`'s
   * connection-level teardown (`teardownSession`/`dispose`).
   */
  disposeAll(): void {
    const all = [...this.controllers.values()];
    this.controllers.clear();
    for (const controller of all) controller.dispose();
    for (const controller of all) this.onClosed?.(controller.sessionId); // CA-M04b: per formerly-registered id
  }
}
