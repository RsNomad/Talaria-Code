import type { ControlDispatcherHostPort } from './ControlDispatcher';
import type { DataPanel, GlobalPanel, HostToWebview, PanelDataMap } from '../../../shared/protocol';
import { makePanelData } from '../../../shared/protocol';
import { PanelUnavailableError } from '../../panels/PanelSourceRegistry';
import { extractCwd, extractRootId, extractSessionId } from '../../panels/panelSources';
import { redactSecretsDeep } from '../../redactControlResponse';

/**
 * WS-GD.2a Task A4: the slice of {@link ControlDispatcherHostPort} the
 * panels domain needs — see {@link PanelDataCoordinator}.
 */
export type PanelDataPort = Pick<
  ControlDispatcherHostPort,
  'emit' | 'logger' | 'panelSources' | 'sessions' | 'rootRegistry' | 'getConnectionCwd'
>;

/**
 * WS-GD.2a Task A4: the panels domain, extracted off `ControlDispatcher`
 * (pure move — every member below is a verbatim lift, comments included).
 */
export class PanelDataCoordinator {
  /**
   * W4 §2d: the fallback stamped on a session-scoped emit when there is no
   * active session to tag a global panel push to. Never used on a healthy
   * path.
   */
  private static readonly UNKNOWN_SESSION_ID = 'unknown-session';

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

  constructor(private readonly port: PanelDataPort) {}

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
   *
   * AU-10: an `unavailable` outcome REJECTS this call with a
   * {@link PanelUnavailableError} instead of resolving with no data — the
   * old `outcome.data !== undefined` gate silently swallowed BOTH the push
   * AND the resolve for exactly this case, leaving the webview's correlated
   * request resolved-with-nothing and its `RemoteData` stuck in `loading`
   * forever (INV-14). The reject is UNCONDITIONAL (never staleness-gated,
   * unlike the push below) — same "the caller's own correlated answer is
   * always honest" posture the staleness comment already documents.
   */
  async fetchPanelData<P extends DataPanel>(panel: P, params?: unknown): Promise<unknown> {
    const scopedParams = this.withResolvedSessionsScope(panel, this.withDefaultCheckpointsScope(panel, params));
    // T-12: mint this attempt's sequence token for its scope BEFORE the
    // fetch starts, so a caller that races ahead (issued LATER, resolves
    // FIRST) bumps the scope's latest token before this one's belated
    // resolution gets a chance to check it.
    const scopeKey = this.panelScopeKey(panel, scopedParams);
    const seq = (this.panelFetchSeq.get(scopeKey) ?? 0) + 1;
    this.panelFetchSeq.set(scopeKey, seq);

    const outcome = await this.port.panelSources.get(panel).fetch(scopedParams);

    if ('unavailable' in outcome) {
      throw new PanelUnavailableError(outcome.unavailable);
    }

    // The CALLER's own correlated return value is always honest — a caller
    // that explicitly asked for this fetch gets its own answer regardless of
    // races. Only the BROADCAST push (shared, ambient webview state) has the
    // overwrite hazard, so only it is gated: a superseded attempt (a newer
    // fetch for the SAME scope has since landed) drops its push silently.
    if (this.panelFetchSeq.get(scopeKey) === seq) {
      // CA-M19 [SECURITY]: the proactive push IS the render path (the correlated
      // control.response is REDACTION_EXEMPT + ignored by the webview for panel
      // fetches). Route the pushed data through the SAME deny-list walker the
      // response path uses — `redactSecretsDeep` is the ungated twin of
      // `redactControlResponse` (one doctrine, not two). Over-redaction of a
      // genuinely secret-shaped key is the SAFE direction (belt doctrine).
      const redacted = redactSecretsDeep(outcome.data) as PanelDataMap[P];
      this.port.emit(this.buildPanelDataMessage(panel, redacted, scopedParams));
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
      return `subagents:${extractSessionId(params) ?? PanelDataCoordinator.UNKNOWN_SESSION_ID}`;
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
   * F3-16: the T-12 staleness gate key and the pushed panel scope must agree
   * and be STABLE across the fetch await. Both `panelScopeKey` and
   * `buildPanelDataMessage` derive the `sessions` cwd from LIVE mutable state
   * (`this.port.sessions`/`getConnectionCwd()`), read at two different times
   * (pre- and post-await) — a mid-await mutation makes them disagree. Resolve
   * the cwd ONCE at fetch entry and stamp it into the (now immutable)
   * scopedParams; both consumers already prefer `extractCwd(params)`, so they
   * then read this single snapshot instead of re-resolving live state.
   *
   * Only stamps when a REAL cwd resolves (session cwd or connection cwd) —
   * when NEITHER resolves, `params` is returned unchanged rather than
   * stamping a synthetic `''`. `scopedParams` is also what's handed to the
   * `PanelSource` itself ({@link fetchPanelData}), and `SessionsPanelSource
   * .resolveCwd` has its OWN richer fallback (`PanelSourceContext
   * .getSessionCwd`/`.getCwd`) for the "nothing resolved yet" case — stamping
   * an empty string here would short-circuit that fallback with a literal
   * `''` instead of leaving `cwd` absent for it to resolve itself (verified
   * against `AcpBackend.test.ts`'s pinned `{cwd: undefined}` `listSessions`
   * calls, which are independent of `buildPanelDataMessage`'s OWN unrelated
   * `?? ''` push-scope default).
   */
  private withResolvedSessionsScope(panel: DataPanel, params: unknown): unknown {
    if (panel !== 'sessions' || extractCwd(params) !== undefined) return params;
    const scopedSessionId = extractSessionId(params);
    const cwd =
      (scopedSessionId !== undefined ? this.port.sessions.get(scopedSessionId)?.cwd : undefined) ??
      this.port.getConnectionCwd();
    if (cwd === undefined) return params;
    const base = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    return { ...base, cwd };
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
      const sessionId = extractSessionId(params) ?? PanelDataCoordinator.UNKNOWN_SESSION_ID;
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
   * Pull a valid `{panel}` out of a `switchPanel`/`panel.data` params object,
   * gated on the panel actually having a registered `PanelSource`. Moved
   * verbatim off `AcpBackend.extractPanel`.
   */
  extractPanel(params: unknown): DataPanel | undefined {
    if (params && typeof params === 'object' && 'panel' in params) {
      const panel = (params as { panel?: unknown }).panel;
      if (typeof panel === 'string' && this.port.panelSources.has(panel as DataPanel)) {
        return panel as DataPanel;
      }
    }
    return undefined;
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

  /**
   * CA-M04: drop the unbounded per-SESSION fetch-seq entry when a tab/session
   * closes. `subagents:${sessionId}` is the only `panelFetchSeq` key that grows
   * without bound (a fresh session id per session/restart); `sessions:${cwd}`
   * and `checkpoints:${rootId}` are bounded by the finite set of roots/cwds AND
   * shared across tabs, so they are deliberately NOT pruned here. The key
   * format MUST match {@link panelScopeKey}'s `subagents` branch verbatim.
   * Wired by this class's own constructor as the `SessionRegistry.setOnClosed`
   * hook — every registry close path prunes; no per-site wiring (CA-M04b).
   */
  pruneFetchSeqForSession(sessionId: string): void {
    this.panelFetchSeq.delete(`subagents:${sessionId}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
