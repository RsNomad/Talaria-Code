import type { DataPanel, PanelDataMap, SubagentsData } from '../../shared/protocol';
import type { AcpClientLike } from '../backend/acp/acpClient';
import type { CheckpointTrackerLike } from '../checkpoints/trackerContract';
import type { Logger } from '../transport/JsonRpcStdio';
// Runtime import of the concrete-source wiring. Safe from a cycle: the concrete
// sources import only TYPES back from this module, so nothing here is needed at
// their module-eval time.
import { registerDefaultPanelSources } from './panelSources';

/**
 * The panel-fetch **strategy + registry** (Zone Z3, finding A1).
 *
 * ## Why this exists
 * `AcpBackend.invokeControl` used to be a growing if-ladder: `mcp` was a 2-RPC
 * join, `sessions` an ACP-channel fetch, `subagents` a live-stream fold,
 * `checkpoints` a shadow-git read, and everything else a table-driven
 * `control.dispatch` — each NEW panel source was a new special-case in TWO
 * places (the method + a half-empty reshaper table). That "one god method knows
 * how to fetch everything" shape is the Service-Locator / mega-dispatch
 * anti-pattern: adding a behaviour means EDITING the dispatcher, violating the
 * Open-Closed Principle, and callers can't tell from the type what a panel's
 * source actually is (Mark Seemann, "Service Locator is an Anti-Pattern",
 * https://blog.ploeh.dk/2011/09/19/MessageDispatchingwithoutServiceLocation/;
 * Arialdo Martini, "You probably don't need MediatR",
 * https://arialdomartini.github.io/mediatr — a mega-dispatch `Send()` hides
 * which handlers a caller really depends on).
 *
 * The fix is the classic Strategy-behind-a-Registry: one {@link PanelSource}
 * per panel, looked up by key, so `invokeControl` collapses to
 * `registry.get(panel).fetch(params)` and a NEW source is added by
 * REGISTERING it — never by editing `AcpBackend` (Open-Closed). A registry
 * (rather than a closed discriminated-union dispatch) is specifically the right
 * shape here because a later zone REGISTERS a `DashboardPanelSource` for
 * skills/tools at runtime — the open-extension case a compile-time union
 * cannot express (dev.to, "The Strategy Pattern in TypeScript: Discriminated
 * Unions Beat Subclasses",
 * https://dev.to/gabrielanhaia/the-strategy-pattern-in-typescript-discriminated-unions-beat-subclasses-17na
 * — "When third-party packages register strategies ... at runtime, you cannot
 * put the extension in your union ... A registry of strategy instances is the
 * right shape there"; Slash Engineering, "Scaling 1M lines of TypeScript:
 * Registries", https://puzzles.slash.com/blog/scaling-1m-lines-of-typescript-registries).
 *
 * ## Two-channel invariant (locked, hard requirement)
 * Unifying the DISPATCH does NOT reroute any panel's DATA. Each source keeps
 * its CURRENT channel: session-coupled state stays on the ACP channel
 * (`sessions` via `AcpClient.listSessions`, `subagents` via the live
 * `session/update` fold) and the extension-side tracker (`checkpoints`), while
 * only global config reads (`tools`/`skills`/`mcp`/`models`/`settings`) use the
 * tui_gateway control channel (`dispatch`). Sources reach their channel through
 * {@link PanelSourceContext}; none of them cross wires.
 */

/**
 * What one {@link PanelSource.fetch} resolves to.
 *
 * `data` is the reshaped, typed snapshot the backend broadcasts as a
 * `panel.data` push (`undefined` SUPPRESSES the push — e.g. the Sessions source
 * before an ACP client exists, mirroring the old `refreshSessionsPanel`'s
 * `if (!this.client) return undefined`).
 *
 * A#6: this used to carry a second `result?: unknown` field so single-RPC
 * sources could resolve `invokeControl` with the RAW upstream RPC result. That
 * split was DEAD WEIGHT — the sole consumer (`fetchPanel` in
 * `webview/state/panels.ts`) ignores the resolved value entirely (the reshaped
 * snapshot only ever rides the `panel.data` push), so a source that set `result`
 * had zero observable effect. Collapsed to just `data`; `fetchPanelData` now
 * resolves with `data` for every source.
 */
export interface PanelFetchOutcome<P extends DataPanel> {
  readonly data: PanelDataMap[P] | undefined;
}

/**
 * A strategy that knows how to fetch ONE panel's data from its (unchanged)
 * channel and reshape it to the typed `PanelDataMap[P]`. Framework-free (no
 * `vscode`): the backend owns the actual `panel.data` emit, so each source is
 * a pure, independently unit-testable fetch/reshape unit.
 */
export interface PanelSource<P extends DataPanel> {
  fetch(params?: unknown): Promise<PanelFetchOutcome<P>>;
  /**
   * OPTIONAL: drop any cross-fetch accumulated state when the session context
   * resets (a new session / a `session/load`). Only sources that page and
   * accumulate need this — currently just the Sessions source (X3), whose
   * paginated "Load more" appends onto prior pages; a session change must not
   * carry the old workspace's accumulated list forward. Sources without
   * cross-fetch state omit it.
   */
  reset?(): void;
}

/**
 * The dependencies a {@link PanelSource} may need, injected by `AcpBackend` so
 * sources never import the backend concretely. Live-mutating handles
 * (`getAcpClient`/`getCwd`) are ACCESSORS, not snapshots, because the ACP
 * client and resolved cwd change across `start()`/`session/load` — a source
 * must read them at fetch time, not construction time.
 *
 * W4-T3b (§7 B6): every session/root-scoped accessor below takes the target
 * identity as an EXPLICIT parameter — never an ambient "the active
 * session/root" lookup. A fetch for tab B's panel that resolves AFTER the
 * user switches to tab C must still read B's session/root, not whichever is
 * "active" when the accessor is finally called; the draft's
 * `getActiveSessionView()`-style ambient accessor was rejected for exactly
 * this reason (the eternal-spinner class this repo has fixed twice). The
 * accessor PATTERN survives only for the connection-global handles
 * (`getAcpClient`, `dispatch`) — there is only ever one live connection.
 */
export interface PanelSourceContext {
  /** tui_gateway control-plane RPC (global config channel). */
  dispatch(method: string, params?: unknown): Promise<unknown>;
  /** The live ACP client, or `undefined` before `start()` (session-coupled channel). */
  getAcpClient(): AcpClientLike | undefined;
  /**
   * The connection-level DEFAULT cwd `start()` resolved — used ONLY as the
   * last-resort fallback when a fetch carries no explicit `sessionId`/`cwd`
   * (a stray unscoped internal call; every real webview-triggered fetch
   * supplies one, §7 B6).
   */
  getCwd(): string | undefined;
  /**
   * W4-T3b (§7 B6): a SPECIFIC session's resolved cwd, by explicit
   * `sessionId` — the `sessions` source's scope-aware cwd resolution.
   * `undefined` if no controller is registered for `sessionId`.
   */
  getSessionCwd(sessionId: string): string | undefined;
  /**
   * W4-T3b (§7 B6, was `getSubagentsSnapshot()`): a read-only snapshot of a
   * SPECIFIC session's live subagents fold, by explicit `sessionId` (the
   * fold lives on the per-session `SessionController`, §2a). `undefined`
   * when `sessionId` names no live controller; the `subagents` source
   * treats that the same as an empty fold.
   */
  getSessionSubagentsSnapshot(sessionId: string): SubagentsData | undefined;
  /**
   * W4-T3b (§7 B6/B7, was the single ambient `checkpointTracker` field): the
   * extension-side shadow-git tracker for a SPECIFIC root, by explicit
   * `rootId` — checkpoints are per-ROOT now (§3.2), so a single ambient
   * tracker can no longer answer "which root's timeline". `undefined` when
   * `rootId` is absent/unregistered (checkpoints unavailable for it).
   */
  getRootTracker(rootId: string): CheckpointTrackerLike | undefined;
  readonly logger?: Logger;
}

/**
 * A typed `panel -> PanelSource` map. `register` adds/overrides a source
 * WITHOUT any change to `AcpBackend` (the Open-Closed extension point a later
 * dashboard zone uses); `get` looks one up and throws if a panel was never
 * registered (a programmer error — every {@link DataPanel} is registered by
 * {@link createDefaultPanelSources}).
 */
export class PanelSourceRegistry {
  // Heterogeneous by panel key; the `register`/`get` signatures keep each
  // panel's source pinned to its own `PanelDataMap[P]`, so the internal cast
  // (unavoidable for a per-key-typed map) is sound at every call site.
  private readonly sources = new Map<DataPanel, PanelSource<DataPanel>>();

  register<P extends DataPanel>(panel: P, source: PanelSource<P>): void {
    this.sources.set(panel, source as unknown as PanelSource<DataPanel>);
  }

  get<P extends DataPanel>(panel: P): PanelSource<P> {
    const source = this.sources.get(panel);
    if (!source) {
      throw new Error(`No PanelSource registered for panel '${panel}'`);
    }
    return source as unknown as PanelSource<P>;
  }

  has(panel: DataPanel): boolean {
    return this.sources.has(panel);
  }
}

/**
 * Build a registry with the 8 default sources registered (tools, skills,
 * models, settings, mcp, sessions, subagents, checkpoints). A later zone can
 * `register()` a replacement (e.g. a dashboard-backed skills/tools source)
 * onto the returned registry without touching this factory or `AcpBackend`.
 */
export function createDefaultPanelSources(context: PanelSourceContext): PanelSourceRegistry {
  const registry = new PanelSourceRegistry();
  registerDefaultPanelSources(registry, context);
  return registry;
}
