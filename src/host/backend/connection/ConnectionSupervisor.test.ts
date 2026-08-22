/*
 * WS-R1/WS-R3 characterization + regression suite (REMEDIATION-ARCHITECTURE
 * §3.1/§3.3). Pins the CURRENT observable contracts of the hand-rolled race
 * helpers and the crash/reconnect teardown BEFORE any structural change —
 * the branch-by-abstraction swaps (settleRace adapters, teardownForRespawn
 * extraction) must stay green under these pins. This file is also the
 * dedicated ConnectionSupervisor suite the TST-03 ledger names.
 *
 * `ConnectionSupervisor` is headless (no vscode import) — constructed
 * directly against a fake `ConnectionSupervisorHostPort`. `hermesPath` AND
 * `pythonPath` are both pinned so `resolveHermes` makes no OS calls (same
 * shape as ControlChannel.test.ts's CONFIG and AcpBackend.test.ts's
 * makeStartableBackend).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionSupervisor } from './ConnectionSupervisor';
import type { ConnectionSupervisorHostPort } from './ConnectionSupervisor';
import type {
  AcpClientCallbacks,
  AcpClientLike,
  AcpClientOptions,
} from '../acp/acpClient';
import type { SessionRegistry } from '../session/SessionRegistry';
import type { SessionController, LoadReplayOutcome } from '../session/SessionController';
import type { SessionHostPort } from '../session/types';
import type { HostToWebviewMessage } from '../../../shared/protocol';
import { must } from '../../../testing/must';
import { respawnBackoffMs } from '../../control/respawnBackoff';
import type { RespawnHealth } from '../../control/respawnHealth';

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const NOOP_CALLBACKS: AcpClientCallbacks = {
  onSessionUpdate: () => {},
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onReadTextFile: async () => '',
};

/** Minimal client fake — the supervisor's connect phase + exit seam only.
 * `newSession`/`prompt`/… are never reached (the port's `openSession` is a
 * fake), so the cast to `AcpClientLike` is safe by construction. */
class FakeSupervisorClient {
  exitHandlers: Array<(code: number | null) => void> = [];
  disposeCallCount = 0;
  /** WS-R3 follow-up 2 (IMP-1 re-review): `exitHandlers.length` captured AT
   * THE MOMENT `dispose()` is called — proves the exit-sub was disposed
   * BEFORE the client, not merely by the time the whole teardown eventually
   * settles. A final-state-only assertion (`exitHandlers` after everything
   * runs) is backstop-masked: `teardownSession()` unconditionally re-disposes
   * `clientExitSub` as `startInternal`'s first act (`ConnectionSupervisor.ts
   * :987-988`), so it reaches 0 on the reconnect happy path even if the
   * ordering this field pins were violated. -1 sentinel = dispose() never
   * called. */
  exitHandlersAtDispose = -1;
  connectError: unknown;
  async connect(): Promise<void> {
    if (this.connectError !== undefined) throw this.connectError;
  }
  async initialize(): Promise<void> {}
  onExit(handler: (code: number | null) => void): { dispose(): void } {
    this.exitHandlers.push(handler);
    return {
      dispose: () => {
        this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
      },
    };
  }
  simulateExit(code: number | null): void {
    for (const h of [...this.exitHandlers]) h(code);
  }
  dispose(): void {
    this.disposeCallCount++;
    this.exitHandlersAtDispose = this.exitHandlers.length;
  }
}

interface FakeController {
  sessionId: string;
  cwd: string;
  tabId: string;
  hasLiveTurn: ReturnType<typeof vi.fn>;
  endOnCrash: ReturnType<typeof vi.fn>;
  endForRestart: ReturnType<typeof vi.fn>;
  /** WS-R4 step 3 (Task 21): recoverOneSession now calls loadReplayOutcome
   * (the nested-discrimination seam), not the loadReplay adapter (WS-R4
   * step 5 / Task 23 deleted it once every caller had migrated). */
  loadReplayOutcome: ReturnType<typeof vi.fn>;
  getRootId: () => string;
}

export function makeController(sessionId: string, tabId: string): FakeController {
  return {
    sessionId,
    cwd: '/fake/ws',
    tabId,
    hasLiveTurn: vi.fn(() => false),
    endOnCrash: vi.fn(),
    endForRestart: vi.fn(),
    loadReplayOutcome: vi.fn(async () => ({
      kind: 'loaded',
      result: { found: true, currentModeId: 'default' },
    })),
    getRootId: () => 'root-1',
  };
}

export function makeSupervisorHarness(): {
  supervisor: ConnectionSupervisor;
  port: ConnectionSupervisorHostPort;
  clients: FakeSupervisorClient[];
  controllers: Map<string, FakeController>;
  emitted: HostToWebviewMessage[];
  logs: string[];
  state: { nextLoadOutcome: unknown; lastMinted: FakeController | undefined };
} {
  const clients: FakeSupervisorClient[] = [];
  const controllers = new Map<string, FakeController>();
  const emitted: HostToWebviewMessage[] = [];
  const logs: string[] = [];
  let mintCounter = 0;
  const state: { nextLoadOutcome: unknown; lastMinted: FakeController | undefined } = {
    nextLoadOutcome: undefined,
    lastMinted: undefined,
  };
  const registry = {
    values: () => [...controllers.values()],
    get: (id: string) => controllers.get(id),
    getByTabId: (tabId: string) => [...controllers.values()].find((c) => c.tabId === tabId),
    open: (sessionId: string, cwd: string, _port: unknown, tabId: string) => {
      const c = makeController(sessionId, tabId);
      c.cwd = cwd;
      c.loadReplayOutcome = vi.fn(() =>
        state.nextLoadOutcome instanceof Promise
          ? (state.nextLoadOutcome as Promise<LoadReplayOutcome>)
          : Promise.resolve(
              (state.nextLoadOutcome as LoadReplayOutcome | undefined) ?? {
                kind: 'loaded',
                result: { found: true, currentModeId: 'default' },
              },
            ),
      );
      state.lastMinted = c;
      controllers.set(sessionId, c);
      return c;
    },
    close: (sessionId: string) => {
      controllers.delete(sessionId);
    },
    disposeAll: () => {
      controllers.clear();
    },
    has: (id: string) => controllers.has(id),
  } as unknown as SessionRegistry;
  const port: ConnectionSupervisorHostPort = {
    config: { hermesPath: '/fake/hermes', pythonPath: '/fake/python' },
    createClient: () => {
      const c = new FakeSupervisorClient();
      clients.push(c);
      return c as unknown as AcpClientLike;
    },
    logger: { append: (line: string) => logs.push(line) },
    callbacks: NOOP_CALLBACKS,
    setCwd: vi.fn(),
    getActiveSessionId: vi.fn(() => undefined),
    setActiveSessionId: vi.fn(),
    sessions: registry,
    startControl: vi.fn(async () => {}),
    buildSessionPort: vi.fn(() => ({}) as unknown as SessionHostPort),
    openSession: vi.fn(async (cwd: string, tabId: string) => {
      mintCounter += 1;
      const c = makeController(`session-${mintCounter}`, tabId);
      c.cwd = cwd;
      controllers.set(c.sessionId, c);
      return c as unknown as SessionController;
    }),
    getMcpServers: () => [],
    announceSessionBound: vi.fn(),
    warmCheckpointBaseline: vi.fn(),
    settleOneShot: vi.fn(),
    resetSessionsAccumulation: vi.fn(),
    isPendingClose: vi.fn(() => false),
    emit: (msg: HostToWebviewMessage) => emitted.push(msg),
  };
  return { supervisor: new ConnectionSupervisor(port), port, clients, controllers, emitted, logs, state };
}

/** Private-member access (repo convention: element access via a cast, never `any`). */
type RecoverSeam = {
  recoverOneSession(sessionId: string, cwd: string, tabId: string, deadlineMs: number): Promise<void>;
};

/** M-2 follow-up (code/concurrency lenses): swaps the supervisor's live
 * `this.client` for a throwaway exit-only fake, so simulating THAT fake's
 * exit fires ONLY the `settleRace` subscription `recoverOneSession` just
 * armed — not `handleAcpCrash`'s standing `clientExitSub` (bound to the
 * ORIGINAL client captured at `startInternal` :425). Isolates the `exit`
 * route from a full crash/respawn cycle. */
type ClientSeam = { client?: AcpClientLike };

describe('WS-R4 co-edit — recoverOneSession routes all six outcomes (named observables)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function recover(h: ReturnType<typeof makeSupervisorHarness>, outcome: unknown): Promise<void> {
    await h.supervisor.start();
    // `start()`'s own `teardownSession()` unconditionally calls
    // `setActiveSessionId(undefined)` as part of the fresh-boot tail — clear
    // it here so downstream assertions observe ONLY what recoverOneSession
    // itself did, not this unrelated pre-existing boot call.
    (h.port.setActiveSessionId as ReturnType<typeof vi.fn>).mockClear();
    (h.port.setCwd as ReturnType<typeof vi.fn>).mockClear();
    h.state.nextLoadOutcome = outcome; // consumed by the registry's open() wiring (Step 1a)
    await (h.supervisor as unknown as RecoverSeam).recoverOneSession('session-R', '/fake/ws', 'tab-R', 120_000);
  }

  it("failure kinds route to session-lost + identity-guarded close: 'no-client' | 'load-failed' | 'not-found'", async () => {
    for (const kind of [{ kind: 'no-client' }, { kind: 'load-failed', message: 'x' }, { kind: 'not-found' }]) {
      const h = makeSupervisorHarness();
      await recover(h, kind);
      expect(h.emitted).toContainEqual(
        expect.objectContaining({ type: 'tab.error', tabId: 'tab-R', kind: 'session-lost' }),
      );
      expect(h.controllers.has('session-R')).toBe(false); // identity-guarded close ran
    }
  });

  it("'superseded' (either arm) → strict no-op: NO tab.error, NO adopt, controller left to its new owner", async () => {
    for (const outcome of [
      { kind: 'superseded' },
      { kind: 'superseded', result: { found: true, currentModeId: 'default' } },
    ]) {
      const h = makeSupervisorHarness();
      await recover(h, outcome);
      expect(h.emitted.filter((m) => m.type === 'tab.error' && m.tabId === 'tab-R')).toHaveLength(0);
      // I-1 (code-lens review): the with-result arm's OLD behavior was ADOPT
      // (setActiveSessionId/setCwd), which emits NO tab.error — so the
      // assertion above alone would stay green even if a regression
      // re-introduced that adopt for THIS arm. Pin the no-op directly, for
      // BOTH arms.
      expect(h.port.setActiveSessionId).not.toHaveBeenCalled();
      expect(h.port.setCwd).not.toHaveBeenCalled();
      // The stale controller is left registered for its new (winning) owner
      // — not closed by this losing recovery attempt.
      expect(h.controllers.has('session-R')).toBe(true);
    }
  });

  it("'loaded' adopts activeSessionId/cwd when none is active", async () => {
    const h = makeSupervisorHarness();
    await recover(h, { kind: 'loaded', result: { found: true, currentModeId: 'default' } });
    expect(h.port.setActiveSessionId).toHaveBeenCalledWith('session-R');
    expect(h.port.setCwd).toHaveBeenCalledWith('/fake/ws');
  });

  it('settleRace deadline → session-lost (the wall clock still un-jams the tail)', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    h.state.nextLoadOutcome = new Promise(() => {}); // a hung loadReplayOutcome
    const pending = (h.supervisor as unknown as RecoverSeam).recoverOneSession('session-R', '/fake/ws', 'tab-R', 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    expect(h.emitted).toContainEqual(
      expect.objectContaining({ type: 'tab.error', tabId: 'tab-R', kind: 'session-lost' }),
    );
  });

  // M-2 (code + concurrency lenses): the `exit` route was previously pinned
  // only TRANSITIVELY (shared branch with the deadline test above, plus
  // settleRace.test.ts's own exit→{kind:'exit'} pin). Direct seam-level pin.
  it("child EXITS mid-load → 'exit' route pinned directly: session-lost + identity-guarded close; belated load resolution discarded (no adopt-after-error)", async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    // See `recover()`'s own comment above: isolate from start()'s own
    // unrelated setActiveSessionId(undefined) teardown call.
    (h.port.setActiveSessionId as ReturnType<typeof vi.fn>).mockClear();
    (h.port.setCwd as ReturnType<typeof vi.fn>).mockClear();
    const hungLoad = deferred<LoadReplayOutcome>();
    h.state.nextLoadOutcome = hungLoad.promise;
    const exitClient = new FakeSupervisorClient();
    (h.supervisor as unknown as ClientSeam).client = exitClient as unknown as AcpClientLike;

    const pending = (h.supervisor as unknown as RecoverSeam).recoverOneSession('session-R', '/fake/ws', 'tab-R', 120_000);
    exitClient.simulateExit(1); // the child dies mid-load
    await pending;

    expect(h.emitted).toContainEqual(
      expect.objectContaining({ type: 'tab.error', tabId: 'tab-R', kind: 'session-lost' }),
    );
    expect(h.controllers.has('session-R')).toBe(false); // identity-guarded close ran

    // The load resolves LATE — after the race already settled on 'exit'.
    // settle-once must discard it: no adopt, no second tab.error.
    hungLoad.resolve({ kind: 'loaded', result: { found: true, currentModeId: 'default' } });
    await Promise.resolve();
    expect(h.port.setActiveSessionId).not.toHaveBeenCalled();
    expect(h.port.setCwd).not.toHaveBeenCalled();
    expect(h.emitted.filter((m) => m.type === 'tab.error')).toHaveLength(1);
  });

  // M-2's defensive-rejection route — zero coverage per the code lens; cheap
  // to pin directly alongside the other failure kinds.
  it('a rejecting loadReplayOutcome (defensive-only) → synthetic load-failed → session-lost, same as the other failure kinds', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    const failing = deferred<LoadReplayOutcome>();
    h.state.nextLoadOutcome = failing.promise;
    const pending = (h.supervisor as unknown as RecoverSeam).recoverOneSession('session-R', '/fake/ws', 'tab-R', 120_000);
    failing.reject(new Error('loadSession boom'));
    await pending;

    expect(h.emitted).toContainEqual(
      expect.objectContaining({ type: 'tab.error', tabId: 'tab-R', kind: 'session-lost' }),
    );
    expect(h.controllers.has('session-R')).toBe(false); // identity-guarded close ran
  });
});

type CrashSeam = {
  handleAcpCrash(code: number | null): void;
  clientExitSub?: { dispose(): void };
  pendingRecovery?: Array<{ sessionId: string; cwd: string; tabId: string }>;
  acpState: string;
};

describe('WS-R3 characterization — handleAcpCrash observable sequence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function startedHarness(): Promise<ReturnType<typeof makeSupervisorHarness> & { seam: CrashSeam }> {
    const h = makeSupervisorHarness();
    await h.supervisor.start(); // boots session-1 via the fake openSession
    return { ...h, seam: h.supervisor as unknown as CrashSeam };
  }

  it('crash: banner ONCE per outage; snapshot EXCLUDES pendingClose; one-shot settled; client nulled+disposed; respawn scheduled', async () => {
    const h = await startedHarness();
    const extra = makeController('session-2', 'tab-2');
    h.controllers.set('session-2', extra);
    const closing = makeController('session-3', 'tab-3');
    h.controllers.set('session-3', closing);
    (h.port.isPendingClose as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => id === 'session-3',
    );

    must(h.clients[0]).simulateExit(1);

    expect(h.emitted.filter((m) => m.type === 'system.error')).toHaveLength(1);
    expect((h.supervisor as unknown as CrashSeam).pendingRecovery?.map((r) => r.sessionId)).toEqual([
      'session-1',
      'session-2', // session-3 excluded — pendingClose tombstone honored
    ]);
    expect(h.port.settleOneShot).toHaveBeenCalledWith('ACP connection lost');
    expect(must(h.clients[0]).disposeCallCount).toBe(1);
    expect(h.supervisor.getClient()).toBeUndefined();
    expect(h.logs.some((l) => l.includes('ACP respawn attempt 1'))).toBe(true);
    // banner-once: a SECOND crash entry while respawning adds no second banner
    (h.supervisor as unknown as CrashSeam).handleAcpCrash(1);
    expect(h.emitted.filter((m) => m.type === 'system.error')).toHaveLength(1);
  });

  it("crash fan-out survives a throwing controller and pins the EXACT log line (with the (tab '…') segment)", async () => {
    const h = await startedHarness();
    const bad = makeController('session-bad', 'tab-bad');
    bad.endOnCrash.mockImplementation(() => {
      throw new Error('boom');
    });
    h.controllers.set('session-bad', bad);
    const good = makeController('session-good', 'tab-good');
    h.controllers.set('session-good', good);

    must(h.clients[0]).simulateExit(1);

    expect(good.endOnCrash).toHaveBeenCalledTimes(1); // the throw did not abort the loop
    expect(must(h.clients[0]).disposeCallCount).toBe(1); // …nor the trailing client dispose
    expect(
      h.logs.some((l) =>
        l.includes("crash fan-out: endOnCrash failed for session 'session-bad' (tab 'tab-bad'), continuing:"),
      ),
    ).toBe(true);
  });

  it('NAMED OBSERVABLE: the exit-sub is disposed even on the already-disposed crash path', async () => {
    const h = await startedHarness();
    h.supervisor.markDisposed();
    const disposeSpy = vi.fn();
    (h.supervisor as unknown as CrashSeam).clientExitSub = { dispose: disposeSpy };
    // startedHarness()'s own start() already emitted `system.recovered`
    // (establishInitialSession, unconditional on a successful mint) and
    // already called settleOneShot('session torn down') (teardownSession,
    // startInternal's first act) — reset both trackers here so this test
    // isolates what THIS handleAcpCrash call does (nothing, past the
    // exit-sub dispose), not what the preceding start() already did.
    h.emitted.length = 0;
    (h.port.settleOneShot as ReturnType<typeof vi.fn>).mockClear();
    (h.supervisor as unknown as CrashSeam).handleAcpCrash(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect((h.supervisor as unknown as CrashSeam).clientExitSub).toBeUndefined();
    expect(h.emitted).toHaveLength(0); // and NOTHING else ran (no banner)
    expect(h.port.settleOneShot).not.toHaveBeenCalled();
  });

  it('pendingRecovery snapshot is taken BEFORE the crash fan-out — order-sensitive (endOnCrash mutates the registry)', async () => {
    const h = await startedHarness();
    const extra = makeController('session-2', 'tab-2');
    h.controllers.set('session-2', extra);
    // endOnCrash never mutates the registry in production (comment :1044-1049),
    // and the fakes' default no-op endOnCrash can't observe a snapshot/fan-out
    // reorder either way — so mutate the registry HERE, mid-fan-out, to make
    // the relative order observable: if a future extraction moved the
    // pendingRecovery snapshot to AFTER this loop, it would compute against
    // the POST-deletion registry and miss 'session-1'.
    extra.endOnCrash.mockImplementation(() => {
      h.controllers.delete('session-1');
    });

    must(h.clients[0]).simulateExit(1);

    // still the PRE-fan-out set — proves the snapshot ran before the loop,
    // not after (a post-fan-out snapshot would see only ['session-2']).
    expect((h.supervisor as unknown as CrashSeam).pendingRecovery?.map((r) => r.sessionId)).toEqual([
      'session-1',
      'session-2',
    ]);
  });

  it('handleAcpCrash: a throwing clientExitSub dispose does not abort before the respawn is scheduled (WS-R3 F2-19 close-out)', async () => {
    const h = await startedHarness();
    const throwingDispose = vi.fn(() => {
      throw new Error('exit-sub dispose boom');
    });
    (h.supervisor as unknown as CrashSeam).clientExitSub = { dispose: throwingDispose };

    // Pre-fix: the throw escapes handleAcpCrash before clientExitSub is
    // nulled and before teardownForRespawn/scheduleAcpRespawn ever run — the
    // supervisor zombies (acpState stuck at 'ready', no respawn timer armed).
    expect(() => must(h.clients[0]).simulateExit(1)).not.toThrow();

    expect(throwingDispose).toHaveBeenCalledTimes(1);
    expect((h.supervisor as unknown as CrashSeam).clientExitSub).toBeUndefined();
    // Sibling crash-banner behavior is untouched by this guard.
    expect(h.emitted.filter((m) => m.type === 'system.error')).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('ACP respawn attempt 1'))).toBe(true);

    await vi.advanceTimersByTimeAsync(respawnBackoffMs(1));
    expect(h.clients.length).toBeGreaterThanOrEqual(2); // respawn actually spawned
  });

  it('handleAcpCrash: a throwing client.dispose() (inside teardownForRespawn) does not abort before the respawn is scheduled (WS-R3 F2-19 close-out follow-up)', async () => {
    const h = await startedHarness();
    const client = must(h.clients[0]);
    client.dispose = () => {
      throw new Error('client dispose boom');
    };

    // Pre-fix: teardownForRespawn's unguarded `this.client?.dispose()` throws,
    // propagating straight out of handleAcpCrash — which has NO try/catch
    // around its `teardownForRespawn(...)` call — BEFORE `scheduleAcpRespawn()`
    // ever runs. The supervisor zombies (acpState stuck, no respawn timer
    // armed, no subsequent spawn attempt).
    expect(() => must(h.clients[0]).simulateExit(1)).not.toThrow();

    expect(h.supervisor.getClient()).toBeUndefined();
    expect((h.supervisor as unknown as CrashSeam).acpState).toBe('respawning');
    expect(h.logs.some((l) => l.includes('ACP respawn attempt 1'))).toBe(true);

    await vi.advanceTimersByTimeAsync(respawnBackoffMs(1));
    expect(h.clients.length).toBeGreaterThanOrEqual(2); // respawn actually spawned
  });
});

describe('WS-R3 characterization — reconnect refusal matrix + teardown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("not 'ready' → honest refusal (idle wording)", async () => {
    const h = makeSupervisorHarness();
    await expect(h.supervisor.reconnect()).resolves.toEqual({
      ok: false,
      reason: 'The agent connection is not running.',
    });
  });

  it('live turn → refusal with the pinned wording', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    const busy = must(h.controllers.get('session-1'));
    busy.hasLiveTurn.mockReturnValue(true);
    await expect(h.supervisor.reconnect()).resolves.toEqual({
      ok: false,
      reason: 'A turn is still running — wait for it to finish (or cancel it) before re-checking.',
    });
  });

  it("acpState 'starting' → honest refusal, distinct wording from idle/live-turn", async () => {
    const h = makeSupervisorHarness();
    (h.supervisor as unknown as CrashSeam).acpState = 'starting';
    await expect(h.supervisor.reconnect()).resolves.toEqual({
      ok: false,
      reason: 'The agent is already (re)connecting — wait a moment, then re-check.',
    });
  });

  it("acpState 'respawning' → same honest-refusal wording as 'starting' (the third refusal-matrix arm)", async () => {
    const h = makeSupervisorHarness();
    (h.supervisor as unknown as CrashSeam).acpState = 'respawning';
    await expect(h.supervisor.reconnect()).resolves.toEqual({
      ok: false,
      reason: 'The agent is already (re)connecting — wait a moment, then re-check.',
    });
  });

  it("idle reconnect: teardown ordering + startInternal in the SAME tail link → {ok:true}; pins the reconnect fan-out log line (NO tab segment)", async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    const bad = makeController('session-bad', 'tab-bad');
    bad.endOnCrash.mockImplementation(() => {
      throw new Error('boom');
    });
    h.controllers.set('session-bad', bad);

    await expect(h.supervisor.reconnect()).resolves.toEqual({ ok: true });
    expect(h.port.settleOneShot).toHaveBeenCalledWith('agent reconnecting');
    expect(must(h.clients[0]).disposeCallCount).toBe(1); // old client disposed
    expect(must(h.clients[0]).exitHandlersAtDispose).toBe(0); // exit-sub disposed BEFORE client.dispose() — the ORDERING pin (NOT backstop-masked by teardownSession's later re-dispose; see field doc above)
    expect(must(h.clients[0]).exitHandlers).toHaveLength(0); // old exit-sub cleared, final state — defense in depth ONLY; teardownSession's :987-988 backstop also reaches 0 here, so this line alone has no teeth against the ordering regression above
    expect(h.clients).toHaveLength(2); // startInternal spawned a fresh one
    expect(h.emitted.filter((m) => m.type === 'system.error')).toHaveLength(0); // reconnect never emits the crash banner
    expect(
      h.logs.some((l) =>
        l.includes("reconnect fan-out: endOnCrash failed for session 'session-bad', continuing:"),
      ),
    ).toBe(true);
    expect(h.logs.some((l) => l.includes("(tab 'tab-bad')"))).toBe(false); // the tab segment is CRASH-only
  });

  it('teardownForRespawn (via reconnect()): a throwing clientExitSub dispose does not abort the reconnect (WS-R3 F2-19 close-out)', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    const throwingDispose = vi.fn(() => {
      throw new Error('exit-sub dispose boom');
    });
    // Live on the reconnect() path — unlike handleAcpCrash (which already
    // nulled clientExitSub before calling teardownForRespawn), this is the
    // dispose that actually fires for real (see teardownForRespawn's own doc).
    (h.supervisor as unknown as CrashSeam).clientExitSub = { dispose: throwingDispose };

    // Pre-fix: the throw escapes teardownForRespawn, which sits OUTSIDE
    // reconnect()'s own try/catch around startInternal() — the whole
    // runOnStartTail link rejects instead of resolving {ok:false}, and
    // acpState never reaches 'respawning' / startInternal() never runs.
    await expect(h.supervisor.reconnect()).resolves.toEqual({ ok: true });

    expect(throwingDispose).toHaveBeenCalledTimes(1);
    expect(h.clients).toHaveLength(2); // startInternal still spawned a fresh client
  });
});

describe('WS-R3 F3-4 (reconnect half) — wedge-break clause', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('{force:true} bypasses the live-turn refusal; the fan-out ends the turn as USER intent (endForRestart -> turn.end{cancelled}), never as a crash', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    const busy = must(h.controllers.get('session-1'));
    busy.hasLiveTurn.mockReturnValue(true);
    await expect(h.supervisor.reconnect({ force: true })).resolves.toEqual({ ok: true });
    expect(busy.endForRestart).toHaveBeenCalledTimes(1); // T16: user-intent ending (ADR-T16)
    expect(busy.endOnCrash).not.toHaveBeenCalled(); // the crash ending stays crash-only
  });

  it('no force + live turn → refusal byte-identical to today', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    must(h.controllers.get('session-1')).hasLiveTurn.mockReturnValue(true);
    await expect(h.supervisor.reconnect()).resolves.toEqual({
      ok: false,
      reason: 'A turn is still running — wait for it to finish (or cancel it) before re-checking.',
    });
  });
});

describe('WS-R3 F2-19 — supervisor respawn loop health transitions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('degraded at attempt 5, down at 10, ok on a successful respawn — transition-only', async () => {
    let failRespawns = true;
    const h = makeSupervisorHarness();
    // Every client AFTER the boot one refuses to connect while failRespawns is on.
    const originalCreate = h.port.createClient;
    (h.port as { createClient: typeof originalCreate }).createClient = (options) => {
      const c = originalCreate(options);
      if (h.clients.length > 1 && failRespawns) {
        must(h.clients[h.clients.length - 1]).connectError = new Error('spawn refused');
      }
      return c;
    };
    const health: RespawnHealth[] = [];
    h.supervisor.onHealth((x) => health.push(x));
    await h.supervisor.start();
    must(h.clients[0]).simulateExit(1); // crash → attempt 1
    for (let attempt = 1; attempt <= 10; attempt++) {
      await vi.advanceTimersByTimeAsync(respawnBackoffMs(attempt));
      await vi.advanceTimersByTimeAsync(1); // let the failed start() settle + reschedule
    }
    expect(health).toEqual([
      { state: 'degraded', attempts: 5 },
      { state: 'down', attempts: 10 },
    ]);
    failRespawns = false;
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(11));
    await vi.advanceTimersByTimeAsync(1);
    expect(health[health.length - 1]).toEqual({ state: 'ok', attempts: 0 });
    expect(health).toHaveLength(3);
  });

  /**
   * F2-19b self-heal hardening (mirrors Task 17's ControlChannel review
   * findings): a throwing `onHealth` subscriber must never be able to
   * silently kill `scheduleAcpRespawn`'s loop — the exact opposite of what
   * F2-19 exists to prevent. The throwing subscriber is registered FIRST so
   * a naive (unguarded) fan-out would abort before the sibling subscriber
   * below ever runs; both the sibling's full transition sequence AND the
   * loop's continued arming past the throw are asserted.
   */
  it('a throwing health subscriber at the down transition does not stop the loop from arming the next attempt (F2-19 never-terminal invariant)', async () => {
    let failRespawns = true;
    const h = makeSupervisorHarness();
    const originalCreate = h.port.createClient;
    (h.port as { createClient: typeof originalCreate }).createClient = (options) => {
      const c = originalCreate(options);
      if (h.clients.length > 1 && failRespawns) {
        must(h.clients[h.clients.length - 1]).connectError = new Error('spawn refused');
      }
      return c;
    };
    const seen: RespawnHealth[] = [];
    h.supervisor.onHealth((x) => {
      if (x.state === 'down') throw new Error('subscriber boom at down');
    });
    h.supervisor.onHealth((x) => seen.push(x));
    await h.supervisor.start();
    must(h.clients[0]).simulateExit(1); // crash → attempt 1
    for (let attempt = 1; attempt <= 10; attempt++) {
      await vi.advanceTimersByTimeAsync(respawnBackoffMs(attempt));
      await vi.advanceTimersByTimeAsync(1);
    }
    // The sibling subscriber still saw BOTH transitions — the throw at
    // 'down' did not abort emitHealth's fan-out for the handlers after it.
    expect(seen).toEqual([
      { state: 'degraded', attempts: 5 },
      { state: 'down', attempts: 10 },
    ]);

    // The throw at the 'down' transition must not have prevented attempt
    // 11's backoff from being armed — the loop keeps retrying forever
    // (F2-19's never-terminal invariant), same guarantee the crash loop
    // itself already provides.
    failRespawns = false;
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(11));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.clients.length).toBeGreaterThanOrEqual(12); // attempt 11 actually spawned
    expect(h.supervisor.getClient()).toBeDefined(); // …and the connection healed
  });

  /**
   * F2-19b self-heal hardening, logger half: mirrors ControlChannel's own
   * "guarded against a throwing logger" suite. `port.logger.append` sits on
   * the crash/respawn/arm critical path at three call sites
   * (`handleAcpCrash`'s banner, `scheduleAcpRespawn`'s own log, and the
   * retry-failure log inside the timeout callback) plus `teardownForRespawn`'s
   * per-controller fan-out log — an always-throwing logger (a bad/disposed
   * `vscode.OutputChannel`) must not be able to silently zombie the loop at
   * any of them.
   */
  it('a logger whose append() always throws does not silently kill the self-heal loop across repeated crash/respawn cycles', async () => {
    let failOnce = true;
    const h = makeSupervisorHarness();
    const originalCreate = h.port.createClient;
    (h.port as { createClient: typeof originalCreate }).createClient = (options) => {
      const c = originalCreate(options);
      if (h.clients.length > 1 && failOnce) {
        must(h.clients[h.clients.length - 1]).connectError = new Error('spawn refused');
        failOnce = false; // only attempt 1 fails — attempt 2 must reach 'ready'
      }
      return c;
    };
    (h.port as { logger: typeof h.port.logger }).logger = {
      append: () => {
        throw new Error('logger boom (disposed OutputChannel)');
      },
    };
    await h.supervisor.start();

    // Crash: handleAcpCrash() calls the (throwing) banner log BEFORE
    // teardownForRespawn/scheduleAcpRespawn run. Pre-fix, an unguarded
    // `logger.append` throw escapes handleAcpCrash entirely — synchronously,
    // right out through this simulateExit() call — leaving the supervisor a
    // zombie that never respawns.
    expect(() => must(h.clients[0]).simulateExit(1)).not.toThrow();

    // Attempt 1's backoff must have been armed despite the throw above —
    // scheduleAcpRespawn's OWN log call is a 2nd unguarded site on this path.
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(1));
    expect(h.clients).toHaveLength(2); // respawn actually spawned — loop alive

    // Attempt 1 fails (connectError above) — its catch handler's own
    // (throwing) failure log must not prevent scheduling attempt 2.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(2));
    expect(h.clients).toHaveLength(3); // attempt 2 actually spawned

    // Full self-heal: attempt 2 has no connectError — the loop can still
    // reach 'ready' again despite every logger.append() call throwing.
    await vi.advanceTimersByTimeAsync(1);
    expect(h.supervisor.getClient()).toBeDefined();
  });

  /**
   * F2-19b follow-up (arch review Important-1): `onHealth` is purely
   * edge-triggered with no replay. A late subscriber — one that reads state
   * WITHOUT having registered an `onHealth` handler at all, e.g. a webview
   * panel VS Code reveals lazily, post-outage — must not default to 'ok'
   * while the ACP child is actually down. Deliberately registers NO
   * `onHealth` subscriber here.
   */
  it("currentHealth() reflects the LIVE state for a late subscriber, not a default 'ok' (arch review Important-1)", async () => {
    let failRespawns = true;
    const h = makeSupervisorHarness();
    const originalCreate = h.port.createClient;
    (h.port as { createClient: typeof originalCreate }).createClient = (options) => {
      const c = originalCreate(options);
      if (h.clients.length > 1 && failRespawns) {
        must(h.clients[h.clients.length - 1]).connectError = new Error('spawn refused');
      }
      return c;
    };
    await h.supervisor.start();
    must(h.clients[0]).simulateExit(1); // crash → attempt 1
    for (let attempt = 1; attempt <= 10; attempt++) {
      await vi.advanceTimersByTimeAsync(respawnBackoffMs(attempt));
      await vi.advanceTimersByTimeAsync(1);
    }
    // No onHealth subscriber was ever registered — a late subscriber calling
    // currentHealth() now must read the TRUE live state, not a default 'ok'.
    expect(h.supervisor.currentHealth()).toEqual({ state: 'down', attempts: 11 });

    // LIVE, not frozen at the transition payload's attempts:10 — one more
    // failed attempt keeps the live counter climbing.
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(11));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.supervisor.currentHealth()).toEqual({ state: 'down', attempts: 12 });
  });

  /**
   * F2-19b follow-up (concurrency re-review Important-1): `handleAcpCrash`'s
   * crash-banner `port.emit(...)` call sits BEFORE `teardownForRespawn`/
   * `scheduleAcpRespawn` on the crash chain. An unguarded throw there must
   * not abort the method before the respawn is scheduled — the exact F2-19
   * zombie this class exists to prevent, independent of whether
   * `vscode.EventEmitter.fire` happens to swallow listener throws in
   * production.
   */
  it('a throwing crash-banner emit listener does not abort handleAcpCrash before scheduleAcpRespawn (safeEmit guard)', async () => {
    const h = makeSupervisorHarness();
    const originalEmit = h.port.emit;
    (h.port as { emit: typeof originalEmit }).emit = (msg) => {
      if (msg.type === 'system.error' && msg.message === 'The agent exited unexpectedly — reconnecting…') {
        throw new Error('emit listener boom (crash banner)');
      }
      originalEmit(msg);
    };
    await h.supervisor.start();

    // Pre-fix this throws SYNCHRONOUSLY: handleAcpCrash's crash-banner
    // port.emit call runs before teardownForRespawn/scheduleAcpRespawn, so
    // an unguarded throw here aborts handleAcpCrash before the respawn is
    // ever scheduled.
    expect(() => must(h.clients[0]).simulateExit(1)).not.toThrow();

    // scheduleAcpRespawn was still reached despite the throw: its own log
    // call fires synchronously inside the same handleAcpCrash call.
    expect(h.logs.some((l) => l.includes('ACP respawn attempt 1'))).toBe(true);

    // …and attempt 1 actually spawns and the connection self-heals.
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(1));
    expect(h.clients.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.supervisor.getClient()).toBeDefined();
  });
});

/** Dispose-race fix: private-state seam (repo convention — cast, never `any`). */
type DisposeRaceSeam = { acpState: string };

describe('dispose() racing startInternal — a disposed supervisor never resurrects (WS-UX T5 review finding)', () => {
  it('G2: dispose() landing while the connect phase settles → start() rejects; no resurrect, no exit-sub, no session mint, no banner, no orphan', async () => {
    const h = makeSupervisorHarness();
    const healthEvents: RespawnHealth[] = [];
    h.supervisor.onHealth((health) => healthEvents.push(health));
    (h.port.startControl as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // The REAL AcpBackend.dispose() sequence (AcpBackend.ts:1979 then
      // :1992), landing after connect()/initialize() resolved but before
      // startInternal's continuation resumes past the connect-phase await.
      h.supervisor.markDisposed();
      h.supervisor.teardownSession();
    });

    // RED (pre-fix): start() RESOLVES — the supervisor resurrects to 'ready',
    // attaches an exit-sub to the disposed client, mints a bootstrap session
    // and emits system.recovered, all on a disposed supervisor.
    await expect(h.supervisor.start()).rejects.toThrow(/disposed/i);

    expect((h.supervisor as unknown as DisposeRaceSeam).acpState).toBe('disposed'); // never 'ready'
    expect(must(h.clients[0]).disposeCallCount).toBe(1); // no orphaned client (teardownSession's dispose; catch no-ops)
    expect(must(h.clients[0]).exitHandlers).toHaveLength(0); // no crash-sub attached to a disposed client
    expect(h.supervisor.getClient()).toBeUndefined();
    expect(h.port.openSession).not.toHaveBeenCalled(); // no session minted post-dispose
    expect(h.emitted.filter((m) => m.type === 'system.recovered')).toHaveLength(0);
    expect(h.emitted.filter((m) => m.type === 'system.error')).toHaveLength(0); // catch suppresses the banner when disposed
    expect(healthEvents).toHaveLength(0);
  });

  it('G2 (markDisposed alone in the window): the catch still disposes the just-connected client — no orphan even without teardownSession', async () => {
    const h = makeSupervisorHarness();
    (h.port.startControl as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      h.supervisor.markDisposed(); // no teardownSession — the guard+catch clean up alone
    });
    await expect(h.supervisor.start()).rejects.toThrow(/disposed/i);
    expect(must(h.clients[0]).disposeCallCount).toBe(1); // disposed by startInternal's own catch (CF-01/I-1 path)
    expect(h.supervisor.getClient()).toBeUndefined();
    expect((h.supervisor as unknown as DisposeRaceSeam).acpState).toBe('disposed');
  });

  it('G1: dispose() racing the resolveHermes() await aborts before any client is created', async () => {
    const h = makeSupervisorHarness();
    const startPromise = h.supervisor.start();
    // startInternal's FIRST act (teardownSession, :377) synchronously calls
    // settleOneShot('session torn down'), then suspends at `await
    // resolveHermes(...)` (:387; pinned hermesPath+pythonPath → microtasks
    // only, no OS calls — same reasoning as ControlChannel.test.ts:506-528).
    // Poll one microtask at a time until that sentinel shows: we are then
    // INSIDE the resolveHermes window, strictly before createClient. Bounded
    // so a regression fails loudly instead of hanging the suite.
    for (let i = 0; i < 50 && (h.port.settleOneShot as ReturnType<typeof vi.fn>).mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(h.port.settleOneShot).toHaveBeenCalled(); // startInternal entered…
    expect(h.clients).toHaveLength(0); // …and is still pre-createClient: the window is REAL, not assumed
    h.supervisor.markDisposed();

    // RED (pre-fix): resolves, and h.clients grows to 1 — a client (⇒ child)
    // created for a supervisor that dispose() already finished with.
    await expect(startPromise).rejects.toThrow(/disposed/i);
    expect(h.clients).toHaveLength(0); // a disposed supervisor never creates a client
    expect((h.supervisor as unknown as DisposeRaceSeam).acpState).toBe('disposed');
  });

  it('spurious-health pin + respawn-caller safety: dispose() landing while a crash-loop attempt is mid-connect emits NO {state:ok} recovery and never re-arms', async () => {
    vi.useFakeTimers();
    try {
      const h = makeSupervisorHarness();
      const healthEvents: RespawnHealth[] = [];
      h.supervisor.onHealth((health) => healthEvents.push(health));
      await h.supervisor.start(); // healthy boot (emitHealth(0) dedupes: lastState already 'ok')

      // Fail the next 4 connect phases so the tracker leaves 'ok'
      // ('degraded' fires when attempt 5 is ARMED — respawnHealth.ts:9,19-23).
      let failNext = 4;
      const realCreate = h.port.createClient;
      h.port.createClient = (opts: AcpClientOptions) => {
        const client = realCreate(opts) as unknown as FakeSupervisorClient;
        if (failNext > 0) {
          failNext -= 1;
          client.connectError = new Error('connect boom');
        }
        return client as unknown as AcpClientLike;
      };

      must(h.clients[0]).simulateExit(1); // handleAcpCrash → attempt 1 armed
      for (let attempt = 1; attempt <= 4; attempt++) {
        await vi.advanceTimersByTimeAsync(respawnBackoffMs(attempt)); // each fails, re-arms the next
      }
      expect(healthEvents).toContainEqual({ state: 'degraded', attempts: 5 });
      healthEvents.length = 0;

      // Attempt 5 will SUCCEED its connect phase — but dispose() lands in the window.
      (h.port.startControl as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        h.supervisor.markDisposed();
        h.supervisor.teardownSession();
      });
      await vi.advanceTimersByTimeAsync(respawnBackoffMs(5));

      // RED (pre-fix): healthEvents contains the spurious {state:'ok',
      // attempts:0} "recovered" push — fired AFTER dispose(), to subscribers
      // markDisposed() correctly no longer clears (T5's tracker refactor).
      expect(healthEvents).toHaveLength(0);
      expect((h.supervisor as unknown as DisposeRaceSeam).acpState).toBe('disposed');
      expect(vi.getTimerCount()).toBe(0); // the timer-callback catch saw 'disposed': no re-arm (ConnectionSupervisor.ts:1249)
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnect-caller safety: an in-flight reconnect() that loses the dispose race refuses honestly and does not re-arm', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    (h.port.startControl as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      h.supervisor.markDisposed();
      h.supervisor.teardownSession();
    });

    // RED (pre-fix): resolves {ok:true} — a "successful" reconnect of a
    // supervisor that is already disposed, with acpState resurrected.
    const outcome = await h.supervisor.reconnect();

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('disposed') });
    expect((h.supervisor as unknown as DisposeRaceSeam).acpState).toBe('disposed');
    expect(h.logs.some((line) => line.includes('ACP respawn attempt'))).toBe(false); // reconnect's catch skipped scheduleAcpRespawn (:1213-1216)
  });
});
