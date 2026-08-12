import type {
  McpData,
  McpServer,
  McpStatus,
  ModelInfo,
  ModelProvider,
  ModelsData,
  SessionsData,
  SessionSummary,
  SettingField,
  SettingsData,
  SettingsSection,
  SkillInfo,
  SkillsData,
  ToolInfo,
  ToolKind,
  ToolsData,
  ToolsetInfo,
} from '../../shared/protocol';

/**
 * The Zone S reshaping seam: PURE functions that turn a raw control-plane RPC
 * result (tui_gateway JSON-RPC `result`, or — for panels sourced from the ACP
 * channel, see `sessions` in `src/shared/protocol.ts` — an ACP response) into
 * the EXACT `PanelDataMap[panel]` shape the corresponding
 * `webview/src/panels/*.tsx` component renders. Each panel's {@link PanelSource}
 * (`panelSources.ts` / `dashboardPanelSources.ts`) calls the matching `reshape*`
 * function at fetch time, so a panel's `.tsx` NEVER has to know about
 * tui_gateway's wire shape.
 *
 * A#3: the old `reshapePanelData` DISPATCH TABLE (+ `AcpBackend.emitPanelData`
 * + `METHOD_TO_PANEL`) that also lived here was DELETED — it survived only on an
 * `invokeControl` fallthrough no live webview flow reached, and its `skills`/
 * `tools` entries diverged from the real dashboard-backed sources. The pure
 * `reshape*` functions below are the single home for reshaping and are what the
 * PanelSources use.
 */

/* ------------------------------------------------------------------ *
 * Raw tui_gateway shapes — grounded in the pinned tui_gateway wire contract
 * ------------------------------------------------------------------ */

/**
 * One resolved tool row, kept only for DEFENSIVE/forward-compat handling. The
 * REAL `tools.list` wire shape carries tool NAMES as bare strings (see
 * {@link RawToolset}); this object form is tolerated in case a future Hermes
 * build enriches the per-tool entry (it is NOT evidenced by current source).
 */
export interface RawToolDef {
  name: string;
  description?: string;
  enabled?: boolean;
}

/**
 * One toolset bundle inside a `tools.list` result
 * (`tui_gateway/server.py:13439-13467`).
 *
 * corr-M1 — GROUND TRUTH: a toolset's member tools arrive as
 * `resolved_tools: List[str]` — bare tool-NAME strings, not `{name,...}` objects
 * (`tools/toolsets.py:687,920`; the dashboard `GET /api/tools/toolsets` reshaper
 * already treats them as `string[]`). The reshaper reads {@link resolved_tools}
 * first; the legacy `tools` field (either `string[]` or the defensive
 * {@link RawToolDef} object form) is a fallback so an older/mock shape still
 * works. Reading a plain string as `t.name` was crashing the LIVE no-dashboard
 * tools source (`classifySource(undefined)` TypeError).
 */
export interface RawToolset {
  name: string;
  description?: string;
  tool_count: number;
  enabled: boolean;
  /** Real tui_gateway field: resolved tool NAMES. */
  resolved_tools?: string[];
  /** Legacy/defensive fallback: names, or the object form for forward-compat. */
  tools?: Array<string | RawToolDef>;
}

/** Raw `tools.list` RPC result (`tui_gateway/server.py:13439-13467`). */
export interface RawToolsListResult {
  toolsets?: RawToolset[];
}

/**
 * Heuristic `ToolKind` classifier. `tools.list`/`tools.show` carry no `kind`
 * field on the wire (contracts-tui-gateway.md §2 — only `name`/`description`
 * are pinned for an individual tool row) but `ToolsPanel.tsx` needs one for
 * its icon, so we classify by name prefix against Hermes' known core-tool
 * vocabulary (`read_file`, `patch`, `terminal`, `web_search`, `todo`, …, per
 * `src/shared/mockScenario.ts`'s hand-authored reference set). Unmatched
 * names (including any `<mcp_server>:<tool>` name) fall back to `'other'`.
 */
const KIND_PATTERNS: ReadonlyArray<readonly [RegExp, ToolKind]> = [
  [/^(read|cat|view|list_dir|glob)/i, 'read'],
  [/^(write|edit|patch|apply_diff|create_file|delete)/i, 'edit'],
  [/^(exec|shell|run|terminal|command)/i, 'execute'],
  [/^(search|grep|find)/i, 'search'],
  [/^(fetch|http|web|browser|curl)/i, 'fetch'],
  [/^(think|plan|todo|reason)/i, 'think'],
];

export function classifyKind(name: string): ToolKind {
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(name)) return kind;
  }
  return 'other';
}

/**
 * `tools.configure`'s own params doc pins the convention that an MCP-backed
 * tool's addressable name is `"<mcp_server_name>:<tool_name>"`
 * (contracts-tui-gateway.md §2) — reuse that literal marker to classify
 * `source`. `tools.list` does not otherwise flag plugin-provided tools
 * distinctly from core ones, so anything without a colon defaults to `'core'`.
 */
export function classifySource(name: string): ToolInfo['source'] {
  return name.includes(':') ? 'mcp' : 'core';
}

/**
 * Reshape a raw `tools.list` result into `ToolsData` (`ToolsPanel.tsx`).
 *
 * corr-M1: a toolset's member tools are `resolved_tools: string[]` on the real
 * wire (bare names). Each entry is normalized to `{name, description?, enabled?}`
 * whether it arrives as a string (real shape → empty description, inherits the
 * toolset's `enabled`) or as a defensive/legacy object. Handling the string case
 * is what fixes the `classifySource(undefined)` TypeError the LIVE no-dashboard
 * tools source was hitting.
 */
export function reshapeToolsList(raw: RawToolsListResult): ToolsData {
  const toolsets: ToolsetInfo[] = [];
  const tools: ToolInfo[] = [];

  for (const ts of raw.toolsets ?? []) {
    toolsets.push({ name: ts.name, enabled: ts.enabled, toolCount: ts.tool_count });

    for (const entry of ts.resolved_tools ?? ts.tools ?? []) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const description = typeof entry === 'string' ? '' : entry.description ?? '';
      const enabled = typeof entry === 'string' ? ts.enabled : entry.enabled ?? ts.enabled;
      tools.push({
        name,
        description,
        enabled,
        kind: classifyKind(name),
        toolset: ts.name,
        source: classifySource(name),
      });
    }
  }

  return { toolsets, tools };
}

/* ------------------------------------------------------------------ *
 * Raw `skills.manage {action:"list"}` shape — grounded in
 * `hermes-agent-2026.7.7.2/tui_gateway/server.py:13717-13724` (calls
 * `hermes_cli.banner.get_available_skills()`) and `hermes_cli/banner.py:93-110`.
 * ------------------------------------------------------------------ */

/**
 * One raw skill entry. The GROUNDED real shape (per `get_available_skills()`,
 * `hermes_cli/banner.py:93-110`) is a bare `string` (just the skill name) —
 * `get_available_skills()` calls `tools/skills_tool.py`'s `_find_all_skills()`
 * (which DOES produce richer `{name,description,category}` dicts) but then
 * discards everything except `name`, regrouping into `Dict[category,
 * List[name]]`. There is therefore NO raw `description`/`enabled`/
 * `installed`/`source` field available from this RPC at all.
 *
 * The object form below is kept as a defensive/forward-compat allowance
 * (see `reshapeSkillsList`'s doc) in case a future Hermes build enriches this
 * response — it is NOT evidenced by current source.
 */
export type RawSkillEntry =
  | string
  | {
      name: string;
      description?: string;
      enabled?: boolean;
    };

/** Raw `skills.manage {action:"list"}` result: `{"skills": {<category>: [<name>, ...]}}`. */
export interface RawSkillsManageListResult {
  skills?: Record<string, RawSkillEntry[]>;
}

/**
 * Reshape raw `skills.manage {action:"list"}` into `SkillsData` — the DEGRADED
 * tui_gateway FALLBACK for the Skills panel (W1.5: the real source is the
 * dashboard `GET /api/skills`, see `dashboardPanelSources.ts`). This RPC is
 * name-only: `description` defaults to `''`, and `enabled` defaults to `true` —
 * legitimately, not a guess: `get_available_skills()` already filters to only
 * on-disk, non-disabled skills (`hermes_cli/banner.py:100-104`,
 * `tools/skills_tool.py:637`), so every skill it returns is enabled.
 * `provenance`/`usage` are OMITTED here (this RPC carries neither) — they are
 * populated only by the dashboard source. `installed`/`source` were removed from
 * `SkillInfo` entirely (A4): the endpoint only ever lists installed skills.
 */
export function reshapeSkillsList(raw: RawSkillsManageListResult): SkillsData {
  const grouped = raw.skills ?? {};
  const categories = Object.keys(grouped);
  const skills: SkillInfo[] = [];

  for (const category of categories) {
    for (const entry of grouped[category] ?? []) {
      if (typeof entry === 'string') {
        skills.push({ id: entry, name: entry, category, description: '', enabled: true });
      } else {
        skills.push({
          id: entry.name,
          name: entry.name,
          category,
          description: entry.description ?? '',
          enabled: entry.enabled ?? true,
        });
      }
    }
  }

  return { skills, categories };
}

/* ------------------------------------------------------------------ *
 * Raw MCP sources — grounded in contracts-tui-gateway.md §3 (GAPS #1: no
 * single RPC returns server list + status + tool counts). Joined from
 * `config.get({key:"full"}).mcp_servers` (server list + launch command,
 * `tools/mcp_tool.py:13-60` schema) and `tools.list`'s per-toolset
 * `tool_count` (`tui_gateway/server.py:13439-13467`).
 * ------------------------------------------------------------------ */

/**
 * One `mcp_servers.<name>` entry from `config.get({key:"full"})`. The
 * docstring example (`tools/mcp_tool.py:13-60`) shows `command`/`args`/`env`
 * for stdio transport or `url`/`headers` for HTTP/SSE transport, plus
 * optional `timeout`/`connect_timeout`. `enabled` is NOT in that example but
 * IS read at registration time (`v.get("enabled", True)`,
 * `tools/mcp_tool.py:4903`) — an explicit `enabled: false` skips connecting
 * the server without removing its config entry, so it is a real optional key.
 */
export interface RawMcpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** Raw `config.get({key:"full"})` result — only the `mcp_servers` slice is used here. */
export interface RawConfigFullResult {
  mcp_servers?: Record<string, RawMcpServerConfig>;
}

/**
 * Find the `tools.list` toolset that corresponds to one MCP server.
 * `register_mcp_servers()` always registers the canonical toolset as
 * `mcp-<server_name>` (`tools/mcp_tool.py:4750`), then registers an ALIAS
 * `<server_name> -> mcp-<server_name>` (`tools/mcp_tool.py:4840`);
 * `toolsets.get_all_toolsets()` prefers the alias as the display key unless
 * it collides with a static toolset name (`toolsets.py:814-836`). So in
 * practice a server's toolset is normally keyed by its bare name, falling
 * back to the canonical `mcp-<name>` form only on a collision — check both.
 */
function findServerToolset(name: string, toolsets: RawToolset[]): RawToolset | undefined {
  return toolsets.find((ts) => ts.name === name) ?? toolsets.find((ts) => ts.name === `mcp-${name}`);
}

/** Join a stdio server's `command`/`args` into the single `McpServer.command` string. */
function formatCommand(cfg: RawMcpServerConfig): string {
  if (cfg.url) return cfg.url;
  return [cfg.command, ...(cfg.args ?? [])].filter((part): part is string => Boolean(part)).join(' ');
}

/**
 * Join `config.get({key:"full"}).mcp_servers` with `tools.list`'s toolset
 * `tool_count` into `McpData` (`McpPanel.tsx`).
 *
 * `reload.mcp` (the third source the original design suggested
 * joining) was traced to `tui_gateway/server.py:11137-11223` and returns only
 * `{"status": "confirm_required"|"reloaded", "message"?}` — no per-server
 * data — so it contributes nothing to this pure reshaper; it is wired as the
 * panel's explicit reload/retry ACTION in `AcpBackend` instead (see
 * `AcpBackend.refreshMcpPanel`/the `reload.mcp` branch of `invokeControl`).
 *
 * A4 (W1.5): per-server LIVE connection state (`tools/mcp_tool.py`'s
 * `_servers`/`_server_connect_errors`) lives ONLY in the gateway process and is
 * exposed by no RPC — so `status` here can only ever resolve to `'connected'` (a
 * matching, `tools.list`-registered toolset exists) or `'disconnected'` (no
 * toolset found, or the config sets `enabled: false`). The former
 * `'error'`/`'running'` states and `McpServer.error` had no grounded source and
 * were REMOVED from {@link McpStatus}/{@link McpServer} rather than left as dead
 * branches the `McpPanel` styled + gated a (never-firing) Retry button on.
 */
export function reshapeMcpServers(config: RawConfigFullResult, tools: RawToolsListResult): McpData {
  const toolsets = tools.toolsets ?? [];
  const mcpServers = config.mcp_servers ?? {};
  const servers: McpServer[] = [];

  for (const [name, cfg] of Object.entries(mcpServers)) {
    const toolset = cfg.enabled === false ? undefined : findServerToolset(name, toolsets);
    const status: McpStatus = toolset ? 'connected' : 'disconnected';
    servers.push({
      id: name,
      name,
      status,
      command: formatCommand(cfg),
      toolCount: toolset?.tool_count ?? 0,
    });
  }

  return { servers };
}

/* ------------------------------------------------------------------ *
 * Raw ACP `session/list` shape — Zone HIST. UNLIKE every other raw shape in
 * this file, this one comes from the ACP channel (`AcpClient.listSessions`),
 * not a tui_gateway RPC (see `SessionsData`'s doc, `src/shared/protocol.ts`).
 * ------------------------------------------------------------------ */

/**
 * One raw `session/list` entry. Field-casing is tolerated BOTH ways
 * (`session_id`/`sessionId`, `updated_at`/`updatedAt`) — see
 * {@link AcpListSessionsRawResult}'s doc (`acp/acpClient.ts`) for the
 * evidence that the wire-JSON casing is camelCase. `session/list` is a named
 * SDK method (`AcpClient.listSessions`, `@agentclientprotocol/sdk@0.17.1`),
 * not routed through `extMethod` — this tolerance is belt-and-braces on a
 * wire boundary, not a hedge against an unknown casing; this reshaper
 * accepts either spelling regardless.
 */
export interface RawSessionInfo {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  title?: string | null;
  updated_at?: string | number | null;
  updatedAt?: string | number | null;
}

/** Raw `session/list` result: `{sessions:[...], next_cursor?}` (server page size 50). */
export interface RawSessionListResult {
  sessions?: RawSessionInfo[];
  next_cursor?: string | null;
  nextCursor?: string | null;
}

/** CA-17 (audit-3): a bare epoch-numeric string/number — optionally
 *  fractional (Python `str(time.time())` produces exactly this shape:
 *  seconds, with a fractional part). `Date.parse`/`new Date(string)` do NOT
 *  recognize this format (it isn't ISO-8601), so left as-is it round-trips
 *  through {@link reshapeSessionsList} unchanged and then fails to parse
 *  downstream (`SessionsPanel.tsx`'s `relativeAge`). */
const EPOCH_NUMERIC_PATTERN = /^\d+(\.\d+)?$/;

/** Epoch values at or above this magnitude are treated as milliseconds
 *  rather than seconds — ~2001-09-09 in ms, ~year 33658 in seconds, so any
 *  plausible current-era timestamp sorts unambiguously on one side of it.
 *  The same threshold libraries like Moment/Day.js use for auto unit
 *  detection. */
const EPOCH_MS_THRESHOLD = 1e12;

/**
 * CA-17 (audit-3): normalize a raw `updated_at`/`updatedAt` value into a
 * string `Date.parse` can actually consume. An ISO-8601 string (the
 * documented/expected shape) passes through unchanged — that path already
 * worked. A bare epoch-numeric string or number (seconds or milliseconds,
 * auto-detected by magnitude via {@link EPOCH_MS_THRESHOLD}) is converted to
 * an ISO-8601 string, matching the shape the already-working ISO path
 * produces, so `SessionsPanel.tsx`'s downstream `Date.parse` succeeds
 * either way.
 */
function normalizeUpdatedAt(raw: string | number | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const str = String(raw);
  if (!EPOCH_NUMERIC_PATTERN.test(str)) return str;
  const epoch = parseFloat(str);
  const ms = epoch < EPOCH_MS_THRESHOLD ? epoch * 1000 : epoch;
  // CA-17 (B-6 review): never THROW on an out-of-range/overflow epoch.
  // `new Date(ms).toISOString()` throws `RangeError: Invalid time value`
  // when `ms` is non-finite or outside the ±8.64e15 Date range — e.g. a
  // NANOSECOND-epoch string (`str(time.time_ns())` -> "1700000000000000000",
  // matches EPOCH_NUMERIC_PATTERN, parseFloat -> 1.7e18 -> treated as ms ->
  // Invalid Date), or a huge string parseFloat rounds to Infinity. The
  // reshape's contract is to DEGRADE a bad entry, not throw: the throw has
  // no catch between here and `invokeControl`, so one malformed timestamp on
  // one session would fail the WHOLE sessions-list fetch (no rows render) —
  // strictly worse than the cosmetically-wrong age this fix set out to
  // reduce, and worse than the non-throwing `String(raw)` it replaced. Fall
  // back to the raw string on an invalid date.
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? str : d.toISOString();
}

/**
 * Reshape a raw ACP `session/list` result into `SessionsData`
 * (`SessionsPanel.tsx`): rename `session_id`->`id`, `next_cursor`->`nextCursor`,
 * `updated_at`->`updatedAt` (accepting the camelCase spelling of any of these
 * too — see `RawSessionInfo`'s doc). A `null` `title`/`updated_at`/`next_cursor`
 * (Python `None` serialized to JSON, per `acp_adapter/server.py:1279-1291`'s
 * `s.get("title")`/`next_cursor = ... if has_more ... else None`) collapses to
 * `undefined`, matching the frozen `SessionSummary`/`SessionsData`'s optional
 * (not nullable) fields. `updated_at` may also arrive as a stringified epoch
 * float (or a raw epoch number) rather than ISO-8601 — see
 * {@link normalizeUpdatedAt} (CA-17).
 */
export function reshapeSessionsList(raw: RawSessionListResult): SessionsData {
  const sessions: SessionSummary[] = (raw.sessions ?? []).map((s) => {
    const id = s.session_id ?? s.sessionId ?? '';
    const updatedAtRaw = s.updated_at ?? s.updatedAt;
    return {
      id,
      cwd: s.cwd ?? '',
      title: s.title ?? undefined,
      updatedAt: normalizeUpdatedAt(updatedAtRaw),
    };
  });
  const nextCursor = raw.next_cursor ?? raw.nextCursor ?? undefined;
  return { sessions, nextCursor: nextCursor ?? undefined };
}

/* ------------------------------------------------------------------ *
 * Raw `model.options` shape — grounded in
 * `hermes-agent-2026.7.7.2/tui_gateway/server.py:12383-12421` (the handler
 * calls `hermes_cli.inventory.build_models_payload(..., picker_hints=True)`)
 * and `hermes_cli/inventory.py:111-251` (that builder's return shape).
 * ------------------------------------------------------------------ */

/**
 * One provider row from `build_models_payload`'s `providers` list
 * (`hermes_cli/inventory.py:247-251`, rows from `list_authenticated_providers`
 * + `_append_unconfigured_rows`/`_moa_provider_row`). GROUNDED fields:
 *  - `slug` — the provider id (`_append_unconfigured_rows:307`, `_moa_provider_row:513`).
 *  - `name` — human label (`inventory.py:308`, `:514`).
 *  - `models` — a bare LIST OF MODEL-ID STRINGS, never objects
 *    (`_apply_pricing:443` iterates `for mid in models`; `_moa_provider_row:509`
 *    builds it from `cfg.get("presets", {}).keys()`; the dedup at `:209` does
 *    `m.lower() for m in (row.get("models") or [])`). There is therefore NO
 *    per-model context-window / label field on this RPC.
 *  - `authenticated` — set by `_apply_picker_hints` (`:350-369`), which
 *    `model.options` always runs (`picker_hints=True`, `server.py:12413`);
 *    maps to {@link ModelProvider.connected}.
 * `is_current`/`total_models`/`source`/`capabilities`/`pricing` exist too but
 * are not needed for the frozen `ModelsData` shape.
 */
export interface RawModelProviderRow {
  slug?: string;
  name?: string;
  authenticated?: boolean;
  is_current?: boolean;
  models?: string[];
  total_models?: number;
  /** beta.7 B4: `'virtual'` for synthetic rows (MoA) — grounded `inventory.py:509`. */
  source?: string;
  [key: string]: unknown;
}

/** Raw `model.options` result: `{providers, model, provider}` (`inventory.py:247-251`). */
export interface RawModelOptionsResult {
  providers?: RawModelProviderRow[];
  /** Current model id (`ctx.current_model`, `inventory.py:249`). */
  model?: string;
  /** Current provider slug (`ctx.current_provider`, `inventory.py:250`). */
  provider?: string;
}

/**
 * Reshape a raw `model.options` result into `ModelsData` (`ModelsPanel.tsx`).
 *
 * Frozen-type gap (flagged, not fabricated): `model.options`'s `models` are
 * bare id strings, so a `ModelInfo` gets `label === id` and NO `contextWindow`
 * (the RPC carries no per-model context window — `ModelsPanel.tsx` already
 * renders the `contextWindow`-absent case). `ModelProvider.connected` comes
 * from the row's `authenticated` picker hint; `currentModelId` is the payload's
 * top-level `model`, which matches a `ModelInfo.id` when the current provider's
 * model list contains it.
 */
export function reshapeModelOptions(raw: RawModelOptionsResult): ModelsData {
  const providers: ModelProvider[] = (raw.providers ?? []).map((row) => {
    const models: ModelInfo[] = (row.models ?? []).map((id) => ({ id, label: id }));
    return {
      id: row.slug ?? '',
      name: row.name ?? row.slug ?? '',
      connected: Boolean(row.authenticated),
      models,
      ...(row.source === 'virtual' ? { virtual: true } : {}),
    };
  });
  return { providers, currentModelId: raw.model ?? '' };
}

/* ------------------------------------------------------------------ *
 * Raw `config.show` shape — grounded in
 * `hermes-agent-2026.7.7.2/tui_gateway/server.py:13400-13434`. UNLIKE the
 * editable `config.get`/`config.set` surface, `config.show` returns a
 * READ-ONLY, human-readable dump: `{sections:[{title, rows:[[label, value]]}]}`
 * where every `value` is already stringified server-side (`str(...)`,
 * `server.py:13413-13431`).
 * ------------------------------------------------------------------ */

/** One raw `config.show` section: a `title` + `rows` of `[label, value]` pairs. */
export interface RawConfigShowSection {
  title?: string;
  rows?: unknown[][];
}

/** Raw `config.show` result (`server.py:13434`). */
export interface RawConfigShowResult {
  sections?: RawConfigShowSection[];
}

/**
 * Reshape a raw `config.show` result into `SettingsData` (`SettingsPanel.tsx`).
 *
 * GROUND TRUTH (flagged in the zone report): `config.show` is Hermes' read-only
 * config *display* — it emits `{title, rows:[[label, value]]}` with every value
 * pre-stringified (`server.py:13413-13431`), carrying NO per-field type / enum /
 * description metadata. So each row honestly maps to a `type:'string'`
 * {@link SettingField} (rendered as a read-out by `SettingsPanel.tsx`), keyed by
 * its label; fabricating `boolean`/`enum` types (with editable toggles) from a
 * display dump would be a guess the RPC can't back. A future editable Settings
 * surface would source `config.get`/`config.set` (which DO carry structure),
 * not this reshaper.
 */
export function reshapeConfigShow(raw: RawConfigShowResult): SettingsData {
  const sections: SettingsSection[] = (raw.sections ?? []).map((section) => {
    const fields: SettingField[] = (section.rows ?? []).map((row) => {
      const label = Array.isArray(row) ? row[0] : undefined;
      const value = Array.isArray(row) ? row[1] : undefined;
      return {
        key: label == null ? '' : String(label),
        value: normalizeSettingValue(value),
        type: 'string' as const,
      };
    });
    return { name: section.title ?? '', fields };
  });
  return { sections };
}

/** Coerce a raw `config.show` cell to the `SettingField.value` union (config.show pre-stringifies, so this is normally identity on a string). */
function normalizeSettingValue(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return value == null ? '' : String(value);
}

