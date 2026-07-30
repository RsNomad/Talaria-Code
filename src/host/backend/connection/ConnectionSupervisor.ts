import type { Logger } from '../../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../../runtime/resolveHermes';
import { resolveHermes } from '../../runtime/resolveHermes';
import { respawnBackoffMs } from '../../control/respawnBackoff';
import { BOOTSTRAP_TAB_ID } from '../../../shared/protocol';
import type { HostToWebviewMessage } from '../../../shared/protocol';
import type {
  AcpClientCallbacks,
  AcpClientFactory,
  AcpClientLike,
  AcpLoadSessionResult,
  AcpMcpServer,
} from '../acp/acpClient';
import type { SessionController } from '../session/SessionController';
import type { SessionRegistry } from '../session/SessionRegistry';
import type { SessionHostPort } from '../session/types';

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
 * ConnectionSupervisor.raceAgainstChildExit}'s pre-existing exit-only race
 * (T-B1/V-8, which already covers "the child DIED mid-request" but not "the
 * child stayed ALIVE and simply never answered" — a harness deadlock or a
 * stuck event loop, the gap this task closes). 120s matches `JsonRpcStdio`'s
 * own per-request RPC ceiling and `OneShotRunner.runOneShot`'s whole-turn
 * deadline — generous against replay cost: a local `session/new`/
 * `session/load` streams back in seconds, so this bounds only the
 * pathological hang, never an ordinary slow response.
 */
const SESSION_ESTABLISH_DEADLINE_MS = 120_000;

/** Outcome of {@link ConnectionSupervisor.raceConnectPhase}'s internal race. */
type ConnectPhaseOutcome = { kind: 'connected' } | { kind: 'deadline' } | { kind: 'exit'; code: number | null };

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
   */
  private inFlightStart: Promise<void> | undefined;

  /**
   * R-A6: ACP-channel lifecycle — the same five-state machine ControlChannel
   * runs for the control child (ControlChannel.ts:76,265-307), because the two
   * children over one extension deserve symmetric supervision. 'respawning'
   * additionally gates the "one reconnecting signal per outage" rule.
   */
  private acpState: 'idle' | 'starting' | 'ready' | 'respawning' | 'disposed' = 'idle';
  private acpRespawnAttempts = 0;
  private acpRespawnTimer: ReturnType<typeof setTimeout> | undefined;

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

  constructor(private readonly port: ConnectionSupervisorHostPort) {}

  /** The live ACP client, read at call time — `undefined` before/between connections. */
  getClient(): AcpClientLike | undefined {
    return this.client;
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
   */
  runOnStartTail(fn: () => Promise<void>): Promise<void> {
    const run = (this.inFlightStart ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => fn());
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
        logger: this.port.logger,
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
          message: `Hermes failed to start: ${errorMessage(err)}`,
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
   * race idiom ({@link raceRecoveryAgainstChildExit}) and `ControlChannel`'s
   * own `awaitReady` race.
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
      this.port.emit({ type: 'system.recovered' });
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
      const controller = this.client
        ? await this.raceAgainstChildExit(openSession, this.client, SESSION_ESTABLISH_DEADLINE_MS)
        : await openSession;
      attemptAbandoned = true;
      if (controller === undefined) {
        // T-3: this `undefined` came from EITHER the child's own exit
        // (raced since T-B1/V-8) OR the new SESSION_ESTABLISH_DEADLINE_MS
        // wall-clock deadline (the child stayed ALIVE but never answered
        // `session/new`) — `raceAgainstChildExit` deliberately makes the
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
      this.port.logger?.append(
        `[AcpBackend] initial session establish failed — connection stays up (acpState='ready'): ${errorMessage(err)}`,
      );
      this.port.emit({
        type: 'system.error',
        message: `Failed to start a Hermes session: ${errorMessage(err)}`,
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
   * `startInternal`'s `inFlightStart` tail — a concurrent `openTab` (the
   * ONLY other caller genuinely chained onto this SAME tail, via {@link
   * runOnStartTail}) cannot interleave a half-recovered handshake, and no
   * second child is ever spawned here.
   *
   * W6-FG (doc-honesty fix — a prior revision of this comment overclaimed
   * `tab.load`/`sendPrompt` were ALSO "queued behind the same tail"; they are
   * NOT): `loadTab` (the `tab.load` wire entry) is fire-and-forget — it
   * awaits `AcpBackend.loadSessionIntoTab` directly, with no `inFlightStart`
   * chaining at all — and `sendPrompt` is a synchronous void passthrough to
   * `this.sessions.get(sessionId)?.sendPrompt(...)`. Either CAN genuinely
   * interleave with a still-in-flight recovery here; see {@link
   * recoverOneSession}'s own doc for the race this creates (a same-`sessionId`
   * `tab.load` winning the registry slot mid-recovery) and its
   * identity-guarded close.
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
   */
  private async recoverSessions(
    recovery: Array<{ sessionId: string; cwd: string; tabId: string }>,
  ): Promise<void> {
    for (const { sessionId, cwd, tabId } of recovery) {
      try {
        await this.recoverOneSession(sessionId, cwd, tabId);
      } catch (err) {
        // Defensive — `recoverOneSession` itself never throws today
        // (`SessionController.loadReplay` never rejects), but keeping this
        // per-attempt catch makes the F2 "one bad session can't wedge the
        // others" guarantee airtight against a future change to that
        // contract, exactly like `establishInitialSession`'s own try/catch
        // does for the ordinary bootstrap mint.
        this.port.logger?.append(
          `[AcpBackend] respawn recovery: unexpected failure recovering session '${sessionId}' (tab '${tabId}') — treating as session-lost: ${errorMessage(err)}`,
        );
        this.port.emit({ type: 'tab.error', tabId, kind: 'session-lost', message: errorMessage(err) });
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
   * `controller.loadReplay` never rejects — a load failure resolves
   * `undefined` (after emitting its own `error`/`turn.end` pair for that
   * tab's transcript, UNLESS superseded — see the W6-FG note below). The
   * ADDITIONAL `tab.error{kind: 'session-lost'}` below is the tab-chrome-level
   * restart affordance (§7 B8); the orphaned controller is dropped via the
   * registry's F6 remove-before-dispose, IDENTITY-GUARDED (see the close
   * below) — never a second, unconditional removal path.
   *
   * W6-FG (folded-in W6-FB review Minor — doc-honesty fix + the identity
   * guard itself): a prior revision of this comment claimed "this controller
   * was just minted exclusively for this attempt, so `loadReplay`'s internal
   * 'superseded while awaiting' branch can never fire for it" — that is
   * FALSE. `loadTab`/`tab.load` is fire-and-forget, NOT serialized behind
   * `inFlightStart` (see {@link recoverSessions}'s own corrected doc) — a
   * user CAN load this SAME `sessionId` into a DIFFERENT tab while this
   * `loadReplay` await is still in flight. `SessionRegistry.open`'s W6-FB
   * remove-then-dispose then disposes THIS `controller` and rebinds
   * `sessionId` to the winner's fresh controller — which DOES trip
   * `loadReplay`'s own supersede guard (`this.replay !== replay`) on THIS
   * controller, resolving `undefined` here exactly as an ordinary failure
   * would. If this method then closed by KEY (`this.sessions.close(sessionId)`
   * unconditionally), it would dispose the WINNER — not this stale attempt —
   * silently zombifying the winner's tab with no `tab.error` at all. Fixed by
   * guarding the close by IDENTITY: `controller` is captured ABOVE, before
   * the await, and only closed if it is STILL the registry's current owner
   * for `sessionId`. A no-op when the recovery is genuinely NOT superseded
   * (the overwhelmingly common case) — `this.port.sessions.get(sessionId) ===
   * controller` then holds and the close proceeds exactly as before.
   *
   * I1 (independent concurrency review, W4-T5a fix pass): the `loadReplay`
   * await is raced against `this.client`'s own `onExit` ({@link
   * raceRecoveryAgainstChildExit}) — see that method's doc for why a hung
   * `client.loadSession` here would otherwise wedge the ENTIRE respawn tail,
   * not just this one session's recovery.
   */
  private async recoverOneSession(sessionId: string, cwd: string, tabId: string): Promise<void> {
    const mcpServers = this.port.getMcpServers();
    const controller = this.port.sessions.open(sessionId, cwd, this.port.buildSessionPort(sessionId, cwd), tabId);

    this.port.announceSessionBound(tabId, sessionId, controller.getRootId());

    const loadReplay = controller.loadReplay(cwd, sessionId, cwd, mcpServers);
    const result = this.client
      ? await this.raceRecoveryAgainstChildExit(loadReplay, this.client)
      : await loadReplay;
    if (result === undefined) {
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
      return;
    }

    if (this.port.getActiveSessionId() === undefined) {
      this.port.setActiveSessionId(sessionId);
      this.port.setCwd(cwd);
    }
  }

  /**
   * I1 (independent concurrency review, W4-T5a fix pass): bound {@link
   * recoverOneSession}'s `loadReplay` await against `client`'s own
   * unexpected death. `AcpClientLike.loadSession` (via `loadReplay`) is
   * NOT contractually guaranteed to reject when its child is killed
   * mid-request — `onExit`'s own doc only promises the exit NOTIFICATION
   * (R-A6), never that every in-flight RPC settles. If it hangs, this await
   * never settles, `recoverSessions`'s loop never advances past this
   * session, `establishInitialSession`/`startInternal` never resolve, and
   * the CURRENT `start()` call's `run` — what {@link inFlightStart} is
   * holding — never resolves either: a SECOND crash's `scheduleAcpRespawn ->
   * start()` chains onto that same tail (P0's serialization) and can never
   * reach its own `startInternal()`. Every open tab stays "reconnecting"
   * forever — the never-resolves class this project systematically kills.
   *
   * Races against `client.onExit` rather than a wall-clock timeout — the
   * child dying IS the recovery failing, the exact signal, with no need to
   * guess a duration that's long enough to never misfire on a genuinely
   * slow (but alive) replay. A raced loss resolves `undefined`, which
   * `recoverOneSession`'s EXISTING `result === undefined` branch already
   * treats as a failed recovery (`tab.error{kind:'session-lost'}` +
   * registry drop, reused verbatim — no new failure path). The happy path
   * (`loadReplay` resolves before any exit) is unaffected: the exit branch
   * never wins a race it never enters, and its subscription is disposed
   * either way (mirrors `ControlChannel.awaitReady`'s own event-vs-exit
   * race, `ControlChannel.ts:197`).
   */
  private raceRecoveryAgainstChildExit(
    loadReplay: Promise<AcpLoadSessionResult | undefined>,
    client: AcpClientLike,
  ): Promise<AcpLoadSessionResult | undefined> {
    // T-B1 (closes V-8): re-implemented on {@link raceAgainstChildExit} —
    // behavior identical for this method's own caller (`recoverOneSession`,
    // which has no try/catch around this call): a defensive-only rejection
    // from `loadReplay` (never happens today — see this method's own doc)
    // still resolves `undefined` here, exactly as before, rather than
    // passing through and rejecting `recoverOneSession`'s await the way the
    // generalized helper does for ITS callers.
    //
    // T-3 (closes B1-M1): SESSION_ESTABLISH_DEADLINE_MS added alongside the
    // pre-existing exit-only race — a respawned child that stays ALIVE but
    // never answers `session/load` (no exit ever fires) previously hung
    // this ONE tab's recovery forever (F2's per-tab isolation still holds:
    // `recoverSessions`'s per-attempt try/catch means a stuck sibling never
    // blocked THIS session's own eventual timeout, and vice versa). No
    // belated-resolution guard is needed here the way `establishInitialSession`
    // needed one for `openSession`: `recoverOneSession` already announces
    // `tab.bound` and registers the controller BEFORE this await even
    // starts (§7 B9(b)), so there is no "belated bind" to prevent — and a
    // belated `loadReplay` resolution arriving after THIS method's own
    // `result === undefined` branch (below) has already
    // identity-guard-closed the controller is caught by REUSED, pre-existing
    // machinery: `SessionController.dispose()` clears `this.replay`, which
    // trips `loadReplay`'s own supersede guard (`this.replay !== replay`,
    // the W6-FG note above) and makes the belated continuation a silent
    // no-op, exactly as it already does for the `tab.load`-supersedes-
    // recovery race this same guard was built for.
    return this.raceAgainstChildExit(loadReplay, client, SESSION_ESTABLISH_DEADLINE_MS).catch(() => undefined);
  }

  /**
   * T-B1 (closes V-8): generalizes {@link raceRecoveryAgainstChildExit} to
   * an arbitrary in-flight request `p` — races it against `client`'s own
   * exit. Resolves `p`'s value on the happy path, resolves `undefined` if
   * the child dies first, and — UNLIKE `raceRecoveryAgainstChildExit` —
   * PASSES THROUGH a genuine rejection of `p` rather than swallowing it to
   * `undefined`, so a caller with its OWN honest catch (e.g.
   * `establishInitialSession`'s bootstrap `openSession` race) keeps seeing
   * the real error instead of a misleadingly-generic "child exited" story.
   *
   * T-3 (closes B1-M1): generalized with an OPTIONAL `deadlineMs` — a THIRD
   * way this race can end, resolving `undefined` on the EXACT same contract
   * as the exit branch (an un-jam, not a failure signal of its own; the
   * caller decides what `undefined` means for its own leg). Un-raced, a
   * child that stays ALIVE but never answers `p` (a harness deadlock, a
   * stuck event loop) hangs this await — and therefore `inFlightStart` —
   * forever, exactly the class of bug `raceConnectPhase` already closed for
   * the CONNECT phase; this closes it for session establishment/recovery
   * too. The timer is armed BEFORE `p` is awaited (harmless — `p` is
   * already in flight by the time this is called, so there's no
   * spawn-ordering window to protect here the way `raceConnectPhase` has to
   * protect one) and cleared on EVERY settle path (exit, deadline, or `p`
   * itself resolving/rejecting), so a fast happy path never leaves a stray
   * timer armed (proven by the T-3 fast-path test). Omitting `deadlineMs`
   * reproduces the exact prior behavior (no timer created at all).
   */
  private raceAgainstChildExit<T>(p: Promise<T>, client: AcpClientLike, deadlineMs?: number): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const clearDeadline = (): void => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      };
      const settleResolve = (value: T | undefined): void => {
        if (settled) return;
        settled = true;
        exitSub.dispose();
        clearDeadline();
        resolve(value);
      };
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        exitSub.dispose();
        clearDeadline();
        reject(err);
      };
      const exitSub = client.onExit(() => settleResolve(undefined));
      if (deadlineMs !== undefined) {
        deadlineTimer = setTimeout(() => settleResolve(undefined), deadlineMs);
        // Don't keep the event loop alive on this deadline — matches
        // raceConnectPhase's own CONNECT_PHASE_DEADLINE_MS timer and
        // scheduleAcpRespawn's backoff timer.
        deadlineTimer.unref?.();
      }
      p.then(settleResolve, settleReject);
    });
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
   */
  private handleAcpCrash(code: number | null): void {
    this.clientExitSub?.dispose();
    this.clientExitSub = undefined;
    if (this.acpState === 'disposed') return;
    this.port.logger?.append(
      `[AcpBackend] hermes acp exited unexpectedly (code ${code}); scheduling respawn`,
    );
    if (this.acpState !== 'respawning') {
      // W4 §7 B1: connection-global — hits every open tab, so it rides
      // `system.error` (no sessionId), never a session-scoped `error` that
      // drop-unknown would eat the moment that one tab closes.
      this.port.emit({ type: 'system.error', message: 'The agent exited unexpectedly — reconnecting…' });
    }
    // W4-T5a (Q-10): snapshot every registered session's identity BEFORE the
    // per-controller fan-out / the coming respawn's teardownSession() clears
    // the registry — endOnCrash() never mutates sessionId/cwd/tabId, so
    // capturing here (vs. after the loop) makes no functional difference,
    // but doing it FIRST keeps the recovery worklist visibly independent of
    // whatever endOnCrash does to each controller's turn/replay state.
    this.pendingRecovery = [...this.port.sessions.values()].map((controller) => ({
      sessionId: controller.sessionId,
      cwd: controller.cwd,
      tabId: controller.tabId,
    }));
    // §2c req 5: settle any in-flight one-shot on this SAME child crash —
    // independent of (and before) the per-controller handling below.
    // W6-FI-a: delegates to `OneShotRunner` via the port.
    this.port.settleOneShot('ACP connection lost');
    // CF-01/A fix wave (arch Important, secondary robustness fix): guarded
    // per-controller, mirroring `recoverSessions`'s EXISTING per-attempt
    // try/catch (`:533-546`) — defensive-only (`SessionController.endOnCrash`
    // never throws today, pure turn/state bookkeeping + event emission), but
    // an unguarded abort here would skip BOTH the remaining controllers'
    // crash-end AND the trailing `this.client?.dispose()` below, which is
    // what clears `this.connection` (via `AcpClient.dispose()`) and is now
    // the ONLY thing standing between a stale post-terminate client
    // reference and a hang if `terminate()` itself somehow didn't already
    // self-clear it — see `acpClient.ts`'s `terminate` closure doc.
    for (const controller of this.port.sessions.values()) {
      try {
        controller.endOnCrash();
      } catch (err) {
        this.port.logger?.append(
          `[AcpBackend] crash fan-out: endOnCrash failed for session '${controller.sessionId}' (tab '${controller.tabId}'), continuing: ${errorMessage(err)}`,
        );
      }
    }
    // arch-A2: null the dead client so sendPrompt/loadSession's admission
    // guards refuse honestly ("not started yet") during the backoff window.
    this.client?.dispose();
    this.client = undefined;
    this.acpState = 'respawning';
    this.scheduleAcpRespawn();
  }

  /** Mirrors ControlChannel.scheduleRespawn/attemptRespawn: retry
   * start() forever on the shared respawnBackoffMs schedule; a failed attempt
   * reschedules, a successful one resets the counter (inside start()). */
  private scheduleAcpRespawn(): void {
    if (this.acpState === 'disposed') return;
    const attempt = ++this.acpRespawnAttempts;
    const delayMs = respawnBackoffMs(attempt);
    this.port.logger?.append(`[AcpBackend] ACP respawn attempt ${attempt} in ${delayMs}ms`);
    this.acpRespawnTimer = setTimeout(() => {
      this.acpRespawnTimer = undefined;
      void this.start().catch((err) => {
        this.port.logger?.append(
          `[AcpBackend] ACP respawn attempt ${attempt} failed: ${errorMessage(err)}`,
        );
        if ((this.acpState as string) !== 'disposed') {
          this.acpState = 'respawning'; // stay in-outage: no second UI signal
          this.scheduleAcpRespawn();
        }
      });
    }, delayMs);
    this.acpRespawnTimer.unref?.();
  }

  private clearAcpRespawnTimer(): void {
    if (this.acpRespawnTimer) {
      clearTimeout(this.acpRespawnTimer);
      this.acpRespawnTimer = undefined;
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
   */
  markDisposed(): void {
    this.acpState = 'disposed';
    this.clearAcpRespawnTimer();
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
   * of binding it. `establishInitialSession` is the only caller that passes
   * one; `openTab`'s un-raced mint has nothing to abandon it, so it omits
   * the argument (always `undefined` there — never stale).
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
