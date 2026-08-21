import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControlChannel } from './ControlChannel';
import type { ControlTransport, ControlTransportFactory } from './ControlChannel';
import type { JsonRpcStdioOptions, Logger } from '../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import { must } from '../../testing/must';
import { respawnBackoffMs } from './respawnBackoff';
import type { RespawnHealth } from './respawnHealth';

/**
 * Fake {@link ControlTransport} the tests drive by hand — no child process,
 * no real timers required for its own behaviour. Standing in for
 * `JsonRpcStdio`, whose public surface it mirrors structurally.
 */
class FakeTransport implements ControlTransport {
  disposed = false;
  requests: Array<{ method: string; params?: unknown }> = [];
  /** Override per-test to control what `request()` resolves/rejects with. */
  requestImpl: (method: string, params?: unknown) => Promise<unknown> = async () =>
    undefined;

  private readonly eventHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.requestImpl(method, params) as Promise<T>;
  }

  onEvent(handler: (method: string, params: unknown) => void) {
    this.eventHandlers.add(handler);
    return { dispose: () => this.eventHandlers.delete(handler) };
  }

  onExit(handler: (code: number | null) => void) {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Test helper: simulate an inbound notification frame. */
  emit(method: string, params: unknown): void {
    for (const h of [...this.eventHandlers]) h(method, params);
  }

  /** Test helper: simulate the child process exiting. */
  exit(code: number | null): void {
    for (const h of [...this.exitHandlers]) h(code);
  }
}

/** `resolveHermes` resolves real fields with no OS calls as long as
 * `hermesPath` AND `pythonPath` are both set — see `runtime/resolveHermes.ts`.
 * (AU-7/INV-9: an unset `pythonPath` now derives via realpath + an
 * existence-check against the real FS, which a fake path would fail; these
 * tests are about respawn/timer/disposal behavior, not python derivation, so
 * `pythonPath` is pinned to opt out of that new codepath entirely — the same
 * "pin both settings" shape Setup-flow installs use in production.) */
const CONFIG: HermesRuntimeConfig = {
  hermesPath: '/fake/venv/bin/hermes',
  pythonPath: '/fake/venv/bin/python',
};

function makeFactory(): { factory: ControlTransportFactory; transports: FakeTransport[] } {
  const transports: FakeTransport[] = [];
  const factory: ControlTransportFactory = (_options: JsonRpcStdioOptions) => {
    const t = new FakeTransport();
    transports.push(t);
    return t;
  };
  return { factory, transports };
}

const GATEWAY_READY = { type: 'gateway.ready', payload: { skin: 'default' } };

/**
 * `ControlChannel.start()` reaches the point where it constructs the
 * transport only after `resolveHermes()`'s internal awaits settle (real
 * microtask hops, unrelated to any fake timer). Draining a handful of
 * microtask ticks with real timers active makes the transport-construction
 * deterministic before a test touches `transports[N]`.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

/** Same idea, for tests running under `vi.useFakeTimers()` — advancing by 0ms
 * still drains the interleaved real-Promise microtask queue. */
async function flushMicrotasksFake(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('ControlChannel.start', () => {
  it('resolves once the transport emits the gateway.ready event frame', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasks();
    expect(transports).toHaveLength(1);
    must(transports[0]).emit('event', GATEWAY_READY);

    await expect(startPromise).resolves.toBeUndefined();
    channel.dispose();
  });

  it('ignores non-ready event frames and other notification methods before resolving', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).emit('event', { type: 'message.delta', payload: {} });
    must(transports[0]).emit('somethingElse', { type: 'gateway.ready' });

    let settled = false;
    void startPromise.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    must(transports[0]).emit('event', GATEWAY_READY);
    await expect(startPromise).resolves.toBeUndefined();
    channel.dispose();
  });

  it('rejects and disposes the transport if the child exits before gateway.ready', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).exit(1);

    await expect(startPromise).rejects.toThrow(/exited/i);
    expect(must(transports[0]).disposed).toBe(true);
    channel.dispose();
  });

  it('times out waiting for gateway.ready after ~15s', async () => {
    vi.useFakeTimers();
    try {
      const { factory, transports } = makeFactory();
      const channel = new ControlChannel(CONFIG, undefined, factory);

      const startPromise = channel.start();
      const assertion = expect(startPromise).rejects.toThrow(/timed out/i);
      await flushMicrotasksFake(); // let the transport + 15s timer get registered
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(must(transports[0]).disposed).toBe(true);
      channel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second concurrent start() call shares the same in-flight attempt', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const first = channel.start();
    const second = channel.start();
    await flushMicrotasks();
    expect(transports).toHaveLength(1); // no duplicate spawn

    must(transports[0]).emit('event', GATEWAY_READY);
    await Promise.all([first, second]);
    channel.dispose();
  });

  it('start() resolves immediately once already ready, without spawning again', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    await channel.start();
    expect(transports).toHaveLength(1);
    channel.dispose();
  });
});

describe('ControlChannel.dispatch', () => {
  it('throws if called before start() has connected', async () => {
    const { factory } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);
    await expect(channel.dispatch('tools.list')).rejects.toThrow(/not connected/i);
    channel.dispose();
  });

  it('delegates to the transport once connected and returns its result', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    must(transports[0]).requestImpl = async (method, params) => ({ echo: method, params });
    const result = await channel.dispatch('tools.list', { session_id: 'sess-1' });

    expect(result).toEqual({ echo: 'tools.list', params: { session_id: 'sess-1' } });
    expect(must(transports[0]).requests).toContainEqual({
      method: 'tools.list',
      params: { session_id: 'sess-1' },
    });
    channel.dispose();
  });

  it('throws after dispose()', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);
    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    channel.dispose();
    await expect(channel.dispatch('tools.list')).rejects.toThrow(/disposed/i);
  });
});

describe('ControlChannel.onEvent', () => {
  it('fans out well-formed event frames as (type, payload)', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);
    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    const received: Array<[string, unknown]> = [];
    const sub = channel.onEvent((type, payload) => received.push([type, payload]));

    must(transports[0]).emit('event', {
      type: 'message.delta',
      session_id: 's1',
      payload: { text: 'hi' },
    });
    must(transports[0]).emit('somethingElse', { type: 'should.be.ignored' }); // wrong outer method
    must(transports[0]).emit('event', { payload: {} }); // missing type

    expect(received).toEqual([['message.delta', { text: 'hi' }]]);

    sub.dispose();
    must(transports[0]).emit('event', { type: 'message.delta', payload: {} });
    expect(received).toHaveLength(1); // no more deliveries after dispose

    channel.dispose();
  });

  it('a handler throwing does not prevent other handlers from running', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);
    const startPromise = channel.start();
    await flushMicrotasks();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    channel.onEvent(() => {
      throw new Error('boom');
    });
    const received: string[] = [];
    channel.onEvent((type) => received.push(type));

    must(transports[0]).emit('event', { type: 'tool.start', payload: {} });
    expect(received).toEqual(['tool.start']);
    channel.dispose();
  });
});

describe('ControlChannel crash-respawn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('respawns after an unexpected exit and keeps subscribers wired to the new transport', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasksFake();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    const received: string[] = [];
    channel.onEvent((type) => received.push(type));

    // Crash.
    must(transports[0]).exit(1);
    expect(transports).toHaveLength(1); // respawn is scheduled, not immediate

    // First backoff attempt is 500ms (respawnBackoffMs(1)).
    await vi.advanceTimersByTimeAsync(500);
    expect(transports).toHaveLength(2);

    must(transports[1]).emit('event', GATEWAY_READY);
    await flushMicrotasksFake();

    // Subscriber registered before the crash still receives events from the
    // NEW transport — subscribers are channel-scoped, not transport-scoped.
    must(transports[1]).emit('event', { type: 'session.info', payload: {} });
    expect(received).toEqual(['session.info']);

    // dispatch() now goes to the new transport.
    must(transports[1]).requestImpl = async () => ({ ok: true });
    await expect(channel.dispatch('session.status')).resolves.toEqual({ ok: true });

    channel.dispose();
  });

  /**
   * Review follow-up on TE-1 (AU-12): every other exit/respawn test here
   * drives `exit(1)` — a numeric exit code. `JsonRpcStdio`'s `'error'`-only
   * termination path (no following `'exit'` at all — e.g. a post-ready
   * transport failure) fans `onExit` with `code = null` instead. This pins
   * that `ControlChannel.handleCrash(null)` treats a null code exactly like
   * a numeric one: it schedules a respawn rather than staying wedged in
   * `'ready'` on a dead transport. Test-only — no ControlChannel production
   * code changed; `FakeTransport.exit()` already accepts `number | null`.
   */
  it('respawns after a null-code (error-only) termination, same as a numeric exit code', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasksFake();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    // Error-only termination: no exit code was ever produced.
    must(transports[0]).exit(null);
    expect(transports).toHaveLength(1); // respawn is scheduled, not immediate

    // First backoff attempt is 500ms (respawnBackoffMs(1)).
    await vi.advanceTimersByTimeAsync(500);
    expect(transports).toHaveLength(2);

    must(transports[1]).emit('event', GATEWAY_READY);
    await flushMicrotasksFake();
    channel.dispose();
  });

  it('backs off exponentially across repeated failed respawn attempts', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasksFake();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    must(transports[0]).exit(1); // attempt 1 scheduled at 500ms
    await vi.advanceTimersByTimeAsync(500);
    expect(transports).toHaveLength(2);

    must(transports[1]).exit(1); // attempt 2 scheduled at 1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(transports).toHaveLength(2); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(transports).toHaveLength(3);

    must(transports[2]).emit('event', GATEWAY_READY);
    await flushMicrotasksFake();
    channel.dispose();
  });

  it('does not schedule a respawn once disposed', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasksFake();
    must(transports[0]).emit('event', GATEWAY_READY);
    await startPromise;

    channel.dispose();
    must(transports[0]).exit(1);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(transports).toHaveLength(1); // no respawn after dispose
  });
});

describe('ControlChannel respawn/dispose races (CF-01 / L6 I-4, I-5)', () => {
  it('start() during an armed respawn backoff timer leaves no stale timer to double-spawn', async () => {
    vi.useFakeTimers();
    try {
      const { factory, transports } = makeFactory();
      const channel = new ControlChannel(CONFIG, undefined, factory);

      const startPromise = channel.start();
      await flushMicrotasksFake();
      must(transports[0]).emit('event', GATEWAY_READY);
      await startPromise;

      // Crash schedules a respawn attempt at 500ms (respawnBackoffMs(1)).
      must(transports[0]).exit(1);
      expect(transports).toHaveLength(1);

      // Well before the backoff elapses, an explicit start() re-arms a fresh
      // spawn attempt of its own (state is 'respawning', not 'ready', so
      // start() proceeds rather than returning early).
      await vi.advanceTimersByTimeAsync(100);
      const restartPromise = channel.start();
      await flushMicrotasksFake();
      expect(transports).toHaveLength(2); // the explicit start()'s spawn

      // Advance PAST the ORIGINAL 500ms backoff deadline (100 + 500 = 600).
      // A stale (uncleared) respawn timer fires attemptRespawn() here and
      // spawns a THIRD transport — that's the bug: start() must clear
      // `respawnTimer` so this stale callback never runs.
      await vi.advanceTimersByTimeAsync(500);
      expect(transports).toHaveLength(2); // stale timer must NOT double-spawn

      must(transports[1]).emit('event', GATEWAY_READY);
      await restartPromise;
      channel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() clears an armed respawn-backoff timer via clearRespawnTimer() (white-box: pins the mechanism, not just the outcome)', async () => {
    // The test above proves the *outcome* (no double-spawn), but it passes
    // with EITHER fix present alone: `attemptRespawn`'s
    // `pendingReady || state === 'ready'` guard already suppresses the stale
    // timer's callback in that test's timing (a fresh `pendingReady` is set
    // by the explicit `start()` before the original timer's deadline is
    // reached), so it can't distinguish "start() calls clearRespawnTimer()"
    // from "attemptRespawn() happens to no-op". This test asserts on the
    // timer directly, synchronously, before the attemptRespawn guard could
    // ever come into play.
    vi.useFakeTimers();
    try {
      const { factory, transports } = makeFactory();
      const channel = new ControlChannel(CONFIG, undefined, factory);

      const startPromise = channel.start();
      await flushMicrotasksFake();
      must(transports[0]).emit('event', GATEWAY_READY);
      await startPromise;

      // Crash arms exactly one pending timer: scheduleRespawn()'s backoff.
      must(transports[0]).exit(1);
      expect(vi.getTimerCount()).toBe(1);

      // Call start() but deliberately do NOT await or advance time yet.
      // `start()` has no `await` of its own, and `spawnAndAwaitReady()`'s
      // first line (`await resolveHermes(...)`) resolves via microtasks
      // only (CONFIG.hermesPath is set, so `resolveHermesBin` never touches
      // a timer) — so the ENTIRE synchronous prefix of this call, including
      // `this.clearRespawnTimer()`, runs before control returns here, and
      // the READY_TIMEOUT_MS handshake timer (armed later, inside
      // `awaitReady()`) has NOT been created yet. At this exact instant the
      // only timer that could possibly be pending is the original
      // respawn-backoff timeout from the crash above.
      const restartPromise = channel.start();
      expect(vi.getTimerCount()).toBe(0); // the armed respawn timer was cleared

      await flushMicrotasksFake();
      expect(transports).toHaveLength(2); // the explicit start()'s own spawn
      must(transports[1]).emit('event', GATEWAY_READY);
      await restartPromise;
      channel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() during the ready handshake does not resurrect to ready and disposes the freshly-spawned transport', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    await flushMicrotasks();
    expect(transports).toHaveLength(1);

    // dispose() races the in-flight handshake — the ready event arrives
    // AFTER dispose() has already run.
    channel.dispose();
    must(transports[0]).emit('event', GATEWAY_READY);

    await expect(startPromise).rejects.toThrow(/disposed/i);
    expect(must(transports[0]).disposed).toBe(true); // no orphaned child

    // Must stay disposed — never resurrected to 'ready' by the late handshake.
    await expect(channel.dispatch('tools.list')).rejects.toThrow(/disposed/i);
  });

  it('dispose() racing the resolveHermes() await aborts before any transport is spawned', async () => {
    // Covers the EARLIER disposed re-check in `spawnAndAwaitReady()`
    // (right after `await resolveHermes(...)`, before the transport is
    // constructed) — distinct from the test above, which races dispose()
    // against the LATER re-check (after the transport exists and the
    // handshake is in flight). Here `transports` must stay empty: a
    // disposed channel must never spawn a process at all.
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const startPromise = channel.start();
    // No await/flush here: `start()` has no `await` of its own, and
    // `spawnAndAwaitReady()`'s first line pauses at `await
    // resolveHermes(this.config)`, which resolves via microtasks only
    // (CONFIG.hermesPath is set, so `resolveHermesBin` never touches a
    // timer). So calling `dispose()` synchronously right after `start()`
    // lands strictly BEFORE `resolveHermes()`'s await settles and strictly
    // BEFORE the transport is created — exactly the CF-01/I-5 window.
    channel.dispose();

    await expect(startPromise).rejects.toThrow(/disposed/i);
    expect(transports).toHaveLength(0); // no transport spawned for a disposed channel
    await expect(channel.dispatch('tools.list')).rejects.toThrow(/disposed/i);
  });
});

describe('WS-R3 F2-19 — ControlChannel.onHealth transitions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Drive one FAILED respawn attempt: backoff fires, spawn resolves, the
   * 15s ready-handshake times out, the failure schedules the next attempt. */
  async function failOneAttempt(attempt: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(attempt)); // backoff → attemptRespawn → spawn
    await vi.advanceTimersByTimeAsync(15_000); // READY_TIMEOUT_MS — handshake fails
  }

  it('degraded at attempt 5, down at attempt 10 — transition-only; ok on recovery', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);
    const health: RespawnHealth[] = [];
    channel.onHealth((h) => health.push(h));

    const start = channel.start();
    await vi.advanceTimersByTimeAsync(0);
    must(transports[0]).emit('event', GATEWAY_READY); // healthy boot
    await start;

    must(transports[0]).exit(1); // crash → attempt 1 scheduled
    for (let attempt = 1; attempt <= 10; attempt++) {
      await failOneAttempt(attempt);
    }
    expect(health).toEqual([
      { state: 'degraded', attempts: 5 },
      { state: 'down', attempts: 10 },
    ]);

    // Recovery: the NEXT scheduled attempt gets a ready handshake.
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(11));
    must(transports[transports.length - 1]).emit('event', GATEWAY_READY);
    await vi.advanceTimersByTimeAsync(0);
    expect(health[health.length - 1]).toEqual({ state: 'ok', attempts: 0 });
    expect(health).toHaveLength(3); // strictly transition-only
  });

  it('a throwing health subscriber never breaks the loop or its siblings', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);
    const seen: RespawnHealth[] = [];
    channel.onHealth(() => {
      throw new Error('subscriber boom');
    });
    channel.onHealth((h) => seen.push(h));
    const start = channel.start();
    await vi.advanceTimersByTimeAsync(0);
    must(transports[0]).emit('event', GATEWAY_READY);
    await start;
    must(transports[0]).exit(1);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await failOneAttempt(attempt);
    }
    expect(seen).toEqual([{ state: 'degraded', attempts: 5 }]);
  });

  it('currentHealth() reflects the LIVE state for a late subscriber, not the frozen last-transition payload (arch review Important-1)', async () => {
    const { factory, transports } = makeFactory();
    const channel = new ControlChannel(CONFIG, undefined, factory);

    const start = channel.start();
    await vi.advanceTimersByTimeAsync(0);
    must(transports[0]).emit('event', GATEWAY_READY);
    await start;

    expect(channel.currentHealth()).toEqual({ state: 'ok', attempts: 0 });

    must(transports[0]).exit(1); // crash → attempt 1 scheduled
    for (let attempt = 1; attempt <= 10; attempt++) {
      await failOneAttempt(attempt);
    }

    // A subscriber that registers only NOW — e.g. a webview panel lazily
    // revealed after the outage already happened — must be able to recover
    // the current state instead of defaulting to 'ok' from having heard no
    // transition yet. (respawnAttempts is 11 here: the loop above drove
    // attempts 1..10 to fire AND fail, and processing attempt 10's failure
    // already scheduled attempt 11 — same count the pre-existing
    // "degraded at 5, down at 10" test's own recovery step uses.)
    expect(channel.currentHealth()).toEqual({ state: 'down', attempts: 11 });

    // Prove it's LIVE, not a frozen last-transition payload: one more
    // failed attempt bumps the real count while onHealth itself stays
    // silent (transition-only — still no 3rd event, still 'down').
    await failOneAttempt(11);
    expect(channel.currentHealth()).toEqual({ state: 'down', attempts: 12 });

    channel.dispose();
  });

  it('a subscriber that throws at the down transition, whose own error-log call ALSO throws, still lets the next attempt run (F2-19a — no escaping error can kill the self-heal loop; concurrency review Minor-1/2)', async () => {
    const { factory, transports } = makeFactory();
    // Simulates the compound escape the concurrency review named: the
    // per-handler `catch` in `emitHealth` tries to log via `this.log`
    // (`logger.append`), and the logger itself throws for that exact
    // message — a failure mode a plain try/catch around the subscriber
    // alone cannot neutralize.
    const throwingLogger: Logger = {
      append(line: string) {
        if (line.includes('health handler threw')) {
          throw new Error('logger boom (compound failure)');
        }
      },
    };
    const channel = new ControlChannel(CONFIG, throwingLogger, factory);
    channel.onHealth((h) => {
      if (h.state === 'down') throw new Error('subscriber boom at down');
    });

    const start = channel.start();
    await vi.advanceTimersByTimeAsync(0);
    must(transports[0]).emit('event', GATEWAY_READY);
    await start;

    must(transports[0]).exit(1); // crash → attempt 1 scheduled
    // Attempts 1..9 are ordinary (no transition below the 'degraded'==5 /
    // 'down'==10 thresholds crossed here, since 'degraded' at 5 doesn't
    // throw). Processing attempt 9's failure calls scheduleRespawn(10) —
    // respawnAttempts crosses the 'down' threshold, which is exactly where
    // the throwing subscriber AND the throwing logger both fire.
    for (let attempt = 1; attempt <= 9; attempt++) {
      await failOneAttempt(attempt);
    }
    expect(transports).toHaveLength(10); // initial spawn + attempts 1..9

    // The compound escape above must not have prevented attempt 10's
    // backoff timer from being armed and firing.
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(10));
    expect(transports).toHaveLength(11); // attempt 10 actually spawned — loop survives

    must(transports[10]).emit('event', GATEWAY_READY); // let it recover cleanly
    await vi.advanceTimersByTimeAsync(0);
    channel.dispose();
  });
});

describe('ControlChannel.log() — guarded against a throwing logger on the crash/respawn path (F2-19a IMPORTANT-1, concurrency re-review)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a logger whose append() always throws does not silently kill the self-heal loop across repeated crash/respawn cycles', async () => {
    const { factory, transports } = makeFactory();
    // Models a bad/disposed vscode.OutputChannel: EVERY append() throws,
    // unconditionally — unlike the existing compound-throw test above, which
    // only throws for one specific message.
    const throwingLogger: Logger = {
      append() {
        throw new Error('logger boom (disposed OutputChannel)');
      },
    };
    const channel = new ControlChannel(CONFIG, throwingLogger, factory);

    const start = channel.start();
    await vi.advanceTimersByTimeAsync(0);
    must(transports[0]).emit('event', GATEWAY_READY);
    await start;

    // Crash: handleCrash() calls this.log() BEFORE scheduleRespawn() runs
    // (ControlChannel.ts ~L380). Pre-fix, the unguarded `logger?.append`
    // throw escapes handleCrash entirely — synchronously, through the
    // FakeTransport.exit() dispatch loop, right out to this call — leaving
    // the channel a zombie (state stuck at 'ready', transport undefined)
    // that never respawns.
    expect(() => must(transports[0]).exit(1)).not.toThrow();

    // Attempt 1's backoff must have been armed despite the throw above —
    // scheduleRespawn()'s OWN log() call (~L389) is the 2nd unguarded site
    // on this path.
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(1));
    expect(transports).toHaveLength(2); // respawn actually spawned — loop alive

    // Let attempt 1's handshake time out so attemptRespawn()'s catch handler
    // runs its own this.log() call (~L421, the 3rd unguarded site) before
    // scheduling attempt 2 — must not stall the loop either.
    await vi.advanceTimersByTimeAsync(15_000); // READY_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(respawnBackoffMs(2));
    expect(transports).toHaveLength(3); // attempt 2 actually spawned

    // Full self-heal: the loop can still reach 'ready' again.
    must(transports[2]).emit('event', GATEWAY_READY);
    await vi.advanceTimersByTimeAsync(0);
    await expect(channel.dispatch('tools.list')).resolves.toBeUndefined();

    channel.dispose();
  });
});
