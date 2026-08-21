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
});

describe('WS-R1 characterization — raceSessionLoadAgainstDeadline discriminated contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("p settles (even to undefined) → {kind:'settled', value} — distinguishable from timeout", async () => {
    const { supervisor } = makeSupervisorHarness();
    const d = deferred<undefined>();
    const race = supervisor.raceSessionLoadAgainstDeadline(d.promise);
    d.resolve(undefined);
    await expect(race).resolves.toEqual({ kind: 'settled', value: undefined });
  });

  it("120s pass with p pending → {kind:'timeout'}", async () => {
    const { supervisor } = makeSupervisorHarness();
    const race = supervisor.raceSessionLoadAgainstDeadline(deferred<string>().promise);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(race).resolves.toEqual({ kind: 'timeout' });
  });

  it('rejection passthrough (not swallowed)', async () => {
    const { supervisor } = makeSupervisorHarness();
    const d = deferred<string>();
    const race = supervisor.raceSessionLoadAgainstDeadline(d.promise);
    const boom = new Error('boom');
    d.reject(boom);
    await expect(race).rejects.toBe(boom);
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
    const race = h.raceRecoveryAgainstChildExit(d.promise, client as unknown as AcpClientLike);
    d.reject(new Error('boom'));
    await expect(race).resolves.toBeUndefined();
  });

  it('exit → undefined; the pre-existing 120s deadline → undefined', async () => {
    const { supervisor } = makeSupervisorHarness();
    const h = supervisor as unknown as RaceHelpers;
    const client = new FakeSupervisorClient();
    const race = h.raceRecoveryAgainstChildExit(
      deferred<AcpLoadSessionResult | undefined>().promise,
      client as unknown as AcpClientLike,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(race).resolves.toBeUndefined();
  });
});
