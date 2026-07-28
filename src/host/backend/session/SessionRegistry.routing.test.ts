import { describe, it, expect } from 'vitest';
import { SessionRegistry } from './SessionRegistry';
import type { SessionHostPort } from './types';
import { RootCoordinator } from '../../checkpoints/RootCoordinator';
import type { AcpClientLike, AcpLoadSessionResult } from '../acp/acpClient';
import type { AcpRequestPermissionRequest, AcpRequestPermissionResponse, AcpSessionUpdate } from '../acp/types';
import type { HostToWebviewMessage } from '../../../shared/protocol';
import { BOOTSTRAP_TAB_ID } from '../../../shared/protocol';

/**
 * W4-T1a headless isolation tests (the brief's gate section) — TWO
 * controllers with distinct sessionIds, driven through the SAME dispatch
 * PATTERN `AcpBackend`'s router uses (`registry.get(sessionId)?.method(...)`
 * with a fail-closed/drop-unknown fallback), proving the extraction's
 * isolation properties without needing the real vscode-facing `AcpBackend`.
 */

class FakeAcpClient implements AcpClientLike {
  async connect(): Promise<void> {}
  async initialize(): Promise<void> {}
  async newSession(): Promise<{ sessionId: string; currentModeId: string }> {
    return { sessionId: 'unused', currentModeId: 'default' };
  }
  async prompt(): Promise<{ stopReason: string }> {
    return { stopReason: 'end_turn' };
  }
  async cancel(): Promise<void> {}
  async setSessionMode(): Promise<void> {}
  async setSessionModel(): Promise<void> {}
  async listSessions(): Promise<{ sessions: never[] }> {
    return { sessions: [] };
  }
  async loadSession(): Promise<AcpLoadSessionResult> {
    return { found: true, currentModeId: 'default' };
  }
  onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  dispose(): void {}
}

function makePort(emitted: HostToWebviewMessage[]): SessionHostPort {
  const client = new FakeAcpClient();
  return {
    getClient: () => client,
    emit: (msg) => emitted.push(msg),
    emitSystemError: (message, detail) => emitted.push({ type: 'system.error', message, detail }),
    root: new RootCoordinator('/ws', undefined),
    workspaceRoots: () => [],
    refreshCheckpointsPanel: () => undefined,
    resolveMentions: async () => [],
  };
}

/** Mirrors `AcpBackend.handleSessionUpdate`'s registry-lookup half exactly. */
function routeUpdate(registry: SessionRegistry, sessionId: string, update: AcpSessionUpdate, logs: string[]): void {
  const controller = registry.get(sessionId);
  if (!controller) {
    logs.push(`[router] session/update for unknown session '${sessionId}' — dropped`);
    return;
  }
  controller.applyUpdate(update);
}

/** Mirrors `AcpBackend.handleRequestPermission`'s (a)/(c) branches (T1a: no ephemeral registry here). */
async function routePermission(
  registry: SessionRegistry,
  req: AcpRequestPermissionRequest,
  approvalId: string,
  logs: string[],
): Promise<AcpRequestPermissionResponse> {
  const controller = registry.get(req.sessionId);
  if (controller) return controller.handlePermission(req, approvalId);
  logs.push(`[policy] permission request on unrecognized session '${req.sessionId}' — auto-denied (fail-closed)`);
  return { outcome: { outcome: 'cancelled' } };
}

/** A minimal empty-path `edit` permission request — under the default 'manual'
 * preset this always lands on F1's ask-card path (no fs/canonicalization). */
function makeEditReq(sessionId: string, toolCallId: string): AcpRequestPermissionRequest {
  return {
    sessionId,
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ],
    toolCall: { toolCallId, title: 'Approve edit', kind: 'edit' },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('W4-T1a — SessionController/SessionRegistry isolation (headless, fake port)', () => {
  it('(a) applyUpdate routing isolation: an update for session B never mutates session A fold/emit', () => {
    const registry = new SessionRegistry();
    const emittedA: HostToWebviewMessage[] = [];
    const emittedB: HostToWebviewMessage[] = [];
    const a = registry.open('session-a', '/ws', makePort(emittedA));
    const b = registry.open('session-b', '/ws', makePort(emittedB));
    const logs: string[] = [];

    routeUpdate(registry, 'session-b', { sessionUpdate: 'available_commands_update', availableCommands: [] }, logs);

    expect(emittedB).toEqual([{ type: 'commands.available', sessionId: 'session-b', commands: [] }]);
    expect(emittedA).toEqual([]); // session A's emit stream is untouched
    expect(b.getAvailableCommands()).toEqual([]);
    expect(a.getAvailableCommands()).toBeUndefined(); // session A's fold is untouched
  });

  it('(b) dispose isolation: disposing session B settles only B approvals — A stays live and unresolved', async () => {
    const registry = new SessionRegistry();
    const emittedA: HostToWebviewMessage[] = [];
    const emittedB: HostToWebviewMessage[] = [];
    registry.open('session-a', '/ws', makePort(emittedA));
    registry.open('session-b', '/ws', makePort(emittedB));
    const logs: string[] = [];

    const pendingA = routePermission(registry, makeEditReq('session-a', 'tc-a'), 'appr-a', logs);
    const pendingB = routePermission(registry, makeEditReq('session-b', 'tc-b'), 'appr-b', logs);
    await flush(); // let both reach the ask-card path (pendingApprovals populated)

    registry.close('session-b');

    const outcomeB = await pendingB;
    expect(outcomeB).toEqual({ outcome: { outcome: 'cancelled' } }); // B settled cancelled by dispose

    // A's controller is still registered and its approval is still UNSETTLED —
    // resolve it manually to prove dispose(B) never touched it.
    expect(registry.has('session-a')).toBe(true);
    expect(registry.has('session-b')).toBe(false);
    let settledA = false;
    void pendingA.then(() => {
      settledA = true;
    });
    await flush();
    expect(settledA).toBe(false); // still pending — untouched by B's dispose
    registry.get('session-a')?.respondApproval('appr-a', 'allow_once');
    const outcomeA = await pendingA;
    expect(outcomeA).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });

  it('(c) drop-unknown: a session/update for an unregistered sessionId is dropped (dev-log), throws nothing', () => {
    const registry = new SessionRegistry();
    const logs: string[] = [];

    expect(() =>
      routeUpdate(registry, 'ghost-session', { sessionUpdate: 'available_commands_update', availableCommands: [] }, logs),
    ).not.toThrow();

    expect(logs.some((l) => l.includes('ghost-session'))).toBe(true);
  });

  it('(d) F6: handlePermission arriving after the controller is removed-from-map hits the fail-closed path, not the live controller', async () => {
    const registry = new SessionRegistry();
    const emitted: HostToWebviewMessage[] = [];
    registry.open('session-a', '/ws', makePort(emitted));

    registry.close('session-a'); // F6: remove-from-map FIRST, then dispose/settle

    const logs: string[] = [];
    const outcome = await routePermission(registry, makeEditReq('session-a', 'tc-a'), 'appr-late', logs);

    expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } }); // fail-closed deny, not a card
    expect(logs.some((l) => l.includes('unrecognized session'))).toBe(true);
    expect(registry.has('session-a')).toBe(false);
    expect(emitted).toEqual([]); // no approval.request card was ever emitted for the late request
  });

  it('(e) W4-T5a deliverable 1: open() stamps the given tabId onto the controller, readable back via getByTabId', () => {
    const registry = new SessionRegistry();
    const controller = registry.open('session-a', '/ws', makePort([]), 'tab-2');

    expect(controller.tabId).toBe('tab-2');
    expect(registry.getByTabId('tab-2')).toBe(controller);
  });

  it('(f) W4-T5a deliverable 1: open() defaults tabId to BOOTSTRAP_TAB_ID when omitted (back-compat for existing single-tab callers)', () => {
    const registry = new SessionRegistry();
    const controller = registry.open('session-a', '/ws', makePort([]));

    expect(controller.tabId).toBe(BOOTSTRAP_TAB_ID);
    expect(registry.getByTabId(BOOTSTRAP_TAB_ID)).toBe(controller);
  });

  it('(g) getByTabId returns undefined for a tabId nothing is registered under', () => {
    const registry = new SessionRegistry();
    registry.open('session-a', '/ws', makePort([]), 'tab-1');

    expect(registry.getByTabId('tab-unknown')).toBeUndefined();
  });

  /**
   * W6-FB (3-way CODE Important — same `sessionId` loaded into two DIFFERENT
   * tabs leaks a controller + mis-routes): `open()` was an UNCONDITIONAL
   * `controllers.set(sessionId, controller)` — minting a SECOND controller
   * for a sessionId that already has one (e.g. `loadSessionIntoTab` re-
   * homing a History row that a different tab already has loaded) silently
   * dropped the FIRST controller out of the map with no dispose: its
   * `session/close` never fires, its pendingApprovals/turn/replay state is
   * never settled — a leak. Registry-level fix (mirrors `close`'s F6
   * remove-before-dispose, reused verbatim): `open()` now removes-then-
   * disposes any EXISTING same-sessionId controller FIRST — the single
   * choke point every caller (`openSession`, `recoverOneSession`,
   * `loadSessionIntoTab`) mints through, so the invariant holds regardless
   * of which one collides. `openSession` mints a fresh, server-assigned id
   * every time, so this is purely ADDITIVE there (never observes an
   * `existing` hit) — behavior-preserving for every pre-W6-FB caller.
   */
  it('(h) W6-FB: open() disposes any controller ALREADY registered under the SAME sessionId (remove-before-dispose) before minting the replacement — no leaked controller', async () => {
    const registry = new SessionRegistry();
    const emittedA: HostToWebviewMessage[] = [];
    const emittedB: HostToWebviewMessage[] = [];
    registry.open('session-shared', '/ws', makePort(emittedA), 'tab-1');

    const logs: string[] = [];
    let settledFirst = false;
    const pendingFirst = routePermission(registry, makeEditReq('session-shared', 'tc-first'), 'appr-first', logs);
    void pendingFirst.then(() => {
      settledFirst = true;
    });
    await flush(); // let it reach the ask-card path (pendingApprovals populated on the FIRST controller)
    expect(settledFirst).toBe(false); // sanity: genuinely pending before the collision

    const second = registry.open('session-shared', '/ws', makePort(emittedB), 'tab-2');
    await flush();

    // No leak: the FIRST controller's pending approval is settled (cancelled)
    // by ITS dispose() — proof dispose actually ran, not merely that the map
    // slot changed.
    expect(settledFirst).toBe(true);
    const outcomeFirst = await pendingFirst;
    expect(outcomeFirst).toEqual({ outcome: { outcome: 'cancelled' } });

    // Exactly ONE controller is registered under the shared sessionId — the
    // SECOND one took the slot; `tab-1` (the FIRST's own tab) resolves to
    // nothing AT THE REGISTRY LEVEL (turning this into the tab-chrome
    // `tab.error{kind:'session-lost'}` terminal signal is the router's job —
    // see the sequential/concurrent cross-tab tests in `AcpBackend.test.ts`).
    expect(registry.get('session-shared')).toBe(second);
    expect(registry.getByTabId('tab-1')).toBeUndefined();
    expect(registry.getByTabId('tab-2')).toBe(second);
  });
});
