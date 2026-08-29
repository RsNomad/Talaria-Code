import type {
  HostToWebview,
  ControlMethod,
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
import type { DashboardToggleResult } from '../../dashboard/HermesDashboardClient';
import { hasToggleNameCache } from '../../dashboard/dashboardPanelSources';
import type { AcpLoadSessionResult } from '../acp/acpClient';
import { readCustomModes, toCatalog, buildModeFloorSnapshot } from '../customModes';
import type { SessionController } from '../session/SessionController';
import type { SessionRegistry } from '../session/SessionRegistry';
import { ConfigWriteTail } from './configWriteTail';
import { PanelDataCoordinator } from './panelDataCoordinator';
import { McpAdminHandler, isMcpAdminMethod } from './mcpAdminHandler';
import { SkillsAdminHandler, isSkillsAdminMethod } from './skillsAdminHandler';
import { CheckpointActionHandler } from './checkpointActions';

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

  constructor(private readonly port: ControlDispatcherHostPort) {
    this.panels = new PanelDataCoordinator(this.port);
    this.mcpAdmin = new McpAdminHandler(this.port, this.configWriteTail, (panel) => this.panels.fetchPanelData(panel));
    this.skillsAdmin = new SkillsAdminHandler(this.port, this.configWriteTail, (panel) => this.panels.fetchPanelData(panel));
    this.checkpoints = new CheckpointActionHandler(this.port, (panel, params) => this.panels.fetchPanelData(panel, params));
    // CA-M04b: self-wire the per-session fetch-seq prune to the registry's
    // close choke point — every close path (tab close, rebind, swap-eviction,
    // failed/abandoned loads, crash-recovery failure, teardown disposeAll)
    // funnels through `SessionRegistry.close`/`disposeAll`, so this ONE hook
    // covers them all, present and future, with no per-site wiring.
    port.sessions.setOnClosed((sessionId) => this.panels.pruneFetchSeqForSession(sessionId));
  }

  /**
   * The most-recently-opened/loaded session's controller, or `undefined`
   * before any session is open.
   *
   * W6-FG (3-way ARCH I-2 — ambient-state-elimination): kept ONLY for
   * {@link getPreset}/{@link getAvailableCommands} — a last-resort,
   * DISPLAY-only hydrate-seed read with no session identity available at
   * its call site (see those methods' own docs on the original
   * `AcpBackend`). Moved verbatim — reimplemented here against the injected
   * `getActiveSessionId`/`sessions` port accessors instead of `this.
   * activeSessionId`/`this.sessions` directly.
   */
  private activeController(): SessionController | undefined {
    const activeSessionId = this.port.getActiveSessionId();
    return activeSessionId ? this.port.sessions.get(activeSessionId) : undefined;
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
      return this.toggleDashboard(method, params);
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
        await this.panels.fetchPanelData('mcp');
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
      // and never touches the panel.
      const raw = await this.port.dispatch(method, params);
      if (isSaveKeyResult(raw)) {
        await this.panels.fetchPanelData('models');
      }
      return raw;
    }

    return this.port.dispatch(method, params);
  }

  /**
   * W1.5: the real Skills / Tools toggle — routed to the dashboard REST
   * channel. Moved verbatim off `AcpBackend.toggleDashboard` — AH5's
   * host-side serialization tail ({@link dashboardToggleTail}) moved WITH
   * it (see that field's own doc).
   */
  private async toggleDashboard(
    method: 'skills.toggle' | 'toolsets.toggle',
    params: unknown,
  ): Promise<DashboardToggleResult> {
    return this.configWriteTail.join(() => this.toggleDashboardInner(method, params));
  }

  private async toggleDashboardInner(
    method: 'skills.toggle' | 'toolsets.toggle',
    params: unknown,
  ): Promise<DashboardToggleResult> {
    const dashboard = this.port.getDashboard();
    if (!dashboard) {
      throw new Error(`Refusing '${method}': the Hermes dashboard channel is not configured.`);
    }
    const { name, enabled } = extractToggleParams(params);
    if (!name) {
      throw new Error(`'${method}' requires a { name, enabled } payload.`);
    }

    const panel = method === 'skills.toggle' ? 'skills' : 'tools';
    const source = this.port.panelSources.get(panel);
    if (hasToggleNameCache(source)) {
      const known = source.lastListedNames();
      if (known && !known.has(name)) {
        throw new Error(`Refusing '${method}': '${name}' is not in the last-listed ${panel} set.`);
      }
    }

    const client = await dashboard.ensure();
    return method === 'skills.toggle'
      ? client.toggleSkill(name, enabled)
      : client.toggleToolset(name, enabled);
  }

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
   * W2-F1 wire-pin (mode-coordination §4.1): the boot-time hydrate-seed
   * read. Moved verbatim off `AcpBackend.getPreset` — see the original
   * method's doc for the full W6-FG/W6-FF sanctioned-exception rationale
   * (unchanged).
   */
  getPreset(): EditPolicyPreset {
    return this.activeController()?.getPreset() ?? 'manual';
  }

  /**
   * W2 F-S: the cached ACP `available_commands` catalog for the
   * most-recently-opened session. Moved verbatim off `AcpBackend
   * .getAvailableCommands` — see the original method's doc (unchanged).
   */
  getAvailableCommands(): SlashCommandInfo[] | undefined {
    return this.activeController()?.getAvailableCommands();
  }

  /**
   * W6-FF (3-way ARCH I-1): every LIVE session's tab-identity triple
   * (+rootId), for `TalariaViewProvider.seedState`'s `hydrate` payload. Moved
   * verbatim off `AcpBackend.listTabs` — see the original method's doc
   * (unchanged); reads `this.port.sessions.values()` instead of `this.
   * sessions.values()`.
   *
   * H4-B8 (arch report Minor-2): each entry ALSO carries that SAME
   * controller's OWN per-tab display fields — `preset`/`currentModelId`/
   * `activeModeId`/`availableCommands` — read directly off THAT controller
   * (never the active/ambient one), so P-1 isolation holds: entry N's
   * values can only ever be entry N's own session's values. `activeModeId`
   * maps `activeCustomModeId`'s `null` ("no custom mode") to `undefined`
   * (the seed's own absent-field convention, matching `currentModelId`/
   * `availableCommands`'s existing `undefined`-when-unset shape).
   */
  listTabs(): HydrateTabSeed[] {
    return [...this.port.sessions.values()].map((controller) => {
      const currentModelId = controller.currentModelId;
      const activeModeId = controller.activeCustomModeId ?? undefined;
      const availableCommands = controller.getAvailableCommands();
      return {
        tabId: controller.tabId,
        sessionId: controller.sessionId,
        cwd: controller.cwd,
        rootId: controller.getRootId(),
        preset: controller.getPreset(),
        ...(currentModelId !== undefined ? { currentModelId } : {}),
        ...(activeModeId !== undefined ? { activeModeId } : {}),
        ...(availableCommands !== undefined ? { availableCommands } : {}),
        // A5 (T-1 V-12 seed fold-in): this tab's OWN live-turn status, so a
        // post-recreate reconcile regains the Stop affordance immediately.
        turnActive: controller.hasLiveTurn(),
      };
    });
  }

  /**
   * P7-N10: the sessionId-less fan-out `setMode(mode)` (`for (const
   * controller of sessions.values()) controller.setMode(mode)`) that used to
   * live here was YAGNI-deleted — a twice-flagged latent footgun (a wire
   * message with no `sessionId` that mutated EVERY live session, safe today
   * only because its sole caller hardcoded `'default'`). Grep confirmed no
   * caller depended on it beyond that hardcoded pinned-default use, and the
   * webview never actually sent the wire message (the mode PICKER is a
   * completely different, sessionId-scoped path: `mode.set` -> {@link
   * setCustomMode} below). "Every session pinned at default" remains
   * enforced by the INDEPENDENT per-session mechanisms already on
   * `SessionController` (constructor init, the newSession/loadSession
   * reassert-on-drift, the per-turn reassert) — none of which ever routed
   * through the fan-out.
   */

  /**
   * W4-T4b (SF-2 §4.3 mitigation 1 — the PRIMARY self-widening fix):
   * snapshot-on-activate. Moved verbatim off `AcpBackend.setCustomMode` —
   * see the original method's doc (unchanged).
   */
  setCustomMode(sessionId: string, modeId: string | null): void {
    const controller = this.port.sessions.get(sessionId);
    if (!controller) return;
    const configs = readCustomModes();
    const config = modeId !== null ? configs.find((c) => c.id === modeId) : undefined;
    const resolvedModeId = config ? config.id : null;
    const snapshot = config ? buildModeFloorSnapshot(config) : undefined;
    controller.setCustomMode(snapshot, resolvedModeId);
    this.port.emit({
      type: 'mode.state',
      sessionId,
      modeId: resolvedModeId,
      available: toCatalog(configs),
    });
  }

  /**
   * W4-T4b (SF-2 §4.3 mitigation 2 — the self-widening CLOSE). Moved
   * verbatim off `AcpBackend.handleCustomModesConfigChanged` — see the
   * original method's doc (unchanged); `vscode.window.showWarningMessage`
   * is now reached through the injected `showWarningMessage` port accessor
   * so this module stays vscode-free.
   */
  handleCustomModesConfigChanged(): void {
    const affected = [...this.port.sessions.values()].filter((c) => c.activeCustomModeId !== null);
    if (affected.length === 0) return;
    this.port.showWarningMessage(
      "A custom mode's definition changed on disk. The active session keeps enforcing the previously-selected definition — re-select the mode to apply changes.",
    );
    const available = toCatalog(readCustomModes());
    for (const controller of affected) {
      this.port.emit({
        type: 'mode.state',
        sessionId: controller.sessionId,
        modeId: controller.activeCustomModeId,
        available,
      });
    }
  }

  /**
   * W4-T5b (§2d `tab.load` wire): the PUBLIC entry for a tab-scoped History
   * load. Moved verbatim off `AcpBackend.loadTab` — see the original
   * method's doc (unchanged); `loadSessionIntoTab` itself stays on
   * `AcpBackend` (too entangled, see this class's own header doc) and is
   * reached through the injected port.
   */
  async loadTab(tabId: string, sessionId: string, cwd: string, title?: string): Promise<void> {
    try {
      await this.port.loadSessionIntoTab(sessionId, cwd, tabId, title);
    } catch (err) {
      this.port.logger?.append(
        `[AcpBackend] loadTab failed (tabId=${tabId}, sessionId=${sessionId}): ${errorMessage(err)}`,
      );
    }
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** W1.5: pull `{name, enabled}` out of a `skills.toggle`/`toolsets.toggle` payload. Moved verbatim. */
function extractToggleParams(params: unknown): { name?: string; enabled: boolean } {
  if (!params || typeof params !== 'object') return { enabled: false };
  const p = params as { name?: unknown; enabled?: unknown };
  const name = typeof p.name === 'string' ? p.name : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    enabled: p.enabled === true,
  };
}

// WS-GD.2a A8: `TURN_ACTIVE_RESTORE_REFUSAL`/`AMBIGUOUS_ROOT`/
// `UNKNOWN_ROOT_RESTORE_REFUSAL`/`NO_TRACKER_RESTORE_REFUSAL`/
// `MALFORMED_RESTORE_REFUSAL`/`extractRestoreParams`/
// `CHECKPOINT_LABEL_MAX_LEN`/`truncateCheckpointLabel` moved onto
// `checkpointActions.ts` (own docs moved there verbatim) with the rest of
// the checkpoints domain.
