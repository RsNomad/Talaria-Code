import type {
  HostToWebview,
  ControlMethod,
  DataPanel,
  EditPolicyPreset,
  HydrateTabSeed,
  SlashCommandInfo,
} from '../../../shared/protocol';
import { CONTROL_METHODS } from '../../../shared/protocol';
import type { RootCoordinator } from '../../checkpoints/RootCoordinator';
import type { RootRegistry } from '../../checkpoints/rootRegistry';
import type { Logger } from '../../transport/JsonRpcStdio';
import type { PanelSourceRegistry } from '../../panels/PanelSourceRegistry';
import type { DashboardService } from '../../dashboard/HermesDashboardManager';
import type { AcpLoadSessionResult } from '../acp/acpClient';
import type { SessionRegistry } from '../session/SessionRegistry';
import { ConfigWriteTail } from './configWriteTail';
import { PanelDataCoordinator } from './panelDataCoordinator';
import { McpAdminHandler, isMcpAdminMethod } from './mcpAdminHandler';
import { SkillsAdminHandler, isSkillsAdminMethod } from './skillsAdminHandler';
import { CheckpointActionHandler } from './checkpointActions';
import { DashboardToggleHandler } from './dashboardToggles';
import { SessionScopeActions } from './sessionScopeActions';
import { errorMessage } from '../../../shared/errorMessage';

/**
 * WS-GD.2a A5: `TRUST_GATED_METHODS` now lives on `adminOpRunner.ts` (its
 * own full doc moved there verbatim) — re-exported here so
 * `AcpBackend.test.ts`'s partition-lock import path (`./control/
 * ControlDispatcher`) stays stable.
 */
export { TRUST_GATED_METHODS } from './adminOpRunner';

/**
 * Task A6 (§4.8): the narrowed `CancellationToken` shape {@link
 * ControlDispatcherHostPort.withProgress} hands `mcp.auth`'s task callback —
 * exactly the two members that callback reads.
 */
export interface McpAuthCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(cb: () => void): { dispose(): void };
}

// WS-GD.2a A6: `McpAdminMethod`/`isMcpAdminMethod` moved onto
// `mcpAdminHandler.ts` (own docs moved there verbatim) — imported above.

// WS-GD.2a A7: `SkillsAdminMethod`/`isSkillsAdminMethod` moved onto
// `skillsAdminHandler.ts` (own docs moved there verbatim) — imported above.

/**
 * W6-FI-c (3-way ARCH I-4, part 3 of 3): the dependencies {@link
 * ControlDispatcher} needs from its host, injected so this class never
 * imports `vscode` and stays unit-testable in isolation — mirrors {@link
 * ../oneshot/OneShotRunner.OneShotHostPort}/{@link
 * ../connection/ConnectionSupervisor.ConnectionSupervisorHostPort}'s own
 * accessor-at-call-time posture. `panelSources`/`sessions`/`rootRegistry`
 * are passed BY REFERENCE (not accessors) — all three are `readonly` fields
 * on `AcpBackend`, constructed once and never reassigned, so the SAME live
 * instance `AcpBackend` itself uses is threaded through here (mirrors
 * `ConnectionSupervisorHostPort.sessions`'s own precedent).
 */
export interface ControlDispatcherHostPort {
  /** The tui_gateway control-plane dispatch (`AcpBackend`'s `ControlChannel.dispatch`). */
  dispatch(method: string, params?: unknown): Promise<unknown>;
  /** Fires a HostToWebview message (`AcpBackend`'s emitter). */
  emit(msg: HostToWebview): void;
  logger?: Logger;
  /** The panel-fetch strategy registry (Zone Z3, finding A1) — the SAME live instance `AcpBackend.registerPanelSource` mutates. */
  panelSources: PanelSourceRegistry;
  /** The per-session actor registry — read at call time via the reference itself (a `Map`-backed registry, not a snapshot). */
  sessions: SessionRegistry;
  /**
   * BH-02 (round-2): `true` while `AcpBackend.pendingClose` tombstones
   * `sessionId` — the close was requested but its registry removal is still
   * deferred on the start tail (see `AcpBackend.pendingClose`'s own doc). The
   * hydrate seed ({@link SessionScopeActions.listTabs}) excludes such a
   * session so a webview dispose/recreate in that window never re-seeds a tab
   * the user has already closed — the SAME tombstone honor
   * `ConnectionSupervisor`'s crash snapshot already applies
   * (`ConnectionSupervisorHostPort.isPendingClose`).
   */
  isPendingClose(sessionId: string): boolean;
  /** `Map<canonicalRoot, RootCoordinator>` — checkpoint restore/redo/baseline root routing + the single-root convenience fallback. */
  rootRegistry: RootRegistry;
  /** Resolve (or mint) the `RootCoordinator` owning `cwd`'s containing workspace root — accessor (fs-realpath resolution stays host-side, `AcpBackend`'s own `resolveRootCoordinator`). */
  resolveRootCoordinator(cwd: string): RootCoordinator;
  /** The connection's current resolved boot cwd (`AcpBackend.cwd`) — the session-baseline snapshot's root target. */
  getConnectionCwd(): string | undefined;
  /** The most-recently-opened/loaded session's id, or `undefined` — the ambient last-resort `activeController()` reads (W6-FG sanctioned exception, see that method's own doc below). */
  getActiveSessionId(): string | undefined;
  /** The optional dashboard REST channel (Skills/Tools toggle backing) — `undefined` when not wired. */
  getDashboard(): DashboardService | undefined;
  /** Surface a non-blocking warning to the user (`vscode.window.showWarningMessage`) — injected so this module stays vscode-free, mirroring every other extracted subsystem's DI posture. */
  showWarningMessage(message: string): void;
  /**
   * Task A5 (§3 Layer 5, §4.5): `() => vscode.workspace.isTrusted` — the
   * dispatcher-side trust gate for {@link TRUST_GATED_METHODS}, defense-in-
   * depth over `trustGate.ts`'s existing "no ACP backend in an untrusted
   * workspace" gate (a SECOND, independent check on the control-method
   * surface itself).
   */
  isTrusted(): boolean;
  /**
   * Task A5 (§3 Layer 3, §4.5): the native consent modal —
   * `vscode.window.showWarningMessage(message, { modal: true, detail },
   * actionLabel) === actionLabel` (Context7-pinned `MessageOptions.detail`
   * renders only for modal messages). A compromised webview can at most
   * summon this dialog; it can never answer it.
   */
  confirm(message: string, detail: string, actionLabel: string): Promise<boolean>;
  /**
   * Rev-1 B4 (CF-13 parity, TH-4): the masked, host-side credential prompt —
   * `vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut:
   * true })`, the SAME masked-seam idiom `promptAndSaveProviderKey`
   * (`TalariaViewProvider.ts`) and `setupHost.vscode.ts`'s
   * `showPasswordInput` already use. Resolves the entered secret, or
   * `undefined` when the user dismisses the prompt (Escape / clicks away)
   * — {@link ControlDispatcher.mcpCatalogInstall} treats BOTH an
   * `undefined` answer AND an empty string as a decline of the WHOLE
   * install (no partial install). Called ONLY after the install's native
   * consent modal ({@link confirm}) is confirmed, once per
   * `entry.required_env` var — MCP catalog API keys must never be typed
   * into the webview (CF-13: "keys never enter the webview; the host
   * prompts for them, masked").
   */
  promptSecret(prompt: string): Promise<string | undefined>;
  /**
   * Task A6 (§4.8, Context7-pinned `window.withProgress<R>(options, task:
   * (progress, token: CancellationToken) => Thenable<R>): Thenable<R>` —
   * only `ProgressLocation.Notification` supports the cancel button): the
   * F-4 OAuth blocking-wait UX. `token` is narrowed to exactly the two
   * members `mcp.auth` reads (`isCancellationRequested` +
   * `onCancellationRequested`) — the real `vscode.CancellationToken` is a
   * strict superset, so `AcpBackend`'s implementation satisfies this
   * structurally without re-exporting a `vscode` type here.
   */
  withProgress<T>(title: string, task: (token: McpAuthCancellationToken) => Promise<T>): Promise<T>;
  /**
   * The C1/W6-FB entangled History-load choreography (`AcpBackend
   * .loadSessionIntoTab`) — too entangled with `openSession`/session-minting
   * to move (per the brief: "leave in the router anything too entangled").
   * This dispatcher only ever CALLS it (from `invokeControl`'s `session.load`
   * branch and from {@link ControlDispatcher.loadTab}) — it never
   * re-implements any part of that choreography.
   */
  loadSessionIntoTab(
    sessionId: string,
    cwd: string,
    tabId?: string,
    title?: string,
  ): Promise<AcpLoadSessionResult | undefined>;
}

/**
 * W6-FI-c (3-way ARCH I-4, part 3 of 3) — the control-message routing
 * surface: {@link invokeControl} (the webview→host control-method dispatch)
 * and every control-method handler that doesn't belong to the one-shot
 * subsystem (W6-FI-a, {@link ../oneshot/OneShotRunner.OneShotRunner}) or the
 * connection-lifecycle subsystem (W6-FI-b, {@link
 * ../connection/ConnectionSupervisor.ConnectionSupervisor}) — EXTRACTED off
 * `AcpBackend` (behavior-preserving MOVE + DI, mirroring both siblings'
 * posture exactly). `AcpBackend` still owns and delegates to it: every
 * moved method becomes a one-line passthrough on `AcpBackend`'s public
 * surface (`invokeControl`/`getPreset`/`getAvailableCommands`/`listTabs`/
 * `setCustomMode`/`loadTab`), exactly like {@link
 * ../oneshot/OneShotRunner.OneShotRunner}'s `oneShot()`/{@link
 * ../connection/ConnectionSupervisor.ConnectionSupervisor}'s `start()`
 * already do.
 *
 * **Left in the router (AcpBackend), NOT moved here — entangled or
 * out-of-scope:**
 * - `openSession`/`openTabInternal`/`loadSessionIntoTab` — the C1/W6-FB
 *   session-minting + History-load choreography (dispose-before-mint,
 *   post-confinement-await occupant re-read, orphaned-tab signal) is too
 *   entangled with `SessionRegistry.open`/`buildSessionPort` to extract
 *   verbatim; `loadSessionIntoTab` is called BY this class (`session.load`,
 *   `loadTab`) through the injected port, never re-implemented here.
 * - `sendPrompt`/`cancel`/`respondApproval`/`resolveDiff`/`setModel`/
 *   `setPreset`/`acceptWholeFileDiff` — the `AgentBackend` per-session
 *   routing table's OTHER five (six, counting `setModel`) one-line
 *   `this.sessions.get(sessionId)?.method(...)` passthroughs. `setModel` is
 *   architecturally IDENTICAL in shape to these — a routing-table
 *   passthrough, not a control-method handler — so it stays alongside its
 *   siblings rather than being cherry-picked out; moving one of six
 *   structurally-identical one-liners without the other five would be an
 *   arbitrary split, not a coherent seam.
 * - `resolveRootCoordinator`/`findContainingWorkspaceRoot`/
 *   `canonicalizeWorkspaceRoot`/the `rootRegistry` field itself — stay on
 *   `AcpBackend` because `buildSessionPort` (also not extracted) depends on
 *   them for every `SessionController` mint; this dispatcher reaches them
 *   only through the injected `resolveRootCoordinator`/`rootRegistry` port
 *   accessors, never re-implementing the fs-realpath resolution.
 * - `registerPanelSource` — a one-line wiring API `extension.ts` calls once
 *   at activation (not a per-message control dispatch); stays put, unchanged,
 *   still writing into the SAME `panelSources` registry this class reads.
 */
export class ControlDispatcher {
  /**
   * S-M4 / A#2 / Sec-M1: the RUNTIME allowlist of control methods {@link
   * invokeControl} will accept — see the original field doc on `AcpBackend`
   * (moved verbatim) for the full drift-proofing rationale.
   */
  private static readonly ALLOWED_CONTROL_METHODS: ReadonlySet<string> = new Set<ControlMethod | 'panel.data'>([
    ...CONTROL_METHODS,
    'panel.data',
  ]);

  private readonly configWriteTail = new ConfigWriteTail();

  /**
   * WS-GD.2a Task A4: the panels domain — see {@link PanelDataCoordinator}.
   * Constructed in the constructor from the SAME port this class receives
   * (the full `ControlDispatcherHostPort` structurally satisfies its
   * narrower `PanelDataPort` Pick).
   */
  private readonly panels: PanelDataCoordinator;

  /**
   * WS-GD.2a A6: the mcp-admin domain — see {@link McpAdminHandler}.
   * Constructed in the constructor from the SAME port + `configWriteTail`
   * this class owns, plus a `refetchPanel` callback bound to {@link panels}
   * (the full `ControlDispatcherHostPort` structurally satisfies its
   * narrower `McpAdminPort` Pick).
   */
  private readonly mcpAdmin: McpAdminHandler;

  /**
   * WS-GD.2a A7: the skills-admin domain — see {@link SkillsAdminHandler}.
   * Constructed in the constructor from the SAME port + `configWriteTail`
   * this class owns, plus a `refetchPanel` callback bound to {@link panels}
   * (the full `ControlDispatcherHostPort` structurally satisfies its
   * narrower `SkillsAdminPort` Pick).
   */
  private readonly skillsAdmin: SkillsAdminHandler;

  /**
   * WS-GD.2a A8: the checkpoints domain — see {@link CheckpointActionHandler}.
   * Constructed in the constructor from the SAME port this class owns, plus
   * a `fetchPanelData` callback bound to {@link panels} (the full
   * `ControlDispatcherHostPort` structurally satisfies its narrower
   * `CheckpointActionPort` Pick).
   */
  private readonly checkpoints: CheckpointActionHandler;

  /**
   * WS-GD.2a A9: the dashboard-toggles domain — see {@link
   * DashboardToggleHandler}. Constructed in the constructor from the SAME
   * port + `configWriteTail` this class owns (the full
   * `ControlDispatcherHostPort` structurally satisfies its narrower
   * `DashboardTogglePort` Pick).
   */
  private readonly dashboardToggles: DashboardToggleHandler;

  /**
   * WS-GD.2a A9: the sessions-scope domain — see {@link SessionScopeActions}.
   * Constructed in the constructor from the SAME port this class owns (the
   * full `ControlDispatcherHostPort` structurally satisfies its narrower
   * `SessionScopePort` Pick).
   */
  private readonly sessionScope: SessionScopeActions;

  constructor(private readonly port: ControlDispatcherHostPort) {
    this.panels = new PanelDataCoordinator(this.port);
    this.mcpAdmin = new McpAdminHandler(this.port, this.configWriteTail, (panel) => this.panels.fetchPanelData(panel));
    this.skillsAdmin = new SkillsAdminHandler(this.port, this.configWriteTail, (panel) => this.panels.fetchPanelData(panel));
    this.checkpoints = new CheckpointActionHandler(this.port, (panel, params) => this.panels.fetchPanelData(panel, params));
    this.dashboardToggles = new DashboardToggleHandler(this.port, this.configWriteTail);
    this.sessionScope = new SessionScopeActions(this.port);
    // CA-M04b: self-wire the per-session fetch-seq prune to the registry's
    // close choke point — every close path (tab close, rebind, swap-eviction,
    // failed/abandoned loads, crash-recovery failure, teardown disposeAll)
    // funnels through `SessionRegistry.close`/`disposeAll`, so this ONE hook
    // covers them all, present and future, with no per-site wiring.
    port.sessions.setOnClosed((sessionId) => this.panels.pruneFetchSeqForSession(sessionId));
  }

  /**
   * Thin passthrough to the control plane, with panel FETCHES unified behind
   * the {@link PanelSourceRegistry} (Zone Z3, finding A1). Moved verbatim off
   * `AcpBackend` — see the original method's doc for the full per-branch
   * routing-table rationale (unchanged).
   */
  async invokeControl(method: string, params?: unknown): Promise<unknown> {
    if (!ControlDispatcher.ALLOWED_CONTROL_METHODS.has(method)) {
      throw new Error(`Refusing to invoke disallowed control method '${method}'`);
    }

    const requestedPanel = this.panels.extractPanel(params);

    if (method === 'panel.data') {
      if (!requestedPanel) return undefined;
      return this.panels.fetchPanelData(requestedPanel, params);
    }

    if (method === 'session.list') {
      return this.panels.fetchPanelData('sessions', params);
    }

    if (method === 'session.load') {
      const { sessionId, cwd } = extractLoadParams(params);
      if (!sessionId || !cwd) {
        this.port.logger?.append(
          `[AcpBackend] session.load: missing sessionId/cwd (sessionId=${String(sessionId)}, cwd=${String(cwd)})`,
        );
        return undefined;
      }
      return this.port.loadSessionIntoTab(sessionId, cwd);
    }

    if (method === 'checkpoint.restore') {
      return this.checkpoints.restoreCheckpoint(params);
    }

    if (method === 'checkpoint.redo' || method === 'checkpoint.redoAll') {
      return this.checkpoints.redoCheckpoint(method, params);
    }

    if (method === 'skills.toggle' || method === 'toolsets.toggle') {
      const raw = await this.dashboardToggles.toggle(method, params);
      // BH-01 (ADR-R2-04): the toggle persisted server-side, but the response carries
      // only {ok,name,enabled}; the webview's V-11 reconcile shows `serverValue` once the
      // op settles, so the persisted list MUST be pushed BEFORE this RPC resolves
      // (postMessage is FIFO on one channel → the push folds first). The push is a
      // courtesy re-fetch of state that already persisted, so its failure must not
      // turn a successful toggle into a rejected RPC (ADR-R2-16) — see {@link rePushPanel}.
      const panel = method === 'skills.toggle' ? 'skills' : 'tools';
      await this.rePushPanel(panel, method);
      return raw;
    }

    // Task A5+A6 (§4.5, §4.7, §4.8): the full T1 MCP admin core —
    // add/remove/setEnabled/test/auth (A5) plus catalog/catalogInstall (A6).
    if (isMcpAdminMethod(method)) {
      return this.mcpAdmin.handle(method, params);
    }

    // Task B4 (§5.4): the T2 skills admin core — create/hubPreview/hubScan/
    // hubInstall. Task B5 adds `skills.hubUninstall` to the same core.
    if (isSkillsAdminMethod(method)) {
      return this.skillsAdmin.handle(method, params);
    }

    if (method === 'reload.mcp') {
      const raw = await this.port.dispatch(method, params);
      if (isReloadedResult(raw)) {
        // L2-CA-26 (ADR-R2-16 completion): the reload already persisted
        // server-side by the time `raw` resolves — see {@link rePushPanel}.
        await this.rePushPanel('mcp', method);
      }
      return raw;
    }

    if (method === 'model.save_key') {
      // CF-13/D1: `params` carries `{slug, api_key}` — the SECOND field is
      // the provider API key. It is passed straight through to
      // `this.port.dispatch` (the ONLY thing that needs it — the harness
      // persists it to `~/.hermes/.env`) and is otherwise untouched by this
      // branch: never logged, never inspected, never echoed into the
      // return value below. Mirrors `reload.mcp`'s "dispatch → refetch
      // panel" shape: on success (`{provider: <refreshed row>}`) the Models
      // panel is re-fetched FRESH (a real `model.options` read, not
      // anything fabricated from the request) and pushed; a failure (e.g.
      // the harness's 4006 "managed install" refusal) rejects this call
      // and never touches the panel. L2-CA-26 (ADR-R2-16 completion): the
      // save already persisted by the time `raw` resolves, so the refetch
      // itself must never turn that success into a rejection — see {@link
      // rePushPanel} (which also NEVER logs `params`, the API key).
      const raw = await this.port.dispatch(method, params);
      if (isSaveKeyResult(raw)) {
        await this.rePushPanel('models', method);
      }
      return raw;
    }

    return this.port.dispatch(method, params);
  }

  /**
   * CA-26 / ADR-R2-16 (completes C1/BH-01, which applied this pattern to the
   * toggle branches only): a panel re-push is a courtesy re-fetch of state
   * that ALREADY persisted server-side (the toggle write, the `reload.mcp`
   * confirm, the `model.save_key` provider write) by the time this is
   * called — its failure must never turn that successful, already-persisted
   * RPC into a rejected one. All three panel-mutating branches
   * (`skills.toggle`/`toolsets.toggle`, `reload.mcp`, `model.save_key`) route
   * through this ONE helper instead of each carrying its own try/catch.
   * NEVER logs `params` — `model.save_key`'s params carry the provider API
   * key (CF-13/D1); the log line names only the method and the caught
   * error's message.
   */
  private async rePushPanel(panel: DataPanel, method: string): Promise<void> {
    try {
      await this.panels.fetchPanelData(panel);
    } catch (err) {
      this.port.logger?.append(`[ControlDispatcher] ${method}: panel re-push failed (mutation persisted) — ${errorMessage(err)}`);
    }
  }

  // WS-GD.2a A9: `toggleDashboard`/`toggleDashboardInner`/`extractToggleParams`
  // moved onto `dashboardToggles.ts` (own docs moved there verbatim, the
  // public entry renamed `toggle`) — imported above.

  /**
   * WS-GD.2a Task A8: thin delegator — the full Zone CKPT / C1 warm-index
   * doc moved WITH the implementation onto {@link CheckpointActionHandler
   * .warmCheckpointBaseline}. The PUBLIC surface (the port thunk
   * `AcpBackend` builds calls this exact method) is unchanged.
   */
  warmCheckpointBaseline(): void {
    this.checkpoints.warmCheckpointBaseline();
  }

  /**
   * WS-GD.2a Task A9: thin delegator — the full W2-F1 wire-pin doc moved
   * WITH the implementation onto {@link SessionScopeActions.getPreset}. The
   * PUBLIC surface (`AcpBackend.getPreset` calls this exact method) is
   * unchanged.
   */
  getPreset(): EditPolicyPreset {
    return this.sessionScope.getPreset();
  }

  /**
   * WS-GD.2a Task A9: thin delegator — the full W2 F-S doc moved WITH the
   * implementation onto {@link SessionScopeActions.getAvailableCommands}.
   * The PUBLIC surface (`AcpBackend.getAvailableCommands` calls this exact
   * method) is unchanged.
   */
  getAvailableCommands(): SlashCommandInfo[] | undefined {
    return this.sessionScope.getAvailableCommands();
  }

  /**
   * WS-GD.2a Task A9: thin delegator — the full W6-FF/H4-B8 doc moved WITH
   * the implementation onto {@link SessionScopeActions.listTabs}. The
   * PUBLIC surface (`AcpBackend.listTabs` calls this exact method) is
   * unchanged.
   */
  listTabs(): HydrateTabSeed[] {
    return this.sessionScope.listTabs();
  }

  /**
   * WS-GD.2a Task A9: thin delegator — the full W4-T4b mitigation-1 doc (and
   * the P7-N10 fan-out-deletion tombstone) moved WITH the implementation
   * onto {@link SessionScopeActions.setCustomMode}. The PUBLIC surface
   * (`AcpBackend.setCustomMode` calls this exact method) is unchanged.
   */
  setCustomMode(sessionId: string, modeId: string | null): void {
    this.sessionScope.setCustomMode(sessionId, modeId);
  }

  /**
   * WS-GD.2a Task A9: thin delegator — the full W4-T4b mitigation-2 doc
   * moved WITH the implementation onto {@link SessionScopeActions
   * .handleCustomModesConfigChanged}. The PUBLIC surface
   * (`AcpBackend.handleCustomModesConfigChanged` calls this exact method) is
   * unchanged.
   */
  handleCustomModesConfigChanged(): void {
    this.sessionScope.handleCustomModesConfigChanged();
  }

  /**
   * WS-GD.2a Task A9: thin delegator — the full W4-T5b doc moved WITH the
   * implementation onto {@link SessionScopeActions.loadTab}. The PUBLIC
   * surface (`AcpBackend.loadTab` calls this exact method) is unchanged.
   */
  async loadTab(tabId: string, sessionId: string, cwd: string, title?: string): Promise<void> {
    return this.sessionScope.loadTab(tabId, sessionId, cwd, title);
  }

  /**
   * WS-GD.2a Task A4: thin delegator — the full W6-FI-c Part 2 doc (the
   * checkpoints-panel refresh rationale) moved WITH the implementation onto
   * {@link PanelDataCoordinator.refreshCheckpointsPanel}. The PUBLIC surface
   * (`AcpBackend`/`RootCoordinator` call this exact method) is unchanged.
   */
  refreshCheckpointsPanel(rootId: string): void {
    this.panels.refreshCheckpointsPanel(rootId);
  }

  /**
   * WS-GD.2a Task A4: thin delegator — the full CA-M04 doc moved WITH the
   * implementation onto {@link PanelDataCoordinator.pruneFetchSeqForSession}.
   * The PUBLIC surface (the standing `ControlDispatcher.test.ts` reach-
   * through tests call this exact method) is unchanged.
   */
  pruneFetchSeqForSession(sessionId: string): void {
    this.panels.pruneFetchSeqForSession(sessionId);
  }
}

// --- module-local helpers ----------------------------------------------------

/**
 * `reload.mcp` only actually reloaded when `status === "reloaded"`. Moved
 * verbatim off `AcpBackend.ts`'s module-local helper of the same name.
 */
function isReloadedResult(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { status?: unknown }).status === 'reloaded';
}

/**
 * CF-13/D1: `model.save_key` succeeded — the harness returns
 * `{provider: <refreshed ModelOptionProvider row>}` (confirmed harness
 * contract, `server.py:12426-12503`). Mirrors {@link isReloadedResult}'s
 * shape-check posture: a failure rejects the whole `dispatch` call instead
 * of resolving here, so this only ever gates the Models panel refetch on an
 * actual success.
 */
function isSaveKeyResult(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { provider?: unknown }).provider !== undefined;
}

/** Zone HIST: pull `{sessionId, cwd}` out of `session.load`'s params (the clicked `SessionSummary`). Moved verbatim. */
function extractLoadParams(params: unknown): { sessionId?: string; cwd?: string } {
  if (!params || typeof params !== 'object') return {};
  const p = params as { sessionId?: unknown; cwd?: unknown };
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined;
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

// WS-GD.2a A8: `TURN_ACTIVE_RESTORE_REFUSAL`/`AMBIGUOUS_ROOT`/
// `UNKNOWN_ROOT_RESTORE_REFUSAL`/`NO_TRACKER_RESTORE_REFUSAL`/
// `MALFORMED_RESTORE_REFUSAL`/`extractRestoreParams`/
// `CHECKPOINT_LABEL_MAX_LEN`/`truncateCheckpointLabel` moved onto
// `checkpointActions.ts` (own docs moved there verbatim) with the rest of
// the checkpoints domain.

// WS-GD.2a A9: `extractToggleParams` moved onto `dashboardToggles.ts` with
// the rest of the dashboard-toggles domain; the ORIGINAL `errorMessage` (this
// file's own copy) moved onto `sessionScopeActions.ts` — it had exactly one
// caller (`loadTab`), which moved with it. `activeController`/`getPreset`/
// `getAvailableCommands`/`listTabs`/`setCustomMode`/
// `handleCustomModesConfigChanged`/`loadTab` moved onto
// `sessionScopeActions.ts` (own docs moved there verbatim, including the
// P7-N10 tombstone) with the rest of the sessions-scope domain.
