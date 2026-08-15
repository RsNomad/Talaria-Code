import type {
  McpData,
  SessionsData,
  SessionSummary,
  SubagentsData,
  CheckpointsData,
} from '../../shared/protocol';
import type { AcpClientLike, AcpListSessionsRawResult } from '../backend/acp/acpClient';
import { CheckpointLockTimeoutError } from '../checkpoints/CheckpointTracker';
import type { ToggleNameCache } from '../dashboard/dashboardPanelSources';
import type {
  PanelFetchOutcome,
  PanelSource,
  PanelSourceContext,
  PanelSourceRegistry,
} from './PanelSourceRegistry';
import {
  reshapeConfigShow,
  reshapeMcpServers,
  reshapeModelOptions,
  reshapeSessionsList,
  reshapeSkillsList,
  reshapeToolsList,
  type RawConfigFullResult,
  type RawConfigShowResult,
  type RawModelOptionsResult,
  type RawSessionListResult,
  type RawSkillsManageListResult,
  type RawToolsListResult,
} from './reshapePanelData';

/**
 * The 8 concrete {@link PanelSource}s (Zone Z3, finding A1) — one per data
 * panel. Each keeps its panel's ORIGINAL channel (see the two-channel invariant
 * on {@link PanelSourceContext}); this module only unifies the DISPATCH shape,
 * never the routing. The pure `reshape*` functions live in `reshapePanelData.ts`
 * (well-tested there); the sources OWN calling them at the right point in each
 * fetch (the old `reshapePanelData` dispatch table + `AcpBackend.emitPanelData`
 * that also called them were deleted — A#3).
 */

/* ---- tui_gateway single-RPC sources (global config channel) -------------- *
 * These resolve `{ data: reshaped }`: the reshaped data both rides the
 * `panel.data` push AND is what `invokeControl` resolves with. The old
 * `result: raw` split (RAW upstream result on the resolve) was dropped — its
 * sole consumer (the webview's `fetchPanel`) ignored the resolved value, so it
 * had zero observable effect (finding A#6).
 *
 * F10 (TG-6, AU-OBS-L3) — FROZEN CONTRACT: these five sources (`ToolsPanelSource`,
 * `SkillsPanelSource`, `ModelsPanelSource`, `SettingsPanelSource`, and
 * `McpPanelSource`'s two dispatches) deliberately ride the gateway's global
 * config channel with NO session scoping of their own — none of them reads,
 * resolves, or constructs an acp `sessionId` (contrast `SessionsPanelSource`/
 * `SubagentsPanelSource`, which explicitly do via `ctx.getSessionCwd`/
 * `extractSessionId`). This is not an oversight to "helpfully" fix later: the
 * gateway process routes by ITS OWN `_sessions` dict
 * (`tui_gateway/server.py:5949-5988`, keyed at `:5966-5980`), which NEVER
 * contains an acp-child session id — that id lives in a completely different
 * namespace (`acp_adapter/session.py`). A dispatch that has no matching key in
 * `_sessions` falls back to the gateway's own unknown-session global handling,
 * which is exactly the behavior these config RPCs want (there is only ever
 * one gateway-side config to read). Threading an acp `sessionId` into one of
 * these dispatches expecting it to SCOPE the result would be a category
 * error — the id means nothing on this wire — so no source here should ever
 * be edited to add that.
 *
 * GROUNDING NOTE (do not remove without re-verifying): `ToolsPanelSource`,
 * `ModelsPanelSource`, and `SettingsPanelSource` forward their `fetch(params)`
 * argument to `ctx.dispatch` UNFILTERED; `SkillsPanelSource` spreads it too
 * (merging in `action:'list'`) — none of the four inspects or strips a
 * `sessionId` key if one is present in `params`. Today no caller ever puts one
 * there: `webview/src/state/panels.ts`'s `resolvePanelRequest` exhaustively
 * switches on `DataPanel` and only adds `sessionId` for the `subagents`/
 * `sessions` branches (`tools`/`mcp`/`skills`/`models`/`settings`/`setup`
 * return bare `{panel}`), and every host-internal `fetchPanelData('mcp'|
 * 'skills'|'models', …)` call site (`ControlDispatcher.ts`) passes no params
 * at all. So the "no session scoping" guarantee these four sources enjoy
 * today is a CALLER-CONVENTION guarantee, not a defense in this file — only
 * `McpPanelSource` is structurally immune (its `fetch` takes no params at
 * all). Locked (the source-side half — no source may start EXPLICITLY
 * threading a session id into its own dispatch) by
 * `panelSources.gatewayScope.test.ts`.
 * -------------------------------------------------------------------------- */

/** `tools.list` -> `ToolsData` (`tui_gateway/server.py:13439-13465`). */
export class ToolsPanelSource implements PanelSource<'tools'> {
  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'tools'>> {
    const raw = await this.ctx.dispatch('tools.list', params);
    return { data: reshapeToolsList(raw as RawToolsListResult) };
  }
}

/**
 * `skills.manage {action:"list"}` -> `SkillsData`. The `action:'list'` param is
 * merged in explicitly (mirrors the old `PANEL_REFRESH_PARAMS.skills`): the
 * gateway's `skills.manage` is keyed on `action`, and while its default happens
 * to be `"list"` today (`server.py:13717-13724`), that default is an
 * implementation detail we don't lean on silently.
 */
export class SkillsPanelSource implements PanelSource<'skills'> {
  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'skills'>> {
    const dispatchParams = { ...(params as Record<string, unknown> | undefined), action: 'list' };
    const raw = await this.ctx.dispatch('skills.manage', dispatchParams);
    return { data: reshapeSkillsList(raw as RawSkillsManageListResult) };
  }
}

/** `model.options` -> `ModelsData` (`server.py:12383-12421`; reshaper grounded in `build_models_payload`). */
export class ModelsPanelSource implements PanelSource<'models'> {
  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'models'>> {
    const raw = await this.ctx.dispatch('model.options', params);
    return { data: reshapeModelOptions(raw as RawModelOptionsResult) };
  }
}

/** `config.show` -> `SettingsData` (`server.py:13400-13434`, read-only display dump). */
export class SettingsPanelSource implements PanelSource<'settings'> {
  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'settings'>> {
    const raw = await this.ctx.dispatch('config.show', params);
    return { data: reshapeConfigShow(raw as RawConfigShowResult) };
  }
}

/* ---- join / fold / native sources (resolve with the reshaped data) ------- */

/**
 * The Zone CFG MCP-hub join: `config.get({key:"full"}).mcp_servers` +
 * `tools.list`'s per-toolset `tool_count` -> `McpData`. No single tui_gateway
 * RPC returns this shape (`contracts-tui-gateway.md` §3 GAPS #1). Still the
 * tui_gateway channel (global config), just two RPCs — dispatched in order so
 * `config.get` precedes `tools.list` on the wire.
 */
export class McpPanelSource implements PanelSource<'mcp'>, ToggleNameCache {
  /** Server names from the last successful `config.get` (the toggle key set, S-M4). */
  private knownNames: Set<string> | undefined;

  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(): Promise<PanelFetchOutcome<'mcp'>> {
    const [config, tools] = await Promise.all([
      this.ctx.dispatch('config.get', { key: 'full' }),
      this.ctx.dispatch('tools.list', {}),
    ]);
    const rawConfig = config as RawConfigFullResult;
    this.knownNames = new Set(Object.keys(rawConfig.mcp_servers ?? {}));
    const data: McpData = reshapeMcpServers(rawConfig, tools as RawToolsListResult);
    return { data };
  }

  lastListedNames(): ReadonlySet<string> | undefined {
    return this.knownNames;
  }
}

/** One cwd's independent accumulation/coalescing state (W4-T3b §7 B7). */
interface SessionsCwdBucket {
  accumulated: SessionSummary[];
  seenIds: Set<string>;
  /** In-flight fetches keyed by cursor (`''` = the cursor-less page-1 fetch). */
  inFlight: Map<string, Promise<PanelFetchOutcome<'sessions'>>>;
}

function newBucket(): SessionsCwdBucket {
  return { accumulated: [], seenIds: new Set(), inFlight: new Map() };
}

/**
 * Zone HIST: the History panel's data from the ACP channel
 * (`AcpClient.listSessions`), NOT tui_gateway — session-coupled state stays on
 * its channel (two-channel invariant). `cwd` resolves from an explicit scope
 * key on the fetch (`cwd`, else via `sessionId` -> `ctx.getSessionCwd`),
 * falling back to the connection-level default only as a last resort (§7 B6).
 *
 * ## Pagination accumulation (X3) — host-side, so no webview reducer change
 * `session/list` returns ONE page (server page size 50) plus a `nextCursor`.
 * The webview's `panel.data` reducer wholesale-REPLACES `panelData.sessions`
 * with each push, so if this source emitted only the freshly-fetched page,
 * "Load more" (page 2) would DROP page 1 and mis-report the count. Instead this
 * source ACCUMULATES:
 *  - a fetch WITHOUT a cursor is a fresh page-1 load (switchTab / refresh) and
 *    RESETS the accumulation before appending;
 *  - a fetch WITH a cursor ("Load more") APPENDS onto the accumulated list;
 *  - either way it emits the FULL accumulated list, so the wholesale-replace
 *    reducer renders every page. Entries are de-duped by `id` (a page overlap
 *    or a double-click can't insert a session twice / break React keys).
 * {@link reset} additionally clears the accumulation on a new session /
 * `session/load` (called by `AcpBackend`), so a different workspace's history
 * never carries forward.
 *
 * ## Per-cwd scoping (§7 B7 — load-bearing correction)
 * The accumulation/coalescing state above used to be SINGLETON instance
 * state — under multi-tab with different cwds, tab A's "Load more" would
 * wrongly append A's page onto tab B's accumulated page, and the
 * cursor-keyed `inFlight` would coalesce two DIFFERENT cwds' fetches onto
 * one result. Each cwd now gets its OWN {@link SessionsCwdBucket}, keyed by
 * the resolved cwd — same behavior as before for the single-cwd case,
 * correct for the multi-cwd one. {@link reset} clears every bucket (a
 * connection-level reset — T1a's active-controller-reuse approximation for
 * `session.load` still doesn't know which ONE cwd changed, so a full reset
 * is the safe degrade until T5's real per-tab targeting).
 *
 * ## Re-entrancy guard (A#7)
 * "Load more" is now a CORRELATED request (the webview awaits it), and two
 * rapid clicks fire the SAME `{cursor}` twice. `seenIds` already blocks a
 * DOUBLE-APPEND of the same rows, but each overlapping fetch would still hit the
 * ACP channel and emit its own push. So a fetch already in flight for a given
 * cursor is COALESCED: a concurrent fetch with the same cursor key returns the
 * in-flight promise instead of issuing a second `listSessions`. This makes
 * "load more" idempotent under overlapping clicks.
 */
export class SessionsPanelSource implements PanelSource<'sessions'> {
  private readonly buckets = new Map<string, SessionsCwdBucket>();

  constructor(private readonly ctx: PanelSourceContext) {}

  private bucketFor(cwd: string): SessionsCwdBucket {
    let bucket = this.buckets.get(cwd);
    if (!bucket) {
      bucket = newBucket();
      this.buckets.set(cwd, bucket);
    }
    return bucket;
  }

  /** §7 B6: explicit `cwd` wins; else resolve via an explicit `sessionId`;
   * else the connection-level default (last resort — see the class doc).
   * `!== undefined` throughout (never truthiness) — an empty-string cwd is
   * a real value the ORIGINAL `client.listSessions(this.ctx.getCwd(), …)`
   * call always passed through as-is; coercing it to "absent" would be the
   * exact falsy-empty-string class of bug D1 fixed. */
  private resolveCwd(params: unknown): string | undefined {
    const explicitCwd = extractCwd(params);
    if (explicitCwd !== undefined) return explicitCwd;
    const sessionId = extractSessionId(params);
    const viaSession = sessionId !== undefined ? this.ctx.getSessionCwd(sessionId) : undefined;
    if (viaSession !== undefined) return viaSession;
    return this.ctx.getCwd();
  }

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'sessions'>> {
    const client = this.ctx.getAcpClient();
    // AU-10: no client yet is a TERMINAL "unavailable" outcome, not a silent
    // `{data: undefined}` hold — `ControlDispatcher.fetchPanelData` rejects
    // the correlated request with this reason, which the webview's existing
    // `fetchPanel` catch path renders as an honest, retryable error instead
    // of spinning on "Loading…" forever (see `PanelFetchOutcome`'s own doc).
    if (!client) return { unavailable: 'Agent is not connected yet.' };

    // The bucket MAP needs a concrete string key; the CLIENT call keeps
    // `cwd` as `string | undefined` (an unresolved cwd is passed through
    // as `undefined`, exactly like the pre-T3b single-bucket code did —
    // never silently coerced to `''`).
    const cwd = this.resolveCwd(params);
    const bucket = this.bucketFor(cwd ?? '');
    const cursor = extractCursor(params);
    const key = cursor ?? '';
    // Re-entrancy: coalesce a concurrent duplicate (a double-clicked "Load
    // more") onto the already-in-flight fetch so it can't double-append or
    // double-hit the ACP channel.
    const existing = bucket.inFlight.get(key);
    if (existing) return existing;

    const run = this.fetchPage(client, cwd, bucket, cursor);
    bucket.inFlight.set(key, run);
    try {
      return await run;
    } finally {
      bucket.inFlight.delete(key);
    }
  }

  private async fetchPage(
    client: AcpClientLike,
    cwd: string | undefined,
    bucket: SessionsCwdBucket,
    cursor: string | undefined,
  ): Promise<PanelFetchOutcome<'sessions'>> {
    // A cursor-less fetch is a fresh page-1 load — start THIS cwd's
    // accumulation over so re-opening the panel doesn't stack duplicate
    // pages / rewind the cursor.
    if (cursor === undefined) {
      bucket.accumulated = [];
      bucket.seenIds.clear();
    }

    const raw: AcpListSessionsRawResult = await client.listSessions(cwd, cursor);
    // TG-5 (AU-51, INV-20): drop any ephemeral one-shot session id
    // (`OneShotRunner`'s `session/new` mints) before it ever enters the
    // accumulated page — see `reshapeSessionsList`'s own doc.
    const page: SessionsData = reshapeSessionsList(raw as RawSessionListResult, this.ctx.getOneShotSessionIds());

    for (const session of page.sessions) {
      if (bucket.seenIds.has(session.id)) continue;
      bucket.seenIds.add(session.id);
      bucket.accumulated.push(session);
    }

    const data: SessionsData = { sessions: [...bucket.accumulated] };
    if (page.nextCursor !== undefined) data.nextCursor = page.nextCursor;
    return { data };
  }

  /** Drop every cwd's accumulated pages (new session / `session/load`). */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Zone SUB: the Subagents panel is whatever ONE SPECIFIC session's live
 * `SubagentAccumulator` fold has produced from the ACP `session/update`
 * stream's `delegate_task` events — never an RPC. The fold lives on the
 * per-session `SessionController` (§2a); W4-T3b (§7 B6) reads it by the
 * EXPLICIT `sessionId` the fetch carries (never an ambient "active session"
 * accessor — subagents is the ONE genuinely per-tab panel, so resolving the
 * wrong session here is a direct P-1 bleed). A missing/unregistered
 * `sessionId` degrades to an empty fold, exactly like a freshly-constructed
 * accumulator did before that session ever started.
 */
export class SubagentsPanelSource implements PanelSource<'subagents'> {
  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'subagents'>> {
    const sessionId = extractSessionId(params);
    // `!== undefined` (never truthiness) — an empty-string id is a real,
    // if unusual, value; the D1 class of bug this repo just fixed once
    // (`rootId ?? ` vs `rootId ||`) is exactly a falsy-empty-string check.
    const data: SubagentsData = (sessionId !== undefined ? this.ctx.getSessionSubagentsSnapshot(sessionId) : undefined) ?? {
      delegations: [],
    };
    return { data };
  }
}

/**
 * Zone CKPT: the Checkpoints panel's data is `CheckpointTracker.list()` (the
 * extension-side shadow-git tracker), already the exact `CheckpointsData` shape.
 *
 * W4-T3b (§7 B6/B7): resolves the tracker by the EXPLICIT `rootId` the fetch
 * carries, via `ctx.getRootTracker(rootId)` — checkpoints are per-ROOT (one
 * shared timeline across every same-root tab, §3.2), so there is no longer
 * a single ambient tracker to fall back on; a missing/unregistered `rootId`
 * degrades to the disabled state, same as "no tracker wired" always did.
 *
 * Zone Z9 deferral #2 — transient vs permanent (this REPLACES the old
 * `refreshCheckpointsPanel` blanket-catch-as-unavailable masking):
 *  - a {@link CheckpointLockTimeoutError} is TRANSIENT (another window/process
 *    is mid-operation) and RE-THROWN, so `invokeControl` rejects and Z2's
 *    RemoteData surfaces `error.retryable=true` + a working Retry;
 *  - a no-tracker case (no workspace, or an unresolved rootId) or any
 *    GENUINE-PERMANENT failure (`GitUnavailableError`, a corrupt index)
 *    resolves to the disabled `available:false` state (a non-retryable
 *    "checkpoints unavailable" panel), preserving the old behaviour for
 *    real permanent errors.
 */
export class CheckpointsPanelSource implements PanelSource<'checkpoints'> {
  constructor(private readonly ctx: PanelSourceContext) {}

  async fetch(params?: unknown): Promise<PanelFetchOutcome<'checkpoints'>> {
    const rootId = extractRootId(params);
    // `!== undefined` (never truthiness) — an empty-string rootId is a real
    // value here (an unrooted/no-cwd controller canonicalizes to `''`, per
    // `canonicalizeWorkspaceRoot`'s own doc), not "absent".
    const tracker = rootId !== undefined ? this.ctx.getRootTracker(rootId) : undefined;
    if (!tracker) {
      const data: CheckpointsData = {
        checkpoints: [],
        available: false,
        unavailableReason: rootId !== undefined ? 'Unknown workspace root.' : 'No workspace open.',
      };
      return { data };
    }
    try {
      const data = await tracker.list();
      return { data };
    } catch (err) {
      if (err instanceof CheckpointLockTimeoutError) {
        // Transient: let it reject -> retryable error state, NOT a permanent
        // `available:false` disabled panel.
        throw err;
      }
      const data: CheckpointsData = {
        checkpoints: [],
        available: false,
        unavailableReason: errorMessage(err),
      };
      return { data };
    }
  }
}

/** Register all 8 default sources onto `registry`. Called by `createDefaultPanelSources`. */
export function registerDefaultPanelSources(
  registry: PanelSourceRegistry,
  context: PanelSourceContext,
): void {
  registry.register('tools', new ToolsPanelSource(context));
  registry.register('skills', new SkillsPanelSource(context));
  registry.register('models', new ModelsPanelSource(context));
  registry.register('settings', new SettingsPanelSource(context));
  registry.register('mcp', new McpPanelSource(context));
  registry.register('sessions', new SessionsPanelSource(context));
  registry.register('subagents', new SubagentsPanelSource(context));
  registry.register('checkpoints', new CheckpointsPanelSource(context));
}

/** Zone HIST: pull an optional pagination `cursor` out of `session.list`/`switchTab` params. */
function extractCursor(params: unknown): string | undefined {
  return extractStringField(params, 'cursor');
}

/** W4-T3b (§7 B6): pull an explicit `sessionId` scope key out of a fetch's
 * params, when the caller supplied one. Exported for `AcpBackend`'s
 * `buildPanelDataMessage`, which resolves the SAME scope key for the
 * matching `panel.data` push. */
export function extractSessionId(params: unknown): string | undefined {
  return extractStringField(params, 'sessionId');
}

/** W4-T3b (§7 B6): pull an explicit `rootId` scope key out of a fetch's
 * params — see {@link extractSessionId}'s doc. */
export function extractRootId(params: unknown): string | undefined {
  return extractStringField(params, 'rootId');
}

/** W4-T3b (§7 B6): pull an explicit `cwd` scope key out of a fetch's params
 * — see {@link extractSessionId}'s doc. */
export function extractCwd(params: unknown): string | undefined {
  return extractStringField(params, 'cwd');
}

function extractStringField(params: unknown, field: string): string | undefined {
  if (params && typeof params === 'object' && field in params) {
    const value = (params as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
