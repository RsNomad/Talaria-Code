import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toZeroBasedPosition,
  withDeadline,
  createIndexingTracker,
  LruCache,
  createConcurrencyPool,
  extractSnippet,
  buildConfinementVerdict,
} from './toolPipeline';
import type { PositionInput, RealpathConfiner } from './toolPipeline';
import type { PlainRange } from './resultShaper';
import { must } from '../../testing/must';

/**
 * W3 (LIB) · T6a tests — the pure/injectable pipeline primitives (research
 * doc §5.1/§5.2, brief `w3-t6a-brief.md`). Exhaustive per the brief's test
 * matrix: 1-based↔0-based boundary, deadline race (no timer leak, real
 * rejection propagation), first-empty indexing policy, bounded LRU, bounded
 * concurrency pool (the bound + finally-release-on-rejection are the
 * reviewed crux), pure snippet extraction, fail-closed confinement verdict.
 *
 * Concurrency/deadline tests are deterministic: fake timers for the deadline
 * race, hand-rolled deferred promises + microtask-flush loops (NOT real
 * sleeps) for the pool. No `setTimeout`-based waiting is ever used to prove
 * a concurrency property in this file.
 */

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function pos(line: number, character: number) {
  return { line, character };
}

function range(startLine: number, startChar: number, endLine: number, endChar: number): PlainRange {
  return { start: pos(startLine, startChar), end: pos(endLine, endChar) };
}

/** A controllable promise, without `!` non-null assertions — the executor
 * runs synchronously, so `box.resolve`/`box.reject` are always assigned by
 * the time this function returns. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  const box: { resolve?: (value: T) => void; reject?: (reason: unknown) => void } = {};
  const promise = new Promise<T>((res, rej) => {
    box.resolve = res;
    box.reject = rej;
  });
  return {
    promise,
    resolve: (value: T) => box.resolve?.(value),
    reject: (reason: unknown) => box.reject?.(reason),
  };
}

/** Deterministically drains the microtask queue N times — NOT a sleep (no
 * real time passes, no timer involved), just repeated `await
 * Promise.resolve()` to let an already-scheduled promise chain fully settle
 * before the next assertion. */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// toZeroBasedPosition — R7.2/R7.3
// ---------------------------------------------------------------------------

describe('toZeroBasedPosition', () => {
  it('converts the 1-based wire boundary 1,1 to 0-based 0,0', () => {
    expect(toZeroBasedPosition({ line: 1, character: 1 })).toEqual({
      ok: true,
      position: { line: 0, character: 0 },
    });
  });

  it('converts an arbitrary in-range 1-based position', () => {
    expect(toZeroBasedPosition({ line: 5, character: 10 })).toEqual({
      ok: true,
      position: { line: 4, character: 9 },
    });
  });

  const badInputs: ReadonlyArray<[string, PositionInput]> = [
    ['line 0', { line: 0, character: 1 }],
    ['line -1', { line: -1, character: 1 }],
    ['line 1.5', { line: 1.5, character: 1 }],
    ['line NaN', { line: NaN, character: 1 }],
    ['line Infinity', { line: Infinity, character: 1 }],
    ['line -Infinity', { line: -Infinity, character: 1 }],
    ['character 0', { line: 1, character: 0 }],
    ['character -1', { line: 1, character: -1 }],
    ['character 1.5', { line: 1, character: 1.5 }],
    ['character NaN', { line: 1, character: NaN }],
    ['character Infinity', { line: 1, character: Infinity }],
  ];

  for (const [label, input] of badInputs) {
    it(`refuses ${label} with a typed, non-empty reason (never throws)`, () => {
      let result: ReturnType<typeof toZeroBasedPosition> | undefined;
      expect(() => {
        result = toZeroBasedPosition(input);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result !== undefined && !result.ok) {
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// withDeadline — Promise.race, no timer leak, propagates real rejections
// ---------------------------------------------------------------------------

describe('withDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves ok with the work value when work settles before the deadline', async () => {
    const work = () => Promise.resolve('fast-value');
    await expect(withDeadline(work, 1000)).resolves.toEqual({ status: 'ok', value: 'fast-value' });
  });

  it('resolves timeout when work has not settled by the deadline', async () => {
    const never = deferred<string>();
    const promise = withDeadline(() => never.promise, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toEqual({ status: 'timeout' });
  });

  it('propagates a real work() rejection instead of swallowing it into a timeout', async () => {
    const work = () => Promise.reject(new Error('provider exploded'));
    await expect(withDeadline(work, 1000)).rejects.toThrow('provider exploded');
  });

  it('propagates a synchronous throw from work() as a rejection (never leaks the timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const work = (): Promise<string> => {
      throw new Error('sync boom');
    };
    await expect(withDeadline(work, 1000)).rejects.toThrow('sync boom');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears the deadline timer when work wins the race (no dangling timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withDeadline(() => Promise.resolve('value'), 1000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears the deadline timer when the deadline itself wins (no dangling timer either way)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const never = deferred<string>();
    const promise = withDeadline(() => never.promise, 50);
    await vi.advanceTimersByTimeAsync(50);
    await promise;
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  // Regression lock (Opus review Minor-1): the code is already correct here
  // — `Promise.race` attaches a reaction to EVERY promise passed to it
  // (including the losing one), so a `work()` that rejects AFTER the
  // deadline has already fired is still "handled" from Node's perspective,
  // even though `withDeadline` itself already resolved with
  // `{status:'timeout'}` via the other racer. Without this test, a future
  // refactor (e.g. swapping `Promise.race` for a hand-rolled resolve-once
  // wrapper, or adding a `.catch` that strips the reaction from `okPromise`)
  // could silently reintroduce a process-level `unhandledRejection` leak.
  it('does not leak an unhandledRejection when work() rejects AFTER the deadline has already fired', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const late = deferred<string>();
      const promise = withDeadline(() => late.promise, 10);

      // The deadline wins first — advance fake timers PAST the 10ms
      // deadline before `work()` ever settles, so the outer `withDeadline`
      // call has already resolved with `{status:'timeout'}` by the time the
      // late rejection below happens.
      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).resolves.toEqual({ status: 'timeout' });

      // NOW work() rejects, well after withDeadline already settled. This
      // must never surface as a process-level unhandledRejection.
      late.reject(new Error('late failure, after the deadline already fired'));
      await flushMicrotasks();
      // Node's unhandledRejection detection fires on a later macrotask tick
      // after the rejection's microtask queue drains, not merely after more
      // microtasks. Switch to REAL timers for this one wait (nothing in this
      // test still depends on fake time — the deadline already fired above)
      // so a genuine `setTimeout` tick elapses and Node's internal check has
      // a real turn of the event loop to run before we assert.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// createIndexingTracker — first-empty "maybe-indexing" policy
// ---------------------------------------------------------------------------

describe('createIndexingTracker', () => {
  it('classifies the first-ever empty result for a language as first-empty', () => {
    const tracker = createIndexingTracker();
    expect(tracker.classify('python', true)).toBe('first-empty');
  });

  it('classifies a second empty (no non-empty in between) as normal — fires at most once per key', () => {
    const tracker = createIndexingTracker();
    expect(tracker.classify('python', true)).toBe('first-empty');
    expect(tracker.classify('python', true)).toBe('normal');
    expect(tracker.classify('python', true)).toBe('normal');
  });

  it('classifies empty as normal once a non-empty has already been recorded for that key', () => {
    const tracker = createIndexingTracker();
    expect(tracker.classify('python', false)).toBe('normal');
    expect(tracker.classify('python', true)).toBe('normal');
  });

  it('treats distinct language keys independently', () => {
    const tracker = createIndexingTracker();
    expect(tracker.classify('python', true)).toBe('first-empty');
    expect(tracker.classify('typescript', true)).toBe('first-empty');
  });

  it('a non-empty result is always classified normal, regardless of history', () => {
    const tracker = createIndexingTracker();
    expect(tracker.classify('python', false)).toBe('normal');
    expect(tracker.classify('python', false)).toBe('normal');
  });

  it('once a non-empty is seen after a first-empty, further empties stay normal', () => {
    const tracker = createIndexingTracker();
    expect(tracker.classify('rust', true)).toBe('first-empty');
    expect(tracker.classify('rust', false)).toBe('normal');
    expect(tracker.classify('rust', true)).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// LruCache — bounded, recency-ordered
// ---------------------------------------------------------------------------

describe('LruCache', () => {
  it('evicts the least-recently-used entry when over capacity', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3'); // evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
    expect(cache.size).toBe(2);
  });

  it('a get() refreshes recency, protecting an entry from the next eviction', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a'); // 'a' is now MRU; 'b' is now LRU
    cache.set('c', '3'); // evicts 'b', not 'a'
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });

  it('overwriting an existing key updates its value without changing size', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '1-updated');
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe('1-updated');
    expect(cache.get('b')).toBe('2');
  });

  it('overwriting an existing key also refreshes its recency', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '1-updated'); // 'a' is MRU again; 'b' is LRU
    cache.set('c', '3'); // evicts 'b'
    expect(cache.get('a')).toBe('1-updated');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });

  it('maxEntries=1 keeps exactly the most recently set entry', () => {
    const cache = new LruCache<string>(1);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.size).toBe(1);
  });

  it('maxEntries=0 is guarded: nothing is ever retained', () => {
    const cache = new LruCache<string>(0);
    cache.set('a', '1');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('a negative maxEntries is guarded the same as 0 (never throws, never grows)', () => {
    expect(() => new LruCache<string>(-5)).not.toThrow();
    const cache = new LruCache<string>(-5);
    expect(() => cache.set('a', '1')).not.toThrow();
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createConcurrencyPool — the concurrency crux: bound + finally-release
// ---------------------------------------------------------------------------

describe('createConcurrencyPool', () => {
  it('bounds concurrency at maxInFlight and lets all queued tasks eventually settle (FIFO)', async () => {
    const pool = createConcurrencyPool(2);
    const defs = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    let activeNow = 0;
    let maxActiveObserved = 0;
    const started: number[] = [];

    const makeTask = (i: number) => (): Promise<string> => {
      activeNow++;
      started.push(i);
      maxActiveObserved = Math.max(maxActiveObserved, activeNow);
      return must(defs[i]).promise.finally(() => {
        activeNow--;
      });
    };

    const results = defs.map((_, i) => pool.run(makeTask(i)));

    // Only the first `maxInFlight` (2) tasks start synchronously — the rest
    // queue FIFO, proving the bound at the moment of submission.
    expect(started).toEqual([0, 1]);
    expect(maxActiveObserved).toBeLessThanOrEqual(2);

    must(defs[0]).resolve('r0');
    await flushMicrotasks();
    expect(started).toContain(2);
    expect(started).not.toContain(3);
    expect(maxActiveObserved).toBeLessThanOrEqual(2);

    must(defs[1]).resolve('r1');
    await flushMicrotasks();
    expect(started).toContain(3);
    expect(maxActiveObserved).toBeLessThanOrEqual(2);

    must(defs[2]).resolve('r2');
    must(defs[3]).resolve('r3');
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(maxActiveObserved).toBeLessThanOrEqual(2);

    must(defs[4]).resolve('r4');
    const settled = await Promise.all(results);
    expect(settled).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('frees a slot when a task rejects, so a later queued task still runs (finally-release)', async () => {
    const pool = createConcurrencyPool(1);
    const first = deferred<string>();
    const firstResult = pool.run(() => first.promise);

    let secondStarted = false;
    const secondResult = pool.run(async () => {
      secondStarted = true;
      return 'second-ok';
    });

    // Only one slot: the second task must not have started while the first
    // is still pending.
    expect(secondStarted).toBe(false);

    first.reject(new Error('first task failed'));
    await expect(firstResult).rejects.toThrow('first task failed');
    await flushMicrotasks();

    expect(secondStarted).toBe(true);
    await expect(secondResult).resolves.toBe('second-ok');
  });

  it('frees the slot even when a task throws synchronously (not just rejects)', async () => {
    const pool = createConcurrencyPool(1);
    const throwingResult = pool.run((): Promise<string> => {
      throw new Error('sync boom');
    });
    await expect(throwingResult).rejects.toThrow('sync boom');

    let secondRan = false;
    const secondResult = pool.run(async () => {
      secondRan = true;
      return 'ok';
    });
    await flushMicrotasks();
    expect(secondRan).toBe(true);
    await expect(secondResult).resolves.toBe('ok');
  });

  it('run() resolves/rejects with exactly the task outcome for an already-available slot', async () => {
    const pool = createConcurrencyPool(3);
    await expect(pool.run(async () => 42)).resolves.toBe(42);
    await expect(pool.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// extractSnippet — pure, raw, total
// ---------------------------------------------------------------------------

describe('extractSnippet', () => {
  const doc = ['line0', 'line1', 'line2', 'line3', 'line4'].join('\n');

  it('extracts up to maxLines starting at range.start.line for a mid-file range', () => {
    expect(extractSnippet(doc, range(2, 0, 2, 5), 2)).toBe('line2\nline3');
  });

  it('clamps a range whose start line is past EOF instead of throwing', () => {
    expect(() => extractSnippet('a\nb\nc', range(10, 0, 10, 0), 2)).not.toThrow();
    expect(extractSnippet('a\nb\nc', range(10, 0, 10, 0), 2)).toBe('c');
  });

  it('caps the returned snippet at maxLines', () => {
    expect(extractSnippet(doc, range(0, 0, 0, 0), 1)).toBe('line0');
  });

  it('returns an empty string for an empty document', () => {
    expect(extractSnippet('', range(0, 0, 0, 0), 5)).toBe('');
  });

  it('returns an empty string when maxLines is zero or negative, never throwing', () => {
    expect(extractSnippet(doc, range(0, 0, 0, 0), 0)).toBe('');
    expect(extractSnippet(doc, range(0, 0, 0, 0), -3)).toBe('');
  });

  it('clamps a negative or non-finite start line to 0 instead of throwing', () => {
    expect(extractSnippet(doc, range(-5, 0, -5, 0), 1)).toBe('line0');
    expect(() => extractSnippet(doc, range(NaN, 0, NaN, 0), 1)).not.toThrow();
    expect(extractSnippet(doc, range(NaN, 0, NaN, 0), 1)).toBe('line0');
  });

  it('never sanitizes — returns raw text verbatim (the shaper sanitizes, not this function)', () => {
    // Single line (no embedded \n) so a maxLines:1 extraction returns the
    // whole fixture unmodified — control chars and the frame-tag substring
    // must pass through completely untouched (sanitizing is the shaper's
    // job, not this function's).
    const raw = 'const x = "<lsp_result>\tunsanitized";';
    expect(extractSnippet(raw, range(0, 0, 0, 0), 1)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// buildConfinementVerdict — fail-closed over an injected RealpathConfiner
// ---------------------------------------------------------------------------

describe('buildConfinementVerdict', () => {
  const sliceRelative = (root: string, canonical: string): string => {
    const tail = canonical.slice(root.length);
    return tail.replace(/^[/\\]/, '');
  };

  it('returns inRoot+relPath for a path the confiner resolves as contained', async () => {
    const confine: RealpathConfiner = async () => '/workspace/src/a.ts';
    const verdict = await buildConfinementVerdict('/workspace/src/a.ts', ['/workspace'], confine, sliceRelative);
    expect(verdict).toEqual({ inRoot: true, relPath: 'src/a.ts' });
  });

  it('returns external (not a throw) when the confiner resolves null', async () => {
    const confine: RealpathConfiner = async () => null;
    const verdict = await buildConfinementVerdict('/etc/passwd', ['/workspace'], confine, sliceRelative);
    expect(verdict).toEqual({ inRoot: false, externalUri: '/etc/passwd' });
  });

  it('fails closed to external when the confiner throws — NEVER inRoot', async () => {
    const confine: RealpathConfiner = async () => {
      throw new Error('realpath exploded');
    };
    const verdict = await buildConfinementVerdict('/workspace/src/a.ts', ['/workspace'], confine, sliceRelative);
    expect(verdict).toEqual({ inRoot: false, externalUri: '/workspace/src/a.ts' });
    expect(verdict.inRoot).toBe(false);
  });

  it('selects the correct containing root among multiple roots', async () => {
    const confine: RealpathConfiner = async () => '/ws2/file.ts';
    const toRelative = (root: string, canonical: string): string => `${root}::${canonical}`;
    const verdict = await buildConfinementVerdict('anything', ['/ws1', '/ws2'], confine, toRelative);
    expect(verdict).toEqual({ inRoot: true, relPath: '/ws2::/ws2/file.ts' });
  });

  it('passes rawFsPath and roots through to the injected confiner unchanged', async () => {
    let seenTarget: string | undefined;
    let seenRoots: string[] | undefined;
    const confine: RealpathConfiner = async (target, roots) => {
      seenTarget = target;
      seenRoots = roots;
      return null;
    };
    await buildConfinementVerdict('/some/path', ['/root1', '/root2'], confine, sliceRelative);
    expect(seenTarget).toBe('/some/path');
    expect(seenRoots).toEqual(['/root1', '/root2']);
  });
});
