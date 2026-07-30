import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControlChannel } from './ControlChannel';
import type { ControlTransport, ControlTransportFactory } from './ControlChannel';
import type { JsonRpcStdioOptions } from '../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import { must } from '../../testing/must';

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
 * `hermesPath` is set — see `runtime/resolveHermes.ts`. */
const CONFIG: HermesRuntimeConfig = { hermesPath: '/fake/venv/bin/hermes' };

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
