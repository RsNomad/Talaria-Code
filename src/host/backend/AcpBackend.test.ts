import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { promises as fsp, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { AcpBackend } from './AcpBackend';
import type { MentionResolverLike } from './AcpBackend';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import type { ResolvedContext } from '../context/types';
import type {
  Checkpoint,
  CheckpointPhase,
  CheckpointsData,
  ContextRef,
  HostToWebviewMessage,
  SessionsData,
  SubagentsData,
} from '../../shared/protocol';
import { BOOTSTRAP_TAB_ID } from '../../shared/protocol';
import { AcpClient } from './acp/acpClient';
import type {
  AcpClientCallbacks,
  AcpClientFactory,
  AcpClientOptions,
  AcpListSessionsRawResult,
  AcpLoadSessionResult,
  AcpMcpServer,
  AcpMcpServerStdio,
} from './acp/acpClient';
// T-19 (C1+C2): AcpMcpServerHttp moved to shared/ — see acpClient.ts's own note.
import type { AcpMcpServerHttp } from '../../shared/acpMcpServerHttp';
import type { AcpSessionUpdate, AcpRequestPermissionRequest, AcpRequestPermissionResponse } from './acp/types';
import { evaluateEditPolicy } from './policy/editPolicy';
import { EditPreviewRegistry } from '../preview/EditPreviewRegistry';
import type { CheckpointTrackerLike } from '../checkpoints/trackerContract';
import type { RestoreResult } from '../checkpoints/CheckpointTracker';
import { CheckpointLockTimeoutError } from '../checkpoints/CheckpointTracker';
import type { PanelSource } from '../panels/PanelSourceRegistry';
import type { DashboardService } from '../dashboard/HermesDashboardManager';
import type { DashboardClientLike, DashboardToggleResult } from '../dashboard/HermesDashboardClient';
import type { ConfinedReader } from './acp/confinedOpen';
import { ConnectionSupervisor, type ConnectionSupervisorHostPort } from './connection/ConnectionSupervisor';
import { SessionRegistry } from './session/SessionRegistry';
import { must } from '../../testing/must';

/**
 * `vscode` isn't resolvable outside the extension host; `AcpBackend` only
 * needs `vscode.EventEmitter` at construction time (the `emitter` field
 * initializer) for anything exercised by these tests. Vitest intercepts the
 * specifier before resolution, so no real module needs to exist on disk.
 *
 * W4-T4b additions: `AcpBackend`'s constructor now ALSO subscribes to
 * `vscode.workspace.onDidChangeConfiguration` (the §4.3 mitigation 2
 * disposable) — every test in this file constructs a real `AcpBackend`, so
 * this must exist unconditionally or the whole suite breaks, not just the
 * new SF-2 tests. `getConfiguration().inspect('talaria.customModes')` backs
 * `readCustomModes()` (called from `setCustomMode`/`openSession`'s
 * `mode.state` emit/the config-change handler); `window.showWarningMessage`
 * backs the self-widening warning + `customModes.ts`'s own rule-ingest
 * warning. Both `__customModesWorkspaceValue`/`__customModesFolderValue`
 * default to `undefined` (=> `readCustomModes()` returns `[]`), so every
 * PRE-EXISTING test is unaffected unless it opts in via `mockWorkspace`.
 */
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };
    fire(data: T): void {
      for (const listener of [...this.listeners]) listener(data);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  type ConfigChangeEvent = { affectsConfiguration: (section: string) => boolean };
  type ConfigChangeListener = (e: ConfigChangeEvent) => void;
  // Mutable surface the `handleReadTextFile` confinement tests below drive:
  // reassign `workspace.workspaceFolders` / `workspace.__fileBody` per test.
  const workspace: {
    workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
    __fileBody: string;
    fs: { readFile: (uri: { fsPath: string }) => Promise<Buffer> };
    __customModesWorkspaceValue: unknown;
    __customModesFolderValue: unknown;
    __configChangeListeners: ConfigChangeListener[];
    getConfiguration: (section?: string) => {
      inspect: (key: string) => Record<string, unknown> | undefined;
    };
    onDidChangeConfiguration: (listener: ConfigChangeListener) => { dispose(): void };
  } = {
    workspaceFolders: undefined,
    __fileBody: '',
    fs: {
      readFile: async () => Buffer.from(workspace.__fileBody, 'utf-8'),
    },
    __customModesWorkspaceValue: undefined,
    __customModesFolderValue: undefined,
    __configChangeListeners: [],
    getConfiguration: () => ({
      inspect: (key: string) => {
        if (key !== 'talaria.customModes') return undefined;
        return {
          workspaceValue: workspace.__customModesWorkspaceValue,
          workspaceFolderValue: workspace.__customModesFolderValue,
        };
      },
    }),
    onDidChangeConfiguration: (listener: ConfigChangeListener) => {
      workspace.__configChangeListeners.push(listener);
      return {
        dispose: () => {
          workspace.__configChangeListeners = workspace.__configChangeListeners.filter((l) => l !== listener);
        },
      };
    },
  };
  const window = { showWarningMessage: vi.fn() };
  const Uri = { file: (p: string) => ({ fsPath: p }) };
  return { EventEmitter, workspace, window, Uri };
});

/**
 * T-B1 (closes V-8): the "spawn-'error' fans out onExit" test constructs a
 * REAL `AcpClient` (not the `FakeAcpClient` test double every other test in
 * this file uses) to prove the production `acpClient.ts` fix itself, over a
 * fake `ChildProcess` — same technique `acpClient.test.ts`/
 * `acpClient.wire.test.ts` already use (mock `node:child_process`, wire a
 * real `AcpClient` to an `EventEmitter`-based fake child). `importOriginal`
 * keeps `execFile` real (unused by anything in this file — every
 * `makeStartableBackend` config sets `hermesPath`, so `resolveHermesBin`
 * never reaches its `execFile`-based login-shell lookup — but importing it
 * for real rather than dropping it is cheap insurance against a future test
 * in this already-enormous file needing it).
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

/**
 * W2-F1: the policy engine (Zone A, `./policy/editPolicy`, contract C2) is built
 * in PARALLEL. We spy on `evaluateEditPolicy` so the fail-closed test can force a
 * throw. When the real module exists we DELEGATE to it (true integration — the
 * spy's default impl is the real engine); when it does not yet exist we fall
 * back to a faithful C2 transcription of the rows these backend routing/guard
 * tests exercise, so the suite stays runnable during the parallel build.
 */
vi.mock('./policy/editPolicy', async (importOriginal) => {
  // W2-F1: wrap the REAL engine in a vi.fn so tests can observe calls and (in
  // the fail-closed test only) override it once — every other test exercises
  // the real decision table end to end. Deliberately NO import-failure
  // fallback (review minor): if the engine module ever failed to import, the
  // suite must fail loudly rather than silently green-light a hand-transcribed
  // copy of the table that could drift from the real one.
  const actual = await importOriginal<typeof import('./policy/editPolicy')>();
  return { ...actual, evaluateEditPolicy: vi.fn(actual.evaluateEditPolicy) };
});

/** Deferred promise so the test controls exactly when `client.prompt()` settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A throwaway `Checkpoint` value for resolving a controllable snapshot deferred (C1 tests). */
function makeCheckpoint(turnOrdinal: number): Checkpoint {
  return { id: `ckpt-${turnOrdinal}`, label: 'x', age: 'just now', timestamp: '2026-07-11T00:00:00Z', turnOrdinal };
}

/**
 * Minimal stand-in for `AcpClient` — only the surface `runTurn`/`start`
 * touches. Implements enough of `AcpClientLike` (structurally, no explicit
 * `implements` needed) for `AcpBackend`'s injected `createClient` factory —
 * `newSessionCalls` is what the Zone RAG `mcpServers` wiring tests assert on.
 */
class FakeAcpClient {
  promptCallCount = 0;
  newSessionCalls: Array<{ cwd: string; mcpServers?: AcpMcpServer[] }> = [];
  listSessionsCalls: Array<{ cwd?: string; cursor?: string }> = [];
  loadSessionCalls: Array<{ cwd: string; sessionId: string; mcpServers?: AcpMcpServer[] }> = [];
  // W2-F1 wire-pin: the modeId `newSession` reports (drive a drift scenario) and
  // a record of every `setSessionMode` re-assert the pin makes.
  newSessionModeId = 'default';
  /** A7: the modelId `newSession`/`loadSession` report — `undefined` (the
   *  default) matches every PRE-EXISTING test's fixture (no `models` on the
   *  wire), so opting in is required to exercise the bind-time model.state
   *  emission. */
  newSessionModelId: string | undefined = undefined;
  setSessionModeCalls: Array<{ sessionId: string; modeId: string }> = [];
  /** W2-F1 Plan preamble: the last `content` array handed to `prompt`. */
  lastPromptContent: unknown;
  private nextPrompt: ReturnType<typeof deferred<{ stopReason: string; usage?: unknown }>> | undefined;
  private listSessionsResult: AcpListSessionsRawResult = { sessions: [] };
  private loadSessionResult: AcpLoadSessionResult = { found: true, currentModeId: 'default' };
  /** Update `session/update` notifications to fire (simulating history replay)
   * the instant `loadSession` is called, mirroring the real Hermes behavior of
   * streaming the transcript back BEFORE the `session/load` response resolves. */
  private replayUpdates: AcpSessionUpdate[] = [];
  /** Captured from `AcpClientOptions` when constructed via the real
   * `createClient` factory (see `makeStartableBackend`) — undefined when a
   * test manually seeds `seam(backend).client` instead. */
  callbacks: AcpClientCallbacks | undefined;
  /** R-A6: registered `onExit` handlers — `start()` should register exactly one. */
  exitHandlers: Array<(code: number | null) => void> = [];
  /** When set, connect() rejects — drives the failed-respawn backoff test. */
  connectError: unknown;

  constructor(options?: AcpClientOptions) {
    this.callbacks = options?.callbacks;
  }

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }
  async initialize(): Promise<void> {}

  onExit(handler: (code: number | null) => void): { dispose(): void } {
    this.exitHandlers.push(handler);
    return {
      dispose: () => {
        this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
      },
    };
  }

  /** Fire every registered exit handler, as the real child's 'exit' would. */
  simulateExit(code: number | null): void {
    for (const handler of [...this.exitHandlers]) handler(code);
  }

  /** T5b: FIFO queue of sessionIds `newSession()` returns on its NEXT call(s) —
   * lets the one-shot tests give an ephemeral session a DISTINCT id from the
   * pre-seeded main 'session-1'. Falls back to 'session-1' once empty, so
   * every existing single-`newSession`-per-instance test is unaffected. */
  private queuedSessionIds: string[] = [];
  queueSessionId(id: string): void {
    this.queuedSessionIds.push(id);
  }

  /** C1: makes the NEXT `newSession()` call hang (never resolve on its own) —
   * simulates a child that is alive-but-unresponsive during `session/new`,
   * mirroring `hangLoadSession`'s own pattern below. */
  private hungNewSession = false;
  hangNewSession(): void {
    this.hungNewSession = true;
  }

  /** V-10: makes the NEXT `newSession()` call return a CONTROLLABLE deferred
   * promise — unlike `hangNewSession` (never resolves), the test resolves it
   * later via `resolveDelayedNewSession`. Drives the "the one-shot deadline
   * fires BEFORE `newSession` resolves, then `newSession` finally resolves
   * anyway" race the ONESHOT-ORPHAN fix closes. The deferred itself
   * (`delayedNewSessionDeferred`) is kept alive independently of the
   * one-shot "is a delayed call armed" flag consumed by `newSession()` below
   * — `resolveDelayedNewSession` must still be able to reach it AFTER
   * `newSession()` has already been called and returned the pending promise. */
  private delayedNewSessionDeferred: ReturnType<typeof deferred<{ sessionId: string; currentModeId: string }>> | undefined;
  private delayedNewSessionArmed = false;
  delayNewSession(): void {
    this.delayedNewSessionDeferred = deferred<{ sessionId: string; currentModeId: string }>();
    this.delayedNewSessionArmed = true;
  }
  resolveDelayedNewSession(sessionId: string): void {
    this.delayedNewSessionDeferred?.resolve({ sessionId, currentModeId: this.newSessionModeId });
  }

  /** W4-T1b (F2): makes the NEXT `newSession()` call REJECT — simulates a
   * session-establish failure (e.g. Hermes refuses the cwd) on an otherwise
   * healthy connection, driving the phase-split tests. Auto-clears after
   * firing once, so a subsequent (retry) call succeeds normally. */
  private nextNewSessionError: unknown;
  failNextNewSession(err: unknown): void {
    this.nextNewSessionError = err;
  }

  async newSession(
    cwd: string,
    mcpServers?: AcpMcpServer[],
  ): Promise<{ sessionId: string; currentModeId: string; currentModelId?: string }> {
    this.newSessionCalls.push({ cwd, mcpServers });
    if (this.hungNewSession) return new Promise<{ sessionId: string; currentModeId: string }>(() => {}); // never resolves
    if (this.nextNewSessionError !== undefined) {
      const err = this.nextNewSessionError;
      this.nextNewSessionError = undefined;
      throw err;
    }
    if (this.delayedNewSessionArmed && this.delayedNewSessionDeferred) {
      this.delayedNewSessionArmed = false; // consume the "next call is delayed" flag; the deferred itself lives on
      return this.delayedNewSessionDeferred.promise;
    }
    const sessionId = this.queuedSessionIds.shift() ?? 'session-1';
    return { sessionId, currentModeId: this.newSessionModeId, currentModelId: this.newSessionModelId };
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    this.setSessionModeCalls.push({ sessionId, modeId });
  }
  async setSessionModel(_sessionId: string, _modelId: string): Promise<void> {}
  /** IMP-1 (W3-T6 3-lens review, CF-11): records every wire `session/cancel`
   *  call — proves `newSessionInTabInternal` issues an EXPLICIT cancel of the
   *  orphaned turn (gated on `hasLiveTurn()`), and exactly once (not a second
   *  time from `dispose()`'s own cancel-gate, which `endForRestart` nulling
   *  `liveTurnId` first makes skip). */
  cancelCalls: string[] = [];
  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }
  /** CF-01/A fix wave: counts calls — proves `handleAcpCrash`'s per-controller
   *  `endOnCrash()` loop guard still reaches the trailing `client.dispose()`
   *  even when an earlier iteration throws (the loop-guard regression test). */
  disposeCallCount = 0;
  dispose(): void {
    this.disposeCallCount++;
  }

  /** Task 13: the advertised auth methods this fake "retained at initialize" —
   * `undefined` (the default) matches a client whose `initialize()` never ran
   * or a test double predating the surface; `makeStartableBackend`'s
   * `mutateClient` seeds per-client values for the refresh-across-restart
   * tests. */
  advertisedAuthMethods: { id: string; name: string }[] | undefined = undefined;
  getAdvertisedAuthMethods(): { id: string; name: string }[] | undefined {
    return this.advertisedAuthMethods;
  }
  /** Task 13: registered auth-methods-change handlers + a test trigger. */
  authMethodsHandlers: Array<() => void> = [];
  onAuthMethodsChanged(handler: () => void): { dispose(): void } {
    this.authMethodsHandlers.push(handler);
    return {
      dispose: () => {
        this.authMethodsHandlers = this.authMethodsHandlers.filter((h) => h !== handler);
      },
    };
  }
  fireAuthMethodsChanged(): void {
    for (const handler of [...this.authMethodsHandlers]) handler();
  }

  /** W4-T5b: records every `closeSession` call — the best-effort `session/close` seam. */
  closeSessionCalls: string[] = [];
  /** W4-T5b: when set, the NEXT `closeSession()` call REJECTS with this (auto-clears) —
   * drives the dispose()-swallows-a-rejection test. */
  closeSessionError: unknown;
  async closeSession(sessionId: string): Promise<void> {
    this.closeSessionCalls.push(sessionId);
    if (this.closeSessionError !== undefined) {
      const err = this.closeSessionError;
      this.closeSessionError = undefined;
      throw err;
    }
  }

  prompt(_sessionId: string, content: unknown): Promise<{ stopReason: string; usage?: unknown }> {
    this.promptCallCount += 1;
    this.lastPromptContent = content;
    this.nextPrompt = deferred<{ stopReason: string; usage?: unknown }>();
    return this.nextPrompt.promise;
  }

  rejectInFlightPrompt(err: unknown): void {
    this.nextPrompt?.reject(err);
  }

  resolveInFlightPrompt(result: { stopReason: string; usage?: unknown }): void {
    this.nextPrompt?.resolve(result);
  }

  setListSessionsResult(result: AcpListSessionsRawResult): void {
    this.listSessionsResult = result;
  }

  async listSessions(cwd?: string, cursor?: string): Promise<AcpListSessionsRawResult> {
    this.listSessionsCalls.push({ cwd, cursor });
    return this.listSessionsResult;
  }

  setLoadSessionResult(result: AcpLoadSessionResult): void {
    this.loadSessionResult = result;
  }

  /** Queue `session/update` notification(s) `loadSession` fires synchronously
   * before resolving — simulates Hermes replaying history pre-response. */
  setReplayUpdates(updates: AcpSessionUpdate[]): void {
    this.replayUpdates = updates;
  }

  /** M2: makes the NEXT `loadSession()` call hang (never resolve on its own) —
   * simulates a `session/load` replay still in flight when the child dies. */
  private hungLoadSession = false;
  hangLoadSession(): void {
    this.hungLoadSession = true;
  }

  async loadSession(
    cwd: string,
    sessionId: string,
    mcpServers?: AcpMcpServer[],
  ): Promise<AcpLoadSessionResult> {
    this.loadSessionCalls.push({ cwd, sessionId, mcpServers });
    for (const update of this.replayUpdates) {
      this.callbacks?.onSessionUpdate(sessionId, update);
    }
    if (this.hungLoadSession) return new Promise<AcpLoadSessionResult>(() => {}); // never resolves
    return this.loadSessionResult;
  }
}

/** Reaches past TS's compile-time `private` to seed the fields `sendPrompt`/`runTurn`
 * need, and to simulate a superseded/torn-down turn — mirrors how a real "New
 * Session" or a second `sendPrompt` mutates `currentTurnId` mid-flight, without
 * pulling in the real ACP/control-plane spawn machinery `start()` needs.
 *
 * W4-T1a: most of this state MOVED off `AcpBackend` onto the per-session
 * `SessionController` (§2a). `seam()` stays a drop-in replacement for every
 * existing test by PROXYING: `control` (genuinely connection-level, stayed
 * on `AcpBackend`) reads/writes `backend` directly; `client`/`inFlightStart`
 * (W6-FI-b: moved onto `ConnectionSupervisor`) reach ONE hop further, through
 * `backend.connectionSupervisor.{client,inFlightStart}` — same reflective
 * seam, just one more `private` boundary past `AcpBackend` itself, mirroring
 * `ephemeral`'s own W6-FI-a precedent immediately below; `ephemeral`
 * (W6-FI-a: moved onto `OneShotRunner`) reaches ONE hop further, through
 * `backend.oneShotRunner.ephemeral`; `sessionId` reads/writes `backend`'s
 * `activeSessionId` (minting a controller via the SAME production
 * `buildSessionPort`/`SessionRegistry.open` a real `openSession()` call
 * uses, the first time a test sets it); everything else
 * (`currentTurnId`/`liveTurnId`/`replay`/`cwd`/`currentTurnProtected`/
 * `currentMode`/`subagents`) proxies through to the ACTIVE controller,
 * auto-binding method properties so `seam(backend).snapshotCheckpoint(...)`
 * still works for the one call site that reaches a controller-private
 * method this way.
 *
 * W4-T2: the old connection-level `oneShotInFlight` boolean is GONE (the
 * root turn lease subsumes it, F1) — tests that used to read it now call
 * {@link anyLiveTurnOnRoot} instead, which observes the SAME production
 * root-resolution `resolveRootCoordinator` uses.
 */
interface AcpBackendTestSeam {
  client: unknown;
  sessionId: string | undefined;
  currentTurnId: string | undefined;
  /** P1: id of the LIVE prompt turn (see `SessionController`'s own field doc). */
  liveTurnId: string | undefined;
  /** M1: the `start()` serialization tail — should reset to `undefined` once idle. */
  inFlightStart: Promise<void> | undefined;
  /** M2: the in-flight `session/load` replay window (undefined once closed). */
  replay: unknown;
  control: unknown;
  // W2-F1 policy seam: drive the signal context + read the tracked protection.
  cwd: string | undefined;
  currentTurnProtected: boolean;
  // AH4: read back the internally-clamped wire mode.
  currentMode: string;
  // P4b: spy on the subagents fold's setReplaying toggle.
  subagents: { setReplaying(replaying: boolean): void };
  ephemeral: Map<string, unknown>;
  /** W4-T4b (SF-2): read back the controller's snapshot-on-activate state. */
  activeCustomModeId: string | null;
  activeCustomMode: unknown;
}

/** The connection-level field that stays directly on `AcpBackend` post-extraction. */
const SEAM_CONNECTION_FIELDS = new Set(['control']);

/**
 * W6-FI-b: `client`/`inFlightStart` moved off `AcpBackend` onto
 * `ConnectionSupervisor` (3-way ARCH I-4, part 2 of 3 — behavior-preserving
 * MOVE + DI). `seam()`'s reads/writes for these two reach ONE hop further
 * than {@link SEAM_CONNECTION_FIELDS} — through
 * `backend.connectionSupervisor.{client,inFlightStart}` — rather than
 * `backend.{client,inFlightStart}` directly; every existing assertion is
 * unchanged, only HOW the seam reaches the same live field.
 */
const SEAM_SUPERVISOR_FIELDS = new Set(['client', 'inFlightStart']);

/**
 * W6-FI-a: `ephemeral` moved off `AcpBackend` onto `OneShotRunner` (3-way
 * ARCH I-4, part 1 of 3 — behavior-preserving MOVE + DI). `seam()`'s
 * `ephemeral` read reaches ONE hop further than the other
 * {@link SEAM_CONNECTION_FIELDS} — through `backend.oneShotRunner.ephemeral`
 * — rather than `backend.ephemeral` directly; every existing assertion
 * (`seam(backend).ephemeral.size`/`.has(...)`) is unchanged, only HOW the
 * seam reaches the same live `Map` instance.
 */
const SEAM_EPHEMERAL_FIELD = 'ephemeral';

/**
 * `cwd` is a SYNCED special case: it lives on BOTH `AcpBackend` (the
 * connection-level default `oneShot`/panel-fetch code reads) AND the active
 * `SessionController` (the per-session copy the moved policy/turn code
 * reads) — every REAL production flow (`openSession`/`loadSessionIntoTab`)
 * writes both to the SAME value, so the seam mirrors that: write-through to
 * both, read from `AcpBackend`'s copy (always equal to the controller's by
 * construction).
 */
const SEAM_SYNCED_CWD = 'cwd';

/** The minimal reflective shape `seam()` needs from a real `AcpBackend` instance. */
interface AcpBackendInternals {
  activeSessionId: string | undefined;
  cwd: string | undefined;
  sessions: {
    has(id: string): boolean;
    get(id: string): Record<string, unknown> | undefined;
    open(id: string, cwd: string, port: unknown): unknown;
  };
  buildSessionPort(sessionId: string, cwd: string): unknown;
  resolveRootCoordinator(cwd: string): { anyLiveTurn(): boolean };
  /** W6-FI-a: the extracted one-shot subsystem — see {@link SEAM_EPHEMERAL_FIELD}'s doc. */
  oneShotRunner: { ephemeral: Map<string, unknown> };
  /** W6-FI-b: the extracted connection-lifecycle subsystem — see {@link SEAM_SUPERVISOR_FIELDS}'s doc. */
  connectionSupervisor: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * W4-T2: observe "is there a live turn (a main turn OR an in-flight
 * one-shot) on `cwd`'s root" — the direct replacement for the deleted
 * `oneShotInFlight` boolean. Goes through the REAL production
 * `resolveRootCoordinator` (not a reimplementation), so it stays honest
 * about which root a given `cwd` actually resolves to.
 */
function anyLiveTurnOnRoot(backend: AcpBackend, cwd: string): boolean {
  const b = backend as unknown as AcpBackendInternals;
  return b.resolveRootCoordinator(cwd).anyLiveTurn();
}

function seam(backend: AcpBackend): AcpBackendTestSeam {
  const b = backend as unknown as AcpBackendInternals;
  const activeController = (): Record<string, unknown> | undefined =>
    b.activeSessionId ? b.sessions.get(b.activeSessionId) : undefined;

  return new Proxy({} as AcpBackendTestSeam, {
    get(_target, prop: string) {
      if (SEAM_CONNECTION_FIELDS.has(prop)) return b[prop];
      if (SEAM_SUPERVISOR_FIELDS.has(prop)) return b.connectionSupervisor[prop];
      if (prop === SEAM_EPHEMERAL_FIELD) return b.oneShotRunner.ephemeral;
      if (prop === 'sessionId') return b.activeSessionId;
      if (prop === SEAM_SYNCED_CWD) return b.cwd;
      const controller = activeController();
      if (!controller) return undefined;
      const value = controller[prop];
      return typeof value === 'function' ? value.bind(controller) : value;
    },
    set(_target, prop: string, value: unknown) {
      if (SEAM_CONNECTION_FIELDS.has(prop)) {
        b[prop] = value;
        return true;
      }
      if (SEAM_SUPERVISOR_FIELDS.has(prop)) {
        b.connectionSupervisor[prop] = value;
        return true;
      }
      if (prop === 'sessionId') {
        const id = value as string;
        if (!b.sessions.has(id)) {
          b.sessions.open(id, b.cwd ?? '', b.buildSessionPort(id, b.cwd ?? ''));
        }
        b.activeSessionId = id;
        return true;
      }
      if (prop === SEAM_SYNCED_CWD) {
        b.cwd = value as string | undefined;
        const controller = activeController();
        if (controller) controller.cwd = value;
        return true;
      }
      const controller = activeController();
      if (controller) controller[prop] = value;
      return true;
    },
  }) as AcpBackendTestSeam;
}

/**
 * W4-T1b: like {@link seam}, but targets an EXPLICIT sessionId's controller
 * directly — never the "active" one. Needed once a test holds TWO live
 * controllers at once (the P-0 multi-controller isolation tests prove B is
 * judged under B while A stays untouched, which requires reading/writing
 * BOTH controllers' own fields independently of whichever is "active").
 */
function seamFor(backend: AcpBackend, sessionId: string): Record<string, unknown> {
  const b = backend as unknown as { sessions: { get(id: string): Record<string, unknown> | undefined } };
  const controller = b.sessions.get(sessionId);
  if (!controller) throw new Error(`seamFor: no controller registered for '${sessionId}'`);
  return new Proxy(controller, {
    get(target, prop: string) {
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  });
}

function makeBackend(): { backend: AcpBackend; client: FakeAcpClient; messages: HostToWebviewMessage[] } {
  const config: HermesRuntimeConfig = {};
  const backend = new AcpBackend(config);
  const client = new FakeAcpClient();
  seam(backend).client = client;
  seam(backend).sessionId = 'session-1';

  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((msg) => messages.push(msg));

  return { backend, client, messages };
}

describe('AcpBackend.runTurn — catch-block guard for a superseded turn (finding #2)', () => {
  it('does not emit error/turn.end when client.prompt() rejects after the turn was superseded', async () => {
    const { backend, client, messages } = makeBackend();

    backend.sendPrompt('session-1', 'first prompt', 'default');
    // C1: prompt() now sits behind the awaited pre-turn checkpoint barrier, so
    // flush the barrier chain before it is actually in flight.
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1);
    messages.length = 0; // drop the turn.start/user messages from sendPrompt itself

    // Simulate the turn being superseded (New Session / a second prompt) while
    // the first `client.prompt()` call is still in flight.
    seam(backend).currentTurnId = 'turn-2';

    client.rejectInFlightPrompt(new Error('boom: connection reset'));
    await flushMicrotasks();

    expect(messages).toEqual([]);
  });

  it('still emits error/turn.end for a non-superseded rejection (baseline, unchanged)', async () => {
    const { backend, client, messages } = makeBackend();

    backend.sendPrompt('session-1', 'first prompt', 'default');
    await flushMicrotasks(); // C1: let the barrier resolve so prompt() is in flight
    messages.length = 0;

    client.rejectInFlightPrompt(new Error('boom: connection reset'));
    await flushMicrotasks();

    expect(messages).toEqual([
      { type: 'error', sessionId: 'session-1', message: 'boom: connection reset', turnId: 'turn-1' },
      { type: 'turn.end', sessionId: 'session-1', turnId: 'turn-1', status: 'error' },
    ]);
  });

  /**
   * W1-T3 (CF-01/I-2 brief, RED test (b)): a rejected `client.prompt()` — the
   * `SessionController.ts` ~:892 await — must settle the turn with NO leaked
   * pending state: `turnActive` (`ControlDispatcher.listTabs()`'s own
   * per-tab liveness field, `controller.hasLiveTurn()`) must go back to
   * `false`, exactly like a clean turn end. `runTurn`'s existing try/catch
   * (spanning both the :863-865 setSessionMode re-pin AND the :892 prompt
   * await) already routes a rejection here through `emitTurnEnd`, which
   * clears `liveTurnId` — this test pins that guarantee explicitly, in the
   * brief's own vocabulary, rather than only inferring it indirectly (as the
   * two tests above do, via a second `sendPrompt`/an empty message list).
   */
  it('W1-T3: a rejected client.prompt() leaves no stranded turnActive (listTabs reflects the turn as over)', async () => {
    const { backend, client } = makeBackend();

    backend.sendPrompt('session-1', 'first prompt', 'default');
    await flushMicrotasks();
    expect(backend.listTabs().find((t) => t.sessionId === 'session-1')?.turnActive).toBe(true);

    client.rejectInFlightPrompt(new Error('boom: connection reset'));
    await flushMicrotasks();

    expect(backend.listTabs().find((t) => t.sessionId === 'session-1')?.turnActive).toBe(false);
  });
});

/**
 * Drain the microtask queue enough times to walk the whole
 * `sendPrompt -> runTurnWithCheckpoint (await snapshot BARRIER) -> runTurn ->
 * client.prompt()` async chain (C1 made `client.prompt()` sit behind the awaited
 * pre-turn checkpoint barrier, so it is no longer reached synchronously). Every
 * hop is a promise (no timers), so a fixed number of awaits fully settles it.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('AcpBackend.sendPrompt — R-A2: host-authoritative in-flight guard (Hermes QUEUES, never supersedes)', () => {
  it('refuses a second prompt while one is live: no second client.prompt, no phantom user bubble, an error is surfaced', async () => {
    const { backend, client, messages } = makeBackend();
    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1);
    messages.length = 0;

    backend.sendPrompt('session-1', 'second — must be refused', 'default');
    await flushMicrotasks();

    expect(client.promptCallCount).toBe(1); // NOT sent — Hermes would queue it (server.py:1373-1383)
    expect(messages.filter((m) => m.type === 'user')).toEqual([]); // no silently-dropped bubble
    expect(messages.filter((m) => m.type === 'turn.start')).toEqual([]);
    expect(messages).toEqual([
      { type: 'error', sessionId: 'session-1', message: expect.stringContaining('already running') },
    ]);
  });

  it('accepts a new prompt after the live turn ends (complete)', async () => {
    const { backend, client } = makeBackend();
    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    backend.sendPrompt('session-1', 'second', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(2);
  });

  it('accepts a new prompt after the live turn ERRORS (rejection path clears the guard)', async () => {
    const { backend, client } = makeBackend();
    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    client.rejectInFlightPrompt(new Error('boom'));
    await flushMicrotasks();

    backend.sendPrompt('session-1', 'second', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(2);
  });

  it('P2: session.load REFUSES while a turn is live — no supersede (symmetric with checkpoint restore/redo); works once the turn ends', async () => {
    // Previously `session.load` cleared `liveTurnId` unconditionally (a
    // "supersede"), WITHOUT cancelling the still-running turn — a later
    // Restore/Redo would then pass the P3 interlock and could rewrite the
    // worktree out from under the agent that was still writing to it. The
    // corrected behavior refuses the load outright (like checkpoint.restore/
    // redo already do) rather than superseding.
    const { backend, client, messages } = makeBackend();
    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1);
    const liveTurnIdBefore = seam(backend).currentTurnId;
    messages.length = 0;

    const result = await backend.invokeControl('session.load', { sessionId: 'old', cwd: '/ws' });

    expect(result).toBeUndefined(); // "not performed" — loadSession's existing refusal signal
    expect(client.loadSessionCalls).toEqual([]); // never reached the ACP client at all
    expect(messages).toEqual([
      { type: 'error', sessionId: 'session-1', message: expect.stringContaining('still running') },
    ]);
    // no supersede: the SAME turn is still the live/current one, untouched
    expect(seam(backend).currentTurnId).toBe(liveTurnIdBefore);
    expect(seam(backend).liveTurnId).toBe(liveTurnIdBefore);

    // the refused load did not clear the guard — a second prompt is still
    // refused too, because turn 1 is genuinely still live
    backend.sendPrompt('session-1', 'second — must still be refused (turn 1 is still live)', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1); // unchanged

    // once the live turn actually ends, session.load works normally again
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
    expect(seam(backend).liveTurnId).toBeUndefined();

    const loaded = await backend.invokeControl('session.load', { sessionId: 'old', cwd: '/ws' });
    expect(loaded).toBeDefined();
    expect(client.loadSessionCalls).toHaveLength(1);
  });
});

describe('AcpBackend.sendPrompt — ARCH-1 (final review, UI I-3): a user action must never no-op silently', () => {
  it('sendPrompt to an unknown/dead session emits an error instead of the bare `?.` silent no-op', () => {
    const { backend, messages } = makeBackend();

    backend.sendPrompt('ghost-session', 'text that has nowhere to go', 'default');

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'error', sessionId: 'ghost-session' }),
    );
  });

  it('sendPrompt to a KNOWN session still routes to that session\'s controller (baseline, unchanged)', async () => {
    const { backend, client, messages } = makeBackend();

    backend.sendPrompt('session-1', 'hello', 'default');
    await flushMicrotasks();

    expect(client.promptCallCount).toBe(1);
    expect(messages.some((m) => m.type === 'error')).toBe(false);
  });
});

/** Mutable view of the mocked `vscode.workspace` (see the vi.mock factory). */
const mockWorkspace = vscode.workspace as unknown as {
  workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  __fileBody: string;
  /** W4-T4b: the `talaria.customModes` WORKSPACE-scoped value `readCustomModes()` reads. */
  __customModesWorkspaceValue: unknown;
  /** W4-T4b: a FOLDER-scoped value, present only to prove `readCustomModes` ignores it (B10). */
  __customModesFolderValue: unknown;
  __configChangeListeners: Array<(e: { affectsConfiguration: (s: string) => boolean }) => void>;
};

/** W4-T4b: the mocked `vscode.window.showWarningMessage` spy. */
const mockShowWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

/**
 * W4-T4b: the `onDidChangeConfiguration` listener registered by the MOST
 * RECENTLY constructed `AcpBackend` — call immediately after constructing
 * the backend under test (before any sibling backend is constructed) so it
 * targets THAT backend's own subscription, never a stale one from an
 * earlier/unrelated test (every `AcpBackend` in this file registers one).
 */
function lastConfigChangeListener(): (e: { affectsConfiguration: (s: string) => boolean }) => void {
  const listener = mockWorkspace.__configChangeListeners.at(-1);
  if (!listener) throw new Error('lastConfigChangeListener: no onDidChangeConfiguration listener registered');
  return listener;
}

type ReadTextFileHandler = (
  p: string,
  line: number | null,
  limit: number | null,
) => Promise<string>;

function readTextFile(backend: AcpBackend): ReadTextFileHandler {
  return (backend as unknown as { handleReadTextFile: ReadTextFileHandler }).handleReadTextFile.bind(
    backend,
  );
}

/**
 * A `ConfinedReader` that always reports unsupported, as `makeProcFdReader()`
 * (the real, default one — see `./acp/confinedOpen`) does off-Linux. Its own
 * `supported()` probe is gated on `process.platform === 'linux'` and, on a
 * REAL Linux host (e.g. the CI runner), legitimately PASSES — at which point
 * `handleReadTextFile` reads through the confined O_PATH path instead of the
 * `else` branch that calls the mocked `vscode.workspace.fs.readFile`. Tests
 * that assert on `mockWorkspace.__fileBody` are keyed to that `else` branch;
 * without pinning `supported()` to `false` here, they silently swap to
 * reading the REAL on-disk bytes on Linux and fail — not because
 * `handleReadTextFile` is wrong (the confined reader's own real-Linux
 * behavior is exhaustively covered by `confinedOpen.test.ts`'s
 * platform-gated "Linux real FS" block), but because the test double for
 * `vscode.workspace.fs` was silently bypassed. Pin it so the code path under
 * test is deterministic on every platform.
 */
function unsupportedConfinedReader(): ConfinedReader {
  return {
    supported: async () => false,
    readContained: async () => {
      throw new Error(
        'unsupportedConfinedReader: readContained must never be called when supported() is false',
      );
    },
  };
}

/**
 * Constructs an `AcpBackend` wired with {@link unsupportedConfinedReader} so
 * `handleReadTextFile` always resolves reads through the mocked
 * `vscode.workspace.fs`, independent of host platform (see that helper's doc).
 */
function backendWithMockedFsRead(config: HermesRuntimeConfig = {} as HermesRuntimeConfig): AcpBackend {
  return new AcpBackend(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    unsupportedConfinedReader(),
  );
}

/** Minimal stand-in for `ControlChannel` — only the surface `invokeControl`/`start` touches. */
class FakeControlChannel {
  dispatchCalls: Array<{ method: string; params?: unknown }> = [];
  private nextResult: unknown;
  private resultsByMethod = new Map<string, unknown>();
  /** T-12 (fetchPanelData staleness): a FIFO queue of caller-controlled
   *  promises per method — lets a test drive two OVERLAPPING dispatches for
   *  the SAME method and resolve them in either order, to prove a stale
   *  resolution never overwrites a fresher one. Consumed in call order
   *  (first `setDeferredFor` -> first `dispatch` call for that method). */
  private deferredQueueByMethod = new Map<string, Array<Promise<unknown>>>();

  setNextResult(result: unknown): void {
    this.nextResult = result;
  }

  /** Per-method canned result — needed once a single panel join spans >1 RPC (e.g. mcp). */
  setResultFor(method: string, result: unknown): void {
    this.resultsByMethod.set(method, result);
  }

  /** Queues `promise` as the result of the NEXT (not-yet-consumed) `dispatch(method, …)` call. */
  setDeferredFor(method: string, promise: Promise<unknown>): void {
    const queue = this.deferredQueueByMethod.get(method) ?? [];
    queue.push(promise);
    this.deferredQueueByMethod.set(method, queue);
  }

  async start(): Promise<void> {}

  dispose(): void {}

  async dispatch<T>(method: string, params?: unknown): Promise<T> {
    this.dispatchCalls.push({ method, params });
    const queue = this.deferredQueueByMethod.get(method);
    const deferred = queue?.shift();
    if (deferred) return deferred as Promise<T>;
    return (this.resultsByMethod.has(method) ? this.resultsByMethod.get(method) : this.nextResult) as T;
  }
}

function withFakeControl(backend: AcpBackend): FakeControlChannel {
  const control = new FakeControlChannel();
  seam(backend).control = control;
  return control;
}

/**
 * Minimal fake for {@link CheckpointTrackerLike} — the narrow structural
 * interface `AcpBackend` depends on, NOT the real `CheckpointTracker` (which
 * shells out to `git`). `restoreResult`/`listResult` are pre-seeded per test;
 * `snapshotCalls`/`restoreCalls` are what the Zone CKPT tests assert on.
 */
class FakeCheckpointTracker implements CheckpointTrackerLike {
  // W2-F2: records `phase` too, so the after-turn hook's `{ phase: 'after' }`
  // call is distinguishable from the C1 before-barrier's (phase-less) call.
  // W4-T5b: records `sessionLabel` too (DISPLAY-ONLY — R8) — what the
  // checkpoint-row session-label tests assert on.
  snapshotCalls: Array<{ turnOrdinal: number; label?: string; phase?: CheckpointPhase; sessionLabel?: string }> = [];
  restoreCalls: Array<{ id: string; force?: boolean }> = [];
  listResult: CheckpointsData = { checkpoints: [] };
  restoreResult: RestoreResult = { restored: true, filesChanged: 0, changedPaths: [] };
  listError: unknown;

  async snapshot(
    turnOrdinal: number,
    label?: string,
    opts?: { phase?: CheckpointPhase; sessionLabel?: string },
  ): Promise<Checkpoint | null> {
    this.snapshotCalls.push({ turnOrdinal, label, phase: opts?.phase, sessionLabel: opts?.sessionLabel });
    return {
      id: `ckpt-${turnOrdinal}`,
      label: label ?? `Turn ${turnOrdinal}`,
      age: 'just now',
      timestamp: new Date().toISOString(),
      filesChanged: 0,
      turnOrdinal,
      ...(opts?.phase ? { phase: opts.phase } : {}),
      ...(opts?.sessionLabel ? { sessionLabel: opts.sessionLabel } : {}),
    };
  }

  async list(): Promise<CheckpointsData> {
    if (this.listError) throw this.listError;
    return this.listResult;
  }

  async restore(id: string, opts?: { force?: boolean }): Promise<RestoreResult> {
    this.restoreCalls.push({ id, force: opts?.force });
    return this.restoreResult;
  }

  // W2-F2 Phase 1: anchored redo — `redoCalls` records which of the two
  // methods was invoked (and with what `force`), `redoResult` is the
  // pre-seeded RestoreResult both return.
  redoCalls: Array<{ kind: 'redo' | 'redoAll'; force?: boolean }> = [];
  redoResult: RestoreResult = { restored: true, filesChanged: 0, changedPaths: [] };

  async redo(opts?: { force?: boolean }): Promise<RestoreResult> {
    this.redoCalls.push({ kind: 'redo', force: opts?.force });
    return this.redoResult;
  }

  async redoAll(opts?: { force?: boolean }): Promise<RestoreResult> {
    this.redoCalls.push({ kind: 'redoAll', force: opts?.force });
    return this.redoResult;
  }
}

/**
 * T2c: fake {@link MentionResolverLike} — tests control resolution TIMING
 * (via `setImpl`, so a test can hand back a deferred promise to prove
 * barrier-parallel concurrency) and OUTCOME (including a resolver that
 * THROWS, to pin `resolveMentionsSafe`'s total try/catch — the P1 guard)
 * without depending on the real `ContextResolver` (T2b) or its ports (T2d).
 */
class FakeMentionResolver implements MentionResolverLike {
  calls: ContextRef[][] = [];
  private impl: (refs: ContextRef[]) => Promise<ResolvedContext[]> = async () => [];

  setImpl(impl: (refs: ContextRef[]) => Promise<ResolvedContext[]>): void {
    this.impl = impl;
  }

  async resolveAll(refs: ContextRef[]): Promise<ResolvedContext[]> {
    this.calls.push(refs);
    return this.impl(refs);
  }
}

/** Like {@link makeBackend}, but constructs `AcpBackend` with an injected
 * {@link FakeCheckpointTracker} (and, T2c, an optional {@link MentionResolverLike}). */
function makeBackendWithCheckpoints(mentionResolver?: MentionResolverLike): {
  backend: AcpBackend;
  client: FakeAcpClient;
  messages: HostToWebviewMessage[];
  tracker: FakeCheckpointTracker;
} {
  const config: HermesRuntimeConfig = {};
  const tracker = new FakeCheckpointTracker();
  const backend = new AcpBackend(config, undefined, undefined, tracker, undefined, mentionResolver);
  const client = new FakeAcpClient();
  seam(backend).client = client;
  seam(backend).sessionId = 'session-1';

  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((msg) => messages.push(msg));

  return { backend, client, messages, tracker };
}

describe('AcpBackend.invokeControl — Zone S reshaping seam', () => {
  it("reshapes tools.list's raw tui_gateway result into ToolsData for BOTH the panel.data push and the resolved value (A#6: PanelFetchOutcome.result was collapsed — the resolved value is now the reshaped snapshot, not the raw RPC result)", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    const raw = {
      toolsets: [
        {
          name: 'hermes-acp',
          tool_count: 1,
          enabled: true,
          tools: [{ name: 'read_file', description: 'Read a file from the workspace.' }],
        },
      ],
    };
    control.setNextResult(raw);

    const result = await backend.invokeControl('panel.data',{ panel: 'tools' });

    // The RPC actually dispatched is the panel's canonical tui_gateway method.
    expect(control.dispatchCalls).toEqual([
      { method: 'tools.list', params: { panel: 'tools' } },
    ]);

    // The emitted push is the RESHAPED ToolsData (camelCase
    // `toolCount`/`toolset`/`kind`/`source`) — never the raw snake_case
    // tui_gateway shape. This is what `ToolsPanel.tsx` actually renders.
    const expectedPanelData = {
      toolsets: [{ name: 'hermes-acp', enabled: true, toolCount: 1 }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace.',
          enabled: true,
          kind: 'read',
          toolset: 'hermes-acp',
          source: 'core',
        },
      ],
    };

    // A#6: the resolved value is now the SAME reshaped snapshot (the old raw
    // `result` split was dead weight — `fetchPanel` ignored it).
    expect(result).toEqual(expectedPanelData);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'tools', data: expectedPanelData }]);
  });

  // `sessions` used to no-op here (no control-plane RPC backed it) — Zone HIST
  // wired a real ACP-channel fetch for it (`refreshSessionsPanel`, tested in
  // "AcpBackend.invokeControl — Zone HIST: sessions panel refresh" below),
  // so that placeholder assertion no longer holds and was replaced there.
});

/**
 * Tier-2 T-12 ("fetchPanelData stale-overwrite"): `ControlDispatcher
 * .fetchPanelData` used to push whatever it fetched unconditionally, with no
 * regard for whether a NEWER fetch for the same panel/scope had since been
 * issued. Two overlapping fetches for the same panel racing to resolve OUT
 * OF ORDER (the older one settling last) let the STALE data silently
 * overwrite the fresher, already-rendered push. Fix: a per-scope sequence
 * token (the `SessionController.setModel`/`modelSwitchSeq` idiom) — a
 * resolution whose token is no longer the latest for its scope drops its
 * PUSH (the caller's own correlated return value is untouched — only the
 * broadcast push has the overwrite hazard).
 */
describe('AcpBackend.invokeControl — T-12: fetchPanelData drops a stale resolution\'s push', () => {
  it('RED: an older fetch resolving AFTER a newer fetch for the SAME panel does not overwrite the fresher panel.data push', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);

    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    control.setDeferredFor('tools.list', older.promise);
    control.setDeferredFor('tools.list', newer.promise);

    const rawStale = { toolsets: [{ name: 'stale-set', tool_count: 0, enabled: true, tools: [] }] };
    const rawFresh = { toolsets: [{ name: 'fresh-set', tool_count: 0, enabled: true, tools: [] }] };

    // Two overlapping fetches for the SAME panel: the FIRST-issued call is
    // the one that resolves LAST (the "older/slow" fetch), the SECOND-issued
    // call resolves FIRST (the "newer/fast" fetch) — exactly the real
    // "user re-opens/refreshes the panel while a fetch is still in flight"
    // race.
    const first = backend.invokeControl('panel.data', { panel: 'tools' });
    const second = backend.invokeControl('panel.data', { panel: 'tools' });

    // The NEWER (second-issued) fetch resolves FIRST — its push lands.
    newer.resolve(rawFresh);
    await second;

    // THEN the OLDER (first-issued, now-stale) fetch resolves belatedly.
    older.resolve(rawStale);
    await first;

    const pushes = messages.filter(
      (m): m is Extract<HostToWebviewMessage, { type: 'panel.data'; panel: 'tools' }> =>
        m.type === 'panel.data' && m.panel === 'tools',
    );
    // Fails today: BOTH resolutions push unconditionally, so the belated
    // stale resolution emits a SECOND push that overwrites the fresher one
    // already rendered — the last push carries 'stale-set', not 'fresh-set'.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.data.toolsets[0]?.name).toBe('fresh-set');

    // The STALE fetch's own caller is still answered honestly (its own
    // correlated return value is untouched by the push-staleness gate) —
    // only the BROADCAST push is dropped.
    const staleResult = (await first) as { toolsets: Array<{ name: string }> };
    expect(staleResult.toolsets[0]?.name).toBe('stale-set');
  });

  it('a normal single fetch (no race) still pushes exactly once, unaffected by the staleness gate', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setNextResult({ toolsets: [{ name: 'only-set', tool_count: 0, enabled: true, tools: [] }] });

    await backend.invokeControl('panel.data', { panel: 'tools' });

    const pushes = messages.filter((m) => m.type === 'panel.data' && m.panel === 'tools');
    expect(pushes).toHaveLength(1);
  });
});

describe('AcpBackend.invokeControl — Zone CFG: skills panel refresh', () => {
  it("dispatches skills.manage with an injected action:'list' param (the panel-refresh RPC needs more than just {panel})", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setNextResult({ skills: { coding: ['python-debug'] } });

    const result = await backend.invokeControl('panel.data',{ panel: 'skills' });

    expect(control.dispatchCalls).toEqual([
      { method: 'skills.manage', params: { panel: 'skills', action: 'list' } },
    ]);
    // A#6: the resolved value is the RESHAPED SkillsData (same as the push), not
    // the raw `{skills:{...}}` grouping.
    const expectedSkills = {
      skills: [
        { id: 'python-debug', name: 'python-debug', category: 'coding', description: '', enabled: true },
      ],
      categories: ['coding'],
    };
    expect(result).toEqual(expectedSkills);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'skills', data: expectedSkills }]);
  });
});

describe('AcpBackend.invokeControl — Zone CFG: MCP-hub panel refresh (multi-RPC join)', () => {
  it("switchTab('mcp') joins config.get({key:'full'}) + tools.list into McpData (no single RPC covers this — contracts-tui-gateway.md §3 GAPS #1)", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setResultFor('config.get', {
      mcp_servers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      },
    });
    control.setResultFor('tools.list', {
      toolsets: [{ name: 'filesystem', tool_count: 4, enabled: true, tools: [] }],
    });

    const result = await backend.invokeControl('panel.data',{ panel: 'mcp' });

    expect(control.dispatchCalls).toEqual([
      { method: 'config.get', params: { key: 'full' } },
      { method: 'tools.list', params: {} },
    ]);
    const expected = {
      servers: [
        { id: 'filesystem', name: 'filesystem', status: 'connected', command: 'npx -y @modelcontextprotocol/server-filesystem /tmp', toolCount: 4 },
      ],
    };
    expect(result).toEqual(expected);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'mcp', data: expected }]);
  });

  it('a direct reload.mcp call still dispatches through (Retry/Reload buttons) and re-fetches the mcp panel once the reload actually confirms', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setResultFor('reload.mcp', { status: 'reloaded' });
    control.setResultFor('config.get', { mcp_servers: {} });
    control.setResultFor('tools.list', { toolsets: [] });

    const result = await backend.invokeControl('reload.mcp', { confirm: true });

    expect(result).toEqual({ status: 'reloaded' });
    // The reload RPC itself, then the follow-up 2-RPC mcp refresh.
    expect(control.dispatchCalls.map((c) => c.method)).toEqual([
      'reload.mcp',
      'config.get',
      'tools.list',
    ]);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'mcp', data: { servers: [] } }]);
  });

  it('a reload.mcp call that only returns confirm_required does NOT re-fetch the mcp panel (nothing changed yet)', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setResultFor('reload.mcp', { status: 'confirm_required', message: 'confirm?' });

    const result = await backend.invokeControl('reload.mcp', {});

    expect(result).toEqual({ status: 'confirm_required', message: 'confirm?' });
    expect(control.dispatchCalls.map((c) => c.method)).toEqual(['reload.mcp']);
    expect(messages).toEqual([]);
  });
});

/**
 * Builds an `AcpBackend` wired for `start()` to run end-to-end against
 * fakes: `hermesPath` is set so `resolveHermes` skips its stubbed
 * (`notImplemented`) OS lookup, the injected `createClient` factory hands
 * back a `FakeAcpClient` (capturing every `newSession` call) instead of
 * spawning a real `hermes acp` child, and the private `control` field is
 * swapped for a `FakeControlChannel` (same escape hatch the other describe
 * blocks use) so `start()`'s `await this.control.start()` resolves
 * immediately instead of spawning `tui_gateway`.
 */
function makeStartableBackend(
  configOverrides?: Partial<HermesRuntimeConfig>,
  mutateClient?: (client: FakeAcpClient, index: number) => void,
): {
  backend: AcpBackend;
  clients: FakeAcpClient[];
} {
  const config: HermesRuntimeConfig = { hermesPath: '/fake/hermes', ...configOverrides };
  const clients: FakeAcpClient[] = [];
  const createClient: AcpClientFactory = (options) => {
    const client = new FakeAcpClient(options);
    mutateClient?.(client, clients.length);
    clients.push(client);
    return client;
  };
  const backend = new AcpBackend(config, undefined, createClient);
  seam(backend).control = new FakeControlChannel();
  return { backend, clients };
}

const fakeMcpServer: AcpMcpServerStdio = {
  name: 'codebase_search',
  command: '/fake/electron-node',
  args: ['/fake/dist/mcp/codebase-server.js'],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'HERMES_INDEX_DIR', value: '/ws/.hermes/index' },
    { name: 'HERMES_EMBED_ENDPOINT', value: 'http://127.0.0.1:11434' },
    { name: 'EMBED_MODEL', value: 'qwen3-embedding:0.6b' },
    { name: 'HERMES_EMBED_DIMS', value: '768' },
  ],
};

/** Discriminates an `AcpMcpServer` union member by the PRESENCE of `type`
 * (stdio has none — see `AcpMcpServerStdio`'s doc in `acpClient.ts`), the
 * same discriminant `setMcpServer`/`AcpBackend` rely on. */
function isStdioServer(server: AcpMcpServer): server is AcpMcpServerStdio {
  return !('type' in server);
}

describe('AcpBackend.start — Zone RAG: codebase_search MCP server registration', () => {
  it('includes the codebase_search entry (correct McpServerStdio shape, env as a {name,value}[] list) when set via setMcpServer', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);

    await backend.start();

    expect(clients).toHaveLength(1);
    expect(must(clients[0]).newSessionCalls).toHaveLength(1);
    expect(must(must(clients[0]).newSessionCalls[0]).mcpServers).toEqual([fakeMcpServer]);
    // `env` is a LIST of {name,value} pairs, not a dict — assert the shape directly.
    const [entry] = must(must(clients[0]).newSessionCalls[0]).mcpServers ?? [];
    expect(entry !== undefined && isStdioServer(entry) && Array.isArray(entry.env)).toBe(true);
    expect(entry !== undefined && isStdioServer(entry) ? entry.env : []).toContainEqual({
      name: 'HERMES_INDEX_DIR',
      value: '/ws/.hermes/index',
    });
  });

  it('omits codebase_search from session/new when RAG is inactive/untrusted (setMcpServer never called)', async () => {
    const { backend, clients } = makeStartableBackend();

    await backend.start();

    expect(must(must(clients[0]).newSessionCalls[0]).mcpServers).toEqual([]);
  });

  it('re-sends codebase_search on a subsequent session/new (the "New Session" / resume-equivalent re-init) — ACP does not retain it', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);

    await backend.start(); // initial session
    await backend.start(); // talaria.newSession / trust-upgrade re-init

    expect(clients).toHaveLength(2);
    expect(must(must(clients[0]).newSessionCalls[0]).mcpServers).toEqual([fakeMcpServer]);
    expect(must(must(clients[1]).newSessionCalls[0]).mcpServers).toEqual([fakeMcpServer]);
  });

  it('setMcpServer("codebase_search", undefined) clears a previously-registered server on the next session/new', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);
    await backend.start();

    backend.setMcpServer('codebase_search', undefined);
    await backend.start();

    expect(must(must(clients[0]).newSessionCalls[0]).mcpServers).toEqual([fakeMcpServer]);
    expect(must(must(clients[1]).newSessionCalls[0]).mcpServers).toEqual([]);
  });
});

/** A literal `AcpMcpServerHttp` fixture — the W3 LIB `vscode_lsp` advertisement
 * shape `LibServerHost.advertisement()` produces (research doc §4.4). */
const fakeHttpMcpServer: AcpMcpServerHttp = {
  type: 'http',
  name: 'vscode_lsp',
  url: 'http://127.0.0.1:51234/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer TESTTOKEN' }],
};

/** Find an `AcpMcpServer` entry by wire `name`, order-independent — the
 * membership-not-order assertion style §4.4 requires (order depends on
 * RAG's async callback vs LIB init timing and would be flaky). */
function findByName(servers: AcpMcpServer[] | undefined, name: string): AcpMcpServer | undefined {
  return servers?.find((s) => s.name === name);
}

/** Same as {@link isStdioServer}, inverted — narrows to the http variant by
 * the presence of `type` (the discriminant `AcpBackend`'s Map relies on). */
function isHttpServer(server: AcpMcpServer): server is AcpMcpServerHttp {
  return 'type' in server;
}

/** Find the http-variant entry by name, pre-narrowed to `AcpMcpServerHttp` —
 * avoids a type assertion at every call site. */
function findHttpEntry(servers: AcpMcpServer[] | undefined, name: string): AcpMcpServerHttp | undefined {
  const entry = findByName(servers, name);
  return entry !== undefined && isHttpServer(entry) ? entry : undefined;
}

/** Extract the `Authorization` header's value from an http entry. */
function authHeaderValue(server: AcpMcpServerHttp): string | undefined {
  return server.headers.find((h) => h.name === 'Authorization')?.value;
}

/** Fails the test loudly (rather than a silent `!`/`as` narrowing) when an
 * expected http entry is missing from a captured `mcpServers` call. */
function requireHttpEntry(entry: AcpMcpServerHttp | undefined): AcpMcpServerHttp {
  if (entry === undefined) throw new Error('expected an AcpMcpServerHttp entry, found none');
  return entry;
}

describe('AcpBackend.setMcpServer — W3 T3: Map-based multi-server advertisement + stable-value contract', () => {
  it('advertises both codebase_search (stdio) and vscode_lsp (http) on session/new — membership + exact http shape pinned (order-independent)', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);
    backend.setMcpServer('vscode_lsp', fakeHttpMcpServer);

    await backend.start();

    const sent = must(must(clients[0]).newSessionCalls[0]).mcpServers;
    expect(sent).toHaveLength(2);
    expect(findByName(sent, 'codebase_search')).toEqual(fakeMcpServer);
    expect(findByName(sent, 'vscode_lsp')).toEqual(fakeHttpMcpServer);
  });

  it('setMcpServer throws on key/name drift (critic A finding 7) and leaves the map unmutated', async () => {
    const { backend, clients } = makeStartableBackend();

    expect(() => backend.setMcpServer('wrong_key', fakeHttpMcpServer)).toThrow(
      /wrong_key.*vscode_lsp/,
    );

    await backend.start();

    // Not registered under 'wrong_key' NOR under its own 'vscode_lsp' name —
    // the throw happened before any `.set()`, so the map is untouched.
    expect(must(must(clients[0]).newSessionCalls[0]).mcpServers).toEqual([]);
  });

  it('setMcpServer(name, undefined) deletes only that entry — the other survives', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);
    backend.setMcpServer('vscode_lsp', fakeHttpMcpServer);

    backend.setMcpServer('vscode_lsp', undefined);
    await backend.start();

    expect(must(must(clients[0]).newSessionCalls[0]).mcpServers).toEqual([fakeMcpServer]);

    backend.setMcpServer('codebase_search', undefined);
    backend.setMcpServer('vscode_lsp', fakeHttpMcpServer);
    await backend.start();

    expect(must(must(clients[1]).newSessionCalls[0]).mcpServers).toEqual([fakeHttpMcpServer]);
  });

  it('the http entry’s url + Authorization header are byte-identical across a simulated respawn (start→teardown→start) AND across start()→loadSession() — regression lock on delta #1', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);
    backend.setMcpServer('vscode_lsp', fakeHttpMcpServer);

    await backend.start(); // first boot
    await backend.start(); // simulated respawn: startInternal() tears down the previous client first

    expect(clients).toHaveLength(2);
    const bootHttp = requireHttpEntry(findHttpEntry(must(must(clients[0]).newSessionCalls[0]).mcpServers, 'vscode_lsp'));
    const respawnHttp = requireHttpEntry(findHttpEntry(must(must(clients[1]).newSessionCalls[0]).mcpServers, 'vscode_lsp'));
    expect(respawnHttp.url).toBe(bootHttp.url);
    expect(authHeaderValue(respawnHttp)).toBe(authHeaderValue(bootHttp));

    // start() -> loadSession(), driven on the SAME (post-respawn) client —
    // `invokeControl('session.load', ...)` routes through `this.client`,
    // i.e. `clients[1]`.
    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });
    const loadHttp = requireHttpEntry(findHttpEntry(must(must(clients[1]).loadSessionCalls[0]).mcpServers, 'vscode_lsp'));
    expect(loadHttp.url).toBe(respawnHttp.url);
    expect(authHeaderValue(loadHttp)).toBe(authHeaderValue(respawnHttp));
  });
});

describe('AcpBackend.start — R-A6: subscribes to the ACP child exit seam', () => {
  it('start() registers exactly one onExit handler on the live client', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    expect(must(clients[0]).exitHandlers).toHaveLength(1);
  });
});

describe('AcpBackend.start — P0: overlapping start() calls are serialized (no orphaned child / double subscription)', () => {
  it('two concurrent (un-awaited) start() calls never interleave — exactly one live, supervised client survives', async () => {
    const { backend, clients } = makeStartableBackend();

    // Deliberately NOT awaited between calls — the autonomous respawn timer +
    // a user action (e.g. New Session) racing each other is exactly this
    // shape: two start() bodies fired back to back with no await in between.
    const p1 = backend.start();
    const p2 = backend.start();
    await Promise.all([p1, p2]);

    expect(clients).toHaveLength(2); // both bodies ran (nothing was dropped)

    // Exactly one client ends up supervised (a live `onExit` subscription).
    // teardownSession() disposes the PREVIOUS client's exit subscription
    // before a new one is created, so a torn-down client's exitHandlers is
    // empty; a serialized start() therefore leaves exactly one client with
    // exitHandlers.length === 1 (no orphan left supervising nothing AND no
    // double subscription on the survivor).
    const exitHandlerCounts = clients.map((c) => c.exitHandlers.length);
    expect(exitHandlerCounts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(exitHandlerCounts.filter((n) => n === 1)).toHaveLength(1);
  });

  it('the existing sequential start();start() pattern still tears the old client down and supervises only the new one', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    await backend.start();

    expect(clients).toHaveLength(2);
    expect(must(clients[0]).exitHandlers).toHaveLength(0); // torn down by the 2nd start()
    expect(must(clients[1]).exitHandlers).toHaveLength(1); // the live, supervised session
  });

  it('M1: inFlightStart resets to undefined once the chain settles (idle after start() resolves)', async () => {
    const { backend } = makeStartableBackend();

    await backend.start();

    // The self-cleanup guard compares `this.inFlightStart === run` by
    // identity; if `inFlightStart` were ever assigned a `.finally()`-derived
    // promise (a NEW object) instead of `run` itself, this comparison would
    // never match and `inFlightStart` would stay set forever after the first
    // call — silently serializing every later start() behind a resolved-but-
    // never-cleared tail (harmless for correctness here since the tail is
    // already resolved, but proves the guard is dead code).
    expect(seam(backend).inFlightStart).toBeUndefined();
  });

  // W6-FI-c Part 3 (FI-b review m1 — pre-existing coverage gap): a REAL
  // 3-generation inFlightStart race. FI-b's reviewer found that removing the
  // `runOnStartTail` identity-compare guard (`if (this.inFlightStart ===
  // run) this.inFlightStart = undefined;`, ConnectionSupervisor.ts) failed
  // NO existing test at the time, yet crashes on removal — the 2-generation
  // test above can't catch it because there is no THIRD start() arriving
  // while the SECOND generation's tail is still current. This test closes
  // that gap permanently.
  it('W6-FI-c Part 3: a 3-generation start() race (p1; p2; await p1; p3; await[p2,p3]) still serializes — exactly one supervised client survives', async () => {
    const { backend, clients } = makeStartableBackend();

    // Generation 1 and 2 fired back-to-back (no await in between) — p2
    // chains onto p1's tail (`inFlightStart`), exactly like the 2-generation
    // test above.
    const p1 = backend.start();
    const p2 = backend.start();
    // Let generation 1 settle. Generation 2's body may or may not have
    // started yet by the time this resolves — either way, `inFlightStart`
    // must still be p2's `run` here (the identity-compare guard must NOT
    // have let generation 1's `.finally()` clear a tail it no longer owns).
    await p1;
    // Generation 3 arrives WHILE generation 2 is (or is about to be) the
    // CURRENT tail — it must chain onto generation 2, never onto a
    // wrongly-reset `undefined` (which would let 2 and 3 run concurrently,
    // interleaving `this.client`/`clientExitSub` writes — the exact
    // "Cannot read properties of undefined (reading 'onExit')"-class crash
    // the reviewer traced).
    const p3 = backend.start();
    await Promise.all([p2, p3]);

    // Every generation's body ran serially (nothing was dropped or merged).
    expect(clients).toHaveLength(3);

    // Exactly ONE client ends up supervised — the same invariant the
    // 2-generation test above proves, extended to 3 generations. If the
    // guard were broken, generation 2 and 3 could run concurrently and BOTH
    // end up (or neither cleanly end up) supervised — a 2nd live child.
    const exitHandlerCounts = clients.map((c) => c.exitHandlers.length);
    expect(exitHandlerCounts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(exitHandlerCounts.filter((n) => n === 1)).toHaveLength(1);
  });
});

/** Reaches past `private` to read the ACP-channel lifecycle state machine. */
function acpStateOf(backend: AcpBackend): string {
  return (backend as unknown as { connectionSupervisor: { acpState: string } }).connectionSupervisor.acpState;
}

describe('AcpBackend.start — W4-T1b F2: connection/session phase split (critic pin F2)', () => {
  it('the connection reaches ready even when the initial session fails to establish — surfaces via system.error, start() does not reject', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client) => {
      client.failNextNewSession(new Error('Hermes refused the cwd'));
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await expect(backend.start()).resolves.toBeUndefined(); // does NOT reject

    expect(clients).toHaveLength(1);
    expect(must(clients[0]).exitHandlers).toHaveLength(1); // the connection is supervised
    expect(acpStateOf(backend)).toBe('ready'); // NOT 'idle' — the connection itself is healthy
    expect(messages).toEqual([
      { type: 'system.error', message: expect.stringContaining('Hermes refused the cwd') },
    ]);
  });

  it('a subsequent start() retries and succeeds once the session establishes normally (the failed session did not poison the connection)', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) client.failNextNewSession(new Error('Hermes refused the cwd'));
    });
    await backend.start(); // connection ready, initial session failed
    await backend.start(); // an explicit restart — new child, session succeeds this time

    expect(clients).toHaveLength(2);
    expect(must(clients[1]).newSessionCalls).toHaveLength(1);
    expect(acpStateOf(backend)).toBe('ready');
  });

  describe('a session-establish failure DURING a respawn does not loop the whole child', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a crash whose respawn session-establish fails still counts as a HEALTHY reconnect (attempts reset, no infinite full-child respawn loop over one bad session)', async () => {
      // W4-T5a: a respawn re-`session/load`s the crashed session (recovery)
      // rather than minting a fresh one via session/new — so a "session-
      // establish failure during a respawn" is now a FAILED LOAD, and it
      // surfaces as THAT tab's session-lost affordance (not a connection-
      // global system.error) — the connection itself stays healthy either way.
      const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
        if (index === 1) {
          client.loadSession = async () => {
            throw new Error('Hermes refused the cwd');
          };
        }
      });
      await backend.start();
      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));

      must(clients[0]).simulateExit(1); // crash -> 'respawning', backoff attempt 1 scheduled (500ms)
      await vi.advanceTimersByTimeAsync(500);

      expect(clients).toHaveLength(2); // exactly ONE respawn child for this attempt — no loop
      expect(must(clients[1]).exitHandlers).toHaveLength(1); // the reconnected child is supervised
      expect(acpStateOf(backend)).toBe('ready'); // not stuck in 'respawning'/'idle'
      expect(messages.some((m) => m.type === 'error' && /refused the cwd/.test((m as { message: string }).message))).toBe(
        true,
      );
      expect(
        messages.some((m) => m.type === 'tab.error' && (m as { kind?: string }).kind === 'session-lost'),
      ).toBe(true);

      // A SECOND crash on this same (session-less but healthy) child restarts
      // the backoff schedule from attempt 1 (500ms) — proof the failed
      // session establish was NOT counted as a failed respawn ATTEMPT (which
      // would have kept the backoff escalating / looped another child sooner).
      messages.length = 0;
      must(clients[1]).simulateExit(1);
      expect(clients).toHaveLength(2); // no immediate second spawn — the backoff is honored
      await vi.advanceTimersByTimeAsync(500);
      expect(clients).toHaveLength(3);
    });
  });

  describe('no second child ever spawns while acpState is respawning', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('an explicit start() during the backoff WINDOW (timer pending, not yet fired) cancels the stale backoff and spawns exactly ONE new child', async () => {
      const { backend, clients } = makeStartableBackend();
      await backend.start();
      must(clients[0]).simulateExit(1); // 'respawning', backoff timer pending (not fired)
      expect(clients).toHaveLength(1);

      // Simulates a future tab.open-style caller reconnecting eagerly, ahead
      // of the scheduled backoff (e.g. the user manually retries).
      await backend.start();

      expect(clients).toHaveLength(2); // exactly one new child from the explicit start()
      expect(acpStateOf(backend)).toBe('ready');

      // The STALE scheduled backoff timer must never ALSO fire a duplicate.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clients).toHaveLength(2); // still just the one — no orphaned duplicate respawn
    });
  });
});

/**
 * T8 (beta.5 setup-hardening §2.3, bug ⑧): the `[object Object]`
 * session-start banner is replaced by a STRUCTURAL no-provider route.
 *
 * Detection is structural, not textual (critic C-5): the Hermes adapter
 * (`acp_adapter/session.py:652-654`) SWALLOWS `resolve_runtime_provider`
 * failures (`except Exception: logger.debug(...)`), so the AuthError texts
 * never reliably reach the wire. At `establishInitialSession`-failure time
 * the supervisor instead consults the injected `isProviderUnconfigured`
 * thunk — wired by `AcpBackend` to `computeProviderCard(
 * getAdvertisedAuthMethods()).phase === 'unconfigured'`, the SAME source
 * the Setup Provider card reads — with `isAuthRequiredError` (`-32000`) as
 * a supplement only. The real error text (`describeError`) is ALWAYS
 * appended, so the routed branch can never hide it.
 */
describe('ConnectionSupervisor/AcpBackend — T8 (§2.3 ⑧): structural no-provider banner at session-establish failure', () => {
  /** §6 copy, VERBATIM (docs_claude/beta5-setup-hardening-architecture.md:451). */
  const NO_PROVIDER_BANNER =
    'Hermes has no chat provider configured. Open Setup → Provider → "Configure provider", then try again.';

  it('provider UNCONFIGURED (only hermes-setup advertised) + a raw NON-auth rejection ({code:-32603}) ⇒ the pinned copy WITH the real detail appended (structural detection alone routes it)', async () => {
    const { backend } = makeStartableBackend(undefined, (client) => {
      client.advertisedAuthMethods = [{ id: 'hermes-setup', name: 'Hermes setup wizard' }];
      client.failNextNewSession({
        code: -32603,
        message: 'Internal error',
        data: { details: 'runtime provider resolution failed' },
      });
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await expect(backend.start()).resolves.toBeUndefined();

    expect(messages.filter((m) => m.type === 'system.error')).toEqual([
      {
        type: 'system.error',
        message: `${NO_PROVIDER_BANNER} (Internal error (runtime provider resolution failed))`,
      },
    ]);
  });

  it('provider CONFIGURED (a managed method advertised) + a raw JSON-RPC object rejection ⇒ "Failed to start…" with the REAL text — never "[object Object]" (the ⑧ regression)', async () => {
    const { backend } = makeStartableBackend(undefined, (client) => {
      client.advertisedAuthMethods = [
        { id: 'openrouter', name: 'openrouter runtime credentials' },
        { id: 'hermes-setup', name: 'Hermes setup wizard' },
      ];
      client.failNextNewSession({ code: -32603, message: 'Internal error', data: { details: 'boom' } });
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    const errors = messages.filter((m) => m.type === 'system.error');
    expect(errors).toEqual([
      { type: 'system.error', message: 'Failed to start a Hermes session: Internal error (boom)' },
    ]);
    for (const error of errors) expect(JSON.stringify(error)).not.toContain('[object Object]');
  });

  it('the -32000 authRequired SUPPLEMENT routes to the pinned copy even when the structural signal reads configured', async () => {
    const { backend } = makeStartableBackend(undefined, (client) => {
      client.advertisedAuthMethods = [
        { id: 'openrouter', name: 'openrouter runtime credentials' },
        { id: 'hermes-setup', name: 'Hermes setup wizard' },
      ];
      client.failNextNewSession({ code: -32000, message: 'Authentication required' });
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    expect(messages.filter((m) => m.type === 'system.error')).toEqual([
      { type: 'system.error', message: `${NO_PROVIDER_BANNER} (Authentication required)` },
    ]);
  });

  it('a port WITHOUT isProviderUnconfigured (optional member omitted) still routes -32000 to the pinned copy — the supplement works alone', async () => {
    const emitted: HostToWebviewMessage[] = [];
    const authRequired: unknown = { code: -32000, message: 'Authentication required' };
    const port: ConnectionSupervisorHostPort = {
      config: { hermesPath: '/fake/hermes' },
      createClient: (options) => new FakeAcpClient(options),
      callbacks: {
        onSessionUpdate: () => {},
        onRequestPermission: () => Promise.reject(new Error('unused in this test')),
        onReadTextFile: () => Promise.reject(new Error('unused in this test')),
      },
      setCwd: () => {},
      getActiveSessionId: () => undefined,
      setActiveSessionId: () => {},
      sessions: new SessionRegistry(),
      startControl: async () => {},
      buildSessionPort: () => {
        throw new Error('unused in this test');
      },
      openSession: async () => {
        throw authRequired;
      },
      getMcpServers: () => [],
      announceSessionBound: () => {},
      warmCheckpointBaseline: () => {},
      settleOneShot: () => {},
      resetSessionsAccumulation: () => {},
      isPendingClose: () => false,
      emit: (msg) => emitted.push(msg),
    };
    const supervisor = new ConnectionSupervisor(port);

    await supervisor.start();

    expect(emitted).toEqual([
      { type: 'system.error', message: `${NO_PROVIDER_BANNER} (Authentication required)` },
    ]);
  });

  it('host call sites thread the real home into redaction (S-3) — a home-dir path in the failure detail renders as ~', async () => {
    const home = os.homedir();
    const { backend } = makeStartableBackend(undefined, (client) => {
      client.failNextNewSession(new Error(`spawn failed: ${home}/.venvs/hermes/bin/python missing`));
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    expect(messages.filter((m) => m.type === 'system.error')).toEqual([
      {
        type: 'system.error',
        message: 'Failed to start a Hermes session: spawn failed: ~/.venvs/hermes/bin/python missing',
      },
    ]);
  });

  it('AcpBackend.openTab (the second ⑧ call site): a raw JSON-RPC rejection surfaces as tab.error with the real text, never "[object Object]"', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).failNextNewSession({ code: -32603, message: 'Internal error', data: { details: 'boom' } });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.openTab('tab-2');

    expect(messages).toEqual([
      { type: 'tab.error', tabId: 'tab-2', kind: 'open-failed', message: 'Internal error (boom)' },
    ]);
  });
});

/**
 * T-B1 (closes V-8): bounded proof that a promise SETTLES (resolves or
 * rejects) within ordinary microtask draining — lets a RED test proving a
 * "never settles" bug fail FAST via a normal assertion, instead of via
 * vitest's slow real-wall-clock per-test timeout (these hangs have no timer
 * attached pre-fix, so `vi.advanceTimersByTimeAsync` cannot unstick them).
 * Mirrors the repo's `hangNewSession` "prove the never-settles class"
 * precedent (the C1 describe block above) for a case with no built-in
 * timer-driven deadline to advance.
 */
function trackSettlement(p: Promise<unknown>): { settled(): boolean } {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

describe('AcpBackend.start — T-B1: connect-phase exit-race + deadline (closes V-8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a child that exits DURING initialize() rejects with an exited-during-startup error, and does not wedge the start() tail', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) client.initialize = () => new Promise<void>(() => {}); // never resolves
    });

    const startPromise = backend.start();
    const settlement = trackSettlement(startPromise);
    await flushMicrotasks();
    expect(clients).toHaveLength(1);
    expect(settlement.settled()).toBe(false); // still hanging in initialize()

    must(clients[0]).simulateExit(1);
    await flushMicrotasks();

    // RED (pre-fix): nothing un-jams `startInternal`'s unraced awaits —
    // `settlement.settled()` stays false forever (asserted here instead of
    // literally awaiting forever, mirroring the repo's `hangNewSession`
    // never-settles proof technique).
    expect(settlement.settled()).toBe(true);
    await expect(startPromise).rejects.toThrow(/exited during startup/);

    // Tail un-jammed: a SECOND start() with a healthy fake actually runs.
    await backend.start();
    expect(clients).toHaveLength(2);
    expect(acpStateOf(backend)).toBe('ready');
  });

  it('CF-01/I-1: a connect-phase failure disposes+clears the client — getClient() must not return the zombie transport', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) client.initialize = () => new Promise<void>(() => {}); // never resolves
    });

    const startPromise = backend.start();
    await flushMicrotasks();
    expect(clients).toHaveLength(1);

    must(clients[0]).simulateExit(1);
    await flushMicrotasks();
    await expect(startPromise).rejects.toThrow(/exited during startup/);

    // RED (pre-fix): the connect-phase catch (`startInternal`, :253-273)
    // resets `acpState` but never disposes/clears `this.client` — the
    // assignment made earlier (:221) survives the failure, leaving a zombie
    // transport. A later `openTab` would call `newSession()` on this dead
    // client and never settle, wedging `inFlightStart` forever behind a
    // permanent "reconnecting…". `getClient()` must return `undefined` once
    // the connect phase has failed, exactly as `handleAcpCrash` (:856-857)
    // already guarantees for a post-connection crash.
    expect(getSupervisorClient(backend)).toBeUndefined();
  });

  it('the connect-phase deadline fires when the connect phase hangs with no exit at all', async () => {
    const { backend } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) {
        client.connect = () => new Promise<void>(() => {});
        client.initialize = () => new Promise<void>(() => {});
      }
    });
    // W6-FI-b: `startControl()` routes through the injected FakeControlChannel
    // — hang it too, so ALL THREE connect-phase calls are unable to complete
    // (connect() alone already blocks the sequence; this is belt-and-braces
    // fidelity to "no matter which phase the child parks in").
    const control = seam(backend).control as { start(): Promise<void> };
    control.start = () => new Promise<void>(() => {});

    const startPromise = backend.start();
    const settlement = trackSettlement(startPromise);
    await flushMicrotasks();
    expect(settlement.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settlement.settled()).toBe(false); // not yet — still inside the 30s window

    await vi.advanceTimersByTimeAsync(1);

    // RED (pre-fix): no deadline mechanism exists at all — advancing fake
    // time does nothing, and `settlement.settled()` stays false forever.
    expect(settlement.settled()).toBe(true);
    await expect(startPromise).rejects.toThrow(/did not become ready/);
  });

  it('a child exit during the bootstrap openSession un-jams start() — resolves normally, handleAcpCrash owns recovery', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) client.hangNewSession();
    });

    const startPromise = backend.start();
    const settlement = trackSettlement(startPromise);
    await flushMicrotasks();
    expect(clients).toHaveLength(1);
    expect(settlement.settled()).toBe(false); // still hanging in newSession() (session/new)

    must(clients[0]).simulateExit(1);
    await flushMicrotasks();

    // RED (pre-fix): `establishInitialSession`'s un-raced
    // `await this.port.openSession(...)` never returns — `settlement.settled()`
    // stays false forever, even though `handleAcpCrash` (the connection-phase
    // :199 subscription, unaffected by this bug) fired on the SAME exit.
    expect(settlement.settled()).toBe(true);
    await expect(startPromise).resolves.toBeUndefined();

    // handleAcpCrash owns recovery: acpState is 'respawning', and the
    // backoff timer eventually spawns a fresh respawn child.
    expect(acpStateOf(backend)).toBe('respawning');
    await vi.advanceTimersByTimeAsync(500); // respawnBackoffMs(1)
    expect(clients).toHaveLength(2);
  });

  it('a connect-phase failure banners once on a fresh boot; a respawn-loop attempt failing the same way does NOT add a second banner (wasRespawning guard)', async () => {
    // Part 1 — fresh boot: a connect-phase failure DOES banner exactly once.
    {
      const { backend } = makeStartableBackend(undefined, (client) => {
        client.connectError = new Error('fresh boot broken');
      });
      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));

      await expect(backend.start()).rejects.toThrow(/fresh boot broken/);

      // RED (pre-fix): the connect-phase catch never emits system.error at
      // all (V-8's "no banner" bug) — this is `[]`, not length 1.
      expect(messages.filter((m) => m.type === 'system.error')).toEqual([
        { type: 'system.error', message: expect.stringContaining('fresh boot broken') },
      ]);
    }

    // Part 2 — respawn loop: a SECOND connect-phase failure (this time while
    // acpState is already 'respawning', i.e. handleAcpCrash already
    // bannered THIS outage) must not add a second banner on top of it — one
    // signal per outage, the same discipline handleAcpCrash itself already
    // has for repeated crashes.
    {
      const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
        if (index === 1) client.connectError = new Error('still broken on respawn');
      });
      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));

      await backend.start(); // client[0], healthy boot
      must(clients[0]).simulateExit(1); // crash -> ONE banner (handleAcpCrash, pre-existing), 'respawning'
      expect(messages.filter((m) => m.type === 'system.error')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500); // respawn attempt fires -> client[1].connect() rejects

      expect(messages.filter((m) => m.type === 'system.error')).toHaveLength(1); // still just the ONE
      expect(acpStateOf(backend)).toBe('respawning'); // outage continues, backoff loop intact
    }
  });
});

/**
 * T-3 (closes B1-M1): T-B1 already bounds `raceConnectPhase` (connect ->
 * initialize -> startControl) against a wall-clock deadline AND the child's
 * exit — but `establishInitialSession`'s bootstrap `session/new` and
 * `recoverOneSession`'s `session/load` only raced the child's own EXIT.
 * A child that stays ALIVE but never answers either RPC (a harness
 * deadlock, a stuck event loop) strands `inFlightStart` forever. These
 * tests prove the new `SESSION_ESTABLISH_DEADLINE_MS` (120s) closes that
 * gap on both legs, without disturbing the existing exit-race behavior.
 */
describe('AcpBackend.start — T-3 (closes B1-M1): session-establish wall-clock deadline (alive-but-hung session/new / session/load)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a hung bootstrap session/new (child stays ALIVE, no exit) settles at the deadline, fires ONE system.error, and un-jams the tail for a subsequent start()', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) client.hangNewSession();
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const startPromise = backend.start();
    const settlement = trackSettlement(startPromise);
    await flushMicrotasks();
    expect(clients).toHaveLength(1);
    expect(settlement.settled()).toBe(false); // still hanging in newSession() — the child never exits

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settlement.settled()).toBe(false); // not yet — still inside the 120s window

    await vi.advanceTimersByTimeAsync(1);

    // RED (pre-fix): only the child's own exit is raced for this leg — no
    // deadline mechanism exists at all, so advancing fake time does
    // nothing and settlement.settled() stays false forever.
    expect(settlement.settled()).toBe(true);
    await expect(startPromise).resolves.toBeUndefined(); // establishInitialSession never throws back out (F2)

    // Unlike the exit case (handleAcpCrash owns messaging), NOBODY has
    // bannered this outage yet — exactly ONE system.error for it, and the
    // connection itself stays 'ready' (only the session mint hung).
    expect(messages.filter((m) => m.type === 'system.error')).toEqual([
      { type: 'system.error', message: expect.stringContaining('did not respond') },
    ]);
    expect(acpStateOf(backend)).toBe('ready');

    // Tail un-jammed: a SECOND start() with a healthy fake actually runs.
    messages.length = 0;
    await backend.start();
    expect(clients).toHaveLength(2);
    expect(must(clients[1]).newSessionCalls).toHaveLength(1);
  });

  it('a belated bootstrap session/new resolution AFTER the deadline fires no tab.bound and disposes the orphaned session (best-effort session/close)', async () => {
    const resolver = deferred<{ sessionId: string; currentModeId: string }>();
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) {
        client.newSession = async (cwd: string, mcpServers?: AcpMcpServer[]) => {
          client.newSessionCalls.push({ cwd, mcpServers });
          return resolver.promise;
        };
      }
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const startPromise = backend.start();
    const settlement = trackSettlement(startPromise);
    await vi.advanceTimersByTimeAsync(120_000); // the deadline fires — session/new still hasn't answered

    // RED (pre-fix): no deadline exists for this leg — settlement stays
    // false forever, so this fails fast instead of hanging the test.
    expect(settlement.settled()).toBe(true);
    await startPromise;

    expect(messages.filter((m) => m.type === 'system.error')).toHaveLength(1);
    messages.length = 0;

    // The ORIGINAL session/new call was never cancelled (JS promises can't
    // be) — it now answers LATE, after ConnectionSupervisor already gave up
    // on this attempt.
    resolver.resolve({ sessionId: 'late-session', currentModeId: 'default' });
    await flushMicrotasks();

    // No tab.bound for an attempt nobody is waiting on anymore, and the
    // orphaned session is not left dangling, bound or unbound, in the registry.
    expect(messages.some((m) => m.type === 'tab.bound')).toBe(false);
    expect(hasController(backend, 'late-session')).toBe(false);
    expect(must(clients[0]).closeSessionCalls).toContain('late-session'); // best-effort session/close
  });

  it('recovery leg: one hung session/load times out to THAT tab\'s session-lost while the OTHER session still recovers (per-tab isolation holds)', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 1) {
        const original = client.loadSession.bind(client);
        client.loadSession = async (cwd: string, sessionId: string, mcpServers?: AcpMcpServer[]) => {
          if (sessionId === 'session-2') return new Promise<AcpLoadSessionResult>(() => {}); // never resolves, no exit
          return original(cwd, sessionId, mcpServers);
        };
      }
    });
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);
    messages.length = 0;
    await vi.advanceTimersByTimeAsync(500); // respawn fires -> recoverSessions attempts BOTH ids in order

    // session-1 (recovered FIRST — recoverSessions iterates in registration
    // order) resolves normally, well before session-2's deadline ever ticks.
    expect(messages).toContainEqual({
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'session-1',
      rootId: expect.any(String),
    });
    expect(hasController(backend, 'session-1')).toBe(true);

    // session-2 is still hung — no session-lost yet, well inside the window.
    expect(
      messages.some((m) => m.type === 'tab.error' && (m as { tabId?: string }).tabId === 'tab-2'),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000); // session-2's recovery deadline fires

    // RED (pre-fix): only the child's own exit is raced during recovery —
    // no exit is simulated here, so this message never appears.
    expect(messages).toContainEqual({
      type: 'tab.error',
      tabId: 'tab-2',
      kind: 'session-lost',
      message: expect.any(String),
    });
    expect(hasController(backend, 'session-2')).toBe(false);
  });

  it('fast path: the establish-deadline timer is cleared once session/new resolves normally (no stray timer, getTimerCount()===0)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    expect(clients).toHaveLength(1);
    expect(must(clients[0]).newSessionCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AcpClient — T-B1 step 1: spawn "error" fans out the SAME exit handlers as "exit" (Node docs: error may fire with NO exit at all)', () => {
  /** Same minimal fake `ChildProcess` as `acpClient.test.ts`/`acpClient.wire.test.ts`. */
  function makeFakeChildForAcpClient(): ChildProcess {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fake = Object.assign(new NodeEventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
      killed: false,
      exitCode: null,
    });
    return fake as unknown as ChildProcess;
  }

  const NOOP_ACP_CALLBACKS: AcpClientCallbacks = {
    onSessionUpdate: () => {},
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onReadTextFile: async () => '',
  };

  it('a child that emits ONLY "error" (no "exit") still fires onExit exactly once, with code null — and a LATER "exit" on the same child is suppressed (identity guard)', async () => {
    const child = makeFakeChildForAcpClient();
    vi.mocked(spawn).mockReturnValue(child);

    const client = new AcpClient({
      spawn: { command: 'hermes', args: ['acp'] },
      cwd: '/workspace',
      callbacks: NOOP_ACP_CALLBACKS,
    });
    await client.connect();

    const handler = vi.fn();
    client.onExit(handler);

    // Node child_process docs: 'error' may be emitted WITHOUT a following
    // 'exit' at all (e.g. the spawn itself failed) — pre-fix this left
    // `onExit` subscribers silently unnotified: no banner, no respawn.
    child.emit('error', new Error('spawn hermes ENOENT'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(null);

    // If a REAL child later ALSO emits 'exit' for the SAME process, the
    // identity guard (this.child nulled by whichever terminal event fires
    // FIRST) must suppress the duplicate notification.
    child.emit('exit', 1, null);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionSupervisor.establishInitialSession — T5 (UI I-2 / Q2, owner-ratified): system.recovered retires the outage banner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fresh successful bootstrap emits system.recovered (idempotent fold — no standing banner to retire)', async () => {
    const { backend } = makeStartableBackend();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    expect(messages).toContainEqual({ type: 'system.recovered' });
  });

  it('a FAILED bootstrap (session establish throws, catch path) does NOT emit system.recovered', async () => {
    const { backend } = makeStartableBackend(undefined, (client) => {
      client.failNextNewSession(new Error('Hermes refused the cwd'));
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    expect(messages.some((m) => m.type === 'system.recovered')).toBe(false);
    expect(messages).toContainEqual({
      type: 'system.error',
      message: expect.stringContaining('Hermes refused the cwd'),
    });
  });

  it('a successful post-crash recovery emits system.recovered — the outage banner retires', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(137); // crash -> 'respawning', system.error already fired for THIS outage
    await vi.advanceTimersByTimeAsync(500); // respawn fires, recoverSessions() re-loads session-1

    expect(messages).toContainEqual({ type: 'system.recovered' });
  });

  it('a post-crash recovery where the ONE session fails to reload still emits system.recovered — the CONNECTION outage is over even though that tab is session-lost', async () => {
    // Mirrors the F2 "session-establish failure during a respawn" scenario:
    // the connection itself recovers even though `recoverOneSession` could
    // not reload this particular session (announced separately via
    // tab.error{kind:'session-lost'}, T3's contract) — system.recovered
    // describes the CONNECTION-global condition, not any one tab's fate.
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 1) {
        client.loadSession = async () => {
          throw new Error('Hermes refused the cwd');
        };
      }
    });
    await backend.start();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);
    await vi.advanceTimersByTimeAsync(500);

    expect(messages).toContainEqual({ type: 'tab.error', tabId: BOOTSTRAP_TAB_ID, kind: 'session-lost', message: expect.any(String) });
    expect(messages).toContainEqual({ type: 'system.recovered' });
  });
});

describe('AcpBackend.openTab/closeTab — W4-T3b (§2d/§2e Deliverable 5): the real tab.open/tab.close entry points', () => {
  it('mints a fresh session and emits tab.bound{tabId, sessionId, rootId} for the requested tabId', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // boots the connection + the BOOTSTRAP_TAB_ID session
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    must(clients[0]).queueSessionId('session-2');

    await backend.openTab('tab-2');

    const bound = messages.find((m) => m.type === 'tab.bound');
    expect(bound).toMatchObject({ type: 'tab.bound', tabId: 'tab-2', sessionId: 'session-2' });
    expect((bound as { rootId: string }).rootId).toBeTruthy();
    expect(must(clients[0]).newSessionCalls).toHaveLength(2); // the boot session + this tab's
  });

  it('emits tab.error{kind:"open-failed"} instead of throwing when there is no live client', async () => {
    const config: HermesRuntimeConfig = {};
    const { AcpBackend: RealAcpBackend } = await import('./AcpBackend');
    const backend = new RealAcpBackend(config);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await expect(backend.openTab('tab-9')).resolves.toBeUndefined(); // never throws/rejects

    expect(messages).toEqual([
      { type: 'tab.error', tabId: 'tab-9', kind: 'open-failed', message: expect.any(String) },
    ]);
  });

  it('emits tab.error{kind:"open-failed"} when session/new itself rejects', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).failNextNewSession(new Error('Hermes refused the cwd'));
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.openTab('tab-2');

    expect(messages).toEqual([
      { type: 'tab.error', tabId: 'tab-2', kind: 'open-failed', message: expect.stringContaining('refused the cwd') },
    ]);
  });

  it('closeTab disposes only the named session\'s controller, leaving a sibling untouched', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 (BOOTSTRAP_TAB_ID)
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.closeTab('session-2');
    // CF-01/L3-1: closeTab now chains onto the SAME `inFlightStart` tail as
    // start/openTab/loadSessionIntoTab — the actual removal happens a few
    // microtask ticks later (once this call reaches the head of the tail),
    // not synchronously. Flush before relying on it having taken effect.
    await flushMicrotasks();

    // session-2's controller is gone (a sendPrompt for it is silently a
    // no-op — SessionRegistry.get returns undefined); session-1 is untouched.
    expect(() => backend.sendPrompt('session-2', 'hi', 'default')).not.toThrow();
    backend.sendPrompt('session-1', 'still alive', 'default');
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1); // only session-1's prompt reached the client
  });

  it('closeTab is a no-op for an unknown sessionId (a still-unbound tab closed before tab.open resolved)', async () => {
    const { backend } = makeStartableBackend();
    await backend.start();
    expect(() => backend.closeTab('never-existed')).not.toThrow();
  });
});

/**
 * CF-01/L3-1 fix (Important — 3-lens review): `closeTab` DEFERS the actual
 * registry removal onto the topology tail (see that method's own doc) —
 * while a close is queued but not yet run, the closed session stays LIVE in
 * the registry. These tests drive the two realized hazards the review found
 * in that deferral window and prove the SYNCHRONOUS `pendingClose` tombstone
 * closes both: (a) a crash landing in the window must not resurrect a
 * user-closed tab via `handleAcpCrash`'s `pendingRecovery` snapshot; (b) a
 * racing `sendPrompt` for the closing session must no-op, not start a turn.
 */
describe('AcpBackend.closeTab — CF-01/L3-1 fix (Important): the pendingClose tombstone gives SYNCHRONOUS visibility even though removal stays deferred', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closeTab(S) immediately followed by a crash excludes S from the respawn\'s recovery snapshot — no resurrection of a user-closed tab', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.closeTab('session-2'); // tombstoned SYNCHRONOUSLY; the actual removal is still queued on the tail
    // Sanity: the deferral window is real — the removal has not run yet.
    expect(hasController(backend, 'session-2')).toBe(true);

    must(clients[0]).simulateExit(1); // crash lands INSIDE the close's deferral window, before its tail link has a turn

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    await vi.advanceTimersByTimeAsync(500); // respawn fires -> recoverSessions runs

    // RED (pre-fix): session-2 was still in the LIVE registry the instant
    // handleAcpCrash snapshotted pendingRecovery — the respawn re-`session/
    // load`s it and re-binds 'tab-2', resurrecting a tab the user already
    // asked to close.
    expect(must(clients[1]).loadSessionCalls.map((c) => c.sessionId)).toEqual(['session-1']);
    expect(
      messages.some((m) => m.type === 'tab.bound' && (m as { sessionId?: string }).sessionId === 'session-2'),
    ).toBe(false);
    expect(hasController(backend, 'session-2')).toBe(false);
  });

  it('closeTab(S) followed immediately by sendPrompt(S) no-ops during the deferral window — no turn starts on a closing tab', async () => {
    const { backend, messages } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID

    backend.closeTab('session-1'); // tombstoned SYNCHRONOUSLY; the actual removal is still queued on the tail
    // Sanity: the deferral window is real.
    expect(hasController(backend, 'session-1')).toBe(true);

    // `SessionController.sendPrompt` emits `turn.start`/`user` and acquires
    // the root turn lease SYNCHRONOUSLY, before its first `await` — so this
    // is a non-racy proof-point (unlike `client.promptCallCount`, which
    // — even PRE-fix — can read back as 0 anyway once the deferred close's
    // own `dispose()` reaches `this.currentTurnId = undefined` first and
    // trips `runTurnWithCheckpoint`'s post-checkpoint-await supersede guard;
    // that is accidental, timing-dependent masking, not the tombstone
    // working, and must not be mistaken for it).
    //
    // RED (pre-fix): sendPrompt still finds session-1 live in the registry
    // during this window and SYNCHRONOUSLY starts a turn (turn.start/user)
    // on a tab the user just closed, before any dispose() race can matter.
    backend.sendPrompt('session-1', 'hello', 'default');

    expect(messages.some((m) => m.type === 'turn.start')).toBe(false);
    expect(messages.some((m) => m.type === 'user')).toBe(false);
    expect(anyLiveTurnOnRoot(backend, '')).toBe(false); // the root turn lease was never acquired
  });

  it('the tombstone clears once the deferred close actually runs (not permanently stuck) — sendPrompt AFTER the window resolves normally on a fresh session reusing the tab', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.closeTab('session-2');
    await flushMicrotasks(); // let the deferred close actually run

    expect(hasController(backend, 'session-2')).toBe(false);

    // A later, unrelated session sharing no state with the closed one sends
    // normally — the tombstone did not leak past its own deferral window.
    must(clients[0]).queueSessionId('session-3');
    await backend.openTab('tab-3'); // session-3
    backend.sendPrompt('session-3', 'hi again', 'default');
    await flushMicrotasks();

    expect(must(clients[0]).promptCallCount).toBe(1);
  });
});

describe('AcpBackend.listTabs — W6-FF (3-way ARCH I-1): the live tab list TalariaViewProvider\'s hydrate payload reuses', () => {
  it('is empty before any session is established (a genuine cold boot — nothing live to reconcile)', () => {
    const { backend } = makeStartableBackend();
    expect(backend.listTabs()).toEqual([]);
  });

  it('returns every registered tab exactly once, with the SAME {sessionId, cwd, tabId} shape the crash-recovery snapshot itself captures, plus rootId', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // BOOTSTRAP_TAB_ID / session-1
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    const tabs = backend.listTabs();
    expect(tabs).toHaveLength(2);

    const byTab = Object.fromEntries(tabs.map((t) => [t.tabId, t]));
    expect(byTab[BOOTSTRAP_TAB_ID]).toMatchObject({ sessionId: 'session-1' });
    expect(byTab['tab-2']).toMatchObject({ sessionId: 'session-2' });
    // rootId is the SAME per-controller value tab.bound itself carries
    // (SessionController.getRootId()) — never a second, independently-derived id.
    expect(byTab[BOOTSTRAP_TAB_ID]?.rootId).toBe(controllerRootId(backend, 'session-1'));
    expect(byTab['tab-2']?.rootId).toBe(controllerRootId(backend, 'session-2'));
    expect(typeof byTab[BOOTSTRAP_TAB_ID]?.cwd).toBe('string');
    expect(byTab[BOOTSTRAP_TAB_ID]?.cwd.length).toBeGreaterThan(0);
  });

  it('drops a closed tab once its close settles on the topology tail (mirrors SessionRegistry.close\'s remove-before-dispose; CF-01/L3-1: no longer literally synchronous — see the sibling test above)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2');

    backend.closeTab('session-2');
    await flushMicrotasks(); // CF-01/L3-1: closeTab is now tail-queued, not synchronous

    expect(backend.listTabs().map((t) => t.tabId)).toEqual([BOOTSTRAP_TAB_ID]);
  });

  /** H4-B8 (arch report Minor-2): the seed's per-tab DISPLAY fields — each
   * entry surfaces THAT controller's OWN preset/currentModelId/
   * activeModeId/availableCommands, never another tab's (P-1 isolation),
   * sourced from `SessionController.getPreset()`/`currentModelId`/
   * `activeCustomModeId`/`getAvailableCommands()`. RED before the fix:
   * `listTabs()` returns only {tabId,sessionId,cwd,rootId} and these four
   * fields are `undefined` on every entry. */
  it('two registered controllers with DIFFERENT preset/model/mode/commands each surface their OWN values in their OWN seed entry', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // BOOTSTRAP_TAB_ID / session-1
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.setPreset('session-1', 'strict');
    backend.setPreset('session-2', 'plan');
    backend.setModel('session-1', 'model-a');
    backend.setModel('session-2', 'model-b');
    // ARCH-1 (final review, UI I-1) / T2: `SessionController.setModel` now
    // assigns `currentModelId` ONLY after its RPC resolves (never
    // unconditionally at call time), so the field settles one microtask
    // tick after the call returns — flush before reading it back.
    await flushMicrotasks();
    seamFor(backend, 'session-1').activeCustomModeId = 'mode-a';
    seamFor(backend, 'session-2').activeCustomModeId = 'mode-b';
    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'a-cmd', description: 'A only' }],
    });
    fireSessionUpdate(backend)('session-2', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'b-cmd', description: 'B only' }],
    });

    const byTab = Object.fromEntries(backend.listTabs().map((t) => [t.tabId, t]));

    expect(byTab[BOOTSTRAP_TAB_ID]).toMatchObject({
      sessionId: 'session-1',
      preset: 'strict',
      currentModelId: 'model-a',
      activeModeId: 'mode-a',
      availableCommands: [{ name: 'a-cmd', description: 'A only' }],
    });
    expect(byTab['tab-2']).toMatchObject({
      sessionId: 'session-2',
      preset: 'plan',
      currentModelId: 'model-b',
      activeModeId: 'mode-b',
      availableCommands: [{ name: 'b-cmd', description: 'B only' }],
    });
  });

  it('an entry for a controller that never set model/mode/commands carries preset (always defined) with the other three absent — never a ghost value from another tab', async () => {
    const { backend } = makeStartableBackend();
    await backend.start(); // BOOTSTRAP_TAB_ID / session-1 — nothing else set

    const [entry] = backend.listTabs();

    expect(entry).toMatchObject({ tabId: BOOTSTRAP_TAB_ID, sessionId: 'session-1', preset: 'manual' });
    expect(entry?.currentModelId).toBeUndefined();
    expect(entry?.activeModeId).toBeUndefined();
    expect(entry?.availableCommands).toBeUndefined();
  });
});

describe('SessionController.dispose — W4-T5b: best-effort session/close (named SDK method, P-W4-3 / Q-3)', () => {
  it('dispose() fires closeSession(sessionId) on the client when it exposes one', async () => {
    const { backend, client } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID

    backend.closeTab('session-1');
    await flushMicrotasks();

    expect(client.closeSessionCalls).toEqual(['session-1']);
  });

  it('is a no-op when the client does not expose closeSession (optional member — a client built before this deliverable, or one that never implements it)', async () => {
    const { backend } = makeBackend();
    // Swap in a client with NO `closeSession` at all.
    seam(backend).client = { cancel: async () => {} };

    expect(() => backend.closeTab('session-1')).not.toThrow();
    await flushMicrotasks();
  });

  it('a rejecting closeSession does NOT reject/leak out of dispose() (fire-and-forget, swallowed)', async () => {
    const { backend, client } = makeBackend();
    client.closeSessionError = new Error('boom: session/close failed');

    expect(() => backend.closeTab('session-1')).not.toThrow();
    // Let the rejected closeSession() promise settle — an unswallowed
    // rejection here would surface as an unhandled rejection failing this test.
    await flushMicrotasks();

    expect(client.closeSessionCalls).toEqual(['session-1']);
  });
});

describe('AcpBackend — R-A6: ACP child crash-respawn (ControlChannel machine cloned)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unexpected exit → ONE reconnecting error signal → respawn after 500ms re-runs start(): new client recovers the crashed session via session/load (mcpServers re-sent)', async () => {
    const { backend, clients } = makeStartableBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);
    await backend.start();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(137);

    expect(messages).toEqual([
      { type: 'system.error', message: expect.stringContaining('reconnecting') },
    ]);
    expect(clients).toHaveLength(1); // backoff pending, not immediate

    await vi.advanceTimersByTimeAsync(500); // respawnBackoffMs(1)

    expect(clients).toHaveLength(2);
    // W4-T5a (Q-10): respawn recovery re-`session/load`s the crashed
    // session — it does NOT mint a fresh one via session/new.
    expect(must(clients[1]).newSessionCalls).toEqual([]);
    expect(must(clients[1]).loadSessionCalls).toHaveLength(1);
    expect(must(must(clients[1]).loadSessionCalls[0]).mcpServers).toEqual([fakeMcpServer]);
    // exactly one reconnecting signal for the whole outage
    expect(messages.filter((m) => m.type === 'system.error')).toHaveLength(1);
    // the new client is supervised too
    expect(must(clients[1]).exitHandlers).toHaveLength(1);
  });

  it('failed respawn attempts back off exponentially (500 → 1000 → 2000) and a successful respawn resets the schedule', async () => {
    let failFrom = Number.POSITIVE_INFINITY;
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index >= failFrom) client.connectError = new Error('spawn ENOENT');
    });
    await backend.start();

    failFrom = 1; // every client from index 1 on fails to connect
    must(clients[0]).simulateExit(1);

    await vi.advanceTimersByTimeAsync(500); // attempt 1 fires, fails
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999); // attempt 2 not due yet (backoff 1000)
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // attempt 2 fires, fails
    expect(clients).toHaveLength(3);

    failFrom = Number.POSITIVE_INFINITY; // attempt 3 succeeds
    await vi.advanceTimersByTimeAsync(2000); // backoff(3)
    expect(clients).toHaveLength(4);

    // recovered → attempts reset: a NEW crash respawns after 500ms again
    must(clients[3]).simulateExit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(clients).toHaveLength(5);
  });

  it('dispose() cancels a pending respawn; nothing spawns afterwards', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).simulateExit(1);
    backend.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
  });

  it('an intentional restart (start()) detaches the old client — its late exit neither respawns nor signals', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    await backend.start(); // talaria.newSession-style re-init
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(0); // the OLD, torn-down client

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(2);
    expect(messages).toEqual([]);
  });
});

describe('AcpBackend — P1: a crash mid-turn closes the live turn itself (composer-lock fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits turn.end{error} for the live turn, clears liveTurnId/currentTurnId, and refuses a sendPrompt during backoff with "not started"', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);
    expect(seam(backend).liveTurnId).toBe('turn-1');

    must(clients[0]).simulateExit(1); // the child dies mid-turn — no prompt() rejection is simulated

    // The backend closes the turn itself — it does NOT wait on (or assume)
    // the SDK's in-flight prompt() rejecting on child-exit.
    expect(messages).toContainEqual({ type: 'turn.end', sessionId: 'session-1', turnId: 'turn-1', status: 'error' });
    expect(seam(backend).liveTurnId).toBeUndefined();
    expect(seam(backend).currentTurnId).toBeUndefined();

    messages.length = 0;
    backend.sendPrompt('session-1', 'during backoff — must be refused, not queued on a dead client', 'default');
    expect(messages).toEqual([
      { type: 'system.error', message: expect.stringContaining('not started') },
    ]);
    expect(clients).toHaveLength(1); // refused honestly — no respawn attempted yet, no new client

    // the pending respawn still runs normally afterwards (this fix does not
    // interfere with recovery)
    await vi.advanceTimersByTimeAsync(500);
    expect(clients).toHaveLength(2);
  });

  it('a crash with NO live turn emits only the one reconnecting signal (unchanged behavior)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);

    expect(messages).toEqual([
      { type: 'system.error', message: expect.stringContaining('reconnecting') },
    ]);
    expect(messages.some((m) => m.type === 'turn.end')).toBe(false);
  });

  it('M2: a crash DURING a session.load REPLAY closes the replay itself (composer-lock fix, replay variant)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).hangLoadSession(); // the load's response never arrives — replay stays in flight
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    void backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });
    await flushMicrotasks();

    // A replay mints `currentTurnId` and fires `turn.start` but — unlike a
    // live prompt turn — never sets `liveTurnId` (see that field's own doc).
    // The pre-M2 crash-close was keyed on `liveTurnId` alone, so it silently
    // missed this in-flight replay entirely.
    expect(seam(backend).liveTurnId).toBeUndefined();
    expect(seam(backend).currentTurnId).toBe('turn-1');
    expect(seam(backend).replay).not.toBeUndefined();

    must(clients[0]).simulateExit(1); // the child dies mid-replay

    expect(messages).toContainEqual({ type: 'turn.end', sessionId: 'old-session', turnId: 'turn-1', status: 'error' });
    expect(seam(backend).currentTurnId).toBeUndefined();
    expect(seam(backend).replay).toBeUndefined();
  });
});

describe('AcpBackend — W4-T1b §3: a crash releases the (bridge) root turn-lease (no dead-turn deadlock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Like {@link makeStartableBackend} but with an injected {@link FakeCheckpointTracker}
   * so `checkpoint.restore`'s `this.root.anyLiveTurn()` interlock (the bridge
   * lease) is actually reachable/observable via `invokeControl`. */
  function makeStartableBackendWithTracker(tracker: CheckpointTrackerLike): {
    backend: AcpBackend;
    clients: FakeAcpClient[];
  } {
    const config: HermesRuntimeConfig = { hermesPath: '/fake/hermes' };
    const clients: FakeAcpClient[] = [];
    const createClient: AcpClientFactory = (options) => {
      const client = new FakeAcpClient(options);
      clients.push(client);
      return client;
    };
    const backend = new AcpBackend(config, undefined, createClient, tracker);
    seam(backend).control = new FakeControlChannel();
    return { backend, clients };
  }

  it('a crash mid-turn releases the bridge lease — checkpoint.restore is refused while the turn is live, but NOT refused after the crash', async () => {
    const tracker = new FakeCheckpointTracker();
    const { backend, clients } = makeStartableBackendWithTracker(tracker);
    await backend.start();

    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    // Sanity: the lease IS held while the turn is live — restore refuses.
    const restoreWhileLive = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
    expect(restoreWhileLive.restored).toBe(false);
    expect(tracker.restoreCalls).toEqual([]); // never reached the tracker — refused at the interlock

    must(clients[0]).simulateExit(1); // crash mid-turn (SessionController.endOnCrash runs)

    const restoreAfterCrash = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
    expect(restoreAfterCrash.restored).toBe(true); // the lease was released — no dead-turn deadlock
    expect(tracker.restoreCalls).toEqual([{ id: 'ckpt-1', force: undefined }]);
  });
});

describe('AcpBackend — W4-T5a: respawn recovery fan-out (Q-10 / F2 / P-W4-6 ship gate)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('P-W4-6 core: crash with 2 registered sessions -> both get turn.end/error brackets, ONE system.error, respawn re-session/loads BOTH ids, both tab.bound re-emitted', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.sendPrompt('session-2', 'work', 'default'); // tab-2's turn is LIVE at crash time
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);

    // ONE reconnecting signal for the whole outage (unchanged R-A6 rule).
    expect(messages.filter((m) => m.type === 'system.error')).toHaveLength(1);
    // tab-2's live turn gets an error bracket (endOnCrash, per-controller fan-out).
    expect(messages).toContainEqual({
      type: 'turn.end',
      sessionId: 'session-2',
      turnId: expect.any(String),
      status: 'error',
    });
    messages.length = 0;

    await vi.advanceTimersByTimeAsync(500); // respawn fires -> recovery runs

    expect(clients).toHaveLength(2);
    const loadedIds = must(clients[1]).loadSessionCalls.map((c) => c.sessionId).sort();
    expect(loadedIds).toEqual(['session-1', 'session-2']);

    const bound = messages.filter((m) => m.type === 'tab.bound') as Array<{ tabId: string; sessionId: string }>;
    expect(bound.map((b) => ({ tabId: b.tabId, sessionId: b.sessionId })).sort((a, b) => a.tabId.localeCompare(b.tabId))).toEqual(
      [
        { tabId: 'tab-2', sessionId: 'session-2' },
        { tabId: BOOTSTRAP_TAB_ID, sessionId: 'session-1' },
      ].sort((a, b) => a.tabId.localeCompare(b.tabId)),
    );
    // no per-tab session-lost — both recovered
    expect(messages.some((m) => m.type === 'tab.error')).toBe(false);
  });

  /**
   * CF-01/A fix wave (arch Important, secondary robustness fix): mirrors
   * `recoverSessions`'s EXISTING per-attempt try/catch (`:533-546`) — before
   * this fix, `handleAcpCrash`'s per-controller `endOnCrash()` loop
   * (`:862`) had none, so ONE controller throwing aborted the loop before
   * the REMAINING controllers got their own crash-end AND before the
   * trailing `this.client?.dispose()` ran. `dispose()` is exactly what
   * clears `this.connection` — see `acpClient.terminate.test.ts`'s
   * companion fix — so an unguarded abort here could leave a stale client
   * reference's residual post-terminate window open again on TOP of simply
   * dropping the other tab's honest crash signal.
   *
   * `session-1`'s controller is registered FIRST (Map insertion order), so
   * forcing ITS `endOnCrash()` to throw proves the loop survives past the
   * FIRST iteration, not just tolerates a throw on the last one.
   *
   * RED (pre-fix): the loop aborts at session-1 — session-2 never gets its
   * `turn.end{status:'error'}` bracket and `disposeCallCount` stays 0.
   */
  it('one controller\'s endOnCrash() throwing does not skip the remaining controllers\' crash-end nor the trailing client.dispose() (handleAcpCrash loop guard)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.sendPrompt('session-2', 'work', 'default'); // tab-2's turn is LIVE at crash time
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    // Force session-1's endOnCrash to throw — an own-property override on
    // the REAL controller instance (seamFor targets the production object
    // directly), simulating a genuinely unexpected defensive-guard failure.
    seamFor(backend, 'session-1').endOnCrash = () => {
      throw new Error('boom: endOnCrash exploded');
    };

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);

    // session-2's live turn still gets its honest error bracket despite
    // session-1's endOnCrash throwing FIRST in iteration order.
    expect(messages).toContainEqual({
      type: 'turn.end',
      sessionId: 'session-2',
      turnId: expect.any(String),
      status: 'error',
    });
    // The trailing `this.client?.dispose()` (arch-A2 guard, AFTER the loop)
    // still ran despite the mid-loop throw.
    expect(must(clients[0]).disposeCallCount).toBe(1);
  });

  it('a load that FAILS for one session -> tab.error{tabId, kind:"session-lost"} for THAT tab; the OTHER recovers independently (F2 per-tab try/catch)', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 1) {
        const original = client.loadSession.bind(client);
        client.loadSession = async (cwd: string, sessionId: string, mcpServers?: AcpMcpServer[]) => {
          if (sessionId === 'session-2') throw new Error('history store corrupt');
          return original(cwd, sessionId, mcpServers);
        };
      }
    });
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);
    messages.length = 0;
    await vi.advanceTimersByTimeAsync(500);

    // session-2's load failed -> a per-tab session-lost affordance, controller dropped
    expect(messages).toContainEqual({
      type: 'tab.error',
      tabId: 'tab-2',
      kind: 'session-lost',
      message: expect.any(String),
    });
    expect(hasController(backend, 'session-2')).toBe(false);

    // session-1's load succeeded independently — bound normally.
    expect(messages).toContainEqual({
      type: 'tab.bound',
      tabId: BOOTSTRAP_TAB_ID,
      sessionId: 'session-1',
      rootId: expect.any(String),
    });
    expect(hasController(backend, 'session-1')).toBe(true);
  });

  /**
   * Task-7 fix-wave (Minor-4): locks the crash-recovery composition the
   * independent review proved live via a temporary probe (restored
   * afterward) — commits essentially that probe. The headline scenario of
   * audit A-3 itself: kill Hermes mid-session, and on respawn Hermes reports
   * `found:false` (not a rejection) for the recovered session id. Proves ALL
   * THREE effects fire together through the REAL recovery path
   * (`ConnectionSupervisor.recoverOneSession` -> `SessionController.
   * loadReplay`'s `!result.found` branch -> that branch's existing `result
   * === undefined` handling): the transcript-level `error`, the tab-chrome
   * `tab.error{kind:'session-lost'}`, and the dropped controller — not just
   * each one covered in isolation elsewhere.
   */
  it('audit A-3 (crash recovery): a respawn session/load reporting found:false surfaces BOTH the transcript error and the tab session-lost affordance, and drops the controller', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 1) client.setLoadSessionResult({ found: false });
    });
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1);
    messages.length = 0;
    await vi.advanceTimersByTimeAsync(500); // respawn fires -> recovery re-`session/load`s session-1, Hermes reports found:false

    expect(clients).toHaveLength(2);
    expect(must(clients[1]).loadSessionCalls).toHaveLength(1);

    // the transcript-level signal — loadReplay's own found:false branch,
    // identical shape to a rejected client.loadSession().
    expect(messages).toContainEqual({
      type: 'error',
      sessionId: 'session-1',
      message: 'That conversation no longer exists on the agent. Start a new chat.',
      turnId: expect.any(String),
    });
    const turnEnd = messages.find(
      (m) => m.type === 'turn.end' && (m as { sessionId?: string }).sessionId === 'session-1',
    );
    expect(turnEnd).toMatchObject({ status: 'error', sessionId: 'session-1' });

    // the tab-chrome-level terminal signal — the SAME tab.error{kind:'session-lost'} a rejected recovery fires.
    expect(messages).toContainEqual({
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      kind: 'session-lost',
      message: 'Could not recover this session after reconnecting.',
    });

    // the orphaned controller was dropped, not left bound to a dead session.
    expect(hasController(backend, 'session-1')).toBe(false);
  });

  it('lease: a recovered session acquires the root turn-lease cleanly — no dead lease left by the crashed turn', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();

    backend.sendPrompt('session-1', 'work', 'default');
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    must(clients[0]).simulateExit(1); // crash mid-turn -> endOnCrash releases the root lease
    await vi.advanceTimersByTimeAsync(500); // respawn recovers session-1 via session/load

    backend.sendPrompt('session-1', 'after recovery', 'default');
    await flushMicrotasks();
    expect(must(clients[1]).promptCallCount).toBe(1); // the recovered session's first turn was NOT refused
  });

  it('an all-empty crash (no sessions were ever registered) falls back to the ordinary bootstrap mint — never hangs with zero recovered tabs', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 0) client.failNextNewSession(new Error('Hermes refused the cwd'));
    });

    // The connection reaches 'ready', but the FIRST session never registers
    // (F2's connection/session phase split) — `pendingRecovery` will be an
    // EMPTY array at the next crash, not undefined.
    await backend.start();
    expect(clients).toHaveLength(1);

    // the sessionless-but-healthy child dies before any session ever registered
    must(clients[0]).simulateExit(1);
    await vi.advanceTimersByTimeAsync(500);

    expect(clients).toHaveLength(2);
    expect(must(clients[1]).newSessionCalls).toHaveLength(1); // ordinary bootstrap mint, not a recovery loop
    expect(must(clients[1]).loadSessionCalls).toEqual([]);
  });

  /**
   * I1 (independent concurrency review, W4-T5a fix pass): `recoverOneSession`
   * awaits `client.loadSession` (via `controller.loadReplay`) INSIDE the
   * `inFlightStart`-serialized `start()` run. `AcpClientLike.loadSession` is
   * not contractually guaranteed to reject when its child is killed
   * mid-request — if it HANGS, that await never settles, `start()`'s `run`
   * never resolves, `inFlightStart` never resets, and a SECOND crash's
   * `scheduleAcpRespawn -> start()` chains onto that same never-resolving
   * tail (P0's serialization) and can never reach its own `startInternal()`
   * — every tab stays "reconnecting" forever, no matter how much time
   * passes. `FakeAcpClient.hangLoadSession()` simulates exactly that: a
   * promise that never settles, not even on `dispose()`/child-kill.
   */
  it('I1: a hung loadSession during recovery does not wedge the respawn tail — a SECOND crash mid-recovery still lets the next respawn run', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 1) client.hangLoadSession(); // the respawned child never answers session/load
    });
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID

    must(clients[0]).simulateExit(1); // crash #1 -> 'respawning', backoff attempt 1 scheduled (500ms)
    await vi.advanceTimersByTimeAsync(500); // respawn #1 fires -> recoverOneSession hangs on loadSession

    expect(clients).toHaveLength(2);
    expect(must(clients[1]).loadSessionCalls).toHaveLength(1); // the recovery attempt WAS issued — just never answered

    // Crash #2 hits WHILE recovery #1 is still stuck awaiting the hung
    // loadSession — without I1's fix, `recoverOneSession`'s await never
    // settles, so `start()`'s `run` (what `inFlightStart` is holding) never
    // resolves, and the respawn below can never execute its own
    // startInternal(), no matter how much time passes.
    must(clients[1]).simulateExit(1);
    expect(clients).toHaveLength(2); // backoff pending, not immediate

    // The connect phase for client[1] succeeded (only loadSession hung), so
    // acpRespawnAttempts was already reset to 0 before crash #2 — backoff
    // restarts at attempt 1 (500ms), exactly like the sibling
    // "session-establish failure DURING a respawn" test above.
    await vi.advanceTimersByTimeAsync(500);

    // GREEN: the tail is NOT wedged — a third child spawns and re-attempts
    // the still-outstanding session-1 recovery.
    expect(clients).toHaveLength(3);
    expect(must(clients[2]).loadSessionCalls.map((c) => c.sessionId)).toEqual(['session-1']);
  });
});

/**
 * T-1 (V-12 RESTART-STATE): today, an EXPLICIT restart (`talaria.newSession` /
 * the trust-upgrade `setBackend` swap → `AcpBackend.start()` a second time)
 * reaches `ConnectionSupervisor.startInternal` → `teardownSession()` →
 * `SessionRegistry.disposeAll()`, which disposes every registered controller
 * with NO signal at all (`SessionController.dispose()` deliberately never
 * emits — T-A0 fork(2)/BF-B). A mid-turn tab's Stop keeps showing forever
 * (the turn it would cancel is already gone), and every OTHER tab's session
 * id silently stops resolving (no `tab.error`, no `clear` — a zombie tab).
 * The fix reuses the CRASH-path machinery (`SessionController.endForRestart`,
 * `endOnCrash`'s exact live-turn/replay arms with `status:'cancelled'`
 * instead of `'error'`) on a NEW fan-out leg in `startInternal`, gated by
 * `pendingRecovery === undefined` (fresh boot / explicit restart — NEVER a
 * crash respawn, which sets `pendingRecovery` BEFORE this runs).
 */
describe('AcpBackend — T-1 (V-12 RESTART-STATE): explicit restart fans out endForRestart + clear/tab.error (crash path untouched)', () => {
  it('two tabs, tab-2 mid-turn, an EXPLICIT restart (start()) ends its turn CANCELLED then signals it session-lost; the bootstrap-bound tab gets an honest clear with its OWN sessionId', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2

    backend.sendPrompt('session-2', 'work', 'default'); // tab-2's turn is LIVE at restart time
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start(); // explicit restart — NOT a crash: pendingRecovery stays undefined

    // tab-2's live turn ends CANCELLED (user-intended — an explicit restart,
    // never a failure), THEN that tab gets the terminal session-lost
    // affordance — the same ordering `endOnCrash` -> per-tab `tab.error`
    // already gives a failed crash-recovery (§7 B8), reused verbatim.
    const turnEndIdx = messages.findIndex(
      (m) => m.type === 'turn.end' && (m as { sessionId?: string }).sessionId === 'session-2',
    );
    const tabErrorIdx = messages.findIndex(
      (m) => m.type === 'tab.error' && (m as { tabId?: string }).tabId === 'tab-2',
    );
    expect(turnEndIdx).toBeGreaterThanOrEqual(0);
    expect(tabErrorIdx).toBeGreaterThan(turnEndIdx);
    expect(messages[turnEndIdx]).toMatchObject({ type: 'turn.end', sessionId: 'session-2', status: 'cancelled' });
    expect(messages[tabErrorIdx]).toMatchObject({ type: 'tab.error', tabId: 'tab-2', kind: 'session-lost' });

    // The bootstrap-bound session-1 gets an honest, session-scoped `clear`
    // (the tab that is about to be re-bound to a fresh session starts
    // empty) — never the dead PENDING_SESSION_PLACEHOLDER string.
    expect(messages).toContainEqual({ type: 'clear', sessionId: 'session-1' });
  });

  it('a crash mid-turn does NOT run the restart fan-out: pendingRecovery is already set when startInternal\'s guard checks it, so the respawn re-loads BOTH sessions with no clear/extra tab.error ever emitted (the crash path stays byte-identical)', async () => {
    vi.useFakeTimers();
    try {
      const { backend, clients } = makeStartableBackend();
      await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
      must(clients[0]).queueSessionId('session-2');
      await backend.openTab('tab-2'); // session-2

      backend.sendPrompt('session-2', 'work', 'default');
      await flushMicrotasks();
      expect(must(clients[0]).promptCallCount).toBe(1);

      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));

      must(clients[0]).simulateExit(1); // crash — handleAcpCrash's OWN endOnCrash fan-out runs + sets pendingRecovery

      // the crash path's own signal: turn.end{error} (NOT 'cancelled' —
      // endForRestart never ran for this session; endOnCrash did).
      expect(messages).toContainEqual({
        type: 'turn.end',
        sessionId: 'session-2',
        turnId: expect.any(String),
        status: 'error',
      });
      // the restart fan-out never fired during the crash itself.
      expect(messages.some((m) => m.type === 'clear')).toBe(false);

      await vi.advanceTimersByTimeAsync(500); // respawn -> startInternal() runs; its restart-fan-out guard must no-op (pendingRecovery is non-empty here)

      expect(clients).toHaveLength(2);
      const loadedIds = must(clients[1]).loadSessionCalls.map((c) => c.sessionId).sort();
      expect(loadedIds).toEqual(['session-1', 'session-2']); // both sessions recovered normally

      // Exactly ONE `clear` per recovered session — `SessionController.
      // loadReplay`'s OWN, pre-existing per-session clear (unrelated to the
      // restart fan-out). If the fan-out's `pendingRecovery` guard were
      // broken, the bootstrap session would get a SECOND, extra clear from
      // `fanOutRestartSignal` stacked on top of `loadReplay`'s.
      const clears = messages.filter((m) => m.type === 'clear') as Array<{ sessionId: string }>;
      expect(clears.map((c) => c.sessionId).sort()).toEqual(['session-1', 'session-2']);

      // No turn.end anywhere EVER carries 'cancelled' during a crash+respawn
      // — that status is `endForRestart`'s exclusive signature; the crash
      // path only ever produces 'error' (`endOnCrash`) or a genuinely
      // completed turn's own status. Proves `endForRestart` never ran.
      expect(
        messages.some((m) => m.type === 'turn.end' && (m as { status?: string }).status === 'cancelled'),
      ).toBe(false);

      expect(messages.some((m) => m.type === 'tab.error')).toBe(false); // both recovered — no session-lost either
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * W3-T6 (CF-11/D2): "New Session" now rebinds ONLY the current tab — mints a
 * fresh session bound to the SAME tabId, ending only THAT tab's own live
 * turn (honest `status:'cancelled'` via `SessionController.endForRestart` —
 * the SAME primitive the describe block above's whole-connection restart
 * uses, now fired for exactly ONE controller instead of every registered
 * one), leaving every sibling tab's controller and live turn COMPLETELY
 * untouched. Contrast with the T-1 (V-12 RESTART-STATE) block directly
 * above: that is the OLD whole-connection restart `talaria.newSession`
 * command still drives (unchanged, still fans out to every tab, now
 * relabeled "Restart Agent Connection" in package.json for honesty);
 * `newSessionInTab` is the NEW, additional per-tab entry the composer's own
 * "New Session" button posts instead (`tab.newSession`, §2d wire).
 */
describe('AcpBackend.newSessionInTab — W3-T6 (CF-11/D2): per-tab "New Session" rebind', () => {
  /** Like the `W4-T2` describe block's own `mintOnCwd`, but ALSO binds an
   * EXPLICIT tabId — the isolation test below needs two controllers on
   * DIFFERENT roots (so both can hold a live turn simultaneously — same-root
   * turns serialize via the shared root lease, an orthogonal, pre-existing
   * constraint) AND on DIFFERENT named tabs (so `getByTabId` resolves each
   * one distinctly), which the shared `seam()` sessionId setter alone cannot
   * do (it always defaults to `BOOTSTRAP_TAB_ID`). */
  function mintOnCwdForTab(backend: AcpBackend, sessionId: string, cwd: string, tabId: string): void {
    const b = backend as unknown as {
      buildSessionPort(sessionId: string, cwd: string): unknown;
      sessions: { open(id: string, cwd: string, port: unknown, tabId?: string): unknown };
    };
    b.sessions.open(sessionId, cwd, b.buildSessionPort(sessionId, cwd), tabId);
  }

  it('ends the tab\'s own live turn (cancelled), closes the old session, and binds a FRESH session to the SAME tab — the transcript clear lands BEFORE the fresh bind, never as session-lost', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    backend.sendPrompt('session-1', 'work', 'default'); // this tab's OWN turn is live
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    must(clients[0]).queueSessionId('session-2');

    await backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');

    // The OLD session's live turn ends CANCELLED — user-intended, never a
    // failure (endForRestart's own contract, unlike endOnCrash's 'error').
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'turn.end', sessionId: 'session-1', status: 'cancelled' }),
    );
    // The OLD session's transcript clears BEFORE the fresh bind — IMP-2
    // (3-lens review fix): tabId-scoped `tab.clear`, not the old
    // sessionId-scoped `clear`, so the SAME emission also reaches a
    // session-lost tab (see the IMP-2 describe block below).
    const clearIdx = messages.findIndex(
      (m) => m.type === 'tab.clear' && (m as { tabId?: string }).tabId === BOOTSTRAP_TAB_ID,
    );
    const boundIdx = messages.findIndex(
      (m) => m.type === 'tab.bound' && (m as { tabId?: string }).tabId === BOOTSTRAP_TAB_ID && (m as { sessionId?: string }).sessionId === 'session-2',
    );
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(boundIdx).toBeGreaterThan(clearIdx);
    // The fresh session binds to the SAME tabId.
    expect(messages[boundIdx]).toMatchObject({ type: 'tab.bound', tabId: BOOTSTRAP_TAB_ID, sessionId: 'session-2' });
    // The OLD controller is genuinely gone; the NEW one occupies the tab.
    expect(hasController(backend, 'session-1')).toBe(false);
    expect(sessionIdForTab(backend, BOOTSTRAP_TAB_ID)).toBe('session-2');
    // Never session-lost — a New Session is user-intended SUCCESS, not the
    // failure affordance `fanOutRestartSignal` gives an orphaned sibling.
    expect(messages.some((m) => m.type === 'tab.error')).toBe(false);
  });

  it('a sibling tab\'s controller + live turn are COMPLETELY untouched — no message ever names it, and it is still genuinely live afterward', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID, root ''
    // tab-2's own session on a DIFFERENT root, so both can hold a live turn
    // SIMULTANEOUSLY (v1 production always shares one cwd across tabs — this
    // is a TEST device to get two independent live turns, not a claim about
    // production topology; the isolation guarantee under test does not
    // depend on same- vs cross-root).
    mintOnCwdForTab(backend, 'session-2', '/root-2', 'tab-2');

    backend.sendPrompt('session-1', 'A work', 'default'); // A: about to be rebound
    await flushMicrotasks();
    backend.sendPrompt('session-2', 'B work', 'default'); // B: sibling, must survive untouched
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(2); // both genuinely live — independent roots, no lease contention

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    must(clients[0]).queueSessionId('session-3');

    await backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');

    // B's controller is STILL registered, at its ORIGINAL tab.
    expect(hasController(backend, 'session-2')).toBe(true);
    expect(sessionIdForTab(backend, 'tab-2')).toBe('session-2');
    // No message of ANY kind, for ANY reason, ever named B's session/tab
    // during the rebind — not a turn.end, not a tab.error, not a clear.
    expect(
      messages.some((m) => 'sessionId' in m && (m as { sessionId?: string }).sessionId === 'session-2'),
    ).toBe(false);
    expect(messages.some((m) => 'tabId' in m && (m as { tabId?: string }).tabId === 'tab-2')).toBe(false);
    // B's turn is still genuinely live, not merely "still registered" — its
    // OWN root's turn lease is still held (the real production signal
    // `endForRestart`/`dispose` would have released had B's controller been
    // touched at all — proves it was only ever READ here, never mutated).
    expect(anyLiveTurnOnRoot(backend, '/root-2')).toBe(true);
  });

  it('IMP-1 (3-lens review, concurrency): a rebind of a tab holding a GENUINELY live turn issues an explicit wire cancel of the orphaned turn — exactly once, never a second time from dispose()', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    backend.sendPrompt('session-1', 'work', 'default'); // this tab's OWN turn is live
    await flushMicrotasks();
    expect(must(clients[0]).promptCallCount).toBe(1);

    must(clients[0]).queueSessionId('session-2');

    await backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');

    // RED (pre-fix): `endForRestart()` nulls `liveTurnId` with no wire
    // cancel at all, and `dispose()`'s own cancel is gated on `liveTurnId
    // !== undefined` — already false by the time it runs — so the orphaned
    // turn kept running on the harness with nothing ever cancelling it
    // (`cancelCalls` would be `[]`). GREEN (post-fix): the explicit cancel
    // fires BEFORE `endForRestart`, exactly once, for the OLD session only.
    expect(must(clients[0]).cancelCalls).toEqual(['session-1']);
  });

  it('IMP-1: a rebind of an IDLE tab (no live turn) never calls client.cancel', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID — never prompted, genuinely idle
    must(clients[0]).queueSessionId('session-2');

    await backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');

    expect(must(clients[0]).cancelCalls).toEqual([]);
  });

  it('emits tab.error{kind:"open-failed"} instead of throwing when there is no live client', async () => {
    const config: HermesRuntimeConfig = {};
    const { AcpBackend: RealAcpBackend } = await import('./AcpBackend');
    const backend = new RealAcpBackend(config);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await expect(backend.newSessionInTab('tab-9')).resolves.toBeUndefined(); // never throws/rejects

    expect(messages).toEqual([
      { type: 'tab.error', tabId: 'tab-9', kind: 'open-failed', message: expect.any(String) },
    ]);
  });

  it('emits tab.error{kind:"open-failed"} when the fresh session/new itself rejects — the OLD session is still gone (never a zombie)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).failNextNewSession(new Error('Hermes refused the cwd'));
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');

    expect(messages).toContainEqual({
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      kind: 'open-failed',
      message: expect.stringContaining('refused the cwd'),
    });
    expect(hasController(backend, 'session-1')).toBe(false); // old is gone even though the mint failed — never a zombie
  });

  it('mints fresh even for a tab with no current controller (never opened, or already gone) — never throws, and STILL clears (IMP-2: unconditional, tabId-scoped)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).queueSessionId('session-2');
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.newSessionInTab('tab-never-opened');

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'tab.bound', tabId: 'tab-never-opened', sessionId: 'session-2' }),
    );
    // IMP-2 (3-lens review fix, un-pinning the old "clear === false" gap):
    // `tab.clear` is now UNCONDITIONAL — emitted even with no old occupant —
    // because a session-LOST tab (no `old` either, but a dead transcript +
    // standing banner the webview never dropped) needs the exact same
    // signal. Gating on `old` left that tab's dead conversation standing
    // forever; the fix unifies both arms so ordering never depends on
    // whether anything was there to close.
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'tab.clear', tabId: 'tab-never-opened' }),
    );
  });

  it('two rapid newSessionInTab calls on the SAME tab serialize on the tail — the second never reaches its own client.newSession until the first fully settles', async () => {
    const { backend } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
    const calls: Array<ReturnType<typeof deferred<{ sessionId: string; currentModeId: string }>>> = [];
    const client = {
      async newSession(): Promise<{ sessionId: string; currentModeId: string }> {
        const d = deferred<{ sessionId: string; currentModeId: string }>();
        calls.push(d);
        return d.promise;
      },
    };
    seam(backend).client = client;

    const p1 = backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');
    const p2 = backend.newSessionInTab(BOOTSTRAP_TAB_ID);
    await flushMicrotasks();

    // RED (pre-fix): both would reach client.newSession back-to-back — this
    // would already be 2 here. GREEN (post-fix): the second rebind is
    // queued behind the first on the SAME `inFlightStart` tail.
    expect(calls).toHaveLength(1);

    calls[0]?.resolve({ sessionId: 'session-2', currentModeId: 'default' });
    await p1;
    await flushMicrotasks();

    // NOW the second rebind's turn on the tail has arrived.
    expect(calls).toHaveLength(2);
    calls[1]?.resolve({ sessionId: 'session-3', currentModeId: 'default' });
    await p2;

    expect(sessionIdForTab(backend, BOOTSTRAP_TAB_ID)).toBe('session-3');
    expect(hasController(backend, 'session-2')).toBe(false); // the first rebind's own fresh session was itself replaced by the second, in turn
    expect(hasController(backend, 'session-3')).toBe(true);
  });

  it('a tab.newSession racing a sibling\'s sendPrompt does not cross-tab-leak — the sibling\'s prompt genuinely reaches the client, untouched by the queued rebind', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2, same root as session-1 (v1 posture)

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    must(clients[0]).queueSessionId('session-3');

    // Fire the rebind (queues on the tail) and IMMEDIATELY race a sibling
    // sendPrompt — sendPrompt is deliberately never tail-wrapped (§2c), so
    // it is free to run before the queued rebind's own body even starts.
    const rebindPromise = backend.newSessionInTab(BOOTSTRAP_TAB_ID, 'session-1');
    backend.sendPrompt('session-2', 'tab-2 work', 'default');
    await rebindPromise;
    await flushMicrotasks();

    expect(must(clients[0]).promptCallCount).toBe(1); // tab-2's prompt genuinely reached the client
    expect(sessionIdForTab(backend, 'tab-2')).toBe('session-2'); // never replaced
    expect(hasController(backend, 'session-2')).toBe(true);
    expect(
      messages.some((m) => m.type === 'tab.error' && (m as { tabId?: string }).tabId === 'tab-2'),
    ).toBe(false);
    // The rebind itself still completed correctly, unaffected by the race.
    expect(sessionIdForTab(backend, BOOTSTRAP_TAB_ID)).toBe('session-3');
  });
});

/**
 * W6-FG (folded-in W6-FB review Minor — a pre-existing race in the
 * twice-bitten `recoverOneSession`/`SessionRegistry` zone, HISTORICAL):
 * `recoverOneSession` closes by KEY (`this.sessions.close(sessionId)`) after
 * a failed/superseded recovery load, with NO identity guard. `loadTab`/
 * `tab.load` used to NOT be serialized behind `inFlightStart` (only `openTab`
 * was) — a user could load the SAME `sessionId` into a DIFFERENT tab WHILE
 * this recovery's own `loadReplay` await was still in flight.
 * `SessionRegistry.open`'s W6-FB remove-then-dispose then disposed recovery's
 * controller and rebound `sessionId` to the winner's fresh controller. If
 * recovery's own load THEN failed, closing by key disposed the WINNER (not
 * recovery's stale attempt), silently zombifying the winner's tab with no
 * `tab.error` at all. `recoverOneSession`'s identity-guarded close (see its
 * own doc on `ConnectionSupervisor.ts`) fixed the SYMPTOM.
 *
 * CF-01/L3-1 (closes the CAUSE — this task): `loadTab`/`session.load` now
 * chain onto the SAME `inFlightStart` tail as `start`/`openTab`/`closeTab`
 * (via `ConnectionSupervisor.runOnStartTail`) — the interleaving this whole
 * describe block exists to survive can no longer be TRIGGERED through the
 * public API at all: a `tab.load` issued while a respawn recovery is in
 * flight now QUEUES behind it instead of racing it. The test below replaces
 * the old "prove the identity guard saves us after the race happens" proof
 * (no longer constructible) with the stronger, more direct "prove the race
 * can't happen" proof — the exact serialization this task's RED-first test
 * plan calls for. `recoverOneSession`'s identity-guarded close stays in the
 * source, unchanged, as redundancy (see its own doc).
 */
describe('AcpBackend — CF-01/L3-1: loadTab is now serialized on the SAME tail as start/openTab/respawn-recovery (retires the W6-FG race above)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a tab.load for the SAME sessionId issued WHILE a respawn recovery is still in flight does not even reach its own client.loadSession call until recovery settles', async () => {
    const loadCalls: Array<{
      resolve: (r: AcpLoadSessionResult) => void;
      reject: (e: unknown) => void;
    }> = [];
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      if (index === 1) {
        // The respawned child's `loadSession` never auto-resolves — the test
        // drives each call's outcome individually (recovery's own call is
        // call #0; tab-2's own call, once it FINALLY starts, is call #1).
        client.loadSession = (_cwd: string, _sessionId: string, _mcpServers?: AcpMcpServer[]) =>
          new Promise<AcpLoadSessionResult>((resolve, reject) => {
            loadCalls.push({ resolve, reject });
          });
      }
    });
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID, on client[0]

    must(clients[0]).simulateExit(1); // crash -> respawning, backoff scheduled
    await vi.advanceTimersByTimeAsync(500); // respawn #1 fires -> recoverOneSession's own loadReplay (call #0) is now in flight, still inside start()'s OWN runOnStartTail turn

    expect(loadCalls).toHaveLength(1); // recovery's own session-1 load — not yet settled

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    // CF-01/L3-1: tab-2 loads the SAME sessionId WHILE recovery is still
    // stuck awaiting its own loadSession. loadTab now chains onto the SAME
    // `inFlightStart` tail the in-flight start()/recovery call already
    // occupies — it cannot even BEGIN running until that entire call settles.
    const t2Promise = backend.loadTab('tab-2', 'session-1', '/ws');
    await flushMicrotasks();
    // RED (pre-fix): this used to be 2 — tab-2's own load reached
    // client.loadSession immediately, genuinely interleaving with recovery.
    // GREEN (post-fix, asserted here): tab-2's load is queued behind
    // recovery — no second call has been made yet.
    expect(loadCalls).toHaveLength(1);

    // Recovery's OWN load (call #0) now fails. `SessionController.loadReplay`
    // never rejects (it catches internally) — this settles `recoverOneSession`'s
    // `result === undefined` failure branch, which identity-guard-closes
    // session-1 (still its own, untouched, controller at this point).
    must(loadCalls[0]).reject(new Error('history store corrupt'));
    await flushMicrotasks();

    expect(
      messages.filter((m) => m.type === 'tab.error' && (m as { tabId: string }).tabId === BOOTSTRAP_TAB_ID),
    ).toContainEqual({
      type: 'tab.error',
      tabId: BOOTSTRAP_TAB_ID,
      kind: 'session-lost',
      message: expect.any(String),
    });

    // NOW that start()/recovery's tail turn has settled, tab-2's queued load
    // finally starts — it was waiting its turn, never lost or dropped.
    expect(loadCalls).toHaveLength(2);
    must(loadCalls[1]).resolve({ found: true, currentModeId: 'default' });
    await flushMicrotasks();
    await t2Promise;

    expect(sessionIdForTab(backend, 'tab-2')).toBe('session-1');
    expect(hasController(backend, 'session-1')).toBe(true);
    // tab-2 was never actually lost — no tab.error ever targets it.
    expect(
      messages.filter((m) => m.type === 'tab.error' && (m as { tabId: string }).tabId === 'tab-2'),
    ).toEqual([]);
  });
});

/**
 * CF-01/L3-1 (the task's own RED-first proof, dedicated + minimal — see the
 * describe block above for the same guarantee proven against a live
 * respawn): `loadSessionIntoTab` (both its `session.load`/`tab.load`
 * entries) and `closeTab` now chain onto the SAME `inFlightStart` tail as
 * `start`/`openTab`, via `ConnectionSupervisor.runOnStartTail`. These two
 * tests drive the brief's exact two scenarios directly, with no respawn
 * involved: two rapid loads, and a close racing an in-flight load.
 */
describe('AcpBackend — CF-01/L3-1: loadSessionIntoTab/closeTab are serialized on the SAME runOnStartTail queue as start/openTab', () => {
  it('two rapid loadTab calls into DIFFERENT tabs never interleave — the second does not reach its own client.loadSession until the first fully settles', async () => {
    const { backend } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
    const calls: Array<ReturnType<typeof deferred<AcpLoadSessionResult>>> = [];
    const client = {
      async loadSession(): Promise<AcpLoadSessionResult> {
        const d = deferred<AcpLoadSessionResult>();
        calls.push(d);
        return d.promise;
      },
    };
    seam(backend).client = client;

    const p1 = backend.loadTab('tab-1', 'a', '/ws');
    const p2 = backend.loadTab('tab-2', 'b', '/ws');
    await flushMicrotasks();

    // RED (pre-fix): both loads reach client.loadSession back-to-back — this
    // would already be 2 here. GREEN (post-fix): load B is queued behind
    // load A on the SAME `inFlightStart` tail — it cannot start until load
    // A's ENTIRE tail-wrapped call (through its own client.loadSession
    // resolving and its whole announce/loadReplay chain) settles.
    expect(calls).toHaveLength(1);

    calls[0]?.resolve({ found: true, currentModeId: 'default' });
    await p1;
    await flushMicrotasks();

    // NOW load B has started — its turn on the tail arrived.
    expect(calls).toHaveLength(2);
    calls[1]?.resolve({ found: true, currentModeId: 'default' });
    await p2;

    expect(sessionIdForTab(backend, 'tab-1')).toBe('a');
    expect(sessionIdForTab(backend, 'tab-2')).toBe('b');
  });

  it('closeTab racing an in-flight loadTab serializes: the close does not take effect until the load settles', async () => {
    const { backend } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
    const d = deferred<AcpLoadSessionResult>();
    const client = {
      async loadSession(): Promise<AcpLoadSessionResult> {
        return d.promise;
      },
    };
    seam(backend).client = client;

    const loadPromise = backend.loadTab('tab-2', 'history-session', '/ws'); // in flight, blocked on d
    await flushMicrotasks();

    backend.closeTab('session-1'); // fired WHILE the load is still in flight
    await flushMicrotasks();

    // RED (pre-fix): closeTab ran free (not on the tail) — it disposed
    // session-1 immediately, regardless of the in-flight load. GREEN
    // (post-fix): closeTab is queued BEHIND the in-flight load on the SAME
    // tail — session-1 is still alive until the load settles.
    expect(hasController(backend, 'session-1')).toBe(true);

    d.resolve({ found: true, currentModeId: 'default' });
    await loadPromise;
    await flushMicrotasks();

    // Now the queued close has had its turn.
    expect(hasController(backend, 'session-1')).toBe(false);
  });
});

/**
 * CF-01/L3-1 fix (Critical — 3-lens review of the tail-serialization
 * commit): `loadSessionIntoTabInternal`'s `client.loadSession` had NO
 * wall-clock deadline at all — only `AcpClient.raceTermination`'s
 * child-EXIT-only race. Pre-fix this was a LOCALIZED hang (one tab); now
 * that the whole method is tail-serialized (the describe block immediately
 * above), a hung-but-alive child wedges the ENTIRE topology tail forever —
 * every subsequent `openTab`/`closeTab`/`loadSessionIntoTab`/`start` chains
 * behind it. These tests prove `ConnectionSupervisor
 * .raceSessionLoadAgainstDeadline`'s `SESSION_ESTABLISH_DEADLINE_MS` (120s)
 * closes that gap, mirroring the T-3 "session-establish wall-clock deadline"
 * describe block's own style for the bootstrap/recovery legs.
 */
describe('AcpBackend.loadTab — CF-01/L3-1 fix (Critical): a hung-but-alive client.loadSession must not wedge the topology tail forever', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a direct History-load whose client.loadSession never resolves times out at the deadline, emits tab.error, disposes the abandoned controller, and releases the tail for a subsequent openTab', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).hangLoadSession();

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const loadPromise = backend.loadTab('tab-2', 'history-session', '/ws');
    const settlement = trackSettlement(loadPromise);
    await flushMicrotasks();
    expect(settlement.settled()).toBe(false); // still hanging in client.loadSession — the child never exits

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settlement.settled()).toBe(false); // not yet — still inside the 120s window

    await vi.advanceTimersByTimeAsync(1);

    // RED (pre-fix): loadSessionIntoTabInternal's client.loadSession call has
    // no wall-clock deadline at all — advancing fake time does nothing, and
    // settlement.settled() stays false forever (the whole topology tail is
    // wedged: no `openTab`/`closeTab`/another load could ever run again).
    expect(settlement.settled()).toBe(true);
    await loadPromise;

    expect(messages).toContainEqual({
      type: 'tab.error',
      tabId: 'tab-2',
      kind: 'session-lost',
      message: expect.any(String),
    });
    // The abandoned attempt's controller is disposed (identity-guarded,
    // mirrors recoverOneSession's own guard) — not left half-registered,
    // permanently "replaying".
    expect(hasController(backend, 'history-session')).toBe(false);

    // Tail un-jammed: a SECOND topology op (openTab) actually runs.
    messages.length = 0;
    must(clients[0]).queueSessionId('session-3');
    await backend.openTab('tab-3');
    expect(messages).toContainEqual({
      type: 'tab.bound',
      tabId: 'tab-3',
      sessionId: 'session-3',
      rootId: expect.any(String),
    });
  });

  it('a belated client.loadSession resolution AFTER the deadline fires is a silent no-op (no stale clear/turn.start/turn.end into the already-timed-out tab)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    const resolver = deferred<AcpLoadSessionResult>();
    must(clients[0]).loadSession = async (cwd: string, sessionId: string, mcpServers?: AcpMcpServer[]) => {
      must(clients[0]).loadSessionCalls.push({ cwd, sessionId, mcpServers });
      return resolver.promise;
    };

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const loadPromise = backend.loadTab('tab-2', 'history-session', '/ws');
    await vi.advanceTimersByTimeAsync(120_000); // the deadline fires — client.loadSession still hasn't answered
    await loadPromise;
    messages.length = 0;

    // The ORIGINAL client.loadSession call was never cancelled (JS promises
    // can't be) — it now answers LATE, after the deadline already gave up.
    resolver.resolve({ found: true, currentModeId: 'default' });
    await flushMicrotasks();

    // No belated clear/turn.start/turn.end/tab.bound for an attempt nobody
    // is waiting on anymore.
    expect(messages).toEqual([]);
  });

  it('sanity: a client.loadSession that resolves well within the deadline is unaffected (no stray timer left armed)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).setLoadSessionResult({ found: true, currentModeId: 'default' });

    await backend.loadTab('tab-2', 'history-session', '/ws');

    expect(hasController(backend, 'history-session')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * CF-01/L3-1 fix (Important — 3-lens review): `runOnStartTail`'s
 * SELF-DEADLOCK WARNING was "verified by inspection" only, with no runtime
 * enforcement. This proves the new {@link ConnectionSupervisor
 * .executingOnTail} guard turns a synchronous re-entrant call into a loud,
 * immediate error instead of a silent, permanent wedge — and that it does
 * NOT false-trip the legitimate sequential/concurrent-queueing pattern the
 * describe block above (and the "CF-01/L3-1: loadSessionIntoTab/closeTab are
 * serialized..." block further above) already exercise extensively.
 */
describe('ConnectionSupervisor.runOnStartTail — CF-01/L3-1 fix (Important): a re-entrant call throws instead of self-deadlocking the whole topology tail', () => {
  it('a synchronously re-entrant fn (calls runOnStartTail again before returning) rejects with a diagnostic error instead of wedging the tail forever, and un-jams it for the next call', async () => {
    const { backend } = makeBackend();
    const supervisor = connectionSupervisorOf(backend);

    // RED (pre-fix): the inner call silently enqueues behind the OUTER
    // call's own still-pending promise — a genuine self-deadlock (no error,
    // no timeout): neither promise can ever settle, since each is waiting
    // on the other.
    const outer = supervisor.runOnStartTail(() => supervisor.runOnStartTail(() => Promise.resolve('inner')));
    const settlement = trackSettlement(outer);
    await flushMicrotasks();

    expect(settlement.settled()).toBe(true);
    await expect(outer).rejects.toThrow('runOnStartTail: re-entrant call would deadlock the topology tail');

    // Tail un-jammed: a fresh call afterward actually runs (not wedged).
    await expect(supervisor.runOnStartTail(() => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('does NOT false-trip the legitimate pattern: a tail link fn completing, then the NEXT queued link running (sequential, not re-entrant)', async () => {
    const { backend } = makeBackend();
    const supervisor = connectionSupervisorOf(backend);

    const order: string[] = [];
    const p1 = supervisor.runOnStartTail(async () => {
      order.push('fn1-start');
      await Promise.resolve();
      order.push('fn1-end');
      return 'one';
    });
    const p2 = supervisor.runOnStartTail(async () => {
      order.push('fn2-start');
      return 'two';
    });

    await expect(p1).resolves.toBe('one');
    await expect(p2).resolves.toBe('two');
    expect(order).toEqual(['fn1-start', 'fn1-end', 'fn2-start']);
  });

  it('does NOT false-trip the legitimate pattern: an unrelated concurrent caller queues behind an fn still suspended mid-await', async () => {
    const { backend } = makeBackend();
    const supervisor = connectionSupervisorOf(backend);
    const d = deferred<string>();

    const p1 = supervisor.runOnStartTail(() => d.promise); // suspended, not yet settled
    await flushMicrotasks();

    // A totally independent, concurrent call — NOT nested inside fn1's own
    // execution — must enqueue normally, not throw.
    const p2 = supervisor.runOnStartTail(() => Promise.resolve('concurrent'));
    await flushMicrotasks();
    expect(trackSettlement(p2).settled()).toBe(false); // queued behind p1, not yet its turn

    d.resolve('first');
    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('concurrent');
  });
});

describe('AcpBackend — W4-T5a concern-2: tab.open retry after a mid-respawn open-failed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an open-failed tab.open issued during the backoff window is cleanly retryable once the connection recovers (no half-registered state blocks the retry)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1); // crash -> respawning, backoff scheduled (not yet fired)

    await backend.openTab('tab-2'); // issued DURING the backoff window — no live client yet
    expect(messages).toContainEqual({
      type: 'tab.error',
      tabId: 'tab-2',
      kind: 'open-failed',
      message: expect.any(String),
    });
    messages.length = 0;

    await vi.advanceTimersByTimeAsync(500); // respawn completes (session-1 recovered)

    must(clients[1]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // the retry — SAME tabId

    const bound = messages.find((m) => m.type === 'tab.bound' && (m as { tabId: string }).tabId === 'tab-2');
    expect(bound).toMatchObject({ type: 'tab.bound', tabId: 'tab-2', sessionId: 'session-2' });
    // exactly ONE session/new on the retry — the crashed bootstrap tab was
    // RECOVERED via session/load, not re-minted, so nothing else consumed
    // the respawned client's newSession queue ahead of the retry.
    expect(must(clients[1]).newSessionCalls).toHaveLength(1);
  });
});

describe('AcpBackend.loadSessionIntoTab — W4-T5a deliverable 3: proper per-tab mint + cross-root re-home + mode.state', () => {
  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
    mockWorkspace.__customModesWorkspaceValue = undefined;
  });

  it('mints a FRESH controller homed to the ADOPTED cwd\'s RootCoordinator — cross-root re-home, NOT the prior tab\'s root (F6)', async () => {
    const backend = new AcpBackend({} as HermesRuntimeConfig);
    const client = new FakeAcpClient();
    seam(backend).client = client;
    seam(backend).cwd = '/root-a';
    seam(backend).sessionId = 'session-1'; // mints @ root-a, tabId defaults to BOOTSTRAP_TAB_ID
    const priorRootId = rootIdFor(backend, '/root-a');
    const targetRootId = rootIdFor(backend, '/root-b');
    expect(targetRootId).not.toBe(priorRootId); // sanity: genuinely different roots

    const load = callLoadSessionIntoTab(backend);
    await load('old-session', '/root-b', BOOTSTRAP_TAB_ID);

    expect(controllerRootId(backend, 'old-session')).toBe(targetRootId);
    expect(controllerRootId(backend, 'old-session')).not.toBe(priorRootId);
    // the prior tab's controller was disposed via the registry's F6 remove-
    // before-dispose (no second removal path) — never left lingering.
    expect(hasController(backend, 'session-1')).toBe(false);
  });

  it('emits mode.state{modeId:null, available} immediately after tab.bound (M#2 close) — a History-loaded tab starts with no custom mode', async () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only' }];
    const { backend, messages } = makeBackend();

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });

    const boundIndex = messages.findIndex((m) => m.type === 'tab.bound');
    const stateIndex = messages.findIndex((m) => m.type === 'mode.state');
    expect(boundIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBe(boundIndex + 1);
    expect(messages[stateIndex]).toMatchObject({
      type: 'mode.state',
      sessionId: 'old-session',
      modeId: null,
      available: [{ id: 'docs-only', name: 'Docs only' }],
    });
  });

  it('P3 (target-tab, not ambient-active): refuses a load into a tab whose OWN controller has a live turn — a DIFFERENT tab\'s live turn does not block it', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2 becomes the "active" session

    backend.sendPrompt('session-2', 'work', 'default');
    await flushMicrotasks();

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    const load = callLoadSessionIntoTab(backend);

    // refused: tab-2's OWN controller has a live turn.
    const refused = await load('other-session', '/ws', 'tab-2');
    expect(refused).toBeUndefined();
    expect(messages).toContainEqual({
      type: 'error',
      sessionId: 'session-2',
      message: expect.stringContaining('still running'),
    });
    expect(must(clients[0]).loadSessionCalls).toEqual([]);

    messages.length = 0;
    // allowed: BOOTSTRAP_TAB_ID (tab-1) is idle, even though tab-2 (the
    // "ambient active" session under the old T1a approximation) is busy —
    // proves the guard reads the TARGET tab's controller, not activeSessionId.
    const allowed = await load('other-session', '/ws', BOOTSTRAP_TAB_ID);
    expect(allowed).toBeDefined();
    expect(messages.some((m) => m.type === 'tab.bound' && (m as { tabId: string }).tabId === BOOTSTRAP_TAB_ID)).toBe(
      true,
    );
  });

  it('a stale loadReplay whose controller was disposed (superseded by a fresh mint on the SAME tab) never emits into the tab after the fact (F6 x P4b generalized across mint-fresh)', async () => {
    const { backend } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
    let resolveFirst!: (result: AcpLoadSessionResult) => void;
    const firstLoad = new Promise<AcpLoadSessionResult>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const client = {
      async loadSession(): Promise<AcpLoadSessionResult> {
        calls += 1;
        return calls === 1 ? firstLoad : { found: true, currentModeId: 'default' };
      },
    };
    seam(backend).client = client;
    // CF-01/L3-1: this test needs load B to genuinely START while load A is
    // still hung — the outer `loadSessionIntoTab` now fully serializes on
    // `inFlightStart`, which would make load B wait for load A forever (a
    // real deadlock, since A only resolves once B has already been observed
    // below). Drive `loadSessionIntoTabInternal` directly to keep proving
    // this INTERNAL supersede-guard still works under real interleaving —
    // see `callLoadSessionIntoTabInternal`'s own doc.
    const load = callLoadSessionIntoTabInternal(backend);

    const p1 = load('a', '/ws', BOOTSTRAP_TAB_ID); // hangs — the SLOWER load
    const p2 = load('b', '/ws', BOOTSTRAP_TAB_ID); // mints fresh, disposes A's controller (F6)
    await p2;

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    resolveFirst({ found: true, currentModeId: 'default' }); // A's load belatedly resolves — must be a no-op
    await p1;
    await flushMicrotasks();

    expect(messages).toEqual([]); // no stale emit leaked from the disposed controller
  });

  /**
   * Task-7 fix-wave (Important-1, guard 1 of 3): the SAME stale-superseded-load
   * proof as immediately above, but the belated resolution is `found:false`
   * (audit A-3's lost-session branch) instead of a genuine success. Proves the
   * `if (this.replay !== replay) return undefined;` re-check INSIDE that
   * branch (`SessionController.loadReplay`, right after the `!result.found`
   * check) is load-bearing: without it, load A's belated `found:false`
   * resolution would fall through and emit `error`/`turn.end` into tab-1
   * AFTER its controller was disposed by load B's fresh mint — the exact
   * "stale emit after supersede" class this file's `found:true` sibling test
   * exists to forbid, just reached via the OTHER exit of `loadReplay`.
   */
  it('a stale loadReplay whose controller was disposed (superseded by a fresh mint on the SAME tab) never emits into the tab after the fact — found:false variant (audit A-3 supersede re-check)', async () => {
    const { backend } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
    let resolveFirst!: (result: AcpLoadSessionResult) => void;
    const firstLoad = new Promise<AcpLoadSessionResult>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const client = {
      async loadSession(): Promise<AcpLoadSessionResult> {
        calls += 1;
        return calls === 1 ? firstLoad : { found: true, currentModeId: 'default' };
      },
    };
    seam(backend).client = client;
    // CF-01/L3-1: see the found:true sibling test above — drives the
    // internal method directly so load B can genuinely start while load A
    // is still hung (the outer wrapper now fully serializes, which would
    // deadlock this exact setup).
    const load = callLoadSessionIntoTabInternal(backend);

    const p1 = load('a', '/ws', BOOTSTRAP_TAB_ID); // hangs — the SLOWER load, will belatedly resolve found:false
    const p2 = load('b', '/ws', BOOTSTRAP_TAB_ID); // mints fresh, disposes A's controller (F6)
    await p2;

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    resolveFirst({ found: false }); // A's load belatedly resolves found:false — must be a no-op
    await p1;
    await flushMicrotasks();

    expect(messages).toEqual([]); // no stale error/turn.end leaked from the disposed controller
  });

  /**
   * C1 (independent concurrency review, W4-T5a fix pass): the ABOVE "stale
   * loadReplay" test runs with `workspaceFolders === undefined` — the ONE
   * branch of `loadSessionIntoTab` with NO `await` between capturing the
   * tab's occupant (:1601) and disposing it (pre-fix :1626). With a
   * workspace OPEN, `resolveWithinWorkspaceReal` (:1615) is a REAL `await`
   * (genuine `fs.realpath` I/O) sitting between capture and dispose — two
   * concurrent same-tab loads can BOTH capture the SAME prior occupant
   * before either resumes, and the pre-fix code disposes that now-STALE
   * reference instead of whichever controller is ACTUALLY occupying the tab
   * by the time it resumes.
   *
   * Real `fs.realpath` completion order between the two loads is not
   * something a unit test should assert on directly (deliberately NOT
   * pinned here) — instead this drives both loads to the point where EACH
   * has reached its own (controllable) `client.loadSession` call, then
   * lets both belatedly resolve, and asserts on the OUTCOME: exactly one
   * controller must survive, the registry + activeSessionId must agree on
   * which one, and the loser must never emit into the tab. Whichever load
   * happens to resume second is — by construction (loadSessionIntoTab's own
   * F6 dispose-then-mint order) — the one that must win; this test does not
   * need to know or care which literal id that turns out to be.
   */
  it('C1 (concurrency): two concurrent loads into the SAME tab with a workspace OPEN never leak a controller or double-emit', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-c1-'));
    try {
      const project = path.join(tmpRoot, 'project');
      await fsp.mkdir(project, { recursive: true });
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];

      const { backend, messages } = makeBackend(); // session-1 (prior occupant) @ BOOTSTRAP_TAB_ID
      const pending = new Map<string, ReturnType<typeof deferred<AcpLoadSessionResult>>>();
      const client = {
        async loadSession(_cwd: string, sessionId: string): Promise<AcpLoadSessionResult> {
          const d = deferred<AcpLoadSessionResult>();
          pending.set(sessionId, d);
          return d.promise;
        },
      };
      seam(backend).client = client;
      // CF-01/L3-1: this test needs BOTH loads to genuinely reach their own
      // `client.loadSession` call before either resolves — the outer
      // `loadSessionIntoTab` now fully serializes on `inFlightStart`, which
      // would make load B wait for load A's entire turn (a real deadlock,
      // since the poll below waits for BOTH to be pending). Drive
      // `loadSessionIntoTabInternal` directly to keep proving the INTERNAL
      // C1 re-read still works under real interleaving — see
      // `callLoadSessionIntoTabInternal`'s own doc.
      const load = callLoadSessionIntoTabInternal(backend);

      const p1 = load('a', project, BOOTSTRAP_TAB_ID);
      const p2 = load('b', project, BOOTSTRAP_TAB_ID);

      // Both `target` captures (:1601) happen synchronously, before either
      // load's confinement `await` — kicking the two calls off back-to-back
      // (no `await` between them) guarantees that, regardless of real fs
      // timing. Poll (real timers — genuine fs I/O, not fake-timer-driven)
      // until BOTH have cleared confinement and reached their own
      // (controllable) `client.loadSession` call.
      const start = Date.now();
      while (!pending.has('a') || !pending.has('b')) {
        if (Date.now() - start > 5000) {
          throw new Error('timed out waiting for both loads to reach client.loadSession');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // Resolution order does not matter — see this test's own doc: the
      // dispose-or-leak already happened synchronously, right after each
      // load's OWN confinement await resolved (well before either
      // `loadSession` is resolved here).
      pending.get('a')?.resolve({ found: true, currentModeId: 'default' });
      pending.get('b')?.resolve({ found: true, currentModeId: 'default' });
      await Promise.all([p1, p2]);
      await flushMicrotasks();

      // Sanity: the original prior occupant is gone either way (whichever
      // load resumed first closes it with a still-fresh capture).
      expect(hasController(backend, 'session-1')).toBe(false);

      // (a) no leaked controller: exactly one of 'a'/'b' survives.
      const aAlive = hasController(backend, 'a');
      const bAlive = hasController(backend, 'b');
      expect(aAlive).not.toBe(bAlive);
      const winner = aAlive ? 'a' : 'b';

      // (b) the registry and activeSessionId agree, and point at the winner.
      expect(sessionIdForTab(backend, BOOTSTRAP_TAB_ID)).toBe(winner);
      expect(seam(backend).sessionId).toBe(winner);

      // (c) the loser never emits turn.end/finish into the tab after the
      // winner took over — only ONE turn.end for this tab, for the winner.
      const turnEnds = messages.filter((m) => m.type === 'turn.end');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({ sessionId: winner });
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * W6-FB (3-way CODE Important — same `sessionId` loaded into two
   * DIFFERENT tabs): `loadSessionIntoTab`'s C1 re-read is TAB-scoped
   * (`getByTabId(tabId)`) — it never notices that the incoming `sessionId`
   * is ALREADY registered under a DIFFERENT tab. Loading the SAME History
   * row into tab-1 then tab-2 used to leak tab-1's controller (never
   * `session/close`d) and leave tab-1 a silent zombie (still shown bound to
   * `SA` in the webview, but the registry now resolves `SA` to tab-2).
   *
   * SEQUENTIAL variant — the simplest reproduction (no interleaving needed):
   * load SA -> T1 fully completes, THEN load SA -> T2. Mirrors the C1 test's
   * OWN harness (`mkdtemp` so `resolveWithinWorkspaceReal`'s `fs.realpath`
   * is a genuine await, not a same-tick no-op) even though this variant
   * doesn't strictly need the interleaving it buys — consistency with the
   * concurrent variant below and the brief's own mandate.
   */
  it('W6-FB (sequential): the SAME sessionId loaded into a SECOND tab disposes the FIRST tab\'s controller (session/close fires) and signals the orphaned tab — no silent zombie', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-w6fb-seq-'));
    try {
      const project = path.join(tmpRoot, 'project');
      await fsp.mkdir(project, { recursive: true });
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];

      const { backend, client, messages } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
      const load = callLoadSessionIntoTab(backend);

      await load('SA', project, 'tab-1');
      messages.length = 0; // drop tab-1's own tab.bound/mode.state/clear/turn.start/turn.end noise

      await load('SA', project, 'tab-2');

      // No leak: tab-1's controller was ACTUALLY disposed (best-effort
      // `session/close` fired for SA), not merely overwritten in the map.
      expect(client.closeSessionCalls).toContain('SA');

      // No silent zombie: tab-1 gets the EXISTING T5a terminal signal — the
      // SAME `tab.error{kind:'session-lost'}` a failed respawn recovery
      // fires — never left bound-to-a-dead-controller with no affordance.
      expect(messages).toContainEqual({
        type: 'tab.error',
        tabId: 'tab-1',
        kind: 'session-lost',
        message: expect.any(String),
      });

      // Exactly one controller is live for SA, and it is bound to tab-2.
      expect(sessionIdForTab(backend, 'tab-2')).toBe('SA');
      expect(sessionIdForTab(backend, 'tab-1')).toBeUndefined();
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  /**
   * CONCURRENT variant of the same defect: two OVERLAPPING loads of the SAME
   * sessionId into two DIFFERENT tabs (not the same tab — that's the
   * already-hardened C1 path above). Mirrors the C1 concurrency test's own
   * technique exactly (controllable `client.loadSession` deferreds, poll
   * until both loads have reached them, resolution order deliberately not
   * pinned) — proves the fix holds under real interleaving, not just the
   * simple sequential case: whichever load's synchronous post-await block
   * resumes SECOND must see the FIRST's already-minted controller and
   * dispose it (clearing its `replay`), so the FIRST's later belated
   * `client.loadSession` resolution trips its OWN supersede-guard instead of
   * double-emitting `SA`'s replay into both tabs.
   */
  it('W6-FB (concurrency): the SAME sessionId loaded into TWO tabs concurrently never double-emits — exactly one survivor streams, the orphaned tab gets tab.error{kind:session-lost}', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-w6fb-conc-'));
    try {
      const project = path.join(tmpRoot, 'project');
      await fsp.mkdir(project, { recursive: true });
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];

      const { backend, messages } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
      const calls: Array<ReturnType<typeof deferred<AcpLoadSessionResult>>> = [];
      const client = {
        async loadSession(): Promise<AcpLoadSessionResult> {
          const d = deferred<AcpLoadSessionResult>();
          calls.push(d);
          return d.promise;
        },
      };
      seam(backend).client = client;
      // CF-01/L3-1: see the C1 concurrency test above — drives the internal
      // method directly so both loads can genuinely reach `client.loadSession`
      // before either resolves (the outer wrapper now fully serializes,
      // which would deadlock this exact poll-for-both-pending setup).
      const load = callLoadSessionIntoTabInternal(backend);

      const p1 = load('SA', project, 'tab-x');
      const p2 = load('SA', project, 'tab-y');

      // Poll (real timers — genuine fs I/O) until BOTH loads have cleared
      // confinement and reached their own controllable `client.loadSession`
      // call — see the C1 test above for why this is the right sync point.
      const start = Date.now();
      while (calls.length < 2) {
        if (Date.now() - start > 5000) {
          throw new Error('timed out waiting for both loads to reach client.loadSession');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      calls[0]?.resolve({ found: true, currentModeId: 'default' });
      calls[1]?.resolve({ found: true, currentModeId: 'default' });
      await Promise.all([p1, p2]);
      await flushMicrotasks();

      // No double-emit: exactly ONE turn.end for SA (the loser's belated
      // resolution trips its cleared-replay supersede-guard and returns
      // early — the same mechanism the same-TAB C1 fix already relies on).
      const saTurnEnds = messages.filter(
        (m) => m.type === 'turn.end' && (m as { sessionId?: string }).sessionId === 'SA',
      );
      expect(saTurnEnds).toHaveLength(1);

      // No leak: exactly one of tab-x/tab-y ends up bound to SA — the other
      // is the orphan.
      const xHasSA = sessionIdForTab(backend, 'tab-x') === 'SA';
      const yHasSA = sessionIdForTab(backend, 'tab-y') === 'SA';
      expect(xHasSA).not.toBe(yHasSA);
      const orphan = xHasSA ? 'tab-y' : 'tab-x';

      // No silent zombie: the orphaned tab got the terminal session-lost signal.
      expect(messages).toContainEqual({
        type: 'tab.error',
        tabId: orphan,
        kind: 'session-lost',
        message: expect.any(String),
      });
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('AcpBackend.loadTab — W4-T5b: the public tab.load entry (thin wrapper over loadSessionIntoTab)', () => {
  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
  });

  it('reaches loadSessionIntoTab with the EXPLICIT tabId (a non-bootstrap tab) — tab.bound carries that tabId', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID
    must(clients[0]).queueSessionId('session-2');
    await backend.openTab('tab-2'); // session-2 @ tab-2
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.loadTab('tab-2', 'history-session', '/ws');

    expect(must(clients[0]).loadSessionCalls).toContainEqual({
      cwd: '/ws',
      sessionId: 'history-session',
      mcpServers: [],
    });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'tab.bound', tabId: 'tab-2', sessionId: 'history-session' }),
    );
  });

  it('CF-14: emits tab.error{kind:"open-failed"} (never throws/rejects) when there is no live client — mirrors openTab\'s fire-and-forget discipline', async () => {
    const config: HermesRuntimeConfig = {};
    const { AcpBackend: RealAcpBackend } = await import('./AcpBackend');
    const backend = new RealAcpBackend(config);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await expect(backend.loadTab('tab-9', 'history-session', '/ws')).resolves.toBeUndefined();

    // CF-14 (ARCH-1 ban on silent no-ops): a History click during a backend
    // outage used to only log — the tab just never loaded, with no
    // affordance. Mirrors `openTabInternal`'s identical no-client shape.
    expect(messages).toEqual([
      { type: 'tab.error', tabId: 'tab-9', kind: 'open-failed', message: expect.any(String) },
    ]);
  });

  it('CF-14: emits tab.error{kind:"open-failed"} (message never echoes the path) when the load cwd is outside every open workspace folder', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-loadtab-outside-'));
    try {
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
      const { backend, clients } = makeStartableBackend();
      await backend.start();
      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));

      const outsideCwd = path.resolve('/etc');
      await expect(backend.loadTab('tab-2', 'history-session', outsideCwd)).resolves.toBeUndefined();

      expect(must(clients[0]).loadSessionCalls).toEqual([]); // refused before reaching the ACP client
      expect(messages).toEqual([
        { type: 'tab.error', tabId: 'tab-2', kind: 'open-failed', message: expect.any(String) },
      ]);
      // Sec-M2 / status-reason-only: the offending path must never be echoed
      // back into the user-facing message (mirrors `SessionController`'s
      // "never the path" discipline for dropped attachments).
      const [emitted] = messages;
      expect((emitted as { message: string }).message).not.toContain(outsideCwd);
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('resolves cleanly (no throw) when the target tab is busy — loadSessionIntoTab\'s own P3 refusal, unchanged', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    backend.sendPrompt('session-1', 'work', 'default');
    await flushMicrotasks();

    await expect(backend.loadTab(BOOTSTRAP_TAB_ID, 'history-session', '/ws')).resolves.toBeUndefined();
    expect(must(clients[0]).loadSessionCalls).toEqual([]); // refused before reaching the ACP client
  });
});

describe('beta.7 B1: loadTab threads the History title into tab.bound', () => {
  it('a titled load emits tab.bound carrying that title', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).setLoadSessionResult({ found: true, currentModeId: 'default' });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.loadTab('tab-2', 'history-session', '/ws', 'Fix the bug');

    const bound = messages.find((m) => m.type === 'tab.bound' && m.tabId === 'tab-2');
    expect(bound).toMatchObject({ sessionId: 'history-session', title: 'Fix the bug' });
  });

  it('a title-less load (legacy session.load posture) emits tab.bound WITHOUT the key — never title: undefined', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    must(clients[0]).setLoadSessionResult({ found: true, currentModeId: 'default' });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.loadTab('tab-2', 'history-session', '/ws');

    const bound = messages.find((m) => m.type === 'tab.bound' && m.tabId === 'tab-2');
    expect(bound).toBeDefined();
    expect(bound && 'title' in bound).toBe(false);
  });
});

describe('AcpBackend.invokeControl — Zone HIST: sessions panel refresh (ACP session/list, NOT tui_gateway)', () => {
  it("switchTab('sessions') calls client.listSessions (not this.control), reshapes the result into SessionsData, and emits panel.data", async () => {
    const { backend, client, messages } = makeBackend();
    withFakeControl(backend); // proves the sessions fetch never touches this
    client.setListSessionsResult({
      sessions: [
        { session_id: 's1', cwd: '/ws/project', title: 'Fix flaky test', updated_at: '2026-07-10T12:00:00Z' },
      ],
      next_cursor: 'cursor-2',
    });

    const result = await backend.invokeControl('panel.data',{ panel: 'sessions' });

    expect(client.listSessionsCalls).toEqual([{ cwd: undefined, cursor: undefined }]);
    const expected = {
      sessions: [{ id: 's1', cwd: '/ws/project', title: 'Fix flaky test', updatedAt: '2026-07-10T12:00:00Z' }],
      nextCursor: 'cursor-2',
    };
    expect(result).toEqual(expected);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'sessions', data: expected, cwd: '' }]);

    const control = seam(backend).control as { dispatchCalls: unknown[] };
    expect(control.dispatchCalls).toEqual([]);
  });

  it("a direct 'session.list' control.invoke call (pagination 'load more') also refreshes the panel, passing params.cursor through", async () => {
    const { backend, client, messages } = makeBackend();
    client.setListSessionsResult({ sessions: [], next_cursor: null });

    await backend.invokeControl('session.list', { cursor: 'cursor-2' });

    expect(client.listSessionsCalls).toEqual([{ cwd: undefined, cursor: 'cursor-2' }]);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'sessions', data: { sessions: [], nextCursor: undefined }, cwd: '' }]);
  });

  it('passes the workspace cwd start() resolved as the default session/list filter', async () => {
    const { backend, clients } = makeStartableBackend({ cwd: '/ws' });
    await backend.start();
    must(clients[0]).setListSessionsResult({ sessions: [] });

    await backend.invokeControl('panel.data',{ panel: 'sessions' });

    expect(must(clients[0]).listSessionsCalls).toEqual([{ cwd: '/ws', cursor: undefined }]);
  });
});

describe('AcpBackend.invokeControl — Zone HIST: session.load (row click) round trip', () => {
  it('re-sends the registered codebase_search MCP server on session/load — RAG cross-zone contract (mcpServers is not retained across a load either)', async () => {
    const { backend, client } = makeBackend();
    backend.setMcpServer('codebase_search', fakeMcpServer);

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws/project-a' });

    expect(client.loadSessionCalls).toEqual([
      { cwd: '/ws/project-a', sessionId: 'old-session', mcpServers: [fakeMcpServer] },
    ]);
  });

  it('sends an empty mcpServers array on session/load when RAG is inactive/untrusted', async () => {
    const { backend, client } = makeBackend();

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws/project-a' });

    expect(must(client.loadSessionCalls[0]).mcpServers).toEqual([]);
  });

  it('clears the transcript, brackets the load in turn.start/turn.end, and switches the active sessionId to the loaded session', async () => {
    const { backend, client, messages } = makeBackend(); // seeded with sessionId 'session-1'
    client.setLoadSessionResult({ found: true, currentModeId: 'accept_edits' });

    const result = await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });

    // W4-T3b (D1/§7 B9(b)): `tab.bound` is announced FIRST — before the load
    // clears/brackets the replay — so the webview's binding is never racing
    // the very stream it gates. W4-T5a (M#2): `mode.state` immediately
    // follows `tab.bound`, mirroring `openSession`'s own emission order.
    expect(messages.map((m) => m.type)).toEqual(['tab.bound', 'mode.state', 'clear', 'turn.start', 'turn.end']);
    expect(messages[0]).toMatchObject({ type: 'tab.bound', sessionId: 'old-session' });
    expect(messages[3]).toMatchObject({ type: 'turn.start', sessionId: 'old-session' });
    expect(messages[4]).toMatchObject({ type: 'turn.end', status: 'complete' });
    expect(seam(backend).sessionId).toBe('old-session');
    expect(result).toEqual({ found: true, currentModeId: 'accept_edits' });
  });

  it('audit A-3: a load that reports found:false surfaces a terminal error instead of silently binding an empty transcript', async () => {
    const { backend, client, messages } = makeBackend(); // seeded with sessionId 'session-1'
    client.setLoadSessionResult({ found: false });

    const result = await backend.invokeControl('session.load', { sessionId: 'gone-session', cwd: '/ws' });

    // `loadReplay`'s own "not performed" signal — same shape a rejected
    // `client.loadSession` already returns, NOT a bound empty transcript.
    expect(result).toBeUndefined();
    expect(messages.map((m) => m.type)).toEqual(['tab.bound', 'mode.state', 'clear', 'turn.start', 'error', 'turn.end']);
    expect(messages).toContainEqual({
      type: 'error',
      sessionId: 'gone-session',
      message: 'That conversation no longer exists on the agent. Start a new chat.',
      turnId: expect.any(String),
    });
    const turnEnd = messages.find((m) => m.type === 'turn.end');
    expect(turnEnd).toMatchObject({ status: 'error', sessionId: 'gone-session' });
  });

  /**
   * Task-7 fix-wave (Important-1, guard 2 of 3): proves
   * `this.subagents.setReplaying(false)` INSIDE the `!result.found` branch
   * (`SessionController.loadReplay`) is load-bearing, mirroring the existing
   * P4b spy idiom (`seamFor(...).subagents`, `vi.spyOn`) rather than
   * reinventing one. Without it, a session whose load reports `found:false`
   * would be left permanently stuck in "replaying" mode — a LATER live
   * `delegate_task` on this same controller would incorrectly skip
   * `startedAt` (see `SubagentAccumulator.applyStart`'s own doc), reading as
   * though it started at some unknown point in the past instead of live.
   */
  it('a load reporting found:false resets the subagents replaying flag before returning (audit A-3 teardown, guard 2 of 3)', async () => {
    const { backend } = makeBackend();
    let resolveLoad!: (result: AcpLoadSessionResult) => void;
    const loadPromise = new Promise<AcpLoadSessionResult>((resolve) => {
      resolveLoad = resolve;
    });
    const client = {
      async loadSession(): Promise<AcpLoadSessionResult> {
        return loadPromise;
      },
    };
    seam(backend).client = client;

    const p = backend.invokeControl('session.load', { sessionId: 'gone-session', cwd: '/ws' });
    await flushMicrotasks(); // let loadReplay reach `await client.loadSession(...)` — controller minted, setReplaying(true) already fired

    const ctrlSubagents = seamFor(backend, 'gone-session').subagents as { setReplaying(replaying: boolean): void };
    const setReplayingSpy = vi.spyOn(ctrlSubagents, 'setReplaying');

    resolveLoad({ found: false });
    await p;

    expect(setReplayingSpy).toHaveBeenCalledWith(false);
  });

  /**
   * Task-7 fix-wave (Important-1, guard 3 of 3): proves `this.replay =
   * undefined` INSIDE the `!result.found` branch (`SessionController.
   * loadReplay`) is load-bearing. The History-panel path (unlike crash
   * recovery) never closes the controller on `found:false` — it stays
   * registered, still bound to its tab (see `loadSessionIntoTab`'s own doc).
   * Without the clear, a LATER `session/update` for this same sessionId
   * would still find `this.replay` set and fold into an already-finished
   * replay window — resurrecting a transcript item on a session the user was
   * just told no longer exists, instead of being silently dropped (no live
   * `this.turn` either, since no turn ever actually started).
   */
  it('a load reporting found:false clears this.replay (audit A-3 teardown, guard 3 of 3) — a late session/update never resurrects a transcript item', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID — wires the FakeAcpClient's callbacks via the real createClient factory

    must(clients[0]).setLoadSessionResult({ found: false });
    const load = callLoadSessionIntoTab(backend);
    const result = await load('gone-session', '/ws', 'tab-2');

    expect(result).toBeUndefined();
    // the History-panel path never closes the controller on found:false.
    expect(hasController(backend, 'gone-session')).toBe(true);

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    // A late session/update for the dead session arrives — must be a no-op.
    must(clients[0]).callbacks?.onSessionUpdate('gone-session', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'late replay item' },
    });

    expect(messages).toEqual([]);
  });

  it('no-ops (no client call) and logs when sessionId or cwd is missing from params', async () => {
    const { backend, client, messages } = makeBackend();

    const result = await backend.invokeControl('session.load', { sessionId: 'old-session' /* no cwd */ });

    expect(client.loadSessionCalls).toEqual([]);
    expect(messages).toEqual([]);
    expect(result).toBeUndefined();
  });

  it('replays the historical transcript through the EXISTING session/update -> TranscriptItem pipeline (not a new payload)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // wires the FakeAcpClient's callbacks via the real createClient factory

    const client = must(clients[0]);
    client.setReplayUpdates([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed answer.' } },
    ]);
    client.setLoadSessionResult({ found: true, currentModeId: 'default' });

    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((msg) => messages.push(msg));

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws/old-project' });

    // The replayed update arrives as an ordinary `message.delta`/`message.end`
    // pair on the synthetic load turn — the same messages a LIVE turn would
    // produce via `handleSessionUpdate` -> `TurnTranslator.applyUpdate`, proving
    // the replay is NOT dropped by the `sessionId !== this.sessionId || !this.turn`
    // guard (both must already be set before `loadSession()` is awaited).
    const deltaMsg = messages.find((m) => m.type === 'message.delta');
    expect(deltaMsg).toMatchObject({ type: 'message.delta', text: 'Replayed answer.' });
    // W4-T3b: `tab.bound` announces the binding BEFORE the replay streams.
    // W4-T5a (M#2): `mode.state` immediately follows `tab.bound`.
    expect(messages.map((m) => m.type)).toEqual([
      'tab.bound',
      'mode.state',
      'clear',
      'turn.start',
      'message.delta',
      'message.end',
      'turn.end',
    ]);
  });

  it('R-C2: replay renders historical USER messages and brackets each historical turn (no coalescing)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    const client = must(clients[0]);
    client.setReplayUpdates([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the bug' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'now add tests' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Added.' } },
    ]);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((msg) => messages.push(msg));

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws/old' });

    // W4-T3b: `tab.bound` announces the binding BEFORE the replay streams.
    // W4-T5a (M#2): `mode.state` immediately follows `tab.bound`.
    expect(messages.map((m) => m.type)).toEqual([
      'tab.bound',
      'mode.state',
      'clear',
      'turn.start', 'user', 'message.delta', 'message.end', 'turn.end', // historical turn 1
      'turn.start', 'user', 'message.delta', 'message.end', 'turn.end', // historical turn 2
    ]);
    const users = messages.filter((m) => m.type === 'user') as Array<{ text: string; turnId: string }>;
    expect(users.map((u) => u.text)).toEqual(['fix the bug', 'now add tests']);
    expect(must(users[0]).turnId).not.toBe(must(users[1]).turnId); // per-turn boundaries, not one blob
    const lastEnd = messages[messages.length - 1] as { turnId: string; status: string };
    expect(lastEnd.status).toBe('complete');
    expect(lastEnd.turnId).toBe(must(users[1]).turnId); // final turn.end closes the LAST synthetic turn
  });

  // V-18 (Tier-2 remediation architecture §2, DECLARED test overturn): this
  // test used to assert a live `user_message_chunk` is ALWAYS suppressed —
  // that pinned the drain-echo defect (a queued prompt drained mid-turn
  // streamed with no user bubble at all). `makeBackend()` alone (no live
  // turn ever admitted) was never actually exercising "live" in the sense
  // the old title claimed: `SessionController.applyUpdate`'s
  // `if (!this.turn) return;` guard drops EVERY update whenever no turn is
  // live, for reasons that have nothing to do with `user_message_chunk`
  // specifically — the NEW test right below this one now pins THAT
  // (still-true, unrelated) invariant explicitly instead of by accident.
  // This test is corrected to exercise an ACTUAL live turn (via
  // `backend.sendPrompt`), proving the real V-18 claim: a live
  // `user_message_chunk` — the harness's queued-prompt DRAIN echo, its ONLY
  // live emitter — now renders as a `user` item instead of being dropped.
  it('R-C2 / V-18: a live user_message_chunk during an ACTUAL live turn now renders as a user item (drain echo, no longer suppressed)', async () => {
    const { backend, client, messages } = makeBackend();
    backend.sendPrompt('session-1', 'first prompt', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1);
    messages.length = 0; // drop the turn.start/user messages from sendPrompt itself

    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'now add tests too' },
    });

    expect(messages).toEqual([
      { type: 'user', turnId: 'turn-1', sessionId: 'session-1', text: 'now add tests too', mode: 'default' },
    ]);
  });

  // Additive (not an overturn): the genuinely-unrelated invariant the OLD
  // test above accidentally exercised — with NO live turn and NO replay
  // window installed at all, a `user_message_chunk` is still silently
  // dropped by `applyUpdate`'s own early-return guard. Unaffected by V-18.
  it('a user_message_chunk with NO live turn and NO replay window is still silently dropped (applyUpdate\'s early-return guard, unrelated to V-18)', () => {
    const { backend, messages } = makeBackend();
    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'nobody is listening' },
    });
    expect(messages).toEqual([]);
  });
});

/**
 * A7 (Tier-2 remediation architecture §12.1, task T-13): `NewSessionResponse.
 * models.currentModelId`/`LoadSessionResponse.models.currentModelId` used to
 * be discarded entirely, so the webview showed the generic "Model"
 * placeholder (`webview/src/App.tsx:107-108`) until the user's FIRST manual
 * switch — even though the harness already told us the bound model at
 * session/load start. `currentModelId` stays `undefined` on every
 * PRE-EXISTING fixture in this file (`FakeAcpClient`'s default), so this is
 * additive: no existing message-order assertion (e.g. the exact-sequence
 * checks in the `session.load` describe block above) is affected.
 */
describe('AcpBackend — A7: model.state emitted at bind time from the harness-bound currentModelId', () => {
  it('openSession (session/new): a currentModelId in the response emits model.state and sets the controller field', async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client) => {
      client.newSessionModelId = 'claude-sonnet-5';
    });
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    expect(clients).toHaveLength(1);
    expect(messages).toContainEqual({ type: 'model.state', sessionId: 'session-1', modelId: 'claude-sonnet-5' });
    expect(seam(backend).sessionId).toBe('session-1');
  });

  it('openSession: no models field in the response emits no model.state (the placeholder stays, not a fabricated null)', async () => {
    const { backend, clients } = makeStartableBackend(); // newSessionModelId stays undefined (default)
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    expect(clients).toHaveLength(1);
    expect(messages.some((m) => m.type === 'model.state')).toBe(false);
  });

  it('session.load (History-panel load): a currentModelId in the response emits model.state', async () => {
    const { backend, client, messages } = makeBackend(); // seeded with sessionId 'session-1'
    client.setLoadSessionResult({ found: true, currentModeId: 'default', currentModelId: 'gpt-5' });

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });

    expect(messages).toContainEqual({ type: 'model.state', sessionId: 'old-session', modelId: 'gpt-5' });
  });

  it('session.load: no currentModelId in the response emits no model.state (matches the existing exact-sequence assertion)', async () => {
    const { backend, client, messages } = makeBackend();
    client.setLoadSessionResult({ found: true, currentModeId: 'accept_edits' });

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });

    // Unchanged from the pinned sequence above — no model.state slipped in.
    expect(messages.map((m) => m.type)).toEqual(['tab.bound', 'mode.state', 'clear', 'turn.start', 'turn.end']);
  });
});

describe('AcpBackend.handleSessionUpdate — W2 F-S: available_commands_update intercept + cache', () => {
  it('maps, caches, and pushes commands.available BEFORE the turn/replay branch (no turn/replay installed on a fresh makeBackend())', () => {
    const { backend, messages } = makeBackend();

    // `makeBackend()` installs neither `this.turn` nor `this.replay` — if this
    // update fell through to the turn/replay branch instead of being
    // intercepted first, `handleSessionUpdate`'s `if (!this.turn) return;`
    // guard would silently drop it and NOTHING would be emitted (exactly the
    // "silently never fire" bug the architecture doc's wiring note warns
    // about, §3.2).
    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'help', description: 'Show help' },
        { name: 'model', description: 'Switch model', input: { hint: '<name>' } },
      ],
    });

    expect(messages).toEqual([
      {
        type: 'commands.available',
        sessionId: 'session-1',
        commands: [
          { name: 'help', description: 'Show help' },
          { name: 'model', description: 'Switch model', inputHint: '<name>' },
        ],
      },
    ]);
    expect(backend.getAvailableCommands()).toEqual([
      { name: 'help', description: 'Show help' },
      { name: 'model', description: 'Switch model', inputHint: '<name>' },
    ]);
  });

  it('drops malformed entries defensively — never throws, keeps only the well-formed ones', () => {
    const { backend, messages } = makeBackend();

    expect(() =>
      fireSessionUpdate(backend)('session-1', {
        sessionUpdate: 'available_commands_update',
        // Deliberately malformed per the defensive-mapper contract (commands.test.ts).
        availableCommands: [
          { name: 'help', description: 'Show help' },
          { name: 123, description: 'bad name' },
          null,
        ] as never,
      }),
    ).not.toThrow();

    expect(messages).toEqual([
      { type: 'commands.available', sessionId: 'session-1', commands: [{ name: 'help', description: 'Show help' }] },
    ]);
  });

  it('ignores an update for a stale sessionId (the pre-existing sessionId guard, unchanged)', () => {
    const { backend, messages } = makeBackend(); // seeded with sessionId 'session-1'

    fireSessionUpdate(backend)('some-other-session', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'help', description: 'Show help' }],
    });

    expect(messages).toEqual([]);
    expect(backend.getAvailableCommands()).toBeUndefined();
  });

  it('getAvailableCommands() is undefined before any catalog has arrived', () => {
    const { backend } = makeBackend();
    expect(backend.getAvailableCommands()).toBeUndefined();
  });

  it('dispose() (session teardown) clears the cached catalog', () => {
    const { backend } = makeBackend();
    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'help', description: 'Show help' }],
    });
    expect(backend.getAvailableCommands()).toEqual([{ name: 'help', description: 'Show help' }]);

    backend.dispose();

    expect(backend.getAvailableCommands()).toBeUndefined();
  });
});

describe('AcpBackend.loadSession — W2 F-S: available_commands cache re-emit / invalidate (§3.2 cache hygiene)', () => {
  it('W4-T5a: a load of the SAME session ALSO starts with no cached catalog — mint-fresh (F6) applies uniformly, whether the loaded id matches the tab\'s prior session or not', async () => {
    // Pre-T5a this reused the SAME controller instance in place, so its
    // `lastCommands` cache survived the load and was manually re-emitted
    // (the "ACP does not replay available_commands_update on load" gap
    // workaround). W4-T5a mints a FRESH controller for every load — even a
    // same-id reload — so that per-instance cache no longer carries over;
    // a natural `available_commands_update`, if Hermes ever sends one,
    // repopulates it exactly like any other freshly-loaded session.
    const { backend, messages } = makeBackend(); // seeded with sessionId 'session-1'
    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'help', description: 'Show help' }],
    });
    messages.length = 0;

    await backend.invokeControl('session.load', { sessionId: 'session-1', cwd: '/ws' });

    expect(messages.filter((m) => m.type === 'commands.available')).toEqual([]);
    expect(backend.getAvailableCommands()).toBeUndefined();
  });

  it("invalidates the cache on a DIFFERENTLY-loaded session — a prior session's commands never linger, and none are re-emitted", async () => {
    const { backend, messages } = makeBackend(); // seeded with sessionId 'session-1'
    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'help', description: 'Show help' }],
    });
    expect(backend.getAvailableCommands()).toEqual([{ name: 'help', description: 'Show help' }]);
    messages.length = 0;

    await backend.invokeControl('session.load', { sessionId: 'a-different-session', cwd: '/ws' });

    expect(messages.some((m) => m.type === 'commands.available')).toBe(false);
    expect(backend.getAvailableCommands()).toBeUndefined();
  });
});

describe('AcpBackend.loadSession — P4b: a superseded load\'s belated resolution does not corrupt the WINNING load\'s state', () => {
  it("W4-T5a: load A and load B now mint SEPARATE controllers (mint-fresh + F6 dispose-prior, replacing the old reuse-in-place approximation) — load A's belated finish never touches load B's (the winner's) subagents fold", async () => {
    const { backend } = makeBackend();
    let resolveFirst!: (result: AcpLoadSessionResult) => void;
    const firstLoadPromise = new Promise<AcpLoadSessionResult>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    // A minimal client stub: load A (the first call) hangs until `resolveFirst`
    // is invoked below; load B (the second, superseding call) resolves right away.
    const client = {
      async loadSession(): Promise<AcpLoadSessionResult> {
        calls += 1;
        return calls === 1 ? firstLoadPromise : { found: true, currentModeId: 'default' };
      },
    };
    seam(backend).client = client;
    // CF-01/L3-1: this test needs load B to genuinely mint + dispose load
    // A's controller WHILE load A is still hung on its own client.loadSession
    // — the outer `loadSessionIntoTab` (which `invokeControl('session.load', …)`
    // now routes through) fully serializes on `inFlightStart`, which would
    // make load B wait for load A forever (a real deadlock, since A only
    // resolves after B is observed below). Drive `loadSessionIntoTabInternal`
    // directly (bypassing `invokeControl`) to keep proving this INTERNAL
    // supersede-guard still works under real interleaving — see
    // `callLoadSessionIntoTabInternal`'s own doc.
    const load = callLoadSessionIntoTabInternal(backend);

    const p1 = load('a', '/ws', BOOTSTRAP_TAB_ID); // load A — hangs, mints controller A
    const p2 = load('b', '/ws', BOOTSTRAP_TAB_ID); // load B — mints controller B, disposes A (F6)
    await p2;

    // W4-T5a: unlike the pre-T5a reuse-in-place approximation (one shared
    // controller/subagents instance across both loads), load B now owns its
    // OWN controller — spy on IT specifically via its sessionId.
    const controllerBSubagents = seamFor(backend, 'b').subagents as { setReplaying(replaying: boolean): void };
    const setReplayingSpy = vi.spyOn(controllerBSubagents, 'setReplaying');

    resolveFirst({ found: true, currentModeId: 'default' }); // load A FINALLY resolves — but its controller was disposed
    await p1;
    await flushMicrotasks();

    // The bug this guards against (pre-T5a: shared controller; T5a: cross-
    // controller leak after dispose): load A's belated finish must NEVER
    // reach load B's (the actual winner's) fold — the SessionController
    // `dispose()` fix (`this.replay = undefined`, no emit) makes load A's
    // continuation detect it was superseded and return before touching
    // ANYTHING controller-B-shaped, including its subagents accumulator.
    expect(setReplayingSpy).not.toHaveBeenCalled();
  });
});

describe('SessionController.dispose — M1: symmetry with endOnCrash (clears currentTurnId/turn too)', () => {
  it('a direct dispose() of a live-turn controller clears currentTurnId/turn, not just liveTurnId/replay', async () => {
    const { backend, client } = makeBackend(); // session-1 @ BOOTSTRAP_TAB_ID
    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1);
    expect(seam(backend).currentTurnId).toBe('turn-1');
    expect(seam(backend).liveTurnId).toBe('turn-1');

    // Not reachable via the ordinary router today (the P3 live-turn guard +
    // endOnCrash already protect every current caller) — drives the method
    // directly, mirroring how `SessionRegistry.close`/`disposeAll` would
    // call it on a controller a future caller disposes while its turn is
    // still live.
    (seamFor(backend, 'session-1').dispose as () => void)();

    expect(seamFor(backend, 'session-1').currentTurnId).toBeUndefined();
    expect(seamFor(backend, 'session-1').turn).toBeUndefined();
    expect(seamFor(backend, 'session-1').liveTurnId).toBeUndefined();
    expect(seamFor(backend, 'session-1').replay).toBeUndefined();
  });
});

/** Reaches past `private` to fire an ACP `session/update` directly at `handleSessionUpdate`,
 * mirroring how the real `AcpClientCallbacks.onSessionUpdate` wiring invokes it — without
 * requiring the full `start()`/real-client machinery `makeStartableBackend` sets up. */
function fireSessionUpdate(backend: AcpBackend): (sessionId: string, update: AcpSessionUpdate) => void {
  return (
    backend as unknown as { handleSessionUpdate: (sessionId: string, update: AcpSessionUpdate) => void }
  ).handleSessionUpdate.bind(backend);
}

/** T5b: reaches past `private` to drive `teardownSession()`/`handleAcpCrash()`
 * directly — these tests don't go through the full `start()` machinery, so
 * there is no real child exit to simulate via `client.simulateExit`.
 *
 * W6-FI-b: both moved onto `ConnectionSupervisor` (3-way ARCH I-4, part 2 of
 * 2) — reached ONE hop further (`backend.connectionSupervisor.X`) than
 * before, same posture as every other supervisor seam in this file.
 * `teardownSession` is PUBLIC now (was `private`) since `AcpBackend.dispose()`
 * is a genuine external caller; `handleAcpCrash` stays `private` (the cast
 * bypasses it exactly as it did pre-extraction). */
function callTeardownSession(backend: AcpBackend): () => void {
  const supervisor = (backend as unknown as { connectionSupervisor: { teardownSession(): void } })
    .connectionSupervisor;
  return supervisor.teardownSession.bind(supervisor);
}
function callHandleAcpCrash(backend: AcpBackend): (code: number | null) => void {
  const supervisor = (
    backend as unknown as { connectionSupervisor: { handleAcpCrash(code: number | null): void } }
  ).connectionSupervisor;
  return supervisor.handleAcpCrash.bind(supervisor);
}

/** CF-01/I-1: reaches past `private` only to get at `connectionSupervisor`
 * itself (same posture as every other supervisor seam in this file) —
 * `getClient()` is PUBLIC on `ConnectionSupervisor`, so no further cast is
 * needed once the field is reached. Used to prove a failed connect phase
 * actually clears the zombie client, not just resets `acpState`. */
function getSupervisorClient(backend: AcpBackend): unknown {
  return (
    backend as unknown as { connectionSupervisor: { getClient(): unknown } }
  ).connectionSupervisor.getClient();
}

/** W4-T5a: reaches past `private` to drive `loadSessionIntoTab(sessionId, cwd, tabId)`
 * directly with an EXPLICIT tabId — the legacy `session.load` control-method
 * path (`invokeControl`) has no wire field for one (always BOOTSTRAP_TAB_ID),
 * so tab-scoped behavior (P3's target-tab guard, cross-root re-home into a
 * NAMED tab) needs this seam to exercise. */
function callLoadSessionIntoTab(
  backend: AcpBackend,
): (sessionId: string, cwd: string, tabId: string) => Promise<AcpLoadSessionResult | undefined> {
  return (
    backend as unknown as {
      loadSessionIntoTab: (sessionId: string, cwd: string, tabId: string) => Promise<AcpLoadSessionResult | undefined>;
    }
  ).loadSessionIntoTab.bind(backend);
}

/**
 * CF-01/L3-1: reaches past `private` to drive `loadSessionIntoTabInternal`
 * directly, BYPASSING the outer `loadSessionIntoTab` tail-serialization
 * wrapper. The outer wrapper now fully serializes every load onto
 * `inFlightStart` (see `ConnectionSupervisor.runOnStartTail`'s own doc), so
 * two loads issued back-to-back through the PUBLIC entry (`callLoadSessionIntoTab`
 * above, or `loadTab`/`session.load`) can no longer genuinely overlap — the
 * handful of tests that specifically drive REAL interleaving (to prove the
 * pre-existing C1 re-read / W6-FB registry-level dedup / P4b supersede-guard
 * INSIDE the internal method still behave correctly under it) use THIS seam
 * instead. Those guards are still real, still-shipped code — CF-01/L3-1
 * deliberately keeps them as redundancy rather than removing them — this
 * helper is how this file keeps exercising them directly now that the outer
 * wrapper makes them unreachable via any public entry point.
 */
function callLoadSessionIntoTabInternal(
  backend: AcpBackend,
): (sessionId: string, cwd: string, tabId: string) => Promise<AcpLoadSessionResult | undefined> {
  return (
    backend as unknown as {
      loadSessionIntoTabInternal: (
        sessionId: string,
        cwd: string,
        tabId: string,
      ) => Promise<AcpLoadSessionResult | undefined>;
    }
  ).loadSessionIntoTabInternal.bind(backend);
}

/** Reach past `private` to read a specific controller's `getRootId()` — the
 * cross-root re-home proof needs to compare a controller's ACTUAL bound
 * root against the production `resolveRootCoordinator(cwd)` resolution. */
function controllerRootId(backend: AcpBackend, sessionId: string): string | undefined {
  const b = backend as unknown as { sessions: { get(id: string): { getRootId(): string } | undefined } };
  return b.sessions.get(sessionId)?.getRootId();
}

function rootIdFor(backend: AcpBackend, cwd: string): string {
  return (backend as unknown as { resolveRootCoordinator(cwd: string): { rootId: string } }).resolveRootCoordinator(
    cwd,
  ).rootId;
}

function hasController(backend: AcpBackend, sessionId: string): boolean {
  return (backend as unknown as { sessions: { has(id: string): boolean } }).sessions.has(sessionId);
}

/**
 * CF-01/L3-1 fix: reaches past `private` to drive `ConnectionSupervisor
 * .runOnStartTail` DIRECTLY — the re-entrancy-guard tests need to construct
 * both the "genuinely re-entrant" and "legitimate concurrent" scenarios at
 * the tail-primitive level itself, independent of any particular wrapped
 * method (`start`/`openTab`/`closeTab`/`loadSessionIntoTab`), none of which
 * actually re-enters (that's the whole point being tested).
 */
function connectionSupervisorOf(backend: AcpBackend): { runOnStartTail<T>(fn: () => Promise<T>): Promise<T> } {
  return (
    backend as unknown as {
      connectionSupervisor: { runOnStartTail<T>(fn: () => Promise<T>): Promise<T> };
    }
  ).connectionSupervisor;
}

/** C1: reaches past `private` to read the registry's CURRENT tabId -> sessionId
 * binding directly — the concurrency-interleave test needs this independently
 * of `activeSessionId` to prove the two stay in agreement. */
function sessionIdForTab(backend: AcpBackend, tabId: string): string | undefined {
  return (
    backend as unknown as { sessions: { getByTabId(tabId: string): { sessionId: string } | undefined } }
  ).sessions.getByTabId(tabId)?.sessionId;
}

/** T5b (req 6 test-strengthening): reaches past `private` to read an in-flight
 * ephemeral `OneShotCollector`'s accumulated text DIRECTLY off the registry —
 * proves `handleSessionUpdate` took the ephemeral-FIRST branch (`collector.collect`
 * ran) rather than merely falling through the `sessionId !== this.sessionId`
 * drop guard, which would ALSO leave `messages` empty but for the wrong reason.
 *
 * W6-FI-a: the registry moved onto `OneShotRunner` (3-way ARCH I-4) — reaches
 * ONE hop further (`backend.oneShotRunner.ephemeral`) than before, same as
 * `seam()`'s `ephemeral` field (see {@link SEAM_EPHEMERAL_FIELD}'s doc). */
function ephemeralCollectedText(backend: AcpBackend, sessionId: string): string | undefined {
  const collector = (
    backend as unknown as { oneShotRunner: { ephemeral: Map<string, { collectedText: string }> } }
  ).oneShotRunner.ephemeral.get(sessionId);
  return collector?.collectedText;
}

const delegateStart: AcpSessionUpdate = {
  sessionUpdate: 'tool_call',
  toolCallId: 'tc-1',
  title: 'delegate: refactor the parser',
  kind: 'execute',
  status: 'pending',
  content: [{ content: { type: 'text', text: 'Delegating task:\nrefactor the parser' } }],
};

const delegateComplete: AcpSessionUpdate = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tc-1',
  status: 'completed',
  content: [{ content: { type: 'text', text: 'Delegation results: 1 task in 8s\n\n✅ Task 1: completed' } }],
};

const terminalStart: AcpSessionUpdate = {
  sessionUpdate: 'tool_call',
  toolCallId: 'tc-2',
  title: 'terminal: ls -la',
  kind: 'execute',
  status: 'pending',
  content: null,
};

describe('AcpBackend — Zone SUB: subagents accumulator wiring (ACP delegate_task stream, NOT tui_gateway)', () => {
  it('a delegate_task tool_call/tool_call_update pair emits subagents panel.data pushes reflecting the accumulated snapshot', () => {
    const { backend, messages } = makeBackend();
    backend.sendPrompt('session-1', 'please delegate the refactor', 'default');
    messages.length = 0; // drop turn.start/user from sendPrompt itself

    fireSessionUpdate(backend)('session-1', delegateStart);

    const firstPush = messages.find((m) => m.type === 'panel.data' && m.panel === 'subagents');
    expect(firstPush).toEqual({
      type: 'panel.data',
      panel: 'subagents',
      data: {
        delegations: [
          expect.objectContaining({
            id: 'tc-1',
            goal: 'delegate: refactor the parser',
            status: 'running',
          }),
        ],
      },
      sessionId: 'session-1',
    });

    fireSessionUpdate(backend)('session-1', delegateComplete);

    const pushes = messages.filter((m) => m.type === 'panel.data' && m.panel === 'subagents');
    expect(pushes).toHaveLength(2);
    const lastData = (pushes[1] as { data: SubagentsData }).data;
    expect(lastData.delegations[0]).toMatchObject({ id: 'tc-1', status: 'complete' });
    expect(must(lastData.delegations[0]).detail).toContain('Delegation results: 1 task');
  });

  it('does NOT emit a subagents panel.data push for an unrelated tool_call (e.g. terminal)', () => {
    const { backend, messages } = makeBackend();
    backend.sendPrompt('session-1', 'run a command', 'default');
    messages.length = 0;

    fireSessionUpdate(backend)('session-1', terminalStart);

    expect(messages.some((m) => m.type === 'panel.data' && m.panel === 'subagents')).toBe(false);
  });

  it("switchTab('subagents') returns/pushes the accumulated snapshot WITHOUT dispatching any tui_gateway RPC", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    backend.sendPrompt('session-1', 'please delegate', 'default');
    fireSessionUpdate(backend)('session-1', delegateStart);
    messages.length = 0; // drop turn.start/user + the live fold push above

    // W4-T3b (§7 B6): subagents is per-tab — the fetch carries its scope
    // key explicitly, never an ambient "active session" default.
    const result = await backend.invokeControl('panel.data', { panel: 'subagents', sessionId: 'session-1' });

    expect(control.dispatchCalls).toEqual([]);
    const expected = { delegations: [expect.objectContaining({ id: 'tc-1', status: 'running' })] };
    expect(result).toEqual(expected);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'subagents', data: expected, sessionId: 'session-1' }]);
  });

  // W6-FG (3-way ARCH I-2 — ambient-state-elimination): the `buildPanelDataMessage`
  // subagents/checkpoints scope-key fallbacks no longer read
  // `activeSessionId`/`activeController()` at all — an unscoped fetch falls
  // straight to the terminal sentinel, never an ambient "active session"
  // guess. These are the "no ambient-active value is consumed as a routing
  // input" guard tests the brief calls for.
  it('W6-FG: an unscoped subagents fetch never leaks a poisoned/ghost activeSessionId into the push', async () => {
    const { backend, messages } = makeBackend();
    (backend as unknown as { activeSessionId: string | undefined }).activeSessionId = 'ghost-active';

    const result = await backend.invokeControl('panel.data', { panel: 'subagents' });

    expect(result).toEqual({ delegations: [] });
    const push = messages.find((m) => m.type === 'panel.data' && m.panel === 'subagents');
    // The UNKNOWN_SESSION_ID sentinel — never the ghost 'ghost-active' value.
    expect(push).toMatchObject({ sessionId: 'unknown-session' });
  });

  it("session.load resets the accumulator — a differently-loaded session's subagents panel starts empty", async () => {
    const { backend, client } = makeBackend();
    backend.sendPrompt('session-1', 'please delegate', 'default');
    fireSessionUpdate(backend)('session-1', delegateStart);
    // P2: session.load now REFUSES while a turn is live — end the turn first
    // (this test is about the accumulator reset on load, not live-turn
    // refusal, which the dedicated P2 test above covers). Flush once to let
    // the pre-turn checkpoint barrier resolve so `client.prompt()` is
    // actually called before resolving it, then again to let the success
    // path's `emitTurnEnd` clear `liveTurnId`.
    await flushMicrotasks();
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });
    const result = await backend.invokeControl('panel.data',{ panel: 'subagents' });

    expect(result).toEqual({ delegations: [] });
  });
});

// Create a directory link `link` -> `target`: real symlink on Linux (the CI
// target), NTFS junction fallback on a privilege-less Windows dev box. Both are
// reparse points that `fs.realpath` canonicalizes, so the escape is exercised
// identically on either platform.
function linkDirSync(target: string, link: string): void {
  try {
    symlinkSync(target, link, 'dir');
  } catch {
    symlinkSync(target, link, 'junction');
  }
}
const canLinkDir = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-acp-symcap-'));
    mkdirSync(path.join(dir, 't'));
    linkDirSync(path.join(dir, 't'), path.join(dir, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

describe('AcpBackend.handleReadTextFile — workspace confinement (findings M1 / S-M5)', () => {
  // A synthetic (non-existent) root is fine for the lexical-denial cases: they
  // are rejected by the fast pre-check before any realpath touches the FS.
  const synthRoot = path.resolve('/workspace/project');
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-read-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    mockWorkspace.workspaceFolders = undefined;
  });

  it('reads a file that really lives inside the workspace root', async () => {
    // The realpath-aware handler canonicalizes the path, so it must exist; the
    // read body itself still comes from the mocked `vscode.workspace.fs`.
    const file = path.join(tmpRoot, 'src', 'a.ts');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'on-disk body is irrelevant; read is mocked');
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    mockWorkspace.__fileBody = 'line1\nline2\nline3';
    // Pinned to the mocked-fs path (see `backendWithMockedFsRead`) — on a real
    // Linux host the default confined reader is legitimately `supported()`
    // and would read the on-disk body above instead of the mock.
    const backend = backendWithMockedFsRead();

    const result = await readTextFile(backend)(file, null, null);
    expect(result).toBe('line1\nline2\nline3');
  });

  it('rejects an absolute path outside the workspace (e.g. /etc/passwd) — fail closed', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: synthRoot } }];
    const backend = new AcpBackend({} as HermesRuntimeConfig);

    await expect(
      readTextFile(backend)(path.resolve('/etc/passwd'), null, null),
    ).rejects.toThrow(/outside the workspace/);
  });

  it('rejects a ../ traversal that escapes the root', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: synthRoot } }];
    const backend = new AcpBackend({} as HermesRuntimeConfig);

    await expect(
      readTextFile(backend)(path.join(synthRoot, '..', 'secret.txt'), null, null),
    ).rejects.toThrow(/outside the workspace/);
  });

  it('rejects everything when no workspace is open', async () => {
    mockWorkspace.workspaceFolders = undefined;
    const backend = new AcpBackend({} as HermesRuntimeConfig);

    await expect(
      readTextFile(backend)(path.join(synthRoot, 'a.ts'), null, null),
    ).rejects.toThrow(/outside the workspace/);
  });

  it.skipIf(!canLinkDir)(
    'rejects a read through an in-workspace symlink that escapes, with an add-workspace-folder hint (S-M5)',
    async () => {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-outside-'));
      try {
        await fsp.writeFile(path.join(outside, 'secret.txt'), 'id_rsa');
        // `<ws>/escape` -> outside; a read of `<ws>/escape/secret.txt` escapes.
        linkDirSync(outside, path.join(tmpRoot, 'escape'));
        mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
        const backend = new AcpBackend({} as HermesRuntimeConfig);

        await expect(
          readTextFile(backend)(path.join(tmpRoot, 'escape', 'secret.txt'), null, null),
        ).rejects.toThrow(/add that location as a workspace folder/);
      } finally {
        await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});

describe('AcpBackend.handleReadTextFile — wire-integer validation for line/limit (D3)', () => {
  let tmpRoot: string;
  let file: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-read-linelimit-'));
    file = path.join(tmpRoot, 'a.ts');
    await fsp.writeFile(file, 'on-disk body is irrelevant; read is mocked');
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    mockWorkspace.__fileBody = 'line1\nline2\nline3';
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    mockWorkspace.workspaceFolders = undefined;
  });

  // Every test below reads `file` (which exists inside a valid, open
  // workspace), so every one of them reaches `confinedReader.supported()`.
  // Use `backendWithMockedFsRead()` throughout so the byte source stays
  // pinned to the `__fileBody` mock above on every platform — see that
  // helper's doc for why the default (real) confined reader is unsafe to
  // leave un-pinned here.

  it('rejects a negative limit instead of silently returning an empty window', async () => {
    const backend = backendWithMockedFsRead();

    await expect(readTextFile(backend)(file, 1, -5)).rejects.toThrow(/limit/i);
  });

  it('rejects a NaN line instead of silently returning the whole file from the start', async () => {
    const backend = backendWithMockedFsRead();

    await expect(readTextFile(backend)(file, NaN, 1)).rejects.toThrow(/line/i);
  });

  it('rejects line below 1 (0 is no longer silently treated as line 1)', async () => {
    const backend = backendWithMockedFsRead();

    await expect(readTextFile(backend)(file, 0, null)).rejects.toThrow(/line/i);
  });

  it('rejects a non-integer line', async () => {
    const backend = backendWithMockedFsRead();

    await expect(readTextFile(backend)(file, 1.5, null)).rejects.toThrow(/line/i);
  });

  it('rejects a non-integer limit', async () => {
    const backend = backendWithMockedFsRead();

    await expect(readTextFile(backend)(file, 1, 2.5)).rejects.toThrow(/limit/i);
  });

  it('allows limit:0 as a legitimate empty-window request (only < 0 is rejected)', async () => {
    const backend = backendWithMockedFsRead();

    await expect(readTextFile(backend)(file, 1, 0)).resolves.toBe('');
  });

  it('does not interpolate the rejected wire value into the error message', async () => {
    const backend = backendWithMockedFsRead();

    let caught: unknown;
    try {
      await readTextFile(backend)(file, 1, -5);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('-5');
  });

  it('keeps a valid line/limit window unchanged (line:2, limit:1)', async () => {
    const backend = backendWithMockedFsRead();

    const result = await readTextFile(backend)(file, 2, 1);
    expect(result).toBe('line2');
  });
});

/**
 * F1 (self-DoS hardening, Tier-2 remediation architecture §12.1, task T-13):
 * `handleReadTextFile` used to read the WHOLE file into memory (confined
 * read + `toString` + `split('\n')` over the entire buffer) before ever
 * applying `limit` — a windowed read of a ~1.5 GB workspace file could OOM
 * the extension host on one request. A fake, injected `ConfinedReader`
 * (the new 8th constructor param) proves the wiring without a real O_PATH
 * probe (Linux-only, platform-gated — unreachable on this dev host).
 */
describe('AcpBackend.handleReadTextFile — F1: bounded confined read (self-DoS hardening)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-read-f1-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    mockWorkspace.workspaceFolders = undefined;
  });

  /** A fake confined reader that is always "supported" and records every `maxBytes` it was called with. */
  function fakeConfinedReader(bytes: Buffer): ConfinedReader & { calls: Array<number | undefined> } {
    const calls: Array<number | undefined> = [];
    return {
      calls,
      supported: async () => true,
      readContained: async (_canonicalPath, _roots, maxBytes) => {
        calls.push(maxBytes);
        // Mirrors the REAL confined reader's contract: a bounded read never
        // returns more than `maxBytes` bytes, regardless of how large the
        // underlying file actually is (confinedOpen.test.ts's own F1 tests
        // prove the real implementation honors this at the syscall level).
        return { ok: true, bytes: maxBytes === undefined ? bytes : bytes.subarray(0, maxBytes) };
      },
    };
  }

  it('a windowed request (limit given) caps the confined read at the fixed byte ceiling', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    const file = path.join(tmpRoot, 'huge.ts');
    const reader = fakeConfinedReader(Buffer.from('line1\nline2\nline3\n'));
    const backend = new AcpBackend(
      {} as HermesRuntimeConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );

    await readTextFile(backend)(file, 1, 2);

    expect(reader.calls).toEqual([4 * 1024 * 1024]); // MAX_WINDOWED_READ_BYTES
  });

  it('a whole-file request (limit omitted) reads unbounded — no cap reaches the confined read', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    const file = path.join(tmpRoot, 'huge.ts');
    const reader = fakeConfinedReader(Buffer.from('whole file body'));
    const backend = new AcpBackend(
      {} as HermesRuntimeConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );

    const result = await readTextFile(backend)(file, null, null);

    expect(reader.calls).toEqual([undefined]);
    expect(result).toBe('whole file body');
  });

  it('a pathologically large file: the confined read is truncated at the cap — no crash, no full materialization', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    const file = path.join(tmpRoot, 'huge.ts');
    // ~20 MB "on disk" — far over the 4 MiB cap. The fake caps its OWN
    // returned buffer at maxBytes (exactly like the real bounded reader),
    // proving the caller only ever receives a bounded number of bytes
    // regardless of the file's real size.
    const bigBuffer = Buffer.from((`${'x'.repeat(200)}\n`).repeat(100_000));
    const reader = fakeConfinedReader(bigBuffer);
    const backend = new AcpBackend(
      {} as HermesRuntimeConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );

    const result = await readTextFile(backend)(file, 1, 3);

    expect(reader.calls).toEqual([4 * 1024 * 1024]);
    expect(result.length).toBeLessThan(bigBuffer.byteLength); // never returned the whole 20 MB
  });

  it('a normal small file reads byte-identically whether the cap applies (limit given) or not (limit omitted)', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    const file = path.join(tmpRoot, 'small.ts');
    const body = 'line1\nline2\nline3';

    const withLimit = new AcpBackend(
      {} as HermesRuntimeConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeConfinedReader(Buffer.from(body)),
    );
    const withoutLimit = new AcpBackend(
      {} as HermesRuntimeConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeConfinedReader(Buffer.from(body)),
    );

    // The cap (4 MiB) is far larger than this file — a windowed request
    // still gets the exact SAME bytes as the whole-file request, only
    // sliced by line/limit afterward exactly as before.
    expect(await readTextFile(withLimit)(file, 1, 100)).toBe(body);
    expect(await readTextFile(withoutLimit)(file, null, null)).toBe(body);
  });
});

describe('AcpBackend — Zone CKPT: checkpoint snapshot hook (turn-start, before edits)', () => {
  it('sendPrompt() snapshots the tracker with the incrementing turn ordinal and the (truncated) prompt as the label', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'please refactor the parser', 'default');
    await flushMicrotasks();

    expect(tracker.snapshotCalls).toEqual([
      { turnOrdinal: 1, label: 'please refactor the parser', sessionLabel: 'Session session-1' },
    ]);
  });

  it('increments turnOrdinal across successive prompts, matching the turnId counter', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    // R-A2: Hermes queues (never supersedes) a concurrent prompt, so the host
    // now refuses a second sendPrompt while one is live (see the R-A2 describe
    // block) — end turn 1 before sending turn 2 to exercise genuinely
    // successive turns, matching how a real client can behave post-guard.
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
    backend.sendPrompt('session-1', 'second', 'default');
    await flushMicrotasks();

    // Filter to the C1 pre-turn (before-edits) snapshots this test targets —
    // resolving turn 1 to completion above also fires its unrelated W2-F2
    // after-turn snapshot (phase: 'after'), covered by its own dedicated tests.
    expect(
      tracker.snapshotCalls.filter((c) => c.phase === undefined).map((c) => c.turnOrdinal),
    ).toEqual([1, 2]);
  });

  it('truncates a very long prompt for the checkpoint label', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    const longPrompt = 'x'.repeat(200);

    backend.sendPrompt('session-1', longPrompt, 'default');
    await flushMicrotasks();

    const label = tracker.snapshotCalls[0]?.label ?? '';
    expect(label.length).toBeLessThan(200);
    expect(label.endsWith('…')).toBe(true);
  });

  it('does not throw / break the turn when snapshot() rejects (fire-and-forget safety)', async () => {
    const { backend, tracker, client } = makeBackendWithCheckpoints();
    tracker.snapshot = async () => {
      throw new Error('shadow git boom');
    };

    expect(() => backend.sendPrompt('session-1', 'hello', 'default')).not.toThrow();
    await flushMicrotasks();

    // The turn itself proceeds unaffected.
    expect(client.promptCallCount).toBe(1);
  });

  it('refreshes the checkpoints panel after a successful snapshot', async () => {
    const { backend, tracker, messages } = makeBackendWithCheckpoints();
    tracker.listResult = {
      checkpoints: [
        { id: 'ckpt-1', label: 'Turn 1', age: 'just now', timestamp: '2026-07-11T00:00:00Z', turnOrdinal: 1 },
      ],
    };

    backend.sendPrompt('session-1', 'hello', 'default');
    await flushMicrotasks();

    const push = messages.find((m) => m.type === 'panel.data' && m.panel === 'checkpoints');
    expect(push).toEqual({ type: 'panel.data', panel: 'checkpoints', data: tracker.listResult, rootId: '' });
  });

  it('does nothing (no throw) when no tracker was injected — checkpoints are simply not wired', async () => {
    const { backend, client } = makeBackend();
    expect(() => backend.sendPrompt('session-1', 'hello', 'default')).not.toThrow();
    await flushMicrotasks(); // C1: prompt() runs after the (no-op) barrier
    expect(client.promptCallCount).toBe(1);
  });

  it('(M-3) gives each session-baseline snapshot a DISTINCT (negative) ordinal so repeated New Session cannot collide ids', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    // Drive the session-baseline snapshot directly (start() needs the real
    // spawn/control machinery; warmCheckpointBaseline is the unit under test).
    // W6-FI-c: moved onto `controlDispatcher` — one more reach-through hop.
    const warm = (
      backend as unknown as { controlDispatcher: { warmCheckpointBaseline: () => void } }
    ).controlDispatcher.warmCheckpointBaseline.bind(
      (backend as unknown as { controlDispatcher: unknown }).controlDispatcher,
    );
    warm(); // first New Session
    warm(); // second New Session, unchanged worktree -> same tree
    await flushMicrotasks();

    const baselineOrdinals = tracker.snapshotCalls
      .filter((c) => c.label === 'Session start')
      .map((c) => c.turnOrdinal);
    expect(baselineOrdinals).toHaveLength(2);
    // Distinct (no dup `<tree>-0` id) and never the old colliding 0.
    expect(new Set(baselineOrdinals).size).toBe(2);
    expect(baselineOrdinals).toEqual([-1, -2]);
    // Negative range never overlaps the positive per-turn ordinals (1, 2, …),
    // so a baseline id can't collide with a turn id even on the identical tree.
    expect(baselineOrdinals.every((o) => o < 0)).toBe(true);
  });
});

describe('SessionController — W4-T5b: checkpoint-row session labels (DISPLAY-ONLY — R8)', () => {
  it('the C1 before-snapshot carries a stable sessionLabel derived from the controller\'s own sessionId', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints(); // session-1

    backend.sendPrompt('session-1', 'please refactor the parser', 'default');
    await flushMicrotasks();

    expect(tracker.snapshotCalls[0]?.sessionLabel).toBe('Session session-1');
  });

  it('the W2-F2 after-snapshot ALSO carries the same sessionLabel as its before-snapshot pair', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'the prompt text', 'default');
    await flushMicrotasks();
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    expect(tracker.snapshotCalls.map((c) => c.sessionLabel)).toEqual(['Session session-1', 'Session session-1']);
  });

  it('the label never affects the (turnOrdinal, phase) correlation — the after-snapshot keeps sharing its ordinal with the before-snapshot regardless of the label carried', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'the prompt text', 'default');
    await flushMicrotasks();
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    const [before, after] = tracker.snapshotCalls;
    expect(before?.turnOrdinal).toBe(after?.turnOrdinal); // (turnOrdinal, phase) pairing untouched
    expect(before?.phase).toBeUndefined();
    expect(after?.phase).toBe('after');
  });
});

describe('AcpBackend — C1: the pre-turn checkpoint snapshot is an AWAITED barrier before the turn', () => {
  it('(ordering) does NOT call client.prompt() until the snapshot write-tree resolves — snapshot precedes prompt', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();
    const order: string[] = [];
    const snap = deferred<Checkpoint>();
    // The tracker's snapshot() capture is gated on `snap`: it does not resolve
    // (its `write-tree` is not "done") until the test releases it.
    tracker.snapshot = () => {
      order.push('snapshot:write-tree');
      return snap.promise;
    };
    const realPrompt = client.prompt.bind(client);
    client.prompt = (sessionId: string, content: unknown) => {
      order.push('prompt');
      return realPrompt(sessionId, content);
    };

    backend.sendPrompt('session-1', 'the agent will edit files this turn', 'default');
    await flushMicrotasks();

    // Barrier PENDING: the snapshot has started but prompt() has NOT been called
    // — the agent cannot touch a file yet, so the capture is guaranteed pre-edit.
    expect(order).toEqual(['snapshot:write-tree']);
    expect(client.promptCallCount).toBe(0);

    // Release the snapshot's write-tree; only NOW may the turn proceed.
    snap.resolve(makeCheckpoint(1));
    await flushMicrotasks();

    expect(order).toEqual(['snapshot:write-tree', 'prompt']);
    expect(client.promptCallCount).toBe(1);
  });

  it('(fail-open, visible) proceeds with the turn UNPROTECTED when the snapshot rejects, still emits turn.end, and logs it', async () => {
    const logs: string[] = [];
    const tracker = new FakeCheckpointTracker();
    tracker.snapshot = async () => {
      throw new Error('git executable not found on PATH');
    };
    const backend = new AcpBackend({} as HermesRuntimeConfig, { append: (l) => logs.push(l) }, undefined, tracker);
    const client = new FakeAcpClient();
    seam(backend).client = client;
    seam(backend).sessionId = 'session-1';
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    backend.sendPrompt('session-1', 'do work', 'default');
    await flushMicrotasks();

    // Fail-OPEN: the turn still ran despite the snapshot failure...
    expect(client.promptCallCount).toBe(1);
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'complete')).toBe(true);
    // ...but not SILENTLY: the unprotected turn is surfaced (log/telemetry).
    expect(logs.some((l) => /snapshot failed/.test(l) && /unprotected/.test(l))).toBe(true);
  });

  it('(refused-during-barrier) a second sendPrompt while the first turn is still in its pre-prompt barrier is REFUSED — the first (live) turn is the one that prompts', async () => {
    const { backend, client, tracker, messages } = makeBackendWithCheckpoints();
    const snaps: Array<ReturnType<typeof deferred<Checkpoint>>> = [];
    tracker.snapshot = () => {
      const d = deferred<Checkpoint>();
      snaps.push(d);
      return d.promise;
    };

    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    // R-A2: `liveTurnId` is set synchronously in sendPrompt (BEFORE the awaited
    // pre-prompt barrier), so this second call is refused outright — it neither
    // supersedes turn-1 nor mints a turn-2. (Pre-A2 this test asserted the
    // opposite — supersession dropping the first — which the host no longer does.)
    backend.sendPrompt('session-1', 'second — refused', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(0); // turn-1's barrier still pending; turn-2 never started
    expect(snaps).toHaveLength(1); // only turn-1 ever reached the barrier
    expect(messages.some((m) => m.type === 'error' && /already running/.test(m.message))).toBe(true);

    snaps.forEach((d) => d.resolve(makeCheckpoint(1)));
    await flushMicrotasks();

    // The LIVE turn-1 (not the refused second) is what actually prompts.
    expect(client.promptCallCount).toBe(1);
    const content = client.lastPromptContent as Array<{ type: string; text?: string }>;
    expect(content.some((b) => b.text === 'first')).toBe(true);
  });

  it('(cancel-during-barrier) a cancel while the barrier pends ends the turn (cancelled) WITHOUT ever calling prompt()', async () => {
    const { backend, client, tracker, messages } = makeBackendWithCheckpoints();
    const snap = deferred<Checkpoint>();
    tracker.snapshot = () => snap.promise;

    backend.sendPrompt('session-1', 'will cancel mid-barrier', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(0);

    backend.cancel('session-1'); // lands DURING the barrier — before session/prompt is sent
    snap.resolve(makeCheckpoint(1));
    await flushMicrotasks();

    expect(client.promptCallCount).toBe(0); // prompt never sent
    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'cancelled')).toBe(true);
  });
});

describe('AcpBackend — T2c: @-mentions resolve in parallel with the C1 barrier (P1 guard)', () => {
  const mentionRef: ContextRef = { id: 'ref-1', kind: 'file', path: '/repo/a.ts' };
  const resolvedMention: ResolvedContext = {
    ref: mentionRef,
    uri: 'file:///repo/a.ts',
    title: 'a.ts',
    linkOnly: true,
  };

  /**
   * V-19 (Tier-2 T-12): `buildPromptContent` now confines `Attachment.path`
   * to the workspace before building its `file:` URI, reusing
   * `resolveWithinWorkspaceReal` — which fails closed (denies) when NO
   * workspace root is open, exactly like the mention path's own
   * `resolveWithinWorkspaceReal`-backed confinement already does. These two
   * tests predate V-19 and only cared about mention-resolution ordering, so
   * neither ever mocked `vscode.workspace.workspaceFolders` — their
   * literal `'/repo/b.ts'` attachment path is a fictional path that cannot
   * resolve under any real root, so it is now correctly DROPPED instead of
   * (as before the fix) sent unconfined. Giving them a real, resolvable
   * workspace root restores the ORIGINAL intent (the attachment survives,
   * unrelated to the mention-parallelism assertions each test actually
   * exercises) without weakening V-19's fail-closed default anywhere else.
   * `mentionRef`/`resolvedMention` above are untouched by this: they flow
   * through the (mocked) `FakeMentionResolver`, never through
   * `confineAttachmentPaths`.
   */
  let tmpRoot: string;
  let attachmentPath: string;
  let attachmentUri: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-mention-p1-'));
    const real = await fsp.realpath(tmpRoot);
    attachmentPath = path.join(real, 'b.ts');
    // Mirrors attachments.ts's private `pathToFileUri` exactly (no shared
    // export exists to reuse — see that file's own doc comment for why the
    // conversion looks like this).
    const normalized = attachmentPath.replace(/\\/g, '/');
    attachmentUri = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: real } }];
  });

  afterEach(async () => {
    mockWorkspace.workspaceFolders = undefined;
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves mentions IN PARALLEL with the snapshot barrier (Promise.all — neither hop blocks the other from starting, both must settle before prompt()) and appends mentionBlocks AFTER buildPromptContent blocks', async () => {
    const resolver = new FakeMentionResolver();
    const { backend, client, tracker } = makeBackendWithCheckpoints(resolver);
    const order: string[] = [];
    const snap = deferred<Checkpoint>();
    tracker.snapshot = () => {
      order.push('snapshot:start');
      return snap.promise;
    };
    const resolve = deferred<ResolvedContext[]>();
    resolver.setImpl((refs) => {
      order.push('resolve:start');
      expect(refs).toEqual([mentionRef]);
      return resolve.promise;
    });

    backend.sendPrompt('session-1',
      'hello',
      'default',
      [{ id: 'att-1', name: 'b.ts', kind: 'file', path: attachmentPath }],
      [mentionRef],
    );
    await flushMicrotasks();

    // Both hops already STARTED before either settled — proves Promise.all
    // concurrency (a sequential await-then-await would only ever show one
    // 'start' at this point).
    expect(order).toEqual(['snapshot:start', 'resolve:start']);
    expect(client.promptCallCount).toBe(0);

    // Settling ONLY the snapshot must not be enough — Promise.all needs BOTH
    // legs to resolve before the barrier clears.
    snap.resolve(makeCheckpoint(1));
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(0);

    // Now settle resolution too — the barrier clears and the turn proceeds.
    // V-19: confining the attachment's path now runs through REAL fs
    // (`resolveWithinWorkspaceReal`'s `realpath`/`lstat`) after the barrier
    // clears — real I/O, not just microtasks — so poll instead of a fixed
    // `flushMicrotasks()` count (same idiom `waitForApprovalCard` already
    // uses above for the sibling real-canonicalization seam).
    resolve.resolve([resolvedMention]);
    await vi.waitFor(() => expect(client.promptCallCount).toBe(1));

    const content = client.lastPromptContent as Array<{
      type: string;
      text?: string;
      uri?: string;
      name?: string;
    }>;
    expect(content.map((b) => b.type)).toEqual(['text', 'resource_link', 'resource_link']);
    expect(content[0]).toEqual({ type: 'text', text: 'hello' });
    // The attachment block (from buildPromptContent) precedes the mention
    // block (from mentionBlocks) — mentionBlocks are appended AFTER, never
    // interleaved or prepended.
    expect(content[1]?.uri).toBe(attachmentUri);
    expect(content[2]).toEqual({ type: 'resource_link', uri: 'file:///repo/a.ts', name: 'a.ts' });
  });

  it('(P1 guard) a resolver that THROWS resolves to [] via resolveMentionsSafe — the turn still proceeds and completes, never stuck (liveTurnId released only by emitTurnEnd)', async () => {
    const resolver = new FakeMentionResolver();
    resolver.setImpl(async () => {
      throw new Error('resolver boom');
    });
    const logs: string[] = [];
    const tracker = new FakeCheckpointTracker();
    const backend = new AcpBackend(
      {} as HermesRuntimeConfig,
      { append: (l) => logs.push(l) },
      undefined,
      tracker,
      undefined,
      resolver,
    );
    const client = new FakeAcpClient();
    seam(backend).client = client;
    seam(backend).sessionId = 'session-1';
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    backend.sendPrompt('session-1', 'do work', 'default', undefined, [mentionRef]);
    await flushMicrotasks();

    // The turn was never stuck: prompt() fired despite the resolver throwing.
    expect(client.promptCallCount).toBe(1);
    const content = client.lastPromptContent as Array<{ type: string; text?: string }>;
    expect(content).toEqual([{ type: 'text', text: 'do work' }]); // no mention blocks — resolved to []
    // The failure is surfaced (fail-open, visible — same discipline as the
    // snapshot barrier's own fail-open logging), never a silent catch.
    expect(logs.some((l) => /mention/i.test(l) && /resolver boom/.test(l))).toBe(true);

    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    // A real turn.end fired (liveTurnId is released ONLY by emitTurnEnd) —
    // the void runner never saw the resolver's rejection.
    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'complete')).toBe(true);
    expect(seam(backend).liveTurnId).toBeUndefined();

    // A second prompt is accepted afterward — proves the composer never got
    // locked (the P1 locked-composer failure class this guard prevents).
    backend.sendPrompt('session-1', 'second', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(2);
  });

  it('(supersede-during-barrier) a prompt SUPERSEDED while the resolver+snapshot barrier is pending still drops without ever calling client.prompt() — guard intact even with a resolver installed', async () => {
    const resolver = new FakeMentionResolver();
    const { backend, client, tracker } = makeBackendWithCheckpoints(resolver);
    const snap = deferred<Checkpoint>();
    tracker.snapshot = () => snap.promise;
    const resolve = deferred<ResolvedContext[]>();
    resolver.setImpl(() => resolve.promise);

    backend.sendPrompt('session-1', 'will be superseded', 'default', undefined, [mentionRef]);
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(0);

    // Simulate a supersede (New Session / a second admitted turn) landing
    // while BOTH the snapshot and the mention resolution are still pending —
    // resolution widens the pre-prompt window, so this re-check must still
    // catch it (same guard `runTurn` uses, re-checked AFTER the Promise.all).
    seam(backend).currentTurnId = 'turn-2';

    snap.resolve(makeCheckpoint(1));
    resolve.resolve([resolvedMention]);
    await flushMicrotasks();

    expect(client.promptCallCount).toBe(0); // dropped — never sent
  });

  it('(cancel-during-barrier) a cancel while the resolver+snapshot barrier is pending still ends the turn cancelled and never calls client.prompt()', async () => {
    const resolver = new FakeMentionResolver();
    const { backend, client, tracker, messages } = makeBackendWithCheckpoints(resolver);
    const snap = deferred<Checkpoint>();
    tracker.snapshot = () => snap.promise;
    const resolve = deferred<ResolvedContext[]>();
    resolver.setImpl(() => resolve.promise);

    backend.sendPrompt('session-1', 'will cancel mid-barrier', 'default', undefined, [mentionRef]);
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(0);

    backend.cancel('session-1'); // lands DURING the barrier — before session/prompt is sent
    snap.resolve(makeCheckpoint(1));
    resolve.resolve([resolvedMention]);
    await flushMicrotasks();

    expect(client.promptCallCount).toBe(0);
    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'cancelled')).toBe(true);
  });

  it("no resolver installed => content is EXACTLY today's buildPromptContent output (no regression), even when mentions are supplied — the feature stays inert until T2d wires a real resolver", async () => {
    const { backend, client } = makeBackend(); // no resolver injected
    backend.sendPrompt('session-1',
      'hello',
      'default',
      [{ id: 'att-1', name: 'b.ts', kind: 'file', path: attachmentPath }],
      [mentionRef],
    );
    // V-19: real fs (`realpath`/`lstat`) backs the attachment confinement
    // step now — poll rather than a fixed microtask-flush count (see the
    // sibling test above for the full rationale).
    await vi.waitFor(() => expect(client.promptCallCount).toBe(1));

    const content = client.lastPromptContent as Array<{ type: string; text?: string; uri?: string; name?: string }>;
    expect(content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: attachmentUri, name: 'b.ts' },
    ]);
  });
});

describe('AcpBackend — W2-F2 Phase 0: after-turn checkpoint on every terminal status', () => {
  it('a cleanly completed turn fires an after-snapshot with the SAME ordinal and phase "after", after the before-snapshot', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'the prompt text', 'default');
    await flushMicrotasks(); // C1 barrier resolves -> before-snapshot recorded, prompt() in flight
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks(); // runTurn settles -> emitTurnEnd(complete) -> after-snapshot

    // The after half of the pair: same (positive) ordinal, phase 'after', an
    // EXPLICIT neutral label (W4-T2 Deliverable 6 — root-scoped ordinals
    // make the tracker's own numeric "After turn N" fallback misleading
    // across tabs, so SessionController passes a non-numeric label instead
    // of `undefined`), and it lands AFTER the C1 before-barrier — proving
    // the pair is ordered before(N) then after(N).
    expect(tracker.snapshotCalls).toEqual([
      { turnOrdinal: 1, label: 'the prompt text', sessionLabel: 'Session session-1' }, // C1 barrier (before)
      { turnOrdinal: 1, label: 'After turn', phase: 'after', sessionLabel: 'Session session-1' }, // W2-F2 after
    ]);
  });

  it('a CANCELLED turn still fires the after-snapshot (R3: partial edits must be captured)', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'do work then stop', 'default');
    await flushMicrotasks();
    // The in-flight prompt resolving with stopReason 'cancelled' drives
    // emitTurnEnd(cancelled) — the interrupted turn's bytes must still be captured.
    client.resolveInFlightPrompt({ stopReason: 'cancelled' });
    await flushMicrotasks();

    expect(tracker.snapshotCalls).toContainEqual({
      turnOrdinal: 1,
      label: 'After turn',
      phase: 'after',
      sessionLabel: 'Session session-1',
    });
  });

  it('an ERRORED turn still fires the after-snapshot (R3)', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'do work then blow up', 'default');
    await flushMicrotasks();
    // A rejected prompt drives the catch-path emitTurnEnd(error) — same R3 rule.
    client.rejectInFlightPrompt(new Error('boom: connection reset'));
    await flushMicrotasks();

    expect(tracker.snapshotCalls).toContainEqual({
      turnOrdinal: 1,
      label: 'After turn',
      phase: 'after',
      sessionLabel: 'Session session-1',
    });
  });

  it('call order across turns is before(1), after(1), before(2) (R4)', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();

    backend.sendPrompt('session-1', 'first', 'default');
    await flushMicrotasks();
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
    backend.sendPrompt('session-1', 'second', 'default');
    await flushMicrotasks();

    // after(1) is INITIATED synchronously on turn 1's end (R4), so it can never
    // reorder behind turn 2's before-barrier.
    expect(tracker.snapshotCalls).toEqual([
      { turnOrdinal: 1, label: 'first', sessionLabel: 'Session session-1' },
      { turnOrdinal: 1, label: 'After turn', phase: 'after', sessionLabel: 'Session session-1' },
      { turnOrdinal: 2, label: 'second', sessionLabel: 'Session session-1' },
    ]);
  });

  it('the after-snapshot refreshes the checkpoints panel (panel.data push)', async () => {
    const { backend, client, tracker, messages } = makeBackendWithCheckpoints();
    tracker.listResult = {
      checkpoints: [
        { id: 'ckpt-1', label: 'Turn 1', age: 'just now', timestamp: '2026-07-11T00:00:00Z', turnOrdinal: 1 },
      ],
    };

    backend.sendPrompt('session-1', 'hello', 'default');
    await flushMicrotasks();
    messages.length = 0; // drop the before-snapshot's refresh + the turn.start/user messages
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    const push = messages.find((m) => m.type === 'panel.data' && m.panel === 'checkpoints');
    expect(push).toEqual({ type: 'panel.data', panel: 'checkpoints', data: tracker.listResult, rootId: '' });
  });

  it('an after-snapshot rejection is logged and swallowed — turn.end already emitted, nothing throws', async () => {
    const logs: string[] = [];
    const tracker = new FakeCheckpointTracker();
    // Fail ONLY the after-snapshot: the C1 before-barrier succeeds, then the
    // phase:'after' call rejects — the failure must be surfaced (log), swallowed.
    tracker.snapshot = async (_ordinal: number, _label?: string, opts?: { phase?: CheckpointPhase }) => {
      if (opts?.phase === 'after') throw new Error('after write-tree boom');
      return null;
    };
    const backend = new AcpBackend({} as HermesRuntimeConfig, { append: (l) => logs.push(l) }, undefined, tracker);
    const client = new FakeAcpClient();
    seam(backend).client = client;
    seam(backend).sessionId = 'session-1';
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    backend.sendPrompt('session-1', 'do work', 'default');
    await flushMicrotasks();
    expect(() => client.resolveInFlightPrompt({ stopReason: 'end_turn' })).not.toThrow();
    await flushMicrotasks();

    // turn.end is emitted BEFORE the after-snapshot is awaited (fire-and-forget),
    // so the rejection can never un-emit it...
    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'complete')).toBe(true);
    // ...and it is surfaced, not silent.
    expect(logs.some((l) => /after-turn checkpoint failed/.test(l))).toBe(true);
  });

  it('loadSession historical replay emits turn.end WITHOUT any after-snapshot (replay must not snapshot)', async () => {
    const { backend, tracker, messages } = makeBackendWithCheckpoints();

    // A successful session/load fires turn.end DIRECTLY (bypassing emitTurnEnd),
    // so a pure history replay — which made no edits — records no after-snapshot.
    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws/old' });

    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'complete')).toBe(true);
    expect(tracker.snapshotCalls.some((c) => c.phase === 'after')).toBe(false);
  });

  it('a FAILED loadSession (mid-replay error) still emits turn.end(error) + settles subagents, but records NO after-snapshot', async () => {
    const { backend, client, tracker, messages } = makeBackendWithCheckpoints();
    // Mid-replay failure: the load streams one delegate_task START (a running
    // delegation) through the ordinary session/update path, then rejects — the
    // exact X4 error branch. A load turn made no NEW edits, so even its ERROR
    // exit must never take an "After turn N" snapshot: over a worktree that had
    // diverged from the last stored checkpoint, dedup could not null it and an
    // orphan after-row would appear for a turn that never ran.
    client.loadSession = async (_cwd: string, sessionId: string) => {
      fireSessionUpdate(backend)(sessionId, delegateStart);
      throw new Error('history store corrupt');
    };

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws/old' });
    await flushMicrotasks();

    // The branch's pre-existing behavior still holds: error surfaced, turn ended...
    expect(messages.some((m) => m.type === 'error')).toBe(true);
    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'error')).toBe(true);
    // ...and the X4 settle still flips the mid-replay delegation to interrupted
    // (the LAST subagents push carries the settled fold).
    const pushes = messages.filter((m) => m.type === 'panel.data' && m.panel === 'subagents');
    expect(pushes.length).toBeGreaterThan(0);
    const lastData = (pushes[pushes.length - 1] as { data: SubagentsData }).data;
    expect(lastData.delegations[0]).toMatchObject({ id: 'tc-1', status: 'interrupted' });
    // The W2-F2 rule: NO after-snapshot for a load/replay turn, even on error.
    expect(tracker.snapshotCalls.some((c) => c.phase === 'after')).toBe(false);
  });

  it('no tracker wired → the emitTurnEnd after-hook is a no-op (no throw)', async () => {
    const { backend, client } = makeBackend();

    backend.sendPrompt('session-1', 'do work', 'default');
    await flushMicrotasks();
    // Completing the turn drives emitTurnEnd -> snapshotAfterTurn, which must
    // early-return cleanly when no tracker is wired.
    expect(() => client.resolveInFlightPrompt({ stopReason: 'end_turn' })).not.toThrow();
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(1);
  });
});

describe('AcpBackend.invokeControl — X1: Chat tab / non-data panel never dispatches panel.data', () => {
  it("panel.data for 'chat' (no PanelSource) early-returns undefined WITHOUT any tui_gateway dispatch", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);

    const result = await backend.invokeControl('panel.data', { panel: 'chat' });

    expect(result).toBeUndefined();
    expect(control.dispatchCalls).toEqual([]); // no bogus panel.data RPC -> no reject
    expect(messages).toEqual([]);
  });

  it('panel.data / switchTab with no panel at all also early-returns cleanly (no dispatch)', async () => {
    const { backend } = makeBackend();
    const control = withFakeControl(backend);

    expect(await backend.invokeControl('panel.data', {})).toBeUndefined();
    expect(await backend.invokeControl('panel.data',{ panel: 'chat' })).toBeUndefined();
    expect(control.dispatchCalls).toEqual([]);
  });
});

describe('AcpBackend.invokeControl — S-M4: host-side runtime allowlist', () => {
  it('REJECTS a removed session-coupled method (rollback.restore) host-side instead of dispatching it', async () => {
    const { backend } = makeBackend();
    const control = withFakeControl(backend);

    await expect(backend.invokeControl('rollback.restore', { id: 'x' })).rejects.toThrow(
      /disallowed control method/,
    );
    expect(control.dispatchCalls).toEqual([]);
  });

  it('REJECTS an arbitrary unknown method string (a compromised webview can send any string)', async () => {
    const { backend } = makeBackend();
    const control = withFakeControl(backend);

    await expect(backend.invokeControl('session.usage')).rejects.toThrow(/disallowed/);
    await expect(backend.invokeControl('evil.method')).rejects.toThrow(/disallowed/);
    expect(control.dispatchCalls).toEqual([]);
  });

  it('still forwards a legit allowlisted method (config.set)', async () => {
    const { backend } = makeBackend();
    const control = withFakeControl(backend);
    control.setNextResult({ ok: true });

    const result = await backend.invokeControl('config.set', { key: 'x', value: 1 });

    expect(result).toEqual({ ok: true });
    expect(control.dispatchCalls).toEqual([{ method: 'config.set', params: { key: 'x', value: 1 } }]);
  });
});

describe('AcpBackend.loadSession — S-M4 / Sec-M2: cwd confined to an open workspace folder (realpath)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-load-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    mockWorkspace.workspaceFolders = undefined;
  });

  it('denies a session.load whose cwd is outside every open workspace folder — CF-14: emits tab.error{kind:"open-failed"} (legacy caller, tabId defaults to BOOTSTRAP_TAB_ID) instead of the old silent no-op', async () => {
    const { backend, client, messages } = makeBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];

    const result = await backend.invokeControl('session.load', {
      sessionId: 's',
      cwd: path.resolve('/etc'),
    });

    expect(result).toBeUndefined();
    expect(client.loadSessionCalls).toEqual([]);
    expect(messages).toEqual([
      { type: 'tab.error', tabId: BOOTSTRAP_TAB_ID, kind: 'open-failed', message: expect.any(String) },
    ]);
  });

  it('allows a session.load whose cwd really lives inside an open workspace folder', async () => {
    const { backend, client } = makeBackend();
    const project = path.join(tmpRoot, 'project');
    await fsp.mkdir(project, { recursive: true });
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];

    await backend.invokeControl('session.load', { sessionId: 's', cwd: project });

    expect(client.loadSessionCalls).toEqual([{ cwd: project, sessionId: 's', mcpServers: [] }]);
  });

  it.skipIf(!canLinkDir)(
    'denies a cwd that reaches outside through an in-workspace directory symlink (Sec-M2: realpath parity, not the old lexical check)',
    async () => {
      const { backend, client } = makeBackend();
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-acp-load-outside-'));
      try {
        // `<ws>/escape` -> outside; a load with cwd `<ws>/escape` is LEXICALLY
        // inside the root but its realpath escapes it.
        linkDirSync(outside, path.join(tmpRoot, 'escape'));
        mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];

        const result = await backend.invokeControl('session.load', {
          sessionId: 's',
          cwd: path.join(tmpRoot, 'escape'),
        });

        // The lexical predicate would have WRONGLY allowed this; the realpath
        // upgrade denies it (parity with readTextFile + checkpoint-restore).
        expect(result).toBeUndefined();
        expect(client.loadSessionCalls).toEqual([]);
      } finally {
        await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  it('R-C3: a successful load updates this.cwd to the realpath-confined load cwd (policy base follows the session)', async () => {
    const { backend } = makeBackend();
    const project = path.join(tmpRoot, 'project');
    await fsp.mkdir(project, { recursive: true });
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    seam(backend).cwd = '/original/workspace-a';

    await backend.invokeControl('session.load', { sessionId: 's', cwd: project });

    const confined = await fsp.realpath(project);
    expect(seam(backend).cwd).toBe(confined);
  });

  it('R-C3: a DENIED load (cwd outside the workspace) leaves this.cwd untouched', async () => {
    const { backend, client } = makeBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: tmpRoot } }];
    seam(backend).cwd = '/original/workspace-a';

    await backend.invokeControl('session.load', { sessionId: 's', cwd: path.resolve('/etc') });

    expect(client.loadSessionCalls).toEqual([]);
    expect(seam(backend).cwd).toBe('/original/workspace-a');
  });

  it('R-C3: with NO workspace folders open (confinement skipped) the raw cwd is adopted', async () => {
    mockWorkspace.workspaceFolders = undefined;
    const { backend } = makeBackend();
    seam(backend).cwd = '/original/workspace-a';

    await backend.invokeControl('session.load', { sessionId: 's', cwd: '/ws/raw-b' });

    expect(seam(backend).cwd).toBe('/ws/raw-b');
  });
});

describe('AcpBackend.invokeControl — X3: Sessions "Load more" APPENDS pages (host-side accumulation)', () => {
  it('page 2 (with cursor) appends onto page 1 rather than replacing it', async () => {
    const { backend, client, messages } = makeBackend();

    client.setListSessionsResult({
      sessions: [
        { session_id: 's1', cwd: '/ws', title: 'a', updated_at: 't1' },
        { session_id: 's2', cwd: '/ws', title: 'b', updated_at: 't2' },
      ],
      next_cursor: 'c2',
    });
    const page1 = (await backend.invokeControl('panel.data',{ panel: 'sessions' })) as SessionsData;
    expect(page1.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(page1.nextCursor).toBe('c2');

    client.setListSessionsResult({
      sessions: [{ session_id: 's3', cwd: '/ws', title: 'c', updated_at: 't3' }],
      next_cursor: null,
    });
    const page2 = (await backend.invokeControl('session.list', { cursor: 'c2' })) as SessionsData;

    // The full accumulated list (page 1 + page 2), not just page 2.
    expect(page2.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(page2.nextCursor).toBeUndefined();

    const pushes = messages.filter((m) => m.type === 'panel.data' && m.panel === 'sessions');
    const lastData = (pushes[pushes.length - 1] as { data: SessionsData }).data;
    expect(lastData.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('a fresh (cursor-less) fetch RESETS the accumulation instead of stacking pages', async () => {
    const { backend, client } = makeBackend();
    client.setListSessionsResult({ sessions: [{ session_id: 's1', cwd: '/ws' }], next_cursor: 'c2' });
    await backend.invokeControl('panel.data',{ panel: 'sessions' });

    client.setListSessionsResult({ sessions: [{ session_id: 's2', cwd: '/ws' }], next_cursor: null });
    const fresh = (await backend.invokeControl('panel.data',{ panel: 'sessions' })) as SessionsData;

    expect(fresh.sessions.map((s) => s.id)).toEqual(['s2']); // page 1 dropped by the reset
  });

  it('A#7 re-entrancy: two overlapping "Load more" (same cursor) coalesce into ONE listSessions call (no double-append)', async () => {
    const { backend, client } = makeBackend();
    client.setListSessionsResult({
      sessions: [{ session_id: 's1', cwd: '/ws', title: 'a', updated_at: 't1' }],
      next_cursor: 'c3',
    });

    // Fire both WITHOUT awaiting the first, so the second lands while the first
    // is still in flight — the guard must coalesce it onto the same fetch.
    const [p1, p2] = [
      backend.invokeControl('session.list', { cursor: 'c2' }),
      backend.invokeControl('session.list', { cursor: 'c2' }),
    ];
    const results = (await Promise.all([p1, p2])) as SessionsData[];
    const r1 = must(results[0]);
    const r2 = must(results[1]);

    // Exactly ONE ACP call for cursor c2 (the double-click didn't double-fetch).
    expect(client.listSessionsCalls.filter((c) => c.cursor === 'c2')).toHaveLength(1);
    // And 's1' appears exactly once (no double-append), on both resolved values.
    expect(r1.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(r2.sessions.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('AcpBackend — X4: delegations stuck running when a turn is cancelled/errored', () => {
  it('flips a still-running delegation to interrupted on a CANCELLED turn.end (+ pushes the refreshed panel)', async () => {
    const { backend, client, messages } = makeBackend();
    backend.sendPrompt('session-1', 'delegate then cancel', 'default');
    await flushMicrotasks();
    fireSessionUpdate(backend)('session-1', delegateStart); // one running delegation
    messages.length = 0;

    client.resolveInFlightPrompt({ stopReason: 'cancelled' });
    await flushMicrotasks();

    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'cancelled')).toBe(true);
    const push = messages.find((m) => m.type === 'panel.data' && m.panel === 'subagents');
    expect(push).toBeDefined();
    expect((push as { data: SubagentsData }).data.delegations[0]).toMatchObject({
      id: 'tc-1',
      status: 'interrupted',
    });
  });

  it('a cleanly COMPLETED turn does not spuriously touch an already-resolved delegation', async () => {
    const { backend, client, messages } = makeBackend();
    backend.sendPrompt('session-1', 'delegate then finish', 'default');
    await flushMicrotasks();
    fireSessionUpdate(backend)('session-1', delegateStart);
    fireSessionUpdate(backend)('session-1', delegateComplete); // tc-1 -> complete
    messages.length = 0;

    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    expect(messages.some((m) => m.type === 'turn.end' && m.status === 'complete')).toBe(true);
    // No spurious subagents push (nothing was running to interrupt).
    expect(messages.some((m) => m.type === 'panel.data' && m.panel === 'subagents')).toBe(false);
  });

  it('(replay) a delegation still running at the END of a session/load replay is settled to interrupted, with no fabricated startedAt', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    const client = must(clients[0]);
    // History replays a delegate_task START but NO completion (the session was cancelled).
    client.setReplayUpdates([delegateStart]);
    client.setLoadSessionResult({ found: true, currentModeId: 'default' });

    await backend.invokeControl('session.load', { sessionId: 'old', cwd: '/ws/old' });
    const result = (await backend.invokeControl('panel.data', {
      panel: 'subagents',
      sessionId: 'old',
    })) as SubagentsData;

    expect(result.delegations[0]).toMatchObject({ id: 'tc-1', status: 'interrupted' });
    expect(must(result.delegations[0]).startedAt).toBeUndefined(); // replayed -> not fabricated as now()
  });
});

describe('AcpBackend.invokeControl — Zone CKPT: checkpoints panel refresh', () => {
  it("switchTab('checkpoints') calls tracker.list() and emits the exact CheckpointsData as panel.data (no reshaping needed)", async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();
    tracker.listResult = {
      checkpoints: [
        { id: 'ckpt-2', label: 'Turn 2', age: '1m ago', timestamp: '2026-07-11T00:01:00Z', turnOrdinal: 2 },
        { id: 'ckpt-1', label: 'Turn 1', age: '2m ago', timestamp: '2026-07-11T00:00:00Z', turnOrdinal: 1 },
      ],
    };

    const result = await backend.invokeControl('panel.data',{ panel: 'checkpoints' });

    expect(result).toEqual(tracker.listResult);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'checkpoints', data: tracker.listResult, rootId: '' }]);
  });

  it('marks the panel unavailable (instead of throwing) when the tracker rejects — e.g. GitUnavailableError', async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();
    tracker.listError = new Error('git executable not found on PATH; checkpoints are disabled');

    const result = await backend.invokeControl('panel.data',{ panel: 'checkpoints' });

    const expected: CheckpointsData = {
      checkpoints: [],
      available: false,
      unavailableReason: 'git executable not found on PATH; checkpoints are disabled',
    };
    expect(result).toEqual(expected);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'checkpoints', data: expected, rootId: '' }]);
  });

  it('marks the panel unavailable when no tracker was injected (e.g. no workspace open)', async () => {
    const { backend, messages } = makeBackend();

    const result = await backend.invokeControl('panel.data',{ panel: 'checkpoints' });

    expect(result).toMatchObject({ checkpoints: [], available: false });
    expect(messages).toEqual([
      { type: 'panel.data', panel: 'checkpoints', data: expect.objectContaining({ available: false }), rootId: '' },
    ]);
  });

  // W6-FG (3-way ARCH I-2 — ambient-state-elimination guard test): with 2+
  // registered roots (so `withDefaultCheckpointsScope`'s single-root
  // convenience does NOT fill in a default), an unscoped checkpoints fetch
  // must fall to the honest empty sentinel — never the ambient "active"
  // session's REAL rootId, even though that session (and its non-empty
  // rootId) genuinely exists.
  it('an unscoped checkpoints fetch (2+ roots — no single-root default) never leaks the ambient "active" session\'s REAL rootId into the push', async () => {
    const { backend, messages } = makeBackend(); // session-1 @ its own (default) root
    seam(backend).cwd = '/root-b';
    seam(backend).sessionId = 'session-2'; // a SECOND controller on a DIFFERENT root — becomes ambient "active"
    const activeRootId = (
      backend as unknown as { resolveRootCoordinator(cwd: string): { rootId: string } }
    ).resolveRootCoordinator('/root-b').rootId;
    expect(activeRootId).not.toBe(''); // sanity: session-2's root is a REAL, non-empty id

    await backend.invokeControl('panel.data', { panel: 'checkpoints' }); // no rootId in params

    const push = messages.find((m) => m.type === 'panel.data' && m.panel === 'checkpoints');
    // The honest empty sentinel — never session-2's real (ambient-"active") rootId.
    expect(push).toMatchObject({ rootId: '' });
  });
});

describe('AcpBackend.invokeControl — Zone CKPT: checkpoint.restore round trip (dirty-worktree guard preserved)', () => {
  it('calls tracker.restore(id) and, on success, RETURNS the RestoreResult (correlated response) + refreshes the list', async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();
    tracker.restoreResult = { restored: true, filesChanged: 2, changedPaths: ['a.ts', 'b.ts'] };
    tracker.listResult = { checkpoints: [] };

    const result = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    expect(tracker.restoreCalls).toEqual([{ id: 'ckpt-1', force: undefined }]);
    // Part A2 reference migration: the RestoreResult rides back on the resolved
    // value (the correlated control.response), NOT a bespoke
    // `checkpoint.restoreResult` push (which was removed from the protocol).
    expect(result).toEqual(tracker.restoreResult);
    // Only the server-initiated checkpoints refresh remains on the wire.
    expect(messages).toEqual([
      { type: 'panel.data', panel: 'checkpoints', data: tracker.listResult, rootId: '' },
    ]);
  });

  it('does NOT force by default — a dirty-worktree-guard refusal ({restored:false, reason}) is surfaced (returned), not silently retried', async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();
    tracker.restoreResult = {
      restored: false,
      reason: 'Refusing to restore: the worktree has changes since the last checkpoint. Pass { force: true } to override.',
    };

    const result = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    expect(tracker.restoreCalls).toEqual([{ id: 'ckpt-1', force: undefined }]);
    // The refusal is the resolved value; no auto-retry/force, and (not restored)
    // no panel refresh — so nothing at all is pushed.
    expect(result).toEqual(tracker.restoreResult);
    expect(messages).toEqual([]);
  });

  it('passes { force: true } through untouched when the webview explicitly re-invokes with force (the "Restore anyway" path)', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    tracker.restoreResult = { restored: true, filesChanged: 1, changedPaths: ['big.dat'] };

    await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1', force: true });

    expect(tracker.restoreCalls).toEqual([{ id: 'ckpt-1', force: true }]);
  });

  it('T-C2 (closes V-17): refuses with the pinned NO_TRACKER_RESTORE_REFUSAL (never a bare undefined) when no tracker was injected', async () => {
    const { backend, messages } = makeBackend();

    const result = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    expect(result).toEqual({
      restored: false,
      reason: 'Checkpoints are not available for this workspace — nothing was restored.',
    });
    expect(messages).toEqual([]);
  });

  it('T-C2 (closes V-17): refuses with the pinned MALFORMED_RESTORE_REFUSAL (never a bare undefined) when the request is missing a checkpoint id', async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();

    const result = await backend.invokeControl('checkpoint.restore', {});

    expect(result).toEqual({
      restored: false,
      reason: 'Malformed restore request (missing checkpoint id) — nothing was restored.',
    });
    expect(tracker.restoreCalls).toEqual([]); // the tracker was never reached
    expect(messages).toEqual([]);
  });

  it('surfaces an unexpected tracker.restore() rejection as a restored:false result instead of throwing', async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();
    tracker.restore = async () => {
      throw new Error('shadow git corrupt');
    };

    const result = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    // Converted to a restored:false RESULT (returned on the correlated
    // response), not thrown and not pushed as a bespoke message.
    expect(result).toEqual({ restored: false, reason: 'shadow git corrupt' });
    expect(messages).toEqual([]);
  });

  it('rides skippedPaths (symlink-escape refusals, Zone Z9 #3) back on the correlated response result', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    tracker.restoreResult = {
      restored: true,
      filesChanged: 1,
      changedPaths: ['a.ts'],
      skippedPaths: ['escape/link.ts'],
    };

    const result = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    expect(result).toEqual({
      restored: true,
      filesChanged: 1,
      changedPaths: ['a.ts'],
      skippedPaths: ['escape/link.ts'],
    });
  });
});

describe('AcpBackend — P3 (A3): turn↔restore interlock', () => {
  it('refuses checkpoint.restore while a turn is live (prompt in flight) WITHOUT calling the tracker', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();
    backend.sendPrompt('session-1', 'long turn', 'default');
    await flushMicrotasks(); // barrier resolved, prompt now in flight (unresolved)
    expect(client.promptCallCount).toBe(1);

    const result = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    expect(result).toEqual({
      restored: false,
      reason:
        'A turn is still running — wait for it to finish (or cancel it) before restoring or redoing a checkpoint.',
    });
    expect(tracker.restoreCalls).toEqual([]); // the tracker was never reached
  });

  it('refuses during the pre-turn barrier too (before prompt is even sent)', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();
    const snap = deferred<Checkpoint | null>();
    tracker.snapshot = () => snap.promise;
    backend.sendPrompt('session-1', 'mid-barrier', 'default');
    await flushMicrotasks();
    expect(client.promptCallCount).toBe(0);

    const result = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
    expect(result.restored).toBe(false);
    expect(tracker.restoreCalls).toEqual([]);
    snap.resolve(makeCheckpoint(1)); // let the suite tear down cleanly
    await flushMicrotasks();
  });

  it('allows restore again after the turn ends (each terminal status)', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();
    backend.sendPrompt('session-1', 'turn', 'default');
    await flushMicrotasks();
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks(); // emitTurnEnd ran → interlock released

    const result = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
    expect(result.restored).toBe(true);
    expect(tracker.restoreCalls).toEqual([{ id: 'ckpt-1', force: undefined }]);
  });

  it('a cancel that lands during the barrier releases the interlock via turn.end{cancelled}', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();
    const snap = deferred<Checkpoint | null>();
    tracker.snapshot = () => snap.promise;
    backend.sendPrompt('session-1', 'will cancel', 'default');
    await flushMicrotasks();
    backend.cancel('session-1');
    snap.resolve(makeCheckpoint(1));
    await flushMicrotasks(); // runTurnWithCheckpoint → emitTurnEnd('cancelled')
    expect(client.promptCallCount).toBe(0);

    const result = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
    expect(result.restored).toBe(true);
  });
});

/**
 * T-C1 (closes audit V-2): `restoreCheckpoint`/`redoCheckpoint` used to only
 * CHECK `root.anyLiveTurn()` before calling `tracker.restore`/`redo`, never
 * HOLD the root's turn lease for the (possibly multi-second) duration of
 * that call — so a `sendPrompt`, a one-shot, or a SECOND restore/redo could
 * be admitted mid-restore and interleave writes with the shadow-git apply
 * loop. The fix (verbatim `OneShotRunner.oneShot` synthetic-holder pattern)
 * makes restore/redo ACQUIRE the lease under a synthetic
 * `checkpoint-restore-N` holder before touching the tracker, and release it
 * in `finally` — these three tests are RED against the pre-fix code (today
 * `tryAcquireTurnLease`/the interlock never observes the restore in flight,
 * so all three admission paths below succeed instead of refusing).
 */
describe('AcpBackend.invokeControl — T-C1 (V-2): restore/redo HOLD the root turn lease while in flight', () => {
  it('checkpoint.restore holds the root turn lease for its own duration — a sendPrompt attempted mid-restore is refused, not admitted', async () => {
    const { backend, client, tracker, messages } = makeBackendWithCheckpoints();
    const restoreGate = deferred<RestoreResult>();
    tracker.restore = () => restoreGate.promise;

    const restorePromise = backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });
    await flushMicrotasks(); // restore is now in flight, tracker.restore() unresolved

    backend.sendPrompt('session-1', 'during restore', 'default');
    await flushMicrotasks();

    // Pre-fix: nothing holds the lease during restore, so this sendPrompt is
    // admitted (promptCallCount becomes 1, a 'user'/'turn.start' pair fires,
    // no refusal error) — RED for the right reason.
    expect(client.promptCallCount).toBe(0);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', sessionId: 'session-1', message: expect.stringContaining('already running') }),
      ]),
    );

    restoreGate.resolve({ restored: true, filesChanged: 0, changedPaths: [] });
    await restorePromise;
    await flushMicrotasks();
  });

  it('releases the restore lease once tracker.restore settles — on BOTH a successful resolve and a thrown rejection', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();

    // Phase A: resolve.
    const resolveGate = deferred<RestoreResult>();
    tracker.restore = () => resolveGate.promise;
    const resolvingRestore = backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });
    await flushMicrotasks();
    // Pre-fix: the lease is never acquired, so this is false today — RED.
    expect(anyLiveTurnOnRoot(backend, '')).toBe(true);
    resolveGate.resolve({ restored: true, filesChanged: 0, changedPaths: [] });
    await resolvingRestore;
    expect(anyLiveTurnOnRoot(backend, '')).toBe(false);

    // Phase B: reject.
    const rejectGate = deferred<RestoreResult>();
    tracker.restore = () => rejectGate.promise;
    const rejectingRestore = backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });
    await flushMicrotasks();
    // Pre-fix: same as Phase A — false today — RED.
    expect(anyLiveTurnOnRoot(backend, '')).toBe(true);
    rejectGate.reject(new Error('shadow git corrupt'));
    const rejectedResult = await rejectingRestore;
    expect(rejectedResult).toEqual({ restored: false, reason: 'shadow git corrupt' }); // unchanged, existing conversion
    expect(anyLiveTurnOnRoot(backend, '')).toBe(false);
  });

  it('a SECOND checkpoint.restore attempted while the first is still in flight is refused with the SAME TURN_ACTIVE_RESTORE_REFUSAL the live-turn case uses (symmetric hazard)', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    const restoreGate = deferred<RestoreResult>();
    // Wraps (rather than discards) the fake's own call-recording behavior —
    // `tracker.restoreCalls` below must still reflect every call that
    // actually reached the tracker.
    tracker.restore = async (id: string, opts?: { force?: boolean }) => {
      tracker.restoreCalls.push({ id, force: opts?.force });
      return restoreGate.promise;
    };

    const firstRestore = backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });
    await flushMicrotasks(); // first restore in flight, holding the lease post-fix

    // Pre-fix: `anyLiveTurn()` is still false (nothing ever acquired), so
    // this second call proceeds straight into `tracker.restore()` a SECOND
    // time (interleaving with the first) instead of being refused — RED.
    const secondResult = await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' });

    expect(secondResult).toEqual({
      restored: false,
      reason: 'A turn is still running — wait for it to finish (or cancel it) before restoring or redoing a checkpoint.',
    });
    expect(tracker.restoreCalls).toEqual([{ id: 'ckpt-1', force: undefined }]); // only the FIRST call ever reached the tracker

    restoreGate.resolve({ restored: true, filesChanged: 0, changedPaths: [] });
    await firstRestore;
    await flushMicrotasks();
  });
});

describe('AcpBackend.invokeControl — Phase 1: checkpoint.redo / checkpoint.redoAll', () => {
  it('dispatches checkpoint.redo → tracker.redo and returns the RestoreResult; success re-pushes the checkpoints panel', async () => {
    const { backend, tracker, messages } = makeBackendWithCheckpoints();
    tracker.redoResult = { restored: true, filesChanged: 1, changedPaths: ['a.txt'] };

    const result = await backend.invokeControl('checkpoint.redo', {});

    expect(tracker.redoCalls).toEqual([{ kind: 'redo', force: undefined }]);
    expect(result).toEqual(tracker.redoResult);
    expect(messages.some((m) => m.type === 'panel.data' && m.panel === 'checkpoints')).toBe(true);
  });

  it('dispatches checkpoint.redoAll with {force:true} forwarded', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();

    await backend.invokeControl('checkpoint.redoAll', { force: true });

    expect(tracker.redoCalls).toEqual([{ kind: 'redoAll', force: true }]);
  });

  it('a {restored:false} redo (no anchor / dirty) is RETURNED as-is and does NOT re-push the panel', async () => {
    const { backend, tracker, messages } = makeBackendWithCheckpoints();
    tracker.redoResult = { restored: false, reason: 'No redo available.' };

    const result = await backend.invokeControl('checkpoint.redo', {});

    expect(result).toEqual(tracker.redoResult);
    expect(messages.some((m) => m.type === 'panel.data' && m.panel === 'checkpoints')).toBe(false);
  });

  it('an unexpected tracker.redo rejection is converted to {restored:false, reason} (not thrown)', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    tracker.redo = async () => {
      throw new Error('shadow git corrupt');
    };

    const result = await backend.invokeControl('checkpoint.redo', {});

    expect(result).toEqual({ restored: false, reason: 'shadow git corrupt' });
  });

  it('T-C2 (closes V-17): refuses with the pinned NO_TRACKER_RESTORE_REFUSAL (never a bare undefined) when no tracker was injected', async () => {
    const { backend } = makeBackend();

    const noTrackerRefusal = {
      restored: false,
      reason: 'Checkpoints are not available for this workspace — nothing was restored.',
    };
    expect(await backend.invokeControl('checkpoint.redo', {})).toEqual(noTrackerRefusal);
    expect(await backend.invokeControl('checkpoint.redoAll', {})).toEqual(noTrackerRefusal);
  });

  it('redo is refused while a turn is live (shares the P3 interlock) without reaching the tracker', async () => {
    const { backend, client, tracker } = makeBackendWithCheckpoints();
    backend.sendPrompt('session-1', 'turn', 'default');
    await flushMicrotasks();

    const result = (await backend.invokeControl('checkpoint.redoAll', {})) as RestoreResult;

    expect(result.restored).toBe(false);
    expect(tracker.redoCalls).toEqual([]);
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
  });

  it('CONTROL_METHODS allowlist accepts checkpoint.redo / checkpoint.redoAll (not rejected as disallowed)', async () => {
    const { backend } = makeBackend(); // no tracker injected — refused (T-C2), not thrown, not disallowed

    const noTrackerRefusal = {
      restored: false,
      reason: 'Checkpoints are not available for this workspace — nothing was restored.',
    };
    await expect(backend.invokeControl('checkpoint.redo', {})).resolves.toEqual(noTrackerRefusal);
    await expect(backend.invokeControl('checkpoint.redoAll', {})).resolves.toEqual(noTrackerRefusal);
  });
});

describe('AcpBackend.invokeControl — Zone Z3: models/settings reshapers (finding "Minors")', () => {
  it("switchTab('models') dispatches model.options and pushes RESHAPED ModelsData (previously raw was pushed)", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    const raw = {
      providers: [{ slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-4-8'] }],
      model: 'claude-opus-4-8',
    };
    control.setNextResult(raw);

    const result = await backend.invokeControl('panel.data',{ panel: 'models' });

    expect(control.dispatchCalls).toEqual([{ method: 'model.options', params: { panel: 'models' } }]);
    // A#6: reshaped ModelsData on BOTH the resolve and the push.
    const expectedModels = {
      providers: [
        { id: 'anthropic', name: 'Anthropic', connected: true, models: [{ id: 'claude-opus-4-8', label: 'claude-opus-4-8' }] },
      ],
      currentModelId: 'claude-opus-4-8',
    };
    expect(result).toEqual(expectedModels);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'models', data: expectedModels }]);
  });

  it("switchTab('settings') dispatches config.show and pushes RESHAPED SettingsData (previously raw was pushed)", async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    const raw = { sections: [{ title: 'Model', rows: [['Model', 'claude-opus-4-8']] }] };
    control.setNextResult(raw);

    const result = await backend.invokeControl('panel.data',{ panel: 'settings' });

    expect(control.dispatchCalls).toEqual([{ method: 'config.show', params: { panel: 'settings' } }]);
    // A#6: reshaped SettingsData on BOTH the resolve and the push.
    const expectedSettings = {
      sections: [{ name: 'Model', fields: [{ key: 'Model', value: 'claude-opus-4-8', type: 'string' }] }],
    };
    expect(result).toEqual(expectedSettings);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'settings', data: expectedSettings }]);
  });
});

/**
 * CF-13/D1: the "Add provider key" harness contract. `model.save_key`
 * ({slug, api_key}) returns `{provider: <refreshed row>}` on success — this
 * dispatcher mirrors `reload.mcp`'s "dispatch → refetch panel" branch: a
 * success re-fetches the Models panel FRESH (`model.options`, not an echo of
 * the request), a failure (e.g. the 4006 managed-install refusal) re-throws
 * without ever touching the panel.
 */
describe('AcpBackend.invokeControl — CF-13/D1: model.save_key (Add provider key) panel refresh', () => {
  it('a successful model.save_key dispatches through and re-fetches the models panel exactly once, from a fresh model.options read', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setResultFor('model.save_key', {
      provider: { slug: 'deepseek', name: 'DeepSeek', authenticated: true, models: ['deepseek-chat'] },
    });
    control.setResultFor('model.options', {
      providers: [{ slug: 'deepseek', name: 'DeepSeek', authenticated: true, models: ['deepseek-chat'] }],
      model: 'deepseek-chat',
    });

    const result = await backend.invokeControl('model.save_key', {
      slug: 'deepseek',
      api_key: 'sk-super-secret-value',
    });

    // The key transits ONCE, host-side, to the harness — exactly the params
    // the caller supplied, verbatim (this dispatcher never touches it).
    expect(control.dispatchCalls).toEqual([
      { method: 'model.save_key', params: { slug: 'deepseek', api_key: 'sk-super-secret-value' } },
      { method: 'model.options', params: undefined },
    ]);
    // The resolved value is the harness's own {provider} reply — never
    // anything fabricated from the request (the key never echoes back).
    expect(result).toEqual({
      provider: { slug: 'deepseek', name: 'DeepSeek', authenticated: true, models: ['deepseek-chat'] },
    });
    const expectedModels = {
      providers: [
        { id: 'deepseek', name: 'DeepSeek', connected: true, models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }] },
      ],
      currentModelId: 'deepseek-chat',
    };
    expect(messages).toEqual([{ type: 'panel.data', panel: 'models', data: expectedModels }]);
  });

  it('a failed model.save_key (4006 managed-install) propagates the rejection and does NOT re-fetch the models panel', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    control.setDeferredFor(
      'model.save_key',
      Promise.reject(new Error('model.save_key failed [4006]: credentials are managed and read-only')),
    );

    await expect(
      backend.invokeControl('model.save_key', { slug: 'deepseek', api_key: 'sk-super-secret-value' }),
    ).rejects.toThrow('[4006]');

    expect(control.dispatchCalls).toEqual([
      { method: 'model.save_key', params: { slug: 'deepseek', api_key: 'sk-super-secret-value' } },
    ]);
    expect(messages).toEqual([]);
  });
});

describe('AcpBackend.registerPanelSource — Open-Closed extension point (dashboard zone)', () => {
  it('routes a panel fetch through a newly-registered source WITHOUT dispatching the default tui_gateway RPC', async () => {
    const { backend, messages } = makeBackend();
    const control = withFakeControl(backend);
    const custom: PanelSource<'tools'> = {
      fetch: async () => ({ data: { toolsets: [{ name: 'dash', enabled: true, toolCount: 2 }], tools: [] } }),
    };
    backend.registerPanelSource('tools', custom);

    const result = await backend.invokeControl('panel.data',{ panel: 'tools' });

    // The default ToolsPanelSource (which would `tools.list`) was overridden —
    // the registry, not an edit to AcpBackend, is the extension point.
    expect(control.dispatchCalls).toEqual([]);
    const expected = { toolsets: [{ name: 'dash', enabled: true, toolCount: 2 }], tools: [] };
    expect(result).toEqual(expected);
    expect(messages).toEqual([{ type: 'panel.data', panel: 'tools', data: expected }]);
  });
});

describe('AcpBackend.invokeControl — Zone Z9 #2: checkpoints transient vs permanent split', () => {
  it('REJECTS (retryable) on a transient CheckpointLockTimeoutError instead of masking it as available:false', async () => {
    const { backend, messages, tracker } = makeBackendWithCheckpoints();
    tracker.listError = new CheckpointLockTimeoutError('another window holds the checkpoint lock');

    // A transient lock timeout propagates out of invokeControl -> the webview's
    // RemoteData shows Error+Retry (retryable), NOT a permanent disabled panel.
    await expect(backend.invokeControl('panel.data',{ panel: 'checkpoints' })).rejects.toBeInstanceOf(
      CheckpointLockTimeoutError,
    );
    // And crucially no push happened (no stale/empty success masking the error).
    expect(messages).toEqual([]);
  });

  it('still masks a GENUINE-PERMANENT failure (non-lock) as available:false (unchanged behaviour)', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    tracker.listError = new Error('git executable not found on PATH; checkpoints are disabled');

    const result = await backend.invokeControl('panel.data',{ panel: 'checkpoints' });

    expect(result).toMatchObject({ available: false });
  });
});

/**
 * W1.5: the Skills & Tools panels are sourced from — and toggle through — the
 * dashboard REST channel, NOT tui_gateway. A fake `DashboardService` proves the
 * routing without any HTTP: `skills.toggle`/`toolsets.toggle` hit the client's
 * toggle methods (not `control.dispatch`), and the skills/tools PANEL fetches go
 * to the dashboard list calls (overriding the default tui_gateway sources).
 */
class FakeDashboardClient implements DashboardClientLike {
  toggleSkillCalls: Array<{ name: string; enabled: boolean }> = [];
  toggleToolsetCalls: Array<{ name: string; enabled: boolean }> = [];
  listSkillsResult = [{ name: 'tdd', description: 'x', category: 'coding', enabled: true, usage: 4, provenance: 'bundled' }];
  listToolsetsResult = [{ name: 'web', label: 'Web', description: '', enabled: true, available: true, configured: false, tools: ['web_search'] }];
  async probe() { return true; }
  async listSkills() { return this.listSkillsResult; }
  async listToolsets() { return this.listToolsetsResult; }
  async toggleSkill(name: string, enabled: boolean): Promise<DashboardToggleResult> {
    this.toggleSkillCalls.push({ name, enabled });
    return { ok: true, name, enabled };
  }
  async toggleToolset(name: string, enabled: boolean): Promise<DashboardToggleResult> {
    this.toggleToolsetCalls.push({ name, enabled });
    return { ok: true, name, enabled };
  }
}

/**
 * AH5: a dashboard client whose `toggleSkill` never settles on its own — the
 * test drives `resolveNext()`/`rejectNext()` to control exactly when the
 * in-flight call completes, so the test can observe whether a SECOND
 * `toggleDashboard` call's underlying `toggleSkill` has started (host-side
 * serialization) or not (the old webview-only guard).
 */
class DeferredDashboardClient implements DashboardClientLike {
  toggleSkillCalls: Array<{ name: string; enabled: boolean }> = [];
  private pendingSkillToggles: Array<{
    name: string;
    enabled: boolean;
    resolve: (result: DashboardToggleResult) => void;
    reject: (error: Error) => void;
  }> = [];

  async probe() {
    return true;
  }
  async listSkills() {
    return [];
  }
  async listToolsets() {
    return [];
  }

  toggleSkill(name: string, enabled: boolean): Promise<DashboardToggleResult> {
    this.toggleSkillCalls.push({ name, enabled });
    return new Promise<DashboardToggleResult>((resolve, reject) => {
      this.pendingSkillToggles.push({ name, enabled, resolve, reject });
    });
  }

  async toggleToolset(name: string, enabled: boolean): Promise<DashboardToggleResult> {
    return { ok: true, name, enabled };
  }

  /** Resolve the OLDEST still-pending `toggleSkill` call with `{ok:true,...}`. */
  resolveNext(): void {
    const pending = this.pendingSkillToggles.shift();
    if (!pending) throw new Error('resolveNext(): no pending toggleSkill call');
    pending.resolve({ ok: true, name: pending.name, enabled: pending.enabled });
  }

  /** Reject the OLDEST still-pending `toggleSkill` call. */
  rejectNext(error: Error): void {
    const pending = this.pendingSkillToggles.shift();
    if (!pending) throw new Error('rejectNext(): no pending toggleSkill call');
    pending.reject(error);
  }
}

function makeBackendWithDashboard(): {
  backend: AcpBackend;
  messages: HostToWebviewMessage[];
  client: FakeDashboardClient;
} {
  const client = new FakeDashboardClient();
  const dashboard: DashboardService = { ensure: async () => client, dispose: () => {} };
  const backend = new AcpBackend({}, undefined, undefined, undefined, dashboard);
  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  return { backend, messages, client };
}

describe('AcpBackend — W1.5 dashboard channel (Skills & Tools)', () => {
  it('routes skills.toggle to the dashboard client (NOT tui_gateway) and returns the {ok,name,enabled} round-trip', async () => {
    const { backend, client } = makeBackendWithDashboard();
    const control = withFakeControl(backend);

    const result = await backend.invokeControl('skills.toggle', { name: 'tdd', enabled: false });

    expect(client.toggleSkillCalls).toEqual([{ name: 'tdd', enabled: false }]);
    expect(control.dispatchCalls).toEqual([]); // never touched the gateway
    expect(result).toEqual({ ok: true, name: 'tdd', enabled: false });
  });

  it('routes toolsets.toggle to the dashboard client', async () => {
    const { backend, client } = makeBackendWithDashboard();
    const result = await backend.invokeControl('toolsets.toggle', { name: 'web', enabled: true });
    expect(client.toggleToolsetCalls).toEqual([{ name: 'web', enabled: true }]);
    expect(result).toEqual({ ok: true, name: 'web', enabled: true });
  });

  it('sources the skills panel from the dashboard GET /api/skills (real enabled + provenance + usage)', async () => {
    const { backend, messages } = makeBackendWithDashboard();
    const control = withFakeControl(backend);

    await backend.invokeControl('panel.data',{ panel: 'skills' });

    expect(control.dispatchCalls).toEqual([]); // not the tui_gateway skills.manage
    expect(messages).toEqual([
      {
        type: 'panel.data',
        panel: 'skills',
        data: {
          categories: ['coding'],
          skills: [{ id: 'tdd', name: 'tdd', category: 'coding', description: 'x', enabled: true, provenance: 'bundled', usage: 4 }],
        },
      },
    ]);
  });

  it('rejects skills.toggle when NO dashboard is wired (never fakes an effect)', async () => {
    const { backend } = makeBackend();
    await expect(backend.invokeControl('skills.toggle', { name: 'x', enabled: false })).rejects.toThrow(
      /dashboard channel is not configured/,
    );
  });

  // S-M4: validate the toggle `name` against the set the panel most-recently
  // listed, so a compromised webview can't push an arbitrary key into Hermes's
  // `skills.disabled` denylist.
  it('rejects a skills.toggle for a name NOT in the last-listed set (once a list has been fetched)', async () => {
    const { backend, client } = makeBackendWithDashboard();

    // Populate the source's known-name cache via a real list fetch first.
    await backend.invokeControl('panel.data', { panel: 'skills' }); // caches {'tdd'}

    await expect(
      backend.invokeControl('skills.toggle', { name: 'not-a-real-skill', enabled: false }),
    ).rejects.toThrow(/not in the last-listed skills set/);
    expect(client.toggleSkillCalls).toEqual([]); // never reached the dashboard client
  });

  it('allows a skills.toggle for a name that IS in the last-listed set', async () => {
    const { backend, client } = makeBackendWithDashboard();
    await backend.invokeControl('panel.data', { panel: 'skills' }); // caches {'tdd'}

    const result = await backend.invokeControl('skills.toggle', { name: 'tdd', enabled: false });

    expect(result).toEqual({ ok: true, name: 'tdd', enabled: false });
    expect(client.toggleSkillCalls).toEqual([{ name: 'tdd', enabled: false }]);
  });

  it('does NOT block a toggle before any list has been fetched (empty cache = cannot validate, so allow)', async () => {
    const { backend, client } = makeBackendWithDashboard();

    // No panel.data fetch first -> the source has no cached name set yet.
    const result = await backend.invokeControl('toolsets.toggle', { name: 'anything', enabled: true });

    expect(result).toEqual({ ok: true, name: 'anything', enabled: true });
    expect(client.toggleToolsetCalls).toEqual([{ name: 'anything', enabled: true }]);
  });

  // AH5: bulk toggles were previously serialized only WEBVIEW-side
  // (`SequentialQueue` in `useToggle.ts`) — a buggy/compromised webview firing
  // parallel `control.request`s reopens the `save_disabled_skills` RMW race on
  // `config.yaml`. The host (the authoritative side) must serialize too.
  it('serializes concurrent dashboard toggles host-side (second PUT starts only after the first settles)', async () => {
    const client = new DeferredDashboardClient();
    const dashboard: DashboardService = { ensure: async () => client, dispose: () => {} };
    const backend = new AcpBackend({}, undefined, undefined, undefined, dashboard);

    const first = backend.invokeControl('skills.toggle', { name: 'a', enabled: false });
    await flushMicrotasks();
    expect(client.toggleSkillCalls).toEqual([{ name: 'a', enabled: false }]);

    const second = backend.invokeControl('skills.toggle', { name: 'b', enabled: true });
    await flushMicrotasks();
    // The second toggle must NOT have reached the dashboard client yet — only
    // the first call is recorded until it settles.
    expect(client.toggleSkillCalls).toEqual([{ name: 'a', enabled: false }]);

    client.resolveNext(); // settle the first
    await first;
    await flushMicrotasks();

    expect(client.toggleSkillCalls).toEqual([
      { name: 'a', enabled: false },
      { name: 'b', enabled: true },
    ]);

    client.resolveNext(); // settle the second so the test doesn't leak a pending promise
    await expect(second).resolves.toEqual({ ok: true, name: 'b', enabled: true });
  });

  // AH5: a REJECTED toggle must not break the chain for the next caller — the
  // tail always resolves regardless of the settled call's outcome.
  it('a rejected dashboard toggle does not block the next queued toggle', async () => {
    const client = new DeferredDashboardClient();
    const dashboard: DashboardService = { ensure: async () => client, dispose: () => {} };
    const backend = new AcpBackend({}, undefined, undefined, undefined, dashboard);

    const first = backend.invokeControl('skills.toggle', { name: 'a', enabled: false });
    await flushMicrotasks();
    const second = backend.invokeControl('skills.toggle', { name: 'b', enabled: true });
    await flushMicrotasks();
    // Same host-side serialization guard as the test above: the second toggle
    // must not have reached the client while the first is still pending.
    expect(client.toggleSkillCalls).toEqual([{ name: 'a', enabled: false }]);

    client.rejectNext(new Error('dashboard unreachable'));
    await expect(first).rejects.toThrow('dashboard unreachable');
    await flushMicrotasks();

    // The rejection must not have wedged the chain — the second PUT went out.
    expect(client.toggleSkillCalls).toEqual([
      { name: 'a', enabled: false },
      { name: 'b', enabled: true },
    ]);

    client.resolveNext();
    await expect(second).resolves.toEqual({ ok: true, name: 'b', enabled: true });
  });
});

// =============================================================================
// W2-F1 (Zone B): edit-policy interception, wire-mode pin, turnProtected, Plan.
// =============================================================================

/** Reaches past `private` to call the ACP request-permission seam directly. */
function callRequestPermission(
  backend: AcpBackend,
): (req: AcpRequestPermissionRequest) => Promise<AcpRequestPermissionResponse> {
  return (
    backend as unknown as {
      handleRequestPermission: (req: AcpRequestPermissionRequest) => Promise<AcpRequestPermissionResponse>;
    }
  ).handleRequestPermission.bind(backend);
}

/**
 * Reaches past `private` to drive the pre-turn snapshot barrier (turnProtected
 * tracking) — W4-T1a: this method MOVED onto `SessionController` (it's the
 * one that tracks `currentTurnProtected`; `AcpBackend` keeps a same-named
 * but DIFFERENT baseline-only sibling that never touches it), so this goes
 * through `seam()`'s controller-proxying + auto-bind rather than a direct
 * cast on `backend`.
 */
function callSnapshotCheckpoint(backend: AcpBackend): (turnOrdinal: number, promptText: string) => Promise<void> {
  return (seam(backend) as unknown as { snapshotCheckpoint: (turnOrdinal: number, promptText: string) => Promise<void> })
    .snapshotCheckpoint;
}

/** Backend wired with a log-capturing logger + a live turn id, for the seam tests. */
function makePolicyBackend(): {
  backend: AcpBackend;
  client: FakeAcpClient;
  messages: HostToWebviewMessage[];
  logs: string[];
} {
  const logs: string[] = [];
  const backend = new AcpBackend({} as HermesRuntimeConfig, { append: (l) => logs.push(l) });
  const client = new FakeAcpClient();
  seam(backend).client = client;
  seam(backend).sessionId = 'session-1';
  seam(backend).currentTurnId = 'turn-1';
  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  return { backend, client, messages, logs };
}

const EDIT_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' },
  { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
] as const;

/** An `edit` request_permission whose write_file `rawInput.arguments.path` is `p`. */
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

/** A command request_permission whose `rawInput.command` is `command`. */
function makeCommandReq(command: string): AcpRequestPermissionRequest {
  return {
    sessionId: 'session-1',
    options: EDIT_OPTIONS.map((o) => ({ ...o })),
    toolCall: {
      toolCallId: 'cmd-1',
      title: `Run: ${command}`,
      kind: 'execute',
      content: [{ content: { type: 'text', text: `$ ${command}` } }],
      rawInput: { command, description: 'run' },
    },
  };
}

/**
 * Bucket 1 F1: `handleRequestPermission` now AWAITS real canonicalization
 * (realpath/lstat) before deciding, so the ask card is no longer emitted
 * synchronously — poll for it instead of asserting inline.
 */
async function waitForApprovalCard(messages: HostToWebviewMessage[]): Promise<void> {
  await vi.waitFor(() => {
    expect(messages.some((m) => m.type === 'approval.request')).toBe(true);
  });
}

// Junction-fallback dir link probe + helper (same shape as pathConfine.test.ts):
// Fedora (the CI/ship target) always supports real symlinks; a Windows dev box
// without SeCreateSymbolicLinkPrivilege falls back to an NTFS junction.
function linkDirSyncSeam(target: string, link: string): void {
  try {
    symlinkSync(target, link, 'dir');
  } catch {
    symlinkSync(target, link, 'junction');
  }
}
const canLinkDirSeam = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-seam-symcap-'));
    mkdirSync(path.join(dir, 't'));
    linkDirSyncSeam(path.join(dir, 't'), path.join(dir, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

describe('AcpBackend — W2-F1: edit-policy interception at the request-permission seam', () => {
  const tmpDirs: string[] = [];

  /** A REAL temp workspace so the F1 canonicalization has actual dirs to realpath. */
  function makeTmpWs(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-seam-ws-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('preset defaults to manual — an edit request still emits the approval card (today’s behavior preserved)', async () => {
    const { backend, messages } = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;
    expect(backend.getPreset()).toBe('manual');

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));

    // manual => engine returns ask => the existing card is emitted and the ACP
    // promise stays pending until the human answers.
    await waitForApprovalCard(messages);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('normal + checkpoint-protected in-workspace non-secret edit => auto-allow (no card, allow_once, audit line)', async () => {
    const { backend, messages, logs } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal');
    messages.length = 0; // drop the policy.state push from setPreset

    const outcome = await callRequestPermission(backend)(makeEditReq('src/a.ts'));

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    // Auto-allow emits NEITHER approval.request NOR tool.diff.
    expect(messages.some((m) => m.type === 'approval.request')).toBe(false);
    expect(messages.some((m) => m.type === 'tool.diff')).toBe(false);
    // Pinned audit line format (F4 added `option=` — the selected option id).
    expect(
      logs.some((l) =>
        /^\[policy\] preset=normal kind=edit outcome=allow rule=normal-safe-edit option=allow_once turn=turn-1 paths=src\/a\.ts$/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('F1: normal + ~/.bashrc => NOT auto-allowed (Hermes expanduser()s it outside the tree; we must too)', async () => {
    const { backend, messages, logs } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal');
    messages.length = 0;

    const pending = callRequestPermission(backend)(makeEditReq('~/.bashrc'));

    await waitForApprovalCard(messages);
    expect(logs.some((l) => /outcome=allow rule=normal-safe-edit/.test(l))).toBe(false);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it.skipIf(!canLinkDirSeam)(
    'F1: normal + edit through an in-workspace symlink into ~/.ssh => NOT auto-allowed (canonical path reveals the escape)',
    async () => {
      const { backend, messages, logs } = makePolicyBackend();
      const ws = makeTmpWs();
      const outside = makeTmpWs(); // second temp dir, plays the out-of-tree home
      mkdirSync(path.join(outside, '.ssh'), { recursive: true });
      linkDirSyncSeam(path.join(outside, '.ssh'), path.join(ws, 'evil'));
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
      seam(backend).cwd = ws;
      seam(backend).currentTurnProtected = true;
      backend.setPreset('session-1', 'normal');
      messages.length = 0;

      const pending = callRequestPermission(backend)(makeEditReq('evil/authorized_keys'));

      // The canonical path escapes + hits the `.ssh` secret floor => ask, never allow.
      await waitForApprovalCard(messages);
      expect(logs.some((l) => /outcome=allow/.test(l))).toBe(false);
      backend.respondApproval('session-1', 'appr-1', 'deny');
      await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    },
  );

  it.skipIf(!canLinkDirSeam)(
    'F1: strict + edit through an in-workspace symlink escaping the tree => hard DENY on the canonical path',
    async () => {
      const { backend } = makePolicyBackend();
      const ws = makeTmpWs();
      const outside = makeTmpWs();
      mkdirSync(path.join(outside, '.ssh'), { recursive: true });
      linkDirSyncSeam(path.join(outside, '.ssh'), path.join(ws, 'evil'));
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
      seam(backend).cwd = ws;
      seam(backend).currentTurnProtected = true;
      backend.setPreset('session-1', 'strict');

      const outcome = await callRequestPermission(backend)(makeEditReq('evil/authorized_keys'));

      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    },
  );

  it('strict + an unprotected turn => auto-deny (deny option id, no card)', async () => {
    const { backend, messages } = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = false;
    backend.setPreset('session-1', 'strict');
    messages.length = 0;

    const outcome = await callRequestPermission(backend)(makeEditReq('src/a.ts'));

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    expect(messages.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it('strict + a secret path (.env) => hard deny even on a protected turn', async () => {
    const { backend } = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'strict');

    const outcome = await callRequestPermission(backend)(makeEditReq('.env'));
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('plan + any edit => deny (plan is read-only)', async () => {
    const { backend } = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'plan');

    const outcome = await callRequestPermission(backend)(makeEditReq('src/a.ts'));
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('a command with $(...) substitution => deny under strict, but the ask card under manual', async () => {
    const strict = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(strict.backend).cwd = '/ws';
    strict.backend.setPreset('session-1', 'strict');

    const denied = await callRequestPermission(strict.backend)(makeCommandReq('echo $(whoami)'));
    expect(denied).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });

    const manual = makePolicyBackend();
    const pending = callRequestPermission(manual.backend)(makeCommandReq('echo $(whoami)'));
    await waitForApprovalCard(manual.messages);
    manual.backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });

  it('deny with NO deny option offered falls back to a Cancelled outcome', async () => {
    const { backend } = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = false;
    backend.setPreset('session-1', 'strict');

    const req: AcpRequestPermissionRequest = {
      sessionId: 'session-1',
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }], // no deny option
      toolCall: {
        toolCallId: 'e',
        title: 't',
        kind: 'edit',
        rawInput: { tool: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } },
      },
    };

    const outcome = await callRequestPermission(backend)(req);
    expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('F2: a decoy arguments.path cannot hide a diff touching .git/hooks — the UNION is gated (no auto-allow)', async () => {
    const { backend, messages, logs } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal');
    messages.length = 0;

    const req = makeEditReq('src/app.ts'); // benign decoy in rawInput.arguments.path
    req.toolCall.content = [
      { type: 'diff', path: 'src/app.ts', oldText: 'a', newText: 'b' },
      { type: 'diff', path: '.git/hooks/pre-commit', oldText: null, newText: 'evil' },
    ];

    const pending = callRequestPermission(backend)(req);

    // The secret floor fires on the unioned `.git` path => ask, never allow.
    await waitForApprovalCard(messages);
    expect(logs.some((l) => /outcome=allow/.test(l))).toBe(false);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('F2: a dangerous command mislabeled kind=edit still hits the command floor (strict => deny)', async () => {
    const { backend } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'strict');

    const req: AcpRequestPermissionRequest = {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'evil-cmd-1',
        title: 'Update README', // attacker-chosen benign label
        kind: 'edit', // mislabeled — the effect field says command
        rawInput: { command: 'rm -rf / --no-preserve-root' },
      },
    };

    const outcome = await callRequestPermission(backend)(req);

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('F2: a benign command mislabeled kind=edit asks, and the card is labeled from OUR effect (kind=command), not the agent title', async () => {
    const { backend, messages } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal');
    messages.length = 0;

    const req: AcpRequestPermissionRequest = {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'evil-cmd-2',
        title: 'Update README',
        kind: 'edit',
        rawInput: { command: 'npm test' },
      },
    };

    const pending = callRequestPermission(backend)(req);

    await waitForApprovalCard(messages);
    const card = messages.find((m) => m.type === 'approval.request');
    expect(card).toMatchObject({ kind: 'command', title: 'Run: npm test' });
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });

  it('F2: an ask card for a ~ edit shows the CANONICAL resolved path, never the raw ~', async () => {
    const { backend, messages } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    // manual (the default) => every edit asks; the card must show the real target.

    const pending = callRequestPermission(backend)(makeEditReq('~/.bashrc'));

    await waitForApprovalCard(messages);
    const card = messages.find((m) => m.type === 'approval.request');
    expect(card).toMatchObject({ kind: 'edit' });
    const title = (card as { title: string }).title;
    expect(title).toMatch(/^Edit: .*\.bashrc$/);
    expect(title).not.toContain('~');
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });

  it('F4: an auto-allow selects allow_once even when broader allow options are offered', async () => {
    const { backend } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal');

    const req = makeEditReq('src/a.ts');
    req.options = [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ];

    const outcome = await callRequestPermission(backend)(req);

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });

  it('F4: an auto-allow with NO allow_once offered NEVER escalates to allow_session/allow_always — falls to the card', async () => {
    const { backend, messages } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal');
    messages.length = 0;

    const req = makeEditReq('src/a.ts');
    req.options = [
      { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ];

    const pending = callRequestPermission(backend)(req);

    // Fail-safe downgrade: a session/permanent grant may never be auto-minted.
    await waitForApprovalCard(messages);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('F4: the audit line records the selected option id (option=allow_once / option=deny)', async () => {
    const allow = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(allow.backend).cwd = ws;
    seam(allow.backend).currentTurnProtected = true;
    allow.backend.setPreset('session-1', 'normal');
    await callRequestPermission(allow.backend)(makeEditReq('src/a.ts'));
    expect(allow.logs.some((l) => /^\[policy\] .*outcome=allow .*option=allow_once /.test(l))).toBe(true);

    const deny = makePolicyBackend();
    seam(deny.backend).cwd = ws;
    seam(deny.backend).currentTurnProtected = false;
    deny.backend.setPreset('session-1', 'strict');
    await callRequestPermission(deny.backend)(makeEditReq('src/a.ts'));
    expect(deny.logs.some((l) => /^\[policy\] .*outcome=deny .*option=deny /.test(l))).toBe(true);
  });

  it('F5: a throw while PARSING the request (mapPermissionRequest) falls to a minimal ask card — not an RPC error', async () => {
    const { backend, messages, logs } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal'); // benign path would auto-allow — the throw must prevent that
    messages.length = 0;

    // Hostile diff content: `newText` is not a string, so `buildDiffHunks` throws
    // inside `mapPermissionRequest` (previously BEFORE the try -> RPC rejection).
    const req: AcpRequestPermissionRequest = {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'edit-evil',
        title: 'Update README',
        kind: 'edit',
        content: [{ type: 'diff', path: 'README.md', oldText: 'a', newText: 42 as unknown as string }],
        rawInput: { tool: 'write_file', arguments: { path: 'README.md', content: 'x' } },
      },
    };

    const pending = callRequestPermission(backend)(req);

    await waitForApprovalCard(messages);
    const card = messages.find((m) => m.type === 'approval.request');
    // The minimal card never echoes the agent's title and no auto-allow happened.
    expect(card).toMatchObject({ title: 'Approval required (request could not be parsed)' });
    expect(logs.some((l) => /interception error/.test(l))).toBe(true);
    expect(logs.some((l) => /outcome=allow/.test(l))).toBe(false);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('an engine exception falls back to the ask card (fail-closed — never a silent auto-allow)', async () => {
    const { backend, messages, logs } = makePolicyBackend();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;
    backend.setPreset('session-1', 'normal'); // would normally auto-allow — but the engine throws
    messages.length = 0;
    vi.mocked(evaluateEditPolicy).mockImplementationOnce(() => {
      throw new Error('engine boom');
    });

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));

    await waitForApprovalCard(messages);
    expect(logs.some((l) => /interception error/.test(l))).toBe(true);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });
});

// =============================================================================
// W2 T4 — F-D: EditPreviewRegistry populate/clear wiring (ask-path-scoped).
// =============================================================================

/** Like {@link makePolicyBackend} but with a real {@link EditPreviewRegistry}
 * injected, so tests can assert directly on what it does/doesn't hold. */
function makePolicyBackendWithRegistry(): {
  backend: AcpBackend;
  registry: EditPreviewRegistry;
  client: FakeAcpClient;
  messages: HostToWebviewMessage[];
  logs: string[];
} {
  const logs: string[] = [];
  const registry = new EditPreviewRegistry();
  const backend = new AcpBackend(
    {} as HermesRuntimeConfig,
    { append: (l) => logs.push(l) },
    undefined,
    undefined,
    undefined,
    undefined,
    registry,
  );
  const client = new FakeAcpClient();
  seam(backend).client = client;
  seam(backend).sessionId = 'session-1';
  seam(backend).currentTurnId = 'turn-1';
  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  return { backend, registry, client, messages, logs };
}

describe('AcpBackend — W2 T4 F-D: EditPreviewRegistry wiring (SECURITY: ask-path-scoped, cannot outlive its approval)', () => {
  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
  });

  it('an ask-path approval populates the registry keyed by toolId with the RAW pre-hunk texts', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));
    await waitForApprovalCard(messages);

    // makeEditReq's diff content is {path, oldText:'a', newText:'b'} — the raw
    // wire texts, verbatim (never re-derived through buildDiffHunks).
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toEqual({ oldText: 'a', newText: 'b' });

    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });

  it('populates every file of a multi-file edit under the one toolId', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const req = makeEditReq('src/app.ts');
    req.toolCall.content = [
      { type: 'diff', path: 'src/app.ts', oldText: 'a', newText: 'b' },
      { type: 'diff', path: 'src/other.ts', oldText: null, newText: 'brand new' },
    ];
    const pending = callRequestPermission(backend)(req);
    await waitForApprovalCard(messages);

    expect(registry.getFile('session-1', 'edit-1', 'src/app.ts')).toEqual({ oldText: 'a', newText: 'b' });
    expect(registry.getFile('session-1', 'edit-1', 'src/other.ts')).toEqual({ oldText: null, newText: 'brand new' });

    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });

  it('a command approval (no diff content) never populates the registry', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';

    const pending = callRequestPermission(backend)(makeCommandReq('npm test'));
    await waitForApprovalCard(messages);

    expect(registry.getFile('session-1', 'cmd-1', '')).toBeUndefined();

    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;
  });

  it('respondApproval REMOVES the registry entry — it cannot outlive a manually-answered approval', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));
    await waitForApprovalCard(messages);
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeDefined();

    backend.respondApproval('session-1', 'appr-1', 'deny');
    await pending;

    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeUndefined();
  });

  it('resolveDiff("accept") — the whole-file accept path (finishApproval) — REMOVES the registry entry', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));
    await waitForApprovalCard(messages);
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeDefined();

    // makeEditReq's single-line a->b diff derives exactly one hunk, so index 0
    // completes the whole-file aggregation and fires finishApproval.
    backend.resolveDiff('session-1', 'edit-1', 0, 'accept');
    await pending;

    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeUndefined();
  });

  it('resolveDiff("reject") REMOVES the registry entry', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));
    await waitForApprovalCard(messages);
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeDefined();

    backend.resolveDiff('session-1', 'edit-1', 0, 'reject');
    await pending;

    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeUndefined();
  });

  it('cancelPendingApprovals (dispose / session teardown) REMOVES every pending registry entry', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const pending = callRequestPermission(backend)(makeEditReq('src/a.ts'));
    await waitForApprovalCard(messages);
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeDefined();

    backend.dispose(); // teardownSession() -> cancelPendingApprovals()
    await pending; // resolves { outcome: 'cancelled' }

    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeUndefined();
  });

  it('a POST-APPLY tool.diff (the ordinary tool-call stream, no approval in play) NEVER populates the registry', () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    backend.sendPrompt('session-1', 'go', 'default');
    messages.length = 0;

    fireSessionUpdate(backend)('session-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'post-apply-1',
      title: 'write_file',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' }],
    });

    // Sanity: this IS the real post-apply display path — it does emit tool.diff.
    expect(messages.some((m) => m.type === 'tool.diff')).toBe(true);
    // But the registry — populated ONLY from emitApprovalCard's ask path — was
    // never touched by it (§7 A6).
    expect(registry.getFile('session-1', 'post-apply-1', 'src/a.ts')).toBeUndefined();
  });

  it('acceptWholeFileDiff accepts every hunk of a multi-hunk diff via the EXISTING resolveDiff seam, resolving the approval', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const req = makeEditReq('src/multi.ts');
    // Two well-separated changes => two distinct hunks from buildDiffHunks.
    req.toolCall.content = [
      {
        type: 'diff',
        path: 'src/multi.ts',
        oldText: Array.from({ length: 20 }, (_, i) => (i === 0 ? 'first-old' : `line${i}`)).join('\n'),
        newText: Array.from({ length: 20 }, (_, i) =>
          i === 0 ? 'first-new' : i === 19 ? 'last-new' : `line${i}`,
        ).join('\n'),
      },
    ];
    const pending = callRequestPermission(backend)(req);
    await waitForApprovalCard(messages);
    expect(registry.getFile('session-1', 'edit-1', 'src/multi.ts')).toBeDefined();

    (backend as unknown as { acceptWholeFileDiff(sessionId: string, toolId: string): void }).acceptWholeFileDiff(
      'session-1',
      'edit-1',
    );

    const outcome = await pending;
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(registry.getFile('session-1', 'edit-1', 'src/multi.ts')).toBeUndefined();
  });

  it('W4-T3b I-1: acceptWholeFileDiff routes by the URI sessionId, NOT the ambient active session', async () => {
    const { backend, registry, messages } = makePolicyBackendWithRegistry();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    seam(backend).cwd = '/ws';
    seam(backend).currentTurnProtected = true;

    const req = makeEditReq('src/a.ts');
    const pending = callRequestPermission(backend)(req);
    await waitForApprovalCard(messages);
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeDefined();

    // Simulate the multi-tab desync the fix defends: the host's ambient
    // `activeSessionId` is some OTHER tab (the last session to act), NOT the
    // session that owns this diff. Under the old ambient routing
    // (`activeController()`), the accept would hit the wrong/absent controller
    // and leave session-1's approval HANGING (never-resolves).
    (backend as unknown as { activeSessionId: string | undefined }).activeSessionId = 'ghost-active';

    (backend as unknown as { acceptWholeFileDiff(sessionId: string, toolId: string): void }).acceptWholeFileDiff(
      'session-1',
      'edit-1',
    );

    // Routed by the explicit sessionId → session-1's approval resolves.
    const outcome = await pending;
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(registry.getFile('session-1', 'edit-1', 'src/a.ts')).toBeUndefined();
  });
});

/** Like {@link makeStartableBackend} but seeds each client's reported `newSession` mode (drift scenario). */
function makeStartableWithMode(modeId: string): { backend: AcpBackend; clients: FakeAcpClient[] } {
  const config: HermesRuntimeConfig = { hermesPath: '/fake/hermes' };
  const clients: FakeAcpClient[] = [];
  const createClient: AcpClientFactory = (options) => {
    const client = new FakeAcpClient(options);
    client.newSessionModeId = modeId;
    clients.push(client);
    return client;
  };
  const backend = new AcpBackend(config, undefined, createClient);
  seam(backend).control = new FakeControlChannel();
  return { backend, clients };
}

describe('AcpBackend — W2-F1: wire-mode pin (never accept_edits/dont_ask; re-assert default)', () => {
  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
  });

  it('re-asserts default after newSession reports a non-default mode (accept_edits drift)', async () => {
    const { backend, clients } = makeStartableWithMode('accept_edits');

    await backend.start();

    expect(must(clients[0]).setSessionModeCalls).toContainEqual({ sessionId: 'session-1', modeId: 'default' });
  });

  it('does NOT re-assert when newSession already reports default (cheap no-op on the happy path)', async () => {
    const { backend, clients } = makeStartableWithMode('default');

    await backend.start();

    expect(must(clients[0]).setSessionModeCalls).toEqual([]);
  });

  it('re-asserts default after loadSession reports a non-default mode (the resume drift window)', async () => {
    const { backend, client } = makeBackend();
    mockWorkspace.workspaceFolders = undefined; // no roots -> load cwd confinement skipped
    client.setLoadSessionResult({ found: true, currentModeId: 'accept_edits' });

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });

    expect(client.setSessionModeCalls).toContainEqual({ sessionId: 'old-session', modeId: 'default' });
  });

  it('a default-preset prompt never sends a non-default wire mode (per-turn pin)', async () => {
    const { backend, client } = makeBackend();

    backend.sendPrompt('session-1', 'hello', 'default');
    await flushMicrotasks();

    // currentMode is already 'default', so no per-turn setSessionMode churn.
    expect(client.setSessionModeCalls).toEqual([]);
  });

  /**
   * CF-01/I-2 (W1-T3, concurrency-critical): `pinWireModeDefault` is called
   * from TWO await sites that must never let a REJECTED `setSessionMode`
   * escape uncaught — `loadReplay` (`SessionController.ts` ~:1123) and
   * `openSession` (`AcpBackend.ts` ~:754). Before this fix, NEITHER call
   * site wrapped the pin, so a rejection propagated:
   *  - out of `loadReplay` -> `loadSessionIntoTab` -> `invokeControl`,
   *    falsifying `loadReplay`'s documented "never rejects" contract and
   *    leaving the webview's transcript stuck mid-turn (the `clear`/
   *    `turn.start` pair it already emitted is never closed by a `turn.end`
   *    — a genuinely different, protocol-level channel from the
   *    `control.response{ok:false}` `TalariaViewProvider` turns the
   *    rejection into, so that outer catch does NOT paper over this).
   *  - out of `openSession` -> `establishInitialSession`'s try/catch, which
   *    (correctly) stops it from crashing `start()`, but DISHONESTLY
   *    reports the whole session establish as FAILED (`system.error`) even
   *    though `tab.bound`/`mode.state` already fired moments earlier and the
   *    session is actually live and usable — the "V-4/V-5 cards honesty"
   *    class of bug this codebase has repeatedly hardened against.
   *
   * The fix lives in ONE place — `pinWireModeDefault` itself now catches
   * `setSessionMode`'s rejection, logs status-only, and returns without
   * throwing — so both call sites are closed by construction; no call-site
   * wrapping is duplicated at either await.
   */
  describe('CF-01/I-2 (W1-T3): a REJECTED setSessionMode pin degrades instead of propagating', () => {
    it('loadReplay: never rejects past the pin, and still emits the closing turn.end (found:true, mode drift, setSessionMode rejects)', async () => {
      const { backend, client, messages } = makeBackend();
      mockWorkspace.workspaceFolders = undefined; // no roots -> load cwd confinement skipped (mirrors :6854)
      client.setLoadSessionResult({ found: true, currentModeId: 'accept_edits' }); // forces the pin's setSessionMode call
      client.setSessionMode = (sessionId: string, modeId: string) => {
        client.setSessionModeCalls.push({ sessionId, modeId }); // still record the attempt, like the real method does
        return Promise.reject(new Error('wire: setSessionMode failed'));
      };

      // RED (pre-fix): this rejects — `loadReplay`'s "never rejects" contract
      // is falsified by the un-caught pin at SessionController.ts ~:1123.
      const result = await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });
      expect(result).toBeDefined(); // the load itself genuinely succeeded — only the best-effort pin degraded

      // The pin was attempted (recorded before it rejected) — this is a real
      // degrade, not a silent skip.
      expect(client.setSessionModeCalls).toContainEqual({ sessionId: 'old-session', modeId: 'default' });

      // The closing terminal signal is still emitted — the webview is never
      // left stuck mid-turn with an opened-but-never-closed transcript.
      const turnEnds = messages.filter((m) => m.type === 'turn.end');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]).toMatchObject({ status: 'complete' }); // the replay itself succeeded
      expect(messages.filter((m) => m.type === 'error')).toEqual([]); // status-only log, never a user-facing error for a best-effort pin
    });

    /**
     * CF-01 (W1-T3 review, CRITICAL fix): the brief's concrete failing
     * scenario end to end — crash-recovery/History `loadReplay` for a
     * session Hermes reports as `accept_edits` (real drift), whose re-pin
     * ALSO rejects. The load itself still degrades honestly (proven by the
     * test right above). The bug: before the fix, `currentMode` stayed
     * `'default'` regardless (the ONLY value ever assigned to it anywhere in
     * the file), so `runTurn`'s `!== 'default'` re-pin check could never
     * fire — a subsequent prompt would reach `client.prompt` on a session
     * that is STILL `accept_edits` server-side, Hermes auto-applying edits
     * with no `request_permission`, our whole out-of-process approval gate
     * silently bypassed for the session's entire life. Fixed: the degraded
     * pin now seeds `currentMode` with the drifted id, so the NEXT turn
     * genuinely re-attempts the pin — and, since it ALSO fails here, aborts
     * the turn honestly instead of ever reaching `client.prompt`.
     */
    it('CF-01 fix: a loadReplay-drifted session with a persistently-failing pin ABORTS its next turn — never reaches client.prompt', async () => {
      const { backend, client, messages } = makeBackend();
      mockWorkspace.workspaceFolders = undefined; // no roots -> load cwd confinement skipped
      client.setLoadSessionResult({ found: true, currentModeId: 'accept_edits' }); // forces the pin's setSessionMode call
      client.setSessionMode = (sessionId: string, modeId: string) => {
        client.setSessionModeCalls.push({ sessionId, modeId }); // still record the attempt, like the real method does
        return Promise.reject(new Error('wire: setSessionMode failed'));
      };

      await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });
      messages.length = 0; // isolate the assertions below to the NEXT turn only

      backend.sendPrompt('old-session', 'hello', 'default');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(0); // never reached — fail-closed
      // The re-pin was genuinely re-attempted on the next turn (not skipped
      // as dead code): one attempt from the load's own degraded pin, one
      // from runTurn's re-pin.
      expect(
        client.setSessionModeCalls.filter((c) => c.sessionId === 'old-session' && c.modeId === 'default'),
      ).toHaveLength(2);
      expect(messages.some((m) => m.type === 'error')).toBe(true);
      expect(messages).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'error' }));
    });

    it('openSession: a rejected pin does not turn an already-bound session into a spurious start failure — but a STILL-drifted session then fail-closes its next turn (CF-01 review fix)', async () => {
      const { backend, clients } = makeStartableBackend(undefined, (client) => {
        client.newSessionModeId = 'accept_edits'; // forces the pin's setSessionMode call
        client.setSessionMode = (sessionId: string, modeId: string) => {
          client.setSessionModeCalls.push({ sessionId, modeId }); // still record the attempt, like the real method does
          return Promise.reject(new Error('wire: setSessionMode failed'));
        };
      });
      const messages: HostToWebviewMessage[] = [];
      backend.onMessage((m) => messages.push(m));

      // `openSession`'s pin degrades honestly — no spurious `system.error`;
      // `tab.bound`/`mode.state` already fired for a session that is
      // genuinely live and usable, so the whole establish is NOT reported
      // failed just because the best-effort re-assert didn't land.
      await backend.start();

      expect(messages.some((m) => m.type === 'tab.bound')).toBe(true);
      expect(messages.filter((m) => m.type === 'system.error')).toEqual([]);
      expect(must(clients[0]).setSessionModeCalls).toContainEqual({ sessionId: 'session-1', modeId: 'default' });

      // Not wedged: the start-tail resets to idle...
      expect(seam(backend).inFlightStart).toBeUndefined();

      // CF-01 (W1-T3 review, CRITICAL fix): the session is STILL accept_edits
      // server-side — the pin never actually succeeded. The OLD version of
      // this test asserted the next prompt proceeds anyway
      // (`promptCallCount===1`), which was the bug this fix closes: that
      // would let a prompt reach Hermes on an unconfirmed accept_edits
      // session, with NO `request_permission` — our whole approval gate
      // silently bypassed. After the fix, `currentMode` was seeded with the
      // drifted id, so `runTurn`'s re-pin check is a REAL backstop: it
      // genuinely retries `setSessionMode` — and since this mock keeps
      // rejecting, the turn now ABORTS honestly instead of silently
      // proceeding.
      messages.length = 0;
      backend.sendPrompt('session-1', 'hello', 'default');
      await flushMicrotasks();

      expect(must(clients[0]).promptCallCount).toBe(0); // client.prompt is NEVER reached — fail-closed
      // The re-pin was genuinely attempted a second time — not skipped as dead code.
      expect(must(clients[0]).setSessionModeCalls.filter((c) => c.modeId === 'default')).toHaveLength(2);
      expect(messages.some((m) => m.type === 'error')).toBe(true);
      expect(messages).toContainEqual(expect.objectContaining({ type: 'turn.end', status: 'error' }));
    });
  });

  // P7-N10: the sessionId-less fan-out `setMode` (`ControlDispatcher.setMode`
  // -> `AcpBackend.setMode`, looping `controller.setMode(mode)` over EVERY
  // live session with no sessionId on the wire) was a twice-flagged latent
  // footgun — safe only because its one caller hardcoded 'default'. YAGNI-
  // deleted (not clamped): grep confirmed it had no caller beyond that
  // hardcoded pinned-default use, and the wire message was never actually
  // sent by the webview (the mode picker uses a completely different path,
  // `mode.set` -> `setCustomMode`, sessionId-scoped, untouched). Deleting the
  // WHOLE vestigial vertical slice (wire type -> TalariaViewProvider handler
  // -> AgentBackend interface -> AcpBackend/ControlDispatcher fan-out) is
  // strictly safer than clamping it in place: a sessionId-less broadcast
  // method can no longer exist to be misused by a future caller, however
  // well-intentioned.
  it('P7-N10 footgun-closed: AcpBackend no longer exposes a setMode fan-out method at all', () => {
    const { backend } = makeBackend();

    // Cast through `unknown` so this compiles regardless of whether the
    // class happens to declare the member — the point of this guard is
    // exactly that it must NOT be declared. Before the P7-N10 delete this
    // was a callable function (RED); after, it is structurally absent.
    expect((backend as unknown as Record<string, unknown>).setMode).toBeUndefined();
  });

  // P7-N10: the fan-out `setMode` deletion is only safe because "every
  // session stays pinned at 'default'" was NEVER load-bearing on it — the
  // OTHER pin mechanisms in this same describe block (constructor init,
  // newSession/loadSession reassert-on-drift, the per-turn reassert) already
  // cover it independently. This test proves that holds across MULTIPLE
  // simultaneous sessions too, with no fan-out call anywhere in the picture
  // — the "pinned-default behavior on bind is preserved" proof the brief
  // calls for.
  it('P7-N10: every live session still starts pinned at default on bind, with no setMode fan-out involved', () => {
    const { backend } = makeBackend(); // mints session-1
    seam(backend).cwd = '/ws-2';
    seam(backend).sessionId = 'session-2'; // mints a second live controller

    expect(seamFor(backend, 'session-1').currentMode).toBe('default');
    expect(seamFor(backend, 'session-2').currentMode).toBe('default');
  });
});

describe('AcpBackend — W2-F1: turnProtected tracking in the pre-turn snapshot barrier', () => {
  it('sets currentTurnProtected true when a positive-ordinal snapshot RESOLVES', async () => {
    const { backend } = makeBackendWithCheckpoints();
    await callSnapshotCheckpoint(backend)(1, 'do work');
    expect(seam(backend).currentTurnProtected).toBe(true);
  });

  it('treats the dedup `null` snapshot as protected too (the tree is already captured)', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    tracker.snapshot = async () => null;
    await callSnapshotCheckpoint(backend)(2, 'x');
    expect(seam(backend).currentTurnProtected).toBe(true);
  });

  it('clears currentTurnProtected to false when a positive-ordinal snapshot REJECTS', async () => {
    const { backend, tracker } = makeBackendWithCheckpoints();
    seam(backend).currentTurnProtected = true; // a prior turn was protected
    tracker.snapshot = async () => {
      throw new Error('git boom');
    };
    await callSnapshotCheckpoint(backend)(3, 'x');
    expect(seam(backend).currentTurnProtected).toBe(false);
  });

  it('a negative-ordinal session baseline snapshot does NOT touch currentTurnProtected', async () => {
    const { backend } = makeBackendWithCheckpoints();
    seam(backend).currentTurnProtected = true;
    await callSnapshotCheckpoint(backend)(-1, 'Session start');
    expect(seam(backend).currentTurnProtected).toBe(true);
  });

  it('stays false when no tracker is wired (a turn is unprotected by construction)', async () => {
    const { backend } = makeBackend();
    await callSnapshotCheckpoint(backend)(1, 'x');
    expect(seam(backend).currentTurnProtected).toBe(false);
  });
});

describe('AcpBackend — W2-F1: Plan preamble injection', () => {
  it('prepends the pinned Plan preamble to the prompt content under the plan preset', async () => {
    const { backend, client } = makeBackend();
    backend.setPreset('session-1', 'plan');

    backend.sendPrompt('session-1', 'add a feature', 'default');
    await flushMicrotasks();

    const content = client.lastPromptContent as Array<{ type: string; text?: string }>;
    expect(must(content[0]).type).toBe('text');
    expect(must(content[0]).text?.startsWith('[PLAN MODE] Plan only.')).toBe(true);
    expect(must(content[0]).text).toContain('add a feature');
  });

  it('does NOT prepend the preamble under a non-plan preset', async () => {
    const { backend, client } = makeBackend();
    backend.setPreset('session-1', 'normal');

    backend.sendPrompt('session-1', 'add a feature', 'default');
    await flushMicrotasks();

    const content = client.lastPromptContent as Array<{ type: string; text?: string }>;
    expect(must(content[0]).text).toBe('add a feature');
  });
});

describe('AcpBackend — W2-F1: setPreset pushes policy.state', () => {
  it('pushes policy.state and audit-logs when the preset changes', () => {
    const logs: string[] = [];
    const backend = new AcpBackend({} as HermesRuntimeConfig, { append: (l) => logs.push(l) });
    // W4-T1a: activePreset moved onto the per-session SessionController
    // (§2a) — setPreset now routes `this.sessions.get(sessionId)?.setPreset(...)`
    // per the router table, so a session must exist to target.
    seam(backend).sessionId = 'session-1';
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    backend.setPreset('session-1', 'strict');

    expect(backend.getPreset()).toBe('strict');
    expect(messages).toEqual([{ type: 'policy.state', sessionId: 'session-1', preset: 'strict' }]);
    expect(logs.some((l) => /preset changed: manual -> strict/.test(l))).toBe(true);
  });

  it('is a no-op when the preset is unchanged (no duplicate push)', () => {
    const { backend, messages } = makeBackend();
    backend.setPreset('session-1', 'manual'); // already manual
    expect(messages).toEqual([]);
  });
});

describe('AcpBackend — W2 S0: sendPrompt optional `mentions` param (scaffolding, unused)', () => {
  const SOME_MENTIONS: ContextRef[] = [
    { id: 'm1', kind: 'file', path: 'src/auth/login.ts' },
    { id: 'm2', kind: 'selection' },
  ];

  it('accepts a `mentions` array without throwing and starts the turn normally', async () => {
    const { backend, client, messages } = makeBackend();

    expect(() => backend.sendPrompt('session-1', 'first prompt', 'default', undefined, SOME_MENTIONS)).not.toThrow();
    await flushMicrotasks();

    expect(client.promptCallCount).toBe(1);
    expect(messages[0]).toEqual({ type: 'turn.start', turnId: 'turn-1', sessionId: 'session-1' });
  });

  it('does not affect the outbound prompt content sent to Hermes (T2 will consume it; unused at S0)', async () => {
    const withoutMentions = makeBackend();
    withoutMentions.backend.sendPrompt('session-1', 'add a feature', 'default');
    await flushMicrotasks();

    const withMentions = makeBackend();
    withMentions.backend.sendPrompt('session-1', 'add a feature', 'default', undefined, SOME_MENTIONS);
    await flushMicrotasks();

    expect(withMentions.client.lastPromptContent).toEqual(withoutMentions.client.lastPromptContent);
  });
});

/**
 * T5b (§2c): backend wired for the one-shot utility-model surface —
 * client/sessionId/cwd pre-seeded (mirroring `makeBackend()`), optionally
 * with an injected checkpoint tracker (req 3's before-snapshot) and a
 * log-capturing logger (req 1's audit lines, req 3's tripwire log).
 */
function makeOneShotBackend(tracker?: CheckpointTrackerLike): {
  backend: AcpBackend;
  client: FakeAcpClient;
  messages: HostToWebviewMessage[];
  logs: string[];
} {
  const logs: string[] = [];
  const backend = new AcpBackend({} as HermesRuntimeConfig, { append: (l) => logs.push(l) }, undefined, tracker);
  const client = new FakeAcpClient();
  seam(backend).client = client;
  // W4-T2: `cwd` MUST be set BEFORE `sessionId` mints the controller — the
  // controller's `port.root` is resolved ONCE, synchronously, at mint time
  // (mirrors production: `openSession`/`loadSessionIntoTab` always know
  // `cwd` before building the port). Minting first then changing `cwd`
  // would bake in the WRONG root (the empty-cwd default). Post-W6-FG,
  // `oneShot()` resolves its root from the EXPLICIT `opts.cwd` it's called
  // with (never from the live `this.cwd`) — the tests below always pass
  // `{ cwd: '/ws' }` to `oneShot()`, so this `seam(backend).cwd = '/ws'`
  // still needs to match: it's what mints `session-1`'s own controller/root
  // above, which is what these tests assert the one-shot's root-scoped
  // lease correctly shares (or doesn't) with.
  seam(backend).cwd = '/ws';
  seam(backend).sessionId = 'session-1';
  const messages: HostToWebviewMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  return { backend, client, messages, logs };
}

describe('AcpBackend.oneShot — §2c one-shot utility-model surface (T5b)', () => {
  it('resolves {ok:true, text} from collected agent_message_chunk text via a DIRECT ephemeral newSession([]) — never start()/startInternal()', async () => {
    const { backend, client, messages } = makeOneShotBackend();
    client.queueSessionId('ephemeral-1');

    const resultPromise = backend.oneShot('Summarize this diff', { cwd: '/ws' });
    await flushMicrotasks();

    // Direct newSession(cwd, []) — no MCP/RAG servers, exactly ONE call (never
    // start()/startInternal(), which would also spawn control.start() etc.).
    expect(client.newSessionCalls).toEqual([{ cwd: '/ws', mcpServers: [] }]);
    expect(client.promptCallCount).toBe(1);
    expect(client.lastPromptContent).toEqual([{ type: 'text', text: 'Summarize this diff' }]);

    fireSessionUpdate(backend)('ephemeral-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'feat: add x' },
    });
    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();

    expect(await resultPromise).toEqual({ ok: true, text: 'feat: add x' });
    // Invisible to the webview and the turn/checkpoint machinery.
    expect(messages).toEqual([]);
    expect(seam(backend).currentTurnId).toBeUndefined();
    expect(seam(backend).liveTurnId).toBeUndefined();
  });

  it('refuses with {ok:false} and never calls client.newSession when Hermes is not started', async () => {
    const backend = new AcpBackend({} as HermesRuntimeConfig);
    const result = await backend.oneShot('hi', { cwd: '/ws' });
    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });

  describe('req 4 — bidirectional SYNCHRONOUS mutual exclusion', () => {
    it('oneShot refuses while a main turn is live (liveTurnId set) — never calls client.newSession', async () => {
      const { backend, client } = makeOneShotBackend();
      backend.sendPrompt('session-1', 'main turn', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);

      const result = await backend.oneShot('quiet call', { cwd: '/ws' });

      expect(result).toEqual({ ok: false, error: expect.stringContaining('turn') });
      expect(client.newSessionCalls).toEqual([]); // no ephemeral session was ever opened

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
    });

    it('sendPrompt refuses while a one-shot is in flight (root lease, F1) — no phantom user bubble, no second client.prompt', async () => {
      const { backend, client, messages } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const oneShotPromise = backend.oneShot('quiet call', { cwd: '/ws' });
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1); // the ephemeral prompt only
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(true);

      backend.sendPrompt('session-1', 'main turn', 'default');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(1); // the main turn was refused, never sent
      expect(messages.filter((m) => m.type === 'user')).toEqual([]);
      expect(messages.filter((m) => m.type === 'turn.start')).toEqual([]);
      expect(messages).toEqual([{ type: 'error', sessionId: 'session-1', message: expect.stringContaining('already running') }]);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await oneShotPromise;
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(false); // released once the one-shot settles
    });

    it('checkpoint.restore / checkpoint.redo refuse while a one-shot is in flight (extends the P3 interlock)', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeOneShotBackend(tracker);
      client.queueSessionId('ephemeral-1');
      const oneShotPromise = backend.oneShot('quiet call', { cwd: '/ws' });
      await flushMicrotasks();

      const restoreResult = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
      const redoResult = (await backend.invokeControl('checkpoint.redo', {})) as RestoreResult;

      expect(restoreResult.restored).toBe(false);
      expect(redoResult.restored).toBe(false);
      expect(tracker.restoreCalls).toEqual([]); // the tracker was never reached
      expect(tracker.redoCalls).toEqual([]);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await oneShotPromise;
    });

    it('restore/redo are allowed again once the one-shot settles', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeOneShotBackend(tracker);
      client.queueSessionId('ephemeral-1');
      const oneShotPromise = backend.oneShot('quiet call', { cwd: '/ws' });
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await oneShotPromise;

      const restoreResult = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;
      expect(restoreResult.restored).toBe(true);
    });
  });

  describe('C1 (Critical) — the wall-clock deadline covers the ENTIRE flow (newSession → setSessionMode → prompt), not just the prompt phase', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a hung client.newSession no longer wedges the root lease — the deadline still fires and releases the backend', async () => {
      const { backend, client, messages } = makeOneShotBackend();
      client.hangNewSession(); // newSession() never resolves — a child alive-but-unresponsive during session/new
      const cancelSpy = vi.spyOn(client, 'cancel');

      const resultPromise = backend.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
      await flushMicrotasks();
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(true); // still synchronously set (req 4 unchanged)

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await resultPromise).toEqual({ ok: false, error: 'timed out' });
      // C1: the lease is released even though `newSession` itself never resolved
      // — before the fix, `runOneShot` was still stuck on `await client.newSession(...)`
      // here and this would hang forever.
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(false);
      // No session id was ever obtained (newSession never resolved) — nothing to cancel.
      expect(cancelSpy).not.toHaveBeenCalled();

      // The backend is not permanently wedged: a subsequent sendPrompt is not
      // refused by a stuck lease — it reaches client.prompt normally.
      backend.sendPrompt('session-1', 'main turn', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);
      expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    });

    it('a hung client.setSessionMode (session already created) is cancelled at the deadline, same as a hung prompt', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      client.newSessionModeId = 'accept_edits'; // forces the setSessionMode call the deadline must also cover
      client.setSessionMode = () => new Promise<void>(() => {}); // never resolves
      const cancelSpy = vi.spyOn(client, 'cancel');

      const resultPromise = backend.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(0); // never reached — still stuck on setSessionMode

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await resultPromise).toEqual({ ok: false, error: 'timed out' });
      expect(cancelSpy).toHaveBeenCalledWith('ephemeral-1'); // a session WAS created — best-effort cancel fires
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(false);
    });
  });

  describe('req 6 — stream isolation (never reaches the webview or the turn machinery)', () => {
    it('reasoning/message/plan updates on the ephemeral session never fire on the webview emitter', async () => {
      const { backend, client, messages } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      });
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      });
      fireSessionUpdate(backend)('ephemeral-1', { sessionUpdate: 'plan', entries: [] });

      expect(messages).toEqual([]);
      // Test-strengthening (review): `messages === []` alone is non-discriminating
      // — the pre-existing `sessionId !== this.sessionId` drop guard ALSO yields
      // `[]`. Assert the update was actually collected into the ephemeral
      // collector's OWN state directly (not just inferred from the final
      // settled result below) — this pins that `handleSessionUpdate` took the
      // ephemeral-FIRST branch, not the drop guard.
      expect(ephemeralCollectedText(backend, 'ephemeral-1')).toBe('hello');

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      expect(await resultPromise).toEqual({ ok: true, text: 'hello' });
    });

    it('the main session still streams normally to the webview once the one-shot has settled', async () => {
      const { backend, client, messages } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await resultPromise;

      backend.sendPrompt('session-1', 'main turn', 'default');
      await flushMicrotasks();
      expect(messages.some((m) => m.type === 'turn.start')).toBe(true);
    });
  });

  describe('req 3 — tool-call tripwire + fail-open before-snapshot', () => {
    it('a non-read/think tool_call cancels the ephemeral session and fails the one-shot', async () => {
      const { backend, client, logs } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'write_file',
        kind: 'edit',
      });
      await flushMicrotasks();

      expect(cancelSpy).toHaveBeenCalledWith('ephemeral-1');
      expect(await resultPromise).toEqual({ ok: false, error: 'unexpected tool call' });
      expect(logs.some((l) => l.includes('tripwire'))).toBe(true);
    });

    it('a MISSING kind also trips the wire (fail-closed, not fail-open)', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'mystery tool',
      });
      await flushMicrotasks();

      expect(cancelSpy).toHaveBeenCalledWith('ephemeral-1');
      expect(await resultPromise).toEqual({ ok: false, error: 'unexpected tool call' });
    });

    it('read/think tool_calls do NOT trip the wire — the one-shot completes normally', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read a file',
        kind: 'read',
      });
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        kind: 'think',
      });
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      });
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(await resultPromise).toEqual({ ok: true, text: 'ok' });
    });

    it('I2: a kind-LESS tool_call_update INHERITS the recorded kind — a normal read/think status upsert does not over-trip', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read a file',
        kind: 'read',
      });
      // The normal upsert shape a real read/think tool sends: a status-only
      // `tool_call_update` with NO `kind` at all (kind is OPTIONAL on an
      // update — acp/types.ts:105). Before I2 this unconditionally tripped.
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      });
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      });
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(await resultPromise).toEqual({ ok: true, text: 'ok' });
    });

    it('fires a fail-open before-snapshot on the checkpoint tracker before the ephemeral prompt, WITHOUT touching currentTurnProtected', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeOneShotBackend(tracker);
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      expect(tracker.snapshotCalls).toHaveLength(1);
      expect(seam(backend).currentTurnProtected).toBe(false); // untouched — the one-shot stays invisible

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await resultPromise;
    });

    it('T1a-I1: the before-snapshot uses a NEGATIVE non-turn ordinal (never the positive per-turn space) so its <tree>-<ordinal> id cannot collide', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeOneShotBackend(tracker);
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      expect(tracker.snapshotCalls).toHaveLength(1);
      const call = must(tracker.snapshotCalls[0]);
      expect(call.label).toBe('One-shot utility call');
      // POSITIVE ordinals are the per-turn space (SessionController.turnCounter);
      // a protective one-shot snapshot MUST land in the NEGATIVE non-turn space
      // (shared with baselines), else a turn→restore-to-prior-tree→one-shot
      // sequence re-stores the recurrent tree with a duplicate id. Before the
      // T1a-I1 fix this was +1 → collided with per-turn ordinal 1.
      expect(call.turnOrdinal).toBeLessThan(0);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await resultPromise;
    });

    it('T1a-I1: successive one-shots mint DISTINCT negative ordinals (monotonic, no self-collision)', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeOneShotBackend(tracker);

      client.queueSessionId('ephemeral-1');
      const p1 = backend.oneShot('one', { cwd: '/ws' });
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await p1;

      client.queueSessionId('ephemeral-2');
      const p2 = backend.oneShot('two', { cwd: '/ws' });
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await p2;

      expect(tracker.snapshotCalls.map((c) => c.turnOrdinal)).toEqual([-1, -2]);
    });

    it('a snapshot failure is fail-open (logged, never fails the one-shot)', async () => {
      const tracker = new FakeCheckpointTracker();
      tracker.snapshot = async () => {
        throw new Error('git boom');
      };
      const { backend, client, logs } = makeOneShotBackend(tracker);
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      });
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();

      expect(await resultPromise).toEqual({ ok: true, text: 'ok' });
      expect(logs.some((l) => l.includes('before-snapshot failed'))).toBe(true);
    });
  });

  describe('req 2 — ephemeral wire-mode pin', () => {
    it('re-asserts default on the ephemeral session when newSession reports drift, WITHOUT touching this.currentMode', async () => {
      const { backend, client } = makeOneShotBackend();
      // Test-strengthening (review): the old test started with `currentMode`
      // already `'default'`, so "left untouched" and "re-written to default"
      // were indistinguishable. Seed a DISTINCTIVE main-session mode first —
      // one the ephemeral pin would never legitimately write — so the
      // post-assertion below actually proves the main field was untouched.
      seam(backend).currentMode = 'dont_ask';
      client.queueSessionId('ephemeral-1');
      client.newSessionModeId = 'accept_edits';
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      expect(client.setSessionModeCalls).toContainEqual({ sessionId: 'ephemeral-1', modeId: 'default' });
      expect(seam(backend).currentMode).toBe('dont_ask'); // unchanged from the distinctive seed — proven untouched

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await resultPromise;
    });

    it('does not re-assert when newSession already reports default (cheap no-op)', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      expect(client.setSessionModeCalls).toEqual([]);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      await resultPromise;
    });
  });

  describe('req 5 — wall-clock deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a hanging ephemeral prompt is cancelled at the deadline and fails the one-shot', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');

      const resultPromise = backend.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(cancelSpy).toHaveBeenCalledWith('ephemeral-1');
      expect(await resultPromise).toEqual({ ok: false, error: 'timed out' });
    });

    it('defaults the deadline to 30s when no timeoutMs is given', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');

      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(cancelSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(cancelSpy).toHaveBeenCalledWith('ephemeral-1');
      expect(await resultPromise).toEqual({ ok: false, error: 'timed out' });
    });

    it('clears the deadline timer once the one-shot completes normally (no stray late cancel)', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const cancelSpy = vi.spyOn(client, 'cancel');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
      await flushMicrotasks();
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      });
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      expect(await resultPromise).toEqual({ ok: true, text: 'ok' });

      await vi.advanceTimersByTimeAsync(5_000); // the deadline would have fired here if left armed
      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });

  describe('V-10 (Tier-2 Important) ONESHOT-ORPHAN — a deadline firing BEFORE newSession resolves must cancel the orphan and never let it dispatch an un-leased prompt', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('V-10 (1): when newSession FINALLY resolves after the deadline already fired, the orphan is cancelled — no client.prompt, no spurious checkpoint, no surviving collector', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeOneShotBackend(tracker);
      client.delayNewSession(); // newSession() won't resolve until the test says so
      const cancelSpy = vi.spyOn(client, 'cancel');

      const resultPromise = backend.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
      await flushMicrotasks();
      expect(client.newSessionCalls).toEqual([{ cwd: '/ws', mcpServers: [] }]); // called, just not yet resolved

      await vi.advanceTimersByTimeAsync(5_000); // the deadline fires while still stuck awaiting newSession
      expect(await resultPromise).toEqual({ ok: false, error: 'timed out' });
      // At fire time no ephemeral id was known yet — the ORIGINAL deadline
      // handler (unchanged, `ephemeralId`-known case) has nothing to cancel.
      expect(cancelSpy).not.toHaveBeenCalled();

      // newSession finally resolves — AFTER the caller (`oneShot`) already
      // returned via the deadline. Before the fix this zombie continuation
      // registers a collector, mints a spurious negative-ordinal checkpoint,
      // and fires client.prompt with no deadline and no lease.
      client.resolveDelayedNewSession('ephemeral-1');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(0); // no un-leased prompt ever dispatches
      expect(tracker.snapshotCalls).toEqual([]); // no spurious checkpoint minted
      expect(cancelSpy).toHaveBeenCalledWith('ephemeral-1'); // the now-known id is best-effort cancelled
      expect(seam(backend).ephemeral.has('ephemeral-1')).toBe(false); // no surviving collector entry
    });

    it('V-10 (2): a real turn started right after the timeout runs ALONE — the orphan resolving even later never dispatches a second, concurrent prompt', async () => {
      const { backend, client, messages } = makeOneShotBackend();
      client.delayNewSession();

      const oneShotPromise = backend.oneShot('quiet call', { cwd: '/ws', timeoutMs: 5_000 });
      await flushMicrotasks();
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(true); // lease held while newSession is pending

      await vi.advanceTimersByTimeAsync(5_000); // deadline fires — oneShot's own `finally` releases the lease
      expect(await oneShotPromise).toEqual({ ok: false, error: 'timed out' });
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(false); // lease released

      // The user's next real turn acquires the SAME root's lease immediately.
      backend.sendPrompt('session-1', "the user's real next turn", 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1); // the real turn's prompt — the ONLY one so far
      expect(messages.some((m) => m.type === 'turn.start')).toBe(true);

      // The orphaned one-shot's newSession finally resolves, WHILE the real
      // turn's own prompt is still in flight — the exact concurrency the
      // class's mutual exclusion (§2c req 4 / F1) must never allow.
      client.resolveDelayedNewSession('ephemeral-1');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(1); // STILL just the real turn's — no concurrent orphan prompt landed

      client.resolveInFlightPrompt({ stopReason: 'end_turn' }); // settle the real turn cleanly
      await flushMicrotasks();
    });

    it('V-10 (3): the root lease is released EXACTLY once on both the happy path and a post-newSession (ephemeralId-known) timeout', async () => {
      const rootOf = (backend: AcpBackend, cwd: string): { releaseTurnLease(id: string): void } =>
        (backend as unknown as { resolveRootCoordinator(cwd: string): { releaseTurnLease(id: string): void } }).resolveRootCoordinator(cwd);

      // Happy path.
      {
        const { backend, client } = makeOneShotBackend();
        client.queueSessionId('ephemeral-1');
        const releaseSpy = vi.spyOn(rootOf(backend, '/ws'), 'releaseTurnLease');

        const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
        await flushMicrotasks();
        client.resolveInFlightPrompt({ stopReason: 'end_turn' });
        await flushMicrotasks();
        expect(await resultPromise).toEqual({ ok: true, text: '' });

        expect(releaseSpy).toHaveBeenCalledTimes(1);
      }

      // Post-newSession timeout: ephemeralId IS known (session already
      // created, stuck hanging on the prompt phase) when the deadline fires —
      // the ORIGINAL (unchanged) deadline-handler release path.
      {
        const { backend, client } = makeOneShotBackend();
        client.queueSessionId('ephemeral-1');
        const releaseSpy = vi.spyOn(rootOf(backend, '/ws'), 'releaseTurnLease');

        const resultPromise = backend.oneShot('hi', { cwd: '/ws', timeoutMs: 5_000 });
        await flushMicrotasks();
        expect(client.promptCallCount).toBe(1); // reached the prompt phase — ephemeralId is known

        await vi.advanceTimersByTimeAsync(5_000);
        expect(await resultPromise).toEqual({ ok: false, error: 'timed out' });

        expect(releaseSpy).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('req 5 — lifecycle settlement (teardown / crash / dispose)', () => {
    it('teardownSession settles an in-flight one-shot as failed (the caller is never left hanging)', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      callTeardownSession(backend)();
      await flushMicrotasks();

      expect(await resultPromise).toEqual({ ok: false, error: expect.any(String) });
      expect(anyLiveTurnOnRoot(backend, '/ws')).toBe(false);
    });

    it('handleAcpCrash settles an in-flight one-shot as failed', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      callHandleAcpCrash(backend)(1);
      await flushMicrotasks();

      expect(await resultPromise).toEqual({ ok: false, error: expect.any(String) });
    });

    it('dispose() settles an in-flight one-shot as failed (via teardownSession)', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      backend.dispose();
      await flushMicrotasks();

      expect(await resultPromise).toEqual({ ok: false, error: expect.any(String) });
    });

    it('I3: teardownSession CLEARS the ephemeral registry (no stale entry survives to blackhole a reused session id)', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();
      expect(seam(backend).ephemeral.size).toBe(1); // registered

      callTeardownSession(backend)();
      await flushMicrotasks();

      expect(await resultPromise).toEqual({ ok: false, error: expect.any(String) });
      expect(seam(backend).ephemeral.size).toBe(0); // I3: no stale entry left behind
    });

    it('I3: handleAcpCrash CLEARS the ephemeral registry', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();
      expect(seam(backend).ephemeral.size).toBe(1);

      callHandleAcpCrash(backend)(1);
      await flushMicrotasks();

      expect(await resultPromise).toEqual({ ok: false, error: expect.any(String) });
      expect(seam(backend).ephemeral.size).toBe(0);
    });
  });

  describe('req 1/5 — ephemeral registry deregistration timing', () => {
    it('deregisters the ephemeral session only AFTER the real client.prompt() call itself settles', async () => {
      const { backend, client } = makeOneShotBackend();
      client.queueSessionId('ephemeral-1');
      const resultPromise = backend.oneShot('hi', { cwd: '/ws' });
      await flushMicrotasks();

      // The tripwire settles the RESULT early, but the underlying prompt()
      // call is still pending — the registry entry must still be present so
      // a late permission request for it still resolves through the
      // ephemeral deny path, not the main one.
      fireSessionUpdate(backend)('ephemeral-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'write',
        kind: 'edit',
      });
      await flushMicrotasks();
      expect(await resultPromise).toEqual({ ok: false, error: 'unexpected tool call' });
      expect(seam(backend).ephemeral.has('ephemeral-1')).toBe(true); // prompt() hasn't settled yet

      client.resolveInFlightPrompt({ stopReason: 'cancelled' }); // the real prompt() finally settles
      await flushMicrotasks();
      expect(seam(backend).ephemeral.has('ephemeral-1')).toBe(false);
    });
  });
});

describe('AcpBackend.handleRequestPermission — §2c req 1: session-keyed 3-way dispatch', () => {
  it('the main session id still routes to the existing policy path (unchanged) — an ask card is emitted', async () => {
    const { backend, messages } = makePolicyBackend();
    void callRequestPermission(backend)(makeEditReq('/ws/notes.txt'));
    await waitForApprovalCard(messages);
    expect(messages.some((m) => m.type === 'approval.request')).toBe(true);
  });

  it("an ephemeral session id is denied (Cancelled) + audit-logged, WITHOUT ever reaching the active preset's auto-allow", async () => {
    const { backend, client, logs } = makeOneShotBackend();
    client.queueSessionId('ephemeral-1');
    // 'normal' auto-ALLOWS a safe protected-turn edit (N1) — proves the
    // dispatch denies BEFORE the request is ever evaluated under this preset.
    backend.setPreset('session-1', 'normal');
    seam(backend).currentTurnProtected = true;
    const oneShotPromise = backend.oneShot('hi', { cwd: '/ws' });
    await flushMicrotasks();

    const response = await callRequestPermission(backend)({
      sessionId: 'ephemeral-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'sneaky-1',
        title: 'Approve edit',
        kind: 'edit',
        content: [{ type: 'diff', path: '/ws/notes.txt', oldText: 'a', newText: 'b' }],
        rawInput: { tool: 'write_file', arguments: { path: '/ws/notes.txt', content: 'b' } },
      },
    });

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(logs.some((l) => l.includes('ephemeral one-shot session'))).toBe(true);

    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
    await oneShotPromise;
  });

  it('an unrecognized/foreign session id is denied (Cancelled) + audit-logged, fail-closed', async () => {
    const { backend, logs } = makeOneShotBackend();
    backend.setPreset('session-1', 'normal');
    seam(backend).currentTurnProtected = true;

    const response = await callRequestPermission(backend)({
      sessionId: 'totally-unrelated-session',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'foreign-1',
        title: 'Approve edit',
        kind: 'edit',
        content: [{ type: 'diff', path: '/ws/notes.txt', oldText: 'a', newText: 'b' }],
        rawInput: { tool: 'write_file', arguments: { path: '/ws/notes.txt', content: 'b' } },
      },
    });

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(logs.some((l) => l.includes('unrecognized session'))).toBe(true);
  });

  it.each([
    ['an empty-string sessionId', ''],
    // `undefined` is a genuine runtime violation of the required `sessionId:
    // string` wire type — the cast simulates a malformed ACP payload that
    // slipped past JSON-RPC deserialization (defensive despite the type).
    ['an absent (undefined) sessionId', undefined as unknown as string],
  ])('W4-T1b hardening: %s is denied + audit-logged as malformed (never falls through to a card or a live controller)', async (_label, sessionId) => {
    const { backend, logs } = makeOneShotBackend();
    backend.setPreset('session-1', 'normal'); // would auto-allow if this ever bled in
    seam(backend).currentTurnProtected = true;

    const response = await callRequestPermission(backend)({
      sessionId,
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'malformed-1',
        title: 'Approve edit',
        kind: 'edit',
        content: [{ type: 'diff', path: '/ws/notes.txt', oldText: 'a', newText: 'b' }],
        rawInput: { tool: 'write_file', arguments: { path: '/ws/notes.txt', content: 'b' } },
      },
    });

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(logs.some((l) => l.includes('malformed'))).toBe(true);
  });
});

/**
 * W4-T1b — the P-0 security PROOF: `handleRequestPermission` dispatches on
 * `req.sessionId` to the LIVE controller (`AcpBackend.ts` §3.1(a)) whose
 * `handlePermission` reads ONLY its OWN `cwd`/`activePreset`/
 * `currentTurnProtected` (+ the injected `port.workspaceRoots()`) — never a
 * shared/global `AcpBackend` field. These tests drive the REAL production
 * dispatch (`callRequestPermission` reaches `AcpBackend.handleRequestPermission`
 * itself, not a re-implementation) with TWO live controllers at once, proving
 * session B is judged under B while A stays untouched.
 */
describe('AcpBackend.handleRequestPermission — W4-T1b: P-0 multi-controller policy isolation', () => {
  const tmpDirs: string[] = [];
  function makeTmpWs(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-t1b-ws-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  /** A backend with ONE live controller ('session-a') already minted — the
   * starting point every test below mints a SECOND controller ('session-b')
   * onto via {@link mintSecondController}. */
  function makeTwoControllerBackend(): {
    backend: AcpBackend;
    client: FakeAcpClient;
    messages: HostToWebviewMessage[];
    logs: string[];
  } {
    const logs: string[] = [];
    const backend = new AcpBackend({} as HermesRuntimeConfig, { append: (l) => logs.push(l) });
    const client = new FakeAcpClient();
    seam(backend).client = client;
    seam(backend).sessionId = 'session-a';
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    return { backend, client, messages, logs };
  }

  /** Mints a SECOND live controller alongside whatever is currently active
   * (mirrors `seam()`'s own mint path — `sessions.has` guards re-minting) and
   * gives it its own `cwd`, sharing the SAME client/root every real tab on
   * one connection would share (T1a's single-instance-bridge reality). */
  function mintSecondController(backend: AcpBackend, sessionId: string, cwd: string): void {
    seam(backend).sessionId = sessionId;
    seam(backend).cwd = cwd;
  }

  /** Like {@link makeEditReq} but the caller supplies BOTH the target
   * sessionId and the (relative) edit path — needed once a test drives TWO
   * controllers through the SAME `handleRequestPermission` router. */
  function makeEditReqFor(sessionId: string, p: string): AcpRequestPermissionRequest {
    return {
      sessionId,
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: `edit-${sessionId}-${p}`,
        title: `Approve edit: ${p}`,
        kind: 'edit',
        content: [{ type: 'diff', path: p, oldText: 'a', newText: 'b' }],
        rawInput: { tool: 'write_file', arguments: { path: p, content: 'b' } },
      },
    };
  }

  /** Writes ONLY the connection-level `AcpBackend.cwd` field directly —
   * deliberately bypassing `seam()`'s cwd setter (which write-throughs to
   * the ACTIVE controller too) so a test can diverge the shared/global field
   * from BOTH controllers' own `cwd` without corrupting either of them. */
  function setSharedCwd(backend: AcpBackend, cwd: string): void {
    (backend as unknown as { cwd: string }).cwd = cwd;
  }

  it("an edit on B is canonicalized against B's OWN cwd — never a stale/foreign AcpBackend.cwd (the exact P-0 bleed vector, architecture doc §3.1)", async () => {
    const { backend, messages } = makeTwoControllerBackend();
    const wsA = makeTmpWs();
    const wsB = path.join(wsA, 'nested-b'); // B's cwd nests inside the sole registered root
    mkdirSync(wsB, { recursive: true });
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: wsA } }];

    seam(backend).cwd = wsA; // session-a is active: sets AcpBackend.cwd AND session-a.cwd
    seamFor(backend, 'session-a').currentTurnProtected = true;
    backend.setPreset('session-a', 'normal');

    mintSecondController(backend, 'session-b', wsB); // session-b.cwd = wsB (AcpBackend.cwd -> wsB too, transiently)
    seamFor(backend, 'session-b').currentTurnProtected = true;
    backend.setPreset('session-b', 'normal');

    // Deliberately diverge the SHARED connection-level field from BOTH
    // controllers' own (correct) cwd — if `handlePermission`'s canonicalization
    // ever regressed to reading this shared field instead of `this.cwd` (the
    // controller's OWN field), the resolution below would silently shift to
    // this bogus path and fail to resolve inside the workspace.
    setSharedCwd(backend, '/nonexistent/stale-global-cwd');
    expect(seamFor(backend, 'session-a').cwd).toBe(wsA); // sanity: untouched by the poison write
    expect(seamFor(backend, 'session-b').cwd).toBe(wsB);

    const outcomeB = await callRequestPermission(backend)(makeEditReqFor('session-b', 'x.txt'));
    const outcomeA = await callRequestPermission(backend)(makeEditReqFor('session-a', 'x.txt'));

    // Both resolve to N1 auto-allow — proof each was canonicalized against
    // ITS OWN cwd (a bled/foreign base would resolve OUTSIDE the workspace,
    // or throw during realpath, and fall to `ask` instead).
    expect(outcomeB).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(outcomeA).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(messages.some((m) => m.type === 'approval.request')).toBe(false);
  });

  it("the auto-allow-bleed test: A=normal+protected auto-allows; B=manual still asks under B's OWN preset; the card carries B's sessionId", async () => {
    const { backend, messages } = makeTwoControllerBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];

    seam(backend).cwd = ws;
    seamFor(backend, 'session-a').currentTurnProtected = true;
    backend.setPreset('session-a', 'normal');

    mintSecondController(backend, 'session-b', ws);
    seamFor(backend, 'session-b').currentTurnProtected = true;
    // B stays 'manual' (the default) — deliberately NOT switched to 'normal'.

    // Sanity: A's own normal+protected edit auto-allows (N1) — the baseline
    // a bleed would leak into B.
    const outcomeA = await callRequestPermission(backend)(makeEditReqFor('session-a', 'a.ts'));
    expect(outcomeA).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

    // B's structurally-identical edit must NOT inherit A's auto-allow.
    const pendingB = callRequestPermission(backend)(makeEditReqFor('session-b', 'b.ts'));
    await waitForApprovalCard(messages);
    const card = messages.find((m) => m.type === 'approval.request') as Extract<
      HostToWebviewMessage,
      { type: 'approval.request' }
    >;
    expect(card.sessionId).toBe('session-b'); // renders in B's tab, never A's

    backend.respondApproval('session-b', card.id, 'allow_once');
    await expect(pendingB).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  });

  it("resolving B's approval settles ONLY B's ACP promise — A's stays pending until answered separately", async () => {
    const { backend, messages } = makeTwoControllerBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws; // manual (the default) on both — every edit asks
    mintSecondController(backend, 'session-b', ws);

    const pendingA = callRequestPermission(backend)(makeEditReqFor('session-a', 'a.ts'));
    const pendingB = callRequestPermission(backend)(makeEditReqFor('session-b', 'b.ts'));
    await vi.waitFor(() => {
      expect(messages.filter((m) => m.type === 'approval.request')).toHaveLength(2);
    });

    const cardA = messages.find(
      (m) => m.type === 'approval.request' && m.sessionId === 'session-a',
    ) as Extract<HostToWebviewMessage, { type: 'approval.request' }>;
    const cardB = messages.find(
      (m) => m.type === 'approval.request' && m.sessionId === 'session-b',
    ) as Extract<HostToWebviewMessage, { type: 'approval.request' }>;

    backend.respondApproval('session-b', cardB.id, 'allow_once');
    await expect(pendingB).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

    let settledA = false;
    void pendingA.then(() => {
      settledA = true;
    });
    await flushMicrotasks();
    expect(settledA).toBe(false); // untouched by B's resolution

    backend.respondApproval('session-a', cardA.id, 'deny');
    await expect(pendingA).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('branch (b): an ephemeral one-shot sessionId is denied WITHOUT consulting A or B, even when both are live under an auto-allow preset', async () => {
    const { backend, client, logs } = makeTwoControllerBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seamFor(backend, 'session-a').currentTurnProtected = true;
    backend.setPreset('session-a', 'normal');
    mintSecondController(backend, 'session-b', ws);
    seamFor(backend, 'session-b').currentTurnProtected = true;
    backend.setPreset('session-b', 'normal');

    client.queueSessionId('ephemeral-1');
    const oneShotPromise = backend.oneShot('hi', { cwd: ws });
    await flushMicrotasks();

    const response = await callRequestPermission(backend)({
      sessionId: 'ephemeral-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'sneaky-1',
        title: 'Approve edit',
        kind: 'edit',
        content: [{ type: 'diff', path: 'x.ts', oldText: 'a', newText: 'b' }],
        rawInput: { tool: 'write_file', arguments: { path: 'x.ts', content: 'b' } },
      },
    });

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(logs.some((l) => l.includes('ephemeral one-shot session'))).toBe(true);

    client.resolveInFlightPrompt({ stopReason: 'end_turn' });
    await flushMicrotasks();
    await oneShotPromise;
  });

  it('branch (c): a foreign sessionId is denied fail-closed, never mis-resolving onto A or B', async () => {
    const { backend, logs } = makeTwoControllerBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    seamFor(backend, 'session-a').currentTurnProtected = true;
    backend.setPreset('session-a', 'normal');
    mintSecondController(backend, 'session-b', ws);
    seamFor(backend, 'session-b').currentTurnProtected = true;
    backend.setPreset('session-b', 'normal');

    const response = await callRequestPermission(backend)(makeEditReqFor('totally-unrelated', 'x.ts'));

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(logs.some((l) => l.includes('unrecognized session'))).toBe(true);
  });

  it('W4-T3b (T1b carry — Q-9/R7): the SAME toolCallId under A and B populates TWO independent EditPreviewRegistry entries, never cross-wired', async () => {
    const registry = new EditPreviewRegistry();
    const backend = new AcpBackend({} as HermesRuntimeConfig, undefined, undefined, undefined, undefined, undefined, registry);
    const client = new FakeAcpClient();
    seam(backend).client = client;
    seam(backend).sessionId = 'session-a';
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws; // manual (default) on both -> every edit asks, populating the registry
    mintSecondController(backend, 'session-b', ws);

    // Deliberately the SAME toolCallId under both sessions — the exact
    // collision class the compound key removes.
    const editFor = (sessionId: string, oldText: string, newText: string): AcpRequestPermissionRequest => ({
      sessionId,
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: {
        toolCallId: 'shared-tool-id',
        title: 'Approve edit: x.ts',
        kind: 'edit',
        content: [{ type: 'diff', path: 'x.ts', oldText, newText }],
        rawInput: { tool: 'write_file', arguments: { path: 'x.ts', content: newText } },
      },
    });

    const pendingA = callRequestPermission(backend)(editFor('session-a', 'A-old', 'A-new'));
    const pendingB = callRequestPermission(backend)(editFor('session-b', 'B-old', 'B-new'));
    await vi.waitFor(() => {
      expect(messages.filter((m) => m.type === 'approval.request')).toHaveLength(2);
    });

    // Each session's OWN entry, under the identical toolCallId, resolves its
    // OWN texts — never the other session's.
    expect(registry.getFile('session-a', 'shared-tool-id', 'x.ts')).toEqual({ oldText: 'A-old', newText: 'A-new' });
    expect(registry.getFile('session-b', 'shared-tool-id', 'x.ts')).toEqual({ oldText: 'B-old', newText: 'B-new' });

    const cardA = messages.find(
      (m) => m.type === 'approval.request' && m.sessionId === 'session-a',
    ) as Extract<HostToWebviewMessage, { type: 'approval.request' }>;
    const cardB = messages.find(
      (m) => m.type === 'approval.request' && m.sessionId === 'session-b',
    ) as Extract<HostToWebviewMessage, { type: 'approval.request' }>;

    // Resolving A's approval removes ONLY A's entry — B's (same toolCallId!)
    // survives untouched.
    backend.respondApproval('session-a', cardA.id, 'deny');
    await pendingA;
    expect(registry.getFile('session-a', 'shared-tool-id', 'x.ts')).toBeUndefined();
    expect(registry.getFile('session-b', 'shared-tool-id', 'x.ts')).toEqual({ oldText: 'B-old', newText: 'B-new' });

    backend.respondApproval('session-b', cardB.id, 'deny');
    await pendingB;
    expect(registry.getFile('session-b', 'shared-tool-id', 'x.ts')).toBeUndefined();
  });
});

/**
 * W4-T2 — the REAL per-root turn lease + root-scoped ordinals + rootId
 * interlock, exercised end-to-end through `AcpBackend` (the headless
 * `RootCoordinator`/`RootRegistry` unit tests live in
 * `src/host/checkpoints/RootCoordinator.test.ts`/`rootRegistry.test.ts`).
 */
describe('AcpBackend — W4-T2: real per-root turn lease + root-scoped ordinals + rootId interlock', () => {
  function makeLeaseBackend(tracker?: CheckpointTrackerLike): {
    backend: AcpBackend;
    client: FakeAcpClient;
    messages: HostToWebviewMessage[];
  } {
    const backend = new AcpBackend({} as HermesRuntimeConfig, undefined, undefined, tracker);
    const client = new FakeAcpClient();
    seam(backend).client = client;
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    return { backend, client, messages };
  }

  /**
   * Mint a controller with `cwd` set BEFORE `sessionId` — `port.root` is
   * resolved ONCE, synchronously, at mint time (mirrors production:
   * `openSession`/`loadSessionIntoTab` always know `cwd` first). Calling
   * this a second time (for a second controller) also write-throughs the
   * PREVIOUSLY active controller's `.cwd` field to the new value — harmless
   * for these lease/ordinal tests (which never assert on a stale
   * controller's `cwd`), and exactly what lets a SECOND mint on a genuinely
   * DIFFERENT cwd still bake the CORRECT root into the new controller's
   * port (the earlier controller's OWN `port.root`, already resolved at
   * ITS mint time, is untouched by this).
   */
  function mintOnCwd(backend: AcpBackend, sessionId: string, cwd: string): void {
    seam(backend).cwd = cwd;
    seam(backend).sessionId = sessionId;
  }

  /** Reach the REAL production root resolution (not a reimplementation) to read a coordinator's own `rootId`/`anyLiveTurn()` for assertions. */
  function rootFor(backend: AcpBackend, cwd: string): { rootId: string; anyLiveTurn(): boolean } {
    return (backend as unknown as { resolveRootCoordinator(cwd: string): { rootId: string; anyLiveTurn(): boolean } })
      .resolveRootCoordinator(cwd);
  }

  describe('root turn lease — real cross-session contention on ONE root', () => {
    it('acquire -> second-session-refused -> release -> now-grantable', async () => {
      const { backend, client, messages } = makeLeaseBackend();
      mintOnCwd(backend, 'session-a', '/root-1');
      mintOnCwd(backend, 'session-b', '/root-1');

      backend.sendPrompt('session-a', 'first', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);

      backend.sendPrompt('session-b', 'second', 'default');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(1); // B's turn never reached client.prompt — refused, not queued
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'error', sessionId: 'session-b', message: expect.stringContaining('already running') }),
      );

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks(); // A's turn ends -> releases the lease

      backend.sendPrompt('session-b', 'second (retry)', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(2); // B now proceeds — no residual deadlock
    });

    it('the SAME session sending twice hits its OWN re-entrancy guard, never the cross-session lease refusal', async () => {
      const { backend, client, messages } = makeLeaseBackend();
      mintOnCwd(backend, 'session-a', '/root-1');

      backend.sendPrompt('session-a', 'first', 'default');
      await flushMicrotasks();
      backend.sendPrompt('session-a', 'second', 'default');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(1);
      // The re-entrancy message (`SessionController`'s own `liveTurnId`
      // guard), NOT the cross-session lease-refusal wording.
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'error', sessionId: 'session-a', message: 'A turn is already running. Stop it before sending a new message.' }),
      );
    });

    it('cross-root: turns on two DIFFERENT roots acquire independently (each root has its own lease)', async () => {
      const { backend, client } = makeLeaseBackend();
      mintOnCwd(backend, 'session-a', '/root-a');
      mintOnCwd(backend, 'session-b', '/root-b');

      backend.sendPrompt('session-a', 'on root a', 'default');
      await flushMicrotasks();
      backend.sendPrompt('session-b', 'on root b', 'default');
      await flushMicrotasks();

      expect(client.promptCallCount).toBe(2); // BOTH reached client.prompt — no cross-root contention
      expect(rootFor(backend, '/root-a').anyLiveTurn()).toBe(true);
      expect(rootFor(backend, '/root-b').anyLiveTurn()).toBe(true);
    });
  });

  describe('root-scoped turn ordinal (§2c) — shared across every session on a root', () => {
    it('two controllers on ONE root mint DISTINCT positive ordinals; before/after of EACH turn share ONE ordinal', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeLeaseBackend(tracker);
      mintOnCwd(backend, 'session-a', '/root-1');
      mintOnCwd(backend, 'session-b', '/root-1');

      backend.sendPrompt('session-a', 'first', 'default');
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks(); // A's turn settles -> lease released, after-snapshot fires

      backend.sendPrompt('session-b', 'second', 'default');
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();

      // ONE shared root-scoped counter across BOTH sessions — A's turn-1
      // before/after pair on ordinal 1, B's turn-1 before/after pair on
      // ordinal 2 (never both claiming 1, which a per-session counter would).
      expect(tracker.snapshotCalls).toEqual([
        { turnOrdinal: 1, label: 'first', sessionLabel: 'Session session-a' },
        { turnOrdinal: 1, label: 'After turn', phase: 'after', sessionLabel: 'Session session-a' },
        { turnOrdinal: 2, label: 'second', sessionLabel: 'Session session-b' },
        { turnOrdinal: 2, label: 'After turn', phase: 'after', sessionLabel: 'Session session-b' },
      ]);
    });

    it('W4-T5b: each session stamps its OWN sessionLabel on a shared root — never the sibling\'s (verified independently of the exact-match test above)', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeLeaseBackend(tracker);
      mintOnCwd(backend, 'session-a', '/root-1');
      mintOnCwd(backend, 'session-b', '/root-1');

      backend.sendPrompt('session-a', 'first', 'default');
      await flushMicrotasks();
      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
      backend.sendPrompt('session-b', 'second', 'default');
      await flushMicrotasks();

      expect(tracker.snapshotCalls.map((c) => c.sessionLabel)).toEqual([
        'Session session-a',
        'Session session-a',
        'Session session-b',
      ]);
    });

    it('F3: baselines on two DIFFERENT roots each mint their OWN distinct negative ordinal (root-scoped, not backend-scoped)', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend } = makeLeaseBackend(tracker);
      // W6-FI-c: moved onto `controlDispatcher` — one more reach-through hop.
      const controlDispatcher = (backend as unknown as { controlDispatcher: { warmCheckpointBaseline: () => void } })
        .controlDispatcher;
      const warm = controlDispatcher.warmCheckpointBaseline.bind(controlDispatcher);

      seam(backend).cwd = '/root-a';
      warm();
      seam(backend).cwd = '/root-b';
      warm();
      await flushMicrotasks();

      const baselineOrdinals = tracker.snapshotCalls
        .filter((c) => c.label === 'Session start')
        .map((c) => c.turnOrdinal);
      // EACH root's own counter starts at -1 — a shared/backend-scoped
      // counter would have produced [-1, -2] instead (F3's exact hazard:
      // two roots/tabs both minting -1 -> duplicate `<tree>-(-1)` ids).
      expect(baselineOrdinals).toEqual([-1, -1]);
    });
  });

  describe('F1 — the ephemeral one-shot rides the SAME root lease', () => {
    it('a following turn acquires immediately after the one-shot releases (every exit path covered — no deadlock)', async () => {
      const { backend, client } = makeLeaseBackend();
      mintOnCwd(backend, 'session-a', '/ws-oneshot');

      client.queueSessionId('ephemeral-1');
      const oneShotPromise = backend.oneShot('quiet call', { cwd: '/ws-oneshot' });
      await flushMicrotasks();
      expect(rootFor(backend, '/ws-oneshot').anyLiveTurn()).toBe(true);

      backend.sendPrompt('session-a', 'blocked while the one-shot runs', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1); // only the ephemeral prompt — the turn was refused, not queued

      client.resolveInFlightPrompt({ stopReason: 'end_turn' }); // settles the one-shot
      await flushMicrotasks();
      await oneShotPromise;
      expect(rootFor(backend, '/ws-oneshot').anyLiveTurn()).toBe(false);

      backend.sendPrompt('session-a', 'now proceeds', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(2); // the ephemeral prompt + the now-unblocked turn
    });
  });

  describe('W6-FG (I-2 fix): one-shot cwd/lease-root correctness — the lease locks the EXPLICIT target cwd, never the ambient connection cwd', () => {
    it("a one-shot targeting root B while the connection's ambient cwd is pinned to root A locks ROOT B's lease — a concurrent turn on root B is excluded, root A stays untouched", async () => {
      const { backend, client } = makeLeaseBackend();
      // Mint session-b on root B FIRST, then session-a on root A LAST — the
      // connection's ambient `this.cwd` ends up pinned to root A (mirrors
      // multi-root: whichever tab most recently minted/loaded is "ambient
      // active", and it need not be the one-shot's real target).
      mintOnCwd(backend, 'session-b', '/root-b');
      mintOnCwd(backend, 'session-a', '/root-a');

      client.queueSessionId('ephemeral-1');
      // The one-shot's REAL target is root B — explicit, never the ambient
      // `this.cwd` (which is root A here).
      const oneShotPromise = backend.oneShot('quiet call', { cwd: '/root-b' });
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1); // the ephemeral prompt
      // The ephemeral session itself is also opened against the REAL target
      // cwd, not the ambient one.
      expect(client.newSessionCalls.at(-1)).toEqual({ cwd: '/root-b', mcpServers: [] });

      // F1: the one-shot must hold ROOT B's lease...
      expect(rootFor(backend, '/root-b').anyLiveTurn()).toBe(true);
      // ...and must NEVER have locked root A (the ambient `this.cwd`, not the
      // one-shot's actual target) — the exact bug: under multi-root, locking
      // the wrong root leaves a concurrent turn on the REAL target root
      // unexcluded, defeating F1.
      expect(rootFor(backend, '/root-a').anyLiveTurn()).toBe(false);

      // A concurrent turn on root B (the one-shot's OWN root) is refused, not queued.
      backend.sendPrompt('session-b', 'blocked — SAME root as the one-shot', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' }); // settles the one-shot
      await flushMicrotasks();
      await oneShotPromise;
      expect(rootFor(backend, '/root-b').anyLiveTurn()).toBe(false);

      // Root A (the ambient cwd, never the one-shot's real target) was free
      // the entire time — a turn there proceeds immediately.
      backend.sendPrompt('session-a', 'root A was always free', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(2);

      // NOW root B is free too — the earlier refusal on session-b was a
      // real, lifted exclusion, not a permanent wedge.
      backend.sendPrompt('session-b', 'retry now that the one-shot released root B', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(3);
    });
  });

  describe('checkpoint.restore/redo/redoAll — rootId routing (Deliverable 5)', () => {
    it("interlocks on the TARGET rootId's anyLiveTurn — a live turn on a DIFFERENT root does not block it", async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeLeaseBackend(tracker);
      mintOnCwd(backend, 'session-a', '/root-a');
      mintOnCwd(backend, 'session-b', '/root-b');
      const rootIdA = rootFor(backend, '/root-a').rootId;
      const rootIdB = rootFor(backend, '/root-b').rootId;
      expect(rootIdA).not.toBe(rootIdB);

      backend.sendPrompt('session-a', 'turn on root A', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);

      const resultB = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1', rootId: rootIdB })) as RestoreResult;
      expect(resultB.restored).toBe(true); // B is idle — proceeds despite A's live turn

      const resultA = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1', rootId: rootIdA })) as RestoreResult;
      // A's OWN root has the live turn — refused with the turn-active reason.
      expect(resultA).toMatchObject({ restored: false, reason: expect.stringContaining('turn is still running') });

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
    });

    it('a rootId that matches NO registered coordinator REFUSES (never restores against the wrong worktree)', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend } = makeLeaseBackend(tracker);
      mintOnCwd(backend, 'session-a', '/root-a');

      const result = (await backend.invokeControl('checkpoint.restore', {
        id: 'ckpt-1',
        rootId: 'totally-unknown-root',
      })) as RestoreResult;

      expect(result.restored).toBe(false);
      expect(tracker.restoreCalls).toEqual([]); // the tracker was never reached
    });

    it('TWO registered roots + NO explicit rootId is ambiguous -> REFUSES (never guesses which worktree)', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend } = makeLeaseBackend(tracker);
      mintOnCwd(backend, 'session-a', '/root-a');
      mintOnCwd(backend, 'session-b', '/root-b');

      const result = (await backend.invokeControl('checkpoint.restore', { id: 'ckpt-1' })) as RestoreResult;

      expect(result.restored).toBe(false);
      expect(tracker.restoreCalls).toEqual([]);
    });

    it('checkpoint.redo/redoAll apply the SAME rootId routing + interlock as restore', async () => {
      const tracker = new FakeCheckpointTracker();
      const { backend, client } = makeLeaseBackend(tracker);
      mintOnCwd(backend, 'session-a', '/root-a');
      mintOnCwd(backend, 'session-b', '/root-b');
      const rootIdA = rootFor(backend, '/root-a').rootId;

      backend.sendPrompt('session-a', 'turn on root A', 'default');
      await flushMicrotasks();

      const redoResult = (await backend.invokeControl('checkpoint.redo', { rootId: rootIdA })) as RestoreResult;
      expect(redoResult.restored).toBe(false);
      expect(tracker.redoCalls).toEqual([]);

      const redoAllResult = (await backend.invokeControl('checkpoint.redoAll', {
        rootId: 'totally-unknown-root',
      })) as RestoreResult;
      expect(redoAllResult.restored).toBe(false);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
    });
  });

  describe('session/load stays tab-scoped — NOT root-interlocked (§3.2)', () => {
    it("a root turn on a SIBLING (non-active) controller does NOT block loading a session into the (idle) active one", async () => {
      const { backend, client } = makeLeaseBackend();
      mintOnCwd(backend, 'session-a', '/root-1'); // will stay ACTIVE + idle
      mintOnCwd(backend, 'session-b', '/root-1'); // becomes active momentarily to start its turn...
      backend.sendPrompt('session-b', 'live on the shared root', 'default');
      await flushMicrotasks();
      expect(client.promptCallCount).toBe(1);
      // ...then re-activate A (idle) as the load's target, mirroring T1a's
      // single-"active controller" approximation (real per-tab targeting is
      // T3's job) — the point under test is that `session.load` NEVER
      // consults `root.anyLiveTurn()`, only the TARGET controller's own
      // `hasLiveTurn()`.
      mintOnCwd(backend, 'session-a', '/root-1');

      const result = await backend.invokeControl('session.load', { sessionId: 'session-c', cwd: '/root-1' });

      expect(result).not.toBeUndefined(); // the load proceeded — never refused by B's live root turn
      expect(client.loadSessionCalls).toEqual([{ cwd: '/root-1', sessionId: 'session-c', mcpServers: [] }]);

      client.resolveInFlightPrompt({ stopReason: 'end_turn' });
      await flushMicrotasks();
    });
  });
});

/**
 * W4-T4b — SF-2 custom modes: host wiring. The PURE engine (T4a) is frozen
 * and unchanged; these tests prove the vscode-boundary wiring that produces
 * the `ModeFloor` data it consumes: `setCustomMode` routing, `mode.state` on
 * bind, the self-widening close (`onDidChangeConfiguration`), and the
 * end-to-end enforcement wire (controller -> engine).
 */
describe('AcpBackend.setCustomMode — SF-2 (T4b): router', () => {
  afterEach(() => {
    mockWorkspace.__customModesWorkspaceValue = undefined;
    mockWorkspace.__customModesFolderValue = undefined;
  });

  it('resolves the config by id, snapshots it onto the controller, and emits the authoritative mode.state for THAT session', () => {
    mockWorkspace.__customModesWorkspaceValue = [
      { id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] },
      { id: 'other', name: 'Other' },
    ];
    const { backend, messages } = makePolicyBackend();

    backend.setCustomMode('session-1', 'docs-only');

    expect(seam(backend).activeCustomModeId).toBe('docs-only');
    expect(seam(backend).activeCustomMode).toEqual({
      deny: ['.vscode/settings.json', '*.code-workspace'],
      allowOnly: ['docs/'],
    });
    const state = messages.find((m) => m.type === 'mode.state');
    expect(state).toEqual({
      type: 'mode.state',
      sessionId: 'session-1',
      modeId: 'docs-only',
      available: [
        { id: 'docs-only', name: 'Docs only' },
        { id: 'other', name: 'Other' },
      ],
    });
  });

  it('is a no-op for an unknown sessionId — fail-safe: no controller mutation, no emitted mode.state', () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only' }];
    const { backend, messages } = makePolicyBackend();

    expect(() => backend.setCustomMode('ghost-session', 'docs-only')).not.toThrow();

    expect(messages.some((m) => m.type === 'mode.state')).toBe(false);
  });

  it('modeId=null clears the active mode', () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend, messages } = makePolicyBackend();
    backend.setCustomMode('session-1', 'docs-only');
    messages.length = 0;

    backend.setCustomMode('session-1', null);

    expect(seam(backend).activeCustomModeId).toBeNull();
    expect(seam(backend).activeCustomMode).toBeUndefined();
    const state = messages.find((m) => m.type === 'mode.state');
    expect(state).toEqual({
      type: 'mode.state',
      sessionId: 'session-1',
      modeId: null,
      available: [{ id: 'docs-only', name: 'Docs only' }],
    });
  });

  it('an UNKNOWN modeId clears the active mode (same as null — never crashes, never half-applies)', () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only' }];
    const { backend, messages } = makePolicyBackend();

    backend.setCustomMode('session-1', 'does-not-exist');

    expect(seam(backend).activeCustomModeId).toBeNull();
    expect(seam(backend).activeCustomMode).toBeUndefined();
    const state = messages.find((m) => m.type === 'mode.state');
    expect(state).toMatchObject({ type: 'mode.state', sessionId: 'session-1', modeId: null });
  });

  // P7-N10: the SAFE contrast to the deleted `setMode` fan-out — the
  // mode-picker path (`mode.set` -> this method) is explicitly sessionId-
  // scoped and stays that way. Activating a custom mode on session-1 must
  // NOT touch session-2's mode state or emit anything for it.
  it('P7-N10: is correctly session-scoped — activating a mode on session-1 leaves session-2 untouched', () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend, messages } = makePolicyBackend(); // mints session-1
    seam(backend).cwd = '/ws-2';
    seam(backend).sessionId = 'session-2'; // mints a second live controller

    backend.setCustomMode('session-1', 'docs-only');

    expect(seamFor(backend, 'session-1').activeCustomModeId).toBe('docs-only');
    expect(seamFor(backend, 'session-2').activeCustomModeId).toBeNull();
    // Only session-1 gets a mode.state push — session-2 never hears about it.
    const states = messages.filter((m) => m.type === 'mode.state');
    expect(states).toEqual([
      {
        type: 'mode.state',
        sessionId: 'session-1',
        modeId: 'docs-only',
        available: [{ id: 'docs-only', name: 'Docs only' }],
      },
    ]);
  });
});

describe('AcpBackend.openSession — SF-2 (T4b) deliverable 4: mode.state on session bind', () => {
  afterEach(() => {
    mockWorkspace.__customModesWorkspaceValue = undefined;
  });

  it('emits mode.state{modeId:null, available} immediately after tab.bound for a freshly-bound session (the picker populates)', async () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only' }];
    const { backend } = makeStartableBackend();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start();

    const boundIndex = messages.findIndex((m) => m.type === 'tab.bound');
    const stateIndex = messages.findIndex((m) => m.type === 'mode.state');
    expect(boundIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBe(boundIndex + 1);
    expect(messages[stateIndex]).toMatchObject({
      type: 'mode.state',
      sessionId: 'session-1',
      modeId: null,
      available: [{ id: 'docs-only', name: 'Docs only' }],
    });
  });

  it('a fresh tab-open also gets its own mode.state (empty catalog when no custom modes are configured — fresh sessions start with no custom mode)', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));
    must(clients[0]).queueSessionId('session-2');

    await backend.openTab('tab-2');

    const state = messages.find((m) => m.type === 'mode.state');
    expect(state).toMatchObject({ type: 'mode.state', sessionId: 'session-2', modeId: null, available: [] });
  });
});

/**
 * W6-P7-N11 (3-way ARCH I-4): `announceSessionBound` is now the SINGLE home
 * for the `tab.bound` + `mode.state` bind-announcement pair that
 * `openSession`, `loadSessionIntoTab`, and (via the `ConnectionSupervisor`
 * port) `recoverOneSession` used to each emit inline/independently. These
 * tests are ADDITIONAL — every pre-existing emission-order assertion above
 * (the M#2 adjacency tests, the session.load/openSession/recovery
 * `messages.map((m) => m.type)` sequences) is untouched, still exercises the
 * REAL emitted messages, and still discriminates the exact same way. This
 * describe block adds the one thing those tests couldn't show on their own:
 * that all three bind paths route through the SAME helper, not three
 * independently-behaving copies of it.
 */
describe('AcpBackend — W6-P7-N11: all 3 bind sites route through the single announceSessionBound (3-way ARCH I-4)', () => {
  /** Narrow spy-target shape for the private `announceSessionBound` — same `as unknown as` seam posture `seam()`/`seamFor()` already use elsewhere in this file. */
  function announceSessionBoundSpy(backend: AcpBackend) {
    const target = backend as unknown as {
      announceSessionBound(tabId: string, sessionId: string, rootId: string): void;
    };
    return vi.spyOn(target, 'announceSessionBound');
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('openSession (via start()) calls announceSessionBound exactly once with its own tabId/sessionId/rootId, and the pinned tab.bound-then-mode.state order still holds on the wire', async () => {
    const { backend } = makeStartableBackend();
    const spy = announceSessionBoundSpy(backend);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.start(); // openSession mints session-1 @ BOOTSTRAP_TAB_ID

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(BOOTSTRAP_TAB_ID, 'session-1', expect.any(String));
    expect(messages.map((m) => m.type).slice(0, 2)).toEqual(['tab.bound', 'mode.state']);
  });

  it('loadSessionIntoTab (via invokeControl session.load) calls announceSessionBound exactly once with its own tabId/sessionId/rootId, and the pinned order still holds on the wire', async () => {
    const { backend } = makeBackend(); // seeded with sessionId 'session-1'
    const spy = announceSessionBoundSpy(backend);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.invokeControl('session.load', { sessionId: 'old-session', cwd: '/ws' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(BOOTSTRAP_TAB_ID, 'old-session', expect.any(String));
    expect(messages.map((m) => m.type).slice(0, 2)).toEqual(['tab.bound', 'mode.state']);
  });

  it('recoverOneSession (post-crash respawn, routed through the ConnectionSupervisor port) calls announceSessionBound exactly once per recovered session, and the pinned order still holds on the wire', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start(); // session-1 @ BOOTSTRAP_TAB_ID

    const spy = announceSessionBoundSpy(backend);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    must(clients[0]).simulateExit(1); // fires the connection-level `system.error` (R-A6) — not part of the bind pair
    messages.length = 0; // isolate the recovery's OWN emission from that connection-level noise
    await vi.advanceTimersByTimeAsync(500); // respawn fires -> recoverOneSession

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(BOOTSTRAP_TAB_ID, 'session-1', expect.any(String));
    expect(messages.map((m) => m.type).slice(0, 2)).toEqual(['tab.bound', 'mode.state']);
  });
});

describe('AcpBackend — SF-2 (T4b) §4.3 mitigation 2: onDidChangeConfiguration require-re-select (the self-widening CLOSE)', () => {
  afterEach(() => {
    mockWorkspace.__customModesWorkspaceValue = undefined;
    mockShowWarningMessage.mockClear();
  });

  it('a disk change to talaria.customModes does NOT re-snapshot a session with an active mode — the ENFORCED snapshot stays the OLD floor, and a visible warning fires (the load-bearing self-widening test)', () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend, messages } = makePolicyBackend();
    const onConfigChange = lastConfigChangeListener();
    backend.setCustomMode('session-1', 'docs-only');
    const snapshotBefore = seam(backend).activeCustomMode;
    messages.length = 0;
    mockShowWarningMessage.mockClear();

    // The agent (or a bypass channel — terminal/execute_code/MCP) widens the
    // ON-DISK definition: the mode now allows EVERYTHING (no allowOnly).
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only' }];
    onConfigChange({ affectsConfiguration: (s) => s === 'talaria.customModes' });

    // The load-bearing assertion: the ENFORCED snapshot is the SAME OBJECT,
    // never replaced — a settings write cannot mutate a live session's floor.
    expect(seam(backend).activeCustomMode).toBe(snapshotBefore);
    expect(seam(backend).activeCustomModeId).toBe('docs-only'); // unchanged
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining('re-select'));
    const state = messages.find((m) => m.type === 'mode.state');
    expect(state).toEqual({
      type: 'mode.state',
      sessionId: 'session-1',
      modeId: 'docs-only', // UNCHANGED — enforcement did not move
      available: [{ id: 'docs-only', name: 'Docs only' }], // REFRESHED catalog for the picker
    });
  });

  it('an unrelated config section change does not warn or re-emit mode.state', () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend, messages } = makePolicyBackend();
    const onConfigChange = lastConfigChangeListener();
    backend.setCustomMode('session-1', 'docs-only');
    messages.length = 0;
    mockShowWarningMessage.mockClear();

    onConfigChange({ affectsConfiguration: (s) => s === 'talaria.autocomplete.enabled' });

    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'mode.state')).toBe(false);
  });

  it('a config change while NO session has an active custom mode is a no-op (nothing to protect)', () => {
    makePolicyBackend(); // no setCustomMode call — activeCustomModeId stays null
    const onConfigChange = lastConfigChangeListener();
    mockShowWarningMessage.mockClear();

    onConfigChange({ affectsConfiguration: (s) => s === 'talaria.customModes' });

    expect(mockShowWarningMessage).not.toHaveBeenCalled();
  });

  it('dispose() unsubscribes the listener (no leak)', () => {
    const { backend } = makePolicyBackend();
    const countAfterConstruct = mockWorkspace.__configChangeListeners.length;

    backend.dispose();

    expect(mockWorkspace.__configChangeListeners.length).toBe(countAfterConstruct - 1);
  });
});

describe('AcpBackend.handleRequestPermission — SF-2 (T4b): the enforcement wire end-to-end (controller -> engine)', () => {
  // A REAL temp workspace so canonicalization establishes containment and
  // the mode floor matches against a workspace-RELATIVE path (mirrors the
  // W2-F1 seam suite's own `makeTmpWs` pattern) — without a real on-disk
  // root, `canonicalizeEditPath` cannot confirm containment and the engine
  // (correctly) judges the ABSOLUTE canonical path instead, which is not
  // what the mode-floor grammar is authored against.
  const tmpDirs: string[] = [];
  function makeTmpWs(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-sf2-ws-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    mockWorkspace.__customModesWorkspaceValue = undefined;
    mockWorkspace.workspaceFolders = undefined;
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('an active allowOnly mode denies an OUT-OF-SCOPE edit through the whole controller -> engine wire', async () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    backend.setCustomMode('session-1', 'docs-only');

    const outcome = await callRequestPermission(backend)(makeEditReq('src/out-of-scope.ts'));

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('the SAME active allowOnly mode lets an IN-SCOPE edit fall through to ordinary preset posture (manual => ask, not an auto-mode-deny)', async () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend, messages } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    backend.setCustomMode('session-1', 'docs-only');
    messages.length = 0;

    const pending = callRequestPermission(backend)(makeEditReq('docs/readme.md'));

    await waitForApprovalCard(messages);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('the F1 allowOnly carve-out (T4a) fires end-to-end: an unresolvable-path edit denies under an active allowOnly mode (the empty-signal path, :471, carries the snapshot)', async () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'docs-only', name: 'Docs only', allowOnly: ['docs/'] }];
    const { backend } = makePolicyBackend();
    backend.setCustomMode('session-1', 'docs-only');

    const emptyPathReq: AcpRequestPermissionRequest = {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: { toolCallId: 'empty-1', title: 'Mystery edit', kind: 'edit' }, // no rawInput, no diff content
    };

    const outcome = await callRequestPermission(backend)(emptyPathReq);

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('with NO active custom mode, the SAME empty-path edit falls back to the ordinary ask (F1, unaffected by SF-2)', async () => {
    const { backend, messages } = makePolicyBackend();
    const emptyPathReq: AcpRequestPermissionRequest = {
      sessionId: 'session-1',
      options: EDIT_OPTIONS.map((o) => ({ ...o })),
      toolCall: { toolCallId: 'empty-2', title: 'Mystery edit', kind: 'edit' },
    };

    const pending = callRequestPermission(backend)(emptyPathReq);

    await waitForApprovalCard(messages);
    backend.respondApproval('session-1', 'appr-1', 'deny');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('the implicit self-protection deny holds even under a deny-only mode that does not otherwise mention .vscode', async () => {
    mockWorkspace.__customModesWorkspaceValue = [{ id: 'no-secrets', name: 'No secrets', deny: ['secrets/'] }];
    const { backend } = makePolicyBackend();
    const ws = makeTmpWs();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    seam(backend).cwd = ws;
    backend.setCustomMode('session-1', 'no-secrets');

    const outcome = await callRequestPermission(backend)(makeEditReq('.vscode/settings.json'));

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });
});

/**
 * Task 13 (onboarding-backend-setup §2.1): `AcpBackend` surfaces the CURRENT
 * client's ACP-advertised auth methods (`getAdvertisedAuthMethods`) plus a
 * change signal (`onAuthMethodsChanged`), so the Setup panel's Provider card
 * can be driven through the extension.ts dep seam. The refresh contract:
 * `talaria.newSession` → `provider.newSession()` → `backend.start()`, which
 * tears the old client down and mints a FRESH one whose own `initialize()`
 * re-retains the methods — the getter must always read the CURRENT client,
 * never a stale snapshot.
 */
describe('AcpBackend — Task 13: advertised auth methods surface', () => {
  const SETUP_ONLY = [{ id: 'hermes-setup', name: 'Configure Hermes provider' }];
  const PROVIDER_AND_SETUP = [
    { id: 'openrouter', name: 'openrouter runtime credentials' },
    { id: 'hermes-setup', name: 'Configure Hermes provider' },
  ];

  it("undefined before start(); the first client's methods after; a re-start (talaria.newSession) refreshes to the NEW client's", async () => {
    const { backend, clients } = makeStartableBackend(undefined, (client, index) => {
      client.advertisedAuthMethods = index === 0 ? SETUP_ONLY : PROVIDER_AND_SETUP;
    });

    expect(backend.getAdvertisedAuthMethods()).toBeUndefined();

    await backend.start();
    expect(backend.getAdvertisedAuthMethods()).toEqual(SETUP_ONLY);

    // talaria.newSession → provider.newSession() → backend.start() again:
    // fresh client, fresh initialize, refreshed advertisement.
    await backend.start();
    expect(clients).toHaveLength(2);
    expect(backend.getAdvertisedAuthMethods()).toEqual(PROVIDER_AND_SETUP);
  });

  it('onAuthMethodsChanged relays the CURRENT client only — a stale (torn-down) client can no longer fire it', async () => {
    const { backend, clients } = makeStartableBackend();
    let fires = 0;
    const sub = backend.onAuthMethodsChanged(() => {
      fires += 1;
    });

    await backend.start();
    must(clients[0]).fireAuthMethodsChanged();
    expect(fires).toBe(1);

    await backend.start(); // mints client[1]; client[0]'s subscription must be dropped
    must(clients[0]).fireAuthMethodsChanged();
    expect(fires).toBe(1); // stale client: not relayed
    must(clients[1]).fireAuthMethodsChanged();
    expect(fires).toBe(2);

    sub.dispose();
  });
});

describe('beta.7 B3: user-triggered reconnect (backend.reconnectAgent)', () => {
  it('tears down the child, mints a NEW client (fresh initialize ⇒ fresh authMethods), and re-loads every live session into its tab', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    expect(clients).toHaveLength(1);

    const result = await backend.reconnectAgent();

    expect(result).toEqual({ ok: true });
    expect(clients).toHaveLength(2);
    expect(must(clients[1]).loadSessionCalls.map((c) => c.sessionId)).toEqual(['session-1']);
  });

  it('refuses while a turn is live — never kills an in-flight session prompt', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    // The fake client's prompt() returns a HELD-OPEN deferred (:369-374) —
    // nothing auto-resolves it, so hasLiveTurn() is genuinely true at the
    // moment reconnectAgent() runs (finding-11 guard: the turn must not be
    // able to settle out from under the test).
    backend.sendPrompt('session-1', 'work', 'default');
    await flushMicrotasks();

    const result = await backend.reconnectAgent();

    expect(result.ok).toBe(false);
    expect(clients).toHaveLength(1); // no teardown happened
    must(clients[0]).resolveInFlightPrompt({ stopReason: 'end_turn' }); // hygiene: settle the held turn
    await flushMicrotasks();
  });

  it('refuses honestly when the connection was never started', async () => {
    const { backend } = makeStartableBackend();
    const result = await backend.reconnectAgent();
    expect(result).toMatchObject({ ok: false, reason: expect.any(String) });
  });

  it('B1 interplay: recovery re-binds WITHOUT a title key, so History-set chips survive a reconnect', async () => {
    const { backend, clients } = makeStartableBackend();
    await backend.start();
    expect(clients).toHaveLength(1);
    const messages: HostToWebviewMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    await backend.reconnectAgent();

    const rebinds = messages.filter((m) => m.type === 'tab.bound');
    expect(rebinds.length).toBeGreaterThan(0);
    for (const b of rebinds) expect('title' in b).toBe(false);
  });
});
