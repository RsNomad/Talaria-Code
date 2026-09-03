import { describe, it, expect, vi } from 'vitest';
import { SettledProbeMemo } from './settledProbeMemo';
import type { SettledProbeMemoOpts } from './settledProbeMemo';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Settled = { tag: string };

/** Builds a memo whose probe is fully controlled by the test via a queue of
 *  deferred promises — one per `kick()`-triggered probe call. */
function makeMemo(
  overrides?: Partial<SettledProbeMemoOpts<Settled>>,
): {
  memo: SettledProbeMemo<Settled>;
  probeCalls: AbortSignal[];
  deferreds: Array<ReturnType<typeof deferred<Settled>>>;
  onSettled: ReturnType<typeof vi.fn>;
} {
  const probeCalls: AbortSignal[] = [];
  const deferreds: Array<ReturnType<typeof deferred<Settled>>> = [];
  const onSettled = vi.fn();
  const opts: SettledProbeMemoOpts<Settled> = {
    probe: (signal: AbortSignal) => {
      probeCalls.push(signal);
      const d = deferred<Settled>();
      deferreds.push(d);
      return d.promise;
    },
    onRejected: () => ({ tag: 'rejected' }),
    onSettled,
    cancellable: true,
    ...overrides,
  };
  return { memo: new SettledProbeMemo<Settled>(opts), probeCalls, deferreds, onSettled };
}

describe('SettledProbeMemo — WS-GD.2b B2 (settled-value + epoch supersession primitive)', () => {
  it('kick-once: a second kick() during flight is a no-op (probe called exactly once)', () => {
    const { memo, probeCalls } = makeMemo();
    memo.kick();
    memo.kick();
    memo.kick();
    expect(probeCalls.length).toBe(1);
  });

  it('kick() is also a no-op once settled — a later kick never re-probes', async () => {
    const { memo, probeCalls, deferreds } = makeMemo();
    memo.kick();
    deferreds[0]?.resolve({ tag: 'first' });
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toEqual({ tag: 'first' });
    memo.kick();
    expect(probeCalls.length).toBe(1);
  });

  it('rejection settles onRejected() and fires onSettled exactly once', async () => {
    const { memo, deferreds, onSettled } = makeMemo();
    memo.kick();
    deferreds[0]?.reject(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toEqual({ tag: 'rejected' });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('a settle whose epoch was superseded writes NOTHING and never fires onSettled', async () => {
    const { memo, deferreds, onSettled } = makeMemo();
    memo.kick(); // attempt #1, epoch 0
    memo.invalidate(); // bumps epoch — attempt #1 is now superseded, no re-kick
    expect(memo.value).toBeUndefined();
    deferreds[0]?.resolve({ tag: 'stale' }); // the superseded attempt settles late
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toBeUndefined(); // dropped — never written
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('invalidate() mid-flight (cancellable:true): the old attempt is inert AND its signal is aborted', () => {
    const { memo, probeCalls } = makeMemo({ cancellable: true });
    memo.kick();
    expect(probeCalls[0]?.aborted).toBe(false);
    memo.invalidate();
    expect(probeCalls[0]?.aborted).toBe(true);
  });

  it('invalidate() mid-flight (cancellable:false): the old attempt is inert but its signal is NEVER aborted — it keeps running', () => {
    const { memo, probeCalls } = makeMemo({ cancellable: false });
    memo.kick();
    expect(probeCalls[0]?.aborted).toBe(false);
    memo.invalidate();
    expect(probeCalls[0]?.aborted).toBe(false); // non-cancellable — the straggler runs on
  });

  it('rekick() starts a fresh attempt whose settle wins', async () => {
    const { memo, probeCalls, deferreds, onSettled } = makeMemo();
    memo.kick(); // attempt #1
    memo.rekick(); // supersede #1, start #2
    expect(probeCalls.length).toBe(2);
    expect(probeCalls[0]?.aborted).toBe(true); // #1 cancelled (cancellable:true)

    deferreds[0]?.resolve({ tag: 'stale' }); // #1's late settle — must be dropped
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toBeUndefined();
    expect(onSettled).not.toHaveBeenCalled();

    deferreds[1]?.resolve({ tag: 'fresh' }); // #2 wins
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toEqual({ tag: 'fresh' });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('after invalidate() the in-flight flag resets so a next kick() works (the TC-3 wedge fix)', () => {
    const { memo, probeCalls } = makeMemo();
    memo.kick(); // attempt #1, in-flight
    memo.invalidate(); // clears in-flight WITHOUT re-kicking
    expect(probeCalls.length).toBe(1); // no re-kick performed by invalidate() itself
    memo.kick(); // must NOT be a wedged no-op
    expect(probeCalls.length).toBe(2);
  });

  it('supersede() keeps the settled value readable but makes a straggler settle inert', async () => {
    const { memo, deferreds, onSettled } = makeMemo();
    memo.kick();
    deferreds[0]?.resolve({ tag: 'settled-before-supersede' });
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toEqual({ tag: 'settled-before-supersede' });
    expect(onSettled).toHaveBeenCalledTimes(1);

    // A later kick() after the value is settled is a no-op (kick-once posture)
    // regardless of supersede — but a supersede() bumps the epoch so any
    // straggler from an EARLIER in-flight attempt cannot land after it either.
    memo.supersede();
    expect(memo.value).toEqual({ tag: 'settled-before-supersede' }); // value still readable — NOT cleared
  });

  it('supersede() on an in-flight attempt (cancellable:true) aborts the signal and drops the later settle', async () => {
    const { memo, probeCalls, deferreds, onSettled } = makeMemo({ cancellable: true });
    memo.kick();
    memo.supersede();
    expect(probeCalls[0]?.aborted).toBe(true);
    deferreds[0]?.resolve({ tag: 'straggler' });
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toBeUndefined(); // dropped by the epoch guard
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('supersede() on an in-flight attempt (cancellable:false) does NOT abort — the straggler runs on but its settle is inert', async () => {
    const { memo, probeCalls, deferreds, onSettled } = makeMemo({ cancellable: false });
    memo.kick();
    memo.supersede();
    expect(probeCalls[0]?.aborted).toBe(false);
    deferreds[0]?.resolve({ tag: 'straggler' });
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toBeUndefined(); // dropped by the epoch guard, not by cancellation
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('a fresh settle after supersede() (via kick()) still wins normally', async () => {
    const { memo, deferreds, onSettled } = makeMemo();
    memo.kick();
    deferreds[0]?.resolve({ tag: 'first' });
    await Promise.resolve();
    await Promise.resolve();
    memo.supersede(); // bumps epoch without clearing the value
    memo.invalidate(); // clears the value so the next kick() actually probes again
    memo.kick();
    expect(deferreds.length).toBe(2);
    deferreds[1]?.resolve({ tag: 'second' });
    await Promise.resolve();
    await Promise.resolve();
    expect(memo.value).toEqual({ tag: 'second' });
    expect(onSettled).toHaveBeenCalledTimes(2);
  });
});
