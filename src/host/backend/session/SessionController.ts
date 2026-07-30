import { homedir } from 'node:os';
import type {
  AgentMode,
  Attachment,
  ApprovalOption,
  ContextRef,
  DiffAction,
  EditPolicyPreset,
  SlashCommandInfo,
  SubagentsData,
} from '../../../shared/protocol';
import { BOOTSTRAP_TAB_ID, makePanelData } from '../../../shared/protocol';
import type { ResolvedContext } from '../../context/types';
import type { SessionHostPort } from './types';
import { TurnTranslator } from '../acp/turnTranslator';
import { ReplayTranslator } from '../acp/replayTranslator';
import { buildPromptContent, confineAttachmentPaths } from '../acp/attachments';
import { mentionBlocks } from '../acp/mentions';
import {
  mapPermissionRequest,
  applyResolvedPresentation,
  buildMinimalAskApproval,
  buildSelectedOutcome,
  buildCancelledOutcome,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from '../acp/permission';
import type { MappedPermissionRequest } from '../acp/permission';
import { buildCommandSignal, buildEditSignalFromResolved, extractEditPathStrings } from '../acp/policySignal';
import { evaluateEditPolicy } from '../policy/editPolicy';
import type { ModeFloor, PolicyDecision, PolicySignal } from '../policy/editPolicy';
import { canonicalizeEditPath } from '../acp/pathConfine';
import type { CanonicalEditPath } from '../acp/pathConfine';
import { mapUsage, mapStopReasonToStatus } from '../acp/usage';
import { mapAvailableCommands } from '../acp/commands';
import type {
  AcpMcpServer,
  AcpLoadSessionResult,
} from '../acp/acpClient';
import type {
  AcpOutboundContentBlock,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionUpdate,
  AcpToolCallFields,
} from '../acp/types';
import { SubagentAccumulator } from '../../panels/subagentAccumulator';
import { extractPreviewFiles } from '../../preview/extractPreviewFiles';

/**
 * W4-T1a — the per-session actor (§2c). Holds ONE ACP session's state (the
 * §2a field-sort table's `SessionController` bucket) and the method bodies
 * MOVED VERBATIM off `AcpBackend`: `sendPrompt`, `cancel`, `respondApproval`,
 * `resolveDiff`, `applyUpdate` (ex-`handleSessionUpdate` body),
 * `handlePermission` (ex-`handleRequestPermission` body), `setPreset`,
 * `setModel`, the `loadReplay`/replay bookkeeping, and `dispose()`
 * — each now reading THIS controller's own fields instead of `AcpBackend`'s
 * flat globals. (The `setMode` body that once lived here was YAGNI-deleted in
 * H9/P7-N10 — the wire-mode pin is `pinWireModeDefault`; the picker uses
 * `setCustomMode`.)
 *
 * TIER (W6-FK / I-9 honest grading — see `src/host/purityScan.ts`'s
 * three-tier vocabulary doc): **headless**, NOT pure. No `vscode` import —
 * every host dependency (the live ACP client, emitting a protocol message,
 * the root's checkpoint tracker/turn-lease bridge, the full workspace-root
 * list, the diff-preview registry, mention resolution, the
 * checkpoints-panel refresh trigger) is reached through the injected
 * {@link SessionHostPort}, so this class needs no `vscode` mock to unit
 * test. But it is NOT deterministic-pure the way e.g. `acp/pathConfine.ts`'s
 * logic is: `sendPrompt`/`runTurn` call `Date.now()` directly (turn timing,
 * `turnStartedAt`/`durationMs`) and `canonicalizeToolCallPaths` calls
 * `homedir()` (path canonicalization) — both real, load-bearing, and
 * deliberately NOT ripped out (that would be a behavior change, not a
 * grading fix). "Vscode-free" and "deterministic" are two different
 * guarantees; this class only ever held the first one, and the class doc
 * used to say "pure" as if it held both — that overstatement is what this
 * note corrects. `session/` is mechanically scanned at the HEADLESS tier by
 * `policyAcpPurity.test.ts`'s session/ extension (no `vscode`, no `fs`;
 * `Date.now()`/`homedir()` are the sanctioned headless seams).
 *
 * T1a note on `sessionId`/`cwd` mutability (a deliberate, test-evidenced
 * deviation from the §2c port sketch's illustrative `readonly sessionId`):
 * with no `tabId` wiring yet (T3's job), `AcpBackend.loadSessionIntoTab`
 * REUSES the single active controller in place for a History-load — exactly
 * mirroring today's `AcpBackend.loadSession` reassigning `this.sessionId`/
 * `this.cwd` on the SAME instance (proven by the existing "P4b: a superseded
 * load's belated resolution must not flip the WINNING load's `replaying`
 * flag" test, which spies on ONE stable `subagents` object instance across
 * two overlapping loads targeting different session ids). `sessionId`/`cwd`
 * are therefore plain mutable fields, reassigned only by {@link loadReplay}.
 * T3 replaces this approximation with a REAL per-tab controller mint.
 */
export class SessionController {
  sessionId: string;
  cwd: string;

  // --- turn lifecycle ---------------------------------------------------
  private turn: TurnTranslator | undefined;
  /** R-C2: non-undefined exactly while a `session/load` replay is streaming. */
  private replay: ReplayTranslator | undefined;
  private currentTurnId: string | undefined;
  private turnCounter = 0;
  private turnStartedAt = 0;
  /**
   * W4-T2 (§2c decoupling): the ROOT-SCOPED checkpoint ordinal minted at
   * `sendPrompt` admission (via `port.root.nextTurnOrdinal()`), shared by
   * the before- AND after-snapshot of this SAME turn. Replaces the deleted
   * `turnOrdinalFromTurnId` derivation — under root-scoped ordinals two
   * sessions' `turn-1` would otherwise both (wrongly) claim ordinal 1.
   */
  private currentTurnOrdinal: number | undefined;
  /** P3: id of the LIVE prompt turn — see `AcpBackend`'s original field doc. */
  private liveTurnId: string | undefined;
  /** The turn id (if any) the user cancelled — see `AcpBackend`'s original field doc. */
  private cancelledTurnId: string | undefined;

  // --- policy inputs ------------------------------------------------------
  /** W2-F1: boots at `'manual'` — today's ask-everything behavior. */
  private activePreset: EditPolicyPreset = 'manual';
  /**
   * F4: the wire `AgentMode` pin now lives PER-CONTROLLER (was a flat
   * `AcpBackend` field).
   *
   * CF-01 (W1-T3 review, CRITICAL fix): widened from `AgentMode` to `string`.
   * A failed re-assert (`pinWireModeDefault`'s catch) now seeds this field
   * with the RAW drifted mode id Hermes reported — not guaranteed to be one
   * of our own `AgentMode` literals — so `runTurn`'s `!== 'default'` re-pin
   * check (~:894, this field's ONLY reader in the file — grep-confirmed) can
   * actually detect the drift, instead of the field staying permanently
   * `'default'` (its only other assignments) and that check being dead code.
   */
  private currentMode: string = 'default';
  /**
   * W4-T4b (SF-2 §4.3 mitigation 1 — the self-widening PRIMARY fix): the
   * active custom mode's snapshot, or `undefined` when no mode is active.
   * Plain DATA only — the router (`AcpBackend.setCustomMode`) does the
   * impure settings read + snapshot build and hands this controller the
   * already-built {@link ModeFloor}; this controller never imports `vscode`
   * and never re-reads settings itself, which is exactly what makes the
   * snapshot immune to a later `onDidChangeConfiguration` firing — only an
   * explicit {@link setCustomMode} call (a user re-pick) replaces it.
   */
  activeCustomMode?: ModeFloor;
  /**
   * W4-T4b: the id of the active custom mode, or `null` when none is
   * active. `AcpBackend`'s `onDidChangeConfiguration` handler reads this
   * (read-only, from the router) to decide which sessions to warn + re-emit
   * `mode.state` for — the value itself is untouched by that path.
   */
  activeCustomModeId: string | null = null;
  /** W2-F1/F2 Phase 0: is the CURRENT turn checkpoint-protected? See `AcpBackend`'s original doc. */
  private currentTurnProtected = false;
  /** T1a: the per-tab active model id. Read by `ControlDispatcher.listTabs` into
   * the `HydrateTabSeed` (H4-B8) so a reconciled tab shows its model without
   * waiting for a fresh push; set by `setModel`.
   * ARCH-1 (final review, UI I-1): assigned ONLY on RPC resolve — never
   * unconditionally at call time — so a recreated webview can never be
   * seeded with a model the agent actually refused. */
  currentModelId: string | undefined;
  /**
   * ARCH-1 (final review, UI I-1) §1.6 — liveness token for `setModel`, the
   * same idiom this controller already uses for `this.replay !== replay`
   * (loadReplay) and BF-B's `disposed` re-check. Two rapid picks A→B can
   * settle out of order; each attempt captures `++this.modelSwitchSeq` at
   * entry, and its resolve/reject handler drops silently if a NEWER attempt
   * has since bumped the counter — only the newest attempt's terminal push
   * ever lands.
   */
  private modelSwitchSeq = 0;

  private readonly subagents = new SubagentAccumulator();

  // --- approval trio (keyed by plain toolCallId — R7, redundant compound removed) ---
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly hunkState = new Map<string, HunkAggregationState>();
  private readonly toolIdToApprovalId = new Map<string, string>();
  /**
   * BF-B: closes the pre-registration dangling-promise window in
   * `handlePermission` — mirrors the controller's existing liveness-token
   * idiom (the `this.replay !== replay` re-check after an await in the
   * `loadReplay` path). `dispose()`'s `cancelPendingApprovals()` only
   * settles approvals ALREADY registered in `pendingApprovals`; a
   * `handlePermission` still suspended on `buildPresentEffectSignals`'s
   * async path canonicalization at dispose time has nothing there yet to
   * cancel. This flag lets it re-validate liveness once that await
   * resolves and short-circuit fail-closed instead of registering a fresh
   * (now orphaned) approval into a dead controller.
   */
  private disposed = false;

  /** W2 F-S (§2e/§3.2): the session-scoped `available_commands` cache. */
  private lastCommands: SlashCommandInfo[] | undefined;

  constructor(
    sessionId: string,
    cwd: string,
    private readonly port: SessionHostPort,
    /**
     * W4-T5a deliverable 1: the tab this controller was minted for — plain
     * readonly DATA (keeps the controller headless; no vscode concept leaks in).
     * Needed so the router can target a per-tab "session lost" affordance on
     * respawn recovery, and so `loadSessionIntoTab`'s P3 guard can ask
     * "does THIS TAB'S controller have a live turn" instead of reading the
     * connection's ambient `activeSessionId` (§7 F6/B6). Defaults to
     * `BOOTSTRAP_TAB_ID` so every pre-T5a call site (tests included) that
     * never threaded a tabId keeps its existing single-tab behavior.
     */
    readonly tabId: string = BOOTSTRAP_TAB_ID,
  ) {
    this.sessionId = sessionId;
    this.cwd = cwd;
  }

  /** True while a live PROMPT turn is running (never true during a replay) — the P2/P3 interlock predicate. */
  hasLiveTurn(): boolean {
    return this.liveTurnId !== undefined;
  }

  getPreset(): EditPolicyPreset {
    return this.activePreset;
  }

  getAvailableCommands(): SlashCommandInfo[] | undefined {
    return this.lastCommands;
  }

  /** W4-T2 (§2d panel.data scope key): this session's workspace-root id — the coordinator's own canonical registry key. */
  getRootId(): string {
    return this.port.root.rootId;
  }

  /**
   * A read-only snapshot of this session's live subagents fold — exposed
   * (rather than the mutable `SubagentAccumulator` instance itself) so
   * `AcpBackend`'s `PanelSourceContext` can reach the active controller's
   * fold through a pure accessor (mirrors `getAcpClient`/`getCwd`'s own
   * posture) without leaking a mutable internal object across the boundary.
   */
  getSubagentsSnapshot(): SubagentsData {
    return this.subagents.snapshot();
  }

  /**
   * W2-F1 wire-pin (mode-coordination §4.1–4.2): keep Hermes's ACP
   * edit-approval mode at `'default'` for THIS session. Moved off
   * `AcpBackend.pinWireModeDefault` — F4 (the pin is per-controller now).
   *
   * CF-01/I-2 (W1-T3): this is the ONE place both call sites reach —
   * `loadReplay` (~:1123) and `AcpBackend.openSession` (~:754) — so
   * catching `setSessionMode`'s rejection HERE closes both by construction,
   * with no duplicated try/catch at either await. Before this fix, a
   * rejection propagated out of `loadReplay` (falsifying its documented
   * "never rejects" contract — the webview's already-emitted `clear`/
   * `turn.start` pair would never get a closing `turn.end`) and out of
   * `openSession` (which `establishInitialSession`'s try/catch does stop
   * from crashing `start()`, but only by DISHONESTLY reporting the whole
   * session establish as failed — `system.error` — even though `tab.bound`/
   * `mode.state` already fired for a session that is actually live and
   * usable).
   *
   * Degrade, don't reject: log status-only (never the raw error body beyond
   * `Error.message` — matches every other degrade site in this file, e.g.
   * {@link snapshotCheckpoint}/{@link snapshotAfterTurn}) and return without
   * claiming the pin succeeded.
   *
   * CF-01 (W1-T3 3-lens review — CRITICAL fix): the FIRST version of this
   * degrade left `this.currentMode` untouched on failure and called
   * `runTurn`'s re-pin check "the fail-CLOSED backstop". That claim was
   * false: `currentMode` is written `'default'` EVERYWHERE ELSE in this file
   * (init, this method's own success tail below, `runTurn`'s own re-pin
   * success) — so "left untouched" meant it silently STAYED `'default'` even
   * though the session is still non-default server-side, and `runTurn`'s
   * `!== 'default'` check (~:894) could then NEVER fire. That "backstop" was
   * unreachable dead code, not a safeguard — a drifted `accept_edits`
   * session could take a prompt with Hermes auto-applying edits (no
   * `request_permission`), our whole out-of-process approval gate silently
   * bypassed for the session's entire life.
   *
   * Fixed: the catch below now SEEDS `this.currentMode` with the raw
   * drifted `reportedModeId` Hermes actually reported (this is why the
   * field's type widened from `AgentMode` to `string` — see its own doc).
   * That makes `runTurn`'s check a REAL backstop: it forces a genuine re-pin
   * attempt on the session's next turn; if THAT re-pin also fails,
   * `runTurn`'s own try/catch (~:943) aborts the turn with an honest
   * `error` — `client.prompt` is never reached. A degraded pin can
   * therefore delay a prompt (one failed-then-retried re-pin) or abort it
   * outright — it can never let one through silently un-pinned.
   */
  async pinWireModeDefault(reportedModeId: string): Promise<void> {
    const client = this.port.getClient();
    if (reportedModeId !== 'default' && client) {
      this.port.logger?.append(
        `[SessionController] wire-mode drift: session reported '${reportedModeId}', re-asserting 'default'`,
      );
      try {
        await client.setSessionMode(this.sessionId, 'default');
      } catch (err) {
        this.port.logger?.append(
          `[SessionController] wire-mode re-assert failed — degrading (session still reports '${reportedModeId}' server-side; seeding currentMode so the NEXT turn's re-pin is a real backstop, not dead code): ${errorMessage(err)}`,
        );
        // CF-01: seed the drift itself — NEVER force-set to 'default' here,
        // which would dishonestly claim a pin that just failed. See this
        // method's own doc above for why this is what makes `runTurn`'s
        // re-pin check reachable at all.
        this.currentMode = reportedModeId;
        return;
      }
    }
    this.currentMode = 'default';
  }

  // --- sendPrompt / cancel -------------------------------------------------

  /**
   * Moved off `AcpBackend.sendPrompt`. W4-T2 (§3.2/F1): the one-shot's
   * connection-level `oneShotInFlight` flag is GONE — a same-root one-shot
   * now holds THIS SAME root lease under its own synthetic holder id, so
   * the lease-acquire below refuses a `sendPrompt` while a one-shot is
   * in flight for free (no separate check needed at the router).
   */
  sendPrompt(text: string, mode: AgentMode, attachments?: Attachment[], mentions?: ContextRef[]): void {
    const client = this.port.getClient();
    if (!client) {
      this.port.emitSystemError('The agent session is not started yet.');
      return;
    }

    if (this.liveTurnId) {
      // V-18 (Tier-2 remediation architecture §2.2): the ONE narrow exception
      // to the refusal below — a text-only `/steer` or `/queue` typed while
      // THIS session's own turn is live is admitted as a same-session
      // control utterance instead of being refused. Every other mid-turn
      // prompt (including a non-command `/steer` typo, an attachment-bearing
      // one, or a DIFFERENT session's prompt) falls through to the existing
      // refusal, byte-identical.
      if (isMidTurnControlUtterance(text, attachments, mentions)) {
        void this.runControlUtterance(text);
        return;
      }
      this.port.logger?.append(
        `[SessionController] sendPrompt refused — turn '${this.liveTurnId}' is still running (Hermes queues, it does not supersede)`,
      );
      this.port.emit({
        type: 'error',
        sessionId: this.sessionId,
        message: 'A turn is already running. Stop it before sending a new message.',
      });
      return;
    }

    // W4-T2 (§3.2): the root turn lease — ONE live turn per workspace root.
    // Synchronous, before any await (mirrors the `liveTurnId` admission
    // discipline above) — refuses (never queues) when a DIFFERENT session
    // (another tab's turn, or an in-flight ephemeral one-shot, F1) already
    // holds this root's lease. A re-entrant acquire by THIS session is
    // idempotent-true, so the `liveTurnId` check above is what actually
    // guards same-session re-entrancy; this guards cross-session/one-shot
    // contention.
    if (!this.port.root.tryAcquireTurnLease(this.sessionId)) {
      this.port.logger?.append(
        '[SessionController] sendPrompt refused — another session (or an in-flight one-shot) holds this root\'s turn lease',
      );
      this.port.emit({
        type: 'error',
        sessionId: this.sessionId,
        message: 'A turn is already running in this workspace. Stop it before sending a new message.',
      });
      return;
    }

    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.currentTurnId = turnId;
    this.liveTurnId = turnId;
    // §2c decoupling: the root-scoped checkpoint ordinal, minted ONCE at
    // admission and shared by the before- AND after-snapshot of this turn.
    const turnOrdinal = this.port.root.nextTurnOrdinal();
    this.currentTurnOrdinal = turnOrdinal;
    this.turn = new TurnTranslator(turnId, this.sessionId);
    this.turnStartedAt = Date.now();

    this.port.emit({ type: 'turn.start', turnId, sessionId: this.sessionId });
    this.port.emit({ type: 'user', turnId, sessionId: this.sessionId, text, mode });

    void this.runTurnWithCheckpoint(turnId, turnOrdinal, text, mode, attachments, mentions);
  }

  /**
   * V-18 (Tier-2 remediation architecture §2.2): the whole mid-turn
   * `/steer`/`/queue` exception. Admitted ONLY from the `isMidTurnControlUtterance`
   * gate in `sendPrompt` above. Touches NO turn bookkeeping — not
   * `liveTurnId`, not `currentTurnId`, not `this.turn`, no lease
   * acquire/release, no ordinal, no checkpoint snapshot, no `turn.start`, no
   * `result.summary`, no `emitTurnEnd`. The harness's own ack ("⏩ Steer
   * queued for the active turn: …" / "Queued for the next turn…",
   * `server.py:1962-1988`) arrives as an ordinary `agent_message_chunk` on
   * the SAME session stream and folds through the live turn's normal
   * grammar (`applyUpdate` → `this.turn.applyUpdate`) — nothing here
   * renders it; it is genuinely indistinguishable from any other agent text
   * mid-turn (accepted, see the architecture doc's cosmetic-append caveat).
   *
   * Race residual (fork F-4, ACCEPTED, documented): between the admission
   * check in `sendPrompt` and the harness actually receiving this utterance,
   * the live turn can end — the harness then treats `/steer` as idle
   * (salvage/rewrite runs a FULL turn *inside this same request*,
   * `server.py:1329-1354`). Re-reading `this.liveTurnId` here (same tick,
   * free — the `turnId` capture below) is the only client-side mitigation
   * available; no atomic check-and-send exists over this wire. Bounded: the
   * rogue turn's events still render (attributed to the previous turnId —
   * visible, not silent, since `this.turn` is never cleared at
   * `emitTurnEnd`), approvals still gate edits (`handlePermission` is
   * session-scoped and turn-agnostic), and an idle composer's next prompt
   * still takes the normal path (the harness queues it honestly).
   */
  private async runControlUtterance(text: string): Promise<void> {
    // Defensive re-read: `sendPrompt`'s admission check and this read are
    // separated by zero awaits, so `liveTurnId` cannot change here — this
    // guards nothing OBSERVABLE (the genuine F-4 race is harness-side, one
    // wire flight, unobservable to the client). It's kept as honest narrowing
    // that stays correct if a future edit ever inserts an await above.
    const turnId = this.liveTurnId;
    if (turnId === undefined) return; // defensive — see the F-4 doc above

    // The same admission-echo grammar `sendPrompt` itself uses just above
    // (`{type:'user', turnId, sessionId, text, mode}`) — `mode` is hardcoded
    // 'default' here (not a caller-supplied argument): a control utterance
    // always rides the session's pinned wire mode, exactly like
    // `ReplayTranslator`'s own historical `user` emit. The webview's
    // exact-match draft-clear guard (`transcript.ts`'s `user` fold) consumes
    // the typed `/steer …`/`/queue …` text from the composer — the correct
    // UX, since the utterance IS what the user just sent.
    this.port.emit({ type: 'user', turnId, sessionId: this.sessionId, text, mode: 'default' });

    const client = this.port.getClient();
    if (!client) {
      // Defensive-only: `sendPrompt` already refuses before reaching the
      // `liveTurnId` branch when no client exists, so this is unreachable
      // from that call site today — kept so this method stays correct on
      // its own if ever called from elsewhere.
      this.reportUndeliveredUtterance();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), UTTERANCE_DEADLINE_MS);
      // Never keeps the process alive — mirrors every other host-side timer
      // in this file that is not itself the reason the process should stay up.
      timer.unref?.();
    });

    try {
      // The SDK never rejects an in-flight request on stream close (the V-8
      // lesson, `acp.js:786-789`) — an unraced await would leak on crash, so
      // this always races the real ACP call against the wall-clock deadline.
      const outcome = await Promise.race([
        client.prompt(this.sessionId, [{ type: 'text', text }]).then(() => 'resolved' as const),
        deadline,
      ]);
      // On resolution: the `PromptResponse` is IGNORED entirely — its
      // `end_turn` is the utterance's own ack, not the session's live turn.
      if (outcome === 'timeout') this.reportUndeliveredUtterance();
    } catch {
      // `client.prompt` rejected — the same "may not have been delivered"
      // signal as a timeout; the live turn's OWN `client.prompt` (a separate
      // in-flight request) is completely unaffected either way.
      this.reportUndeliveredUtterance();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * V-18: the ONE session-scoped `error` a control utterance can ever emit —
   * on deadline OR rejection, NEVER via `client.cancel` (deliberately never
   * called from this path: `cancel` is session-scoped and would kill the
   * user's live turn, not just this utterance). BF-B liveness discipline: a
   * settlement landing after `dispose()` emits nothing into a dead controller.
   */
  private reportUndeliveredUtterance(): void {
    if (this.disposed) return;
    this.port.emit({
      type: 'error',
      sessionId: this.sessionId,
      message: 'The /steer or /queue command may not have been delivered — the agent did not acknowledge it.',
    });
  }

  private async runTurnWithCheckpoint(
    turnId: string,
    turnOrdinal: number,
    text: string,
    mode: AgentMode,
    attachments?: Attachment[],
    mentions?: ContextRef[],
  ): Promise<void> {
    const [, resolved] = await Promise.all([
      this.snapshotCheckpoint(turnOrdinal, text),
      this.port.resolveMentions(mentions),
    ]);

    if (this.currentTurnId !== turnId) return;
    if (this.cancelledTurnId === turnId) {
      this.emitTurnEnd(turnId, 'cancelled');
      return;
    }

    await this.runTurn(turnId, text, mode, attachments, resolved);
  }

  /**
   * Moved off `AcpBackend.cancel`. T-A0 (V-4 — "Stop looks dead"): the
   * harness genuinely blocks a tool-dispatch thread in
   * `future.result(timeout=60)` awaiting our permission response
   * (`permissions.py:139-157` / `edit_approval.py:318-331`); `session/cancel`
   * alone (`server.py:1215-1227`) only sets `cancel_event` + interrupts the
   * agent loop, which cannot unpark that thread — answering the pending
   * permission is the ONLY thing that frees it. `settlePendingApprovals`
   * therefore runs on BOTH exits: immediately after the `client.cancel()`
   * dispatch when a client exists, and BEFORE the early return when it
   * doesn't (a dead client must not strand a card either).
   */
  cancel(): void {
    this.cancelledTurnId = this.currentTurnId;
    const client = this.port.getClient();
    if (!client) {
      this.settlePendingApprovals('cancelled');
      return;
    }
    void client.cancel(this.sessionId).catch((err) => {
      this.port.logger?.append(`[SessionController] session/cancel failed: ${errorMessage(err)}`);
    });
    this.settlePendingApprovals('cancelled');
  }

  // --- approvals ------------------------------------------------------------

  /**
   * Moved off `AcpBackend.respondApproval`. T-A0 (M2/V-7 echo): clears the
   * M2-b expiry timer (a settled approval must never also fire its stale
   * deadline) and emits the authoritative `approval.settle{outcome:
   * 'selected'}` echo — today's ONLY record of a user response is the
   * webview's own optimistic dispatch (`useHostActions.ts`); this is the
   * host-side confirmation ARCH-1's "authoritative terminal push" rule
   * requires for every other item kind.
   */
  respondApproval(id: string, optionId: string): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      this.port.logger?.append(`[SessionController] respondApproval: no pending approval '${id}'`);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(id);
    if (pending.toolId) {
      this.hunkState.delete(pending.toolId);
      this.toolIdToApprovalId.delete(pending.toolId);
      this.port.editPreviewRegistry?.delete(this.sessionId, pending.toolId);
    }
    pending.resolve(buildSelectedOutcome(optionId));
    this.port.emit({
      type: 'approval.settle',
      sessionId: this.sessionId,
      turnId: pending.turnId,
      id,
      toolId: pending.toolId,
      outcome: 'selected',
      optionId,
    });
  }

  /** Moved verbatim off `AcpBackend.resolveDiff`. */
  resolveDiff(toolId: string, hunkIndex: number, action: DiffAction): void {
    const approvalId = this.toolIdToApprovalId.get(toolId);
    const hunks = approvalId ? this.hunkState.get(toolId) : undefined;
    const pending = approvalId ? this.pendingApprovals.get(approvalId) : undefined;
    if (!approvalId || !hunks || !pending) {
      this.port.logger?.append(`[SessionController] resolveDiff: no pending edit-approval for tool '${toolId}'`);
      return;
    }

    if (action === 'reject') {
      this.finishApproval(approvalId, findOptionId(pending.options, 'deny') ?? 'deny');
      this.hunkState.delete(toolId);
      this.toolIdToApprovalId.delete(toolId);
      return;
    }

    hunks.decisions.set(hunkIndex, action);
    if (hunks.decisions.size >= hunks.totalHunks) {
      this.finishApproval(approvalId, findOptionId(pending.options, 'allow_once') ?? 'allow_once');
      this.hunkState.delete(toolId);
      this.toolIdToApprovalId.delete(toolId);
    }
  }

  /** Moved verbatim off `AcpBackend.acceptWholeFileDiff`. */
  acceptWholeFileDiff(toolId: string): void {
    const total = this.hunkState.get(toolId)?.totalHunks ?? 0;
    for (let i = 0; i < total; i++) this.resolveDiff(toolId, i, 'accept');
  }

  /** T-A0 (M2/V-7 echo): same timer-clear + `approval.settle{outcome:'selected'}`
   *  echo as {@link respondApproval} — this is the diff-hunk-aggregation
   *  completion's OWN path to a selected outcome (whole-file accept/reject),
   *  which never goes through `respondApproval` itself. */
  private finishApproval(approvalId: string, optionId: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(approvalId);
    if (pending.toolId) this.port.editPreviewRegistry?.delete(this.sessionId, pending.toolId);
    pending.resolve(buildSelectedOutcome(optionId));
    this.port.emit({
      type: 'approval.settle',
      sessionId: this.sessionId,
      turnId: pending.turnId,
      id: approvalId,
      toolId: pending.toolId,
      outcome: 'selected',
      optionId,
    });
  }

  /**
   * T-A0 (M2 — the generalization of the former `cancelPendingApprovals`):
   * settles every pending approval (or, with `opts.onlyApprovalId`, exactly
   * ONE — the M2-b expiry deadline's own call shape, which must never touch
   * sibling pending approvals) with the ACP-spec-mandated `cancelled`
   * outcome (fail-closed for all three `reason`s — the harness maps any
   * non-`selected` outcome to deny, `permissions.py:95-104` /
   * `edit_approval.py:332-336`), clears its M2-b expiry timer, drops it from
   * every bookkeeping map, and — unless `opts.emit === false` (the
   * `dispose()` path, where the port's liveness is not guaranteed) — pushes
   * ONE authoritative `approval.settle{outcome: reason}` per settled
   * approval. Iterates a SNAPSHOT of the map's keys (`[...keys()]`) so
   * deleting entries mid-loop is safe.
   */
  private settlePendingApprovals(
    reason: 'cancelled' | 'expired' | 'superseded',
    opts?: { onlyApprovalId?: string; emit?: boolean },
  ): void {
    const emit = opts?.emit ?? true;
    const ids = opts?.onlyApprovalId !== undefined ? [opts.onlyApprovalId] : [...this.pendingApprovals.keys()];
    for (const approvalId of ids) {
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(approvalId);
      if (pending.toolId) {
        this.hunkState.delete(pending.toolId);
        this.toolIdToApprovalId.delete(pending.toolId);
        this.port.editPreviewRegistry?.delete(this.sessionId, pending.toolId);
      }
      pending.resolve(buildCancelledOutcome());
      if (emit) {
        this.port.emit({
          type: 'approval.settle',
          sessionId: this.sessionId,
          turnId: pending.turnId,
          id: approvalId,
          toolId: pending.toolId,
          outcome: reason,
        });
      }
    }
  }

  // --- setPreset / setModel --------------------------------------------------

  /** Moved verbatim off `AcpBackend.setPreset`. */
  setPreset(preset: EditPolicyPreset): void {
    if (preset === this.activePreset) return;
    const previous = this.activePreset;
    this.activePreset = preset;
    this.port.logger?.append(`[policy] preset changed: ${previous} -> ${preset}`);
    this.port.emit({ type: 'policy.state', sessionId: this.sessionId, preset });
  }

  /**
   * ARCH-1 (final review, UI I-1): every terminal transition of a switch
   * attempt — RPC resolve, RPC reject, or no live client at all — emits an
   * authoritative `model.state`; the webview's optimistic pick
   * (`useHostActions.setModel`'s `local.setModel`) is legal only because
   * this push always overwrites the same field afterward. `currentModelId`
   * (the H4-B8 hydrate seed) is assigned ONLY on RPC resolve, so a
   * recreated webview can never be seeded with a model the agent refused.
   * `!client` is itself a terminal transition (invariant #1: no silent
   * no-op on a user-initiated action) — it emits both the refusal and the
   * corrective snap-back synchronously, never a bare `return`.
   *
   * §1.6 seq token: `seq` is captured at entry and re-checked in both
   * settlement handlers so a superseded attempt's belated settlement can
   * never clobber a newer attempt's already-landed terminal push (moved
   * off `AcpBackend.setModel`, then reworked for ARCH-1).
   */
  setModel(id: string): void {
    const client = this.port.getClient();
    const previous = this.currentModelId ?? null;
    const seq = ++this.modelSwitchSeq;
    if (!client) {
      this.port.emit({
        type: 'error',
        sessionId: this.sessionId,
        message: 'Cannot switch model: the agent is not connected. Retrying the connection…',
      });
      this.port.emit({ type: 'model.state', sessionId: this.sessionId, modelId: previous });
      return;
    }
    void client.setSessionModel(this.sessionId, id).then(
      () => {
        if (seq !== this.modelSwitchSeq) return; // superseded — the newer attempt owns the terminal push
        this.currentModelId = id;
        this.port.emit({ type: 'model.state', sessionId: this.sessionId, modelId: id });
      },
      (err: unknown) => {
        if (seq !== this.modelSwitchSeq) return;
        this.port.emit({ type: 'error', sessionId: this.sessionId, message: `Failed to switch model: ${errorMessage(err)}` });
        this.port.emit({ type: 'model.state', sessionId: this.sessionId, modelId: previous });
      },
    );
  }

  /**
   * W4-T4b (SF-2 §4.3 mitigation 1): snapshot-on-activate. The router
   * (`AcpBackend.setCustomMode`) has ALREADY done the impure work (settings
   * read, config lookup, `buildModeFloorSnapshot`) — this method only
   * STORES the resulting plain data. `snapshot` is `undefined` exactly when
   * `modeId` is `null` (mode cleared), mirroring `setMode`'s clamp posture.
   * From this call until the next one, `buildPresentEffectSignals` reads
   * `this.activeCustomMode` at signal-build time (per permission request) —
   * a disk change to `talaria.customModes` in between does NOT reach here
   * (the router's `onDidChangeConfiguration` handler deliberately never
   * calls this method); the snapshot changes ONLY via an explicit re-pick.
   */
  setCustomMode(snapshot: ModeFloor | undefined, modeId: string | null): void {
    this.activeCustomMode = snapshot;
    this.activeCustomModeId = modeId;
    this.port.logger?.append(`[policy] custom mode set: ${modeId ?? 'none'}`);
  }

  // --- session/update stream ------------------------------------------------

  /**
   * Moved off `AcpBackend.handleSessionUpdate`'s BODY (the router does the
   * ephemeral-stream catch + registry lookup BEFORE calling this — §7
   * sync-1). Everything from the `available_commands_update` intercept
   * downward is unchanged.
   */
  applyUpdate(update: AcpSessionUpdate): void {
    if (update.sessionUpdate === 'available_commands_update') {
      this.lastCommands = mapAvailableCommands(update.availableCommands);
      this.port.emit({ type: 'commands.available', sessionId: this.sessionId, commands: this.lastCommands });
      return;
    }

    if (this.replay) {
      for (const message of this.replay.apply(update)) this.port.emit(message);
    } else {
      if (!this.turn) return;
      for (const message of this.turn.applyUpdate(update)) this.port.emit(message);
    }

    if (this.subagents.apply(update)) {
      this.port.emit(makePanelData('subagents', this.subagents.snapshot(), { sessionId: this.sessionId }));
    }
  }

  // --- permission dispatch --------------------------------------------------

  /**
   * Moved off `AcpBackend.handleRequestPermission`'s BODY (the router's
   * §3.1(a)-style dispatch mints `approvalId` and calls this — the
   * `approvalCounter` process-unique mint STAYS on `AcpBackend`, so it's
   * threaded in as a parameter rather than reached through the port).
   */
  async handlePermission(req: AcpRequestPermissionRequest, approvalId: string): Promise<AcpRequestPermissionResponse> {
    const turnId = this.currentTurnId ?? 'turn';
    let mapped: MappedPermissionRequest;

    try {
      mapped = mapPermissionRequest(req, turnId, approvalId);
      const options = mapped.approval.options;

      const evaluated = (await this.buildPresentEffectSignals(req.toolCall)).map((signal) => ({
        signal,
        decision: evaluateEditPolicy(this.activePreset, signal),
      }));
      // BF-B: re-validate liveness right after the suspension point — a
      // dispose() that landed WHILE `buildPresentEffectSignals` was awaiting
      // path canonicalization must short-circuit fail-closed here, BEFORE
      // any allow/deny/card decision, so nothing gets registered into (or
      // emitted from) a now-dead controller.
      if (this.disposed) return buildCancelledOutcome();
      const { signal, decision } = pickStrictest(evaluated);

      mapped = { ...mapped, approval: applyResolvedPresentation(mapped.approval, signal) };

      if (decision.outcome === 'allow') {
        const allowId = findAllowOptionId(options);
        this.auditPolicy(decision, signal, turnId, allowId ?? 'card');
        if (allowId) return buildSelectedOutcome(allowId);
      } else if (decision.outcome === 'deny') {
        const denyId = findOptionId(options, 'deny');
        this.auditPolicy(decision, signal, turnId, denyId ?? 'cancelled');
        return denyId ? buildSelectedOutcome(denyId) : buildCancelledOutcome();
      } else {
        this.auditPolicy(decision, signal, turnId, 'card');
      }
    } catch (err) {
      this.port.logger?.append(
        `[policy] interception error — falling back to the ask card (fail-closed): ${errorMessage(err)}`,
      );
      mapped = { approval: buildMinimalAskApproval(req, turnId, approvalId), diffs: [], rawInput: undefined };
    }

    return this.emitApprovalCard(req, mapped, approvalId);
  }

  private async buildPresentEffectSignals(toolCall: AcpToolCallFields): Promise<PolicySignal[]> {
    const signals: PolicySignal[] = [];

    const rawPaths = extractEditPathStrings(toolCall);
    if (rawPaths.length > 0) {
      const resolved = await this.canonicalizeToolCallPaths(rawPaths);
      signals.push(buildEditSignalFromResolved(resolved, this.currentTurnProtected, this.activeCustomMode));
    }

    const commandSignal = buildCommandSignal(toolCall);
    const hasExplicitCommand = typeof toolCall.rawInput?.command === 'string' && commandSignal.command.length > 0;
    if (hasExplicitCommand) signals.push(commandSignal);

    if (signals.length === 0) {
      // W4-T4b: the empty-signal path MUST also carry the snapshot — this is
      // the exact path the F1 allowOnly carve-out (`editPolicy.ts`) defends:
      // an allowOnly mode denies an unresolvable-path edit (positive-proof
      // required), where a deny-only mode falls through to the ordinary ask.
      signals.push(
        toolCall.kind === 'edit'
          ? buildEditSignalFromResolved([], this.currentTurnProtected, this.activeCustomMode)
          : commandSignal,
      );
    }
    return signals;
  }

  private async canonicalizeToolCallPaths(rawPaths: readonly string[]): Promise<CanonicalEditPath[]> {
    const roots = this.port.workspaceRoots();
    const base = this.cwd || roots[0] || '/';
    const home = homedir();
    return Promise.all(rawPaths.map((raw) => canonicalizeEditPath(raw, base, roots, home)));
  }

  private auditPolicy(decision: PolicyDecision, signal: PolicySignal, turnId: string, option: string): void {
    if (!this.port.logger) return;
    const tail = signal.kind === 'edit' ? `paths=${signal.paths.join(',')}` : `cmd="${signal.command}"`;
    this.port.logger.append(
      `[policy] preset=${this.activePreset} kind=${signal.kind} outcome=${decision.outcome} rule=${decision.ruleId} option=${option} turn=${turnId} ${tail}`,
    );
  }

  private emitApprovalCard(
    req: AcpRequestPermissionRequest,
    mapped: MappedPermissionRequest,
    approvalId: string,
  ): Promise<AcpRequestPermissionResponse> {
    // BF-B belt-and-suspenders: the sole registration point into
    // `pendingApprovals` — guarded independently of the :466 re-check above
    // so ANY future caller of this method (not just today's one call site)
    // can never register a fresh approval into a disposed controller.
    if (this.disposed) return Promise.resolve(buildCancelledOutcome());

    const { approval, diffs } = mapped;
    const options = approval.options;

    return new Promise<AcpRequestPermissionResponse>((resolve) => {
      // T-A0 (M2-b): arm the host-side auto-deny deadline HERE, the sole
      // registration point into `pendingApprovals` — our timer starts at
      // receipt, i.e. always >= the harness's own deadline (which starts at
      // its post), so we never deny something the harness still awaits; a
      // late resolve is wire-harmless (the harness already `future.cancel()`ed
      // and returned deny — `permissions.py:153-157`, `edit_approval.py:327-331`).
      const timer = setTimeout(() => {
        this.settlePendingApprovals('expired', { onlyApprovalId: approvalId });
      }, approval.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(approvalId, {
        resolve,
        toolId: req.toolCall.toolCallId,
        options,
        turnId: approval.turnId,
        timer,
      });

      const totalHunks = diffs.reduce((sum, diff) => sum + diff.hunks.length, 0);
      if (totalHunks > 0) {
        this.hunkState.set(req.toolCall.toolCallId, { approvalId, totalHunks, decisions: new Map() });
        this.toolIdToApprovalId.set(req.toolCall.toolCallId, approvalId);
      }

      const previewFiles = extractPreviewFiles(req.toolCall.content);
      if (previewFiles.length > 0) {
        this.port.editPreviewRegistry?.set(this.sessionId, req.toolCall.toolCallId, approvalId, previewFiles);
      }

      this.port.emit(approval);
      for (const diff of diffs) this.port.emit(diff);
    });
  }

  // --- turn plumbing ----------------------------------------------------------

  private async runTurn(
    turnId: string,
    text: string,
    mode: AgentMode,
    attachments?: Attachment[],
    resolved?: ResolvedContext[],
  ): Promise<void> {
    const client = this.port.getClient();
    if (!client) return;

    try {
      if (mode !== 'default') {
        this.port.logger?.append(
          `[policy] clamped incoming prompt mode '${mode}' -> 'default' (preset '${this.activePreset}' active)`,
        );
      }
      // CF-01 (W1-T3 review): the REAL fail-closed backstop for a degraded
      // `pinWireModeDefault` — see that method's own doc for the mechanism.
      // A genuine re-pin attempt here; if it rejects, this whole `try`'s
      // catch (below) aborts the turn with an honest `error` — `client
      // .prompt` just below is never reached on an unconfirmed session.
      if (this.currentMode !== 'default') {
        await client.setSessionMode(this.sessionId, 'default');
        this.currentMode = 'default';
      }

      // V-19: confine every `Attachment.path` to the workspace before it can
      // reach `buildPromptContent`'s `pathToFileUri` — the SAME primitives
      // and ordering (confine FIRST, secret gate SECOND, on the CONFINED
      // canonical path) the mention path already gets (`context/resolver.ts`
      // `resolveFileOrFolder`). A dropped attachment is never sent; the
      // session-scoped error names only the COUNT, never the path/content.
      const { attachments: confinedAttachments, droppedCount } = await confineAttachmentPaths(
        attachments ?? [],
        this.port.workspaceRoots(),
      );
      if (droppedCount > 0) {
        this.port.emit({
          type: 'error',
          sessionId: this.sessionId,
          turnId,
          message: `${droppedCount} attachment${droppedCount === 1 ? '' : 's'} dropped (outside the workspace or secret-classified)`,
        });
      }

      const promptText = this.activePreset === 'plan' ? PLAN_PREAMBLE + text : text;
      const content: AcpOutboundContentBlock[] = [
        ...buildPromptContent(promptText, confinedAttachments),
        ...mentionBlocks(resolved ?? []),
      ];
      const response = await client.prompt(this.sessionId, content);

      if (this.currentTurnId !== turnId || !this.turn) return;

      for (const message of this.turn.finish()) this.port.emit(message);

      const usage = mapUsage(response.usage);
      const status = mapStopReasonToStatus(response.stopReason);
      this.port.emit({
        type: 'result.summary',
        turnId,
        sessionId: this.sessionId,
        // ARCH-1 (T1): the wire now REQUIRES status — pass the same value
        // `emitTurnEnd` below carries, computed once above. T4 owns the
        // UI-facing tone-mapped render this unlocks (ResultSummary.tsx).
        status,
        text: this.turn.settledText || undefined,
        usage: usage ? { ...usage, durationMs: Date.now() - this.turnStartedAt } : undefined,
      });
      this.emitTurnEnd(turnId, status);
    } catch (err) {
      if (this.currentTurnId !== turnId) return;
      this.port.emit({ type: 'error', sessionId: this.sessionId, message: errorMessage(err), turnId });
      this.emitTurnEnd(turnId, 'error');
    }
  }

  private emitTurnEnd(turnId: string, status: 'complete' | 'cancelled' | 'error'): void {
    // T-A0 (V-5-host backstop): FIRST act — a turn ending means nothing is
    // running in this session (one live turn per session), so any approval
    // still open when it ends is abandoned exactly like the anomalous-turn-end
    // items ARCH-1 already settles (messages/reasoning/subagents/summary).
    // A clean `'complete'` end still needs a settle: the turn genuinely
    // finished without the pending card ever being answered (e.g. Hermes
    // moved on) — 'superseded' names that non-adversarial closure, distinct
    // from the 'cancelled' reason every OTHER end status carries.
    this.settlePendingApprovals(status === 'complete' ? 'superseded' : 'cancelled');
    if (this.liveTurnId === turnId) {
      this.liveTurnId = undefined;
      this.port.root.releaseTurnLease(this.sessionId);
    }
    this.port.emit({ type: 'turn.end', turnId, sessionId: this.sessionId, status });
    if (status !== 'complete') this.markSubagentsInterrupted();
    this.snapshotAfterTurn(turnId);
  }

  /**
   * W2-F2 Phase 0: the AFTER-turn snapshot, moved off
   * `AcpBackend.snapshotAfterTurn`. W4-T2 (§2c decoupling): reads the
   * root-scoped `currentTurnOrdinal` field (minted at `sendPrompt`
   * admission) instead of parsing it back out of `turnId` —
   * `turnOrdinalFromTurnId` is DELETED (two sessions' `turn-1` would
   * otherwise both wrongly claim ordinal 1 under root-scoped ordinals).
   *
   * W4-T2 Deliverable 6 (Obs): passes an EXPLICIT, non-numeric label
   * (`AFTER_TURN_LABEL`) rather than `undefined` — the tracker's OWN
   * numeric fallback ("After turn N", `CheckpointTracker.ts`, frozen/
   * unchanged) would otherwise show a ROOT-scoped ordinal that matches no
   * tab's own turn count once two sessions share a root.
   */
  private snapshotAfterTurn(turnId: string): void {
    const tracker = this.port.root.tracker;
    if (!tracker) return;
    const ordinal = this.currentTurnOrdinal;
    if (ordinal === undefined) return; // defensive: no admitted turn ordinal for this turn
    void tracker
      .snapshot(ordinal, AFTER_TURN_LABEL, { phase: 'after', sessionLabel: this.sessionLabelTag() })
      .then(() => this.port.refreshCheckpointsPanel())
      .catch((err: unknown) => {
        this.port.logger?.append(
          `[SessionController] after-turn checkpoint failed — ${turnId} (ordinal ${ordinal})'s edits stay uncaptured (undo may need force until the next snapshot): ${errorMessage(err)}`,
        );
      });
  }

  /**
   * Zone CKPT / C1: the pre-turn checkpoint BARRIER, moved off
   * `AcpBackend.snapshotCheckpoint`. Fail-open (never rejects) — see the
   * original method's doc for the full wall-clock-bounded rationale.
   */
  private async snapshotCheckpoint(turnOrdinal: number, promptText: string): Promise<void> {
    const tracker = this.port.root.tracker;
    if (!tracker) return;
    const label = truncateCheckpointLabel(promptText);
    try {
      await tracker.snapshot(turnOrdinal, label, { sessionLabel: this.sessionLabelTag() });
      if (turnOrdinal > 0) this.currentTurnProtected = true;
    } catch (err) {
      if (turnOrdinal > 0) this.currentTurnProtected = false;
      this.port.logger?.append(
        `[SessionController] checkpoint snapshot failed — turn ${turnOrdinal} proceeds WITHOUT a checkpoint (unprotected): ${errorMessage(err)}`,
      );
      return;
    }
    this.port.refreshCheckpointsPanel();
  }

  /**
   * W4-T5b (checkpoint-row session labels — DISPLAY-ONLY, R8): a short,
   * stable, human-readable tag identifying THIS session on a per-root
   * shared checkpoint timeline (checkpoints are per-ROOT, shared
   * across every same-root tab). Read fresh from `this.sessionId` at each
   * snapshot call site — i.e. captured AT SNAPSHOT TIME — and handed to
   * `tracker.snapshot(...)` as plain data; the tracker stores it verbatim on
   * the row it writes and NEVER re-reads it later. Because `sessionId` can
   * be reassigned in place (`loadReplay`, per this class's own T1a
   * mutability note), a later rotation never retroactively changes an
   * already-written row's label — exactly the R8 guarantee (session ids
   * rotate on auto-compaction, so they must never be treated as a live
   * pointer). No new cross-layer dependency: a short id, not a tab title, is
   * the "clean stable label" this controller can produce on its own.
   */
  private sessionLabelTag(): string {
    const id = this.sessionId;
    const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
    return `Session ${short}`;
  }

  private markSubagentsInterrupted(): void {
    if (this.subagents.markRunningInterrupted()) {
      this.port.emit(makePanelData('subagents', this.subagents.snapshot(), { sessionId: this.sessionId }));
    }
  }

  // --- session/load replay ----------------------------------------------------

  /**
   * The session-scoped body of a History-panel load, moved off
   * `AcpBackend.loadSession` — called by the router
   * (`AcpBackend.loadSessionIntoTab`) AFTER it has: verified a live client
   * exists, refused if the target already has a live turn, and confined
   * `cwd` to the workspace (all vscode-backed, so they stay at the router).
   *
   * Reassigns THIS controller's own `sessionId`/`cwd` in place (see the
   * class doc's T1a note) — `rawCwd` is the UNCONFINED value the ACP
   * `session/load` call itself uses (mirrors today's exact asymmetry:
   * `client.loadSession(cwd, ...)` used the raw param while internal state
   * adopted the confined `adoptedCwd`).
   */
  async loadReplay(
    rawCwd: string,
    sessionId: string,
    adoptedCwd: string,
    mcpServers: AcpMcpServer[],
  ): Promise<AcpLoadSessionResult | undefined> {
    const client = this.port.getClient();
    if (!client) return undefined;

    if (this.sessionId !== sessionId) this.lastCommands = undefined;
    this.sessionId = sessionId;
    this.cwd = adoptedCwd;

    // R-A2 seam close: the router's guard already refused while a turn was
    // live, so this is defensive-only (belt-and-braces), mirroring today's
    // own comment at the equivalent line in `AcpBackend.loadSession`.
    this.liveTurnId = undefined;
    // T-A0: a `session/load` replay supersedes whatever this controller was
    // doing before — any approval still open belongs to a card the webview
    // is about to have cleared out from under anyway (`clear` is emitted
    // right below), so 'superseded' (not 'cancelled') names it honestly.
    this.settlePendingApprovals('superseded');

    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.currentTurnId = turnId;
    this.turn = undefined;
    const replay = new ReplayTranslator(sessionId, turnId, () => {
      this.turnCounter += 1;
      return `turn-${this.turnCounter}`;
    });
    this.replay = replay;

    this.subagents.reset();
    this.subagents.setReplaying(true);

    this.port.emit({ type: 'clear', sessionId });
    this.port.emit({ type: 'turn.start', turnId, sessionId });

    let result: AcpLoadSessionResult;
    try {
      result = await client.loadSession(rawCwd, sessionId, mcpServers);
    } catch (err) {
      if (this.replay !== replay) return undefined;
      this.subagents.setReplaying(false);
      this.replay = undefined;
      this.port.emit({ type: 'error', sessionId, message: errorMessage(err), turnId: replay.currentTurnId });
      this.port.emit({ type: 'turn.end', turnId: replay.currentTurnId, sessionId, status: 'error' });
      this.markSubagentsInterrupted();
      return undefined;
    }

    // Audit A-3: `found: false` means Hermes had no session under this id
    // (`AcpLoadSessionResult`'s own doc — Hermes' `None` at
    // `acp_adapter/server.py:1141-1143`, turned into a look-alike-empty `{}`
    // by the SDK's `?? {}`). Treat it exactly like the request-rejection
    // branch above — never fall through and bind an empty transcript as if
    // the load actually succeeded. This is ALSO the crash-recovery path:
    // `ConnectionSupervisor.recoverOneSession` re-`session/load`s every
    // session that was live at crash time, and its existing `result ===
    // undefined` branch already turns this into that tab's
    // `tab.error{kind:'session-lost'}` terminal signal — reused verbatim,
    // no new protocol member needed. For a direct History-panel load (not
    // crash recovery) the `error` emitted here is the user-visible signal,
    // since that tab is already bound.
    if (!result.found) {
      if (this.replay !== replay) return undefined; // superseded while awaiting
      this.subagents.setReplaying(false);
      this.replay = undefined;
      this.port.emit({
        type: 'error',
        sessionId,
        message: 'That conversation no longer exists on the agent. Start a new chat.',
        turnId: replay.currentTurnId,
      });
      this.port.emit({ type: 'turn.end', turnId: replay.currentTurnId, sessionId, status: 'error' });
      this.markSubagentsInterrupted();
      return undefined;
    }

    if (this.replay !== replay) return result; // superseded while awaiting
    this.subagents.setReplaying(false);
    this.replay = undefined;
    for (const message of replay.finish()) this.port.emit(message);
    // A7: same capture as `AcpBackend.openSession` — a History-panel load or
    // crash-recovery replay restores the harness-bound model too, not just
    // the mode. Omitted (not a fabricated `null`) when the response carried
    // no `models` at all.
    if (result.currentModelId !== undefined) {
      this.currentModelId = result.currentModelId;
      this.port.emit({ type: 'model.state', sessionId, modelId: result.currentModelId });
    }
    await this.pinWireModeDefault(result.currentModeId);
    // I-2 (W1-T3 review, Important fix; re-review fix2 added `|| this.
    // disposed`): recheck for a superseding `loadReplay` AFTER this await —
    // the guard just above (~:1180) only covers the `client.loadSession`
    // await; `pinWireModeDefault` is a SEPARATE suspension point with no
    // recheck of its own before this fix. THIS call reset `this.replay` to
    // `undefined` two lines above; a non-undefined value at this point can
    // only mean a second, superseding `loadReplay` claimed it on the SAME
    // instance in the meantime (the synthetic case production never
    // creates). The REAL production supersede is `SessionRegistry.open`
    // minting a FRESH controller and DISPOSING this one — which also resets
    // `this.replay` to `undefined` (not to a new token), so the first half
    // alone is FALSE and blind to it; `dispose()` sets `this.disposed =
    // true`, which is what the second half catches. Either way, everything
    // past this point (subagents mutation, `commands.available`, the
    // closing `turn.end`) belongs to a turn that no longer exists from the
    // webview's perspective and must not fire.
    if (this.replay !== undefined || this.disposed) return;
    this.markSubagentsInterrupted();
    if (this.lastCommands) {
      this.port.emit({ type: 'commands.available', sessionId, commands: this.lastCommands });
    }
    this.port.emit({ type: 'turn.end', turnId: replay.currentTurnId, sessionId, status: 'complete' });
    return result;
  }

  // --- crash / dispose ----------------------------------------------------

  /**
   * T1a best-effort crash handling — moved off the per-session branch of
   * `AcpBackend.handleAcpCrash` (`:2416-2434` in the pre-extraction file).
   * The router iterates the registry and calls this on every controller
   * (T1b generalizes this into the full "one reconnecting signal / per-tab
   * session-lost" fan-out).
   */
  endOnCrash(): void {
    if (this.liveTurnId !== undefined) {
      const deadTurnId = this.liveTurnId;
      this.liveTurnId = undefined;
      this.currentTurnId = undefined;
      this.port.root.releaseTurnLease(this.sessionId);
      this.port.emit({ type: 'turn.end', turnId: deadTurnId, sessionId: this.sessionId, status: 'error' });
      this.markSubagentsInterrupted();
    } else if (this.replay !== undefined) {
      const deadReplayTurnId = this.replay.currentTurnId;
      this.subagents.setReplaying(false);
      this.replay = undefined;
      this.currentTurnId = undefined;
      this.port.emit({ type: 'turn.end', turnId: deadReplayTurnId, sessionId: this.sessionId, status: 'error' });
      this.markSubagentsInterrupted();
    }
  }

  /**
   * T-1 (V-12 RESTART-STATE): the explicit-restart counterpart of {@link
   * endOnCrash} — reuses that method's exact live-turn/replay arms
   * (release the root turn-lease, emit the closing `turn.end` bracket, mark
   * subagents interrupted) instead of inventing a second mechanism. The ONE
   * difference: the live-turn arm's `turn.end` carries `status:'cancelled'`,
   * not `'error'` — this end is USER-intended (an explicit restart / "New
   * Session"), never a failure. Called by `ConnectionSupervisor`'s restart
   * fan-out (`startInternal`, BEFORE `teardownSession()`) while this
   * controller is still registered and the port is live — the same
   * reasoning that lets `endOnCrash` emit safely.
   */
  endForRestart(): void {
    if (this.liveTurnId !== undefined) {
      const deadTurnId = this.liveTurnId;
      this.liveTurnId = undefined;
      this.currentTurnId = undefined;
      this.port.root.releaseTurnLease(this.sessionId);
      this.port.emit({ type: 'turn.end', turnId: deadTurnId, sessionId: this.sessionId, status: 'cancelled' });
      this.markSubagentsInterrupted();
    } else if (this.replay !== undefined) {
      const deadReplayTurnId = this.replay.currentTurnId;
      this.subagents.setReplaying(false);
      this.replay = undefined;
      this.currentTurnId = undefined;
      this.port.emit({ type: 'turn.end', turnId: deadReplayTurnId, sessionId: this.sessionId, status: 'error' });
      this.markSubagentsInterrupted();
    }
  }

  /**
   * F6 (data-safety / fail-closed): settles ONLY this controller's
   * approvals (cancelled outcome), best-effort `session/cancel`s ITS live
   * turn, releases ITS root turn-lease, and drops ITS subagents fold. The
   * CALLER (`SessionRegistry.close`/`disposeAll`) is responsible for
   * removing this controller from the registry map FIRST, synchronously,
   * BEFORE calling this — so a racing `request_permission` can never find a
   * mid-dispose controller.
   *
   * W4-T5b: also fires a BEST-EFFORT ACP `session/close` (P-W4-3 / Q-3:
   * server-side support is an open Fedora probe) — fire-and-forget, never
   * awaited, never throws/blocks dispose (the `?.` chain no-ops when the
   * client lacks `closeSession`; `AcpClient.closeSession` itself swallows
   * every rejection). Child + tracker + dashboard are disposed ONLY in
   * `AcpBackend.dispose()` — this method never touches them.
   *
   * W4-T5a: also invalidates an in-flight `loadReplay` (sets `this.replay =
   * undefined` with NO emit). `loadSessionIntoTab` now mints a FRESH
   * controller per load and disposes the tab's PRIOR one (F6) instead of
   * reusing one controller in place — so a prior controller's `session/load`
   * can still be awaiting `client.loadSession()` at the moment it is
   * disposed (a second, faster load into the SAME tab won the race). Without
   * this, that belated resolution would run `loadReplay`'s success/failure
   * tail on the DISPOSED controller and emit stale `clear`/`turn.start`-
   * bracketed messages via the shared `port.emit` — into a tab a fresh
   * controller has since taken over (the cross-controller generalization of
   * the existing single-controller P4b supersede guard, whose `this.replay
   * !== replay` check this reuses unmodified: clearing it here makes THAT
   * check trip on the disposed controller's belated continuation).
   */
  dispose(): void {
    this.disposed = true;
    const client = this.port.getClient();
    if (client && this.liveTurnId !== undefined) {
      void client.cancel(this.sessionId).catch((err) => {
        this.port.logger?.append(`[SessionController] dispose: session/cancel failed: ${errorMessage(err)}`);
      });
    }
    if (this.liveTurnId !== undefined) {
      this.port.root.releaseTurnLease(this.sessionId);
      this.liveTurnId = undefined;
    }
    // M1 (independent concurrency review, W4-T5a fix pass): symmetry with
    // `endOnCrash` — clear the turn bookkeeping too, not just
    // `liveTurnId`/`replay`. Not newly reachable today (the P3 live-turn
    // guard + `endOnCrash` already protect every current caller), but a
    // future direct `dispose()` of a live-turn controller would otherwise
    // leave `currentTurnId`/`turn` set, and a belated `runTurn` continuation
    // would only be stopped by ITS `if (this.currentTurnId !== turnId ||
    // !this.turn) return;` guard (:603) by ACCIDENT (a turnId mismatch),
    // not by design.
    this.currentTurnId = undefined;
    this.turn = undefined;
    this.replay = undefined;
    // T-A0 fork (2): dispose does NOT emit — promise settlement (still
    // 'cancelled', unchanged from today) must run so nothing is orphaned,
    // but the port's liveness is not guaranteed at teardown, and BF-B's
    // liveness guards forbid emitting from an already-disposed controller.
    this.settlePendingApprovals('cancelled', { emit: false });
    this.subagents.reset();
    this.subagents.setReplaying(false);
    // W4-T5b (P-W4-3 / Q-3): best-effort session/close — fire-and-forget,
    // swallowed unconditionally so a missing/failing close can never block
    // or reject dispose(). `client` was already captured above (undefined
    // is a safe no-op); `closeSession` itself is OPTIONAL on `AcpClientLike`.
    void client?.closeSession?.(this.sessionId).catch(() => {});
  }
}

// --- module-local types + helpers --------------------------------------------

interface PendingApproval {
  resolve: (response: AcpRequestPermissionResponse) => void;
  toolId?: string;
  options: ApprovalOption[];
  /**
   * T-A0 (M2/M2-b): the turn this approval was registered under (the mapped
   * `approval.request.turnId` at registration time) — carried so a settle
   * emitted from a DIFFERENT call site (cancel/turn-end/expiry, none of
   * which re-derive "which turn was this approval for") still stamps the
   * `approval.settle.turnId` the webview needs to fold it correctly.
   */
  turnId: string;
  /** T-A0 (M2-b): the host-side 60s (or wire-supplied) auto-deny deadline,
   *  cleared on every settle path so an already-settled approval can never
   *  leak a second, late `approval.settle`. */
  timer: ReturnType<typeof setTimeout>;
}

interface HunkAggregationState {
  approvalId: string;
  totalHunks: number;
  decisions: Map<number, DiffAction>;
}

/**
 * V-18 (Tier-2 remediation architecture §2.2): mirrors the harness's own
 * `/steer`/`/queue` recognition EXACTLY (`acp_adapter/server.py:1727-1734` —
 * `text.split(maxsplit=1)`, `cmd = parts[0].lstrip('/').lower()`) so the
 * client only ever admits a mid-turn utterance the harness itself would
 * actually treat as one — never a wider allow path. Requires ALL of:
 *  - text-only (no attachments, no mentions — mirrors the wire's own
 *    `text_only_prompt` guard, `server.py:1360`);
 *  - `text.trim()` starts with `/`;
 *  - the first whitespace-delimited token, with every leading `/` stripped
 *    and lowercased, is exactly `steer` or `queue`.
 * Tolerates `//steer`, mixed case, and any whitespace separator (tab
 * included) between the command and its argument — same as Python's
 * `str.split()` with no separator argument. An unknown command (e.g.
 * `/steermore`, no separator at all) or an attachment-bearing prompt is NOT
 * a control utterance and falls through to the existing refusal.
 */
function isMidTurnControlUtterance(text: string, attachments?: Attachment[], mentions?: ContextRef[]): boolean {
  if (attachments && attachments.length > 0) return false;
  if (mentions && mentions.length > 0) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const firstToken = trimmed.split(/\s+/, 1)[0] ?? '';
  const cmd = firstToken.replace(/^\/+/, '').toLowerCase();
  return cmd === 'steer' || cmd === 'queue';
}

/**
 * V-18: the wall-clock deadline `runControlUtterance` races `client.prompt`
 * against (unref'd — never keeps the process alive) — and NEVER wired to
 * `client.cancel`, since `cancel` is session-scoped and would kill the
 * user's own live turn, not just this utterance.
 */
const UTTERANCE_DEADLINE_MS = 15_000;

/**
 * W2-F1 Plan preamble (C3, pinned VERBATIM — moved off `AcpBackend`):
 * prepended to the prompt text under the Plan preset so Hermes plans via its
 * `todo` tool and does not attempt edits. See `wave-2-mode-coordination-howto.md §3.4`.
 */
const PLAN_PREAMBLE =
  '[PLAN MODE] Plan only. Produce a step-by-step plan using the todo tool. Do NOT call write_file or patch; do not modify any files. Wait for user approval before implementing.\n\n';

/**
 * W4-T2 Deliverable 6 (Obs): under root-scoped ordinals, the tracker's own
 * numeric fallback label ("After turn N") no longer corresponds to any
 * tab's own turn count once two sessions share a root — an explicit,
 * non-numeric label sidesteps the misleading number without touching the
 * (frozen) tracker itself. The full checkpoint-row `sessionLabel` UX is
 * T3/T5's job; this is only "don't emit a misleading 'turn N'".
 */
const AFTER_TURN_LABEL = 'After turn';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findOptionId(options: ApprovalOption[], kind: ApprovalOption['kind']): string | undefined {
  return options.find((option) => option.kind === kind)?.id;
}

interface EvaluatedEffect {
  signal: PolicySignal;
  decision: PolicyDecision;
}

const OUTCOME_SEVERITY: Record<PolicyDecision['outcome'], number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** Bucket 1 F2: of all evaluated effects, act on the STRICTEST outcome — moved off `AcpBackend`. */
function pickStrictest(evaluated: EvaluatedEffect[]): EvaluatedEffect {
  const first = evaluated[0];
  if (first === undefined) throw new Error('pickStrictest: no effects were evaluated');
  return evaluated.reduce((strictest, candidate) =>
    OUTCOME_SEVERITY[candidate.decision.outcome] > OUTCOME_SEVERITY[strictest.decision.outcome]
      ? candidate
      : strictest,
  first);
}

function findAllowOptionId(options: ApprovalOption[]): string | undefined {
  return findOptionId(options, 'allow_once');
}

/** Max length of a checkpoint label before truncation (Zone CKPT — moved off `AcpBackend`). */
const CHECKPOINT_LABEL_MAX_LEN = 80;

function truncateCheckpointLabel(promptText: string): string {
  const collapsed = promptText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CHECKPOINT_LABEL_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, CHECKPOINT_LABEL_MAX_LEN - 1).trimEnd()}…`;
}
