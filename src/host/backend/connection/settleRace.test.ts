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

  it('deadline wins → {kind:"deadline"}; sub disposed', async () => {
    const exit = makeExitSource();
    const d = deferred<string>();
    const race = settleRace(d.promise, { exit: exit.source, deadline: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(race).resolves.toEqual({ kind: 'deadline' });
    expect(exit.liveSubs()).toBe(0);
  });

  it("deadline: 'none' → NO timer is ever created", async () => {
    const d = deferred<string>();
    const race = settleRace(d.promise, { deadline: 'none' });
    expect(vi.getTimerCount()).toBe(0);
    d.resolve('ok');
    await expect(race).resolves.toEqual({ kind: 'value', value: 'ok' });
  });

  it('no exit source → exit can never win; deadline still races', async () => {
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

  it('settle-once: deadline fires first, a belated p REJECTION is discarded (no unhandled rejection, outcome stays deadline)', async () => {
    const d = deferred<string>();
    const race = settleRace(d.promise, { deadline: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(race).resolves.toEqual({ kind: 'deadline' });
    // The belated rejection is handled by the (already-settled) internal
    // handler — this line would trigger an unhandled-rejection crash in the
    // worker if settleRace had not attached one.
    d.reject(new Error('belated'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
