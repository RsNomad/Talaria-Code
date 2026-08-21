import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMutationGate, MUTATION_GATE_DRAIN_DEADLINE_MS } from './mutationGate';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MutationGate — WS-R2 util (position 9.5; closes no finding by itself)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('open gate: sink passes values AND rejections through untouched', async () => {
    const gate = createMutationGate();
    await expect(gate.sink(async () => 42)).resolves.toBe(42);
    const boom = new Error('boom');
    await expect(gate.sink(async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(gate.refusedCount).toBe(0);
    expect(gate.closed).toBe(false);
  });

  it('after close(): op is NEVER invoked; resolves undefined; refusal counted', async () => {
    const gate = createMutationGate();
    void gate.close(Promise.resolve());
    const op = vi.fn(async () => 42);
    await expect(gate.sink(op)).resolves.toBeUndefined();
    expect(op).not.toHaveBeenCalled();
    expect(gate.refusedCount).toBe(1);
    expect(gate.closed).toBe(true);
  });

  it('ORDERING INVARIANT: close() flips SYNCHRONOUSLY — a sink issued while the drain is still pending is already refused', async () => {
    const gate = createMutationGate();
    const drain = deferred<void>();
    const closing = gate.close(drain.promise);
    // the drain has NOT settled — the gate must already refuse:
    const op = vi.fn(async () => 'late-mutation');
    await expect(gate.sink(op)).resolves.toBeUndefined();
    expect(op).not.toHaveBeenCalled();
    drain.resolve(undefined);
    await closing;
  });

  it('DISPOSE-BETWEEN-SINKS: close() landing between two caller-sequenced sinks refuses the second, the first completed', async () => {
    const gate = createMutationGate();
    const first = await gate.sink(async () => 'store-op-done');
    void gate.close(Promise.resolve());
    const second = vi.fn(async () => 'manifest-op');
    await expect(gate.sink(second)).resolves.toBeUndefined();
    expect(first).toBe('store-op-done');
    expect(second).not.toHaveBeenCalled();
    expect(gate.refusedCount).toBe(1);
  });

  it('close() awaits the drain (settles only after the drain settles, pre-deadline)', async () => {
    const gate = createMutationGate();
    const drain = deferred<void>();
    let settled = false;
    const closing = gate.close(drain.promise).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    drain.resolve(undefined);
    await closing;
    expect(settled).toBe(true);
  });

  it('a NEVER-settling drain is bounded by MUTATION_GATE_DRAIN_DEADLINE_MS', async () => {
    const gate = createMutationGate();
    let settled = false;
    const closing = gate.close(new Promise<never>(() => {})).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(MUTATION_GATE_DRAIN_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toBe(true);
  });

  it('a REJECTED drain never rejects close()', async () => {
    const gate = createMutationGate();
    await expect(gate.close(Promise.reject(new Error('drain boom')))).resolves.toBeUndefined();
  });

  it('idempotent: the second close() returns the FIRST close completion; the gate stays closed', async () => {
    const gate = createMutationGate();
    const drain = deferred<void>();
    const first = gate.close(drain.promise);
    const second = gate.close(Promise.resolve()); // different drain — ignored, first close wins
    expect(second).toBe(first);
    drain.resolve(undefined);
    await first;
    expect(gate.closed).toBe(true);
  });

  it('custom drainDeadlineMs overrides the default', async () => {
    const gate = createMutationGate({ drainDeadlineMs: 500 });
    let settled = false;
    const closing = gate.close(new Promise<never>(() => {})).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect(settled).toBe(true);
  });
});
