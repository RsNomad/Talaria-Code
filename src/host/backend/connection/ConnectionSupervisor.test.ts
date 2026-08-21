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
  AcpLoadSessionResult,
} from '../acp/acpClient';
import type { SessionRegistry } from '../session/SessionRegistry';
import type { SessionController } from '../session/SessionController';
import type { SessionHostPort } from '../session/types';
import type { HostToWebviewMessage } from '../../../shared/protocol';
import { must } from '../../../testing/must';

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
  /** Pre-migration recovery stub (recoverOneSession calls loadReplay until
   * Task 21 flips it to loadReplayOutcome — Task 21 adds that member). */
  loadReplay: ReturnType<typeof vi.fn>;
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
    loadReplay: vi.fn(async () => ({ found: true, currentModeId: 'default' })),
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
} {
  const clients: FakeSupervisorClient[] = [];
  const controllers = new Map<string, FakeController>();
  const emitted: HostToWebviewMessage[] = [];
  const logs: string[] = [];
  let mintCounter = 0;
  const registry = {
    values: () => [...controllers.values()],
    get: (id: string) => controllers.get(id),
    getByTabId: (tabId: string) => [...controllers.values()].find((c) => c.tabId === tabId),
    open: (sessionId: string, cwd: string, _port: unknown, tabId: string) => {
      const c = makeController(sessionId, tabId);
      c.cwd = cwd;
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
  return { supervisor: new ConnectionSupervisor(port), port, clients, controllers, emitted, logs };
}

/** Private-member access (repo convention: element access via a cast, never `any`). */
type RaceHelpers = {
  raceAgainstChildExit<T>(p: Promise<T>, client: AcpClientLike, deadlineMs?: number): Promise<T | undefined>;
  raceRecoveryAgainstChildExit(
    p: Promise<AcpLoadSessionResult | undefined>,
    client: AcpClientLike,
    deadlineMs: number,
  ): Promise<AcpLoadSessionResult | undefined>;
};

describe('WS-R1 characterization — raceAgainstChildExit legacy contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function helpers(): { h: RaceHelpers; client: FakeSupervisorClient } {
    const { supervisor } = makeSupervisorHarness();
    return { h: supervisor as unknown as RaceHelpers, client: new FakeSupervisorClient() };
  }

  it('value passthrough (deadline omitted): resolves the value, NO timer is created', async () => {
    const { h, client } = helpers();
    const d = deferred<string>();
    const race = h.raceAgainstChildExit(d.promise, client as unknown as AcpClientLike);
    expect(vi.getTimerCount()).toBe(0); // omitted deadline reproduces the prior no-timer behavior
    d.resolve('v');
    await expect(race).resolves.toBe('v');
    expect(client.exitHandlers).toHaveLength(0); // exit sub disposed on the value path
  });

  it('exit → resolves undefined (collapsed sentinel — the documented :851-856 ambiguity)', async () => {
    const { h, client } = helpers();
    const race = h.raceAgainstChildExit(deferred<string>().promise, client as unknown as AcpClientLike);
    client.simulateExit(1);
    await expect(race).resolves.toBeUndefined();
    expect(client.exitHandlers).toHaveLength(0);
  });

  it('deadline → resolves undefined (SAME sentinel as exit — deliberately indistinguishable)', async () => {
    const { h, client } = helpers();
    const race = h.raceAgainstChildExit(deferred<string>().promise, client as unknown as AcpClientLike, 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(race).resolves.toBeUndefined();
    expect(client.exitHandlers).toHaveLength(0);
  });

  it('rejection passthrough: a genuine rejection of p rejects the race (NOT swallowed)', async () => {
    const { h, client } = helpers();
    const d = deferred<string>();
    const race = h.raceAgainstChildExit(d.promise, client as unknown as AcpClientLike, 120_000);
    const boom = new Error('boom');
    d.reject(boom);
    await expect(race).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0); // timer cleared on the rejection path too
    expect(client.exitHandlers).toHaveLength(0); // exit sub disposed on the rejection path too (symmetric with value/exit/deadline)
  });

  it('fast path clears the deadline timer (the T-3 fast-path pin)', async () => {
    const { h, client } = helpers();
    const d = deferred<string>();
    const race = h.raceAgainstChildExit(d.promise, client as unknown as AcpClientLike, 120_000);
    expect(vi.getTimerCount()).toBe(1);
    d.resolve('v');
    await race;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exit wins over an armed deadline: fires first AND clears the deadline timer (leaked-timer-on-the-exit-path regression pin)', async () => {
    const { h, client } = helpers();
    const race = h.raceAgainstChildExit(deferred<string>().promise, client as unknown as AcpClientLike, 120_000);
    expect(vi.getTimerCount()).toBe(1); // deadline armed
    client.simulateExit(1);
    await expect(race).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); // exit cleared the deadline timer too, not just the p-settle fast path
    expect(client.exitHandlers).toHaveLength(0);
  });

  it('settle-once: p resolves first, then the deadline elapses — outcome stays the value (no clobber to undefined)', async () => {
    const { h, client } = helpers();
    const d = deferred<string>();
    const race = h.raceAgainstChildExit(d.promise, client as unknown as AcpClientLike, 120_000);
    d.resolve('v');
    await expect(race).resolves.toBe('v'); // p wins first
    // late-loser: the deadline elapses AFTER p already won. If a future adapter
    // fails to clear the timer, this actually drives the deadline branch's
    // settleResolve a second time — the `if (settled) return` guard must
    // absorb it silently rather than flip the outcome.
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(race).resolves.toBe('v'); // unchanged
  });

  it('settle-once: exit wins, then p resolves late — outcome stays undefined (late value has no effect)', async () => {
    const { h, client } = helpers();
    const d = deferred<string>();
    const race = h.raceAgainstChildExit(d.promise, client as unknown as AcpClientLike);
    client.simulateExit(1);
    await expect(race).resolves.toBeUndefined(); // exit wins first
    expect(client.exitHandlers).toHaveLength(0);
    // late-loser: p resolves AFTER exit already won. p's own .then callback
    // is still registered and WILL run — this is the genuine second call
    // into settleResolve that the `if (settled) return` guard must swallow.
    d.resolve('late-value');
    await Promise.resolve(); // flush the microtask so settleResolve('late-value') actually runs before we assert
    await expect(race).resolves.toBeUndefined(); // unchanged — the late value never surfaces
  });
});

describe('WS-R1 characterization — raceRecoveryAgainstChildExit swallow contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a rejection is SWALLOWED to undefined (unlike raceAgainstChildExit)', async () => {
    const { supervisor } = makeSupervisorHarness();
    const h = supervisor as unknown as RaceHelpers;
    const client = new FakeSupervisorClient();
    const d = deferred<AcpLoadSessionResult | undefined>();
    const race = h.raceRecoveryAgainstChildExit(d.promise, client as unknown as AcpClientLike, 120_000);
    d.reject(new Error('boom'));
    await expect(race).resolves.toBeUndefined();
  });

  it('the pre-existing 120s deadline elapses (loadReplay pending, no exit) → undefined', async () => {
    const { supervisor } = makeSupervisorHarness();
    const h = supervisor as unknown as RaceHelpers;
    const client = new FakeSupervisorClient();
    const race = h.raceRecoveryAgainstChildExit(
      deferred<AcpLoadSessionResult | undefined>().promise,
      client as unknown as AcpClientLike,
      120_000,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(race).resolves.toBeUndefined();
  });

  it('exit → undefined (the child-exit race — the entire reason this helper exists, per its own doc)', async () => {
    const { supervisor } = makeSupervisorHarness();
    const h = supervisor as unknown as RaceHelpers;
    const client = new FakeSupervisorClient();
    const race = h.raceRecoveryAgainstChildExit(
      deferred<AcpLoadSessionResult | undefined>().promise,
      client as unknown as AcpClientLike,
      120_000,
    );
    client.simulateExit(1);
    await expect(race).resolves.toBeUndefined();
    expect(client.exitHandlers).toHaveLength(0); // exit sub disposed
    expect(vi.getTimerCount()).toBe(0); // the 120s deadline timer is cleared too
  });

  it('happy path: loadReplay resolves to a real result → identity-preserved passthrough (not swallowed)', async () => {
    const { supervisor } = makeSupervisorHarness();
    const h = supervisor as unknown as RaceHelpers;
    const client = new FakeSupervisorClient();
    const sentinel: AcpLoadSessionResult = { found: true, currentModeId: 'default' };
    const d = deferred<AcpLoadSessionResult | undefined>();
    const race = h.raceRecoveryAgainstChildExit(d.promise, client as unknown as AcpClientLike, 120_000);
    d.resolve(sentinel);
    await expect(race).resolves.toBe(sentinel);
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
});

describe('WS-R3 F3-4 (reconnect half) — wedge-break clause', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('{force:true} bypasses the live-turn refusal; the fan-out safely ends the turn', async () => {
    const h = makeSupervisorHarness();
    await h.supervisor.start();
    const busy = must(h.controllers.get('session-1'));
    busy.hasLiveTurn.mockReturnValue(true);
    await expect(h.supervisor.reconnect({ force: true })).resolves.toEqual({ ok: true });
    expect(busy.endOnCrash).toHaveBeenCalledTimes(1); // teardownForRespawn's machinery ended it
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
