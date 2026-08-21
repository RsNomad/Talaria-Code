// src/host/backend/connection/settleRace.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { settleRace } from './settleRace';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal ExitSource fake — exposes the live-subscription count so tests can
 * pin "the exit sub is disposed on EVERY settle path". */
function makeExitSource(): {
  source: { onExit(cb: (code: number | null) => void): { dispose(): void } };
  fire(code: number | null): void;
  liveSubs(): number;
} {
  const handlers = new Set<(code: number | null) => void>();
  return {
    source: {
      onExit(cb) {
        handlers.add(cb);
        return { dispose: () => void handlers.delete(cb) };
      },
    },
    fire(code) {
      for (const h of [...handlers]) h(code);
    },
    liveSubs: () => handlers.size,
  };
}

/** Sync-firing ExitSource test double — invokes its callback SYNCHRONOUSLY,
 * from inside `onExit()` itself, before `onExit` has returned a handle to
 * the caller. No real seam (`AcpClient.onExit` / `JsonRpcStdio.onExit`) does
 * this — both are async-only — but `settleRace` is a generic primitive and
 * must not leak a subscription (or arm a now-orphaned deadline timer) even
 * under this adversarial shape. */
function makeSyncFiringExitSource(code: number | null): {
  source: { onExit(cb: (code: number | null) => void): { dispose(): void } };
  disposeSpy: ReturnType<typeof vi.fn>;
} {
  const disposeSpy = vi.fn();
  return {
    source: {
      onExit(cb) {
        cb(code); // fires BEFORE onExit() returns — the handle isn't assigned yet
        return { dispose: disposeSpy };
      },
    },
    disposeSpy,
  };
}

/** Runs an assertion that no `unhandledRejection` was emitted by Node while
 * `act` executed. Deterministic teeth for "the internal rejection handler
 * is actually attached": if `settleRace` ever dropped its `onRejected`
 * handler on `p`, the resulting derived (unreferenced) promise would surface
 * here. `process.nextTick`/native Promise microtasks are NOT faked by
 * `vi.useFakeTimers()` (its default `toFake` excludes `nextTick` and
 * `queueMicrotask`), so real unhandled-rejection detection still runs. */
async function expectNoUnhandledRejection(act: () => Promise<void> | void): Promise<void> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await act();
    // Flush the real microtask queue across several turns so a same-tick
    // unhandled rejection (Node reports it after the microtask checkpoint)
    // has a chance to surface before we assert.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(seen).toEqual([]);
}

describe('settleRace — WS-R1 primitive contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('value passthrough: p resolves → {kind:"value"}; exit sub disposed; deadline timer cleared (fast path)', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 5_000 });
    expect(exit.liveSubs()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    d.resolve('ok');
    await expect(race).resolves.toEqual({ kind: 'value', value: 'ok' });
    expect(exit.liveSubs()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejection passthrough: p rejects → the race rejects with the SAME error; cleanup still runs', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 5_000 });
    const boom = new Error('boom');
    d.reject(boom);
    await expect(race).rejects.toBe(boom);
    expect(exit.liveSubs()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exit wins → {kind:"exit"}; sub disposed; timer cleared', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 5_000 });
    exit.fire(1);
    await expect(race).resolves.toEqual({ kind: 'exit' });
    expect(exit.liveSubs()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sync-firing ExitSource: onExit fires cb synchronously during subscribe → exit still wins AND the handle is disposed (no leak, no orphaned deadline timer)', async () => {
    const { source, disposeSpy } = makeSyncFiringExitSource(1);
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: source, deadline: 5_000 });
    await expect(race).resolves.toEqual({ kind: 'exit' });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deadline wins → {kind:"deadline"}; sub disposed; timer cleared', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(race).resolves.toEqual({ kind: 'deadline' });
    expect(exit.liveSubs()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadline: 'none' → NO timer is ever created", async () => {
    const d = deferred<string>();
    const race = settleRace(d.promise, { deadline: 'none' });
    expect(vi.getTimerCount()).toBe(0);
    d.resolve('ok');
    await expect(race).resolves.toEqual({ kind: 'value', value: 'ok' });
  });

  it('no exit source → deadline still races (no crash on the optional `exit` guard)', async () => {
    const d = deferred<string>();
    const race = settleRace(d.promise, { deadline: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(race).resolves.toEqual({ kind: 'deadline' });
  });

  it('settle-once: exit fires first, a belated p RESOLUTION is discarded (outcome stays exit)', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 'none' });
    exit.fire(null);
    d.resolve('belated');
    await expect(race).resolves.toEqual({ kind: 'exit' });
  });

  it('settle-once: exit fires first, a belated p REJECTION is discarded (no unhandled rejection, outcome stays exit)', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 'none' });
    exit.fire(null);
    await expect(race).resolves.toEqual({ kind: 'exit' });

    await expectNoUnhandledRejection(() => {
      d.reject(new Error('belated'));
    });
    // Outcome is unchanged by the belated rejection — re-assert against the
    // SAME already-settled promise.
    await expect(race).resolves.toEqual({ kind: 'exit' });
  });

  it('settle-once: deadline fires first, a belated p REJECTION is discarded (no unhandled rejection, outcome stays deadline)', async () => {
    const d = deferred<string>();
    const race = settleRace(d.promise, { deadline: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(race).resolves.toEqual({ kind: 'deadline' });
    expect(vi.getTimerCount()).toBe(0);

    // Teeth: if settleRace ever dropped its `onRejected` handler on `p`,
    // this belated rejection would surface as a real unhandledRejection —
    // proven via a live `process.on('unhandledRejection', …)` listener, not
    // an implicit "the test didn't crash" inference.
    await expectNoUnhandledRejection(() => {
      d.reject(new Error('belated'));
    });
    // Outcome is unchanged by the belated rejection — re-assert against the
    // SAME already-settled promise.
    await expect(race).resolves.toEqual({ kind: 'deadline' });
  });

  it('settle-once: deadline fires first, a belated p RESOLUTION is discarded (outcome stays deadline)', async () => {
    const d = deferred<string>();
    const race = settleRace(d.promise, { deadline: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(race).resolves.toEqual({ kind: 'deadline' });
    d.resolve('belated');
    await expect(race).resolves.toEqual({ kind: 'deadline' });
  });
});
