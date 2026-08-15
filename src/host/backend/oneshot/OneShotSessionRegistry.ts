/**
 * TG-5 (AU-51, `docs_claude/audit-fix-architecture.md` — ADR-4): layer 1 of
 * the two-layer one-shot-cleanup fix. The ACP wire has NO `session/close` —
 * every ephemeral `session/new` `OneShotRunner` mints (commit-message
 * generation etc.) persists server-side forever (`acp_adapter/session.py`
 * `create_session` -> `_persist`, confirmed at `:210-229`) and would
 * otherwise surface in `session.list` alongside real conversations
 * (INV-20: "Utility (one-shot) sessions never surface in user-facing
 * history"). Layer 2 (best-effort `session.delete` via the tui_gateway
 * control plane, `AcpBackend.deleteOneShotSession`) cleans the SHARED
 * `~/.hermes/state.db` row when it can — but that RPC can fail (control
 * channel down, races) and can never reach the acp child's own in-memory
 * `_sessions` (invisible to us regardless — the acp/gateway process split,
 * `tui_gateway/server.py:5973-5980`'s active-guard only ever sees the
 * gateway's OWN sessions). This registry is the DETERMINISTIC guarantee:
 * every id `OneShotRunner` ever mints is recorded here, and
 * `reshapeSessionsList` drops any id this registry knows about before the
 * panel ever sees it — regardless of whether layer 2 ever succeeds.
 *
 * Headless (no `vscode`) like every other `oneshot/`/`acp/`-style module —
 * `AcpBackend` owns the instance and is the only caller that touches
 * `workspaceState` (via {@link ONESHOT_SESSION_IDS_STORAGE_KEY}), so a
 * window reload re-seeds this registry from the persisted array instead of
 * resurfacing every one-shot id ever minted this install.
 */

/**
 * The `workspaceState` key `AcpBackend` persists {@link OneShotSessionRegistry.toArray}
 * under — insertion-ordered, oldest-first, capped at {@link MAX_ONESHOT_SESSION_IDS}.
 */
export const ONESHOT_SESSION_IDS_STORAGE_KEY = 'talaria.oneshot.sessionIds';

/**
 * The registry's LRU bound (TG-5's pinned value). One-shots are rare
 * (commit-message generation, similar utility calls) — 200 is generous
 * headroom while keeping the persisted `workspaceState` array, and the
 * in-memory `Set`, from growing unboundedly over an install's lifetime.
 */
export const MAX_ONESHOT_SESSION_IDS = 200;

/**
 * A bounded, insertion-ordered registry of ephemeral one-shot session ids —
 * a `Set<string>` (O(1) {@link has}) paired with an ordered array so the
 * OLDEST id can be evicted once {@link MAX_ONESHOT_SESSION_IDS} is exceeded
 * (a plain `Map<string, true>` would work too; the explicit array reads
 * more plainly for `toArray`'s persistence round-trip).
 */
export class OneShotSessionRegistry {
  /** Insertion order, oldest first — index 0 is the next eviction candidate. */
  private readonly order: string[] = [];
  private readonly idSet = new Set<string>();

  /**
   * @param initial A previously-persisted id list (`workspaceState.get(ONESHOT_SESSION_IDS_STORAGE_KEY)`,
   *   oldest-first) to re-seed from — a window reload rehydrates the exact
   *   same registry instead of starting empty (and resurfacing every past
   *   one-shot id in `session.list` until each is individually re-minted and
   *   re-recorded). Routed through {@link record} so a persisted list longer
   *   than {@link MAX_ONESHOT_SESSION_IDS} (should never happen — writes are
   *   always bounded — but defensive) still comes out correctly bounded.
   */
  constructor(initial: readonly string[] = []) {
    for (const id of initial) this.record(id);
  }

  /** True iff `id` is a known ephemeral one-shot session id. */
  has(id: string): boolean {
    return this.idSet.has(id);
  }

  /**
   * Record `id` as a minted ephemeral one-shot session, evicting the oldest
   * entry if this push exceeds {@link MAX_ONESHOT_SESSION_IDS}. Returns
   * `true` iff this call actually added a NEW id (the caller — `AcpBackend`
   * — uses this to skip a redundant `workspaceState.update` for an
   * already-known id; re-recording the same id is a harmless no-op either
   * way, `has` already true).
   */
  record(id: string): boolean {
    if (this.idSet.has(id)) return false;
    this.idSet.add(id);
    this.order.push(id);
    if (this.order.length > MAX_ONESHOT_SESSION_IDS) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.idSet.delete(evicted);
    }
    return true;
  }

  /** The read-only view {@link PanelSourceContext.getOneShotSessionIds} hands
   *  `reshapeSessionsList` — same "return the live Set, typed readonly, no
   *  defensive copy" posture `McpPanelSource.lastListedNames` already uses. */
  ids(): ReadonlySet<string> {
    return this.idSet;
  }

  /** Oldest-first snapshot for persistence (`workspaceState.update`). */
  toArray(): string[] {
    return [...this.order];
  }

  /** Current entry count — always `<= MAX_ONESHOT_SESSION_IDS`. */
  get size(): number {
    return this.order.length;
  }
}

/**
 * The narrow `workspaceState` port {@link OneShotSessionRegistry}'s owner
 * (`AcpBackend`) persists through — mirrors `SetupController`'s
 * `SetupHost.globalState`/`setupHost.vscode.ts`'s `context.globalState`
 * wiring (same `{get, update}` shape, same "host-only, injected" posture),
 * scoped to `workspaceState` instead of `globalState` per this fix's
 * pinned key (a one-shot id registry is workspace-scoped, matching every
 * OTHER piece of this connection's state).
 */
export interface WorkspaceStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}
