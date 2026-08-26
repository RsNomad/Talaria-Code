/*
 * BF-B: close the pre-registration dangling-promise window in
 * `SessionController.handlePermission`. The residual window: the permission
 * promise is in-flight DURING `await this.buildPresentEffectSignals(...)`
 * (which awaits `canonicalizeToolCallPaths` — real fs `realpath`/`lstat`) —
 * this is BEFORE `emitApprovalCard` registers the approval into
 * `pendingApprovals`. If `dispose()` runs in that window, `dispose`'s
 * `cancelPendingApprovals()` finds nothing to cancel (not registered yet);
 * when the await resolves, `handlePermission` used to proceed straight to
 * `emitApprovalCard`, registering a FRESH pending approval into a
 * now-disposed controller — an orphaned promise (never drained, never
 * answered) plus side effects (`editPreviewRegistry.set`, `port.emit`) fired
 * into a dead controller. Fail-closed fix: re-check liveness right after the
 * await resolves and short-circuit to the cancelled outcome, registering
 * nothing.
 *
 * `SessionController` is headless (no `vscode` import — see its own class
 * doc), so this constructs one directly against a minimal mock
 * `SessionHostPort`, no `AcpBackend` involved. The race is driven
 * deterministically: `dispose()` is synchronous; `handlePermission` suspends
 * on a REAL fs await (a temp workspace dir, so canonicalization touches
 * actual `realpath`/`lstat` calls — guaranteed to take at least one real I/O
 * tick) — calling `dispose()` immediately after starting the promise,
 * before awaiting it, reliably lands inside that window (mirrors
 * `AcpBackend.test.ts`'s `makeTmpWs`/`makeEditReq` pattern for the same
 * canonicalization seam).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { SessionController } from './SessionController';
import type { SessionHostPort } from './types';
import type { RootCoordinatorLike } from '../../checkpoints/RootCoordinator';
import { buildCancelledOutcome } from '../acp/permission';
import type { AcpRequestPermissionRequest, AcpOutboundContentBlock } from '../acp/types';
import type { AcpClientLike, AcpListSessionsRawResult, AcpLoadSessionResult } from '../acp/acpClient';
import type { Attachment, HostToWebviewMessage } from '../../../shared/protocol';

const EDIT_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
  { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
] as const;

/** Mirrors `AcpBackend.test.ts`'s `makeEditReq` — an `edit` permission
 *  request whose write_file path is `p`, so `buildPresentEffectSignals`
 *  takes the AWAITING `canonicalizeToolCallPaths` branch. */
function makeEditReq(p: string): AcpRequestPermissionRequest {
  return {
    sessionId: 'session-1',
    options: EDIT_OPTIONS.map((o) => ({ ...o })),
    toolCall: {
      toolCallId: 'edit-1',
      title: `Approve edit: ${p}`,
      kind: 'edit',
      content: [{ type: 'diff', path: p, oldText: 'a', newText: 'b' }],
      rawInput: { tool: 'write_file', arguments: { path: p, content: 'b' } },
    },
  };
}

function makeRoot(): RootCoordinatorLike {
  return {
    rootId: 'root-1',
    tracker: undefined,
    tryAcquireTurnLease: () => true,
    releaseTurnLease: () => {},
    anyLiveTurn: () => false,
    nextTurnOrdinal: () => 1,
    nextBaselineOrdinal: () => -1,
    refreshCheckpointsPanel: () => {},
  };
}

function makePort(ws: string): { port: SessionHostPort; emitted: unknown[]; logs: string[] } {
  const emitted: unknown[] = [];
  const logs: string[] = [];
  const port: SessionHostPort = {
    getClient: () => undefined,
    emit: (msg) => emitted.push(msg),
    emitSystemError: () => {},
    root: makeRoot(),
    workspaceRoots: () => [ws],
    logger: { append: (l) => logs.push(l) },
    refreshCheckpointsPanel: () => {},
    resolveMentions: async () => [],
  };
  return { port, emitted, logs };
}

describe('SessionController.handlePermission — BF-B: dispose-mid-canonicalization race', () => {
  const tmpDirs: string[] = [];
  function makeTmpWs(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-sc-bfb-ws-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it(
    'a dispose() landing WHILE canonicalization is in flight resolves fail-closed (cancelled) and registers NO approval card',
    async () => {
      const ws = makeTmpWs();
      const { port, emitted, logs } = makePort(ws);
      const controller = new SessionController('session-1', ws, port);

      // Starts `handlePermission`, which suspends at `await
      // this.buildPresentEffectSignals(...)` (real fs realpath/lstat) —
      // `dispose()` right below is synchronous and runs BEFORE that await
      // resolves, landing squarely in the pre-registration window.
      const pending = controller.handlePermission(makeEditReq('src/a.ts'), 'appr-1');
      controller.dispose();

      const res = await pending;

      // Fail-closed: the disposed-mid-flight outcome is cancelled, never
      // allow/selected.
      expect(res).toEqual(buildCancelledOutcome());

      // No approval card (or its diff) was ever emitted into the disposed
      // controller — the registration point (`emitApprovalCard`) never ran.
      expect(emitted.some((m) => (m as { type?: string }).type === 'approval.request')).toBe(false);
      expect(emitted.some((m) => (m as { type?: string }).type === 'tool.diff')).toBe(false);

      // No orphaned pending approval remains: `respondApproval` for the same
      // id is a documented no-op (logs "no pending approval") whenever
      // nothing was ever registered under it — proving `dispose()`'s
      // `cancelPendingApprovals()` didn't just get lucky finding an
      // already-cancelled entry, but that NOTHING was ever inserted.
      logs.length = 0;
      controller.respondApproval('appr-1', 'allow_once');
      expect(logs.some((l) => l.includes("no pending approval 'appr-1'"))).toBe(true);
    },
    2000,
  );
});

/**
 * ARCH-1 (final review, UI I-1) — T2: SessionController.setModel. Every
 * terminal transition of a switch attempt (RPC resolve, RPC reject, or no
 * live client) must emit an authoritative `model.state` push, and
 * `currentModelId` (the H4-B8 hydrate seed) may be assigned ONLY on RPC
 * resolve. Today's source (:409-416, pre-fix) violates both halves:
 * `if (!client) return;` is a silent no-op on a user-initiated action, and
 * `this.currentModelId = id` runs unconditionally, synchronously, before the
 * RPC even settles.
 *
 * `modelSwitchSeq` (§1.6): two rapid picks A→B can settle out of order — a
 * stale corrective push from a superseded attempt must never clobber a
 * newer confirm. `SessionController` mints a token per attempt; only the
 * settlement whose token still matches `this.modelSwitchSeq` is allowed to
 * emit its terminal push.
 */
describe('SessionController.setModel — ARCH-1 (final review, UI I-1): terminal transitions', () => {
  /**
   * Minimal `AcpClientLike` stub. `setModel` only ever reaches
   * `setSessionModel` on this fake — every other member exists solely to
   * satisfy the interface and throws if a test accidentally reaches it
   * (mirrors `AcpBackend.test.ts`'s `FakeAcpClient`, trimmed to this file's
   * narrower needs).
   */
  function makeFakeClient(setSessionModel: AcpClientLike['setSessionModel']): AcpClientLike {
    const unused = (name: string): never => {
      throw new Error(`unexpected call to AcpClientLike.${name} in a setModel test`);
    };
    return {
      connect: async () => unused('connect'),
      initialize: async () => unused('initialize'),
      newSession: async () => unused('newSession'),
      prompt: async () => unused('prompt'),
      cancel: async () => unused('cancel'),
      setSessionMode: async () => unused('setSessionMode'),
      setSessionModel,
      listSessions: async (): Promise<AcpListSessionsRawResult> => unused('listSessions'),
      loadSession: async () => unused('loadSession'),
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
    };
  }

  function makeControllerPort(client: AcpClientLike | undefined): {
    port: SessionHostPort;
    emitted: HostToWebviewMessage[];
  } {
    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => [],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return { port, emitted };
  }

  it('a successful switch confirms via model.state and assigns currentModelId ONLY after the RPC resolves', async () => {
    const client = makeFakeClient(vi.fn().mockResolvedValue(undefined));
    const { port, emitted } = makeControllerPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);

    controller.setModel('B');

    // RED today: the pre-fix source assigns `this.currentModelId = id`
    // synchronously, immediately after firing the RPC — NOT gated on
    // resolution. Right after the synchronous call returns (before any
    // microtask/tick), the field must still be unassigned.
    expect(controller.currentModelId).toBeUndefined();

    await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(0));

    expect(controller.currentModelId).toBe('B');
    expect(emitted).toContainEqual({ type: 'model.state', sessionId: 'session-1', modelId: 'B' });
  });

  it('setModel: RPC reject emits error AND corrective model.state; currentModelId stays previous', async () => {
    const client = makeFakeClient(vi.fn().mockRejectedValue(new Error('unknown model')));
    const { port, emitted } = makeControllerPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);
    controller.currentModelId = 'A';

    controller.setModel('B');

    await vi.waitFor(() => expect(emitted.some((m) => m.type === 'model.state')).toBe(true));

    // RED today: the pre-fix source has no reject handler that emits a
    // corrective `model.state` at all, and unconditionally already assigned
    // `currentModelId = 'B'` before the RPC even settled.
    expect(controller.currentModelId).toBe('A');
    const push = emitted.find((m) => m.type === 'model.state');
    expect(push).toMatchObject({ modelId: 'A' });
    expect(emitted.some((m) => m.type === 'error')).toBe(true);
  });

  it('setModel with no live client emits an error AND a corrective model.state — never a silent no-op', () => {
    const { port, emitted } = makeControllerPort(undefined);
    const controller = new SessionController('session-1', '/tmp/ws', port);
    controller.currentModelId = 'A';

    controller.setModel('B');

    // RED today: `if (!client) return;` is a silent no-op — nothing is ever
    // emitted, and this user-initiated refusal is invisible to the webview.
    expect(emitted.map((m) => m.type)).toEqual(expect.arrayContaining(['error', 'model.state']));
    const push = emitted.find((m): m is Extract<HostToWebviewMessage, { type: 'model.state' }> => m.type === 'model.state');
    expect(push?.modelId).toBe('A');
    expect(controller.currentModelId).toBe('A');
  });

  it('a superseded switch never emits a stale corrective push (modelSwitchSeq liveness token)', async () => {
    // A-switch: deferred, and ultimately REJECTS after B has already
    // confirmed — the worst case, where a token-less reject handler would
    // push a stale corrective `model.state` on top of B's already-landed
    // confirm. B-switch: resolves immediately. Only B's terminal push may
    // ever land on the wire.
    let rejectA!: (err: unknown) => void;
    const aPromise = new Promise<void>((_resolve, reject) => {
      rejectA = reject;
    });
    const setSessionModel = vi
      .fn()
      .mockImplementationOnce(() => aPromise)
      .mockImplementationOnce(() => Promise.resolve());
    const client = makeFakeClient(setSessionModel);
    const { port, emitted } = makeControllerPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);
    controller.currentModelId = 'A0';

    controller.setModel('A'); // superseded switch — starts first, settles last
    controller.setModel('B'); // superseding switch — starts second, settles first

    await vi.waitFor(() => expect(controller.currentModelId).toBe('B'));
    expect(emitted).toContainEqual({ type: 'model.state', sessionId: 'session-1', modelId: 'B' });

    // Let the superseded A-switch's RPC belatedly reject. RED without the
    // seq token: its reject handler fires unconditionally and pushes a
    // stale `model.state{modelId:'A0'}` (plus an `error`) AFTER B's confirm
    // already landed — clobbering the UI back to the pre-switch value even
    // though B is the switch that actually won.
    const pushCountBeforeALands = emitted.length;
    rejectA(new Error('unknown model'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(emitted.length).toBe(pushCountBeforeALands);
    expect(controller.currentModelId).toBe('B');
    const modelStatePushes = emitted.filter((m) => m.type === 'model.state');
    expect(modelStatePushes[modelStatePushes.length - 1]).toEqual({
      type: 'model.state',
      sessionId: 'session-1',
      modelId: 'B',
    });
  });

  /**
   * D3/A8 partial close (W1-T9): the pinned SDK coerces a `null`
   * `unstable_setSessionModel` result (Hermes's "unknown session" answer)
   * into `{}` — byte-identical to a genuine empty success — so the client
   * cannot discriminate the two over a LIVE connection (that residual is a
   * filed upstream ask, not closeable here). BUT a DIFFERENT, closeable slice
   * exists: today's resolve handler assigns `currentModelId` and emits the
   * success `model.state{id}` UNCONDITIONALLY, so a resolve landing AFTER
   * this controller has died (`dispose()`) or been evicted (`getClient()`
   * goes `undefined` without a formal dispose) emits a FALSE "switched" —
   * silently, because nothing re-checks liveness on the happy path.
   *
   * `dispose()` case: the controller must stay as silent as every other
   * BF-B liveness guard in this file (`reportUndeliveredUtterance`,
   * `emitApprovalCard`, the `loadReplayOutcome` continuation, `dispose()` itself) —
   * `SessionRegistry.open`'s same-sessionId replace (W6-FB) can already have
   * minted a FRESH controller sharing this `port` by the time this resolve
   * lands, so an emit here would risk clobbering the NEW controller's
   * already-landed state with THIS dead controller's stale `previous`. No
   * emit is the fail-safe choice, not a fail-silent one: the false success
   * (`currentModelId` + the success push) is still fully suppressed.
   */
  it('a resolve landing AFTER dispose() must not assign currentModelId or emit anything (BF-B liveness discipline)', async () => {
    let resolveRpc!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveRpc = resolve;
    });
    const client = makeFakeClient(vi.fn().mockImplementation(() => deferred));
    const { port, emitted } = makeControllerPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);
    controller.currentModelId = 'A';

    controller.setModel('B'); // RPC in flight
    controller.dispose(); // controller dies WHILE the RPC is still in flight
    resolveRpc(); // the RPC settles AFTER death

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // RED today: the resolve handler has no liveness check at all — it
    // assigns `currentModelId = 'B'` and emits the success `model.state`
    // unconditionally, even though the controller is dead.
    expect(controller.currentModelId).toBe('A');
    expect(emitted).toEqual([]);
  });

  /**
   * A8/D3 fast-follow (W1-T9b): review of the resolve-arm fix above (the
   * test just before this one) flagged the SIBLING reject arm as having the
   * IDENTICAL clobber hazard, UNGUARDED. `AcpClient.setSessionModel` races
   * the RPC against `raceTermination`, so it can REJECT for reasons OTHER
   * than child death (a genuine protocol error) — meaning a reject can land
   * on a controller that was DISPOSED via the W6-FB same-sessionId-reopen
   * path just as easily as a resolve can. Same fail-safe posture as the
   * resolve arm applies for the identical reason: `SessionRegistry.open`'s
   * same-sessionId replace may already have minted a FRESH controller
   * sharing this dead controller's `port` by the time this reject lands —
   * emitting the stale `model.state{previous}` (+ `error`) through the
   * shared host-wide emitter would clobber that fresh controller's
   * already-landed state, folded purely by `sessionId` in the webview.
   */
  it('a reject landing AFTER dispose() must emit nothing (BF-B liveness discipline, reject arm)', async () => {
    let rejectRpc!: (err: unknown) => void;
    const deferred = new Promise<void>((_resolve, reject) => {
      rejectRpc = reject;
    });
    const client = makeFakeClient(vi.fn().mockImplementation(() => deferred));
    const { port, emitted } = makeControllerPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);
    controller.currentModelId = 'A';

    controller.setModel('B'); // RPC in flight
    controller.dispose(); // controller dies WHILE the RPC is still in flight
    rejectRpc(new Error('unknown model')); // the RPC settles AFTER death

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // RED today: the reject handler only re-checks `seq` — it has no
    // liveness (`this.disposed`) check at all, so it emits the stale
    // `error` + corrective `model.state{previous}` unconditionally, even
    // though the controller is dead.
    expect(emitted).toEqual([]);
  });

  /**
   * The `getClient()`-goes-`undefined`-without-dispose case: the controller
   * itself is still ALIVE (not disposed) — this is the entry guard's own
   * `!client` scenario (:700 above), just discovered late instead of at
   * call time. That existing guard already emits a corrective push in this
   * exact situation, so the resolve arm mirrors it: an honest, status-only
   * `error` plus a snap-back `model.state{previous}` — never the false
   * success, and never a silent drop either (this controller is still very
   * much live and visible to the user).
   */
  it('a resolve landing AFTER the client is evicted (controller still alive) emits a corrective model.state{previous} + status-only error, never the false success', async () => {
    let resolveRpc!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveRpc = resolve;
    });
    let client: AcpClientLike | undefined = makeFakeClient(vi.fn().mockImplementation(() => deferred));
    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => [],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controller = new SessionController('session-1', '/tmp/ws', port);
    controller.currentModelId = 'A';

    controller.setModel('B'); // RPC in flight, client still live at call time
    client = undefined; // evicted mid-RPC — controller is NOT disposed
    resolveRpc(); // the RPC settles AFTER eviction

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // RED today: the resolve handler assigns `currentModelId = 'B'` and
    // emits the false success `model.state{modelId:'B'}` regardless.
    expect(controller.currentModelId).toBe('A');
    expect(emitted.some((m) => m.type === 'model.state' && m.modelId === 'B')).toBe(false);
    const push = emitted.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'model.state' }> => m.type === 'model.state',
    );
    expect(push?.modelId).toBe('A');
    expect(emitted.some((m) => m.type === 'error')).toBe(true);
  });
});

/**
 * ARCH-1 (final review, UI I-4) — T4: `result.summary.status` must carry the
 * turn's REAL outcome (`mapStopReasonToStatus(response.stopReason)`), not an
 * assumed-success default. T1 already made `status` a required wire field
 * and wired this exact emitter (`SessionController.ts` — the `runTurn`
 * `result.summary` emit, a few lines below where `status` is computed via
 * `mapStopReasonToStatus`) to keep `tsc` green ahead of this task; this test
 * is therefore a REGRESSION guard on already-correct host behavior, not a
 * red-before-green host fix. T4's genuine red-before-green proof lives in
 * `ResultSummary.dom.test.tsx` (the webview hardcoded "Turn complete" for
 * every status before this task).
 */
/**
 * T-A0 (audit-2 remediation architecture, Cluster A / Mechanism M — host
 * half): closes V-4 outright (an approval left pending across `cancel()`
 * stranded the harness's blocking `future.result(timeout=60)` thread forever
 * — "Stop looks dead"), plus the host backstop for V-5 (turn-end abandons a
 * still-open card) and host authority for V-6 (the 60s auto-deny deadline
 * was never armed extension-side) and the missing `respondApproval`/
 * `finishApproval` echo for V-7. Every RED test below drives
 * `SessionController` directly (headless, no `AcpBackend`) through the same
 * `handlePermission` seam the BF-B describe block above already exercises,
 * using a `execute`-kind (command) request so `buildPresentEffectSignals`
 * needs no real fs canonicalization — `flushMicrotasks` below flushes the
 * ONE genuine `await` `handlePermission` takes before `emitApprovalCard`
 * registers the pending approval and emits `approval.request` synchronously.
 */
describe('SessionController — T-A0: host settle spine + approval.settle wire member (audit-2 Cluster A)', () => {
  /** Flushes the microtask queue N times — `buildPresentEffectSignals` is an
   *  `async` function with no real internal await for a command request, so
   *  `handlePermission`'s one `await` resolves within a couple of ticks; a
   *  generous margin avoids flakiness without needing fake-timer interplay
   *  with `vi.waitFor`'s own polling. */
  async function flushMicrotasks(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  /** A command request_permission whose `rawInput.command` is `command` —
   *  mirrors `AcpBackend.test.ts`'s helper of the same name, trimmed to this
   *  file's needs (no diff content, so no hunk-aggregation bookkeeping). */
  function makeCommandReq(command: string, toolCallId = 'cmd-1'): AcpRequestPermissionRequest {
    return {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId,
        title: `Run: ${command}`,
        kind: 'execute',
        content: [{ content: { type: 'text', text: `$ ${command}` } }],
        rawInput: { command, description: 'run' },
      },
    };
  }

  /** Minimal `AcpClientLike` stub, mirroring the setModel/sendPrompt describe
   *  blocks' `makeFakeClient` helpers above — every member throws unless
   *  overridden, so a test only wires the ONE method it actually drives. */
  function makeApprovalClient(overrides: Partial<AcpClientLike> = {}): AcpClientLike {
    const unused = (name: string): never => {
      throw new Error(`unexpected call to AcpClientLike.${name} in a T-A0 settle-spine test`);
    };
    return {
      connect: async () => unused('connect'),
      initialize: async () => unused('initialize'),
      newSession: async () => unused('newSession'),
      prompt: async () => unused('prompt'),
      cancel: async () => undefined,
      setSessionMode: async () => unused('setSessionMode'),
      setSessionModel: async () => unused('setSessionModel'),
      listSessions: async (): Promise<AcpListSessionsRawResult> => unused('listSessions'),
      loadSession: async () => unused('loadSession'),
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
      ...overrides,
    };
  }

  function makeSettlePort(client: AcpClientLike | undefined): {
    port: SessionHostPort;
    emitted: HostToWebviewMessage[];
    logs: string[];
  } {
    const emitted: HostToWebviewMessage[] = [];
    const logs: string[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => ['/tmp/ws-a0'],
      logger: { append: (l) => logs.push(l) },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return { port, emitted, logs };
  }

  it('V-4 RED: cancel() settles a pending approval — the promise resolves cancelled AND approval.settle{outcome:"cancelled"} is emitted', async () => {
    const client = makeApprovalClient({
      cancel: async () => undefined,
      prompt: () => new Promise<never>(() => {}),
    });
    const { port, emitted } = makeSettlePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-a0', port);
    controller.sendPrompt('run it', 'default');
    await flushMicrotasks(); // turn-1 live, prompt hanging

    const pending = controller.handlePermission(makeCommandReq('npm test'), 'appr-1');
    await flushMicrotasks();
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(true);

    controller.cancel();

    const res = await pending;
    // Fails today: cancel() only fires session/cancel — the registered
    // promise never settles, so `res` would still be pending (this await
    // would hang) were it not for the RPC-level timeout vitest itself imposes.
    expect(res).toEqual(buildCancelledOutcome());
    expect(emitted).toContainEqual({
      type: 'approval.settle',
      sessionId: 'session-1',
      turnId: 'turn-1',
      id: 'appr-1',
      toolId: 'cmd-1',
      outcome: 'cancelled',
    });
  });

  it(
    'V-6 RED (fake timers): the 60s auto-deny deadline settles the approval as expired; a late respondApproval resolves nothing further',
    async () => {
      vi.useFakeTimers();
      try {
        const client = makeApprovalClient({ prompt: () => new Promise<never>(() => {}) });
        const { port, emitted, logs } = makeSettlePort(client);
        const controller = new SessionController('session-1', '/tmp/ws-a0', port);
        controller.sendPrompt('run it', 'default');
        await flushMicrotasks(); // turn-1 live, prompt hanging

        const pending = controller.handlePermission(makeCommandReq('npm test', 'cmd-v6'), 'appr-v6');
        await flushMicrotasks();
        expect(emitted.some((m) => m.type === 'approval.request')).toBe(true);

        // Fails today: nothing is armed at registration, so nothing fires here.
        vi.advanceTimersByTime(60_000);

        const res = await pending;
        expect(res).toEqual(buildCancelledOutcome());
        expect(emitted).toContainEqual({
          type: 'approval.settle',
          sessionId: 'session-1',
          turnId: 'turn-1',
          id: 'appr-v6',
          toolId: 'cmd-v6',
          outcome: 'expired',
        });

        // The V-6 false-consent host half: a late click on an already-expired
        // card must resolve NOTHING (the promise already settled) and must
        // NOT emit a second settle.
        const settleCountAfterExpiry = emitted.filter((m) => m.type === 'approval.settle').length;
        controller.respondApproval('appr-v6', 'allow_once');
        expect(logs.some((l) => l.includes("no pending approval 'appr-v6'"))).toBe(true);
        expect(emitted.filter((m) => m.type === 'approval.settle').length).toBe(settleCountAfterExpiry);
      } finally {
        vi.useRealTimers();
      }
    },
    2000,
  );

  it('V-5-host RED: a turn ending (status "cancelled") settles any still-pending approval', async () => {
    type PromptResult = Awaited<ReturnType<AcpClientLike['prompt']>>;
    let resolvePrompt!: (value: PromptResult) => void;
    const promptPromise = new Promise<PromptResult>((resolve) => {
      resolvePrompt = resolve;
    });
    const client = makeApprovalClient({ prompt: async () => promptPromise });
    const { port, emitted } = makeSettlePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-a0', port);

    // sendPrompt sets `currentTurnId` SYNCHRONOUSLY before any await, so the
    // handlePermission call right below reads the real live turn id ('turn-1').
    controller.sendPrompt('do the thing', 'default');
    const pending = controller.handlePermission(makeCommandReq('npm test', 'cmd-v5'), 'appr-v5');
    await flushMicrotasks();
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(true);

    resolvePrompt({ stopReason: 'cancelled' });
    await pending;
    await vi.waitFor(() => expect(emitted.some((m) => m.type === 'turn.end')).toBe(true));

    // Fails today: `emitTurnEnd` never touches `pendingApprovals` — the card
    // (and the harness's blocked permission thread) is abandoned.
    expect(emitted).toContainEqual({
      type: 'approval.settle',
      sessionId: 'session-1',
      turnId: 'turn-1',
      id: 'appr-v5',
      toolId: 'cmd-v5',
      outcome: 'cancelled',
    });
  });

  it('Echo RED: respondApproval emits approval.settle{outcome:"selected", optionId}', async () => {
    const client = makeApprovalClient({ prompt: () => new Promise<never>(() => {}) });
    const { port, emitted } = makeSettlePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-a0', port);
    controller.sendPrompt('run it', 'default');
    await flushMicrotasks(); // turn-1 live, prompt hanging

    const pending = controller.handlePermission(makeCommandReq('npm test', 'cmd-echo'), 'appr-echo');
    await flushMicrotasks();
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(true);

    controller.respondApproval('appr-echo', 'allow_once');
    await pending;

    // Fails today: respondApproval resolves the promise but emits nothing —
    // the ONLY record of the response was the webview's own optimistic dispatch.
    expect(emitted).toContainEqual({
      type: 'approval.settle',
      sessionId: 'session-1',
      turnId: 'turn-1',
      id: 'appr-echo',
      toolId: 'cmd-echo',
      outcome: 'selected',
      optionId: 'allow_once',
    });
  });

  it(
    'Timer hygiene RED: after respondApproval, advancing 60s emits no further approval.settle (timer cleared)',
    async () => {
      vi.useFakeTimers();
      try {
        const client = makeApprovalClient({ prompt: () => new Promise<never>(() => {}) });
        const { port, emitted } = makeSettlePort(client);
        const controller = new SessionController('session-1', '/tmp/ws-a0', port);
        controller.sendPrompt('run it', 'default');
        await flushMicrotasks(); // turn-1 live, prompt hanging

        const pending = controller.handlePermission(makeCommandReq('npm test', 'cmd-hyg'), 'appr-hyg');
        await flushMicrotasks();
        expect(emitted.some((m) => m.type === 'approval.request')).toBe(true);

        controller.respondApproval('appr-hyg', 'allow_once');
        await pending;

        const settleCount = emitted.filter((m) => m.type === 'approval.settle').length;
        expect(settleCount).toBe(1);

        // Directly proves respondApproval cleared the expiry timer. If the
        // clearTimeout were dropped, an armed 60s timer would still be pending
        // here — and the map-gone idempotency guard would hide that from the
        // emit-count assertion below, so this timer-count check is the real
        // guard against a leaked timer (review M-1).
        expect(vi.getTimerCount()).toBe(0);

        vi.advanceTimersByTime(60_000);

        // And no late settle emits on the answered path.
        expect(emitted.filter((m) => m.type === 'approval.settle').length).toBe(settleCount);
      } finally {
        vi.useRealTimers();
      }
    },
    2000,
  );
});

describe('SessionController.sendPrompt — ARCH-1 (final review, UI I-4): result.summary carries real status', () => {
  /** Minimal `AcpClientLike` stub whose `prompt` resolves with a caller-supplied
   *  `AcpPromptResult` — every other member throws if reached (mirrors the
   *  setModel describe block's `makeFakeClient`, trimmed to this file's needs). */
  function makeFakeClient(prompt: AcpClientLike['prompt']): AcpClientLike {
    const unused = (name: string): never => {
      throw new Error(`unexpected call to AcpClientLike.${name} in a sendPrompt/result.summary test`);
    };
    return {
      connect: async () => unused('connect'),
      initialize: async () => unused('initialize'),
      newSession: async () => unused('newSession'),
      prompt,
      cancel: async () => unused('cancel'),
      setSessionMode: async () => unused('setSessionMode'),
      setSessionModel: async () => unused('setSessionModel'),
      listSessions: async (): Promise<AcpListSessionsRawResult> => unused('listSessions'),
      loadSession: async () => unused('loadSession'),
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
    };
  }

  function makePromptPort(client: AcpClientLike): { port: SessionHostPort; emitted: HostToWebviewMessage[] } {
    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => ['/tmp/ws'],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return { port, emitted };
  }

  it('result.summary carries status="cancelled" for a turn whose ACP response stopReason is "cancelled"', async () => {
    const client = makeFakeClient(async () => ({ stopReason: 'cancelled' }));
    const { port, emitted } = makePromptPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);

    controller.sendPrompt('do the thing', 'default');

    await vi.waitFor(() => expect(emitted.some((m) => m.type === 'result.summary')).toBe(true));

    const summary = emitted.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'result.summary' }> => m.type === 'result.summary',
    );
    expect(summary?.status).toBe('cancelled');
  });

  it('result.summary carries status="error" for a turn whose ACP response stopReason is "refusal"', async () => {
    const client = makeFakeClient(async () => ({ stopReason: 'refusal' }));
    const { port, emitted } = makePromptPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);

    controller.sendPrompt('do the thing', 'default');

    await vi.waitFor(() => expect(emitted.some((m) => m.type === 'result.summary')).toBe(true));

    const summary = emitted.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'result.summary' }> => m.type === 'result.summary',
    );
    expect(summary?.status).toBe('error');
  });

  it('result.summary carries status="complete" for a normal end_turn stopReason', async () => {
    const client = makeFakeClient(async () => ({ stopReason: 'end_turn' }));
    const { port, emitted } = makePromptPort(client);
    const controller = new SessionController('session-1', '/tmp/ws', port);

    controller.sendPrompt('do the thing', 'default');

    await vi.waitFor(() => expect(emitted.some((m) => m.type === 'result.summary')).toBe(true));

    const summary = emitted.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'result.summary' }> => m.type === 'result.summary',
    );
    expect(summary?.status).toBe('complete');
  });
});

/**
 * V-18 (Tier-2 remediation architecture §2 — RISKIEST task in the programme):
 * `/steer` and `/queue` typed while THIS session's own turn is live must be
 * admitted as a same-session "control utterance" instead of hitting the
 * existing `liveTurnId` refusal — WITHOUT breaking P-1 session isolation.
 * Every test below drives `SessionController.sendPrompt` directly (headless,
 * no `AcpBackend`), using a `client.prompt` stub that returns a FRESH,
 * independently-controllable deferred promise per call — the real ACP wire
 * genuinely runs two concurrent `session/prompt`s in this scenario (the
 * live turn's original prompt AND the utterance's own), and this suite must
 * be able to resolve/reject/leave-pending each independently to prove
 * neither one's bookkeeping bleeds into the other's.
 */
describe('SessionController.sendPrompt — V-18 STEER-QUEUE: mid-turn control utterance', () => {
  /** Flushes the microtask queue N times — the checkpoint-barrier +
   *  mention-resolution awaits in `runTurnWithCheckpoint`, and the
   *  `Promise.race` inside `runControlUtterance`, are each a few real
   *  microtask hops (no timers), so a generous fixed count fully settles
   *  them. Safe to call under `vi.useFakeTimers()` too — fake timers never
   *  fake Promise microtask scheduling, only `setTimeout`/`Date.now`. */
  async function flushMicrotasks(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  type PromptResult = { stopReason: string; usage?: unknown };

  function deferredPrompt(): {
    promise: Promise<PromptResult>;
    resolve: (value: PromptResult) => void;
    reject: (err: unknown) => void;
  } {
    let resolve!: (value: PromptResult) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<PromptResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Every `client.prompt(...)` call gets its OWN deferred promise, recorded
   *  by call index — lets a test independently settle the live turn's
   *  prompt and a mid-turn utterance's prompt, in either order, mirroring
   *  the real ACP wire (two concurrent `session/prompt`s, correlated by the
   *  SDK's own JSON-RPC id, not by anything this fake needs to model). */
  function makeControllablePromptClient(): {
    client: AcpClientLike;
    promptCalls: Array<{ sessionId: string; content: AcpOutboundContentBlock[] }>;
    resolvePrompt: (index: number, result: PromptResult) => void;
    rejectPrompt: (index: number, err: unknown) => void;
    cancelCalls: string[];
  } {
    const promptCalls: Array<{ sessionId: string; content: AcpOutboundContentBlock[] }> = [];
    const deferreds: Array<ReturnType<typeof deferredPrompt>> = [];
    const cancelCalls: string[] = [];
    const unused = (name: string): never => {
      throw new Error(`unexpected call to AcpClientLike.${name} in a V-18 control-utterance test`);
    };
    const client: AcpClientLike = {
      connect: async () => unused('connect'),
      initialize: async () => unused('initialize'),
      newSession: async () => unused('newSession'),
      prompt: async (sessionId, content) => {
        promptCalls.push({ sessionId, content });
        const d = deferredPrompt();
        deferreds.push(d);
        return d.promise;
      },
      cancel: async (sessionId: string) => {
        cancelCalls.push(sessionId);
      },
      setSessionMode: async () => unused('setSessionMode'),
      setSessionModel: async () => unused('setSessionModel'),
      listSessions: async (): Promise<AcpListSessionsRawResult> => unused('listSessions'),
      loadSession: async () => unused('loadSession'),
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
    };
    return {
      client,
      promptCalls,
      resolvePrompt: (index, result) => {
        const d = deferreds[index];
        if (!d) throw new Error(`no client.prompt call recorded at index ${index}`);
        d.resolve(result);
      },
      rejectPrompt: (index, err) => {
        const d = deferreds[index];
        if (!d) throw new Error(`no client.prompt call recorded at index ${index}`);
        d.reject(err);
      },
      cancelCalls,
    };
  }

  function makeUtterancePort(client: AcpClientLike): { port: SessionHostPort; emitted: HostToWebviewMessage[] } {
    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => ['/tmp/ws-v18'],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return { port, emitted };
  }

  it('RED 1+7: a mid-turn /steer fires a SECOND client.prompt with the raw text while the first is still live — no turn.start/turn.end, live turn unaffected — and admits it as a `user` bubble on the LIVE turnId', async () => {
    const { client, promptCalls } = makeControllablePromptClient();
    const { port, emitted } = makeUtterancePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-v18', port);

    controller.sendPrompt('do the real thing', 'default');
    await flushMicrotasks();
    expect(promptCalls).toHaveLength(1);
    expect(emitted.map((m) => m.type)).toEqual(['turn.start', 'user']);
    const baseline = emitted.length;

    // RED today: `sendPrompt`'s pre-fix `liveTurnId` guard refuses this
    // unconditionally — no second `client.prompt` call, and the emitted
    // message is the refusal `error`, not a `user` bubble.
    controller.sendPrompt('/steer focus the failing test', 'default');

    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[1]).toEqual({
      sessionId: 'session-1',
      content: [{ type: 'text', text: '/steer focus the failing test' }],
    });

    const newMessages = emitted.slice(baseline);
    expect(newMessages).toEqual([
      { type: 'user', turnId: 'turn-1', sessionId: 'session-1', text: '/steer focus the failing test', mode: 'default' },
    ]);

    // `runControlUtterance` touches NO turn bookkeeping: still exactly one
    // turn.start, zero turn.end, the live turn still live.
    expect(emitted.filter((m) => m.type === 'turn.start')).toHaveLength(1);
    expect(emitted.filter((m) => m.type === 'turn.end')).toHaveLength(0);
    expect(controller.hasLiveTurn()).toBe(true);
  });

  it('RED 2: the utterance\'s own end_turn resolution does NOT end the live turn — turn.end arrives only when the REAL prompt resolves', async () => {
    const { client, promptCalls, resolvePrompt } = makeControllablePromptClient();
    const { port, emitted } = makeUtterancePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-v18', port);

    controller.sendPrompt('do the real thing', 'default');
    await flushMicrotasks();
    controller.sendPrompt('/queue also handle the docs', 'default');
    expect(promptCalls).toHaveLength(2);

    // RED today: unreachable (the utterance never fires a second prompt
    // pre-fix) — but post-fix, resolving the UTTERANCE's own prompt (index 1)
    // must be a complete no-op on turn bookkeeping: its PromptResponse is
    // ignored entirely.
    resolvePrompt(1, { stopReason: 'end_turn' });
    await flushMicrotasks();
    expect(emitted.some((m) => m.type === 'turn.end')).toBe(false);
    expect(emitted.some((m) => m.type === 'result.summary')).toBe(false);
    expect(controller.hasLiveTurn()).toBe(true);

    // Only the REAL prompt's (index 0) resolution ends the live turn.
    resolvePrompt(0, { stopReason: 'end_turn' });
    await flushMicrotasks();
    const turnEnds = emitted.filter((m) => m.type === 'turn.end');
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({ turnId: 'turn-1', status: 'complete' });
    expect(controller.hasLiveTurn()).toBe(false);
  });

  describe('parity — mirrors the harness parser exactly (server.py:1727-1734)', () => {
    async function setupLiveTurn(): Promise<{
      controller: SessionController;
      promptCalls: Array<{ sessionId: string; content: AcpOutboundContentBlock[] }>;
      emitted: HostToWebviewMessage[];
    }> {
      const { client, promptCalls } = makeControllablePromptClient();
      const { port, emitted } = makeUtterancePort(client);
      const controller = new SessionController('session-1', '/tmp/ws-v18', port);
      controller.sendPrompt('do the real thing', 'default');
      await flushMicrotasks();
      expect(promptCalls).toHaveLength(1);
      return { controller, promptCalls, emitted };
    }

    it('//STEER x (double leading slash + uppercase) IS a control utterance', async () => {
      const { controller, promptCalls } = await setupLiveTurn();
      controller.sendPrompt('//STEER x', 'default');
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]?.content).toEqual([{ type: 'text', text: '//STEER x' }]);
    });

    it('/queue\\tx (tab-separated) IS a control utterance', async () => {
      const { controller, promptCalls } = await setupLiveTurn();
      controller.sendPrompt('/queue\tx', 'default');
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]?.content).toEqual([{ type: 'text', text: '/queue\tx' }]);
    });

    it('/steermore (unknown command, no separator) is NOT a control utterance — existing refusal, byte-identical copy', async () => {
      const { controller, promptCalls, emitted } = await setupLiveTurn();
      const baseline = emitted.length;
      controller.sendPrompt('/steermore', 'default');
      expect(promptCalls).toHaveLength(1); // no second client.prompt
      expect(emitted.slice(baseline)).toEqual([
        {
          type: 'error',
          sessionId: 'session-1',
          message: 'A turn is already running. Stop it before sending a new message.',
        },
      ]);
    });

    it('/steer with an attachment is NOT a control utterance — existing refusal, byte-identical copy', async () => {
      const { controller, promptCalls, emitted } = await setupLiveTurn();
      const baseline = emitted.length;
      const attachment: Attachment = { id: 'a1', name: 'notes.txt', kind: 'file' };
      controller.sendPrompt('/steer look at this', 'default', [attachment]);
      expect(promptCalls).toHaveLength(1);
      expect(emitted.slice(baseline)).toEqual([
        {
          type: 'error',
          sessionId: 'session-1',
          message: 'A turn is already running. Stop it before sending a new message.',
        },
      ]);
    });

    it('plain non-command text mid-turn is NOT a control utterance — existing refusal, byte-identical copy (unchanged behavior)', async () => {
      const { controller, promptCalls, emitted } = await setupLiveTurn();
      const baseline = emitted.length;
      controller.sendPrompt('just a normal follow-up message', 'default');
      expect(promptCalls).toHaveLength(1);
      expect(emitted.slice(baseline)).toEqual([
        {
          type: 'error',
          sessionId: 'session-1',
          message: 'A turn is already running. Stop it before sending a new message.',
        },
      ]);
    });
  });

  it('isolation: a DIFFERENT session\'s /steer while it is idle and another session holds the shared root\'s turn lease takes the NORMAL path and gets the existing lease-refusal, byte-identical', async () => {
    // A real, stateful root lease shared by both controllers — `makeRoot()`
    // always grants (`tryAcquireTurnLease: () => true`), which cannot
    // exercise cross-session contention.
    let holder: string | undefined;
    const sharedRoot: RootCoordinatorLike = {
      rootId: 'root-shared-v18',
      tracker: undefined,
      tryAcquireTurnLease: (sessionId) => {
        if (holder === undefined || holder === sessionId) {
          holder = sessionId;
          return true;
        }
        return false;
      },
      releaseTurnLease: (sessionId) => {
        if (holder === sessionId) holder = undefined;
      },
      anyLiveTurn: () => holder !== undefined,
      nextTurnOrdinal: () => 1,
      nextBaselineOrdinal: () => -1,
      refreshCheckpointsPanel: () => {},
    };

    const { client: clientA } = makeControllablePromptClient();
    const emittedA: HostToWebviewMessage[] = [];
    const portA: SessionHostPort = {
      getClient: () => clientA,
      emit: (msg) => emittedA.push(msg),
      emitSystemError: () => {},
      root: sharedRoot,
      workspaceRoots: () => ['/tmp/ws-v18-shared'],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controllerA = new SessionController('session-A', '/tmp/ws-v18-shared', portA);
    controllerA.sendPrompt('A starts a turn', 'default');
    await flushMicrotasks();
    expect(controllerA.hasLiveTurn()).toBe(true); // A holds the root lease

    const { client: clientB, promptCalls: promptCallsB } = makeControllablePromptClient();
    const emittedB: HostToWebviewMessage[] = [];
    const portB: SessionHostPort = {
      getClient: () => clientB,
      emit: (msg) => emittedB.push(msg),
      emitSystemError: () => {},
      root: sharedRoot,
      workspaceRoots: () => ['/tmp/ws-v18-shared'],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controllerB = new SessionController('session-B', '/tmp/ws-v18-shared', portB);

    // B is IDLE (no liveTurnId of its own) — the mid-turn detector is never
    // even consulted; B takes the normal `sendPrompt` path straight into the
    // (unmodified) root-lease acquire, which A already holds.
    controllerB.sendPrompt('/steer focus the failing test', 'default');

    expect(promptCallsB).toHaveLength(0); // no client.prompt call for B at all
    expect(emittedB).toEqual([
      {
        type: 'error',
        sessionId: 'session-B',
        message: 'A turn is already running in this workspace. Stop it before sending a new message.',
      },
    ]);
  });

  it('V-18 deadline: an utterance whose prompt never settles emits exactly ONE session-scoped error after the 15s deadline; client.cancel is NOT called; the live turn is unaffected', async () => {
    vi.useFakeTimers();
    try {
      const { client, promptCalls, cancelCalls } = makeControllablePromptClient();
      const { port, emitted } = makeUtterancePort(client);
      const controller = new SessionController('session-1', '/tmp/ws-v18', port);

      controller.sendPrompt('do the real thing', 'default');
      await flushMicrotasks();
      controller.sendPrompt('/steer wait for it', 'default');
      expect(promptCalls).toHaveLength(2);
      const baseline = emitted.length;

      // RED today: unreachable pre-fix (no deadline mechanism exists at all
      // for a path that never fires a second prompt).
      vi.advanceTimersByTime(15_000);
      await flushMicrotasks();

      expect(emitted.slice(baseline)).toEqual([
        {
          type: 'error',
          sessionId: 'session-1',
          message: 'The /steer or /queue command may not have been delivered — the agent did not acknowledge it.',
        },
      ]);
      // The deadline handler must NOT call client.cancel — that is
      // session-scoped and would kill the user's live turn.
      expect(cancelCalls).toEqual([]);
      // The live turn (the FIRST, still-pending client.prompt) is untouched.
      expect(controller.hasLiveTurn()).toBe(true);
      expect(emitted.some((m) => m.type === 'turn.end')).toBe(false);

      // Advancing further must not emit a second error (the deadline promise
      // already settled and is not re-armed).
      const afterFirstDeadline = emitted.length;
      vi.advanceTimersByTime(60_000);
      await flushMicrotasks();
      expect(emitted.length).toBe(afterFirstDeadline);
    } finally {
      vi.useRealTimers();
    }
  }, 2000);

  it('V-18 deadline (BF-B): a deadline firing AFTER dispose() emits nothing into the dead controller', async () => {
    vi.useFakeTimers();
    try {
      const { client, promptCalls } = makeControllablePromptClient();
      const { port, emitted } = makeUtterancePort(client);
      const controller = new SessionController('session-1', '/tmp/ws-v18', port);

      controller.sendPrompt('do the real thing', 'default');
      await flushMicrotasks();
      controller.sendPrompt('/queue also this', 'default');
      expect(promptCalls).toHaveLength(2);

      controller.dispose();
      const baseline = emitted.length;

      vi.advanceTimersByTime(15_000);
      await flushMicrotasks();

      // Nothing new — the BF-B liveness guard (`if (this.disposed) return;`)
      // suppresses the would-be error.
      expect(emitted.length).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  }, 2000);
});

/**
 * V-19 (Tier-2 T-12): `Attachment.path` used to reach `buildPromptContent`'s
 * `pathToFileUri` completely unconfined. `runTurn` now confines it FIRST
 * (`resolveWithinWorkspaceReal`), secret-gates it SECOND — the exact ordering
 * and primitives the mention path already uses (`context/resolver.ts`'s
 * `resolveFileOrFolder`) — before it can ever reach `client.prompt()`. These
 * tests drive the real default confinement (real `fs.realpath`/`lstat`, not
 * an injected fake — `SessionController` has no seam to inject one, matching
 * scope), so they use a REAL temp workspace directory, mirroring
 * `SessionController.handlePermission`'s own BF-B suite above.
 */
describe('SessionController.sendPrompt — V-19: attachment path confinement', () => {
  const tmpDirs: string[] = [];
  function makeTmpWs(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-sc-v19-ws-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  function makeFakeClient(prompt: AcpClientLike['prompt']): AcpClientLike {
    const unused = (name: string): never => {
      throw new Error(`unexpected call to AcpClientLike.${name} in a V-19 attachment-confinement test`);
    };
    return {
      connect: async () => unused('connect'),
      initialize: async () => unused('initialize'),
      newSession: async () => unused('newSession'),
      prompt,
      cancel: async () => unused('cancel'),
      setSessionMode: async () => unused('setSessionMode'),
      setSessionModel: async () => unused('setSessionModel'),
      listSessions: async (): Promise<AcpListSessionsRawResult> => unused('listSessions'),
      loadSession: async () => unused('loadSession'),
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
    };
  }

  function makeV19Port(
    client: AcpClientLike,
    ws: string,
  ): { port: SessionHostPort; emitted: HostToWebviewMessage[] } {
    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => [ws],
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return { port, emitted };
  }

  it('RED: an attachment whose path resolves OUTSIDE the workspace is dropped from the prompt content AND a session-scoped error names the drop count (never the path)', async () => {
    const ws = makeTmpWs();
    const outside = makeTmpWs(); // a second, sibling real dir — NOT nested under `ws`
    let promptContent: AcpOutboundContentBlock[] | undefined;
    const client = makeFakeClient(async (_sessionId, content) => {
      promptContent = content;
      return { stopReason: 'end_turn' };
    });
    const { port, emitted } = makeV19Port(client, ws);
    const controller = new SessionController('session-1', ws, port);

    const outsidePath = path.join(outside, 'secret-plan.txt');
    const attachment: Attachment = { id: 'a1', name: 'secret-plan.txt', kind: 'file', path: outsidePath };
    controller.sendPrompt('look at this', 'default', [attachment]);

    await vi.waitFor(() => expect(promptContent).toBeDefined());

    // Dropped: no resource_link for it anywhere in the content sent to Hermes.
    expect(promptContent).toEqual([{ type: 'text', text: 'look at this' }]);

    // A session-scoped error names the COUNT — never the raw path/content.
    const errorMsg = emitted.find(
      (m): m is Extract<HostToWebviewMessage, { type: 'error' }> => m.type === 'error',
    );
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.sessionId).toBe('session-1');
    expect(errorMsg?.message).toContain('1 attachment');
    expect(errorMsg?.message).not.toContain(outsidePath);
    expect(errorMsg?.message).not.toContain('secret-plan.txt');
  });

  it('RED: an in-workspace, non-secret attachment is sent normally — no drop error emitted', async () => {
    const ws = makeTmpWs();
    let promptContent: AcpOutboundContentBlock[] | undefined;
    const client = makeFakeClient(async (_sessionId, content) => {
      promptContent = content;
      return { stopReason: 'end_turn' };
    });
    const { port, emitted } = makeV19Port(client, ws);
    const controller = new SessionController('session-1', ws, port);

    const insidePath = path.join(ws, 'notes.txt');
    const attachment: Attachment = { id: 'a2', name: 'notes.txt', kind: 'file', path: insidePath, mime: 'text/plain' };
    controller.sendPrompt('look at this', 'default', [attachment]);

    await vi.waitFor(() => expect(promptContent).toBeDefined());

    expect(promptContent).toHaveLength(2);
    expect(promptContent?.[1]).toMatchObject({ type: 'resource_link', name: 'notes.txt', mimeType: 'text/plain' });
    expect(emitted.some((m) => m.type === 'error')).toBe(false);
  });
});

/**
 * I-2 (W1-T3 review, Important fix): `loadReplayOutcome`'s LAST supersede
 * guard (`this.replay !== replay`) sits right before `this.replay =
 * undefined` (~:1142-1144) — but `await this.pinWireModeDefault(...)`
 * (~:1154) is a SEPARATE suspension point AFTER that guard, with no recheck
 * once it resolves. If a second, superseding `loadReplayOutcome` call (B)
 * starts while the first (A) is parked on that pin await — and B is itself
 * still in flight (parked on its OWN `client.loadSession` await, so
 * `this.replay` still points at B's fresh `ReplayTranslator`) — A resuming
 * after the pin would, pre-fix, call `markSubagentsInterrupted()` against
 * B's already-reset fold and emit a STALE `turn.end{complete}` for A's own
 * superseded turn on top of B's still-live replay. Fixed: recheck
 * `this.replay !== undefined` right after the pin await, before touching
 * subagents or emitting `turn.end` — A's own reset at ~:1144 left
 * `this.replay` `undefined`; a non-undefined value at this point can only
 * mean a superseding call claimed it in the meantime.
 *
 * WS-R4 step 5: both tests below drive `loadReplayOutcome` directly (the
 * `loadReplay` adapter these were originally written against is deleted) —
 * their `resultA`/`resultB` assertions now check the union `kind` instead of
 * the adapter's collapsed `AcpLoadSessionResult | undefined`; the underlying
 * race being characterized is unchanged.
 */
describe('SessionController.loadReplayOutcome — I-2 (W1-T3 review): supersede recheck AFTER the pinWireModeDefault await', () => {
  /** Same tiny deferred-promise helper `AcpBackend.test.ts` uses. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  // I-2 re-review (W1-T3 fix2): this first test exercises the SYNTHETIC
  // same-instance variant — a second `loadReplayOutcome` call re-claiming
  // `this.replay` on the SAME controller — which the recheck's
  // `this.replay !== undefined`
  // half does cover, but which production never actually does. The test
  // below it ('A DISPOSED while parked...') exercises the REAL production
  // supersede: `SessionRegistry.open` minting a FRESH controller and
  // DISPOSING this one, which is what the `|| this.disposed` half guards.
  it('A superseded WHILE parked on pinWireModeDefault emits NOTHING past the pin — no stale turn.end, and the superseding load B still finishes honestly', async () => {
    const loadSessionA = deferred<AcpLoadSessionResult>();
    const loadSessionB = deferred<AcpLoadSessionResult>();
    const setSessionModeA = deferred<void>();

    const client: AcpClientLike = {
      connect: async () => {
        throw new Error('unused: connect');
      },
      initialize: async () => {
        throw new Error('unused: initialize');
      },
      newSession: async () => {
        throw new Error('unused: newSession');
      },
      prompt: async () => {
        throw new Error('unused: prompt');
      },
      cancel: async () => {
        throw new Error('unused: cancel');
      },
      // A is a drifted session (forces the pin's setSessionMode call, which
      // this test parks open); B never drifts, so its own pin never calls
      // this at all.
      setSessionMode: async (sessionId: string) => {
        if (sessionId === 'session-A') return setSessionModeA.promise;
        throw new Error(`unexpected setSessionMode call for ${sessionId}`);
      },
      setSessionModel: async () => {
        throw new Error('unused: setSessionModel');
      },
      listSessions: async (): Promise<AcpListSessionsRawResult> => {
        throw new Error('unused: listSessions');
      },
      loadSession: async (_cwd: string, sessionId: string) => {
        if (sessionId === 'session-A') return loadSessionA.promise;
        if (sessionId === 'session-B') return loadSessionB.promise;
        throw new Error(`unexpected loadSession call for ${sessionId}`);
      },
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
    };

    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => [],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controller = new SessionController('bootstrap', '/ws', port);

    // A starts and parks on `client.loadSession`.
    const replayA = controller.loadReplayOutcome('/ws', 'session-A', '/ws', []);

    // A's load resolves with a drift, so A proceeds into the pin — which
    // itself parks on `setSessionModeA`. Flush generously: since
    // `setSessionModeA` never resolves on its own, A cannot run past that
    // await no matter how many microtasks are flushed here.
    loadSessionA.resolve({ found: true, currentModeId: 'accept_edits' });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // B supersedes A on the SAME controller — a second, later
    // `loadReplayOutcome` call — and parks on ITS OWN `client.loadSession`
    // (never reaches the pin in this test). `this.replay` now points at B's
    // fresh ReplayTranslator.
    const replayB = controller.loadReplayOutcome('/ws', 'session-B', '/ws', []);
    await Promise.resolve();

    emitted.length = 0; // isolate: only what happens from here on is under test

    // Let A's pin settle — A resumes INSIDE loadReplayOutcome, past the pin
    // await, with B still fully in flight.
    setSessionModeA.resolve(undefined);
    const resultA = await replayA;

    // The fix: A emits NOTHING past the pin boundary once superseded — no
    // stale turn.end, no commands.available, nothing. WS-R4 step 5: this is
    // the post-pin supersede arm — bare `{kind:'superseded'}`, no `result`
    // key (exactOptional absent-key discipline).
    expect(emitted).toEqual([]);
    expect(resultA).toEqual({ kind: 'superseded' });
    expect('result' in resultA).toBe(false);

    // B is unaffected and still completes honestly with its own turn.end.
    loadSessionB.resolve({ found: true, currentModeId: 'default' });
    const resultB = await replayB;
    expect(resultB).toEqual({ kind: 'loaded', result: { found: true, currentModeId: 'default' } });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'complete' }));
  });

  /**
   * I-2 re-review (W1-T3 fix2, Important): the production supersede.
   * `recoverOneSession` (`ConnectionSupervisor.ts:600`) and
   * `loadSessionIntoTab` (`AcpBackend.ts:1200`) never re-claim `this.replay`
   * on the SAME controller instance the way the synthetic test above does —
   * they mint a FRESH controller via `SessionRegistry.open`, which DISPOSES
   * the prior controller for that sessionId (`SessionRegistry.ts:38-41`).
   * `dispose()` resets `this.replay` back to `undefined` (not to a new
   * token) and sets `this.disposed = true`. Pre-fix, the recheck's
   * `this.replay !== undefined` half is FALSE on the disposed controller (it
   * really is `undefined` again) — so the disposed controller falls through
   * and fires `markSubagentsInterrupted()` + a stale `turn.end{complete}`
   * into a tab a fresh controller has since taken over. Fixed by also
   * guarding `this.disposed`.
   */
  it('A DISPOSED while parked on pinWireModeDefault (the real production supersede — SessionRegistry.open minting a fresh controller) emits NOTHING past the pin', async () => {
    const loadSessionA = deferred<AcpLoadSessionResult>();
    const setSessionModeA = deferred<void>();

    const client: AcpClientLike = {
      connect: async () => {
        throw new Error('unused: connect');
      },
      initialize: async () => {
        throw new Error('unused: initialize');
      },
      newSession: async () => {
        throw new Error('unused: newSession');
      },
      prompt: async () => {
        throw new Error('unused: prompt');
      },
      cancel: async () => {
        throw new Error('unused: cancel');
      },
      // A is a drifted session (forces the pin's setSessionMode call, which
      // this test parks open).
      setSessionMode: async (sessionId: string) => {
        if (sessionId === 'session-A') return setSessionModeA.promise;
        throw new Error(`unexpected setSessionMode call for ${sessionId}`);
      },
      setSessionModel: async () => {
        throw new Error('unused: setSessionModel');
      },
      listSessions: async (): Promise<AcpListSessionsRawResult> => {
        throw new Error('unused: listSessions');
      },
      loadSession: async (_cwd: string, sessionId: string) => {
        if (sessionId === 'session-A') return loadSessionA.promise;
        throw new Error(`unexpected loadSession call for ${sessionId}`);
      },
      onExit: () => ({ dispose: () => {} }),
      dispose: () => {},
    };

    const emitted: HostToWebviewMessage[] = [];
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => [],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controller = new SessionController('bootstrap', '/ws', port);

    // A starts and parks on `client.loadSession`.
    const replayA = controller.loadReplayOutcome('/ws', 'session-A', '/ws', []);

    // A's load resolves with a drift, so A proceeds into the pin — which
    // itself parks on `setSessionModeA`. Flush generously: since
    // `setSessionModeA` never resolves on its own, A cannot run past that
    // await no matter how many microtasks are flushed here.
    loadSessionA.resolve({ found: true, currentModeId: 'accept_edits' });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The REAL production supersede: a fresh controller is minted for this
    // sessionId (`SessionRegistry.open`) and THIS controller is disposed —
    // never a second `loadReplayOutcome` call on the same instance. No live
    // turn is registered here, so `dispose()` takes its no-op branch for the
    // cancel/turn-lease bookkeeping; what matters is `this.replay =
    // undefined` and `this.disposed = true`.
    emitted.length = 0; // isolate: only what happens from here on is under test
    controller.dispose();

    // Let A's pin settle — A resumes INSIDE loadReplayOutcome, past the pin
    // await, on a controller that is now disposed.
    setSessionModeA.resolve(undefined);
    const resultA = await replayA;

    // The fix: A emits NOTHING past the pin boundary once disposed — no
    // stale turn.end, no commands.available, nothing. WS-R4 step 5: bare
    // `{kind:'superseded'}` via the `|| this.disposed` half of the recheck.
    expect(emitted).toEqual([]);
    expect(resultA).toEqual({ kind: 'superseded' });
    expect('result' in resultA).toBe(false);
  });
});

describe('WS-R1 F3-4 — cancel fallback deadline force-ends an unresponsive turn', () => {
  function deferredPrompt(): {
    promise: Promise<{ stopReason: string }>;
    resolve: (v: { stopReason: string }) => void;
  } {
    let resolve!: (v: { stopReason: string }) => void;
    const promise = new Promise<{ stopReason: string }>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function makeCancelHarness(): {
    controller: SessionController;
    emitted: HostToWebviewMessage[];
    releaseCalls: number[];
    prompt: ReturnType<typeof deferredPrompt>;
    cancelCalls: string[];
  } {
    const emitted: HostToWebviewMessage[] = [];
    const releaseCalls: number[] = [];
    const cancelCalls: string[] = [];
    const prompt = deferredPrompt();
    const client = {
      cancel: async (sessionId: string) => {
        cancelCalls.push(sessionId);
      },
      prompt: () => prompt.promise,
    } as unknown as AcpClientLike;
    const root: RootCoordinatorLike = {
      rootId: 'root-1',
      tracker: undefined,
      tryAcquireTurnLease: () => true,
      releaseTurnLease: () => {
        releaseCalls.push(Date.now());
      },
      anyLiveTurn: () => false,
      nextTurnOrdinal: () => 1,
      nextBaselineOrdinal: () => -1,
      refreshCheckpointsPanel: () => {},
    };
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root,
      workspaceRoots: () => ['/fake/ws'],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controller = new SessionController('session-1', '/fake/ws', port);
    return { controller, emitted, releaseCalls, prompt, cancelCalls };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no turn end within 15s of cancel() → local force-end: turn.end{cancelled}, lease released, notice emitted, turnId recorded', async () => {
    const { controller, emitted, releaseCalls, cancelCalls } = makeCancelHarness();
    controller.sendPrompt('do the thing', 'default');
    await vi.advanceTimersByTimeAsync(0); // flush to the hanging client.prompt
    controller.cancel();
    expect(cancelCalls).toEqual(['session-1']);
    await vi.advanceTimersByTimeAsync(15_000);
    // M1 (code-lens review): exactly ONE turn.end on the pure force-end path
    // (not merely "at least one") — a double-emit regression on this path is
    // otherwise only caught on the harder belated-settlement test (below).
    expect(emitted.filter((m) => m.type === 'turn.end' && m.turnId === 'turn-1')).toHaveLength(1);
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'turn.end', turnId: 'turn-1', status: 'cancelled' }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'error', turnId: 'turn-1', message: expect.stringContaining('force-stopped') }),
    );
    expect(releaseCalls).toHaveLength(1);
    expect(controller.hasLiveTurn()).toBe(false);
    expect(controller.wasForceEnded('turn-1')).toBe(true);
  });

  it('belated genuine prompt settlement after a force-end is dropped: exactly ONE turn.end, NO result.summary', async () => {
    const { controller, emitted, prompt } = makeCancelHarness();
    controller.sendPrompt('do the thing', 'default');
    await vi.advanceTimersByTimeAsync(0);
    controller.cancel();
    await vi.advanceTimersByTimeAsync(15_000); // force-end fires
    prompt.resolve({ stopReason: 'cancelled' }); // the belated genuine settlement
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted.filter((m) => m.type === 'turn.end' && m.turnId === 'turn-1')).toHaveLength(1);
    expect(emitted.filter((m) => m.type === 'result.summary')).toHaveLength(0);
  });

  it('a genuine turn end BEFORE the deadline clears the timer — no force-end, no notice', async () => {
    const { controller, emitted, prompt } = makeCancelHarness();
    controller.sendPrompt('do the thing', 'default');
    await vi.advanceTimersByTimeAsync(0);
    controller.cancel();
    prompt.resolve({ stopReason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0); // genuine turn.end lands
    await vi.advanceTimersByTimeAsync(15_000); // deadline horizon passes
    expect(emitted.filter((m) => m.type === 'turn.end' && m.turnId === 'turn-1')).toHaveLength(1);
    expect(emitted.filter((m) => m.type === 'error' && typeof m.message === 'string' && m.message.includes('force-stopped'))).toHaveLength(0);
    expect(controller.wasForceEnded('turn-1')).toBe(false);
  });

  // M2 (code-lens review): the test above's "no force-end, no notice" outcome
  // is ALSO satisfiable by forceEndCancelledTurn's own independent
  // `liveTurnId !== turnId` guard — it would still pass even if emitTurnEnd
  // stopped calling clearCancelFallback(). This test isolates the clear
  // itself: checking vi.getTimerCount() right after the genuine end (with no
  // deadline advance in between) proves the timer handle is actually gone,
  // not merely neutralized by the other guard.
  it('a genuine turn.end before the deadline actually clears the cancel-fallback timer handle', async () => {
    const { controller, prompt } = makeCancelHarness();
    controller.sendPrompt('do the thing', 'default');
    await vi.advanceTimersByTimeAsync(0);
    controller.cancel();
    expect(vi.getTimerCount()).toBe(1); // fallback armed
    prompt.resolve({ stopReason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0); // genuine turn.end lands via emitTurnEnd
    expect(vi.getTimerCount()).toBe(0); // the handle itself is cleared, not just guarded
  });

  it('cancel() with no live prompt turn arms NO fallback timer', async () => {
    const { controller } = makeCancelHarness();
    const before = vi.getTimerCount();
    controller.cancel(); // nothing live
    expect(vi.getTimerCount()).toBe(before);
  });

  // Task 8 follow-up (concurrency-lens review Minor 1 / code-lens review M3):
  // endOnCrash/endForRestart clear the turn bookkeeping but, pre-fix, did NOT
  // clear an armed cancelFallbackTimer — stranding the handle. Harmless when
  // IT fires (forceEndCancelledTurn's own currentTurnId/liveTurnId guard
  // no-ops), but armCancelFallback's `cancelFallbackTimer !== undefined`
  // early-return means a stranded handle surviving onto a reused controller
  // would silently suppress the NEXT turn's fallback. vi.getTimerCount()
  // right after the crash/restart call is the discriminator: pre-fix it
  // stays elevated (the handle is still queued); post-fix it drops to 0.
  it('endOnCrash clears an armed cancel-fallback timer (defensive symmetry with dispose)', async () => {
    const { controller, emitted } = makeCancelHarness();
    controller.sendPrompt('do the thing', 'default');
    await vi.advanceTimersByTimeAsync(0);
    controller.cancel(); // arms the fallback
    expect(vi.getTimerCount()).toBe(1);
    controller.endOnCrash();
    expect(vi.getTimerCount()).toBe(0); // RED pre-fix: stays 1, the handle is stranded
    await vi.advanceTimersByTimeAsync(15_000); // deadline horizon passes
    expect(
      emitted.filter(
        (m) => m.type === 'error' && typeof m.message === 'string' && m.message.includes('force-stopped'),
      ),
    ).toHaveLength(0);
  });

  it('endForRestart clears an armed cancel-fallback timer (defensive symmetry with dispose)', async () => {
    const { controller, emitted } = makeCancelHarness();
    controller.sendPrompt('do the thing', 'default');
    await vi.advanceTimersByTimeAsync(0);
    controller.cancel(); // arms the fallback
    expect(vi.getTimerCount()).toBe(1);
    controller.endForRestart();
    expect(vi.getTimerCount()).toBe(0); // RED pre-fix: stays 1, the handle is stranded
    await vi.advanceTimersByTimeAsync(15_000); // deadline horizon passes
    expect(
      emitted.filter(
        (m) => m.type === 'error' && typeof m.message === 'string' && m.message.includes('force-stopped'),
      ),
    ).toHaveLength(0);
  });
});

/**
 * WS-R4 step 1 (REMEDIATION-ARCHITECTURE §3.4): characterization pins for
 * ALL SIX caller-visible outcomes `SessionController.loadReplayOutcome` can
 * produce. Originally written (Task 19) against the pre-union
 * `AcpLoadSessionResult | undefined` sentinel return, driven through the
 * `loadReplay` adapter Task 20 laid over the new union (Task 21-22 migrated
 * both production callers off that adapter onto the union directly). WS-R4
 * step 5 (Task 23) deletes the now-unused `loadReplay` adapter and flips
 * these SAME six arms to drive `loadReplayOutcome` directly, asserting its
 * `LoadReplayOutcome` union `kind` (+ payload) instead of the adapter's
 * collapsed return. These are NOT new-behavior tests — every pin here
 * characterizes the SAME underlying six-arm behavior before and after the
 * flip; if one fails, the test mischaracterized reality and must be fixed,
 * never the production code (characterization-TDD, not red/green TDD).
 *
 * The reusable harness (`makeLoadHarness` + `FakeLoadClient`) is deliberately
 * factored out here for reuse — same fake client, same port shape, so the
 * six arms below stay the behavior-preservation contract across the
 * adapter's whole migration-then-deletion arc.
 *
 * The decisive pin is the "success-but-superseded" arm (current source
 * `:1301`, `if (this.replay !== replay) return { kind: 'superseded', result
 * };`): unlike every other supersede arm in this method (which returns a
 * BARE `{ kind: 'superseded' }`, no `result` key), THIS one carries a
 * TRUTHY, well-formed `AcpLoadSessionResult` on the union while a
 * superseding load has already claimed `this.replay` — and both of
 * `loadReplayOutcome`'s production callers (`AcpBackend
 * .loadSessionIntoTabInternal`, `ConnectionSupervisor.recoverOneSession`)
 * treat this arm's `result` as SUCCESS, never touching the tab. A naive
 * union consumer that maps every `superseded` kind generically (ignoring the
 * `result` payload) would flip this arm's caller-visible outcome from
 * silent-success to `tab.error{session-lost}` + a guarded close — a real
 * regression that would still pass `tsc` and every OTHER existing test.
 * Pinning the truthy `toEqual({ kind: 'superseded', result: {...} })` here
 * (not just `toMatchObject({ kind: 'superseded' })`) is what makes that
 * regression fail loudly.
 */
class FakeLoadClient {
  loadSessionCalls: Array<{ cwd: string; sessionId: string }> = [];
  private loadDeferreds: Array<{
    resolve: (r: AcpLoadSessionResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  setSessionModeCalls: Array<{ sessionId: string; modeId: string }> = [];
  private modeDeferreds: Array<{ resolve: () => void }> = [];

  loadSession(cwd: string, sessionId: string): Promise<AcpLoadSessionResult> {
    this.loadSessionCalls.push({ cwd, sessionId });
    return new Promise<AcpLoadSessionResult>((resolve, reject) => {
      this.loadDeferreds.push({ resolve, reject });
    });
  }
  resolveLoad(index: number, result: AcpLoadSessionResult): void {
    this.loadDeferreds[index]?.resolve(result);
  }
  rejectLoad(index: number, err: unknown): void {
    this.loadDeferreds[index]?.reject(err);
  }
  setSessionMode(sessionId: string, modeId: string): Promise<void> {
    this.setSessionModeCalls.push({ sessionId, modeId });
    return new Promise<void>((resolve) => {
      this.modeDeferreds.push({ resolve: () => resolve() });
    });
  }
  resolveMode(index: number): void {
    this.modeDeferreds[index]?.resolve();
  }
  async cancel(): Promise<void> {}
}

function makeLoadHarness(): {
  controller: SessionController;
  client: FakeLoadClient;
  emitted: HostToWebviewMessage[];
} {
  const emitted: HostToWebviewMessage[] = [];
  const client = new FakeLoadClient();
  const port: SessionHostPort = {
    getClient: () => client as unknown as AcpClientLike,
    emit: (msg) => emitted.push(msg),
    emitSystemError: () => {},
    root: makeRoot(),
    workspaceRoots: () => ['/fake/ws'],
    logger: { append: () => {} },
    refreshCheckpointsPanel: () => {},
    resolveMentions: async () => [],
  };
  return { controller: new SessionController('session-1', '/fake/ws', port), client, emitted };
}

describe('WS-R4 characterization — the SIX loadReplayOutcome arms (REMEDIATION-ARCHITECTURE §3.4)', () => {
  it('ARM loaded (happy path): clear + turn.start stream, turn.end{complete}, returns {kind:"loaded", result}', async () => {
    const { controller, client, emitted } = makeLoadHarness();
    const load = controller.loadReplayOutcome('/fake/ws', 'session-1', '/fake/ws', []);
    client.resolveLoad(0, { found: true, currentModeId: 'default' });
    const outcome = await load;
    expect(outcome).toEqual({ kind: 'loaded', result: { found: true, currentModeId: 'default' } });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'clear', sessionId: 'session-1' }));
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'turn.start', turnId: 'turn-1' }));
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'turn.end', turnId: 'turn-1', status: 'complete' }),
    );
  });

  it('ARM no-client: resolves {kind:"no-client"} with ZERO emissions (the silent arm)', async () => {
    const { controller, emitted } = makeLoadHarness();
    // A port whose getClient answers undefined:
    const noClient = new SessionController('session-1', '/fake/ws', {
      getClient: () => undefined,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => ['/fake/ws'],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    });
    void controller; // the harness controller is unused in this arm
    await expect(noClient.loadReplayOutcome('/fake/ws', 'session-1', '/fake/ws', [])).resolves.toEqual({
      kind: 'no-client',
    });
    expect(emitted).toHaveLength(0);
  });

  it('ARM load-failed: error{message} + turn.end{error}, resolves {kind:"load-failed", message}', async () => {
    const { controller, client, emitted } = makeLoadHarness();
    const load = controller.loadReplayOutcome('/fake/ws', 'session-1', '/fake/ws', []);
    client.rejectLoad(0, new Error('load boom'));
    await expect(load).resolves.toEqual({ kind: 'load-failed', message: 'load boom' });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'error', message: 'load boom' }));
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'error' }));
  });

  it('ARM not-found: the pinned message + turn.end{error}, resolves {kind:"not-found"}', async () => {
    const { controller, client, emitted } = makeLoadHarness();
    const load = controller.loadReplayOutcome('/fake/ws', 'session-1', '/fake/ws', []);
    client.resolveLoad(0, { found: false });
    await expect(load).resolves.toEqual({ kind: 'not-found' });
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'That conversation no longer exists on the agent. Start a new chat.',
      }),
    );
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'error' }));
  });

  it('ARM superseded-mid-await (empty): a superseded load resolves bare {kind:"superseded"} SILENTLY, no result key (no error, no turn.end from the loser)', async () => {
    const { controller, client, emitted } = makeLoadHarness();
    const loser = controller.loadReplayOutcome('/fake/ws', 'session-A', '/fake/ws', []);
    void controller.loadReplayOutcome('/fake/ws', 'session-B', '/fake/ws', []); // supersedes on the SAME instance (T1a reuse)
    const emissionsBefore = emitted.length;
    client.resolveLoad(0, { found: false }); // the LOSER's response
    const outcome = await loser;
    expect(outcome).toEqual({ kind: 'superseded' });
    expect('result' in outcome).toBe(false); // exactOptional absent-key discipline
    expect(emitted).toHaveLength(emissionsBefore); // strict silence
  });

  it("ARM :1301 success-but-superseded — NAMED OBSERVABLE (union): {kind:'superseded'} CARRIES the result (callers treat as SUCCESS), zero further emissions from the loser's tail", async () => {
    const { controller, client, emitted } = makeLoadHarness();
    const loser = controller.loadReplayOutcome('/fake/ws', 'session-A', '/fake/ws', []);
    void controller.loadReplayOutcome('/fake/ws', 'session-B', '/fake/ws', []);
    const emissionsBefore = emitted.length;
    client.resolveLoad(0, { found: true, currentModeId: 'default' }); // the loser SUCCEEDED
    await expect(loser).resolves.toEqual({
      kind: 'superseded',
      result: { found: true, currentModeId: 'default' },
    });
    expect(emitted).toHaveLength(emissionsBefore); // silent success
  });

  it('ARM superseded-post-pin (:1330): dispose mid-pinWireModeDefault → bare {kind:"superseded"} return, no result key, NO closing turn.end', async () => {
    const { controller, client, emitted } = makeLoadHarness();
    const load = controller.loadReplayOutcome('/fake/ws', 'session-1', '/fake/ws', []);
    client.resolveLoad(0, { found: true, currentModeId: 'weird-mode' }); // non-default → pin awaits setSessionMode
    await Promise.resolve(); // let loadReplayOutcome reach the pin await
    await Promise.resolve();
    controller.dispose(); // the production supersede (SessionRegistry.open disposes the prior controller)
    client.resolveMode(0);
    const outcome = await load;
    expect(outcome).toEqual({ kind: 'superseded' });
    expect('result' in outcome).toBe(false);
    expect(emitted.filter((m) => m.type === 'turn.end' && m.status === 'complete')).toHaveLength(0);
  });
});

/**
 * ADR-UX-P2-2 (WS-UX Phase-2, Task 3): `endForRestart`'s replay arm must
 * close the bracket with `status:'cancelled'`, not `'error'` — extending
 * V-12's own reasoning (the live-turn arm already does this) to the replay
 * arm. `endForRestart` is reached only on user-intended paths (per-tab New
 * Session, explicit restart fan-out, T16 force-reconnect), so an in-flight
 * replay it interrupts was abandoned by user choice, not broken.
 * `endOnCrash` (a real failure path) keeps `'error'` in both arms —
 * untouched by this task.
 *
 * Reuses the `makeLoadHarness`/`FakeLoadClient` fixture from the WS-R4
 * `loadReplayOutcome` suite above: `loadSession()` never resolves, so
 * `this.replay` stays set exactly like the "mid-await" arms there — the
 * same in-flight-replay state `endForRestart` must interrupt.
 */
describe('SessionController.endForRestart — ADR-UX-P2-2 (replay arm)', () => {
  it('landing MID-REPLAY closes the replay bracket with status "cancelled" (user-intended), not "error"', () => {
    const { controller, emitted } = makeLoadHarness();
    // Arrange: an in-flight replay (this.replay set, client.loadSession()
    // never resolves) — the same pending-loadSession fixture the
    // loadReplayOutcome suite uses.
    void controller.loadReplayOutcome('/fake/ws', 'session-1', '/fake/ws', []);
    // Act:
    controller.endForRestart();
    // Assert: the closing bracket is user-intent vocabulary, not 'error'.
    const end = emitted.find((m) => m.type === 'turn.end');
    expect(end).toMatchObject({ type: 'turn.end', status: 'cancelled' });
  });
});

/**
 * WS-SL F3-3 (BHF-F3-3): turn-liveness at approval registration.
 * The zombie: `handlePermission` suspends at `await buildPresentEffectSignals`;
 * a `cancel()` landing in that window runs `settlePendingApprovals` over a
 * snapshot that does NOT yet contain this approval — when the await resolves,
 * `emitApprovalCard` registers a fresh card for a turn the user already
 * stopped, and it lives until the 60 s M2-b expiry (or the 15 s WS-R1 cancel
 * fallback force-end). Characterization-first: the first committed shape of
 * the first test below PINNED today's zombie (card emitted after cancel,
 * promise stranded), then flipped to the fixed expectation — the flip is the
 * regression test.
 */
describe('SessionController.emitApprovalCard — WS-SL F3-3: turn-liveness at registration', () => {
  async function flushF33(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  function makeF33CommandReq(command: string, toolCallId = 'cmd-1'): AcpRequestPermissionRequest {
    return {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId,
        title: `Run: ${command}`,
        kind: 'execute',
        content: [{ content: { type: 'text', text: `$ ${command}` } }],
        rawInput: { command, description: 'run' },
      },
    };
  }

  function makeF33Harness(): {
    controller: SessionController;
    emitted: HostToWebviewMessage[];
    logs: string[];
    resolvePrompt: (v: { stopReason: string }) => void;
  } {
    const emitted: HostToWebviewMessage[] = [];
    const logs: string[] = [];
    let resolvePrompt!: (v: { stopReason: string }) => void;
    const client = {
      cancel: async () => undefined,
      prompt: () =>
        new Promise<{ stopReason: string }>((resolve) => {
          resolvePrompt = resolve;
        }),
    } as unknown as AcpClientLike;
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => ['/fake/ws'],
      logger: { append: (l) => logs.push(l) },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    const controller = new SessionController('session-1', '/fake/ws', port);
    return { controller, emitted, logs, resolvePrompt: (v) => resolvePrompt(v) };
  }

  it('a cancel() landing while handlePermission is suspended refuses the registration — cancelled outcome, NO card, nothing pending', async () => {
    const { controller, emitted } = makeF33Harness();
    controller.sendPrompt('do the thing', 'default');
    await flushF33(); // reach the hanging client.prompt — turn-1 is live

    // Suspends at `await this.buildPresentEffectSignals(...)`:
    const pending = controller.handlePermission(makeF33CommandReq('npm test'), 'appr-z1');
    controller.cancel(); // lands INSIDE the suspension window — the F3-3 race

    const res = await pending;
    expect(res).toEqual(buildCancelledOutcome());
    // The zombie observable (pre-fix): approval.request WAS emitted after
    // cancel and lived until expiry. Post-fix: no card at all.
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(false);
    // Nothing was registered: a late answer is the documented no-op and emits
    // no settle echo.
    controller.respondApproval('appr-z1', 'allow_once');
    expect(emitted.some((m) => m.type === 'approval.settle')).toBe(false);
  });

  it('after the cancelled turn ends, a straggler handlePermission still resolves cancelled with no card (cancelledTurnId bookkeeping lingers)', async () => {
    const { controller, emitted, resolvePrompt } = makeF33Harness();
    controller.sendPrompt('do the thing', 'default');
    await flushF33();
    controller.cancel();
    resolvePrompt({ stopReason: 'cancelled' });
    await flushF33(); // turn-1 fully over (turn.end{cancelled} emitted)
    emitted.length = 0;

    const res = await controller.handlePermission(makeF33CommandReq('npm test', 'cmd-z2'), 'appr-z2');
    expect(res).toEqual(buildCancelledOutcome());
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('a permission arriving with NO turn ever admitted refuses registration (fail-closed) instead of minting a 60 s zombie card', async () => {
    const { controller, emitted } = makeF33Harness();
    const res = await controller.handlePermission(makeF33CommandReq('npm test', 'cmd-z3'), 'appr-z3');
    expect(res).toEqual(buildCancelledOutcome());
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('a live, uncancelled turn still gets its card and a user answer resolves selected (healthy path untouched)', async () => {
    const { controller, emitted } = makeF33Harness();
    controller.sendPrompt('do the thing', 'default');
    await flushF33();
    const pending = controller.handlePermission(makeF33CommandReq('npm test', 'cmd-z4'), 'appr-z4');
    await flushF33();
    expect(emitted.some((m) => m.type === 'approval.request')).toBe(true);
    controller.respondApproval('appr-z4', 'allow_once');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });
});

/**
 * WS-SL F2-06: `emitApprovalCard` registers into `pendingApprovals` (entry +
 * 60 s timer) BEFORE `port.emit(approval)`. Pre-fix, an emit throw propagated
 * out of the Promise executor — the returned promise REJECTED (the harness
 * saw an RPC error) while the entry and its 60 s timer lingered, later firing
 * a stale `approval.settle{expired}` for a card the webview may never have
 * rendered. Characterization-first: the first committed shape of this test
 * PINNED the rejection + leaked timer, then flipped.
 */
describe('SessionController.emitApprovalCard — WS-SL F2-06: emit-throw settles fail-closed', () => {
  it('a port.emit throw during the card emit resolves the approval cancelled, clears the entry + timer, and leaks nothing', async () => {
    vi.useFakeTimers();
    try {
      const emitted: HostToWebviewMessage[] = [];
      const logs: string[] = [];
      let boomArmed = true;
      const client = {
        cancel: async () => undefined,
        prompt: () => new Promise<never>(() => {}),
      } as unknown as AcpClientLike;
      const port: SessionHostPort = {
        getClient: () => client,
        emit: (msg) => {
          if (boomArmed && msg.type === 'approval.request') throw new Error('webview gone');
          emitted.push(msg);
        },
        emitSystemError: () => {},
        root: makeRoot(),
        workspaceRoots: () => ['/fake/ws'],
        logger: { append: (l) => logs.push(l) },
        refreshCheckpointsPanel: () => {},
        resolveMentions: async () => [],
      };
      const controller = new SessionController('session-1', '/fake/ws', port);
      controller.sendPrompt('do the thing', 'default');
      for (let i = 0; i < 6; i++) await Promise.resolve(); // turn-1 live, prompt hanging
      const timersBefore = vi.getTimerCount();

      const res = await controller.handlePermission(
        {
          sessionId: 'session-1',
          options: EDIT_OPTIONS.map((o) => ({ ...o })),
          toolCall: {
            toolCallId: 'cmd-f206',
            title: 'Run: npm test',
            kind: 'execute',
            content: [{ content: { type: 'text', text: '$ npm test' } }],
            rawInput: { command: 'npm test', description: 'run' },
          },
        },
        'appr-f206',
      );

      // Fail-closed: the future RESOLVES cancelled (never rejects — a
      // rejection is an RPC error, not a deny).
      expect(res).toEqual(buildCancelledOutcome());
      // The just-registered entry + its 60 s timer are gone.
      expect(vi.getTimerCount()).toBe(timersBefore);
      boomArmed = false;
      controller.respondApproval('appr-f206', 'allow_once');
      expect(logs.some((l) => l.includes("no pending approval 'appr-f206'"))).toBe(true);
      // The settle used emit:false (the port just proved unreliable) — no
      // approval.settle echo was attempted through the failing port.
      expect(emitted.some((m) => m.type === 'approval.settle')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * WS-SL F1-13: `sendPrompt` minted a turn id, a ROOT-scoped checkpoint
 * ordinal, and a checkpoint snapshot for a whitespace-only prompt with
 * nothing attached — burning a turn + ordinal on an utterance Hermes treats
 * as empty. Characterization-first: the first committed shape of the first
 * test PINNED the burn (turn.start emitted, ordinal minted), then flipped.
 */
describe('SessionController.sendPrompt — WS-SL F1-13: empty-prompt refusal', () => {
  function makeF113Harness(): {
    controller: SessionController;
    emitted: HostToWebviewMessage[];
    ordinalCalls: () => number;
    promptCalls: () => number;
  } {
    const emitted: HostToWebviewMessage[] = [];
    let ordinals = 0;
    let prompts = 0;
    const client = {
      cancel: async () => undefined,
      prompt: () => {
        prompts += 1;
        return new Promise<never>(() => {});
      },
    } as unknown as AcpClientLike;
    const root: RootCoordinatorLike = {
      rootId: 'root-1',
      tracker: undefined,
      tryAcquireTurnLease: () => true,
      releaseTurnLease: () => {},
      anyLiveTurn: () => false,
      nextTurnOrdinal: () => {
        ordinals += 1;
        return ordinals;
      },
      nextBaselineOrdinal: () => -1,
      refreshCheckpointsPanel: () => {},
    };
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root,
      workspaceRoots: () => ['/fake/ws'],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return {
      controller: new SessionController('session-1', '/fake/ws', port),
      emitted,
      ordinalCalls: () => ordinals,
      promptCalls: () => prompts,
    };
  }

  it('a whitespace-only prompt with no attachments/mentions is refused BEFORE any mint: error emitted, no turn.start, no ordinal, no client.prompt', async () => {
    const { controller, emitted, ordinalCalls, promptCalls } = makeF113Harness();
    controller.sendPrompt('   \n\t ', 'default');
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(emitted).toEqual([
      { type: 'error', sessionId: 'session-1', message: 'Cannot send an empty message.' },
    ]);
    expect(ordinalCalls()).toBe(0);
    expect(promptCalls()).toBe(0);
    expect(controller.hasLiveTurn()).toBe(false);
  });

  it('an empty text WITH an attachment is admitted (the attachment carries the content)', async () => {
    const { controller, emitted, ordinalCalls } = makeF113Harness();
    controller.sendPrompt('', 'default', [
      { id: 'att-1', name: 'notes.txt', kind: 'file', path: '/fake/ws/notes.txt' },
    ]);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(emitted.some((m) => m.type === 'turn.start')).toBe(true);
    expect(ordinalCalls()).toBe(1);
  });

  it('an empty text WITH a mention is admitted', async () => {
    const { controller, emitted } = makeF113Harness();
    controller.sendPrompt('', 'default', undefined, [{ id: 'ref-1', kind: 'file', path: 'a.ts' }]);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(emitted.some((m) => m.type === 'turn.start')).toBe(true);
  });
});

/**
 * WS-SL F2-05: `void this.runTurnWithCheckpoint(...)` had no terminal catch —
 * a rejection from `snapshotCheckpoint`/`resolveMentions` (the `Promise.all`
 * before any turn guard) became an unhandled rejection AND leaked the root
 * turn lease + `liveTurnId`, wedging every later prompt on this root behind
 * "A turn is already running…". Characterization-first: the first committed
 * shape of this test PINNED the wedge (no turn.end, lease held, next prompt
 * refused), then flipped. The catch mirrors `runTurn`'s own error arm:
 * same guard, same bounded `errorMessage(err)`, same `emitTurnEnd`.
 */
describe('SessionController.runTurnWithCheckpoint — WS-SL F2-05: terminal catch (no leaked lease)', () => {
  function makeF205Harness(): {
    controller: SessionController;
    emitted: HostToWebviewMessage[];
    releaseCalls: () => number;
    promptCalls: () => number;
    disarmMentionBoom: () => void;
  } {
    const emitted: HostToWebviewMessage[] = [];
    let releases = 0;
    let prompts = 0;
    let mentionBoom = true;
    const client = {
      cancel: async () => undefined,
      prompt: () => {
        prompts += 1;
        return new Promise<never>(() => {});
      },
    } as unknown as AcpClientLike;
    const root: RootCoordinatorLike = {
      rootId: 'root-1',
      tracker: undefined,
      tryAcquireTurnLease: () => true,
      releaseTurnLease: () => {
        releases += 1;
      },
      anyLiveTurn: () => false,
      nextTurnOrdinal: () => 1,
      nextBaselineOrdinal: () => -1,
      refreshCheckpointsPanel: () => {},
    };
    const port: SessionHostPort = {
      getClient: () => client,
      emit: (msg) => emitted.push(msg),
      emitSystemError: () => {},
      root,
      workspaceRoots: () => ['/fake/ws'],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => {
        if (mentionBoom) throw new Error('mention resolution boom');
        return [];
      },
    };
    return {
      controller: new SessionController('session-1', '/fake/ws', port),
      emitted,
      releaseCalls: () => releases,
      promptCalls: () => prompts,
      disarmMentionBoom: () => {
        mentionBoom = false;
      },
    };
  }

  it('a pre-prompt rejection ends the turn honestly: error{turnId} + turn.end{error}, lease released, next prompt admitted', async () => {
    const { controller, emitted, releaseCalls, promptCalls, disarmMentionBoom } = makeF205Harness();

    controller.sendPrompt('do the thing', 'default');
    await vi.waitFor(() => {
      expect(emitted.some((m) => m.type === 'turn.end')).toBe(true);
    });

    expect(emitted).toContainEqual({
      type: 'error',
      sessionId: 'session-1',
      message: 'mention resolution boom',
      turnId: 'turn-1',
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: 'turn.end', turnId: 'turn-1', status: 'error' }),
    );
    expect(releaseCalls()).toBe(1);
    expect(controller.hasLiveTurn()).toBe(false);
    expect(promptCalls()).toBe(0); // the turn never reached client.prompt

    // The lease is genuinely free: the NEXT prompt is admitted, not refused.
    disarmMentionBoom();
    controller.sendPrompt('again', 'default');
    await vi.waitFor(() => expect(promptCalls()).toBe(1));
    expect(emitted.some((m) => m.type === 'error' && m.message.includes('already running'))).toBe(false);
  });
});

/**
 * WS-SL A-04: `current_mode_update` was typed (`types.ts:158`) but never
 * applied to `currentMode` — `runTurn`'s re-pin backstop (`if
 * (this.currentMode !== 'default')` before `client.prompt`) was blind to an
 * agent-initiated switch to accept_edits/dont_ask. Zero behavior change vs
 * pinned Hermes 2026.7.7.2 (never emits it — grep 0); real on a future
 * harness. Characterization-first: the first committed shape of the first
 * test PINNED the blindness (no re-pin call), then flipped.
 */
describe('SessionController.applyUpdate — WS-SL A-04: current_mode_update reaches the re-pin backstop', () => {
  function makeA04Harness(): {
    controller: SessionController;
    setSessionModeCalls: Array<{ sessionId: string; modeId: string }>;
    promptCalls: () => number;
  } {
    const setSessionModeCalls: Array<{ sessionId: string; modeId: string }> = [];
    let prompts = 0;
    const client = {
      cancel: async () => undefined,
      setSessionMode: async (sessionId: string, modeId: string) => {
        setSessionModeCalls.push({ sessionId, modeId });
      },
      prompt: () => {
        prompts += 1;
        return new Promise<never>(() => {});
      },
    } as unknown as AcpClientLike;
    const port: SessionHostPort = {
      getClient: () => client,
      emit: () => {},
      emitSystemError: () => {},
      root: makeRoot(),
      workspaceRoots: () => ['/fake/ws'],
      logger: { append: () => {} },
      refreshCheckpointsPanel: () => {},
      resolveMentions: async () => [],
    };
    return {
      controller: new SessionController('session-1', '/fake/ws', port),
      setSessionModeCalls,
      promptCalls: () => prompts,
    };
  }

  it('an agent-initiated switch reported via current_mode_update makes the NEXT turn re-pin default before prompting', async () => {
    const { controller, setSessionModeCalls, promptCalls } = makeA04Harness();

    controller.applyUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });

    controller.sendPrompt('do the thing', 'default');
    await vi.waitFor(() => expect(promptCalls()).toBe(1));
    expect(setSessionModeCalls).toEqual([{ sessionId: 'session-1', modeId: 'default' }]);
  });

  it('without a current_mode_update the next turn does NOT re-pin (baseline — proves the write, not ambient behavior)', async () => {
    const { controller, setSessionModeCalls, promptCalls } = makeA04Harness();
    controller.sendPrompt('do the thing', 'default');
    await vi.waitFor(() => expect(promptCalls()).toBe(1));
    expect(setSessionModeCalls).toEqual([]);
  });

  it('a switch back to default overwrites the record — no spurious re-pin', async () => {
    const { controller, setSessionModeCalls, promptCalls } = makeA04Harness();
    controller.applyUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
    controller.applyUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    controller.sendPrompt('do the thing', 'default');
    await vi.waitFor(() => expect(promptCalls()).toBe(1));
    expect(setSessionModeCalls).toEqual([]);
  });
});
