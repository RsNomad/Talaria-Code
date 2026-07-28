import type {
  HostToWebview,
  ControlMethod,
  DataPanel,
  GlobalPanel,
  PanelDataMap,
  EditPolicyPreset,
  HydrateTabSeed,
  SlashCommandInfo,
} from '../../../shared/protocol';
import { CONTROL_METHODS, makePanelData } from '../../../shared/protocol';
import type { RestoreResult } from '../../checkpoints/CheckpointTracker';
import type { CheckpointTrackerLike } from '../../checkpoints/trackerContract';
import type { RootCoordinator } from '../../checkpoints/RootCoordinator';
import type { RootRegistry } from '../../checkpoints/rootRegistry';
import type { Logger } from '../../transport/JsonRpcStdio';
import type { PanelSourceRegistry } from '../../panels/PanelSourceRegistry';
import { extractCwd, extractRootId, extractSessionId } from '../../panels/panelSources';
import type { DashboardService } from '../../dashboard/HermesDashboardManager';
import type { DashboardToggleResult } from '../../dashboard/HermesDashboardClient';
import { hasToggleNameCache } from '../../dashboard/dashboardPanelSources';
import type { AcpLoadSessionResult } from '../acp/acpClient';
import { readCustomModes, toCatalog, buildModeFloorSnapshot } from '../customModes';
import type { SessionController } from '../session/SessionController';
import type { SessionRegistry } from '../session/SessionRegistry';

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
   * The C1/W6-FB entangled History-load choreography (`AcpBackend
   * .loadSessionIntoTab`) — too entangled with `openSession`/session-minting
   * to move (per the brief: "leave in the router anything too entangled").
   * This dispatcher only ever CALLS it (from `invokeControl`'s `session.load`
   * branch and from {@link ControlDispatcher.loadTab}) — it never
   * re-implements any part of that choreography.
   */
  loadSessionIntoTab(sessionId: string, cwd: string, tabId?: string): Promise<AcpLoadSessionResult | undefined>;
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

  /**
   * W4 §2d: the fallback stamped on a session-scoped emit when there is no
   * active session to tag a global panel push to. Never used on a healthy
   * path.
   */
  private static readonly UNKNOWN_SESSION_ID = 'unknown-session';

  /**
   * AH5: HOST-SIDE serialization tail for {@link toggleDashboard}. Moved
   * verbatim off `AcpBackend` — see the original field doc (unchanged).
   */
  private dashboardToggleTail: Promise<unknown> = Promise.resolve();

  /**
   * T-C1 (closes audit V-2): mints a unique synthetic lease-holder id per
   * `restoreCheckpoint`/`redoCheckpoint` invocation — verbatim pattern from
   * {@link ../oneshot/OneShotRunner.OneShotRunner.oneShot}'s own
   * `leaseCounter`/`leaseHolder`. Restore/redo used to only CHECK
   * `root.anyLiveTurn()` before calling into the tracker, never HOLD the
   * root's turn lease for the (possibly multi-second) duration of that
   * call — so a `sendPrompt`, a one-shot, or a SECOND restore/redo could be
   * admitted mid-restore and interleave agent writes with the shadow-git
   * apply loop. Restore/redo now acquire this SAME root turn lease (the one
   * `SessionController.sendPrompt`/`OneShotRunner.oneShot` already contend
   * on) under a synthetic `checkpoint-restore-N` holder, for the whole call.
   */
  private restoreLeaseCounter = 0;

  /**
   * T-12 (Tier-2 remediation, "fetchPanelData stale-overwrite"): per-scope
   * sequence tokens — the SAME idiom `SessionController.setModel` already
   * uses for `modelSwitchSeq` (capture `++seq` at entry, re-check `seq ===
   * latest` after the await, drop the belated side effect if a newer
   * attempt has since landed). Keyed by panel+scope (mirrors {@link
   * buildPanelDataMessage}'s own scope derivation) so concurrent fetches for
   * DIFFERENT panels/scopes never interfere with each other — only a fetch
   * racing against ANOTHER fetch for the exact same scope can go stale.
   */
  private readonly panelFetchSeq = new Map<string, number>();

  constructor(private readonly port: ControlDispatcherHostPort) {}

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

    const requestedPanel = this.extractPanel(params);

    if (method === 'panel.data') {
      if (!requestedPanel) return undefined;
      return this.fetchPanelData(requestedPanel, params);
    }

    if (method === 'session.list') {
      return this.fetchPanelData('sessions', params);
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
      return this.restoreCheckpoint(params);
    }

    if (method === 'checkpoint.redo' || method === 'checkpoint.redoAll') {
      return this.redoCheckpoint(method, params);
    }

    if (method === 'skills.toggle' || method === 'toolsets.toggle') {
      return this.toggleDashboard(method, params);
    }

    if (method === 'reload.mcp') {
      const raw = await this.port.dispatch(method, params);
      if (isReloadedResult(raw)) {
        await this.fetchPanelData('mcp');
      }
      return raw;
    }

    return this.port.dispatch(method, params);
  }

  /**
   * The unified panel-fetch seam (Zone Z3, finding A1). Moved verbatim off
   * `AcpBackend.fetchPanelData` — see the original method's doc for the full
   * push/resolve-agreement rationale (unchanged).
   *
   * PRIVATE: every caller is internal to this class (H9-hygiene). The
   * external reach-through this used to need — `AcpBackend.buildSessionPort`
   * closing over it directly — was removed by W6-FI-c Part 2, which folds
   * that call through {@link refreshCheckpointsPanel} instead, so the
   * implementation now lives in, and is reached through, exactly one place.
   */
  private async fetchPanelData<P extends DataPanel>(panel: P, params?: unknown): Promise<unknown> {
    const scopedParams = this.withDefaultCheckpointsScope(panel, params);
    // T-12: mint this attempt's sequence token for its scope BEFORE the
    // fetch starts, so a caller that races ahead (issued LATER, resolves
    // FIRST) bumps the scope's latest token before this one's belated
    // resolution gets a chance to check it.
    const scopeKey = this.panelScopeKey(panel, scopedParams);
    const seq = (this.panelFetchSeq.get(scopeKey) ?? 0) + 1;
    this.panelFetchSeq.set(scopeKey, seq);

    const outcome = await this.port.panelSources.get(panel).fetch(scopedParams);

    // The CALLER's own correlated return value is always honest — a caller
    // that explicitly asked for this fetch gets its own answer regardless of
    // races. Only the BROADCAST push (shared, ambient webview state) has the
    // overwrite hazard, so only it is gated: a superseded attempt (a newer
    // fetch for the SAME scope has since landed) drops its push silently.
    if (outcome.data !== undefined && this.panelFetchSeq.get(scopeKey) === seq) {
      this.port.emit(this.buildPanelDataMessage(panel, outcome.data, scopedParams));
    }
    return outcome.data;
  }

  /**
   * T-12: the scope key `fetchPanelData`'s staleness gate keys its sequence
   * tokens on — deliberately mirrors {@link buildPanelDataMessage}'s own
   * per-panel scope derivation (subagents/checkpoints/sessions are
   * session|root|cwd-scoped; every other panel is one shared global scope)
   * so two fetches are only ever compared for staleness when they are
   * fetching the exact same rendered slice of state. Kept as a small,
   * independent helper rather than refactored into `buildPanelDataMessage`
   * itself (which needs the FETCHED `data` too, not just the scope) to avoid
   * touching that already-pinned method's shape.
   */
  private panelScopeKey(panel: DataPanel, params: unknown): string {
    if (panel === 'subagents') {
      return `subagents:${extractSessionId(params) ?? ControlDispatcher.UNKNOWN_SESSION_ID}`;
    }
    if (panel === 'checkpoints') {
      return `checkpoints:${extractRootId(params) ?? ''}`;
    }
    if (panel === 'sessions') {
      const scopedSessionId = extractSessionId(params);
      const cwd =
        extractCwd(params) ??
        (scopedSessionId !== undefined ? this.port.sessions.get(scopedSessionId)?.cwd : undefined) ??
        this.port.getConnectionCwd() ??
        '';
      return `sessions:${cwd}`;
    }
    return panel;
  }

  /**
   * W4-T3b (§7 B6): when a `checkpoints` fetch carries no explicit `rootId`,
   * fall back to "the single registered root". Moved verbatim off
   * `AcpBackend.withDefaultCheckpointsScope` — see the original method's doc
   * (unchanged); reads `this.port.rootRegistry.values()` instead of `this.
   * rootRegistry.values()`.
   */
  private withDefaultCheckpointsScope(panel: DataPanel, params: unknown): unknown {
    if (panel !== 'checkpoints' || extractRootId(params) !== undefined) return params;
    const all = [...this.port.rootRegistry.values()];
    if (all.length !== 1) return params;
    const base = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const first = all[0];
    if (first === undefined) {
      // Unreachable: all.length === 1 was just checked above.
      return params;
    }
    return { ...base, rootId: first.rootId };
  }

  /**
   * W4 §7 B2: the ONE place that turns a fetched `PanelDataMap[P]` into the
   * scoped `panel.data` message {@link makePanelData} requires. Moved
   * verbatim off `AcpBackend.buildPanelDataMessage` — see the original
   * method's doc for the full scope-key-from-params rationale (unchanged);
   * the `sessions` branch's `?? this.cwd` fallback now reads `this.port.
   * getConnectionCwd()`.
   */
  private buildPanelDataMessage<P extends DataPanel>(panel: P, data: PanelDataMap[P], params?: unknown): HostToWebview {
    if (panel === 'subagents') {
      const sessionId = extractSessionId(params) ?? ControlDispatcher.UNKNOWN_SESSION_ID;
      return makePanelData(panel, data as PanelDataMap['subagents'], { sessionId });
    }
    if (panel === 'checkpoints') {
      const rootId = extractRootId(params) ?? '';
      return makePanelData(panel, data as PanelDataMap['checkpoints'], { rootId });
    }
    if (panel === 'sessions') {
      const scopedSessionId = extractSessionId(params);
      const cwd =
        extractCwd(params) ??
        (scopedSessionId !== undefined ? this.port.sessions.get(scopedSessionId)?.cwd : undefined) ??
        this.port.getConnectionCwd() ??
        '';
      return makePanelData(panel, data as PanelDataMap['sessions'], { cwd });
    }
    if (panel === 'tools' || panel === 'mcp' || panel === 'skills' || panel === 'models' || panel === 'settings') {
      return makePanelData(panel, data as PanelDataMap[GlobalPanel]);
    }
    const exhaustive: never = panel;
    throw new Error(`unhandled panel: ${String(exhaustive)}`);
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
    const run = () => this.toggleDashboardInner(method, params);
    const result = this.dashboardToggleTail.then(run, run);
    this.dashboardToggleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
   * Pull a valid `{panel}` out of a `switchPanel`/`panel.data` params object,
   * gated on the panel actually having a registered `PanelSource`. Moved
   * verbatim off `AcpBackend.extractPanel`.
   */
  private extractPanel(params: unknown): DataPanel | undefined {
    if (params && typeof params === 'object' && 'panel' in params) {
      const panel = (params as { panel?: unknown }).panel;
      if (typeof panel === 'string' && this.port.panelSources.has(panel as DataPanel)) {
        return panel as DataPanel;
      }
    }
    return undefined;
  }

  /**
   * Zone CKPT / C1: baseline-only snapshot helper. Moved verbatim off
   * `AcpBackend.snapshotCheckpoint` (the connection-level sibling — see the
   * original doc for how it differs from `SessionController`'s OWN
   * per-turn barrier of the same name). FAIL-OPEN — never rejects.
   */
  private async snapshotCheckpoint(
    tracker: CheckpointTrackerLike,
    turnOrdinal: number,
    promptText: string,
    rootId: string,
  ): Promise<void> {
    const label = truncateCheckpointLabel(promptText);
    try {
      await tracker.snapshot(turnOrdinal, label);
    } catch (err) {
      this.port.logger?.append(
        `[AcpBackend] checkpoint snapshot failed — turn ${turnOrdinal} proceeds WITHOUT a checkpoint (unprotected): ${errorMessage(err)}`,
      );
      return;
    }
    void this.fetchPanelData('checkpoints', { rootId }).catch((err: unknown) => {
      this.port.logger?.append(`[AcpBackend] post-snapshot checkpoints refresh failed: ${errorMessage(err)}`);
    });
  }

  /**
   * Zone CKPT / C1: fire the session-baseline snapshot from `AcpBackend
   * .start`/`ConnectionSupervisor.establishInitialSession`. Moved verbatim
   * off `AcpBackend.warmCheckpointBaseline` — fire-and-forget, see the
   * original doc for the full warm-index rationale (unchanged).
   */
  warmCheckpointBaseline(): void {
    const root = this.port.resolveRootCoordinator(this.port.getConnectionCwd() ?? '');
    const tracker = root.tracker;
    if (!tracker) return;
    const ordinal = root.nextBaselineOrdinal();
    void this.snapshotCheckpoint(tracker, ordinal, 'Session start', root.rootId);
  }

  /**
   * Zone CKPT: the Checkpoints panel's "Restore"/"Restore anyway" action.
   * Moved verbatim off `AcpBackend.restoreCheckpoint` — see the original
   * method's doc for the full W4-T2 Deliverable 5 rootId-routing rationale
   * (unchanged).
   */
  private async restoreCheckpoint(params: unknown): Promise<RestoreResult> {
    const { id, force, rootId } = extractRestoreParams(params);
    const root = this.resolveRestoreTargetRoot(rootId);
    if (root === AMBIGUOUS_ROOT) return UNKNOWN_ROOT_RESTORE_REFUSAL;
    if (!root || !root.tracker) return NO_TRACKER_RESTORE_REFUSAL;
    // T-C1 (V-2): HOLD the root turn lease for the whole restore, not just
    // check it — see {@link restoreLeaseCounter}'s doc.
    const holder = `checkpoint-restore-${++this.restoreLeaseCounter}`;
    if (!root.tryAcquireTurnLease(holder)) return TURN_ACTIVE_RESTORE_REFUSAL;
    try {
      if (!id) {
        this.port.logger?.append('[AcpBackend] checkpoint.restore: missing id in params');
        return MALFORMED_RESTORE_REFUSAL;
      }
      const result = await root.tracker.restore(id, { force });
      if (result.restored) {
        await this.fetchPanelData('checkpoints', { rootId: root.rootId }).catch((err: unknown) => {
          this.port.logger?.append(`[AcpBackend] post-restore checkpoints refresh failed: ${errorMessage(err)}`);
        });
      }
      return result;
    } catch (err) {
      return { restored: false, reason: errorMessage(err) };
    } finally {
      root.releaseTurnLease(holder);
    }
  }

  /**
   * W2-F2 Phase 1: the Checkpoints panel's Redo / Redo All actions. Moved
   * verbatim off `AcpBackend.redoCheckpoint` — mirrors {@link
   * restoreCheckpoint} exactly, including the rootId routing + interlock.
   */
  private async redoCheckpoint(
    method: 'checkpoint.redo' | 'checkpoint.redoAll',
    params: unknown,
  ): Promise<RestoreResult> {
    const { force, rootId } = extractRestoreParams(params);
    const root = this.resolveRestoreTargetRoot(rootId);
    if (root === AMBIGUOUS_ROOT) return UNKNOWN_ROOT_RESTORE_REFUSAL;
    if (!root || !root.tracker) return NO_TRACKER_RESTORE_REFUSAL;
    // T-C1 (V-2): HOLD the root turn lease for the whole redo, not just
    // check it — mirrors {@link restoreCheckpoint} exactly (same shared
    // counter/holder prefix — restore and redo contend on the SAME lease).
    const holder = `checkpoint-restore-${++this.restoreLeaseCounter}`;
    if (!root.tryAcquireTurnLease(holder)) return TURN_ACTIVE_RESTORE_REFUSAL;
    try {
      const result =
        method === 'checkpoint.redo'
          ? await root.tracker.redo({ force })
          : await root.tracker.redoAll({ force });
      if (result.restored) {
        await this.fetchPanelData('checkpoints', { rootId: root.rootId }).catch((err: unknown) => {
          this.port.logger?.append(`[AcpBackend] post-redo checkpoints refresh failed: ${errorMessage(err)}`);
        });
      }
      return result;
    } catch (err) {
      return { restored: false, reason: errorMessage(err) };
    } finally {
      root.releaseTurnLease(holder);
    }
  }

  /**
   * W4-T2 Deliverable 5: resolve the checkpoint-action TARGET root. Moved
   * verbatim off `AcpBackend.resolveRestoreTargetRoot` — see the original
   * method's doc for the full ambiguity-refusal rationale (unchanged).
   */
  private resolveRestoreTargetRoot(rootId: string | undefined): RootCoordinator | undefined | typeof AMBIGUOUS_ROOT {
    if (rootId) return this.port.rootRegistry.get(rootId) ?? AMBIGUOUS_ROOT;
    const all = [...this.port.rootRegistry.values()];
    if (all.length === 1) return all[0];
    if (all.length === 0) return undefined;
    return AMBIGUOUS_ROOT;
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
   * (+rootId), for `HermesViewProvider.seedState`'s `hydrate` payload. Moved
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
    return [...this.port.sessions.values()].map((controller) => ({
      tabId: controller.tabId,
      sessionId: controller.sessionId,
      cwd: controller.cwd,
      rootId: controller.getRootId(),
      preset: controller.getPreset(),
      currentModelId: controller.currentModelId,
      activeModeId: controller.activeCustomModeId ?? undefined,
      availableCommands: controller.getAvailableCommands(),
      // A5 (T-1 V-12 seed fold-in): this tab's OWN live-turn status, so a
      // post-recreate reconcile regains the Stop affordance immediately.
      turnActive: controller.hasLiveTurn(),
    }));
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
   * through the fan-out. See `.superpowers/sdd/reports/p7-n10-report.md`.
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
  async loadTab(tabId: string, sessionId: string, cwd: string): Promise<void> {
    try {
      await this.port.loadSessionIntoTab(sessionId, cwd, tabId);
    } catch (err) {
      this.port.logger?.append(
        `[AcpBackend] loadTab failed (tabId=${tabId}, sessionId=${sessionId}): ${errorMessage(err)}`,
      );
    }
  }

  /**
   * W6-FI-c Part 2 (3-way ARCH I-4c, folding in the W4-F5 critic-pin
   * placement fix — "checkpoint-panel refresh belongs on RootCoordinator,
   * not N× controller ports"): the checkpoints-panel refresh
   * IMPLEMENTATION — reuses {@link fetchPanelData} (the SAME call every
   * other checkpoint-refresh site already makes), wrapped in the identical
   * fail-open catch-and-log every one of them uses. `AcpBackend
   * .resolveRootCoordinator` wires this method (bound to the NEWLY-minted
   * root's canonical id) into that root's `RootCoordinator` exactly ONCE, at
   * mint time (`rootRegistry.getOrCreate`'s `notifyCheckpointsChanged`
   * param) — see `RootCoordinator.refreshCheckpointsPanel`'s own doc. Every
   * `SessionController` sharing that root reaches this SAME implementation
   * through `port.root.refreshCheckpointsPanel()` (the port's `root` field
   * was ALREADY the shared coordinator instance — no new port surface
   * needed), instead of `AcpBackend.buildSessionPort` independently
   * re-implementing the fetch+catch+log per controller mint.
   */
  refreshCheckpointsPanel(rootId: string): void {
    void this.fetchPanelData('checkpoints', { rootId }).catch((err: unknown) => {
      this.port.logger?.append(`[AcpBackend] checkpoints panel refresh failed: ${errorMessage(err)}`);
    });
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

/** Zone HIST: pull `{sessionId, cwd}` out of `session.load`'s params (the clicked `SessionSummary`). Moved verbatim. */
function extractLoadParams(params: unknown): { sessionId?: string; cwd?: string } {
  if (!params || typeof params !== 'object') return {};
  const p = params as { sessionId?: unknown; cwd?: unknown };
  return {
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
    cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
  };
}

/** W1.5: pull `{name, enabled}` out of a `skills.toggle`/`toolsets.toggle` payload. Moved verbatim. */
function extractToggleParams(params: unknown): { name?: string; enabled: boolean } {
  if (!params || typeof params !== 'object') return { enabled: false };
  const p = params as { name?: unknown; enabled?: unknown };
  return {
    name: typeof p.name === 'string' ? p.name : undefined,
    enabled: p.enabled === true,
  };
}

/**
 * P3 (arch A3): pinned refusal returned by {@link ControlDispatcher
 * .restoreCheckpoint}/{@link ControlDispatcher.redoCheckpoint} while a turn
 * is live. Moved verbatim — the exact string is a cross-zone contract, do
 * not reword without updating the panel.
 */
const TURN_ACTIVE_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'A turn is still running — wait for it to finish (or cancel it) before restoring or redoing a checkpoint.',
};

/**
 * W4-T2 Deliverable 5: the tri-state sentinel {@link ControlDispatcher
 * .resolveRestoreTargetRoot} returns when the checkpoint action's target
 * root could not be determined. Moved verbatim.
 */
const AMBIGUOUS_ROOT = Symbol('ambiguous-root');

/**
 * Zone CKPT (W4-T2, data-safety): pinned refusal for a `checkpoint.restore`/
 * `redo`/`redoAll` whose target root could not be determined. Moved verbatim.
 */
const UNKNOWN_ROOT_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'Could not determine which workspace this checkpoint action targets — refusing to restore against the wrong worktree.',
};

/**
 * T-C2 (closes audit V-17): pinned refusal for {@link ControlDispatcher
 * .restoreCheckpoint}/{@link ControlDispatcher.redoCheckpoint} when the
 * target root has no checkpoint tracker (checkpoints unavailable for this
 * workspace). This used to be a bare `undefined`, which `CheckpointsPanel`'s
 * `if (result && !result.restored)` sent down the success branch — an
 * affirmative "Workspace restored." on a restore that never ran. `undefined`
 * is never success.
 */
const NO_TRACKER_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'Checkpoints are not available for this workspace — nothing was restored.',
};

/**
 * T-C2 (closes audit V-17): pinned refusal for {@link ControlDispatcher
 * .restoreCheckpoint} when the request is missing the checkpoint `id` — same
 * bare-`undefined` false-success hazard as {@link NO_TRACKER_RESTORE_REFUSAL}.
 */
const MALFORMED_RESTORE_REFUSAL: RestoreResult = {
  restored: false,
  reason: 'Malformed restore request (missing checkpoint id) — nothing was restored.',
};

/**
 * Zone CKPT: pull `{id, force, rootId}` out of `checkpoint.restore`'s
 * params. Moved verbatim.
 */
function extractRestoreParams(params: unknown): { id?: string; force?: boolean; rootId?: string } {
  if (!params || typeof params !== 'object') return {};
  const p = params as { id?: unknown; force?: unknown; rootId?: unknown };
  return {
    id: typeof p.id === 'string' ? p.id : undefined,
    force: typeof p.force === 'boolean' ? p.force : undefined,
    rootId: typeof p.rootId === 'string' ? p.rootId : undefined,
  };
}

/** Max length of a checkpoint label before truncation (Zone CKPT). Moved verbatim. */
const CHECKPOINT_LABEL_MAX_LEN = 80;

/**
 * Zone CKPT: the checkpoint `label` is the user's prompt text, truncated so
 * a pasted essay doesn't blow out the Checkpoints panel's timeline row.
 * Moved verbatim.
 */
function truncateCheckpointLabel(promptText: string): string {
  const collapsed = promptText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CHECKPOINT_LABEL_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, CHECKPOINT_LABEL_MAX_LEN - 1).trimEnd()}…`;
}
