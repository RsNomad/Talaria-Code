import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpClientLike,
  AcpListSessionsRawResult,
  AcpLoadSessionResult,
  AcpMcpServer,
  AcpNewSessionResult,
  AcpPromptResult,
} from '../acp/acpClient';
import type { AcpOutboundContentBlock, AcpSessionUpdate } from '../acp/types';
import type { RootCoordinatorLike } from '../../checkpoints/RootCoordinator';
import type { CheckpointTrackerLike } from '../../checkpoints/trackerContract';
import type { RestoreResult } from '../../checkpoints/CheckpointTracker';
import type { CheckpointPhase, CheckpointsData } from '../../../shared/protocol';
import { OneShotRunner, type OneShotHostPort } from './OneShotRunner';

/**
 * TST-03 (WS-TD): the dedicated `OneShotRunner` suite. Drives the REAL runner
 * through its REAL `OneShotHostPort` with complete structural fakes for every
 * dependency it reaches (`AcpClientLike`, `RootCoordinatorLike`,
 * `CheckpointTrackerLike`) — a fake that omits a required member fails `tsc`,
 * never silently. Every literal asserted below is grounded in
 * `OneShotRunner.ts` at write-time (§2c requirement tags cited per test).
 * `AcpBackend.test.ts` pins the same subsystem INDIRECTLY (reflective seams
 * through the backend); this file is the direct contract.
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

/** Drain the microtask queue far enough for every `await` in one runner phase to settle (same idiom as `AcpBackend.test.ts`). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function chunk(text: string): AcpSessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

/**
 * Complete `AcpClientLike` fake — every REQUIRED member present. Only the four
 * members the runner reaches (`newSession`/`setSessionMode`/`prompt`/`cancel`)
 * record + are controllable; the rest are inert.
 */
class FakeClient implements AcpClientLike {
  newSessionCalls: Array<{ cwd: string; mcpServers: AcpMcpServer[] | undefined }> = [];
  setSessionModeCalls: Array<{ sessionId: string; modeId: string }> = [];
  promptCalls: Array<{ sessionId: string; content: AcpOutboundContentBlock[] }> = [];
  cancelCalls: string[] = [];
  /** The modeId every `newSession` reports — non-`'default'` drives the re-pin branch. */
  currentModeId = 'default';
  private nextSessionId = 'ephemeral-1';
  private pendingNewSession: ReturnType<typeof deferred<AcpNewSessionResult>> | undefined;
  private pendingMode: ReturnType<typeof deferred<void>> | undefined;
  private pendingPrompt: ReturnType<typeof deferred<AcpPromptResult>> | undefined;

  /** The NEXT `newSession()` resolves with this id. */
  queueSessionId(id: string): void {
    this.nextSessionId = id;
  }
  /** Make the NEXT `newSession()` hang until `resolveNewSession()` / `rejectNewSession()`. */
  holdNewSession(): void {
    this.pendingNewSession = deferred<AcpNewSessionResult>();
  }
  resolveNewSession(): void {
    this.pendingNewSession?.resolve({ sessionId: this.nextSessionId, currentModeId: this.currentModeId });
  }
  rejectNewSession(err: unknown): void {
    this.pendingNewSession?.reject(err);
  }
  /** Make the NEXT `setSessionMode()` hang until `resolveSetSessionMode()` / `rejectSetSessionMode()`. */
  holdSetSessionMode(): void {
    this.pendingMode = deferred<void>();
  }
  resolveSetSessionMode(): void {
    this.pendingMode?.resolve(undefined);
  }
  rejectSetSessionMode(err: unknown): void {
    this.pendingMode?.reject(err);
  }
  /** Settle the MOST RECENT `prompt()` (every prompt hangs until the test settles it). */
  resolvePrompt(): void {
    this.pendingPrompt?.resolve({ stopReason: 'end_turn' });
  }
  rejectPrompt(err: unknown): void {
    this.pendingPrompt?.reject(err);
  }

  async connect(): Promise<void> {}
  async initialize(): Promise<void> {}
  newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<AcpNewSessionResult> {
    this.newSessionCalls.push({ cwd, mcpServers });
    if (this.pendingNewSession) return this.pendingNewSession.promise;
    return Promise.resolve({ sessionId: this.nextSessionId, currentModeId: this.currentModeId });
  }
  prompt(sessionId: string, content: AcpOutboundContentBlock[]): Promise<AcpPromptResult> {
    this.promptCalls.push({ sessionId, content });
    this.pendingPrompt = deferred<AcpPromptResult>();
    return this.pendingPrompt.promise;
  }
  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }
  setSessionMode(sessionId: string, modeId: string): Promise<void> {
    this.setSessionModeCalls.push({ sessionId, modeId });
    if (this.pendingMode) return this.pendingMode.promise;
    return Promise.resolve();
  }
  async setSessionModel(): Promise<void> {}
  async listSessions(): Promise<AcpListSessionsRawResult> {
    return { sessions: [] };
  }
  async loadSession(): Promise<AcpLoadSessionResult> {
    return { found: false };
  }
  onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  dispose(): void {}
}

/** Complete `CheckpointTrackerLike` fake — records `snapshot`; the rest are inert. */
class FakeTracker implements CheckpointTrackerLike {
  snapshotCalls: Array<{ turnOrdinal: number; label: string | undefined; phase: CheckpointPhase | undefined }> = [];
  snapshotError: unknown;

  async snapshot(
    turnOrdinal: number,
    label?: string,
    opts?: { phase?: CheckpointPhase; sessionLabel?: string },
  ): Promise<null> {
    this.snapshotCalls.push({ turnOrdinal, label, phase: opts?.phase });
    if (this.snapshotError !== undefined) throw this.snapshotError;
    return null; // "deduped" — the runner never consumes the value (§2c req 3)
  }
  async list(): Promise<CheckpointsData> {
    return { checkpoints: [] };
  }
  async restore(): Promise<RestoreResult> {
    return { restored: false, reason: 'fake' };
  }
  async redo(): Promise<RestoreResult> {
    return { restored: false, reason: 'fake' };
  }
  async redoAll(): Promise<RestoreResult> {
    return { restored: false, reason: 'fake' };
  }
}

/**
 * Complete `RootCoordinatorLike` fake with the REAL lease semantics the runner
 * depends on (single holder; same-holder re-acquire is idempotent-true;
 * holder-checked release) and a NEGATIVE baseline counter. `nextTurnOrdinal`
 * THROWS: a one-shot must never draw a positive turn ordinal (W4-T2 F3).
 */
class FakeRoot implements RootCoordinatorLike {
  readonly rootId: string;
  tracker: CheckpointTrackerLike | undefined;
  holder: string | undefined;
  acquireCalls: string[] = [];
  releaseCalls: string[] = [];
  refreshCalls = 0;
  private baselineOrdinal = 0;

  constructor(rootId: string, tracker: CheckpointTrackerLike | undefined) {
    this.rootId = rootId;
    this.tracker = tracker;
  }
  tryAcquireTurnLease(sessionId: string): boolean {
    this.acquireCalls.push(sessionId);
    if (this.holder !== undefined && this.holder !== sessionId) return false;
    this.holder = sessionId;
    return true;
  }
  releaseTurnLease(sessionId: string): void {
    this.releaseCalls.push(sessionId);
    if (this.holder === sessionId) this.holder = undefined;
  }
  anyLiveTurn(): boolean {
    return this.holder !== undefined;
  }
  nextTurnOrdinal(): number {
    throw new Error('a one-shot must never draw a TURN ordinal');
  }
  nextBaselineOrdinal(): number {
    this.baselineOrdinal -= 1;
    return this.baselineOrdinal;
  }
  refreshCheckpointsPanel(): void {
    this.refreshCalls += 1;
  }
}

interface Harness {
  runner: OneShotRunner;
  client: FakeClient;
  /** The root `resolveRoot('/ws')` returns (pre-minted). */
  root: FakeRoot;
  rootFor(cwd: string): FakeRoot;
  tracker: FakeTracker;
  logs: string[];
  recorded: string[];
  deleted: string[];
  resolveRootCalls: string[];
  /** Mutate to simulate "start() has not completed" (the readiness gate). */
  connection: { client: FakeClient | undefined; cwd: string | undefined };
}

function makeHarness(opts: { withTracker?: boolean; modeId?: string } = {}): Harness {
  const client = new FakeClient();
  if (opts.modeId !== undefined) client.currentModeId = opts.modeId;
  const tracker = new FakeTracker();
  const trackerForRoot = opts.withTracker === false ? undefined : tracker;
  const roots = new Map<string, FakeRoot>();
  const rootFor = (cwd: string): FakeRoot => {
    let root = roots.get(cwd);
    if (!root) {
      root = new FakeRoot(cwd, trackerForRoot);
      roots.set(cwd, root);
    }
    return root;
  };
  const logs: string[] = [];
  const recorded: string[] = [];
  const deleted: string[] = [];
  const resolveRootCalls: string[] = [];
  const connection: Harness['connection'] = { client, cwd: '/ws' };
  const port: OneShotHostPort = {
    getClient: () => connection.client,
    getConnectionCwd: () => connection.cwd,
    resolveRoot: (cwd) => {
      resolveRootCalls.push(cwd);
      return rootFor(cwd);
    },
    logger: { append: (line) => logs.push(line) },
    recordOneShotSessionId: (id) => recorded.push(id),
    deleteOneShotSession: (id) => deleted.push(id),
  };
  return {
    runner: new OneShotRunner(port),
    client,
    root: rootFor('/ws'),
    rootFor,
    tracker,
    logs,
    recorded,
    deleted,
    resolveRootCalls,
    connection,
  };
}

describe('OneShotRunner — readiness gate (the original `!this.client || !this.cwd` guard)', () => {
  it('no client → {ok:false, "not started"} and NOTHING else runs (no root resolve, no lease, no newSession)', async () => {
    const h = makeHarness();
    h.connection.client = undefined;
    await expect(h.runner.oneShot('hi', { cwd: '/ws' })).resolves.toEqual({
      ok: false,
      error: 'The agent session is not started yet.',
    });
    expect(h.resolveRootCalls).toEqual([]);
    expect(h.root.acquireCalls).toEqual([]);
    expect(h.client.newSessionCalls).toEqual([]);
  });

  it('a client but no connection cwd → the same refusal', async () => {
    const h = makeHarness();
    h.connection.cwd = undefined;
    await expect(h.runner.oneShot('hi', { cwd: '/ws' })).resolves.toEqual({
      ok: false,
      error: 'The agent session is not started yet.',
    });
    expect(h.client.newSessionCalls).toEqual([]);
  });
});

describe('OneShotRunner — §2c req 4 / F1 root turn-lease (synchronous, unique holder per call)', () => {
  it('acquires under a UNIQUE synthetic holder per invocation and releases the SAME holder in finally', async () => {
    const h = makeHarness();
    const p1 = h.runner.oneShot('one', { cwd: '/ws' });
    await flushMicrotasks();
    h.client.resolvePrompt();
    await expect(p1).resolves.toEqual({ ok: true, text: '' });

    const p2 = h.runner.oneShot('two', { cwd: '/ws' });
    await flushMicrotasks();
    h.client.resolvePrompt();
    await expect(p2).resolves.toEqual({ ok: true, text: '' });

    expect(h.root.acquireCalls).toEqual(['one-shot-1', 'one-shot-2']);
    expect(h.root.releaseCalls).toEqual(['one-shot-1', 'one-shot-2']);
    expect(h.root.anyLiveTurn()).toBe(false);
  });

  it('the lease is taken BEFORE the first await — a second concurrent one-shot is refused synchronously with no newSession', async () => {
    const h = makeHarness();
    const first = h.runner.oneShot('one', { cwd: '/ws' });
    // No await between the two calls: the refusal must be decided synchronously.
    const second = h.runner.oneShot('two', { cwd: '/ws' });
    await expect(second).resolves.toEqual({ ok: false, error: 'a turn is already running' });
    await flushMicrotasks();
    expect(h.client.newSessionCalls).toHaveLength(1);
    expect(h.root.acquireCalls).toEqual(['one-shot-1', 'one-shot-2']); // the counter still advanced — never a reused id
    expect(h.root.releaseCalls).toEqual([]); // the refused call never releases what it never held

    h.client.resolvePrompt();
    await expect(first).resolves.toEqual({ ok: true, text: '' });
    expect(h.root.releaseCalls).toEqual(['one-shot-1']);
  });

  it('a main turn already holding the lease refuses the one-shot', async () => {
    const h = makeHarness();
    expect(h.root.tryAcquireTurnLease('session-1')).toBe(true);
    await expect(h.runner.oneShot('hi', { cwd: '/ws' })).resolves.toEqual({ ok: false, error: 'a turn is already running' });
    expect(h.client.newSessionCalls).toEqual([]);
  });

  it('W6-FG: the root and the ephemeral session cwd come from opts.cwd — never from the connection cwd', async () => {
    const h = makeHarness();
    h.connection.cwd = '/elsewhere';
    const p = h.runner.oneShot('hi', { cwd: '/ws-b' });
    await flushMicrotasks();
    h.client.resolvePrompt();
    await p;
    expect(h.resolveRootCalls).toEqual(['/ws-b']);
    expect(h.client.newSessionCalls).toEqual([{ cwd: '/ws-b', mcpServers: [] }]);
  });
});

describe('OneShotRunner — the pinned happy-path sequence (newSession → snapshot → prompt → collected text)', () => {
  it('runs the sequence, records the id at mint, collects agent_message_chunk text only, deletes exactly once after settle', async () => {
    const h = makeHarness();
    h.client.queueSessionId('eph-1');
    const p = h.runner.oneShot('summarize', { cwd: '/ws', timeoutMs: 1_000 });
    await flushMicrotasks();

    expect(h.client.newSessionCalls).toEqual([{ cwd: '/ws', mcpServers: [] }]);
    expect(h.recorded).toEqual(['eph-1']); // TG-5 layer 1: recorded at mint, unconditionally
    expect(h.client.setSessionModeCalls).toEqual([]); // already 'default' — no re-pin
    expect(h.tracker.snapshotCalls).toEqual([{ turnOrdinal: -1, label: 'One-shot utility call', phase: undefined }]);
    expect(h.client.promptCalls).toEqual([{ sessionId: 'eph-1', content: [{ type: 'text', text: 'summarize' }] }]);
    expect(h.runner.has('eph-1')).toBe(true);
    expect(h.deleted).toEqual([]); // not settled yet

    h.runner.collect('eph-1', chunk('Hello, '));
    h.runner.collect('eph-1', chunk('world'));
    h.runner.collect('eph-1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'IGNORED' } });
    h.client.resolvePrompt();
    await expect(p).resolves.toEqual({ ok: true, text: 'Hello, world' });

    expect(h.runner.has('eph-1')).toBe(false);
    expect(h.deleted).toEqual(['eph-1']); // TG-5 layer 2: exactly once
    expect(h.root.releaseCalls).toEqual(['one-shot-1']);
    expect(h.client.cancelCalls).toEqual([]);
  });

  it('a non-default session mode is re-pinned to `default` BEFORE the snapshot and the prompt', async () => {
    const h = makeHarness({ modeId: 'accept_edits' });
    h.client.holdSetSessionMode();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();

    expect(h.client.setSessionModeCalls).toEqual([{ sessionId: 'ephemeral-1', modeId: 'default' }]);
    expect(h.tracker.snapshotCalls).toEqual([]); // still waiting on the re-pin
    expect(h.client.promptCalls).toEqual([]);

    h.client.resolveSetSessionMode();
    await flushMicrotasks();
    expect(h.tracker.snapshotCalls).toHaveLength(1);
    expect(h.client.promptCalls).toHaveLength(1);

    h.client.resolvePrompt();
    await expect(p).resolves.toEqual({ ok: true, text: '' });
  });

  it('no tracker on the root → no snapshot, no baseline ordinal drawn, the prompt still runs', async () => {
    const h = makeHarness({ withTracker: false });
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    expect(h.tracker.snapshotCalls).toEqual([]);
    expect(h.client.promptCalls).toHaveLength(1);
    h.client.resolvePrompt();
    await expect(p).resolves.toEqual({ ok: true, text: '' });
    expect(h.root.nextBaselineOrdinal()).toBe(-1); // nothing was drawn during the run
  });

  it('§2c req 3: a snapshot failure is fail-open — logged, the prompt still runs, the result is unaffected', async () => {
    const h = makeHarness();
    h.tracker.snapshotError = new Error('shadow git stalled');
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    expect(h.client.promptCalls).toHaveLength(1);
    expect(h.logs).toEqual([
      '[AcpBackend] one-shot before-snapshot failed (proceeding unprotected): shadow git stalled',
    ]);
    h.client.resolvePrompt();
    await expect(p).resolves.toEqual({ ok: true, text: '' });
  });
});

describe('OneShotRunner — error paths settle the caller, release the lease, clean up exactly once', () => {
  it('newSession rejects → {ok:false, error}; nothing minted: no record, no delete; lease released; no prompt', async () => {
    const h = makeHarness();
    h.client.holdNewSession();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    h.client.rejectNewSession(new Error('agent refused cwd'));
    await expect(p).resolves.toEqual({ ok: false, error: 'agent refused cwd' });
    expect(h.recorded).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.root.releaseCalls).toEqual(['one-shot-1']);
    expect(h.client.promptCalls).toEqual([]);
  });

  it('setSessionMode rejects AFTER mint → {ok:false, error}; the minted id is recorded AND deleted exactly once; no prompt', async () => {
    const h = makeHarness({ modeId: 'accept_edits' });
    h.client.holdSetSessionMode();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    h.client.rejectSetSessionMode(new Error('mode refused'));
    await expect(p).resolves.toEqual({ ok: false, error: 'mode refused' });
    expect(h.recorded).toEqual(['ephemeral-1']);
    expect(h.deleted).toEqual(['ephemeral-1']); // TG-5 layer 2 via the catch-path dispatch
    expect(h.runner.has('ephemeral-1')).toBe(false);
    expect(h.client.promptCalls).toEqual([]);
    expect(h.root.releaseCalls).toEqual(['one-shot-1']);
  });

  it('prompt rejects → {ok:false, error}; collector removed; delete exactly once', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    h.client.rejectPrompt(new Error('agent died mid-prompt'));
    await expect(p).resolves.toEqual({ ok: false, error: 'agent died mid-prompt' });
    expect(h.runner.has('ephemeral-1')).toBe(false);
    expect(h.deleted).toEqual(['ephemeral-1']);
  });
});

describe('OneShotRunner — §2c req 3 tool-call tripwire (via collect)', () => {
  it('a non-read/think tool_call cancels the ephemeral session, fails the one-shot, logs the tripwire, deletes once — and the registry entry lives until the cancelled prompt settles', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();

    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'write_file', kind: 'edit' });
    await flushMicrotasks();

    expect(h.client.cancelCalls).toEqual(['ephemeral-1']);
    await expect(p).resolves.toEqual({ ok: false, error: 'unexpected tool call' });
    expect(h.logs).toEqual([
      "[AcpBackend] one-shot tripwire: ephemeral session 'ephemeral-1' produced a 'edit' tool_call — cancelling",
    ]);
    expect(h.deleted).toEqual(['ephemeral-1']);
    expect(h.runner.has('ephemeral-1')).toBe(true); // the map entry is removed only when the (cancelled) prompt settles

    h.runner.collect('ephemeral-1', chunk('late')); // a settled collector ignores everything afterwards
    h.client.resolvePrompt(); // Hermes ends the cancelled prompt
    await flushMicrotasks();
    expect(h.runner.has('ephemeral-1')).toBe(false);
    expect(h.deleted).toEqual(['ephemeral-1']); // still exactly once — settle is idempotent
  });

  it('a fresh tool_call with NO kind trips the wire (fail-closed, not fail-open)', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'mystery tool' });
    await flushMicrotasks();
    expect(h.client.cancelCalls).toEqual(['ephemeral-1']);
    await expect(p).resolves.toEqual({ ok: false, error: 'unexpected tool call' });
    expect(h.logs[0]).toContain("produced a 'undefined' tool_call");
  });

  it('read/think never trip; a kind-less tool_call_update inherits the kind recorded for its toolCallId; an unknown kind-less update is ignored', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();

    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read a file', kind: 'read' });
    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1' }); // no kind → looked up: read
    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'thinking', kind: 'think' });
    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call_update', toolCallId: 'never-seen' }); // no kind, unknown id → ignored
    h.runner.collect('ephemeral-1', chunk('fine'));

    expect(h.client.cancelCalls).toEqual([]);
    h.client.resolvePrompt();
    await expect(p).resolves.toEqual({ ok: true, text: 'fine' });
  });

  it('a tool_call_update that CARRIES a disallowed kind trips even when the original call was read', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read', kind: 'read' });
    h.runner.collect('ephemeral-1', { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', kind: 'edit' });
    await flushMicrotasks();
    expect(h.client.cancelCalls).toEqual(['ephemeral-1']);
    await expect(p).resolves.toEqual({ ok: false, error: 'unexpected tool call' });
  });

  it('collect() for an id that is not an in-flight one-shot is a no-op', () => {
    const h = makeHarness();
    expect(() => h.runner.collect('nope', chunk('x'))).not.toThrow();
    expect(h.runner.has('nope')).toBe(false);
  });
});

describe('OneShotRunner — C1 wall-clock deadline races the WHOLE body (+ V-10 orphan checkpoints)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a hanging prompt is cancelled at timeoutMs: {ok:false,"timed out"}, collector gone, delete exactly once — a LATE prompt settle changes nothing', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
    await flushMicrotasks();
    expect(h.client.promptCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.client.cancelCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.cancelCalls).toEqual(['ephemeral-1']);

    await expect(p).resolves.toEqual({ ok: false, error: 'timed out' });
    expect(h.runner.has('ephemeral-1')).toBe(false);
    expect(h.deleted).toEqual(['ephemeral-1']);
    expect(h.root.releaseCalls).toEqual(['one-shot-1']);
    expect(h.logs).toContain('[AcpBackend] one-shot deadline (5000ms) exceeded — cancelling');

    h.client.resolvePrompt(); // the zombie prompt finally settles
    await flushMicrotasks();
    expect(h.deleted).toEqual(['ephemeral-1']); // still once
  });

  it('defaults to a 30 000 ms deadline when timeoutMs is omitted', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.client.cancelCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.cancelCalls).toEqual(['ephemeral-1']);
    await expect(p).resolves.toEqual({ ok: false, error: 'timed out' });
  });

  it('the deadline timer is cleared on normal completion — no late cancel', async () => {
    const h = makeHarness();
    const p = h.runner.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
    await flushMicrotasks();
    h.runner.collect('ephemeral-1', chunk('ok'));
    h.client.resolvePrompt();
    await expect(p).resolves.toEqual({ ok: true, text: 'ok' });
    await vi.advanceTimersByTimeAsync(5_000); // the deadline would have fired here if left armed
    expect(h.client.cancelCalls).toEqual([]);
  });

  it('V-10: the deadline fires while newSession is still pending → timed out now; when newSession later resolves the orphan is recorded, cancelled, deleted once — never snapshotted or prompted', async () => {
    const h = makeHarness();
    h.client.holdNewSession();
    const p = h.runner.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
    await flushMicrotasks();
    expect(h.client.newSessionCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ ok: false, error: 'timed out' });
    expect(h.client.cancelCalls).toEqual([]); // no id was known at fire time
    expect(h.root.releaseCalls).toEqual(['one-shot-1']); // the lease is already back

    h.client.resolveNewSession();
    await flushMicrotasks();
    expect(h.recorded).toEqual(['ephemeral-1']); // TG-5 layer 1: unconditional, even for an orphan
    expect(h.client.cancelCalls).toEqual(['ephemeral-1']);
    expect(h.deleted).toEqual(['ephemeral-1']); // the `!collector` branch dispatches the cleanup directly
    expect(h.tracker.snapshotCalls).toEqual([]);
    expect(h.client.promptCalls).toEqual([]);
    expect(h.runner.has('ephemeral-1')).toBe(false);
  });

  it('V-10: the deadline fires while setSessionMode is pending → after it resolves: no snapshot, no prompt, delete still exactly once (the collector-present checkpoint never double-dispatches)', async () => {
    const h = makeHarness({ modeId: 'accept_edits' });
    h.client.holdSetSessionMode();
    const p = h.runner.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
    await flushMicrotasks();
    expect(h.client.setSessionModeCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ ok: false, error: 'timed out' });
    expect(h.deleted).toEqual(['ephemeral-1']); // the deadline handler settled the registered collector

    h.client.resolveSetSessionMode();
    await flushMicrotasks();
    expect(h.client.promptCalls).toEqual([]);
    expect(h.tracker.snapshotCalls).toEqual([]);
    expect(h.deleted).toEqual(['ephemeral-1']); // still once
    expect(h.client.cancelCalls).toEqual(['ephemeral-1', 'ephemeral-1']); // deadline handler + post-await checkpoint: two best-effort cancels, one id
  });
});

describe('OneShotRunner — §2c req 5 settleAll (teardown / crash)', () => {
  it('settles every in-flight one-shot (across roots) as {ok:false, reason}, clears the registry, deletes each exactly once, releases each lease', async () => {
    const h = makeHarness();
    h.client.queueSessionId('eph-a');
    const pa = h.runner.oneShot('a', { cwd: '/ws-a' });
    await flushMicrotasks();
    h.client.queueSessionId('eph-b');
    const pb = h.runner.oneShot('b', { cwd: '/ws-b' });
    await flushMicrotasks();
    expect(h.runner.has('eph-a')).toBe(true);
    expect(h.runner.has('eph-b')).toBe(true);

    h.runner.settleAll('connection lost');

    await expect(pa).resolves.toEqual({ ok: false, error: 'connection lost' });
    await expect(pb).resolves.toEqual({ ok: false, error: 'connection lost' });
    expect(h.runner.has('eph-a')).toBe(false);
    expect(h.runner.has('eph-b')).toBe(false);
    expect(h.deleted).toEqual(['eph-a', 'eph-b']);
    expect(h.rootFor('/ws-a').anyLiveTurn()).toBe(false);
    expect(h.rootFor('/ws-b').anyLiveTurn()).toBe(false);

    h.client.resolvePrompt(); // a zombie prompt settling later changes nothing
    await flushMicrotasks();
    expect(h.deleted).toEqual(['eph-a', 'eph-b']);
  });

  it('settleAll on an empty registry is a no-op', () => {
    const h = makeHarness();
    expect(() => h.runner.settleAll('x')).not.toThrow();
    expect(h.deleted).toEqual([]);
  });
});
