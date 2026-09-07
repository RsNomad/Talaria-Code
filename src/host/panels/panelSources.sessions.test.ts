import { describe, it, expect } from 'vitest';
import type { PanelSourceContext } from './PanelSourceRegistry';
import type { AcpClientLike, AcpListSessionsRawResult } from '../backend/acp/acpClient';
import { SessionsPanelSource } from './panelSources';

/**
 * L2-CA-13 (WS-R1 R1-4): `SessionsPanelSource` keeps a per-cwd bucket
 * (`accumulated`/`seenIds`/`inFlight`). The existing `inFlight` map only
 * coalesces a fetch for the SAME cursor — two DIFFERENT-cursor fetches (a
 * cursor-less page-1 load racing a cursored "Load more") used to run
 * CONCURRENTLY, so whichever `listSessions` call settled first mutated the
 * shared `accumulated`/`seenIds` state first, corrupting order (and, worse,
 * a later page-1 reset could wipe out an already-applied "Load more" page).
 * The fix serializes a bucket's page fetches through a promise chain
 * (mirroring `ConfigWriteTail`'s settled-swallow `.then(run, run)` tail),
 * with the same-cursor `inFlight` coalescing kept ON TOP of it.
 *
 * This suite drives `SessionsPanelSource` directly against a fully
 * controllable `listSessions` stub (one manually-resolved/rejected deferred
 * PER CALL) so the tests can force the exact interleavings that used to
 * corrupt the bucket.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Call {
  cwd: string | undefined;
  cursor: string | undefined;
  deferred: ReturnType<typeof deferred<AcpListSessionsRawResult>>;
}

/** A `listSessions` stub where EVERY call gets its own manually-settled
 * deferred (never auto-resolves), recorded in invocation order in `calls`. */
function makeControllableClient(): { client: AcpClientLike; calls: Call[] } {
  const calls: Call[] = [];
  const listSessions = async (cwd?: string, cursor?: string): Promise<AcpListSessionsRawResult> => {
    const d = deferred<AcpListSessionsRawResult>();
    calls.push({ cwd, cursor, deferred: d });
    return d.promise;
  };
  return { client: { listSessions } as unknown as AcpClientLike, calls };
}

/** Minimal `PanelSourceContext` — `dispatch` throws (this source must never
 * touch the tui_gateway channel, per the two-channel invariant). */
function makeCtx(client: AcpClientLike): PanelSourceContext {
  return {
    dispatch: async () => {
      throw new Error('SessionsPanelSource must use the ACP channel, not dispatch');
    },
    getAcpClient: () => client,
    getCwd: () => undefined,
    getSessionCwd: () => undefined,
    getSessionSubagentsSnapshot: () => undefined,
    getRootTracker: () => undefined,
    getOneShotSessionIds: () => new Set<string>(),
  };
}

/** A raw `session/list`-shaped page (Hermes `acp_adapter/server.py`'s
 * `SessionInfo` fields, snake_case wire keys). */
function rawPage(sessions: Array<{ id: string; cwd?: string }>, nextCursor?: string): AcpListSessionsRawResult {
  return {
    sessions: sessions.map((s) => ({ session_id: s.id, cwd: s.cwd ?? '/w' })),
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
  };
}

/** Poll (via microtask ticks, no timers needed) until a call matching
 * `predicate` has been recorded. The chain fix defers exactly WHEN a
 * different-cursor call is issued, so tests can't assume a fixed tick
 * count — they wait for the call to actually happen. */
async function untilCall(calls: readonly Call[], predicate: (c: Call) => boolean, maxTicks = 50): Promise<Call> {
  for (let i = 0; i < maxTicks; i++) {
    const found = calls.find(predicate);
    if (found) return found;
    await Promise.resolve();
  }
  throw new Error('listSessions was never called for the expected predicate within the tick budget');
}

describe('L2-CA-13: SessionsPanelSource serializes page fetches per cwd bucket', () => {
  it('different-cursor fetches are ordered by ISSUE order, not by which listSessions call settles first — no duplicate ids, nextCursor from the LAST page', async () => {
    const { client, calls } = makeControllableClient();
    const source = new SessionsPanelSource(makeCtx(client));

    const page1Promise = source.fetch({ cwd: '/w' }); // fresh page-1, no cursor
    const page2Promise = source.fetch({ cwd: '/w', cursor: 'sess-1' }); // "Load more", started before page-1 settles

    // Resolve the CURSOR ("load more") fetch first whenever it is ALREADY in
    // flight concurrently with page-1 — this is exactly the race the old,
    // unserialized code loses: it fires both `listSessions` calls
    // immediately, so whichever settles first mutates the shared
    // `accumulated`/`seenIds` state first.
    const earlyCursorCall = calls.find((c) => c.cursor === 'sess-1');
    earlyCursorCall?.deferred.resolve(rawPage([{ id: 'sess-2' }]));

    const page1Call = await untilCall(calls, (c) => c.cursor === undefined);
    page1Call.deferred.resolve(rawPage([{ id: 'sess-1' }], 'sess-1'));

    // Under the fix, page-2's OWN `listSessions` call is not even issued
    // until page-1's run fully settles, so it only appears now — the resolve
    // above (if it fired at all) was a no-op against a call that didn't
    // exist yet.
    const page2Call = await untilCall(calls, (c) => c.cursor === 'sess-1');
    page2Call.deferred.resolve(rawPage([{ id: 'sess-2' }])); // no-op if already resolved above

    const [outcome1, outcome2] = await Promise.all([page1Promise, page2Promise]);

    expect(outcome1).toEqual({ data: { sessions: [{ id: 'sess-1', cwd: '/w' }], nextCursor: 'sess-1' } });
    expect(outcome2).toEqual({
      data: { sessions: [{ id: 'sess-1', cwd: '/w' }, { id: 'sess-2', cwd: '/w' }] },
    });
  });

  it('M-11 honest end state: a session deleted between pages -> the next cursor is unknown -> the wire returns an EMPTY page -> the list ends cleanly, no error (grounded: acp_adapter/server.py:1264-1270, unknown cursor never falls back to the full list)', async () => {
    const { client, calls } = makeControllableClient();
    const source = new SessionsPanelSource(makeCtx(client));

    const page1Promise = source.fetch({ cwd: '/w' });
    const page1Call = await untilCall(calls, (c) => c.cursor === undefined);
    page1Call.deferred.resolve(rawPage([{ id: 'sess-1' }], 'sess-1'));
    const outcome1 = await page1Promise;
    expect(outcome1).toEqual({ data: { sessions: [{ id: 'sess-1', cwd: '/w' }], nextCursor: 'sess-1' } });

    // 'sess-1' (the cursor "Load more" would send) got deleted server-side —
    // the cursor is now unknown, so the wire returns an EMPTY page.
    const page2Promise = source.fetch({ cwd: '/w', cursor: 'sess-1' });
    const page2Call = await untilCall(calls, (c) => c.cursor === 'sess-1');
    page2Call.deferred.resolve(rawPage([]));
    const outcome2 = await page2Promise;

    expect(outcome2).toEqual({ data: { sessions: [{ id: 'sess-1', cwd: '/w' }] } }); // unchanged, list just ends
    expect(outcome2.data && 'nextCursor' in outcome2.data).toBe(false);
  });

  it('a rejected fetch rejects only its OWN caller; the chain is not poisoned for the NEXT queued fetch, and no unhandled rejection escapes', async () => {
    const seenRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seenRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { client, calls } = makeControllableClient();
      const source = new SessionsPanelSource(makeCtx(client));

      const failingPromise = source.fetch({ cwd: '/w' }); // no cursor
      const failingCall = await untilCall(calls, (c) => c.cursor === undefined);
      const boom = new Error('listSessions boom');
      failingCall.deferred.reject(boom);
      await expect(failingPromise).rejects.toBe(boom);

      // A different-cursor fetch queued behind the rejected one must still run.
      const nextPromise = source.fetch({ cwd: '/w', cursor: 'c-after-reject' });
      const nextCall = await untilCall(calls, (c) => c.cursor === 'c-after-reject');
      nextCall.deferred.resolve(rawPage([{ id: 'sess-9' }]));
      await expect(nextPromise).resolves.toEqual({ data: { sessions: [{ id: 'sess-9', cwd: '/w' }] } });

      // Node reports an unhandled rejection only after a microtask
      // checkpoint — give the internal settled-swallow chain a few extra
      // turns to surface one if it ever dropped a handler.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seenRejections).toEqual([]);
  });

  it('same-cursor coalescing still works ON TOP of the chain: two concurrent "Load more" calls for the same cursor share ONE listSessions call', async () => {
    const { client, calls } = makeControllableClient();
    const source = new SessionsPanelSource(makeCtx(client));

    const [p1, p2] = [source.fetch({ cwd: '/w', cursor: 'c9' }), source.fetch({ cwd: '/w', cursor: 'c9' })];
    const call = await untilCall(calls, (c) => c.cursor === 'c9');
    call.deferred.resolve(rawPage([{ id: 'sess-x' }]));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls.filter((c) => c.cursor === 'c9')).toHaveLength(1);
    expect(r1).toEqual({ data: { sessions: [{ id: 'sess-x', cwd: '/w' }] } });
    expect(r2).toEqual(r1);
  });

  it('bucket lifecycle: a pending fetch for one cwd does not block a concurrent fetch for a DIFFERENT cwd (independent per-bucket chains)', async () => {
    const { client, calls } = makeControllableClient();
    const source = new SessionsPanelSource(makeCtx(client));

    const aPromise = source.fetch({ cwd: '/a' });
    const aCall = await untilCall(calls, (c) => c.cwd === '/a' && c.cursor === undefined);

    // Start B's fetch WHILE A is still pending — a shared/global chain would
    // block B's own listSessions call behind A's; a fresh per-cwd bucket
    // must not.
    const bPromise = source.fetch({ cwd: '/b' });
    const bCall = await untilCall(calls, (c) => c.cwd === '/b' && c.cursor === undefined);
    bCall.deferred.resolve(rawPage([{ id: 'b1', cwd: '/b' }]));
    await expect(bPromise).resolves.toEqual({ data: { sessions: [{ id: 'b1', cwd: '/b' }] } });

    aCall.deferred.resolve(rawPage([{ id: 'a1', cwd: '/a' }]));
    await expect(aPromise).resolves.toEqual({ data: { sessions: [{ id: 'a1', cwd: '/a' }] } });
  });
});
