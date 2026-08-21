import { homedir } from 'node:os';
import type { Logger } from '../../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../../runtime/resolveHermes';
import { resolveHermes } from '../../runtime/resolveHermes';
import { respawnBackoffMs } from '../../control/respawnBackoff';
import { respawnHealthForAttempt } from '../../control/respawnHealth';
import type { RespawnHealth, RespawnHealthState } from '../../control/respawnHealth';
import { describeError, isAuthRequiredError } from '../../../shared/errorText';
import { BOOTSTRAP_TAB_ID } from '../../../shared/protocol';
import type { HostToWebviewMessage } from '../../../shared/protocol';
import type {
  AcpClientCallbacks,
  AcpClientFactory,
  AcpClientLike,
  AcpMcpServer,
} from '../acp/acpClient';
import type { SessionController, LoadReplayOutcome } from '../session/SessionController';
import type { SessionRegistry } from '../session/SessionRegistry';
import type { SessionHostPort } from '../session/types';
import { settleRace } from './settleRace';
import type { RaceOutcome } from './settleRace';

/**
 * T-B1 (closes V-8): how long `startInternal` waits for `connect()` ->
 * `initialize()` -> `startControl()` to complete before giving up and
 * banner-ing. A cold Fedora venv import is seconds, not tens of seconds —
 * 30s mirrors the webview RPC's own 30s timeout and `OneShotRunner`'s 30s
 * default deadline (`remediation-architecture.md`, T-B1 fork 1).
 */
const CONNECT_PHASE_DEADLINE_MS = 30_000;

/**
 * T-3 (closes B1-M1): how long {@link ConnectionSupervisor.establishInitialSession}'s
 * bootstrap `session/new` and {@link ConnectionSupervisor.recoverOneSession}'s
 * `session/load` wait for the child to ANSWER before giving up. Distinct
 * from {@link CONNECT_PHASE_DEADLINE_MS} (which bounds connect/initialize/
 * startControl, BEFORE a session is even attempted) and from {@link
 * settleRace}'s pre-existing exit-only race (as used by {@link
 * ConnectionSupervisor.recoverOneSession}, WS-R4 step 3)
 * (T-B1/V-8, which already covers "the child DIED mid-request" but not "the
 * child stayed ALIVE and simply never answered" — a harness deadlock or a
 * stuck event loop, the gap this task closes). 120s matches `JsonRpcStdio`'s
 * own per-request RPC ceiling and `OneShotRunner.runOneShot`'s whole-turn
 * deadline — generous against replay cost: a local `session/new`/
 * `session/load` streams back in seconds, so this bounds only the
 * pathological hang, never an ordinary slow response.
 */
export const SESSION_ESTABLISH_DEADLINE_MS = 120_000;

/**
 * WS-R1 F2-03: per-session increment on the OVERALL crash-recovery budget.
 * Recovery of N sessions is bounded by SESSION_ESTABLISH_DEADLINE_MS +
 * N × this — the first wedged session may burn the full establish deadline,
 * later ones only ever the shrinking remainder, and sessions past the
 * budget are marked session-lost WITHOUT an attempt (never their own full
 * serial 120s slot). Proposed default; tunable on Fedora live-QA.
 */
const RECOVERY_PER_SESSION_INCREMENT_MS = 10_000;

/** Outcome of {@link ConnectionSupervisor.raceConnectPhase}'s internal race. */
type ConnectPhaseOutcome = { kind: 'connected' } | { kind: 'deadline' } | { kind: 'exit'; code: number | null };

/** beta.7 B3: outcome of a user-triggered reconnect. */
export type ReconnectOutcome = { ok: true } | { ok: false; reason: string };

/**
 * W6-FI-b (3-way ARCH I-4, part 2 of 3) — the connection LIFECYCLE
 * subsystem, EXTRACTED VERBATIM off `AcpBackend` (behavior-preserving MOVE +
 * dependency injection, not a rewrite — mirrors {@link
 * ../oneshot/OneShotRunner}'s own W6-FI-a precedent). Every `await`
 * ordering, closure capture, `acpState` transition, timer arming, and
 * serialization guard is preserved exactly — only WHERE this code lives
 * changed, never WHAT it does. This is the "found-twice" concurrency zone
 * (T5b C1 backend-wedge, W6-FB same-session controller leak, the
 * W6-FG-folded `recoverOneSession` identity race) — see each method's own
 * doc below for the exact invariant it still carries.
 *
 * Owns: spawn/connect/initialize the ACP child, the `acpState` machine
 * (`idle`/`starting`/`ready`/`respawning`/`disposed`), the `inFlightStart`
 * tail-serialization (shared with `AcpBackend.openTab` via {@link
 * runOnStartTail}), crash detection + respawn backoff, and post-respawn
 * per-session recovery (`session/load` every tab that was registered at
 * crash time).
 *
 * NOT owned (deliberately left on `AcpBackend` — see the extraction report
 * for the full entanglement analysis): `cwd`/`activeSessionId` (both are
 * mutated by `openSession`/`loadSessionIntoTab`, which stay in the router
 * and whose C1/W6-FB choreography this task must not touch — this class
 * reaches them only through the narrow `setCwd`/`getActiveSessionId`/
 * `setActiveSessionId` port accessors, exactly where the ORIGINAL code
 * touched them), `mcpServers`/`sessions` (shared collaborators the router
 * also owns directly), `openSession`/`buildSessionPort`/
 * `warmCheckpointBaseline`/`resetSessionsAccumulation` (session-mint /
 * checkpoint-zone helpers, not connection-lifecycle), and the ACP client
 * CALLBACKS themselves (`handleSessionUpdate`/`handleRequestPermission`/
 * `handleReadTextFile` stay on `AcpBackend` — they dispatch into the
 * session registry / one-shot runner / vscode-backed file confinement, none
 * of which is a connection concern).
 *
 * HEADLESS: no `vscode` import (mirrors `OneShotRunner`/`SessionController`)
 * — every host dependency is reached through the injected {@link
 * ConnectionSupervisorHostPort}.
 */
export class ConnectionSupervisor {
  private client: AcpClientLike | undefined;

  /** R-A6: subscription to the live ACP client's exit seam; replaced per session. */
  private clientExitSub: { dispose(): void } | undefined;

  /**
   * P0: HOST-SIDE serialization tail for {@link start} (and, via {@link
   * runOnStartTail}, `AcpBackend.openTab`) — see the original field doc
   * (preserved on `AcpBackend.ts` pre-W6-FI-b) for the full
   * interleaving-hazard rationale, unchanged by this extraction.
   *
   * CF-01/L3-1: `AcpBackend.loadSessionIntoTab` (both its `session.load` and
   * `tab.load` callers) and `AcpBackend.closeTab` now ALSO chain onto this
   * SAME tail — see {@link runOnStartTail}'s doc. Typed `Promise<unknown>`
   * (widened from `Promise<void>`) because `runOnStartTail` is now generic
   * over its callback's resolved type (a value-returning load vs. a
   * void-returning start/close) — this field only ever chains on the
   * settlement of whatever's queued, never reads its resolved value, so the
   * widened type is safe.
   */
  private inFlightStart: Promise<unknown> | undefined;

  /**
   * R-A6: ACP-channel lifecycle — the same five-state machine ControlChannel
   * runs for the control child (ControlChannel.ts:76,265-307), because the two
   * children over one extension deserve symmetric supervision. 'respawning'
   * additionally gates the "one reconnecting signal per outage" rule.
   */
  private acpState: 'idle' | 'starting' | 'ready' | 'respawning' | 'disposed' = 'idle';
  private acpRespawnAttempts = 0;
  private acpRespawnTimer: ReturnType<typeof setTimeout> | undefined;

  /** WS-R3 F2-19b: health-transition subscribers for the ACP supervisor's
   * OWN respawn loop — mirrors ControlChannel's `healthHandlers`/
   * `lastHealthState` field-for-field (the future gateway.health push,
   * Phase 3 WS-UX wires both loops' `onHealth` to the same panel signal). */
  private readonly healthHandlers = new Set<(health: RespawnHealth) => void>();
  private lastHealthState: RespawnHealthState = 'ok';

  /**
   * W4-T5a (Q-10 / F2 / P-W4-6): a snapshot of every session registered at
   * CRASH time — `{sessionId, cwd, tabId}` — captured by {@link handleAcpCrash}
   * BEFORE the coming respawn's `teardownSession()` (`startInternal`'s first
   * act) empties the registry via `disposeAll()`. `establishInitialSession`
   * consumes (and clears) this once the connection is healthy again: a
   * non-empty snapshot means "this start() is a post-crash respawn — attempt
   * `session/load` for every entry instead of minting a fresh bootstrap
   * session" (see {@link recoverSessions}). `undefined` means "this start()
   * is a genuine fresh boot / an explicit user restart" — the ordinary
   * bootstrap-mint path applies, exactly as before T5a.
   */
  private pendingRecovery: Array<{ sessionId: string; cwd: string; tabId: string }> | undefined;

  /**
   * CF-01/L3-1 fix (Important — 3-lens review of the tail-serialization
   * commit): a cheap, SYNCHRONOUS-ONLY re-entrancy guard for {@link
   * runOnStartTail}. True for EXACTLY the duration of the synchronous call
   * into a queued `fn()` — set right before invoking it, cleared in a
   * `finally` the INSTANT that call RETURNS CONTROL (a pending promise, for
   * every real `fn` here — never once that promise later SETTLES).
   *
   * Scoped this narrowly on purpose. `runOnStartTail`'s own SELF-DEADLOCK
   * WARNING (below) is a "verified by inspection" invariant with NO runtime
   * enforcement today — a future 5th tail user whose `fn` body calls ANOTHER
   * tail-wrapped method (`start`/`openTab`/`closeTab`/`loadSessionIntoTab`)
   * as an immediate, un-awaited action would silently and PERMANENTLY wedge
   * the whole topology tail (no error, no timeout — the inner call enqueues
   * onto `fn`'s OWN still-pending promise, which can never settle because
   * `fn` is now itself waiting on that very link). A flag held for `fn`'s
   * ENTIRE lifetime (cleared on SETTLEMENT rather than on invocation-return)
   * would also catch that self-recursive case — but it would ALSO throw on
   * the legitimate, extensively-tested pattern this whole class exists to
   * support: an unrelated, concurrent top-level caller (e.g. a user's
   * `closeTab` firing while a DIFFERENT `fn` is still suspended mid-`await`)
   * queueing BEHIND the in-flight link (`AcpBackend.test.ts`'s "CF-01/L3-1:
   * loadSessionIntoTab/closeTab are serialized on the SAME runOnStartTail
   * queue" describe block is exactly this scenario, and must not false-trip).
   *
   * The narrow window sidesteps that conflict: by the time a legitimate
   * concurrent caller's OWN `runOnStartTail` call happens, the in-flight
   * `fn`'s synchronous invocation has ALREADY returned control (its
   * `finally` already cleared the flag) — only a call SYNCHRONOUSLY NESTED
   * inside `fn`'s own still-executing call frame ever observes the flag as
   * `true`. This is a best-effort diagnostic for the common mistake (an
   * immediate, un-awaited nested call, the shape every existing tail user
   * takes — `fn` IS the wrapped method's entire body), not a comprehensive
   * one: an `fn` that awaits something else first and only THEN re-enters is
   * not caught by this guard and would still silently wedge, exactly as
   * before this fix. "Cheap" — not perfect — was the brief.
   */
  private executingOnTail = false;

  constructor(private readonly port: ConnectionSupervisorHostPort) {}

  /** The live ACP client, read at call time — `undefined` before/between connections. */
  getClient(): AcpClientLike | undefined {
    return this.client;
  }

  /**
   * WS-R3 F2-19b: subscribe to the ACP respawn loop's health TRANSITIONS
   * ('ok' → 'degraded' at 5 failed attempts → 'down' at 10 → back to 'ok'
   * on a successful respawn). Transition-only — never one event per
   * attempt. `scheduleAcpRespawn` keeps its backoff schedule forever
   * regardless of subscribers (fail-visible, never fail-stopped) — see
   * {@link emitHealth}'s own doc for the hardening that guarantees it.
   * Supervisor-scoped like the crash/reconnect machinery it observes.
   */
  onHealth(handler: (health: RespawnHealth) => void): { dispose(): void } {
    this.healthHandlers.add(handler);
    return {
      dispose: () => {
        this.healthHandlers.delete(handler);
      },
    };
  }

  /**
   * WS-R3 F2-19b (arch review Important-1): the CURRENT health, computed
   * fresh from the live `acpRespawnAttempts` through the same classifier
   * `emitHealth` uses — NOT the frozen payload of the last-fired
   * transition. `onHealth` is purely edge-triggered and holds no replay, so
   * a subscriber that registers AFTER the ACP child has already
   * crash-looped past a threshold (e.g. a webview panel VS Code creates
   * lazily, only revealed post-outage) would otherwise hear nothing and
   * default to assuming `'ok'` — the exact fail-invisible regression F2-19
   * exists to prevent, reintroduced for the ACP-child half. Mirrors
   * `ControlChannel.currentHealth()` field-for-field (ControlChannel.ts
   * :192-197) — also doubles as the live "retried N times" counter, unlike
   * a transition payload which freezes at the 5/10 threshold crossing.
   */
  currentHealth(): RespawnHealth {
    return {
      state: respawnHealthForAttempt(this.acpRespawnAttempts),
      attempts: this.acpRespawnAttempts,
    };
  }

  /**
   * Spawn both channels, ACP-initialize (advertising `fs.readTextFile:true,
   * writeTextFile:false, terminal:false` — deliberately false-sounding but
   * correct: zero terminal handlers are registered, so we advertise what we
   * implement rather than repeat the earlier `terminal:true` over-claim; see
   * `acpClient.ts`'s `initialize()` comment for the rationale), start the
   * control gateway, then
   * open the first session (`session/new`, via `AcpBackend.openSession`).
   * Safe to call again for a fresh session — tears down every previous
   * session and ACP child first.
   *
   * §2c: `start()` is now CONNECTION phase + the first session's open (the
   * router-table's "the first tab's open replaces today's in-`start()`
   * session mint" — F2-structural) — `openSession` is what a future T3
   * "new tab" caller would ALSO invoke, serialized through the same
   * {@link inFlightStart} tail.
   *
   * P0: a thin serialization wrapper around {@link startInternal} via {@link
   * runOnStartTail} — see that method's doc for why. Every call chains onto
   * the tail of the previous one (a prior FAILED start must not block the
   * next), so two `start()` bodies can never interleave, no matter how close
   * together (or how concurrently) callers invoke this.
   */
  async start(): Promise<void> {
    return this.runOnStartTail(() => this.startInternal());
  }

  /**
   * W6-FI-b: the shared P0 tail-serialization primitive `start()` and
   * `AcpBackend.openTab()` BOTH chain onto — extracted verbatim from the
   * (previously duplicated, byte-for-byte identical apart from which inner
   * function it invoked) bodies of those two methods. `AcpBackend.openTab`'s
   * own doc already documented this sharing ("openSession calls are
   * serialized through the SAME tail-chaining pattern `start()` uses") — this
   * method is that ONE mechanism, now with one implementation instead of two
   * copies.
   *
   * CF-01/L3-1 (closes the C1/W6-FB/W6-FG cross-tab race family's
   * generator): `AcpBackend.loadSessionIntoTab` (the single choke point BOTH
   * the `session.load` control method and the `tab.load` wire entry funnel
   * through) and `AcpBackend.closeTab` now chain onto this SAME tail too —
   * every topology mutation (start / respawn-recovery / openTab / a
   * History-load / a tab close) is therefore FULLY serialized, in FIFO call
   * order, with no exceptions. This retires the W6-FG doc's "loadTab is
   * fire-and-forget, NOT serialized behind inFlightStart" note (see
   * `recoverSessions`/`recoverOneSession`'s own doc, corrected alongside this
   * change) — that race can no longer occur. The pre-existing per-call
   * guards inside those bodies (the C1 post-await occupant re-read, the
   * W6-FB registry-level same-sessionId dedup, `recoverOneSession`'s
   * identity-guarded close) are intentionally left in place as redundancy —
   * they no longer have a live caller-facing race to catch via the public
   * API, but they cost nothing to keep and remain a second line of defense.
   *
   * Generic over the callback's resolved type (`T`) rather than fixed to
   * `void` — `start`/`openTab`/`closeTab`'s bodies resolve `void`, but
   * `loadSessionIntoTab`'s resolves an `AcpLoadSessionResult | undefined`
   * VALUE that its own caller needs back. The chaining logic itself never
   * inspects `inFlightStart`'s resolved value (only its settlement), so
   * genericizing is behavior-preserving for every existing `void` caller.
   *
   * M1: `this.inFlightStart` must be assigned `run` itself (not a
   * `.finally()`-derived promise) — the self-reset check below
   * (`this.inFlightStart === run`) compares by identity, and `.finally()`
   * always returns a NEW promise object, so comparing against that would
   * never match and `inFlightStart` would never reset to `undefined` once
   * idle. `run` is what's returned to the caller (so a failed run still
   * rejects to ITS OWN caller); the `.finally()`-derived promise is a
   * throwaway used only for its side effect, with a no-op `.catch` so a
   * rejected `run` doesn't also surface as an unhandled rejection on that
   * separate (unreferenced) promise object.
   *
   * SELF-DEADLOCK WARNING for future callers: `fn` must NOT itself invoke
   * another method that also calls `runOnStartTail` (directly or
   * transitively) — that would enqueue a SECOND link onto this same tail
   * from WITHIN the first link's own execution, and since the tail only
   * advances once the CURRENTLY-RUNNING link's promise settles, that inner
   * call would wait forever for a predecessor that is, in fact, itself
   * (a self-deadlock). None of `start`/`openTab`/`loadSessionIntoTab`/
   * `closeTab`'s wrapped bodies call each other or themselves — each enqueues
   * exactly once, at its own outer entry point, verified by inspection.
   *
   * CF-01/L3-1 fix (Important — 3-lens review): the paragraph above was
   * "verified by inspection" ONLY — no runtime enforcement backed it, so a
   * future 5th tail user violating it would silently and PERMANENTLY wedge
   * the whole connection topology (no error, no timeout — the exact
   * never-resolves class this codebase deadline-protects everywhere else).
   * {@link executingOnTail} now makes a DIRECT, synchronous violation (`fn`
   * calling another tail-wrapped method as an immediate, un-awaited action —
   * the shape every current `fn` here takes) fail LOUDLY instead: see that
   * field's own doc for the exact scope (synchronous-only) and why a wider
   * "true for fn's whole lifetime" guard would have false-tripped the
   * legitimate concurrent-queueing pattern this method exists to provide.
   *
   * CONNECTION-WIDE, not per-tab (Minor doc fix, same review): every one of
   * `start`/`openTab`/`closeTab`/`loadSessionIntoTab` chains onto this ONE
   * shared tail regardless of WHICH tab it targets — a slow op on one tab
   * (e.g. a near-deadline History-load) blocks topology mutations on every
   * OTHER tab too, until it settles or times out. This is the intended cost
   * of closing the cross-tab race family CF-01/L3-1 retired, not an
   * accidental side effect.
   */
  runOnStartTail<T>(fn: () => Promise<T>): Promise<T> {
    if (this.executingOnTail) {
      throw new Error('runOnStartTail: re-entrant call would deadlock the topology tail');
    }
    const run = (this.inFlightStart ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        this.executingOnTail = true;
        try {
          return fn();
        } finally {
          this.executingOnTail = false;
        }
      });
    this.inFlightStart = run;
    run
      .finally(() => {
        if (this.inFlightStart === run) this.inFlightStart = undefined;
      })
      .catch(() => undefined);
    return run;
  }

  /**
   * W4-T1b F2 (critic pin — connection/session phase split): the CONNECTION
   * phase (spawn / connect / `initialize` / control / the exit subscription)
   * is now the ONLY thing this try/catch guards. A session-establish failure
   * must never throw back out of here — that would flip `acpState` to
   * 'idle' and (via {@link scheduleAcpRespawn}'s `.catch`) drive a full
   * respawn loop over what is actually a perfectly healthy connection, just
   * because ONE session failed to mint. {@link establishInitialSession} owns
   * its own try/catch and surfaces that failure honestly instead (see its
   * doc) — the split is exactly "one bad session must not wedge the
   * connection."
   */
  private async startInternal(): Promise<void> {
    if (this.acpState === 'disposed') throw new Error('AcpBackend: disposed');
    this.clearAcpRespawnTimer(); // an explicit (re)start replaces any pending retry
    this.fanOutRestartSignal();
    this.teardownSession();
    // T-B1 (closes V-8): captured BEFORE the line below flips `acpState` to
    // 'starting' — the catch block's banner-once guard needs to know whether
    // THIS attempt is a scheduled respawn (in which case `handleAcpCrash`
    // already bannered the outage) or a fresh boot / explicit restart (no
    // standing banner yet).
    const wasRespawning = this.acpState === 'respawning';
    this.acpState = 'starting';
    let connectedCwd: string | undefined;
    try {
      const resolved = await resolveHermes(this.port.config);
      this.port.setCwd(resolved.cwd);
      connectedCwd = resolved.cwd;

      this.client = this.port.createClient({
        spawn: resolved.acp,
        cwd: resolved.cwd,
        ...(this.port.logger !== undefined ? { logger: this.port.logger } : {}),
        callbacks: this.port.callbacks,
      });
      const client = this.client;

      // T-B1 (closes V-8): race the WHOLE connect phase (connect ->
      // initialize -> startControl) against the child's own exit AND a
      // wall-clock deadline. Un-raced, a child that spawns fine and dies
      // DURING `initialize()` (e.g. a broken Fedora Python venv raising
      // ImportError) hung this `await` forever — the SDK never rejects an
      // in-flight request on stream close (see `acpClient.ts`'s own doc) —
      // which wedged `inFlightStart` forever too: every future
      // `start()`/`openTab` chains onto this same dead tail via
      // `runOnStartTail`, with no banner (fresh-boot rejections were
      // log-only) and no respawn (the crash-only `onExit` subscription below
      // is never reached). See {@link raceConnectPhase}'s own doc.
      await this.raceConnectPhase(client, async () => {
        await client.connect();
        await client.initialize();
        await this.port.startControl();
      });

      // R-A6: supervise the live child as soon as the CONNECTION itself is
      // healthy — independent of whether the session below manages to
      // establish (F2). Mirrors ControlChannel (onExit attached post-ready, :192).
      this.clientExitSub = client.onExit((code) => this.handleAcpCrash(code));

      this.acpRespawnAttempts = 0;
      this.acpState = 'ready';
      this.emitHealth(0);
    } catch (err) {
      // Cast: TS narrows `acpState` to 'starting' | 'ready' across this try
      // block's control flow, but `AcpBackend.dispose()` can reassign it (via
      // {@link markDisposed}) to 'disposed' during any of the `await`s above
      // (same reasoning as `scheduleAcpRespawn`'s cast below) — a real
      // runtime possibility TS's synchronous CFA doesn't model.
      if ((this.acpState as string) !== 'disposed') this.acpState = 'idle';
      // CF-01/I-1: mirrors `handleAcpCrash`'s own arch-A2 guard (:856-857) —
      // a connect-phase failure must dispose+clear the zombie client the
      // same way a post-connection crash does. Without this, the
      // assignment at :221 survives the failure: `getClient()` keeps
      // returning a client whose transport is dead, so a later `openTab`
      // calls `newSession()` on it and NEVER settles — wedging
      // `inFlightStart` forever behind a permanent "reconnecting…" banner.
      this.client?.dispose();
      this.client = undefined;
      // T-B1 (closes V-8): a connect-phase failure must become a VISIBLE
      // error — before this task, a hung/dead child during connect/
      // initialize left NO banner at all. One signal per outage, the SAME
      // guard discipline as `handleAcpCrash` (below): a respawn-loop attempt
      // failing here must NOT add a second banner on top of the crash's own
      // ("The agent exited unexpectedly — reconnecting…").
      if (!wasRespawning && (this.acpState as string) !== 'disposed') {
        this.port.emit({
          type: 'system.error',
          message: `Hermes failed to start: ${describeHostError(err)}`,
        });
      }
      throw err;
    }

    // F2: the connection is healthy and `acpState` is already 'ready' —
    // session establishment is INDIVIDUALLY try/caught from here on.
    await this.establishInitialSession(connectedCwd);
  }

  /**
   * T-B1 (closes V-8): races the connect PHASE (`connect` -> `initialize` ->
   * `startControl`, run via `run`) against two failure signals a plain
   * `await run()` cannot see: the child's own exit (a broken Fedora Python
   * venv / ImportError inside `initialize()` kills the child instead of
   * rejecting the in-flight RPC — the SDK never rejects in-flight requests
   * on stream close, see `acpClient.ts`'s own doc) and a wall-clock deadline
   * ({@link CONNECT_PHASE_DEADLINE_MS}) for the case where the child stays
   * alive but never answers at all. Precedent: the in-repo event-vs-exit
   * race idiom ({@link settleRace}, as used by {@link recoverOneSession},
   * WS-R4 step 3) and `ControlChannel`'s own `awaitReady` race.
   *
   * The temporary `onExit` subscription (and the deadline timer) are armed
   * BEFORE `run()` is invoked, not after — `run()`'s first act is
   * `client.connect()`, which spawns the child, and arming first closes the
   * (vanishingly small but real) window where the child could exit before
   * anything is listening.
   *
   * A genuine rejection from `run()` itself (e.g. `initialize()` rejecting
   * with a real protocol error) is NOT one of these two signals and
   * propagates unchanged — this race only ever ADDS two new ways for the
   * awaited phase to end, it never swallows the ordinary one.
   */
  private async raceConnectPhase(client: AcpClientLike, run: () => Promise<void>): Promise<void> {
    let exitSub: { dispose(): void } | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await new Promise<ConnectPhaseOutcome>((resolve, reject) => {
        let settled = false;
        exitSub = client.onExit((code) => {
          if (settled) return;
          settled = true;
          resolve({ kind: 'exit', code });
        });
        deadlineTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ kind: 'deadline' });
        }, CONNECT_PHASE_DEADLINE_MS);
        // Don't keep the event loop alive on the connect deadline — matches the
        // respawn timer (:scheduleAcpRespawn) and acpClient's killTimer (review CR-B1-M2).
        deadlineTimer.unref?.();
        // Invoked AFTER the exit subscription + deadline timer above are
        // armed — see this method's own doc for why the ordering matters.
        run().then(
          () => {
            if (settled) return;
            settled = true;
            resolve({ kind: 'connected' });
          },
          (err: unknown) => {
            if (settled) return;
            settled = true;
            reject(err);
          },
        );
      });

      if (outcome.kind === 'connected') return;
      if (outcome.kind === 'deadline') {
        throw new Error(
          `Hermes did not become ready within ${CONNECT_PHASE_DEADLINE_MS / 1000}s. Check the Hermes install (talaria.hermesPath / Python venv) — see the Talaria Code output channel.`,
        );
      }
      throw new Error(
        `hermes acp exited during startup (code ${outcome.code}). Check the Hermes install (talaria.hermesPath / Python venv) — see the Talaria Code output channel.`,
      );
    } finally {
      exitSub?.dispose();
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  /**
   * W4-T1b F2: open the first session on an already-healthy connection, OR
   * (W4-T5a, Q-10) recover EVERY session that was registered at crash time.
   * Split out of {@link startInternal} so a failure here can NEVER throw
   * back into the connection phase / respawn loop — a boot-time bootstrap
   * failure surfaces honestly as a connection-global `system.error` (the
   * WHOLE connection has no live session yet, not just one tab) and leaves
   * the connection `'ready'` for a future retry; a per-session recovery
   * failure surfaces as THAT tab's `tab.error{kind:'session-lost'}` instead
   * (§7 B8 terminal-reply discipline, generalized to the recovery path).
   *
   * `connectedCwd` is `undefined` only if this were ever reached without the
   * connection phase having run — defensive; the connection phase throws
   * (and returns early via `startInternal`'s own catch) before falling
   * through here in that case, so this branch is unreachable in practice.
   */
  private async establishInitialSession(connectedCwd: string | undefined): Promise<void> {
    if (connectedCwd === undefined) return;

    // W4-T5a (Q-10): consume the crash-time snapshot ONCE — a later crash
    // during THIS SAME recovery attempt re-captures a fresh one from
    // whatever the registry holds at that moment (best-effort; see
    // `handleAcpCrash`'s own doc).
    const recovery = this.pendingRecovery;
    this.pendingRecovery = undefined;
    if (recovery && recovery.length > 0) {
      await this.recoverSessions(recovery);
      // T5 (UI I-2 / Q2, owner-ratified 2026-07-25 — remediation-architecture.md
      // §2): the CONNECTION outage this attempt was recovering from is over —
      // retire the `system.error` banner `handleAcpCrash` fired for it, even
      // if one or more individual sessions above could not be reloaded (each
      // failure already announced its own tab-scoped
      // `tab.error{kind:'session-lost'}`, honestly per-tab per T3). This is a
      // terminal-transition push, not a per-retry-attempt re-emission: it
      // fires exactly once, here, after `recoverSessions` genuinely settles.
      //
      // WS-R3 F3-2: guarded on acpState — mirrors the sibling system.error
      // guard at :565; a crash during recoverSessions has already flipped
      // state via handleAcpCrash, which runs synchronously on exit.
      if (this.acpState !== 'respawning') {
        this.port.emit({ type: 'system.recovered' });
      }
      return;
    }

    try {
      // W4-T3b (D1): the connection-boot session binds to the shared
      // `BOOTSTRAP_TAB_ID` — the SAME id the webview's `INITIAL_STATE` tab
      // uses — so its `tab.bound` names a tab the webview already has.
      //
      // T-B1 (closes V-8): raced against the child's own exit — an un-raced
      // await here hangs THIS `start()` call's `inFlightStart` tail forever
      // if the child dies mid-`session/new` (the SDK never rejects an
      // in-flight request on stream close). `this.client` is always live at
      // this point (`startInternal` only reaches `establishInitialSession`
      // after a successful connect phase, in the SAME call), but the
      // ternary mirrors `recoverOneSession`'s own defensive style rather
      // than asserting it with a non-null assertion.
      //
      // T-3 (closes B1-M1): `attemptAbandoned` is this bootstrap attempt's
      // identity guard — flipped `true` the moment THIS race settles (exit,
      // deadline, or success), regardless of which. `openSession`
      // (`AcpBackend.ts`) polls it via `isStaleAttempt` right after its own
      // `client.newSession` resolves, BEFORE registering a controller or
      // firing `tab.bound` — see that method's own doc for why the guard
      // has to live THERE and not here: `openSession`'s register+emit is
      // synchronous with `newSession` resolving (no `await` in between), so
      // by the time control returns to this line, `tab.bound` would already
      // be on the wire if we tried to veto from out here instead. A plain
      // boolean closure (not a shared counter field) is sufficient — each
      // bootstrap attempt mints its OWN, so it doubles as this attempt's
      // token without needing cross-attempt bookkeeping on the class.
      let attemptAbandoned = false;
      const openSession = this.port.openSession(connectedCwd, BOOTSTRAP_TAB_ID, () => attemptAbandoned);
      // WS-R1: raced via settleRace directly — exit and deadline are now
      // discriminated outcomes, but this branch deliberately keeps mapping
      // BOTH to the same abandoned-attempt handling below (the acpState
      // check already tells outage from deadline for the banner; new
      // per-outcome copy is WS-UX's job, not this migration's).
      const outcome = this.client
        ? await settleRace(openSession, { exit: this.client, deadline: SESSION_ESTABLISH_DEADLINE_MS })
        : { kind: 'value' as const, value: await openSession };
      attemptAbandoned = true;
      const controller = outcome.kind === 'value' ? outcome.value : undefined;
      if (controller === undefined) {
        // T-3: this `undefined` came from EITHER the child's own exit
        // (raced since T-B1/V-8) OR the new SESSION_ESTABLISH_DEADLINE_MS
        // wall-clock deadline (the child stayed ALIVE but never answered
        // `session/new`) — this `settleRace` collapse deliberately makes the
        // two indistinguishable to ITS caller (the un-jam contract is
        // identical), so this method tells them apart the same way
        // `startInternal`'s own `wasRespawning` capture does:
        // `handleAcpCrash` (the connection-phase :232 `onExit`
        // subscription, independent of this race) fires SYNCHRONOUSLY on
        // exit and unconditionally flips `acpState` to 'respawning' as its
        // LAST act — so if we're still 'ready' here, nobody has bannered
        // this outage yet (the deadline case; the exit case's own banner +
        // recovery are already owned by `handleAcpCrash`, unchanged from
        // T-B1).
        if (this.acpState !== 'respawning') {
          this.port.emit({
            type: 'system.error',
            message: 'The agent did not respond while starting a session — will retry on the next start.',
          });
        }
        this.port.logger?.append(
          '[AcpBackend] initial session establishment did not complete (child exit or the establish deadline) — this attempt is abandoned; a healthy connection retries on the next start()',
        );
        return;
      }
    } catch (err) {
      // T8 (beta.5 §2.3, bug ⑧): STRUCTURAL no-provider routing, not
      // textual (critic C-5) — Hermes' adapter (`acp_adapter/session.py:
      // 652-654`) swallows `resolve_runtime_provider` failures, so the
      // AuthError texts never reliably reach the wire. The injected
      // `isProviderUnconfigured` thunk consults the SAME source the Setup
      // Provider card reads (`computeProviderCard(getAdvertisedAuthMethods())
      // .phase === 'unconfigured'` — see `AcpBackend`'s port wiring);
      // `isAuthRequiredError` (`-32000`, the ACP SDK's authRequired) is a
      // SUPPLEMENT only. Either way the real error text is ALWAYS appended
      // — this branch can route the message, never hide it. `describeError`
      // (not the old naive `String(err)`) is what kills the literal
      // `"[object Object]"` the SDK's raw `{code,message,data}` rejection
      // used to render as (§0.1 row ⑧, `acp.js:886`).
      const detail = describeHostError(err);
      this.port.logger?.append(
        `[AcpBackend] initial session establish failed — connection stays up (acpState='ready'): ${detail}`,
      );
      this.port.emit({
        type: 'system.error',
        message:
          this.port.isProviderUnconfigured?.() === true || isAuthRequiredError(err)
            ? `Hermes has no chat provider configured. Open Setup → Provider → "Configure provider", then try again. (${detail})`
            : `Failed to start a Hermes session: ${detail}`,
      });
      return;
    }
    // Zone CKPT / C1: take a session-baseline snapshot (turn ordinal 0) right
    // after the session opens. Deliberately fire-and-forget — see the
    // original doc (preserved on `AcpBackend.warmCheckpointBaseline`).
    this.port.warmCheckpointBaseline();
    // T5 (UI I-2 / Q2, owner-ratified — remediation-architecture.md §2): a
    // fresh boot / explicit restart has no standing `system.error` banner to
    // retire, but the fold to `systemError: undefined` (transcript.ts) is
    // idempotent, so emitting unconditionally on every successful establish
    // is safe and keeps this a single unconditional rule rather than a
    // "was there actually a banner" tracking flag.
    this.port.emit({ type: 'system.recovered' });
  }

  /**
   * W4-T5a (Q-10 / F2 / P-W4-6): on a successful respawn, `session/load`
   * EVERY session that was registered at crash time — each attempt
   * INDIVIDUALLY try/caught (F2's "per-tab session phase") so one
   * unrecoverable session can never wedge the connection or abort the
   * others. Runs INSIDE `establishInitialSession`, itself inside
   * `startInternal`'s `inFlightStart` tail — a concurrent `openTab` OR (CF-01/
   * L3-1, below) `loadTab`/`session.load`/`closeTab` cannot interleave a
   * half-recovered handshake, and no second child is ever spawned here.
   *
   * CF-01/L3-1 (UPDATE — supersedes the W6-FG paragraph immediately below):
   * `loadTab`/`session.load` (both routed through `AcpBackend
   * .loadSessionIntoTab`) now ALSO chain onto this SAME `inFlightStart` tail
   * (via {@link runOnStartTail}) — a `tab.load` issued while a respawn
   * recovery is still in flight now QUEUES behind it instead of interleaving;
   * it does not even begin running until this entire recovery settles. The
   * W6-FG race described below (and its identity-guarded close in {@link
   * recoverOneSession}) can therefore no longer be TRIGGERED through the
   * public API — the guard is kept as redundancy, not removed. `sendPrompt`
   * is unaffected (still a synchronous void passthrough, still can
   * technically overlap a recovery in flight, but that is a per-session-turn
   * concern, not a topology-identity one — out of this task's scope).
   *
   * W6-FG (doc-honesty fix, HISTORICAL — the race this originally described,
   * now closed by CF-01/L3-1 above): a prior revision of this comment
   * overclaimed `tab.load`/`sendPrompt` were ALSO "queued behind the same
   * tail"; they were NOT. `loadTab` (the `tab.load` wire entry) was
   * fire-and-forget — it awaited `AcpBackend.loadSessionIntoTab` directly,
   * with no `inFlightStart` chaining at all. It COULD genuinely interleave
   * with a still-in-flight recovery here; see {@link recoverOneSession}'s own
   * doc for the race this created (a same-`sessionId` `tab.load` winning the
   * registry slot mid-recovery) and its identity-guarded close.
   *
   * T5 (UI I-2 / Q2, owner-ratified — REVERSES the paragraph this replaces;
   * see `remediation-architecture.md` §2 for the full argument): the prior
   * revision of this doc argued the "one reconnecting signal per outage"
   * rule (§3.3) needed no SECOND signal on resolution, because the per-tab
   * `tab.bound`/`tab.error` emissions below ARE the resolution and the
   * `system.error` banner should stay up until the user manually dismisses
   * it (`local.dismissSystemError`). That argument does not hold: the
   * degraded state was announced GLOBALLY (`system.error` — connection-wide,
   * no `sessionId`), but per-tab events never touch `AppState.systemError` —
   * so the global claim was never actually resolved at the layer it was
   * made, and a banner asserting an outage that ended minutes ago is
   * affirmative misinformation (NN/g visibility-of-system-status; GitHub
   * Primer: a critical banner's lifecycle is tied to its condition — when
   * the condition resolves, the banner goes away). `establishInitialSession`
   * now emits `{ type: 'system.recovered' }` once this method returns (see
   * its own call site) — that is retirement of the FIRST signal, not a
   * second one; no new banner appears, the standing one disappears. The
   * "do not double-emit" half of the original rule still stands and is
   * UNCHANGED by this reversal: it constrains re-emitting `system.error`
   * per retry attempt (`handleAcpCrash`'s `if (this.acpState !==
   * 'respawning')` guard, unaffected here) — `system.recovered` fires
   * exactly once per successful `establishInitialSession`, never per
   * attempt.
   *
   * WS-R1 F2-03: this loop previously gave EVERY session its own full
   * `SESSION_ESTABLISH_DEADLINE_MS` (120s) — N crash-snapshotted sessions
   * that all hang could therefore wedge this whole tail for up to N×120s.
   * Now bounded by ONE overall budget (`SESSION_ESTABLISH_DEADLINE_MS +
   * RECOVERY_PER_SESSION_INCREMENT_MS × recovery.length`, computed once
   * above the loop) consumed cooperatively across attempts: each session
   * gets `min(SESSION_ESTABLISH_DEADLINE_MS, remaining-budget)`, and a
   * session whose turn comes up after the budget is already exhausted is
   * marked `tab.error{kind:'session-lost'}` WITHOUT even attempting
   * `session/load` — honest about never having tried, not a slow-attempt
   * masquerading as an instant one. A session that recovers fast still
   * only ever consumes its real wall-clock time, exactly as before.
   */
  private async recoverSessions(
    recovery: Array<{ sessionId: string; cwd: string; tabId: string }>,
  ): Promise<void> {
    // WS-R1 F2-03: one OVERALL budget for the whole serial chain — computed
    // once, consumed cooperatively (fake-timer- and Fedora-clock-friendly:
    // Date.now() under vitest fake timers advances with the clock).
    const budgetDeadline =
      Date.now() + SESSION_ESTABLISH_DEADLINE_MS + RECOVERY_PER_SESSION_INCREMENT_MS * recovery.length;
    for (const { sessionId, cwd, tabId } of recovery) {
      const remainingMs = budgetDeadline - Date.now();
      if (remainingMs <= 0) {
        this.port.logger?.append(
          `[AcpBackend] respawn recovery: budget exhausted — session '${sessionId}' (tab '${tabId}') marked session-lost without an attempt`,
        );
        this.port.emit({
          type: 'tab.error',
          tabId,
          kind: 'session-lost',
          message: 'Could not recover this session after reconnecting.',
        });
        continue;
      }
      try {
        await this.recoverOneSession(sessionId, cwd, tabId, Math.min(SESSION_ESTABLISH_DEADLINE_MS, remainingMs));
      } catch (err) {
        // Defensive — `recoverOneSession` itself never throws today
        // (`SessionController.loadReplay` never rejects), but keeping this
        // per-attempt catch makes the F2 "one bad session can't wedge the
        // others" guarantee airtight against a future change to that
        // contract, exactly like `establishInitialSession`'s own try/catch
        // does for the ordinary bootstrap mint.
        this.port.logger?.append(
          `[AcpBackend] respawn recovery: unexpected failure recovering session '${sessionId}' (tab '${tabId}') — treating as session-lost: ${describeHostError(err)}`,
        );
        this.port.emit({ type: 'tab.error', tabId, kind: 'session-lost', message: describeHostError(err) });
      }
    }
  }

  /**
   * W4-T5a: recover ONE crashed session via `session/load` on the new
   * child. Mints a fresh controller and announces it via {@link
   * ConnectionSupervisorHostPort.announceSessionBound} — W6-P7-N11: the SAME
   * shared helper `openSession`/`loadSessionIntoTab` route through, so this
   * emits the identical `tab.bound` + `mode.state` pair — M#2-consistent, a
   * recovered session also starts with no custom mode since nothing
   * preserved the prior floor across the crash — BEFORE attempting the load
   * (§7 B9(b): announce the binding before replaying). `cwd` was already a
   * valid, previously-confined cwd (recorded from a live pre-crash controller) — re-running
   * `resolveWithinWorkspaceReal` on our OWN recorded state would be
   * redundant, so (unlike `loadSessionIntoTab`) this trusts it directly.
   *
   * `controller.loadReplayOutcome` never rejects — a load failure resolves a
   * failure-kind `LoadReplayOutcome` (after emitting its own `error`/
   * `turn.end` pair for that tab's transcript, UNLESS superseded — see the
   * W6-FG note below). The ADDITIONAL `tab.error{kind: 'session-lost'}` below
   * is the tab-chrome-level restart affordance (§7 B8); the orphaned
   * controller is dropped via the registry's F6 remove-before-dispose,
   * IDENTITY-GUARDED (see the close below) — never a second, unconditional
   * removal path.
   *
   * CF-01/L3-1: the race this doc originally described can no longer be
   * reached through the public API — `loadTab`/`session.load` now chain onto
   * this SAME `inFlightStart` tail (see {@link recoverSessions}'s own
   * updated doc), so a `tab.load` for this `sessionId` cannot even START
   * until this recovery attempt's `loadReplayOutcome` has fully settled. The
   * identity-guarded close immediately below is KEPT anyway — pure
   * redundancy now, never removed (a future caller reaching this method some
   * other way, or a bug in the tail itself, still can't zombify the winner).
   *
   * W6-FG (folded-in W6-FB review Minor — doc-honesty fix + the identity
   * guard itself, HISTORICAL): a prior revision of this comment claimed
   * "this controller was just minted exclusively for this attempt, so the
   * load's internal 'superseded while awaiting' branch can never fire for
   * it" — that was FALSE at the time. `loadTab`/`tab.load` used to be
   * fire-and-forget, NOT serialized behind `inFlightStart` — a
   * user COULD load this SAME `sessionId` into a DIFFERENT tab while this
   * load await was still in flight. `SessionRegistry.open`'s W6-FB
   * remove-then-dispose then disposes THIS `controller` and rebinds
   * `sessionId` to the winner's fresh controller — which DOES trip
   * `loadReplayOutcome`'s own supersede guard (`this.replay !== replay`) on
   * THIS controller, resolving a `superseded` outcome here — now handled by
   * an EXPLICIT no-op route (WS-R4 step 3, below) instead of collapsing into
   * the generic failure branch. If this method then closed by KEY
   * (`this.sessions.close(sessionId)` unconditionally), it would dispose the
   * WINNER — not this stale attempt — silently zombifying the winner's tab
   * with no `tab.error` at all. Fixed by guarding the close by IDENTITY:
   * `controller` is captured ABOVE, before the await, and only closed if it
   * is STILL the registry's current owner for `sessionId`. A no-op when the
   * recovery is genuinely NOT superseded (the overwhelmingly common case) —
   * `this.port.sessions.get(sessionId) === controller` then holds and the
   * close proceeds exactly as before.
   *
   * WS-R4 step 3 (§3.4, R1×R4 co-edit — the reviewed route table, RETIRES
   * the two hand-rolled exit-race helper methods that used to sit here — a
   * two-level adapter pair that collapsed exit/deadline AND every
   * `LoadReplayOutcome` failure kind into one `undefined` sentinel): the
   * `loadReplayOutcome` await is now raced against `this.client`'s own exit
   * AND `deadlineMs` directly via {@link settleRace}, nested one level —
   * `settleRace` yields `RaceOutcome<LoadReplayOutcome>`: either
   * `{kind:'exit'}` / `{kind:'deadline'}` (the race itself un-jamming) or
   * `{kind:'value', value: LoadReplayOutcome}` (the load settled, and is
   * discriminated further). This method was the LAST caller of both retired
   * helpers, which are now fully deleted. Every route below is now an
   * explicit, named branch:
   *
   *   - `exit` / `deadline` (the race itself) → session-lost — the wall
   *     clock/child-death un-jam this project systematically provides.
   *   - `no-client` / `load-failed` / `not-found` → the SAME session-lost
   *     route — behavior-preserving (these already collapsed to `undefined`
   *     under the old adapter).
   *   - `superseded` (either arm — with or without a carried result) →
   *     NO-OP. DELIBERATE BEHAVIOR CHANGE (reviewed): the OLD adapter
   *     treated a superseded-WITH-result load as a truthy success (adopting
   *     `activeSessionId`/`cwd` for a load a NEWER op already owns) and a
   *     superseded-empty load as an ordinary failure (erroring a tab a newer
   *     op legitimately owns). Both were wrong — a newer op owns this tab
   *     now, so recovery silently stands down instead. Reachable only
   *     through non-public interleavings today (CF-01/L3-1 tail-serialized
   *     the API — see the W6-FG paragraph above), so this route has no
   *     integration-level trigger, only the dedicated supervisor-level pin.
   *   - `loaded` → adopt `activeSessionId`/`cwd` if none is active yet
   *     (unchanged from the old truthy-adopt behavior).
   *   - an unexpected rejection of the raced promise (defensive only —
   *     `loadReplayOutcome` never rejects today) is treated as `load-failed`,
   *     preserving the old swallow-to-undefined contract's spirit as an
   *     explicit, named route instead of a silent catch.
   */
  private async recoverOneSession(sessionId: string, cwd: string, tabId: string, deadlineMs: number): Promise<void> {
    const mcpServers = this.port.getMcpServers();
    const controller = this.port.sessions.open(sessionId, cwd, this.port.buildSessionPort(sessionId, cwd), tabId);

    this.port.announceSessionBound(tabId, sessionId, controller.getRootId());

    const load = controller.loadReplayOutcome(cwd, sessionId, cwd, mcpServers);
    let raced: RaceOutcome<LoadReplayOutcome>;
    try {
      raced = this.client
        ? await settleRace(load, { exit: this.client, deadline: deadlineMs })
        : { kind: 'value', value: await load };
    } catch (err) {
      // Defensive: loadReplayOutcome never rejects today — preserve the old
      // swallow-to-undefined contract as an explicit load-failed route.
      raced = { kind: 'value', value: { kind: 'load-failed', message: describeHostError(err) } };
    }

    const sessionLost = (): void => {
      this.port.emit({
        type: 'tab.error',
        tabId,
        kind: 'session-lost',
        message: 'Could not recover this session after reconnecting.',
      });
      // W6-FG: identity-guarded — only close if `controller` (captured above,
      // BEFORE the await) is STILL the registry's current owner for
      // `sessionId`. See this method's own doc for the race this guards.
      if (this.port.sessions.get(sessionId) === controller) this.port.sessions.close(sessionId);
    };

    if (raced.kind === 'exit' || raced.kind === 'deadline') {
      sessionLost();
      return;
    }
    const outcome = raced.value;
    switch (outcome.kind) {
      case 'no-client':
      case 'load-failed':
      case 'not-found':
        sessionLost();
        return;
      case 'superseded':
        // §3.4 step 3 (reviewed decision, either arm): a newer op owns the
        // tab — recovery stands down silently. Reachable only through
        // non-public interleavings since CF-01/L3-1 serialized the tail.
        return;
      case 'loaded':
        if (this.port.getActiveSessionId() === undefined) {
          this.port.setActiveSessionId(sessionId);
          this.port.setCwd(cwd);
        }
        return;
      default: {
        // WS-R4 step 3 follow-up (all three review lenses — I-1/M-4, M1,
        // M1): exhaustiveness guard against union extension. All 5 current
        // `LoadReplayOutcome` kinds are handled above, so this default is
        // UNREACHABLE today — no runtime behavior change. Its purpose is
        // compile-time: a future 6th kind must fail to COMPILE here, not
        // silently fall through to an implicit no-op return — the exact
        // sentinel-conflation-by-omission disease this workstream exists to
        // kill (a recovery method going fail-silent on an unrecognized
        // terminal state).
        const _exhaustive: never = outcome;
        throw new Error(`unhandled LoadReplayOutcome kind: ${(_exhaustive as { kind: string }).kind}`);
      }
    }
  }

  /**
   * T-1 (V-12 RESTART-STATE): on a fresh boot OR an EXPLICIT user restart —
   * `pendingRecovery === undefined`, the SAME discriminator
   * `establishInitialSession` already consumes; a crash respawn sets it
   * BEFORE this runs (`handleAcpCrash`, below), so this is a no-op for that
   * leg — every controller still registered at this instant belongs to a
   * session the coming `teardownSession()` (next statement) is about to
   * dispose out from under it with NO signal at all
   * (`SessionController.dispose()` deliberately never emits — T-A0
   * fork(2)/BF-B). Reuses the crash-path machinery instead of inventing a
   * second one: `endForRestart()` on every controller first (ends its live
   * turn/replay honestly, `status:'cancelled'` — user-intended, not a
   * failure), THEN the session currently bound to `BOOTSTRAP_TAB_ID` (the
   * tab about to be re-bound to a fresh session id) gets an honest
   * `clear{sessionId}`, and every OTHER tab gets the SAME terminal
   * `tab.error{kind:'session-lost'}` affordance a failed crash-recovery
   * already gives (§7 B8) — reused verbatim rather than inventing a second
   * "session ended" story. A no-op on a genuinely empty registry too
   * (nothing to signal).
   */
  private fanOutRestartSignal(): void {
    if (this.pendingRecovery !== undefined) return;
    const controllers = [...this.port.sessions.values()];
    if (controllers.length === 0) return;
    for (const controller of controllers) controller.endForRestart();
    for (const controller of controllers) {
      if (controller.tabId === BOOTSTRAP_TAB_ID) {
        this.port.emit({ type: 'clear', sessionId: controller.sessionId });
      } else {
        this.port.emit({
          type: 'tab.error',
          tabId: controller.tabId,
          kind: 'session-lost',
          message: 'Session ended — a new agent session was started.',
        });
      }
    }
  }

  /**
   * §2c: connection-level teardown. Disposes the old ACP client and EVERY
   * registered controller (F6-respecting bulk form,
   * `SessionRegistry.disposeAll`), then settles any in-flight ephemeral
   * one-shot. Called at the top of {@link startInternal} (a fresh
   * connection invalidates every session id the old one minted) and by
   * `AcpBackend.dispose()`.
   *
   * PUBLIC (was `private` pre-W6-FI-b): `AcpBackend.dispose()` is the one
   * caller outside this class — see that method's doc for the exact
   * ordering it preserves (this call must land at the SAME position
   * relative to `rootRegistry.disposeAll()`/`control.dispose()` it always
   * has).
   */
  teardownSession(): void {
    this.clientExitSub?.dispose();
    this.clientExitSub = undefined;
    this.client?.dispose();
    this.client = undefined;
    this.port.setActiveSessionId(undefined);
    this.port.sessions.disposeAll();
    // §2c req 5: settle (never leave hanging) any one-shot still in flight —
    // the SAME choke-point every controller's approvals get, for the same
    // reason (an in-flight SDK `prompt()` rejecting on child exit is
    // unverified). W6-FI-a: delegates to `OneShotRunner` via the port.
    this.port.settleOneShot('session torn down');
    this.port.resetSessionsAccumulation();
  }

  /**
   * WS-R3 (FUNC-RECONNECT-DRIFT, §3.3): the ONE shared outage teardown both
   * handleAcpCrash and reconnect() previously hand-copied ("verbatim order"
   * — the highest-drift-risk duplication in this concurrency zone). Body
   * order is the crash path's proven sequence, unchanged:
   *  1. exit-sub dispose — UNCONDITIONAL FIRST statement (idempotent:
   *     ?.dispose() + set-undefined) so the child's exit can never ALSO
   *     schedule a crash respawn mid-teardown (double-start);
   *  2. pendingRecovery snapshot (pendingClose-tombstoned sessions excluded);
   *  3. settleOneShot(settleReason) — each caller's reason string preserved;
   *  4. guarded per-controller endOnCrash fan-out — a throwing controller
   *     never aborts the loop; `fanOutLog` is PER-CALLER because the two
   *     callers' log lines genuinely differ (crash carries the "(tab '…')"
   *     segment, reconnect does not — both pinned observables); the body
   *     appends ": <describeHostError(err)>";
   *  5. client dispose + null (arch-A2), acpState = 'respawning'.
   * Drift is dead by construction — one body (ADR-R3).
   */
  private teardownForRespawn(settleReason: string, fanOutLog: (controller: SessionController) => string): void {
    this.clientExitSub?.dispose();
    this.clientExitSub = undefined;
    this.pendingRecovery = [...this.port.sessions.values()]
      .filter((controller) => !this.port.isPendingClose(controller.sessionId))
      .map((controller) => ({
        sessionId: controller.sessionId,
        cwd: controller.cwd,
        tabId: controller.tabId,
      }));
    this.port.settleOneShot(settleReason);
    for (const controller of this.port.sessions.values()) {
      try {
        controller.endOnCrash();
      } catch (err) {
        // WS-R3 F2-19b: `safeLog`, not a raw `port.logger?.append` — this
        // fan-out sits directly on the `handleAcpCrash -> teardownForRespawn
        // -> scheduleAcpRespawn` critical path; an unguarded throwing logger
        // here would abort this loop before `this.acpState = 'respawning'`
        // below and before `handleAcpCrash` ever reaches its
        // `scheduleAcpRespawn()` call, zombie-ing the connection.
        this.safeLog(`${fanOutLog(controller)}: ${describeHostError(err)}`);
      }
    }
    this.client?.dispose();
    this.client = undefined;
    this.acpState = 'respawning';
  }

  /**
   * R-A6: the ACP child died after a successful session establishment.
   * Mirrors ControlChannel.handleCrash: detach, mark respawning, schedule a
   * backoff retry. Emits ONE user-visible signal per outage.
   *
   * §2c routing table: fan out the crash to EVERY registered controller's
   * best-effort `SessionController.endOnCrash` (ends a live turn / dead
   * replay, settles subagents, releases the root turn-lease explicitly —
   * F2). Controllers are NOT disposed here — `teardownSession()` (the
   * first act of the coming respawn's `startInternal`) is what eventually
   * clears the registry; until then it keeps their state alive.
   *
   * W4-T5a (Q-10): captures {@link pendingRecovery} — the `{sessionId, cwd,
   * tabId}` of EVERY currently-registered session — BEFORE that clearing
   * happens, so `establishInitialSession` can `session/load` each one once
   * the respawned connection is healthy (§7 B8's "never a silent drop,
   * never a silent new session", generalized to every tab, not just the
   * bootstrap one).
   *
   * CF-01/L3-1 fix (Important — 3-lens review): the snapshot below EXCLUDES
   * any session `AcpBackend.pendingClose` currently tombstones (via the
   * narrow {@link ConnectionSupervisorHostPort.isPendingClose} predicate). A
   * `closeTab(S)` defers S's ACTUAL registry removal onto the topology tail
   * (`AcpBackend.closeTab`'s own doc), so S can still be LIVE in
   * `this.port.sessions` at the exact instant a crash lands here — without
   * this filter, a crash landing in that window would resurrect a session
   * the user already asked to close (re-`session/load`s it and re-binds its
   * tab on the coming respawn). See `AcpBackend.pendingClose`'s own doc for
   * the full tombstone rationale.
   */
  private handleAcpCrash(code: number | null): void {
    this.clientExitSub?.dispose();
    this.clientExitSub = undefined;
    if (this.acpState === 'disposed') return;
    // WS-R3 F2-19b (mirrors ControlChannel.handleCrash's own log() guard):
    // this banner log runs BEFORE teardownForRespawn/scheduleAcpRespawn
    // below — an unguarded throwing logger must not be able to abort this
    // method before the respawn is actually scheduled.
    this.safeLog(`[AcpBackend] hermes acp exited unexpectedly (code ${code}); scheduling respawn`);
    if (this.acpState !== 'respawning') {
      // W4 §7 B1: connection-global — hits every open tab, so it rides
      // `system.error` (no sessionId), never a session-scoped `error` that
      // drop-unknown would eat the moment that one tab closes.
      // WS-R3 F2-19b (concurrency re-review Important-1): `safeEmit`, not a
      // raw `port.emit` — see that method's own doc. This is the last
      // unguarded collaborator call on the crash/respawn/arm chain, and it
      // runs BEFORE teardownForRespawn/scheduleAcpRespawn below.
      this.safeEmit({ type: 'system.error', message: 'The agent exited unexpectedly — reconnecting…' });
    }
    this.teardownForRespawn(
      'ACP connection lost',
      (controller) =>
        `[AcpBackend] crash fan-out: endOnCrash failed for session '${controller.sessionId}' (tab '${controller.tabId}'), continuing`,
    );
    this.scheduleAcpRespawn();
  }

  /**
   * beta.7 B3: DELIBERATE teardown + respawn + re-`initialize()` — so a
   * provider configured via `hermes model` (auth methods are built only
   * inside Hermes' `initialize()`, acp_adapter/server.py:875) is re-advertised
   * without a window reload. Reuses {@link handleAcpCrash}'s exact sequence
   * minus the crash logging/backoff, then runs {@link startInternal} in the
   * SAME tail link — so a reconnect can never interleave with an in-flight
   * start/openTab/tab.load/close (runOnStartTail's whole point), and the
   * fn calls startInternal DIRECTLY (never start()) per the tail's
   * self-deadlock rule. Session continuity rides the EXISTING
   * pendingRecovery → establishInitialSession → recoverSessions pipeline.
   * Guards run INSIDE the link (state can change while queued):
   *  - not 'ready' → honest refusal (never interrupts an in-progress start,
   *    an outage respawn, or a disposed supervisor);
   *  - any live turn → refusal (a reconnect must never kill a running turn).
   * On startInternal rejection: same stay-in-outage posture as a failed
   * scheduled respawn attempt (:1129-1131) — hand the outage to the existing
   * backoff machinery AND refuse honestly, so a failed reconnect still heals.
   *
   * WS-R3 F3-4: wedge-break — a turn whose cancel force-end deadline already
   * fired has hasLiveTurn() false (WS-R1 routed the force-end through
   * emitTurnEnd), so it no longer trips this guard; an explicit {force:true}
   * (future WS-UX affordance) bypasses a still-live turn — teardownForRespawn's
   * endOnCrash fan-out is the safe ending machinery, idempotent if the turn
   * completes in between.
   */
  async reconnect(opts?: { force?: boolean }): Promise<ReconnectOutcome> {
    return this.runOnStartTail(async () => {
      if (this.acpState !== 'ready') {
        return {
          ok: false as const,
          reason:
            this.acpState === 'starting' || this.acpState === 'respawning'
              ? 'The agent is already (re)connecting — wait a moment, then re-check.'
              : 'The agent connection is not running.',
        };
      }
      if (opts?.force !== true) {
        for (const controller of this.port.sessions.values()) {
          if (controller.hasLiveTurn()) {
            return {
              ok: false as const,
              reason: 'A turn is still running — wait for it to finish (or cancel it) before re-checking.',
            };
          }
        }
      }
      this.teardownForRespawn(
        'agent reconnecting',
        (controller) =>
          `[AcpBackend] reconnect fan-out: endOnCrash failed for session '${controller.sessionId}', continuing`,
      );
      try {
        await this.startInternal();
        return { ok: true as const };
      } catch (err) {
        if ((this.acpState as string) !== 'disposed') {
          this.acpState = 'respawning';
          this.scheduleAcpRespawn();
        }
        return { ok: false as const, reason: `Reconnect failed: ${describeHostError(err)}` };
      }
    });
  }

  /** Mirrors ControlChannel.scheduleRespawn/attemptRespawn: retry
   * start() forever on the shared respawnBackoffMs schedule; a failed attempt
   * reschedules, a successful one resets the counter (inside start()).
   *
   * WS-R3 F2-19b (mirrors ControlChannel's own F2-19a hardening,
   * concurrency review Minor-1/Minor-2): the next backoff is armed BEFORE
   * `emitHealth` runs — not after. `emitHealth` fans out to arbitrary
   * subscriber callbacks synchronously; arming first means this attempt's
   * timer is already committed before any of that untrusted code runs, so
   * nothing in the emit path (a throw that somehow escapes `emitHealth`'s
   * own defensive wrapper, or a reentrant subscriber) can prevent — or
   * race — the next attempt from being scheduled. */
  private scheduleAcpRespawn(): void {
    if (this.acpState === 'disposed') return;
    const attempt = ++this.acpRespawnAttempts;
    const delayMs = respawnBackoffMs(attempt);
    // WS-R3 F2-19b: guarded — see `safeLog`'s own doc. This log runs BEFORE
    // the timer below is armed; an unguarded throw here would silently
    // abort the whole respawn schedule.
    this.safeLog(`[AcpBackend] ACP respawn attempt ${attempt} in ${delayMs}ms`);
    this.acpRespawnTimer = setTimeout(() => {
      this.acpRespawnTimer = undefined;
      void this.start().catch((err) => {
        // WS-R3 F2-19b: guarded — this failure log runs BEFORE the
        // reschedule call below; an unguarded throw here would silently
        // drop the outage instead of retrying it.
        this.safeLog(`[AcpBackend] ACP respawn attempt ${attempt} failed: ${describeHostError(err)}`);
        if ((this.acpState as string) !== 'disposed') {
          this.acpState = 'respawning'; // stay in-outage: no second UI signal
          this.scheduleAcpRespawn();
        }
      });
    }, delayMs);
    this.acpRespawnTimer.unref?.();
    this.emitHealth(attempt);
  }

  private clearAcpRespawnTimer(): void {
    if (this.acpRespawnTimer) {
      clearTimeout(this.acpRespawnTimer);
      this.acpRespawnTimer = undefined;
    }
  }

  /**
   * WS-R3 F2-19b: emit an `onHealth` transition for the CURRENT attempt
   * count. Mirrors ControlChannel.emitHealth exactly (F2-19a concurrency
   * review Minor-1): the WHOLE body is wrapped defensively. Without it, a
   * pathological failure INSIDE the per-handler catch below (the logger
   * itself throwing, or `String(err)` throwing on an exotic error) would
   * escape `emitHealth` entirely. Both call sites — `scheduleAcpRespawn`
   * (after arming the next backoff, see its own ordering note) and
   * `startInternal`'s success path (its very last step) — sit on the
   * respawn loop's critical path, so an escaping throw here must never be
   * possible: the self-heal loop's "always another attempt" invariant
   * cannot depend on a subscriber or a logger behaving.
   */
  private emitHealth(attempts: number): void {
    try {
      const state = respawnHealthForAttempt(attempts);
      if (state === this.lastHealthState) return;
      this.lastHealthState = state;
      for (const handler of [...this.healthHandlers]) {
        try {
          handler({ state, attempts });
        } catch (err) {
          this.safeLog(`[AcpBackend] health handler threw: ${String(err)}`);
        }
      }
    } catch {
      // Swallow: see the doc comment above. Nothing productive can be done
      // with a failure of the failure-reporting path itself, and this
      // function must never be the reason the next backoff isn't armed.
    }
  }

  /**
   * WS-R3 F2-19b (mirrors ControlChannel.log()'s own guard, concurrency
   * re-review IMPORTANT-1): every `port.logger?.append` call on the
   * crash/respawn/arm critical path — `handleAcpCrash`'s banner,
   * `teardownForRespawn`'s per-controller fan-out, `scheduleAcpRespawn`'s
   * own log, and the retry-failure log inside its timeout callback — routes
   * through here instead of calling `port.logger?.append` directly. An
   * unguarded call (e.g. a bad/disposed `vscode.OutputChannel` on Fedora)
   * would otherwise escape and abort whichever caller invoked it before it
   * reaches the next scheduling step — leaving the connection a zombie that
   * never respawns: exactly the F2-19 silent fail-stop this class exists to
   * prevent. A logging failure must never affect control flow.
   *
   * WS-R3 F2-19b (code review Minor — doc footgun): deliberately does NOT
   * prepend a `[AcpBackend]` prefix itself, unlike `ControlChannel.log()`.
   * Every call site on this class already embeds `[AcpBackend]` inline in
   * its own message string — adding one here would double-prefix those
   * messages and redden T13's fan-out-log characterization pins (the exact
   * strings `ConnectionSupervisor.test.ts` asserts on). Do not "fix" this.
   */
  private safeLog(message: string): void {
    try {
      this.port.logger?.append(message);
    } catch {
      // Swallow: a logging failure must never affect control flow.
    }
  }

  /**
   * WS-R3 F2-19b (concurrency re-review Important-1): guards
   * `handleAcpCrash`'s crash-banner `port.emit(...)` call — the one
   * remaining unguarded collaborator call on the `handleAcpCrash ->
   * teardownForRespawn -> scheduleAcpRespawn -> arm` chain, sitting BEFORE
   * `teardownForRespawn`/`scheduleAcpRespawn` run. If it threw,
   * `handleAcpCrash` would abort at that statement: `teardownForRespawn`
   * never runs (client not disposed, `pendingRecovery` never snapshotted,
   * `acpState` never flips to 'respawning') and `scheduleAcpRespawn()` is
   * never reached — the exact F2-19 zombie this class exists to prevent.
   * Safe in production TODAY only because `port.emit` -> `AcpBackend.emit`
   * -> `vscode.EventEmitter.fire` happens to route a throwing listener to
   * `onUnexpectedError` rather than rethrow synchronously into the caller —
   * that is the PRIMITIVE's behavior, not a guarantee this call site
   * enforces itself. Mirrors `safeLog`'s try/catch-swallow shape exactly.
   */
  private safeEmit(msg: HostToWebviewMessage): void {
    try {
      this.port.emit(msg);
    } catch {
      // Swallow: an emit failure must never affect control flow — see the
      // doc comment above.
    }
  }

  /**
   * W6-FI-b: the connection-owned first two acts of `AcpBackend.dispose()`
   * (`this.acpState = 'disposed'; this.clearAcpRespawnTimer();`), bundled
   * into one call. Safe to combine — both are synchronous, back-to-back,
   * with no `await` between them in the original, so nothing could ever
   * observe the intermediate state. `AcpBackend.dispose()` calls this FIRST
   * (same position as the original two statements), then separately calls
   * {@link teardownSession} several statements later (AFTER
   * `rootRegistry.disposeAll()`) — that ordering is NOT bundled here, since
   * it is not adjacent in the original.
   *
   * WS-R3 F2-19b: also clears `healthHandlers` — mirrors
   * `ControlChannel.dispose()`'s own `eventHandlers.clear()`/
   * `healthHandlers.clear()` pair. Same synchronous, no-`await`-between
   * reasoning applies.
   */
  markDisposed(): void {
    this.acpState = 'disposed';
    this.clearAcpRespawnTimer();
    this.healthHandlers.clear();
  }
}

/**
 * The dependencies a `ConnectionSupervisor` needs from its host, injected so
 * the supervisor itself never imports `vscode` and stays unit-testable in
 * isolation (mirrors `OneShotHostPort`/`SessionHostPort`'s accessor posture).
 *
 * `cwd`/`activeSessionId` are NOT exposed as a general get/set pair — only
 * the exact accessors the moved code originally used (`setCwd` — the moved
 * code only ever WRITES it; `getActiveSessionId`/`setActiveSessionId` — the
 * moved code reads then conditionally writes it in `recoverOneSession`).
 * Every OTHER read/write of `cwd`/`activeSessionId` lives in router methods
 * that stay on `AcpBackend` (`openSession`/`loadSessionIntoTab`/
 * `activeController`) and touches the fields directly, unchanged.
 */
export interface ConnectionSupervisorHostPort {
  /** Passed straight through to `resolveHermes` — unchanged from `AcpBackend`'s own constructor param. */
  config: HermesRuntimeConfig;
  /** Test seam — the same `AcpClientFactory` `AcpBackend`'s constructor receives. */
  createClient: AcpClientFactory;
  logger?: Logger;

  /**
   * The three ACP client callbacks, forwarded straight through to
   * `createClient({..., callbacks})` — each one a thin passthrough to
   * `AcpBackend`'s own `handleSessionUpdate`/`handleRequestPermission`/
   * `handleReadTextFile` (none of which is a connection-lifecycle concern:
   * they dispatch into the session registry / one-shot runner / vscode-file
   * confinement).
   */
  callbacks: AcpClientCallbacks;

  /**
   * Write the connection's resolved boot cwd. The moved code only ever
   * WRITES this (`startInternal`'s `resolved.cwd`, `recoverOneSession`'s
   * conditional re-adoption) — every READ of `AcpBackend.cwd` happens in
   * router code that stays (`openTabInternal`/`warmCheckpointBaseline`/
   * `buildPanelDataMessage`/the `OneShotHostPort` accessor), so no `getCwd`
   * is needed here.
   */
  setCwd(cwd: string): void;
  /** `recoverOneSession`'s "is there already an active session" check — the ONE read this class needs. */
  getActiveSessionId(): string | undefined;
  /** `recoverOneSession`'s conditional adoption + `teardownSession`'s unconditional clear. */
  setActiveSessionId(sessionId: string | undefined): void;

  /** The shared per-session actor registry (`AcpBackend.sessions`) — same live instance, injected by reference. */
  sessions: SessionRegistry;
  /** `this.control.start()` — the control-plane gateway `AcpBackend` owns and starts. */
  startControl(): Promise<void>;
  /** `AcpBackend.buildSessionPort` — mints the `SessionHostPort` a freshly-opened/recovered controller needs. */
  buildSessionPort(sessionId: string, cwd: string): SessionHostPort;
  /**
   * `AcpBackend.openSession` — mints the connection-boot bootstrap session.
   * T-3 (closes B1-M1): `isStaleAttempt`, when supplied, is polled once
   * `client.newSession` resolves — BEFORE registering the controller or
   * firing `tab.bound` — so a belated resolve for an attempt this class
   * already gave up on (deadline/exit) closes the orphaned session instead
   * of binding it. `establishInitialSession` is the only caller reached
   * through this port interface that passes one. WS-R1 F3-1: `openTab`'s
   * mint (`AcpBackend.openTabInternal`, called directly — not through this
   * port) is ALSO now deadline+exit-raced and passes the same guard; it is
   * no longer un-raced, and no longer unconditionally `undefined`/never-stale.
   */
  openSession(cwd: string, tabId: string, isStaleAttempt?: () => boolean): Promise<SessionController>;
  /** `[...this.mcpServers.values()]` — the MCP servers to advertise on a recovered `session/load`. */
  getMcpServers(): AcpMcpServer[];
  /**
   * W6-P7-N11 (3-way ARCH I-4): routes `recoverOneSession`'s bind-time
   * `tab.bound` + `mode.state` announcement through the SAME
   * `AcpBackend.announceSessionBound` that `openSession`/`loadSessionIntoTab`
   * use — see that method's own doc for the exact preserved order/shape.
   * Replaces this class's former direct `port.emit(...)` pair +
   * `getAvailableModesCatalog()` read.
   */
  announceSessionBound(tabId: string, sessionId: string, rootId: string): void;
  /** `AcpBackend.warmCheckpointBaseline` — fire-and-forget session-baseline snapshot after a fresh bootstrap mint. */
  warmCheckpointBaseline(): void;
  /** `this.oneShotRunner.settleAll(reason)` — settle any in-flight ephemeral one-shot on teardown/crash. */
  settleOneShot(reason: string): void;
  /** `AcpBackend.resetSessionsAccumulation` — clear the Sessions panel's paginated accumulation. */
  resetSessionsAccumulation(): void;
  /**
   * CF-01/L3-1 fix (Important): narrow predicate — is `sessionId` mid-close
   * (added synchronously by `AcpBackend.closeTab`, cleared once the deferred
   * `closeTabInternal` actually runs)? {@link handleAcpCrash}'s
   * `pendingRecovery` snapshot excludes any session this returns `true` for
   * — a user-closed session must never be resurrected by a crash respawn.
   * Deliberately a single boolean read (not a broader "give me the whole
   * set" surface) — this class needs no other visibility into `pendingClose`.
   * See `AcpBackend.pendingClose`'s own doc for the full tombstone rationale.
   */
  isPendingClose(sessionId: string): boolean;

  /**
   * T8 (beta.5 §2.3, bug ⑧ — critic C-5): OPTIONAL structural "no chat
   * provider configured" probe, consulted at `establishInitialSession`-
   * failure time to route the session-start banner. `AcpBackend` wires it
   * to `computeProviderCard(getAdvertisedAuthMethods()).phase ===
   * 'unconfigured'` — the SAME advertised-auth-methods source the Setup
   * Provider card reads (`extension.ts` binds `SetupControllerDeps.
   * getAdvertisedAuthMethods` to a thunk over the very same
   * `AgentBackend.getAdvertisedAuthMethods`), so banner and card can never
   * disagree. Optional (older test doubles omit it, like
   * `onAuthMethodsChanged`): absent, routing falls back to the
   * `isAuthRequiredError` (`-32000`) supplement alone.
   */
  isProviderUnconfigured?: () => boolean;

  /**
   * Fires a HostToWebview message (mirrors `SessionHostPort.emit`, but
   * unconstrained — connection-level emits are MOSTLY not session-scoped).
   * W6-P7-N11 (doc fix, closes 3-way ARCH Minor-6): `recoverOneSession`'s
   * session-scoped `mode.state`/`tab.bound` pair now goes through {@link
   * announceSessionBound}, not this method. The remaining direct `emit(...)`
   * calls carry no `sessionId` (`system.error`, `tab.error`) — EXCEPT T-1's
   * {@link fanOutRestartSignal}, which emits `clear{sessionId}` for the
   * bootstrap-bound tab on an explicit restart (the webview routes `clear` by
   * `sessionId` regardless of emit origin — review T-1 M-1).
   */
  emit(msg: HostToWebviewMessage): void;
}

/**
 * T8 (beta.5 §2.3, bug ⑧): host-side error rendering — the shared
 * `describeError` with the extension host's REAL home threaded in (folded
 * hardening S-3: `os.homedir()` works even when `$HOME`/`%USERPROFILE%`
 * are unset, where `errorText.ts`'s own env fallback would silently skip
 * redaction). Replaces this file's former naive `err instanceof Error ?
 * err.message : String(err)` copy, which rendered the ACP SDK's raw
 * JSON-RPC `{code,message,data}` rejections (`acp.js:886`) as the literal
 * `"[object Object]"`. Scope pin (§2.3): only THIS file's and
 * `AcpBackend.ts`'s copies convert this wave — the other ~11 naive copies
 * across the codebase are a mechanical follow-up.
 */
function describeHostError(err: unknown): string {
  return describeError(err, homedir());
}
