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
import { describe, it, expect, afterEach, vi } from 'vitest';
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
    editPreviewRegistry: undefined,
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
      editPreviewRegistry: undefined,
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
   * `emitApprovalCard`, the `loadReplay` continuation, `dispose()` itself) —
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
      editPreviewRegistry: undefined,
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
      editPreviewRegistry: undefined,
      resolveMentions: async () => [],
    };
    return { port, emitted, logs };
  }

  it('V-4 RED: cancel() settles a pending approval — the promise resolves cancelled AND approval.settle{outcome:"cancelled"} is emitted', async () => {
    const client = makeApprovalClient({ cancel: async () => undefined });
    const { port, emitted } = makeSettlePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-a0', port);

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
      turnId: 'turn',
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
        const client = makeApprovalClient();
        const { port, emitted, logs } = makeSettlePort(client);
        const controller = new SessionController('session-1', '/tmp/ws-a0', port);

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
          turnId: 'turn',
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
    const client = makeApprovalClient();
    const { port, emitted } = makeSettlePort(client);
    const controller = new SessionController('session-1', '/tmp/ws-a0', port);

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
      turnId: 'turn',
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
        const client = makeApprovalClient();
        const { port, emitted } = makeSettlePort(client);
        const controller = new SessionController('session-1', '/tmp/ws-a0', port);

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
      editPreviewRegistry: undefined,
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
      editPreviewRegistry: undefined,
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
      editPreviewRegistry: undefined,
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
      editPreviewRegistry: undefined,
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
      editPreviewRegistry: undefined,
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
 * I-2 (W1-T3 review, Important fix): `loadReplay`'s LAST supersede guard
 * (`this.replay !== replay`) sits right before `this.replay = undefined`
 * (~:1142-1144) — but `await this.pinWireModeDefault(...)` (~:1154) is a
 * SEPARATE suspension point AFTER that guard, with no recheck once it
 * resolves. If a second, superseding `loadReplay` call (B) starts while the
 * first (A) is parked on that pin await — and B is itself still in flight
 * (parked on its OWN `client.loadSession` await, so `this.replay` still
 * points at B's fresh `ReplayTranslator`) — A resuming after the pin would,
 * pre-fix, call `markSubagentsInterrupted()` against B's already-reset fold
 * and emit a STALE `turn.end{complete}` for A's own superseded turn on top
 * of B's still-live replay. Fixed: recheck `this.replay !== undefined`
 * right after the pin await, before touching subagents or emitting
 * `turn.end` — A's own reset at ~:1144 left `this.replay` `undefined`; a
 * non-undefined value at this point can only mean a superseding call
 * claimed it in the meantime.
 */
describe('SessionController.loadReplay — I-2 (W1-T3 review): supersede recheck AFTER the pinWireModeDefault await', () => {
  /** Same tiny deferred-promise helper `AcpBackend.test.ts` uses. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  // I-2 re-review (W1-T3 fix2): this first test exercises the SYNTHETIC
  // same-instance variant — a second `loadReplay` re-claiming `this.replay`
  // on the SAME controller — which the recheck's `this.replay !== undefined`
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
      editPreviewRegistry: undefined,
      resolveMentions: async () => [],
    };
    const controller = new SessionController('bootstrap', '/ws', port);

    // A starts and parks on `client.loadSession`.
    const replayA = controller.loadReplay('/ws', 'session-A', '/ws', []);

    // A's load resolves with a drift, so A proceeds into the pin — which
    // itself parks on `setSessionModeA`. Flush generously: since
    // `setSessionModeA` never resolves on its own, A cannot run past that
    // await no matter how many microtasks are flushed here.
    loadSessionA.resolve({ found: true, currentModeId: 'accept_edits' });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // B supersedes A on the SAME controller — a second, later `loadReplay`
    // call — and parks on ITS OWN `client.loadSession` (never reaches the
    // pin in this test). `this.replay` now points at B's fresh
    // ReplayTranslator.
    const replayB = controller.loadReplay('/ws', 'session-B', '/ws', []);
    await Promise.resolve();

    emitted.length = 0; // isolate: only what happens from here on is under test

    // Let A's pin settle — A resumes INSIDE loadReplay, past the pin await,
    // with B still fully in flight.
    setSessionModeA.resolve(undefined);
    const resultA = await replayA;

    // The fix: A emits NOTHING past the pin boundary once superseded — no
    // stale turn.end, no commands.available, nothing.
    expect(emitted).toEqual([]);
    expect(resultA).toBeUndefined();

    // B is unaffected and still completes honestly with its own turn.end.
    loadSessionB.resolve({ found: true, currentModeId: 'default' });
    const resultB = await replayB;
    expect(resultB).toEqual({ found: true, currentModeId: 'default' });
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
      editPreviewRegistry: undefined,
      resolveMentions: async () => [],
    };
    const controller = new SessionController('bootstrap', '/ws', port);

    // A starts and parks on `client.loadSession`.
    const replayA = controller.loadReplay('/ws', 'session-A', '/ws', []);

    // A's load resolves with a drift, so A proceeds into the pin — which
    // itself parks on `setSessionModeA`. Flush generously: since
    // `setSessionModeA` never resolves on its own, A cannot run past that
    // await no matter how many microtasks are flushed here.
    loadSessionA.resolve({ found: true, currentModeId: 'accept_edits' });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The REAL production supersede: a fresh controller is minted for this
    // sessionId (`SessionRegistry.open`) and THIS controller is disposed —
    // never a second `loadReplay` call on the same instance. No live turn
    // is registered here, so `dispose()` takes its no-op branch for the
    // cancel/turn-lease bookkeeping; what matters is `this.replay =
    // undefined` and `this.disposed = true`.
    emitted.length = 0; // isolate: only what happens from here on is under test
    controller.dispose();

    // Let A's pin settle — A resumes INSIDE loadReplay, past the pin await,
    // on a controller that is now disposed.
    setSessionModeA.resolve(undefined);
    const resultA = await replayA;

    // The fix: A emits NOTHING past the pin boundary once disposed — no
    // stale turn.end, no commands.available, nothing.
    expect(emitted).toEqual([]);
    expect(resultA).toBeUndefined();
  });
});
