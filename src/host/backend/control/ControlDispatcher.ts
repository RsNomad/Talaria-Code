import type {
  HostToWebview,
  ControlMethod,
  DataPanel,
  GlobalPanel,
  PanelDataMap,
  EditPolicyPreset,
  HydrateTabSeed,
  SlashCommandInfo,
  McpAddParams,
  McpAddResult,
  McpCatalogData,
  McpCatalogEntry,
  McpCatalogInstallResult,
  McpTestResult,
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
import type { DashboardAdminClient, DashboardToggleResult } from '../../dashboard/HermesDashboardClient';
import { hasDashboardAdmin } from '../../dashboard/HermesDashboardClient';
import { hasToggleNameCache } from '../../dashboard/dashboardPanelSources';
import type { AcpLoadSessionResult } from '../acp/acpClient';
import { readCustomModes, toCatalog, buildModeFloorSnapshot } from '../customModes';
import type { SessionController } from '../session/SessionController';
import type { SessionRegistry } from '../session/SessionRegistry';
import { validateMcpAdd, describeAddForModal, stripModalControls, validateCatalogInstall, describeCatalogForModal, RELOAD_LINE } from './mcpEntryValidation';

/**
 * Task A5 (features-add-mcp-skills-architecture.md §3 Layer 5, §4.5 item 1):
 * the FULL trust-gated method set for T1 (MCP admin) + T2 (skills admin) —
 * checked FIRST, before any network call or modal, for every method in this
 * set. Mirrors `SetupController.MUTATING_METHODS` + its `handle()` check
 * (`SetupController.ts:612-634, :1146-1148`) as a SECOND, independent gate
 * on the control-method surface (defense-in-depth over `trustGate.ts`'s
 * "no ACP backend in an untrusted workspace" gate).
 *
 * Pinned as the FULL 9-method set: A5 routes `mcp.add`/`mcp.remove`/
 * `mcp.setEnabled`/`mcp.test`/`mcp.auth`'s trust+fail-closed-cache guard;
 * A6 routes `mcp.auth`'s body + `mcp.catalogInstall`; the three
 * `skills.*` admin methods are routed by B4/B5 — but the trust-gate SET
 * itself is defined here, once, so no later task can silently add a
 * mutating method without also classifying it here (the
 * `SetupController.test.ts:1675-1712` partition-lock idiom, mirrored in
 * `AcpBackend.test.ts`'s `PINNED_TRUST_GATED_METHODS` lock test).
 * `mcp.catalog` (listing) is deliberately ABSENT — §4.7 pins it read-only,
 * same class as `tools.list`, not trust-gated.
 */
export const TRUST_GATED_METHODS: ReadonlySet<string> = new Set([
  'mcp.add',
  'mcp.remove',
  'mcp.setEnabled',
  'mcp.test',
  'mcp.auth',
  'mcp.catalogInstall',
  'skills.create',
  'skills.hubInstall',
  'skills.hubUninstall',
]);

/**
 * Task A6 (§4.8): the narrowed `CancellationToken` shape {@link
 * ControlDispatcherHostPort.withProgress} hands `mcp.auth`'s task callback —
 * exactly the two members that callback reads.
 */
export interface McpAuthCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(cb: () => void): { dispose(): void };
}

/** The 7 MCP admin methods {@link ControlDispatcher.handleMcpAdmin} routes (A5: add/remove/setEnabled/test/auth; A6: catalog/catalogInstall). */
type McpAdminMethod = 'mcp.add' | 'mcp.remove' | 'mcp.setEnabled' | 'mcp.test' | 'mcp.auth' | 'mcp.catalog' | 'mcp.catalogInstall';

function isMcpAdminMethod(method: string): method is McpAdminMethod {
  return (
    method === 'mcp.add' ||
    method === 'mcp.remove' ||
    method === 'mcp.setEnabled' ||
    method === 'mcp.test' ||
    method === 'mcp.auth' ||
    method === 'mcp.catalog' ||
    method === 'mcp.catalogInstall'
  );
}

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

  /**
   * W4 §2d: the fallback stamped on a session-scoped emit when there is no
   * active session to tag a global panel push to. Never used on a healthy
   * path.
   */
  private static readonly UNKNOWN_SESSION_ID = 'unknown-session';

  /**
   * AH5: HOST-SIDE serialization tail, originally for {@link toggleDashboard}
   * alone (moved verbatim off `AcpBackend`). Task A5 (§4.5) widened its use
   * to EVERY dashboard-mutating control method — {@link handleMcpAdmin} now
   * chains onto this SAME queue — so `skills.toggle`/`toolsets.toggle`/
   * `mcp.add`/`mcp.remove`/`mcp.setEnabled`/`mcp.test`/`mcp.auth` (and A6/B4/
   * B5's `mcp.catalogInstall`/`skills.*`) can never interleave two writes to
   * the same underlying `~/.hermes/config.yaml` — one shared tail, not one
   * per method family.
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

  /**
   * Task A6 (§4.7 item 1): the last catalog LISTED this session — the
   * fail-closed guard `mcp.catalogInstall`'s {@link validateCatalogInstall}
   * checks a requested name against. `undefined` until this session's first
   * `mcp.catalog` call (mirrors the `mcp` panel's own `lastListedNames()`
   * fail-closed posture, {@link requireListedMcpName}).
   */
  private lastCatalogEntries: McpCatalogEntry[] | undefined;

  /**
   * Task A6 (§4.7 item 2, FM-12 precedent): single-flight per catalog entry
   * name — a re-click while installing is refused. Test-and-set/release both
   * live in {@link acquireMcpSingleFlight}/{@link handleMcpAdmin}, checked
   * SYNCHRONOUSLY before the call joins {@link dashboardToggleTail} (see
   * that method's own doc for why it can't be checked inside the queued
   * handler).
   */
  private readonly inFlightCatalogInstalls = new Set<string>();

  /**
   * Task A6 (§4.8 critic IMPORTANT-3): single-flight per MCP name for
   * `mcp.auth` — same test-and-set/release posture as {@link
   * inFlightCatalogInstalls}.
   */
  private readonly inFlightAuthNames = new Set<string>();

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

    // Task A5+A6 (§4.5, §4.7, §4.8): the full T1 MCP admin core —
    // add/remove/setEnabled/test/auth (A5) plus catalog/catalogInstall (A6).
    if (isMcpAdminMethod(method)) {
      return this.handleMcpAdmin(method, params);
    }

    if (method === 'reload.mcp') {
      const raw = await this.port.dispatch(method, params);
      if (isReloadedResult(raw)) {
        await this.fetchPanelData('mcp');
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
        await this.fetchPanelData('models');
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
    if (
      panel === 'tools' ||
      panel === 'mcp' ||
      panel === 'skills' ||
      panel === 'models' ||
      panel === 'settings' ||
      panel === 'setup'
    ) {
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
   * Task A5+A6 (§4.5, §4.7): the T1 MCP admin core, riding the SAME host-side
   * serialization tail as {@link toggleDashboard} ({@link
   * dashboardToggleTail}) — the plan is explicit that every dashboard
   * mutation (skills/toolsets toggle, and `mcp.add`/`remove`/`setEnabled`/
   * `test`/`auth`/`catalogInstall`) shares ONE queue, so a compromised or
   * buggy webview firing parallel `control.request`s can't interleave two
   * writes to the same underlying `~/.hermes/config.yaml`. `mcp.catalog`
   * (a plain read) rides the same tail purely for routing uniformity — it
   * never mutates anything, so it can never be the cause of an interleave.
   */
  private async handleMcpAdmin(method: McpAdminMethod, params: unknown): Promise<unknown> {
    // Task A6 (§4.7 item 3, §4.8 critic IMPORTANT-3): the `mcp.auth`/
    // `mcp.catalogInstall` single-flight test-and-set MUST happen here,
    // synchronously, BEFORE this call ever joins `dashboardToggleTail` —
    // that tail serializes a handler's FULL execution (including
    // `mcp.auth`'s possible multi-minute OAuth wait), so a duplicate call
    // gated INSIDE the queued handler would simply queue silently behind
    // the in-flight one: by the time it ran, the first would already be
    // done and the guard would never observe the overlap. A synchronous
    // pre-check makes the refusal immediate instead of a silent wait.
    const releaseSingleFlight = this.acquireMcpSingleFlight(method, params);
    const run = () => this.handleMcpAdminInner(method, params);
    const result = this.dashboardToggleTail.then(run, run);
    this.dashboardToggleTail = result.then(
      () => undefined,
      () => undefined,
    );
    if (releaseSingleFlight) {
      // Release regardless of outcome — a declined modal, a validation
      // refusal, or a real failure must free the name exactly like success.
      result.then(releaseSingleFlight, releaseSingleFlight);
    }
    return result;
  }

  /**
   * Task A6 (§4.7 item 3, §4.8 IMPORTANT-3): the single-flight test-and-set
   * for `mcp.auth`/`mcp.catalogInstall` — see {@link handleMcpAdmin}'s own
   * doc for why this runs synchronously, before queueing. Returns a release
   * callback for the two guarded methods; `undefined` for every other
   * method (nothing to release) or when the payload carries no usable name
   * (the real per-method handler rejects with a clearer validation message
   * once it runs).
   */
  private acquireMcpSingleFlight(method: McpAdminMethod, params: unknown): (() => void) | undefined {
    if (method !== 'mcp.auth' && method !== 'mcp.catalogInstall') return undefined;
    const name = extractMcpName(params);
    if (!name) return undefined;
    const inFlight = method === 'mcp.auth' ? this.inFlightAuthNames : this.inFlightCatalogInstalls;
    if (inFlight.has(name)) {
      throw new Error(
        method === 'mcp.auth'
          ? `Sign-in for "${name}" is already in progress.`
          : `Installing "${name}" is already in progress.`,
      );
    }
    inFlight.add(name);
    return () => inFlight.delete(name);
  }

  /**
   * Task A5+A6 (§3 Layer 5, §4.5 items 1-3, §4.7): trust gate -> admin-client
   * resolution -> the per-method route. `mcp.catalog` (no trust gate, §4.7)
   * and `mcp.add` (creating a NEW name) are the two methods with no name to
   * validate against the last-listed cache; every other method runs the
   * FAIL-CLOSED last-listed-name guard first.
   */
  private async handleMcpAdminInner(method: McpAdminMethod, params: unknown): Promise<unknown> {
    if (TRUST_GATED_METHODS.has(method) && !this.port.isTrusted()) {
      throw new Error(`Refusing '${method}': the workspace is not trusted — trust this workspace to manage MCP servers.`);
    }

    const client = await this.resolveMcpAdminClient(method);

    if (method === 'mcp.catalog') {
      return this.mcpCatalog(client);
    }

    if (method === 'mcp.add') {
      return this.mcpAdd(client, params);
    }

    if (method === 'mcp.catalogInstall') {
      return this.mcpCatalogInstall(client, params);
    }

    const name = extractMcpName(params);
    this.requireListedMcpName(method, name);

    switch (method) {
      case 'mcp.remove':
        return this.mcpRemove(client, name);
      case 'mcp.setEnabled':
        return this.mcpSetEnabled(client, name, extractMcpEnabled(params));
      case 'mcp.test':
        // F-8 CONFIRMED (§4.5 item 7): no modal, no reload — the envelope
        // (including an `{ok:false}` connect failure) is a RESOLVED result
        // the panel renders, never a rejection.
        return client.testMcpServer(name);
      case 'mcp.auth':
        return this.mcpAuth(client, name);
      default: {
        const exhaustive: never = method;
        throw new Error(`unhandled MCP admin method: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * Task A5 (§4.5 item 2): `dashboard.ensure()` then the `hasDashboardAdmin`
   * structural narrowing (the `hasToggleNameCache` idiom) — a dashboard
   * client without the T1 admin surface (or no dashboard at all) fails
   * closed rather than silently no-op-ing.
   */
  private async resolveMcpAdminClient(method: string): Promise<DashboardAdminClient> {
    const dashboard = this.port.getDashboard();
    if (!dashboard) {
      throw new Error(`Refusing '${method}': the Hermes dashboard channel is not configured.`);
    }
    const client = await dashboard.ensure();
    if (!hasDashboardAdmin(client)) {
      throw new Error(`Refusing '${method}': the dashboard client does not support MCP admin actions.`);
    }
    return client;
  }

  /**
   * Task A5 (§3 Layer 5 critic IMPORTANT-2, §4.5 item 3): the FAIL-CLOSED
   * name-cache guard for `mcp.remove`/`mcp.setEnabled`/`mcp.test`/`mcp.auth`.
   * DELIBERATELY diverges from {@link toggleDashboardInner}'s lenient
   * `if (known && !known.has(name))` idiom: an UNFETCHED cache
   * (`lastListedNames()` returns `undefined` — the `mcp` panel was never
   * listed this host session) is a REFUSAL here, not a skip. `mcp.setEnabled`
   * has no modal, so this cache is its ONLY gate — without the fail-closed
   * rule a compromised webview's FIRST message could toggle an arbitrary
   * server before any panel render ever populated the cache.
   */
  private requireListedMcpName(method: string, name: string | undefined): asserts name is string {
    if (!name) {
      throw new Error(`'${method}' requires a { name } payload.`);
    }
    const source = this.port.panelSources.get('mcp');
    const known = hasToggleNameCache(source) ? source.lastListedNames() : undefined;
    if (known === undefined) {
      throw new Error(`Refusing '${method}': the MCP panel has not been listed yet — open it first.`);
    }
    if (!known.has(name)) {
      throw new Error(`${method}: '${name}' is not in the last-listed MCP servers.`);
    }
  }

  /**
   * Task A5 (§4.5 item 4): `validateMcpAdd` -> `describeAddForModal` (an
   * `ok:false` ceiling refusal REJECTS here, before any modal) -> the native
   * consent modal -> `addMcpServer` -> `reload.mcp{confirm:true}` -> an `mcp`
   * panel refetch -> `{ok:true, name, transport}` (`transport` is the
   * VALIDATED discriminant — see the `McpAddResult` doc, protocol.ts). `env`
   * VALUES pass through `validated.body` exactly once and are never logged.
   */
  private async mcpAdd(client: DashboardAdminClient, params: unknown): Promise<McpAddResult> {
    const validated = validateMcpAdd(params);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const transport = extractValidatedAddTransport(params);
    const described = describeAddForModal(toMcpAddParams(validated.body, transport));
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(described.message, described.detail, 'Add server');
    if (!confirmed) {
      throw new Error(`Adding MCP server "${validated.body.name}" was declined or cancelled.`);
    }
    await client.addMcpServer(validated.body);
    await this.port.dispatch('reload.mcp', { confirm: true });
    await this.fetchPanelData('mcp');
    return { ok: true, name: validated.body.name, transport };
  }

  /** Task A5 (§4.5 item 5): confirm -> `removeMcpServer` -> reload -> refetch. */
  private async mcpRemove(client: DashboardAdminClient, name: string): Promise<unknown> {
    const message = stripModalControls(`Remove MCP server "${name}"?`);
    const confirmed = await this.port.confirm(message, RELOAD_LINE, 'Remove');
    if (!confirmed) {
      throw new Error(`Removing MCP server "${name}" was declined or cancelled.`);
    }
    const result = await client.removeMcpServer(name);
    await this.port.dispatch('reload.mcp', { confirm: true });
    await this.fetchPanelData('mcp');
    return result;
  }

  /**
   * Task A6 (§4.7 item 1): read-only, NOT trust-gated — "same class as
   * `tools.list`" (§4.7). Caches the returned rows on {@link
   * lastCatalogEntries} so `mcp.catalogInstall`'s fail-closed name guard has
   * a session-scoped, server-authored set to check against (never the
   * webview's own claim).
   */
  private async mcpCatalog(client: DashboardAdminClient): Promise<McpCatalogData> {
    const data = await client.listMcpCatalog();
    this.lastCatalogEntries = data.entries;
    return data;
  }

  /**
   * Task A6 (§4.7 items 2-4): `validateCatalogInstall` against the last-
   * LISTED catalog (fail-closed — `mcp.catalog` was never called this
   * session -> `lastCatalogEntries` is `undefined` -> the entry lookup finds
   * nothing) -> `describeCatalogForModal`, passing the VALIDATED submitted
   * env as the 2nd arg (A3-IMP2 binding: the "Credentials are saved…" line
   * must reflect what the user actually submitted, never the entry's
   * `required_env` schema) -> native consent -> `installCatalogEntry`. A
   * synchronous (`background:false`) install resolves immediately; a
   * background (git-bootstrap) install is handed to {@link
   * pollCatalogInstall} for the ground-truth-verified wait (Layer 6).
   * Single-flight per entry name is enforced by the CALLER ({@link
   * handleMcpAdmin}'s synchronous {@link acquireMcpSingleFlight}) — this
   * method never re-checks it.
   */
  private async mcpCatalogInstall(client: DashboardAdminClient, params: unknown): Promise<McpCatalogInstallResult> {
    const validated = validateCatalogInstall(params, this.lastCatalogEntries ?? []);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const { entry, env } = validated;
    const described = describeCatalogForModal(entry, env);
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(
      described.message,
      described.detail,
      entry.needs_install ? 'Install & build' : 'Install',
    );
    if (!confirmed) {
      throw new Error(`Installing MCP "${entry.name}" was declined or cancelled.`);
    }
    const result = await client.installCatalogEntry({ name: entry.name, env, enable: true });
    if (!result.background) {
      await this.port.dispatch('reload.mcp', { confirm: true });
      await this.fetchPanelData('mcp');
      return { ok: true, name: entry.name };
    }
    if (!result.action) {
      throw new Error(`Catalog install of "${entry.name}" started in the background but returned no action id.`);
    }
    return await this.pollCatalogInstall(client, entry.name, result.action);
  }

  /**
   * Task A6 (§4.7 item 2, background branch): poll `actionStatus` at a
   * 1s -> 2s backoff, capped at 180s total (clone+build headroom). On
   * `running:false`, GROUND-TRUTH verify (Layer 6, unexecuted-assurance
   * doctrine): a FRESH `listMcpCatalog()` must show this row's `installed
   * === true` — the exit code alone is never trusted. On a timeout or a
   * still-`installed:false` row, the action's tail `lines` go to the
   * output-channel logger ONLY; the thrown message never carries them.
   */
  private async pollCatalogInstall(
    client: DashboardAdminClient,
    name: string,
    action: string,
  ): Promise<McpCatalogInstallResult> {
    const deadline = Date.now() + CATALOG_POLL_CAP_MS;
    let delay = CATALOG_POLL_FIRST_DELAY_MS;
    let lastLines: string[] = [];
    for (;;) {
      const status = await client.actionStatus(action);
      lastLines = status.lines;
      if (!status.running) break;
      if (Date.now() >= deadline) {
        this.rejectCatalogInstall(name, lastLines);
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = CATALOG_POLL_STEP_DELAY_MS;
    }

    const verify = await client.listMcpCatalog();
    this.lastCatalogEntries = verify.entries;
    const row = verify.entries.find((entry) => entry.name === name);
    if (!row || row.installed !== true) {
      this.rejectCatalogInstall(name, lastLines);
    }

    await this.port.dispatch('reload.mcp', { confirm: true });
    await this.fetchPanelData('mcp');
    return { ok: true, name };
  }

  /**
   * Task A6 (§4.7 item 2, §3 Layer 6): the shared timeout/ground-truth-
   * failure refusal. `tailLines` goes to the output-channel logger only —
   * never into the thrown message (the constraint the reject-message test
   * proves).
   */
  private rejectCatalogInstall(name: string, tailLines: string[]): never {
    this.port.logger?.append(
      `[AcpBackend] catalog install "${name}" did not verify as installed — action tail:\n${tailLines.join('\n')}`,
    );
    throw new Error('Catalog install did not complete — see the Talaria output log.');
  }

  /**
   * Task A6 (§4.8): OAuth login. No modal — the plan calls this "self-
   * evident" (user-initiated browser handoff; the only persisted
   * consequence, `auth: oauth`, is written server-side only on verified
   * success). Cancellation only abandons OUR wait via `AbortSignal`; the
   * Hermes-side flow continues until ITS OWN timeout — the returned
   * envelope's copy says exactly that. Single-flight per name (critic
   * IMPORTANT-3, Hermes's own token snapshot/remove/restore dance,
   * `web_server.py:10592-10629`, is not safe under a concurrent same-name
   * call) is enforced by the CALLER ({@link handleMcpAdmin}'s synchronous
   * {@link acquireMcpSingleFlight}) — this method never re-checks it.
   */
  private async mcpAuth(client: DashboardAdminClient, name: string): Promise<McpTestResult> {
    const result = await this.port.withProgress<McpTestResult>(
      `MCP "${name}" — complete the sign-in in your browser`,
      async (token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await client.authMcpServer(name, controller.signal);
        } catch (err) {
          if (token.isCancellationRequested) {
            return {
              ok: false,
              error: 'Cancelled. The browser sign-in may still be completing — run Test after finishing it.',
              tools: [],
            };
          }
          throw err;
        } finally {
          sub.dispose();
        }
      },
    );
    if (result.ok) {
      await this.fetchPanelData('mcp');
    }
    return result;
  }

  /**
   * Task A5 (§4.5 item 6): NO modal (toggle class — consent already happened
   * at add/install time) -> `setMcpServerEnabled` -> reload -> refetch.
   */
  private async mcpSetEnabled(client: DashboardAdminClient, name: string, enabled: boolean): Promise<unknown> {
    const result = await client.setMcpServerEnabled(name, enabled);
    await this.port.dispatch('reload.mcp', { confirm: true });
    await this.fetchPanelData('mcp');
    return result;
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

/** Task A5: pull `{name}` out of an `mcp.remove`/`mcp.setEnabled`/`mcp.test`/`mcp.auth` payload. */
function extractMcpName(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as { name?: unknown };
  return typeof p.name === 'string' ? p.name : undefined;
}

/** Task A5: pull `{enabled}` out of an `mcp.setEnabled` payload. */
function extractMcpEnabled(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  return (params as { enabled?: unknown }).enabled === true;
}

/**
 * Task A5: `validateMcpAdd` already confirmed `params.transport` is exactly
 * `'stdio'` or `'http'` before returning `ok:true` — this reads that SAME
 * validated discriminant off the original (still-`unknown`) params object,
 * for the `McpAddResult.transport` field and for reconstructing a typed
 * `McpAddParams` to hand `describeAddForModal` (§4.2's own doc: "`transport`
 * is threaded from the VALIDATED McpAddParams discriminant").
 */
function extractValidatedAddTransport(params: unknown): 'stdio' | 'http' {
  const p = params as { transport?: unknown };
  return p.transport === 'http' ? 'http' : 'stdio';
}

/**
 * Task A5: rebuild a typed `McpAddParams` from `validateMcpAdd`'s already-
 * trimmed/validated `body` (which deliberately drops `transport` — the REST
 * wire body has no such field) plus the separately-read discriminant, so the
 * modal text (`describeAddForModal`) reflects the SAME validated bytes that
 * go on the wire (§3 Layer 3: "the modal text derives from the same
 * validated object that goes on the wire").
 */
function toMcpAddParams(
  body: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> },
  transport: 'stdio' | 'http',
): McpAddParams {
  return transport === 'http'
    ? { name: body.name, transport: 'http', url: body.url ?? '' }
    : { name: body.name, transport: 'stdio', command: body.command ?? '', args: body.args ?? [], env: body.env ?? {} };
}

/**
 * Task A6 (§4.7 item 2): background catalog-install poll cadence — the
 * FIRST wait is 1s, every wait after that is 2s, and the total elapsed poll
 * time (first `actionStatus` call to the last) is capped at 180s (clone +
 * build headroom).
 */
const CATALOG_POLL_FIRST_DELAY_MS = 1_000;
const CATALOG_POLL_STEP_DELAY_MS = 2_000;
const CATALOG_POLL_CAP_MS = 180_000;

/** Task A6: a plain `setTimeout` wait — {@link pollCatalogInstall}'s backoff step. Real timers in production; `vi.useFakeTimers()` in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
