import { describe, it, expect } from 'vitest';
import { SequentialQueue } from './sequentialQueue';

/**
 * The toggle serializer (W1.5): parallel dashboard toggles race the config.yaml
 * read-modify-write, so a burst must run strictly one at a time. These prove the
 * ordering guarantee and that one failure does not poison the queue for later
 * tasks — while the failing task's own rejection is still observable (rollback).
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SequentialQueue', () => {
  it('runs tasks one at a time in submission order — the 2nd starts only after the 1st settles', async () => {
    const q = new SequentialQueue();
    const started: number[] = [];
    const first = deferred<void>();

    const p1 = q.run(async () => {
      started.push(1);
      await first.promise;
    });
    const p2 = q.run(async () => {
      started.push(2);
    });

    // Let microtasks flush: task 1 has started, task 2 is still queued.
    await Promise.resolve();
    expect(started).toEqual([1]);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(started).toEqual([1, 2]);
  });

  it('surfaces a task rejection to its own caller AND keeps running later tasks', async () => {
    const q = new SequentialQueue();
    const ran: string[] = [];

    const failing = q.run(async () => {
      ran.push('a');
      throw new Error('boom');
    });
    const following = q.run(async () => {
      ran.push('b');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom'); // caller observes the failure (→ rollback)
    await expect(following).resolves.toBe('ok'); // chain not poisoned
    expect(ran).toEqual(['a', 'b']);
  });
});
