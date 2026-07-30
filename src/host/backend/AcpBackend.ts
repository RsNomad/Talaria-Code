import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type {
  HostToWebviewMessage,
  AgentMode,
  Attachment,
  ContextRef,
  DiffAction,
  DataPanel,
  EditPolicyPreset,
  HydrateTabSeed,
  SlashCommandInfo,
} from '../../shared/protocol';
import { BOOTSTRAP_TAB_ID } from '../../shared/protocol';
import type { CheckpointTrackerLike } from '../checkpoints/trackerContract';
import type { RootCoordinator } from '../checkpoints/RootCoordinator';
import { RootRegistry } from '../checkpoints/rootRegistry';
import type { Logger } from '../transport/JsonRpcStdio';
import type { ResolvedContext } from '../context/types';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import { ControlChannel } from '../control/ControlChannel';
import { createDefaultPanelSources } from '../panels/PanelSourceRegistry';
import type {
  PanelSource,
  PanelSourceContext,
  PanelSourceRegistry,
} from '../panels/PanelSourceRegistry';
import type { DashboardService } from '../dashboard/HermesDashboardManager';
import {
  DashboardSkillsPanelSource,
  DashboardToolsPanelSource,
} from '../dashboard/dashboardPanelSources';
import { AgentBackend } from './AgentBackend';
import { AcpClient } from './acp/acpClient';
import type {
  AcpClientFactory,
  AcpLoadSessionResult,
  AcpMcpServer,
} from './acp/acpClient';
import { resolveWithinWorkspace, resolveWithinWorkspaceReal } from './acp/pathConfine';
import { makeProcFdReader, type ConfinedReader, type ConfinedReadDenial } from './acp/confinedOpen';
import {
  buildCancelledOutcome,
} from './acp/permission';
import type {
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionUpdate,
} from './acp/types';
import type { OneShotResult } from '../scm/utilityModel';
import { SessionController } from './session/SessionController';
import { SessionRegistry } from './session/SessionRegistry';
import type { SessionHostPort } from './session/types';
import type { EditPreviewRegistry } from '../preview/EditPreviewRegistry';
import { readCustomModes, toCatalog } from './customModes';
import { OneShotRunner, type OneShotHostPort } from './oneshot/OneShotRunner';
import { ConnectionSupervisor, type ConnectionSupervisorHostPort } from './connection/ConnectionSupervisor';
import { ControlDispatcher, type ControlDispatcherHostPort } from './control/ControlDispatcher';

/**
 * The REAL backend. Implements the exact same {@link AgentBackend} interface
 * as {@link MockBackend}, so swapping it in is a one-line change in
 * `extension.ts`.
 *
 * ## Topology (spec §1, §3)
 * ```
 * AcpBackend
 *  ├── ACP channel     → child `hermes acp`                    (conversation, via acp/acpClient.ts)
 *  └── ControlChannel  → child `python -m tui_gateway.entry`   (control plane)
 * ```
 * Both children are spawned through {@link resolveHermes} (login-shell PATH,
 * sibling venv python).
 *
 * ## W4-T1a/T2 shape (§2c/§3.2) — connection owner + router
 * `AcpBackend` now RETAINS only connection/global state (`client`,
 * `clientExitSub`, `inFlightStart`, `acpState`, respawn timer/attempts,
 * `control`, `dashboard`, the `mcpServers` map, `approvalCounter`, the
 * `SessionRegistry`, the `RootRegistry` (W4-T2: a real per-root
 * `Map<canonicalRoot, RootCoordinator>`, not a single-instance bridge), the
 * global half of `panelSources`). Every session-scoped concern (turn
 * lifecycle, policy inputs, the approval trio, the subagents fold, the
 * command cache) lives on a per-session {@link SessionController}, minted by
 * {@link openSession}/{@link loadSessionIntoTab} and looked up by `sessionId`
 * for every session-targeting `AgentBackend` call — see each router method's
 * doc below for the exact routing-table row it implements.
 *
 * The one-shot utility-model surface ({@link oneShot}) is DELIBERATELY NOT
 * part of the SessionController extraction — it is connection-level (an
 * isolated, short-lived `session/new` outside any tab's lifecycle). W6-FI-a
 * (3-way ARCH I-4, part 1 of 3) moved its implementation + the `ephemeral`
 * registry into a dedicated {@link OneShotRunner} (behavior-preserving MOVE +
 * dependency injection); `AcpBackend` still owns and delegates to it —
 * `oneShot` itself, and the two ACP-callback lookup sites
 * ({@link handleSessionUpdate}/{@link handleRequestPermission}), are thin
 * passthroughs now.
 *
 * W6-FI-b (3-way ARCH I-4, part 2 of 3) — the connection LIFECYCLE subsystem
 * (spawn/connect/`acpState` machine/`inFlightStart` tail/crash+respawn/
 * per-session recovery) moved the SAME way into a dedicated {@link
 * ConnectionSupervisor} (behavior-preserving MOVE + DI — see its own doc for
 * the full "found-twice" concurrency-zone rationale). `AcpBackend` still owns
 * it and delegates: {@link start} is a thin passthrough; {@link openTab}
 * chains onto the SAME serialization tail via `connectionSupervisor
 * .runOnStartTail`; {@link dispose} calls its `markDisposed`/`teardownSession`
 * at the exact same two positions the original inline code occupied. `cwd`/
 * `activeSessionId` stay physically on `AcpBackend` (read/written broadly by
 * `openSession`/`loadSessionIntoTab`, which are NOT part of this extraction —
 * see the extraction report for the entanglement analysis); the supervisor
 * reaches them only through the narrow port accessors those two router
 * methods never touch.
 *
 * W6-FI-c (3-way ARCH I-4, part 3 of 3, FINAL) — the control-message
 * routing surface ({@link invokeControl} + `getPreset`/`getAvailableCommands`/
 * `listTabs`/`setCustomMode`/`loadTab` + the checkpoint-restore/
 * redo/panel-fetch/dashboard-toggle machinery) moved the SAME way into a
 * dedicated {@link ControlDispatcher} (behavior-preserving MOVE + DI — see
 * its own doc for the exact member list and what stayed behind). `AcpBackend`
 * still owns it and delegates: every moved public method is now a one-line
 * passthrough. `openSession`/`openTabInternal`/`loadSessionIntoTab` (the
 * C1/W6-FB session-minting + History-load choreography) and the six
 * `sendPrompt`/`cancel`/`respondApproval`/`resolveDiff`/`setModel`/`setPreset`
 * per-session routing-table passthroughs stay here — see {@link
 * ControlDispatcher}'s header doc for the full entanglement rationale.
 * This is the LAST of the three W6-FI extractions (finding I-4).
 */

// AH1: `CheckpointTrackerLike` moved to `../checkpoints/trackerContract` (a
// panels/ -> backend/ dependency edge shouldn't exist just to reach this
// type; its siblings `RestoreResult`/`CheckpointLockTimeoutError` already
// live under `checkpoints/`). Re-exported here for back-compat so no other
// importer breaks.
export type { CheckpointTrackerLike };

// S-M4 / A#2 / Sec-M1 / W4 §2d: the runtime control-method allowlist
// (`ALLOWED_CONTROL_METHODS`) and the `UNKNOWN_SESSION_ID` fallback sentinel
// moved onto `ControlDispatcher` (W6-FI-c, 3-way ARCH I-4 part 3 of 3) —
// both were private implementation details of `invokeControl`/
// `buildPanelDataMessage`, which moved with them. See `ControlDispatcher.ts`
// for the (unchanged) rationale.

/**
 * T2c (§2a): the minimal shape `AcpBackend` depends on to resolve
 * webview-supplied `@`-mentions — deliberately NOT the concrete `ContextResolver`
 * class (T2b). Injecting this narrow interface keeps this file free of the
 * `vscode`-backed ports/adapters and the real resolver CONSTRUCTION, both of
 * which are T2d's job (`extension.ts` wires the real `ContextResolver` in);
 * tests here inject a fake. Matches `ContextResolver.resolveAll`'s contract
 * exactly (`resolver.ts`: "NEVER throws") — but {@link AcpBackend.resolveMentionsSafe}
 * treats a violation of that contract as defense-in-depth, not a given.
 */
export interface MentionResolverLike {
  resolveAll(refs: ContextRef[]): Promise<ResolvedContext[]>;
}

/**
 * F1 (self-DoS hardening, Tier-2 remediation architecture §12.1, task T-13):
 * `handleReadTextFile` used to materialize the ENTIRE file into memory
 * (confined read, `toString('utf-8')`, then `split('\n')` over the whole
 * thing) before ever applying `limit` — a windowed read of a ~1.5 GB
 * workspace file could OOM the extension host on a single request. This
 * ceiling only engages on the confined (O_PATH, Linux/Fedora target) read
 * path, and only when a `limit` was actually requested (a `limit == null`
 * request genuinely wants the whole file — unchanged). 4 MiB mirrors this
 * codebase's existing byte-cap conventions for a single in-memory buffer
 * (`autocomplete/backends/http.ts`'s `MAX_STREAM_BYTES`,
 * `mcp/lsp/libServerHost.ts`'s `DEFAULT_MAX_BODY_BYTES`) — comfortably
 * larger than any normal source file (so normal files read byte-identically
 * to before), yet a fixed, bounded ceiling regardless of how large the file
 * on disk actually is.
 */
const MAX_WINDOWED_READ_BYTES = 4 * 1024 * 1024;

export class AcpBackend implements AgentBackend {
  /** D2 (A2): this is the real backend — see `AgentBackend.kind`'s doc. */
  readonly kind = 'acp' as const;

  private readonly emitter = new vscode.EventEmitter<HostToWebviewMessage>();
  readonly onMessage = this.emitter.event;

  private readonly control: ControlChannel;

  /**
   * W4 §2d: "the most recently opened/loaded session" bookkeeping —
   * `openSession`/`recoverOneSession`/`loadSessionIntoTab`'s occupant
   * convergence (the C1/W6-FB same-tab and same-session concurrency fixes
   * both key off this field's writes) and `loadSessionIntoTab`'s reuse-cwd
   * default.
   *
   * W6-FG (3-way ARCH I-2 — ambient-state-elimination): this field's WRITE
   * sites (C1/W6-FB bookkeeping) are UNCHANGED and load-bearing — do not
   * touch them. What changed is its READ side as a ROUTING/MUTATION input:
   * the `buildPanelDataMessage` scope-key fallbacks no longer read it
   * (removed — every real caller supplies its own scope, Zone-4-verified).
   * (P7-N10: the W6-FG-era `setMode` fan-out that USED to be documented
   * here as reading this field for routing was itself YAGNI-deleted — it
   * never actually consumed this field as a routing input either, by
   * construction; see `ControlDispatcher`'s own P7-N10 doc note.)
   * The ONLY remaining reads are `getPreset()`/`getAvailableCommands()`
   * (via {@link activeController}) — a genuinely last-resort, DISPLAY-only
   * hydrate-seed with no session identity available at its call site
   * (`TalariaViewProvider.seedState`, itself pre-tab-bind); see
   * {@link activeController}'s own doc.
   *
   * W6-FI-b: stays physically HERE (not moved onto {@link ConnectionSupervisor})
   * — `openSession`/`loadSessionIntoTab` (both router methods, deliberately
   * NOT part of this extraction) read/write it directly, unchanged. The
   * supervisor's OWN two touch points (`recoverOneSession`'s conditional
   * adopt, `teardownSession`'s unconditional clear) reach it through the
   * narrow `getActiveSessionId`/`setActiveSessionId` port accessors instead.
   */
  private activeSessionId: string | undefined;

  /**
   * The resolved workspace cwd `start()`/`openSession` opened the ACTIVE
   * session against — reused as the default `cwd` filter for `session/list`
   * (Zone HIST) and re-derived by `loadSessionIntoTab`. T1a keeps this as a
   * connection-level field (T2's real per-root/per-session cwd model
   * replaces it) — see `SessionController.cwd` for the per-session copy the
   * moved policy/turn code actually reads.
   *
   * W6-FI-b: same posture as {@link activeSessionId} above — stays here
   * (`openSession`/`loadSessionIntoTab`/`openTabInternal`/
   * `warmCheckpointBaseline`/`buildPanelDataMessage`/the `OneShotHostPort`
   * accessor all read it directly, unchanged); {@link ConnectionSupervisor}
   * only ever WRITES it, through the injected `setCwd` port accessor.
   */
  private cwd: string | undefined;

  /**
   * The MCP servers to advertise on every `session/new`/`session/load`,
   * keyed by their wire `name` — an insertion-ordered `Map` (plain JS `Map`
   * iteration order IS insertion order; no extra structure needed). Today
   * holds the stdio `codebase_search` server (Zone RAG,
   * pinned contract, `undefined`/absent until
   * `extension.ts` calls {@link setMcpServer} — it owns the Workspace-Trust +
   * `shouldActivateRag` gate) and, once W3 T7 wires it, the http
   * `vscode_lsp` server (research doc §4.4). This class makes no trust
   * decision of its own for any entry — it only re-sends whatever it was
   * last handed.
   */
  private readonly mcpServers = new Map<string, AcpMcpServer>();

  /**
   * W6-FI-a (3-way ARCH I-4, part 1 of 3): the ephemeral one-shot subsystem
   * — `oneShot`'s mutual-exclusion/deadline/ephemeral-registry machinery,
   * EXTRACTED off this class (behavior-preserving MOVE + DI, see
   * {@link OneShotRunner}'s own doc). Constructed once, below, with this
   * connection's live-client/cwd accessors and root resolver injected — the
   * SAME dependencies the pre-extraction methods read directly off `this`.
   */
  private readonly oneShotRunner: OneShotRunner;

  /**
   * W6-FI-b (3-way ARCH I-4, part 2 of 3): the connection lifecycle
   * subsystem — spawn/connect/`acpState`/`inFlightStart`/crash+respawn/
   * per-session recovery, EXTRACTED off this class (behavior-preserving
   * MOVE + DI, see {@link ConnectionSupervisor}'s own doc). Constructed
   * once, below, with this connection's collaborators + the narrow
   * `cwd`/`activeSessionId` accessors injected — the SAME dependencies the
   * pre-extraction methods read/wrote directly off `this`.
   */
  private readonly connectionSupervisor: ConnectionSupervisor;

  /**
   * W6-FI-c (3-way ARCH I-4, part 3 of 3, FINAL): the control-message
   * routing surface, EXTRACTED off this class (behavior-preserving MOVE +
   * DI, see {@link ControlDispatcher}'s own doc). Constructed once, below,
   * AFTER {@link panelSources}/{@link sessions}/{@link rootRegistry} exist
   * (passed by reference — all three are readonly, constructed once, never
   * reassigned) — the SAME dependencies the pre-extraction methods read
   * directly off `this`.
   */
  private readonly controlDispatcher: ControlDispatcher;

  /** Zone Z3 (finding A1): the panel-fetch strategy registry — see `PanelSourceRegistry`'s doc. */
  private readonly panelSources: PanelSourceRegistry;

  /** W4-T1a Deliverable 3: the per-session actor registry. */
  private readonly sessions = new SessionRegistry();

  /**
   * W4-T2 Deliverable 2: `Map<canonicalRoot, RootCoordinator>` — replaces
   * T1a's single-instance bridge. Each session's controller is handed the
   * coordinator for its OWN cwd's (realpath'd) workspace root as `port.root`
   * (resolved by {@link resolveRootCoordinator}); baselines and the one-shot
   * before-snapshot draw their NEGATIVE ordinal from the OWNING
   * coordinator's `nextBaselineOrdinal()` (F3 — replaces the old per-backend
   * `sessionBaselineCount`).
   */
  private readonly rootRegistry = new RootRegistry();

  /** The process-unique approval-id mint — STAYS connection-level (§2c). */
  private approvalCounter = 0;

  /**
   * CF-01/L3-1 fix (Important — 3-lens review of the tail-serialization
   * commit): a SYNCHRONOUS close tombstone. {@link closeTab} now defers the
   * ACTUAL registry removal onto {@link connectionSupervisor}'s topology
   * tail (see that method's own doc) — while a close is queued but has not
   * yet run, the closed session `S` stays LIVE in `this.sessions`. Two
   * hazards that opened: (1) `ConnectionSupervisor.handleAcpCrash`'s
   * `pendingRecovery` snapshot reads the live registry — a crash landing in
   * that window captures `S` and the coming respawn re-`session/load`s a
   * tab the user already asked to close (resurrection); (2) {@link
   * sendPrompt} (never tail-wrapped) can still find `S` live and start a
   * turn on a closing tab. `closeTab` adds `sessionId` here SYNCHRONOUSLY,
   * BEFORE enqueuing the deferred close; `closeTabInternal` removes it once
   * the actual `sessions.close` has run. This restores the
   * pre-serialization SYNCHRONOUS visibility of a close (a crash snapshot /
   * `sendPrompt` see it INSTANTLY) while keeping the removal ITSELF
   * deferred on the tail — ordering safety is unchanged: a close still
   * queues behind an in-flight load rather than interrupting one mid-
   * `loadReplay`. Read by `ConnectionSupervisor.handleAcpCrash` through the
   * narrow `ConnectionSupervisorHostPort.isPendingClose` predicate (not a
   * broad new port surface — see that member's own doc) and directly by
   * {@link sendPrompt}/{@link handleSessionUpdate} (same class).
   */
  private readonly pendingClose = new Set<string>();

  // AH5: `dashboardToggleTail` (the HOST-SIDE serialization tail for
  // `toggleDashboard`) moved onto `ControlDispatcher` (W6-FI-c) — it was a
  // private implementation detail of the method that moved with it.

  /**
   * W4-T4b (SF-2 §4.3 mitigation 2): disposable for the `talaria.customModes`
   * change-detection subscription — owned here (not `context.subscriptions`,
   * mirroring how `clientExitSub`/`this.control` are owned) so a mock->real
   * trust-upgrade swap (which disposes the OLD backend) also unsubscribes
   * the old listener; the new backend's constructor registers its own.
   */
  private readonly customModesConfigSub: vscode.Disposable;

  constructor(
    // W6-FI-b: no longer a parameter PROPERTY (`private readonly config`) —
    // `this.config` had no reader left once `startInternal`'s `resolveHermes
    // (this.config)` moved onto `ConnectionSupervisorHostPort.config` below;
    // the plain parameter is still read once, right here in the constructor,
    // to build that port (and to construct `ControlChannel`, as before).
    config: HermesRuntimeConfig,
    private readonly logger?: Logger,
    /** Test seam — defaults to the real ACP SDK client (`AcpClient`). */
    private readonly createClient: AcpClientFactory = (options) => new AcpClient(options),
    /**
     * Zone CKPT: the extension-side checkpoint tracker (shadow-git),
     * constructed and `init()`'d by `extension.ts` (storage dir + workspace
     * root aren't known here). `undefined` when no workspace is open, or the
     * caller chose not to wire checkpoints (e.g. tests) — every checkpoint
     * codepath below treats that as "unavailable", never as an error.
     */
    private readonly checkpointTracker?: CheckpointTrackerLike,
    /**
     * W1.5: the dashboard REST service (adopt-or-spawn `HermesDashboardManager`),
     * constructed + owned by `extension.ts` (like {@link checkpointTracker}) and
     * gated behind the same trusted-workspace + `backend==='acp'` selection —
     * `undefined` when the dashboard isn't wired (tests, or a future opt-out).
     * When present, it OWNS the real Skills & Tools panels (list + toggle),
     * replacing the fake `skills.manage` enable/disable path.
     */
    private readonly dashboard?: DashboardService,
    /**
     * T2c (§2a): optional injected resolver for webview-supplied `@`-mentions —
     * a minimal structural port ({@link MentionResolverLike}), NOT the concrete
     * `ContextResolver` (T2b/T2d construct + wire the real one via `extension.ts`,
     * over the `vscode`-backed ports this class must stay free of). `undefined`
     * here (tests, or before T2d lands) makes {@link resolveMentionsSafe} always
     * return `[]` — mentions stay inert, the app behaves exactly as today.
     */
    private readonly mentionResolver?: MentionResolverLike,
    /**
     * W2 T4 (F-D, §3.5): the host-only read-only diff-preview registry,
     * constructed + owned by `extension.ts` (like {@link checkpointTracker}/
     * {@link dashboard} above) and injected the same way. `undefined` here
     * (tests, or before T4 lands) makes preview population/clearing a no-op —
     * the ask-path approval flow itself is completely unaffected either way.
     */
    private readonly editPreviewRegistry?: EditPreviewRegistry,
    /**
     * O_PATH confined reader (accepted-limits Limit-1 close). Falls back to
     * the plain read on non-Linux / probe failure — see {@link
     * ./acp/confinedOpen}. F1 (Tier-2 remediation architecture §12.1, task
     * T-13): test seam — defaults to the real `makeProcFdReader()`; tests
     * inject a fake so the `maxBytes` bounded-read wiring in {@link
     * handleReadTextFile} is provable without a real O_PATH probe (which is
     * Linux-only and platform-gated, `confinedOpen.ts`'s own doc).
     */
    private readonly confinedReader: ConfinedReader = makeProcFdReader(),
  ) {
    this.control = new ControlChannel(config, logger);
    // W6-FI-a: every accessor closes over `this`, read at CALL TIME (not
    // construction time) — mirrors `buildSessionPort`'s own posture, so the
    // runner always sees the CURRENT client/cwd/root, even across a respawn.
    const oneShotPort: OneShotHostPort = {
      getClient: () => this.connectionSupervisor.getClient(),
      getConnectionCwd: () => this.cwd,
      resolveRoot: (cwd) => this.resolveRootCoordinator(cwd),
      logger: this.logger,
    };
    this.oneShotRunner = new OneShotRunner(oneShotPort);
    // W6-FI-b: same accessor-at-call-time posture as `oneShotPort` above —
    // every closure reads `this`'s CURRENT state, never a construction-time
    // snapshot. `cwd`/`activeSessionId` stay physically on `AcpBackend`
    // (see their own field docs); `sessions`/`callbacks` are injected by
    // reference/value since the supervisor needs the SAME live instances
    // `AcpBackend` itself uses.
    const connectionPort: ConnectionSupervisorHostPort = {
      config,
      createClient: this.createClient,
      logger: this.logger,
      callbacks: {
        onSessionUpdate: (sessionId, update) => this.handleSessionUpdate(sessionId, update),
        onRequestPermission: (req) => this.handleRequestPermission(req),
        onReadTextFile: (path, line, limit) => this.handleReadTextFile(path, line, limit),
      },
      setCwd: (cwd) => {
        this.cwd = cwd;
      },
      getActiveSessionId: () => this.activeSessionId,
      setActiveSessionId: (sessionId) => {
        this.activeSessionId = sessionId;
      },
      sessions: this.sessions,
      startControl: () => this.control.start(),
      buildSessionPort: (sessionId, cwd) => this.buildSessionPort(sessionId, cwd),
      openSession: (cwd, tabId, isStaleAttempt) => this.openSession(cwd, tabId, isStaleAttempt),
      getMcpServers: () => [...this.mcpServers.values()],
      // CF-01/L3-1 fix (Important): the narrow cross-boundary read
      // `handleAcpCrash`'s `pendingRecovery` snapshot needs — see
      // `pendingClose`'s own doc and `ConnectionSupervisorHostPort
      // .isPendingClose`'s own doc for the full tombstone rationale.
      isPendingClose: (sessionId) => this.pendingClose.has(sessionId),
      // W6-P7-N11 (3-way ARCH I-4): the shared bind-announcement pair — see
      // `announceSessionBound`'s own doc for the preserved order/shape.
      announceSessionBound: (tabId, sessionId, rootId) => this.announceSessionBound(tabId, sessionId, rootId),
      // W6-FI-c: `warmCheckpointBaseline` moved onto `controlDispatcher` — a
      // lazy closure (only INVOKED after this constructor returns, once the
      // connection actually establishes), so referencing `this
      // .controlDispatcher` here — before it's assigned a few lines below —
      // is safe, mirroring `resolveRoot`/`buildSessionPort`'s own posture.
      warmCheckpointBaseline: () => this.controlDispatcher.warmCheckpointBaseline(),
      settleOneShot: (reason) => this.oneShotRunner.settleAll(reason),
      resetSessionsAccumulation: () => this.resetSessionsAccumulation(),
      emit: (msg) => this.emitter.fire(msg),
    };
    this.connectionSupervisor = new ConnectionSupervisor(connectionPort);
    this.panelSources = createDefaultPanelSources(this.buildPanelSourceContext());
    // W6-FI-c (3-way ARCH I-4, part 3 of 3): every accessor closes over
    // `this`, read at CALL TIME — mirrors `oneShotPort`/`connectionPort`'s
    // own posture. `panelSources`/`sessions`/`rootRegistry` are passed BY
    // REFERENCE (readonly fields, constructed once, never reassigned) — see
    // `ControlDispatcherHostPort`'s own doc for why that's safe here.
    const controlPort: ControlDispatcherHostPort = {
      dispatch: (method, params) => this.control.dispatch(method, params),
      emit: (msg) => this.emitter.fire(msg),
      logger: this.logger,
      panelSources: this.panelSources,
      sessions: this.sessions,
      rootRegistry: this.rootRegistry,
      resolveRootCoordinator: (cwd) => this.resolveRootCoordinator(cwd),
      getConnectionCwd: () => this.cwd,
      getActiveSessionId: () => this.activeSessionId,
      getDashboard: () => this.dashboard,
      showWarningMessage: (message) => {
        void vscode.window.showWarningMessage(message);
      },
      loadSessionIntoTab: (sessionId, cwd, tabId) => this.loadSessionIntoTab(sessionId, cwd, tabId),
    };
    this.controlDispatcher = new ControlDispatcher(controlPort);
    // W4-T4b (§4.3 mitigation 2 — the self-widening close's second leg): a
    // `talaria.customModes` disk change NEVER auto-re-snapshots a live
    // session's enforced floor (mitigation 1, `setCustomMode`, is what
    // snapshots) — see `ControlDispatcher.handleCustomModesConfigChanged`'s
    // doc (W6-FI-c: moved off this class, called through the delegate below).
    this.customModesConfigSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('talaria.customModes')) this.controlDispatcher.handleCustomModesConfigChanged();
    });
    // W1.5: route Skills & Tools through the dashboard REST channel (real
    // enabled/description/provenance/usage + a real toggle) via Z3's Open-Closed
    // registry — the default tui_gateway sources become the degraded fallback
    // only when no dashboard is wired. A fetch made while the dashboard is
    // unreachable REJECTS (retryable panel error), never a fake success.
    if (this.dashboard) {
      const ensure = () => this.dashboard!.ensure();
      this.panelSources.register('skills', new DashboardSkillsPanelSource(ensure));
      this.panelSources.register('tools', new DashboardToolsPanelSource(ensure));
    }
  }

  /**
   * Build the {@link SessionHostPort} a `SessionController` for `sessionId`
   * consumes (§2c). Every accessor closes over `this`, read at CALL TIME
   * (not construction time) — mirrors `buildPanelSourceContext`'s own
   * posture — so a controller always sees the CURRENT client/tracker/etc.,
   * even across a respawn.
   *
   * W4-T2: `root` is now resolved ONCE, synchronously, at port-build time
   * (via {@link resolveRootCoordinator}) — `cwd` must be the session's OWN
   * cwd (not the connection-level `this.cwd`), since it decides WHICH
   * `RootCoordinator` this controller shares. Like T1a's `SessionController`
   * itself, a port is only ever rebuilt when a FRESH controller is minted —
   * `loadSessionIntoTab`'s in-place reuse of the active controller (no
   * `tabId` wiring yet) does not re-resolve `root` on a cwd change; a real
   * cross-root re-home is T3's job (critic pin F6).
   */
  private buildSessionPort(sessionId: string, cwd: string): SessionHostPort {
    void sessionId; // identity is carried by the controller itself, not the port
    const root = this.resolveRootCoordinator(cwd);
    return {
      getClient: () => this.connectionSupervisor.getClient(),
      emit: (msg) => this.emitter.fire(msg),
      emitSystemError: (message, detail) => this.emitter.fire({ type: 'system.error', message, detail }),
      root,
      workspaceRoots: () => this.workspaceRoots(),
      logger: this.logger,
      // W6-FI-c Part 2 (3-way ARCH I-4c, W4-F5 placement fix): this session's
      // OWN root, resolved once at port-build time above — never ambient
      // ("the active controller's root") — now delegates DIRECTLY to that
      // shared `RootCoordinator`'s own canonical refresh implementation
      // (wired ONCE, at root-mint time, by `resolveRootCoordinator`) instead
      // of independently re-implementing the fetch+catch+log HERE, per
      // controller mint. Behavior-equivalent: same `fetchPanelData(
      // 'checkpoints', {rootId})` call, same fail-open catch-and-log — see
      // `ControlDispatcher.refreshCheckpointsPanel`'s own doc for the exact
      // (unchanged) implementation this now runs through.
      refreshCheckpointsPanel: () => root.refreshCheckpointsPanel(),
      editPreviewRegistry: this.editPreviewRegistry,
      resolveMentions: (mentions) => this.resolveMentionsSafe(mentions),
    };
  }

  /**
   * W4-T2 Deliverable 2/3: resolve (or mint) the {@link RootCoordinator} for
   * `cwd`'s CONTAINING workspace root, keyed by its REALPATH'd canonical
   * form (Obs: an aliased/symlinked root must resolve to the SAME
   * coordinator + shadow repo as its canonical target, or the two fork).
   *
   * The injected {@link checkpointTracker} (constructed by `extension.ts`
   * for the FIRST workspace root only — today's only reachable shape) is
   * handed to the coordinator ONLY when the resolved canonical root matches
   * that primary root; a genuinely different second root in a multi-root
   * workspace gets `tracker: undefined` (checkpoints unavailable for it)
   * rather than silently sharing the primary root's shadow-git — which
   * would write root B's snapshots into root A's worktree (active
   * corruption, strictly worse than "unavailable"). Minting a REAL per-root
   * tracker factory is `extension.ts` wiring beyond T2's mechanism-only
   * scope (multi-root tracker construction is Fedora-probed, P-W4-5).
   *
   * W6-FI-c Part 2 (3-way ARCH I-4c, W4-F5 placement fix): also wires the
   * NEWLY-minted coordinator's checkpoints-panel refresh trigger — ONCE, at
   * mint time (the `notifyCheckpointsChanged` factory below, like
   * `trackerFactory` above, is only invoked by `getOrCreate` on a cache
   * miss) — to `controlDispatcher.refreshCheckpointsPanel(canonicalRoot)`.
   * Every `SessionController` sharing this root subsequently reaches that
   * SAME implementation through its `port.root` (the shared coordinator
   * instance), instead of `buildSessionPort` re-implementing the refresh
   * independently per controller mint (the F5 hazard).
   */
  private resolveRootCoordinator(cwd: string): RootCoordinator {
    const containingRoot = this.findContainingWorkspaceRoot(cwd);
    const canonicalRoot = this.canonicalizeWorkspaceRoot(containingRoot);
    const primaryRoot = this.canonicalizeWorkspaceRoot(this.workspaceRoots()[0] ?? cwd);
    return this.rootRegistry.getOrCreate(
      canonicalRoot,
      () => (canonicalRoot === primaryRoot ? this.checkpointTracker : undefined),
      () => this.controlDispatcher.refreshCheckpointsPanel(canonicalRoot),
    );
  }

  /** The open workspace folder that CONTAINS `cwd`, or the first folder / `cwd` itself when none contains it (no workspace open — a bare cwd is its own root). */
  private findContainingWorkspaceRoot(cwd: string): string {
    const roots = this.workspaceRoots();
    const firstRoot = roots[0];
    if (roots.length === 0 || firstRoot === undefined) return cwd;
    const resolved = path.resolve(cwd || firstRoot);
    for (const root of roots) {
      if (isPathWithin(resolved, path.resolve(root))) return root;
    }
    return firstRoot;
  }

  /**
   * Realpath a workspace root to its canonical form (sync — this keeps
   * {@link buildSessionPort}/{@link resolveRootCoordinator} synchronous,
   * matching `tryAcquireTurnLease`'s own synchronous-admission discipline;
   * called rarely — once per genuinely NEW root, not per-turn). Falls back
   * to the lexical form on any FS error (a not-yet-existing/unreadable root
   * still needs a STABLE key). An empty/falsy `root` is returned AS-IS —
   * never realpath'd — so a degenerate no-cwd caller (headless tests) never
   * silently resolves to `process.cwd()` via `path.resolve('')`.
   */
  private canonicalizeWorkspaceRoot(root: string): string {
    if (!root) return root;
    try {
      return realpathSync(path.resolve(root));
    } catch {
      return path.resolve(root);
    }
  }

  /**
   * Bind the {@link PanelSourceContext} to this backend's live state. The ACP
   * client and cwd are ACCESSORS (not snapshots) because they change across
   * `start()`/`session/load` — a source reads them at fetch time. The control
   * dispatch is the tui_gateway channel.
   *
   * W4-T3b (§7 B6): `getSessionCwd`/`getSessionSubagentsSnapshot`/
   * `getRootTracker` all resolve by an EXPLICIT identity the CALLER (a
   * `PanelSource`) supplies — never "the active session/root" — via the
   * `SessionRegistry`/`RootRegistry` these sources never touch directly.
   */
  private buildPanelSourceContext(): PanelSourceContext {
    return {
      dispatch: (method, params) => this.control.dispatch(method, params),
      getAcpClient: () => this.connectionSupervisor.getClient(),
      getCwd: () => this.cwd,
      getSessionCwd: (sessionId) => this.sessions.get(sessionId)?.cwd,
      getSessionSubagentsSnapshot: (sessionId) => this.sessions.get(sessionId)?.getSubagentsSnapshot(),
      getRootTracker: (rootId) => this.rootRegistry.get(rootId)?.tracker,
      logger: this.logger,
    };
  }

  // W6-FI-c: `activeController()` (the W6-FG-sanctioned last-resort
  // ambient read `getPreset`/`getAvailableCommands` used) moved onto
  // `ControlDispatcher` — both its only two callers moved with it. See
  // `ControlDispatcher.activeController`'s own doc (unchanged rationale).

  /**
   * Register (or override) a panel's data source WITHOUT editing this class —
   * the Open-Closed extension point (see `PanelSourceRegistry`'s doc). A later
   * zone wires e.g. a dashboard-backed skills/tools source through here; the
   * fetch dispatch in {@link invokeControl} then routes to it automatically.
   */
  registerPanelSource<P extends DataPanel>(panel: P, source: PanelSource<P>): void {
    this.panelSources.register(panel, source);
  }

  /**
   * Spawn both channels, ACP-initialize (advertising `fs.readTextFile:true,
   * writeTextFile:false, terminal:false` — deliberately false-sounding but
   * correct: zero terminal handlers are registered, so we advertise what we
   * implement rather than repeat the earlier `terminal:true` over-claim; see
   * `acpClient.ts`'s `initialize()` comment for the rationale), start the
   * control gateway, then
   * open the first session (`session/new`, via {@link openSession}). Safe to
   * call again for a fresh session — tears down every previous session and
   * ACP child first.
   *
   * W6-FI-b (3-way ARCH I-4, part 2 of 3): a thin passthrough to {@link
   * connectionSupervisor} — the connection-phase spawn/connect/initialize,
   * the `acpState` machine, the `inFlightStart` P0/M1 tail-serialization,
   * crash detection + respawn backoff, and post-crash per-session recovery
   * (previously inline here: `startInternal`/`establishInitialSession`/
   * `recoverSessions`/`recoverOneSession`/`raceRecoveryAgainstChildExit`/
   * `handleAcpCrash`/`scheduleAcpRespawn`/`clearAcpRespawnTimer`, plus the
   * `client`/`clientExitSub`/`inFlightStart`/`acpState`/
   * `acpRespawnAttempts`/`acpRespawnTimer`/`pendingRecovery` fields) moved
   * onto {@link ConnectionSupervisor} verbatim — see its own doc for the
   * full req-tagged rationale. Behavior-preserving: same signature, same
   * result. `openTab` (below) chains onto the SAME `inFlightStart` tail via
   * `connectionSupervisor.runOnStartTail` — see that method's doc.
   */
  async start(): Promise<void> {
    return this.connectionSupervisor.start();
  }

  /**
   * W6-P7-N11 (3-way ARCH I-4): the single home for the bind-time
   * `tab.bound` + `mode.state` emission PAIR that {@link openSession},
   * {@link loadSessionIntoTab}, and `ConnectionSupervisor.recoverOneSession`
   * (reached through {@link ConnectionSupervisorHostPort.announceSessionBound})
   * each used to mint independently — the FI-b-triplicated choreography the
   * 3-way ARCH finding I-4 named. Behavior-preserving EXTRACT ONLY: WHERE
   * the emission lives changed, never WHAT or WHEN it fires. Reproduces the
   * exact sequence every site already emitted, verbatim:
   *  1. `tab.bound{tabId, sessionId, rootId}` (W4-T3b D1) — announce the
   *     binding BEFORE any replay streams (§7 B9(b)).
   *  2. `mode.state{sessionId, modeId: null, available}` immediately after
   *     (M#2 adjacency, pinned by `AcpBackend.test.ts`) — every bind path
   *     starts a session with no custom mode, so the picker populates.
   * Each caller supplies its OWN `tabId`/`sessionId`/`rootId` — never
   * flattened to one shared value. `openSession`'s additional
   * `pinWireModeDefault` step (a possible `setSessionMode` round trip) is
   * NOT part of this pair and stays inline at that one call site, ordered
   * strictly AFTER this call returns (unchanged from before the extract).
   */
  private announceSessionBound(tabId: string, sessionId: string, rootId: string): void {
    this.emitter.fire({ type: 'tab.bound', tabId, sessionId, rootId });
    this.emitter.fire({
      type: 'mode.state',
      sessionId,
      modeId: null,
      available: toCatalog(readCustomModes()),
    });
  }

  /**
   * §2c: `client.newSession` + mint a `SessionController` (via the
   * registry, injecting the port) + adopt it as the active session, then
   * announce the bind via {@link announceSessionBound} (W4-T3b D1) — the
   * webview learns its tab's real root here, ordered BEFORE
   * `pinWireModeDefault`'s possible `setSessionMode` round trip so a fresh
   * session's binding is always announced before anything else could stream
   * for it. Router table: "the first tab's open replaces today's
   * in-`start()` session mint" — `establishInitialSession` calls this once
   * (with the shared `BOOTSTRAP_TAB_ID`) for the connection's boot session;
   * {@link openTab} is the real, independently-serialized "new tab" entry
   * point.
   *
   * W4-T3b: T1a deferred the `tab.bound` emission "to avoid breaking
   * exact-message-sequence tests" — that deferral is now resolved: this IS
   * the correct behavior, and the (few) affected host tests were updated to
   * expect it (see `AcpBackend.test.ts`'s W4-T3b describe blocks).
   *
   * T-3 (closes B1-M1): `isStaleAttempt`, when supplied, is checked ONCE
   * `client.newSession` resolves — BEFORE `sessions.open`'s registration
   * has a chance to become visible via `tab.bound`. Only
   * `ConnectionSupervisor.establishInitialSession`'s bootstrap race passes
   * one (see its own doc for why the guard has to live HERE rather than at
   * that call site: this method's register-then-announce runs to
   * completion synchronously off the SAME microtask `newSession` resolves
   * into, so by the time control would return to a caller-side check,
   * `tab.bound` has already fired). `openTab` never passes one — a plain
   * new-tab mint has no earlier deadline/exit to have been abandoned by.
   */
  private async openSession(
    cwd: string,
    tabId: string,
    isStaleAttempt?: () => boolean,
  ): Promise<SessionController> {
    const client = this.connectionSupervisor.getClient();
    if (!client) throw new Error('AcpBackend.openSession: no live ACP client');
    const mcpServers = [...this.mcpServers.values()];
    const session = await client.newSession(cwd, mcpServers);
    const controller = this.sessions.open(
      session.sessionId,
      cwd,
      this.buildSessionPort(session.sessionId, cwd),
      tabId,
    );
    if (isStaleAttempt?.()) {
      // T-3 (closes B1-M1): a BELATED `session/new` resolution — the caller
      // already gave up on this attempt (child exit or the
      // SESSION_ESTABLISH_DEADLINE_MS wall-clock deadline) before
      // `client.newSession` finally answered. JS promises can't be
      // cancelled, so this call kept running in the background.
      // `sessions.close` is the SAME remove-then-dispose the ordinary close
      // path uses (F6) — dispose ALSO fires a best-effort `session/close`
      // (`SessionController.dispose`), so the now-orphaned server-side
      // session is cleaned up too, without a second, bespoke close call
      // here. Never mutates `activeSessionId`/`cwd` and never announces the
      // bind — nothing about an abandoned attempt should become "the"
      // active session, and rejecting (rather than returning the
      // now-disposed controller) keeps this method's return contract
      // honest. The rejection is harmless to observe: the ONLY awaiter is
      // `raceAgainstChildExit`'s own `p.then(settleResolve, settleReject)`,
      // already settled by the time this fires — `settleReject`'s
      // already-settled guard discards it, and attaching a rejection
      // handler at all is what keeps this from ever surfacing as an
      // unhandled rejection.
      this.sessions.close(session.sessionId);
      throw new Error(
        'AcpBackend.openSession: attempt superseded (session/new resolved after the caller gave up)',
      );
    }
    this.activeSessionId = session.sessionId;
    this.cwd = cwd;
    // W4-T4b (SF-2 deliverable 4): a freshly-bound session starts with no
    // custom mode — announce the authoritative `mode.state` (via {@link
    // announceSessionBound}) so the picker populates (§4). Without this the
    // webview's `availableModes` stays empty forever and the picker never
    // renders.
    this.announceSessionBound(tabId, session.sessionId, controller.getRootId());
    // A7: surface the harness-bound model at session start — kills the
    // generic "Model" placeholder (`webview/src/App.tsx`) the webview would
    // otherwise show until the user's first manual switch. Omitted (not a
    // fabricated `null`) when the response carried no `models` at all — the
    // id-namespace contract question stays deferred.
    if (session.currentModelId !== undefined) {
      controller.currentModelId = session.currentModelId;
      this.emitter.fire({ type: 'model.state', sessionId: session.sessionId, modelId: session.currentModelId });
    }
    // W2-F1 wire-pin (mode-coordination §4.1): F4 — the pin is per-controller now.
    await controller.pinWireModeDefault(session.currentModeId);
    return controller;
  }

  /**
   * W4-T3b (§2d/§2e Deliverable 5): the real `tab.open` entry point — mint a
   * brand-new ACP session for `tabId` on the connection's current cwd (v1:
   * new tabs share the connection's single-root cwd; a per-tab cwd picker is
   * not in this wave's UI). Serialized through the SAME `inFlightStart`
   * tail `start()` uses (§2c: "openSession calls are serialized through the
   * same tail-chaining pattern so a respawn's re-establishment loop and a
   * user's new-tab click can never interleave their `newSession` handshakes")
   * — W6-FI-b: that shared tail now lives on {@link connectionSupervisor};
   * this calls its {@link ConnectionSupervisor.runOnStartTail} exactly where
   * the inlined P0/M1 chaining used to sit, unchanged in every observable
   * respect (same field, same identity-compare self-reset, same interleaving
   * guarantee — see that method's own doc).
   *
   * NEVER throws back to the caller — a rejected/impossible open (no live
   * client, e.g. mid-respawn; a `session/new` failure) emits `tab.error`
   * (§7 B8: `tab.open` MUST get a terminal reply, or the tab's composer stays
   * disabled forever).
   */
  async openTab(tabId: string): Promise<void> {
    return this.connectionSupervisor.runOnStartTail(() => this.openTabInternal(tabId));
  }

  private async openTabInternal(tabId: string): Promise<void> {
    const client = this.connectionSupervisor.getClient();
    if (!client) {
      this.emitter.fire({
        type: 'tab.error',
        tabId,
        kind: 'open-failed',
        message: 'The agent is not connected yet.',
      });
      return;
    }
    const cwd = this.cwd ?? this.workspaceRoots()[0] ?? '';
    try {
      await this.openSession(cwd, tabId);
    } catch (err) {
      this.emitter.fire({ type: 'tab.error', tabId, kind: 'open-failed', message: errorMessage(err) });
    }
  }

  /**
   * W4-T3b (§2e Deliverable 5): close a chat-session tab's session. The
   * webview already owns the authoritative `tabId<->sessionId` binding (from
   * `tab.bound`) and sends it back on `tab.close` — this is a thin pass
   * through to {@link SessionRegistry.close}'s existing F6 remove-before-
   * dispose guarantee. A no-op for an unrecognized `sessionId` (a still-
   * unbound tab closed before its `tab.open` resolved has none to send).
   *
   * CF-01/L3-1 (closes the C1/W6-FB/W6-FG cross-tab race family's generator):
   * the actual removal (`closeTabInternal`) now chains onto the SAME
   * `inFlightStart` tail `start()`/`openTab`/`loadSessionIntoTab` use, via
   * {@link ConnectionSupervisor.runOnStartTail} — a close can no longer
   * interleave with an in-flight load/open/start/respawn. The public
   * signature stays synchronous `void` (matches `AgentBackend`'s interface
   * and every existing caller's fire-and-forget usage, e.g.
   * `TalariaViewProvider`'s `tab.close` handler). CORRECTED (3-lens review of
   * this same commit): the OBSERVABLE effect (the registry removal) is
   * deferred — NOT "a few microtask ticks" (that undersold it) — the true
   * bound is "queues behind whatever is currently on `inFlightStart`", which
   * can be an in-flight load/respawn-recovery, up to
   * `ConnectionSupervisor`'s own `SESSION_ESTABLISH_DEADLINE_MS` (120s)
   * before that link even settles. Mirrors {@link
   * ControlDispatcher.refreshCheckpointsPanel}'s `void promise.catch(...)`
   * fire-and-forget idiom: a rejection (defensive only — neither
   * `SessionRegistry.close` nor `SessionController.dispose` throws today) is
   * caught and logged here instead of becoming an unhandled rejection.
   *
   * CF-01/L3-1 fix (Important, the review's own finding): REMOVAL being
   * deferred does NOT mean VISIBILITY is — {@link pendingClose} tombstones
   * `sessionId` here, SYNCHRONOUSLY, before the deferred link is even
   * enqueued below, so `ConnectionSupervisor.handleAcpCrash`'s
   * `pendingRecovery` snapshot and {@link sendPrompt} both see this close
   * INSTANTLY (never resurrecting/turning-on a session the user just asked
   * to close), even though the registry entry itself lingers a little
   * longer. See {@link pendingClose}'s own doc for the full rationale.
   */
  closeTab(sessionId: string): void {
    this.pendingClose.add(sessionId);
    void this.connectionSupervisor.runOnStartTail(() => this.closeTabInternal(sessionId)).catch((err: unknown) => {
      this.logger?.append(`[AcpBackend] closeTab failed (sessionId=${sessionId}): ${errorMessage(err)}`);
    });
  }

  private async closeTabInternal(sessionId: string): Promise<void> {
    try {
      this.sessions.close(sessionId);
    } finally {
      // CF-01/L3-1 fix: clear the tombstone only once the ACTUAL removal has
      // run — see {@link pendingClose}'s own doc. `finally` so a defensive
      // (never-happens-today) throw from `sessions.close` still clears it.
      this.pendingClose.delete(sessionId);
    }
  }

  /**
   * Register (or clear, when `server` is `undefined`) the MCP server keyed
   * by `name` that every subsequent `session/new`/`session/load` should
   * advertise (see the `start()` comment above for the re-send rationale).
   * `extension.ts` is the only caller — it owns each entry's activation gate
   * (Zone RAG: Workspace Trust + `shouldActivateRag` — "only register
   * `codebase_search` when RAG is active and the workspace is trusted; omit it
   * otherwise"; W3 LIB (T7): `shouldActivateLib`, research doc §4.2) — this class makes no
   * trust decision of its own for any entry.
   *
   * Key/name-drift guard (critic A finding 7): when SETTING (`server`
   * defined), `name` MUST equal `server.name` — Hermes registers MCP servers
   * idempotently by the WIRE `name`, so a key that differs from `server.name`
   * would silently register under one identity while a later
   * `setMcpServer(key, undefined)` "clears" a key Hermes never actually knew
   * by. This is a programmer-contract violation (a wiring bug, not a runtime
   * input), so it THROWS rather than silently swallowing or coercing.
   */
  setMcpServer(name: string, server: AcpMcpServer | undefined): void {
    if (server === undefined) {
      this.mcpServers.delete(name);
      return;
    }
    if (name !== server.name) {
      throw new Error(`setMcpServer: key "${name}" !== server.name "${server.name}"`);
    }
    this.mcpServers.set(name, server);
  }

  /**
   * §2c routing table: `sendPrompt`/`cancel`/`respondApproval`/`resolveDiff`/
   * `setModel`/`setPreset` are all `sessionId`-first now (S0) and route as
   * `this.sessions.get(sessionId)?.method(...)`. W4-T2 (F1): the old
   * connection-level `oneShotInFlight` admission check is GONE — the root
   * turn lease now subsumes it: a same-root one-shot holds THIS SAME lease
   * under its own synthetic holder id, so `SessionController.sendPrompt`'s
   * own lease-acquire refuses for free (no separate router-side check).
   */
  sendPrompt(sessionId: string, text: string, mode: AgentMode, attachments?: Attachment[], mentions?: ContextRef[]): void {
    // CF-01/L3-1 fix (Important): a session mid-`closeTab` (tombstoned
    // synchronously, actual removal still queued on the topology tail) must
    // never start a new turn — see {@link pendingClose}'s own doc. Silent
    // no-op, NOT the ARCH-1 error path below: the user just asked to close
    // THIS exact tab, so a stray/raced send for it needs no feedback the way
    // a genuinely-unexpected lost session does.
    if (this.pendingClose.has(sessionId)) return;
    const controller = this.sessions.get(sessionId);
    if (!controller) {
      // ARCH-1 (final review, UI I-3): a user-initiated action must never
      // no-op silently — a bare `?.` here would drop the send with no
      // feedback whenever the webview still believes a session is bound
      // but the registry has already lost it (e.g. `tab.error{session-lost}`
      // raced this call, or a stale composer somehow reached a dead tab).
      // `foldSessionScoped` (webview reducer) maps `sessionId` back to
      // whichever tab still believes it owns this session, so the error
      // lands where the user is actually looking.
      this.emitter.fire({
        type: 'error',
        sessionId,
        message: 'This conversation\'s session is no longer available. Load it again from History or start a new chat.',
      });
      return;
    }
    controller.sendPrompt(text, mode, attachments, mentions);
  }

  /**
   * TOTAL (§2a's P1 guard): NEVER rejects, NEVER throws. No resolver injected,
   * or no mentions to resolve, short-circuits to `[]` without invoking the
   * resolver at all. A resolver that rejects/throws — a contract violation of
   * `ContextResolver.resolveAll`'s own "never throws" guarantee, defended
   * against here anyway — is caught and logged, and resolution degrades to
   * `[]`. Exposed to every `SessionController` via `port.resolveMentions`
   * (§2c) — a connection-level dependency (T2c), not a per-session one.
   */
  private async resolveMentionsSafe(mentions?: ContextRef[]): Promise<ResolvedContext[]> {
    if (!this.mentionResolver || !mentions || mentions.length === 0) return [];
    try {
      return await this.mentionResolver.resolveAll(mentions);
    } catch (err) {
      this.logger?.append(
        `[AcpBackend] mention resolution failed — proceeding with no resolved context: ${errorMessage(err)}`,
      );
      return [];
    }
  }

  /** §2c routing table: `cancel` routes as `this.sessions.get(sessionId)?.cancel()`. */
  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.cancel();
  }

  /**
   * §2c "One-shot model-call surface" — a silent, isolated single model call
   * on the EXISTING ACP connection via an ephemeral `session/new`. Backs
   * {@link UtilityModelPort} (T5c binds the two; this class does not
   * `implements` the port itself — callers should depend on the port, not on
   * `AcpBackend`). See §2c for the six pinned requirements.
   *
   * W6-FI-a (3-way ARCH I-4, part 1 of 3): a thin passthrough to
   * {@link oneShotRunner} — the mutual-exclusion/deadline/ephemeral-registry
   * machinery (previously inline here: `runOneShot`/`runOneShotBody`/
   * `snapshotBeforeOneShot`/`settleAllEphemeral`, plus the `oneShotLeaseCounter`
   * and `ephemeral` fields) moved onto {@link OneShotRunner} verbatim — see
   * its own doc for the full req-tagged rationale (§2c req 4's synchronous
   * mutual exclusion, F1's shared root lease, C1's deadline-races-the-
   * entire-body fix). Behavior-preserving: same signature, same result.
   */
  async oneShot(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<OneShotResult> {
    return this.oneShotRunner.oneShot(prompt, opts);
  }

  /** §2c routing table: `respondApproval` routes as `this.sessions.get(sessionId)?.respondApproval(...)`. */
  respondApproval(sessionId: string, id: string, optionId: string): void {
    this.sessions.get(sessionId)?.respondApproval(id, optionId);
  }

  /** §2c routing table: `resolveDiff` routes as `this.sessions.get(sessionId)?.resolveDiff(...)`. */
  resolveDiff(sessionId: string, toolId: string, hunkIndex: number, action: DiffAction): void {
    this.sessions.get(sessionId)?.resolveDiff(toolId, hunkIndex, action);
  }

  /**
   * W2 T4 (F-D, §3.5): the diff-preview editor's Accept button. Session-scoped
   * (W4-T3b review I-1): the `talaria-diff:` tab URI carries the OWNING
   * `sessionId` (`parseDiffUri`), so route to THAT controller — never the
   * ambient `activeController()`, which under multi-tab is the last session to
   * act, NOT the tab the diff belongs to (a mismatch would hang session A's
   * approval or accept B's edit under a colliding toolId).
   */
  acceptWholeFileDiff(sessionId: string, toolId: string): void {
    this.sessions.get(sessionId)?.acceptWholeFileDiff(toolId);
  }

  /** §2c routing table: `setModel` routes as `this.sessions.get(sessionId)?.setModel(id)`. */
  setModel(sessionId: string, id: string): void {
    this.sessions.get(sessionId)?.setModel(id);
  }

  /**
   * §2c routing table: `setPreset` routes as `this.sessions.get(sessionId)?.setPreset(preset)`.
   */
  setPreset(sessionId: string, preset: EditPolicyPreset): void {
    this.sessions.get(sessionId)?.setPreset(preset);
  }

  /**
   * W4-T4b (SF-2 §4.3 mitigation 1 — the PRIMARY self-widening fix):
   * snapshot-on-activate.
   *
   * W6-FI-c (3-way ARCH I-4, part 3 of 3): a thin passthrough to {@link
   * controlDispatcher} — the snapshot-on-activate mechanics (previously
   * inline here) moved onto {@link ControlDispatcher} verbatim — see its
   * own doc for the full rationale.
   */
  setCustomMode(sessionId: string, modeId: string | null): void {
    this.controlDispatcher.setCustomMode(sessionId, modeId);
  }

  // W6-FI-c: `handleCustomModesConfigChanged` (W4-T4b SF-2 §4.3 mitigation
  // 2, the self-widening CLOSE) moved onto `ControlDispatcher` verbatim —
  // the constructor's `onDidChangeConfiguration` subscription above now
  // calls `this.controlDispatcher.handleCustomModesConfigChanged()`. See
  // `ControlDispatcher`'s own doc for the full rationale (unchanged).

  /**
   * W2-F1: `TalariaViewProvider.seedState`'s hydrate-seed read.
   *
   * W6-FI-c (3-way ARCH I-4, part 3 of 3): a thin passthrough to {@link
   * controlDispatcher} — see its own doc for the full W6-FG/W6-FF
   * sanctioned-exception rationale (unchanged).
   */
  getPreset(): EditPolicyPreset {
    return this.controlDispatcher.getPreset();
  }

  /**
   * W2 F-S: the cached ACP `available_commands` catalog for the
   * most-recently-opened session.
   *
   * W6-FI-c (3-way ARCH I-4, part 3 of 3): a thin passthrough to {@link
   * controlDispatcher} — see its own doc (unchanged).
   */
  getAvailableCommands(): SlashCommandInfo[] | undefined {
    return this.controlDispatcher.getAvailableCommands();
  }

  /**
   * W6-FF (3-way ARCH I-1): every LIVE session's tab-identity triple
   * (+rootId), for `TalariaViewProvider.seedState`'s `hydrate` payload.
   *
   * W6-FI-c (3-way ARCH I-4, part 3 of 3): a thin passthrough to {@link
   * controlDispatcher} — see its own doc (unchanged).
   */
  listTabs(): HydrateTabSeed[] {
    return this.controlDispatcher.listTabs();
  }

  /**
   * Thin passthrough to the control plane, with panel FETCHES unified behind
   * the {@link PanelSourceRegistry} (Zone Z3, finding A1).
   *
   * W6-FI-c (3-way ARCH I-4, part 3 of 3, FINAL): a thin passthrough to
   * {@link controlDispatcher} — the full per-branch routing table
   * (previously inline here: `session.list`/`session.load`/
   * `checkpoint.restore`/`checkpoint.redo`/`checkpoint.redoAll`/
   * `skills.toggle`/`toolsets.toggle`/`reload.mcp`/the allowlist guard)
   * moved onto {@link ControlDispatcher} verbatim — see its own doc for the
   * full routing-table rationale (unchanged). `session.load`/`loadTab`
   * reach back into {@link loadSessionIntoTab} (this class, NOT extracted)
   * through the injected port.
   */
  async invokeControl(method: string, params?: unknown): Promise<unknown> {
    return this.controlDispatcher.invokeControl(method, params);
  }

  // W6-FI-c: `fetchPanelData`/`withDefaultCheckpointsScope`/
  // `buildPanelDataMessage`/`toggleDashboard`/`toggleDashboardInner`/
  // `extractPanel`/`snapshotCheckpoint`/`warmCheckpointBaseline`/
  // `restoreCheckpoint`/`redoCheckpoint`/`resolveRestoreTargetRoot` all
  // moved onto `ControlDispatcher` verbatim — their only callers
  // (`invokeControl`'s branches, `ConnectionSupervisorHostPort
  // .warmCheckpointBaseline`) moved/were-updated with them. See
  // `ControlDispatcher.ts` for the full unchanged rationale each carried.

  /**
   * Zone HIST / §2c routing table: the router half of a History-panel load
   * — verifies a live client exists, refuses while the TARGET TAB already
   * has a live turn (P3), confines `cwd` to the workspace (vscode-backed,
   * stays here), then mints a FRESH controller for the loaded session and
   * disposes the tab's PRIOR controller (F6), delegating the session-scoped
   * replay bookkeeping to {@link SessionController.loadReplay}. `tabId`
   * defaults to the shared `BOOTSTRAP_TAB_ID`: the legacy control-method
   * caller (`invokeControl('session.load', …)`) has no per-tab wire field;
   * real per-tab wiring rides `tab.load` (§2d).
   *
   * W4-T5a (deliverable 3, replaces the T1a active-controller-reuse
   * approximation):
   * - **P3 is TAB-scoped, not ambient-active** (§3.2: a replay never touches
   *   the worktree, so this is a live-turn refusal on the TARGET tab's own
   *   controller — distinct from the root-scoped restore/redo interlock).
   *   `getByTabId` finds that controller directly; a busy SIBLING tab never
   *   blocks a load into an idle one (the T1a approximation's bug — it read
   *   `this.activeController()`, i.e. whichever session happened to be
   *   "active" connection-wide, not the tab actually being loaded into).
   * - **Mint FRESH, home to the ADOPTED cwd's root (F6 cross-root re-home):**
   *   `this.sessions.open(sessionId, adoptedCwd, this.buildSessionPort(...))`
   *   resolves `port.root` via `resolveRootCoordinator(adoptedCwd)` — the
   *   RootCoordinator for adoptedCwd's OWN containing root, never the prior
   *   tab's. A tab loaded into a different-root session is re-homed to that
   *   root's lease + tracker automatically, by construction.
   * - **Dispose the tab's PRIOR controller FIRST** (before minting), via the
   *   registry's F6 remove-before-dispose `close` — reused verbatim, no
   *   second removal path. Disposing first (not after) matters when the
   *   loaded `sessionId` happens to equal the prior controller's own id (a
   *   same-tab reload): minting first would let `sessions.open` overwrite
   *   the map slot, and a subsequent `close(target.sessionId)` would then
   *   remove+dispose the WRONG (freshly-minted) controller.
   * - **C1 fix (concurrency review): re-read the occupant AFTER the
   *   confinement await, not before.** The tab's occupant is captured twice
   *   — `target` at :1601 (a pre-check for the P3 live-turn guard, read
   *   before ANY await) and `currentOccupant`, re-read via
   *   `sessions.getByTabId(tabId)` immediately before the dispose/
   *   `activeSessionId` comparison below, AFTER the confinement `await`
   *   (present whenever a workspace is open). Two concurrent same-tab loads
   *   can both capture the SAME `target` before either resumes; whichever
   *   resumes first mints its own controller into this tab, so whichever
   *   resumes second must dispose THAT one, not the stale pre-await
   *   `target` (which disposing would silently no-op, since the registry no
   *   longer holds it) — otherwise the second load's own controller leaks
   *   into the tab alongside the first's, and both later emit into the same
   *   tab. The re-read makes the F6 dispose-then-mint choreography (and its
   *   `activeSessionId` bookkeeping) always target whatever is ACTUALLY
   *   registered for this tab right now.
   * - **mode.state mirrors openSession's emission set** (M#2 close): a
   *   History-loaded tab must populate its picker exactly like a fresh
   *   session does — a freshly-minted controller has no custom mode yet.
   * - `tab.bound` is still emitted BEFORE the replay streams (§7 B9(b)).
   * - **W6-FB fix (3-way CODE Important, residue of the C1 fix above): the
   *   C1 re-read is TAB-scoped (`getByTabId(tabId)`) and never notices that
   *   the incoming `sessionId` is ALREADY registered under a DIFFERENT
   *   tab** — loading the SAME History row into two tabs used to leak the
   *   first tab's controller (`SessionRegistry.open` was an unconditional
   *   overwrite) and leave that tab a silent zombie. Fixed at TWO levels:
   *   `SessionRegistry.open` itself now enforces "at most one live
   *   controller per sessionId" (removes-then-disposes any existing
   *   same-sessionId controller before minting — the registry-level
   *   invariant, robust to every caller); this method additionally
   *   captures `orphanedTabId` (the prior owner's tab, if different from
   *   this load's `tabId`) BEFORE minting and fires the EXISTING
   *   `tab.error{kind:'session-lost'}` terminal signal for it afterward —
   *   the orphaned tab's own webview affordance, reusing the T5a recovery
   *   machinery rather than inventing a new signal.
   */
  /**
   * W4-T5b (§2d `tab.load` wire): the PUBLIC entry for a tab-scoped History
   * load — a thin wrapper over the private {@link loadSessionIntoTab} above
   * (T5a's already-hardened mint/re-home/mode.state path), passing an
   * EXPLICIT `tabId` instead of that method's `BOOTSTRAP_TAB_ID` default. No
   * new load/mint/confinement/concurrency logic here — `loadSessionIntoTab`
   * itself already re-reads the tab's occupant after its confinement await
   * (C1) and handles two rapid same-tab loads correctly; this method only
   * makes it reachable from the webview's `tab.load` message.
   *
   * NEVER throws to the caller (mirrors {@link openTab}'s fire-and-forget +
   * terminal-reply discipline): `loadSessionIntoTab`'s own early-return
   * branches already emit the tab-scoped `error` (no live client, cwd
   * outside the workspace, target tab busy) or simply no-op, so this
   * try/catch only guards a genuinely unexpected rejection — defense in
   * depth, the same posture {@link openTabInternal} takes around
   * `openSession`.
   *
   * W6-FI-c (3-way ARCH I-4, part 3 of 3): a thin passthrough to {@link
   * controlDispatcher} — the try/catch wrapper (previously inline here)
   * moved onto {@link ControlDispatcher} verbatim; it reaches back into
   * THIS class's {@link loadSessionIntoTab} (not extracted) through the
   * injected port.
   */
  async loadTab(tabId: string, sessionId: string, cwd: string): Promise<void> {
    return this.controlDispatcher.loadTab(tabId, sessionId, cwd);
  }

  /**
   * CF-01/L3-1 (closes the C1/W6-FB/W6-FG cross-tab race family's
   * generator): the tail-wrapped ENTRY — BOTH callers (`invokeControl`'s
   * `session.load` branch and `loadTab`/`tab.load`, via the SAME injected
   * `ControlDispatcherHostPort.loadSessionIntoTab` accessor, :436) reach the
   * real body exclusively through this method, so wrapping HERE — once —
   * covers both entry points, exactly mirroring how {@link openTab} wraps
   * {@link openTabInternal}. Chains onto the SAME `inFlightStart` tail
   * `start()`/`openTab`/`closeTab` use, via {@link
   * ConnectionSupervisor.runOnStartTail}: a load can no longer interleave
   * with a start/respawn-recovery/openTab/another load/a close. See
   * `ConnectionSupervisor.recoverSessions`/`recoverOneSession`'s own doc for
   * the exact W6-FG race this retires (a `tab.load` racing a still-in-flight
   * respawn recovery). The C1 post-confinement-await re-read and the W6-FB
   * registry-level same-`sessionId` dedup INSIDE {@link
   * loadSessionIntoTabInternal} are UNCHANGED — kept as redundancy, not
   * removed (see that method's own doc, preserved verbatim).
   *
   * NO SELF-DEADLOCK: `loadSessionIntoTabInternal`'s body never calls
   * `start`/`openTab`/`closeTab`/`loadSessionIntoTab` (itself) — it only
   * reaches `this.sessions.*`/`this.buildSessionPort`/
   * `this.announceSessionBound`/`controller.loadReplay`, none of which touch
   * `runOnStartTail` — so this enqueues exactly once per call, at this outer
   * entry, never re-entering the tail from within an already-queued link.
   */
  private async loadSessionIntoTab(
    sessionId: string,
    cwd: string,
    tabId: string = BOOTSTRAP_TAB_ID,
  ): Promise<AcpLoadSessionResult | undefined> {
    return this.connectionSupervisor.runOnStartTail(() =>
      this.loadSessionIntoTabInternal(sessionId, cwd, tabId),
    );
  }

  private async loadSessionIntoTabInternal(
    sessionId: string,
    cwd: string,
    tabId: string,
  ): Promise<AcpLoadSessionResult | undefined> {
    if (!this.connectionSupervisor.getClient()) {
      this.logger?.append(`[AcpBackend] session.load: no live client (sessionId=${sessionId}, cwd=${cwd})`);
      return undefined;
    }

    // P3 (W4-T5a): refuse while the TARGET TAB's own controller has a live
    // turn — never the ambient "active" session (a busy sibling tab must
    // not block a load into an idle one).
    const target = this.sessions.getByTabId(tabId);
    if (target?.hasLiveTurn()) {
      this.emitter.fire({
        type: 'error',
        sessionId: target.sessionId,
        message: 'A turn is still running — wait for it to finish (or cancel it) before loading another session.',
      });
      return undefined;
    }

    // S-M4 / Sec-M2: scope the load `cwd` to an OPEN workspace folder.
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    let adoptedCwd = cwd;
    if (roots.length > 0) {
      const confined = await resolveWithinWorkspaceReal(cwd, roots);
      if (confined === null) {
        this.logger?.append(`[AcpBackend] session.load denied — cwd outside the workspace: ${cwd}`);
        return undefined;
      }
      adoptedCwd = confined;
    }

    // C1 (independent concurrency review, W4-T5a fix pass): re-read the
    // tab's occupant HERE, after the confinement await above — `target`
    // (captured before that await, :1601) can be STALE by now: a concurrent
    // same-tab load that resumed first has already closed `target` and
    // minted its OWN controller in its place. Disposing/comparing against
    // the stale `target` would silently no-op the close (the registry no
    // longer holds it) and leak the racing controller forever — the actual
    // bug this re-read fixes. When `roots.length === 0` above, there is no
    // await between :1601 and here, so `currentOccupant` is always
    // IDENTICAL to `target` and this is a no-op for that branch.
    const currentOccupant = this.sessions.getByTabId(tabId);

    // W6-FB (3-way CODE Important — same `sessionId` loaded into two
    // DIFFERENT tabs): captured at the SAME post-confinement-await
    // checkpoint as the C1 re-read above, so it reflects whichever
    // controller is ACTUALLY registered for `sessionId` right now, not a
    // stale pre-await snapshot. MUST be read before `sessions.open` below —
    // once that call returns, the registry-level invariant (`SessionRegistry
    // .open`) has already disposed this controller and evicted it from the
    // map, so its `tabId` would be unrecoverable. `undefined` here covers
    // both "sessionId not registered anywhere yet" and "already registered
    // under THIS SAME tab" (an ordinary same-tab reload — not an orphan).
    const priorOwner = this.sessions.get(sessionId);
    const orphanedTabId = priorOwner && priorOwner.tabId !== tabId ? priorOwner.tabId : undefined;

    // F6: dispose the tab's PRIOR controller FIRST (remove-before-dispose,
    // reused verbatim) — BEFORE minting, so a same-id reload never disposes
    // the freshly-minted replacement instead of the stale one.
    if (currentOccupant) this.sessions.close(currentOccupant.sessionId);

    // F6 cross-root re-home: mint FRESH, homed to the ADOPTED cwd's root.
    // W6-FB: `SessionRegistry.open` itself now enforces "at most one live
    // controller per sessionId" — if `priorOwner` above is still registered
    // (the cross-tab collision; an ordinary same-tab reload's `priorOwner`
    // was ALREADY removed by the `close` just above, so this is a no-op
    // there), this call removes-then-disposes it before minting, so the
    // cross-tab collision can never leak a controller or double-emit
    // (mirrors the C1 same-tab guarantee, now enforced at the registry).
    const controller = this.sessions.open(
      sessionId,
      adoptedCwd,
      this.buildSessionPort(sessionId, adoptedCwd),
      tabId,
    );
    if (this.activeSessionId === undefined || this.activeSessionId === currentOccupant?.sessionId) {
      this.activeSessionId = sessionId;
      this.cwd = adoptedCwd;
    }
    // X3: a new session context — drop the paginated sessions accumulation so
    // the History panel doesn't carry the old workspace's pages forward.
    this.resetSessionsAccumulation();

    // W6-FB: the orphaned tab (`orphanedTabId`) never had ITS OWN occupant
    // swapped — the registry now resolves `sessionId` to the tab THIS call
    // just bound it to, so without an explicit signal the orphaned tab would
    // sit in the webview still showing `sessionId`, bound to a controller
    // that was just disposed out from under it, with no affordance (a
    // silent zombie). Reuse the EXISTING T5a terminal signal verbatim — the
    // SAME `tab.error{kind:'session-lost'}` a failed respawn recovery fires
    // (§7 B8) — rather than inventing a new one.
    if (orphanedTabId !== undefined) {
      this.emitter.fire({
        type: 'tab.error',
        tabId: orphanedTabId,
        kind: 'session-lost',
        message: 'This session was loaded into another tab.',
      });
    }

    // §7 B9(b): announce the binding BEFORE the replay streams. M#2 (T4b
    // carry, closed): via the shared {@link announceSessionBound}
    // (W6-P7-N11) — mirrors openSession's emission set, a History-loaded tab
    // starts with no custom mode, so its picker populates.
    this.announceSessionBound(tabId, sessionId, controller.getRootId());

    // CF-01/L3-1 fix (Critical — 3-lens review of the tail-serialization
    // commit): `client.loadSession` (inside `loadReplay`) had NO wall-clock
    // deadline at all — only `AcpClient.raceTermination`'s child-EXIT-only
    // race. Before this commit that was merely a LOCALIZED hang (this one
    // tab's load); now that this whole method is tail-serialized (see
    // `loadSessionIntoTab`'s own doc), a hung-but-alive child wedges the
    // ENTIRE topology tail forever — every subsequent `openTab`/`closeTab`/
    // `loadSessionIntoTab`/`start` chains behind it. Mirrors
    // `recoverOneSession`'s `SESSION_ESTABLISH_DEADLINE_MS` deadline via
    // {@link ConnectionSupervisor.raceSessionLoadAgainstDeadline} — see that
    // method's own doc for why it is DELIBERATELY NOT a reuse of
    // `raceAgainstChildExit` (that helper cannot distinguish "the deadline
    // fired" from "`loadReplay` genuinely resolved `undefined`" — the
    // ordinary `found:false`/rejected-load outcome, which already emits its
    // OWN session-scoped `error` via `loadReplay` itself and must NOT also
    // get a second, duplicate `tab.error` here).
    const mcpServers = [...this.mcpServers.values()];
    const loadReplay = controller.loadReplay(cwd, sessionId, adoptedCwd, mcpServers);
    const outcome = await this.connectionSupervisor.raceSessionLoadAgainstDeadline(loadReplay);
    if (outcome.kind === 'timeout') {
      // The child stayed ALIVE but never answered within
      // SESSION_ESTABLISH_DEADLINE_MS. JS promises can't be cancelled — the
      // original `loadReplay` keeps running in the background and MAY still
      // belatedly resolve. Identity-guarded close (mirrors
      // `recoverOneSession`'s own guard, W6-FG) de-fangs that: disposing
      // `controller` now sets `this.replay = undefined` on it, which trips
      // `loadReplay`'s own supersede recheck (`this.replay !== replay`) the
      // moment the belated `client.loadSession` finally settles, making that
      // continuation a silent no-op instead of emitting stale `clear`/
      // `turn.start`/`turn.end` into a tab we already told the user timed
      // out. Emits the SAME tab-chrome restart affordance
      // (`tab.error{kind:'session-lost'}`, §7 B8) the recovery path's own
      // timeout uses, and — by returning — RELEASES the topology tail for
      // the next queued link.
      if (this.sessions.get(sessionId) === controller) this.sessions.close(sessionId);
      this.emitter.fire({
        type: 'tab.error',
        tabId,
        kind: 'session-lost',
        message: 'The agent did not respond while loading this session — try again.',
      });
      return undefined;
    }
    return outcome.value;
  }

  dispose(): void {
    // W6-FI-b: `this.acpState = 'disposed'; this.clearAcpRespawnTimer();`
    // moved onto `connectionSupervisor.markDisposed()` verbatim — see that
    // method's own doc for why bundling these two (previously inline,
    // adjacent, synchronous) statements into one call is behavior-preserving.
    this.connectionSupervisor.markDisposed();
    this.customModesConfigSub.dispose();
    // W4-T2 (§2a): a `RootCoordinator`'s lifetime is "first controller on
    // that root -> extension deactivate" — `dispose()` IS that deactivate
    // choke-point (also reached on the mock->real trust-upgrade swap, which
    // disposes the OLD backend; the NEW one gets its own fresh registry).
    this.rootRegistry.disposeAll();
    // §2c req 5: `teardownSession()` below settles any in-flight one-shot
    // (`oneShotRunner.settleAll`) — this IS the "dispose" choke-point the
    // requirement pins; no separate call is needed since dispose()
    // unconditionally tears the session(s) down first. W6-FI-b: `teardownSession`
    // moved onto {@link connectionSupervisor} verbatim — called at the SAME
    // position (after `rootRegistry.disposeAll()`, before `control.dispose()`).
    this.connectionSupervisor.teardownSession();
    this.control.dispose();
    // A#10: the backend OWNS its dashboard channel's lifecycle — dispose it here
    // rather than via a separate `extension.ts` subscription, so the mock->real
    // trust-upgrade swap (which disposes the old backend) also tears its
    // dashboard down. Idempotent (`HermesDashboardManager.dispose`).
    this.dashboard?.dispose();
    this.emitter.dispose();
  }

  // --- ACP client callbacks --------------------------------------------------

  /**
   * §2c routing table: FIRST branch = the existing ephemeral one-shot
   * stream catch (§7 sync-1 — the one-shot's stream must be caught BEFORE
   * the registry lookup or commit-gen hangs to its deadline); THEN
   * `this.sessions.get(sessionId)?.applyUpdate(update)`; unknown sessionId
   * → DROP with a dev-log (never throw, never `!`) — background tabs now
   * stream instead of being silently discarded.
   *
   * W6-FI-a: the `has`/`collect` pair on {@link oneShotRunner} replaces the
   * direct `ephemeral` map lookup (3-way ARCH I-4's exact recommended seam)
   * — same ephemeral-FIRST branch behavior, now delegated.
   */
  private handleSessionUpdate(sessionId: string, update: AcpSessionUpdate): void {
    if (this.oneShotRunner.has(sessionId)) {
      this.oneShotRunner.collect(sessionId, update);
      return;
    }
    // CF-01/L3-1 fix (Minor, optional per review): a session mid-`closeTab`
    // is about to be gone — drop its stream fan-out too, same rationale as
    // {@link sendPrompt}'s guard above (see {@link pendingClose}'s own doc).
    if (this.pendingClose.has(sessionId)) {
      this.logger?.append(`[AcpBackend] session/update for closing session '${sessionId}' — dropped`);
      return;
    }

    const controller = this.sessions.get(sessionId);
    if (!controller) {
      this.logger?.append(`[AcpBackend] session/update for unknown session '${sessionId}' — dropped`);
      return;
    }
    controller.applyUpdate(update);
  }

  /**
   * §2c/§3.1(a): the session-keyed permission dispatch — T1a scope: mint
   * `approvalId` (the process-unique `approvalCounter` STAYS here) and
   * delegate to the live controller's `handlePermission`; else PRESERVE
   * today's ephemeral/one-shot + fallback path UNCHANGED (T1b hardens the
   * else branch into the full §3.1 fail-closed dispatch table).
   */
  private async handleRequestPermission(req: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse> {
    // W4-T1b hardening (§3.1 dispatch edges): a nullish/empty runtime
    // `sessionId` is defensive-only (the wire type is a required `string`) —
    // `Map.get` of such a value already resolves to `undefined` and falls
    // through to the fail-closed branch below, so this guard changes no
    // OUTCOME. It exists so the audit trail says WHY (malformed, not merely
    // foreign) and so the fail-closed default is asserted explicitly ahead
    // of the lookup, not merely inherited from `Map`'s behavior.
    if (!req.sessionId) {
      this.logger?.append(
        '[policy] permission request with a malformed/absent sessionId — auto-denied (fail-closed)',
      );
      return buildCancelledOutcome();
    }

    const controller = this.sessions.get(req.sessionId);
    if (controller) {
      this.approvalCounter += 1;
      return controller.handlePermission(req, `appr-${this.approvalCounter}`);
    }

    if (this.oneShotRunner.has(req.sessionId)) {
      this.logger?.append(
        `[policy] permission request on ephemeral one-shot session '${req.sessionId}' — auto-denied (a one-shot needs no tools)`,
      );
    } else {
      this.logger?.append(
        `[policy] permission request on unrecognized session '${req.sessionId}' — auto-denied (fail-closed)`,
      );
    }
    return buildCancelledOutcome();
  }

  /** The open workspace folder roots (POSIX on the Fedora target), for policy signal building. */
  private workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  /**
   * Backs the client's `readTextFile` (advertised `fs.readTextFile: true`).
   * SECURITY (security-review.md M1 / hardening S-M5): the requested path is
   * confined to the open workspace folder(s) before any read, AFTER resolving
   * symlinks.
   */
  private async handleReadTextFile(
    path: string,
    line: number | null | undefined,
    limit: number | null | undefined,
  ): Promise<string> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const safePath = await resolveWithinWorkspaceReal(path, roots);
    if (!safePath) {
      const symlinkEscape = resolveWithinWorkspace(path, roots) !== null;
      this.logger?.append(
        `[AcpBackend] readTextFile denied — ${symlinkEscape ? 'symlink target escapes workspace' : 'path outside workspace'}: ${path}`,
      );
      throw new Error(
        symlinkEscape
          ? `readTextFile denied: '${path}' resolves through a symlink to a location outside the workspace. If this access is intentional, add that location as a workspace folder.`
          : 'readTextFile denied: path is outside the workspace root(s).',
      );
    }
    let bytes: Buffer;
    if (await this.confinedReader.supported()) {
      // F1: a windowed read (`limit` given) never needs the whole file —
      // cap the confined read so a pathologically large file can't OOM the
      // host. `limit == null` (the caller wants the whole file) stays
      // unbounded, unchanged.
      const maxBytes = limit != null ? MAX_WINDOWED_READ_BYTES : undefined;
      const res = await this.confinedReader.readContained(safePath, roots, maxBytes);
      if (!res.ok) {
        this.logger?.append(
          `[AcpBackend] readTextFile confined-read denied (${res.denial.kind}): ${path}`,
        );
        throw new Error(this.confinedDenialMessage(res.denial, path));
      }
      bytes = res.bytes;
    } else {
      bytes = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(safePath)));
    }
    const text = bytes.toString('utf-8');
    if (line == null && limit == null) return text;
    // D3: fail-visible on out-of-range wire integers rather than the prior
    // silent coercion (limit:-5 -> empty window; line:NaN -> slice(NaN) === 0
    // -> whole-file-from-0). OWASP Input Validation Cheat Sheet: reject
    // out-of-range/non-integer input rather than sanitizing/coercing it. No
    // wire-supplied value is interpolated into the message (invariant #3).
    if (line != null && (!Number.isInteger(line) || line < 1)) {
      throw new Error('readTextFile: line must be a positive integer.');
    }
    if (limit != null && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error('readTextFile: limit must be a non-negative integer.');
    }
    const lines = text.split('\n');
    const start = line != null ? Math.max(0, line - 1) : 0;
    const end = limit != null ? start + limit : lines.length;
    return lines.slice(start, end).join('\n');
  }

  /** Map a confined-read denial to a user-actionable `readTextFile` error message. */
  private confinedDenialMessage(denial: ConfinedReadDenial, requested: string): string {
    switch (denial.kind) {
      case 'escape':
        return `readTextFile denied: '${requested}' resolves through a symlink to a location outside the workspace. If this access is intentional, add that location as a workspace folder.`;
      case 'not-regular':
        return `readTextFile denied: '${requested}' is not a regular file.`;
      case 'gone':
        return `readTextFile failed: '${requested}' no longer exists.`;
      case 'unsupported':
      case 'io':
        return `readTextFile failed: could not read '${requested}'.`;
    }
  }

  /** X3: clear the Sessions source's paginated accumulation (new session / `session/load`). */
  private resetSessionsAccumulation(): void {
    this.panelSources.get('sessions').reset?.();
  }

  // W6-FI-b: `teardownSession`/`handleAcpCrash`/`scheduleAcpRespawn`/
  // `clearAcpRespawnTimer` moved onto {@link ConnectionSupervisor} verbatim
  // (behavior-preserving MOVE + DI) — see that class's own doc for the full
  // rationale each carried. `dispose()` above calls the two still-needed
  // from here (`markDisposed`/`teardownSession`) at the SAME positions the
  // inlined code occupied.
}

// --- module-local helpers ----------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * W4-T2: is `child` at or below `parent`? Mirrors `pathConfine.ts`'s own
 * `isWithin` (kept local — that module's version isn't exported, and this
 * is a cheap lexical containment check over already-`path.resolve`'d
 * strings, not a security boundary — `resolveRootCoordinator` only ever
 * uses it to pick WHICH already-open workspace folder a cwd belongs to).
 */
function isPathWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// W6-FI-c: `isReloadedResult`/`extractLoadParams`/`extractToggleParams`/
// `TURN_ACTIVE_RESTORE_REFUSAL`/`AMBIGUOUS_ROOT`/`UNKNOWN_ROOT_RESTORE_REFUSAL`/
// `extractRestoreParams`/`CHECKPOINT_LABEL_MAX_LEN`/`truncateCheckpointLabel`
// all moved onto `ControlDispatcher.ts` verbatim (module-local helpers of the
// methods that moved with them).
