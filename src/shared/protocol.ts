/**
 * Talaria Code — Host <-> Webview protocol (single source of truth).
 *
 * This file is the CONTRACT every other agent depends on. The host (extension)
 * translates backend events (ACP `session/update` notifications and tui_gateway
 * `event` notifications / RPC results) into {@link HostToWebview} messages; the
 * webview renders them and posts {@link WebviewToHost} messages back.
 *
 * Provenance legend used in JSDoc below:
 *  - `ACP <name>`  = Agent Client Protocol `session/update` variant or method
 *    (see `acp_adapter/events.py`, `server.py`).
 *  - `TUI <name>`  = tui_gateway JSON-RPC method or `_emit` event
 *    (see `tui_gateway/server.py`, catalogued in
 *    `research/harness/hermes-tui-gateway-methods.md`).
 *
 * Rules: strict TypeScript, no `any`. Both unions are discriminated on `type`.
 * Agents A (host) and B (webview) import these types by name; they never
 * redefine them.
 */

/* ------------------------------------------------------------------ *
 * Shared enums & primitive shapes
 * ------------------------------------------------------------------ */

/**
 * W4 §2e: the resource guard on how many chat-session tabs the webview keeps
 * (N retained live transcripts inside one `retainContextWhenHidden` webview).
 * A single named constant so the tab strip's "+" admission check and any
 * future host-side guard read the SAME pinned number.
 */
export const MAX_TABS = 8;

/**
 * W4 §2e/§7 B9(d): the id of the ONE implicit tab the webview boots with,
 * before any real `tab.open` round trip exists — shared with the host so
 * `AcpBackend`'s connection-boot session mint (`establishInitialSession`)
 * and `loadSessionIntoTab`'s in-place controller reuse (no per-tab mint yet,
 * a T1a approximation carried forward — see `SessionController`'s class
 * doc) can name the SAME tab their `tab.bound` emission targets, matching
 * the webview's `INITIAL_STATE` bootstrap tab.
 */
export const BOOTSTRAP_TAB_ID = 'tab-bootstrap';

/**
 * Semantic category of a tool call — drives the tool-card icon/treatment.
 * Mirrors ACP `ToolCallKind` (`acp_adapter/tools.py` `_kind_for`).
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'execute'
  | 'search'
  | 'fetch'
  | 'think'
  | 'other';

/**
 * Lifecycle of a tool call. `pending` = created, args still streaming;
 * `running` = executing; `done`/`failed` = terminal.
 * Mirrors ACP `ToolCallStatus` + TUI `tool.start`/`tool.generating`/`tool.complete`.
 *
 * `interrupted` (audit-2 Cluster A / T-A1): the webview-side terminal state a
 * still-`pending`/`running` tool card folds to when its turn ends anything
 * other than `'complete'` — the card-level mirror of `SubagentStatus`'s own
 * `interrupted` (see that type's doc). NOT emitted by the host on `tool.*`
 * messages; folded client-side only (T-A1's job). Listed here so the shared
 * `ToolStatus` union — and the exhaustive `STATUS` Record consuming it in
 * `ToolCard.tsx` — stay the single source of truth `tsc` enforces.
 */
export type ToolStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';

/**
 * A single hunk of a unified diff. `header` is the `@@ -a,b +c,d @@` line;
 * `sign` is the leading gutter character of each line.
 * Origin: ACP `tool_diff_content` (`edit_approval.py`).
 */
export interface DiffHunk {
  header: string;
  lines: { sign: '+' | '-' | ' '; text: string }[];
}

/**
 * One selectable answer on an approval card.
 * Origin: ACP `session/request_permission` option set (`permissions.py`).
 */
export interface ApprovalOption {
  id: string;
  label: string;
  kind: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always';
}

/**
 * One row of the plan / todo checklist.
 * Origin: ACP `plan` (`AgentPlanUpdate` / `PlanEntry`, `events.py:39-84`).
 */
export interface PlanItem {
  text: string;
  status: 'done' | 'active' | 'pending';
}

/**
 * Side panels (tabs) the webview can show. `chat` is the default.
 * `setup` (Task 8 — protocol v2, §6 of the onboarding/backend-setup
 * architecture doc): the Talaria Config / Backend Setup screen — GLOBAL
 * scope (see {@link PANEL_SCOPE}), like `settings`.
 */
export type Panel =
  | 'chat'
  | 'tools'
  | 'mcp'
  | 'skills'
  | 'checkpoints'
  | 'subagents'
  | 'sessions'
  | 'models'
  | 'settings'
  | 'setup';

/**
 * Turn approval policy / mode. Maps to Hermes approval policy
 * (`server.py:534-565`, ACP `session/set_mode`):
 *  - `default`      — ask before edits/commands
 *  - `accept_edits` — auto-approve workspace + tmp edits
 *  - `dont_ask`     — auto-approve for the session (except sensitive paths)
 */
export type AgentMode = 'default' | 'accept_edits' | 'dont_ask';

/**
 * W2-F1: client-side edit-approval preset. NOT the wire {@link AgentMode} —
 * all four presets pin the ACP session mode at 'default' so every main-loop
 * FILE EDIT (`write_file`/`patch`) surfaces to our `request_permission` seam
 * (any other wire mode lets Hermes auto-approve those edits internally and
 * bypass the client engine).
 *
 * HONEST SCOPE (F3): the seam does NOT pre-approve everything. Ordinary shell
 * commands are auto-approved by Hermes (only its own dangerous-command regex
 * raises a prompt), and subagent (`delegate_task`) edits, `execute_code` /
 * `terminal`, and MCP-tool writes never reach the seam at all. Those mutation
 * paths are captured after the fact by the post-turn checkpoint snapshot
 * (Phase 0 undo) — recovery, not pre-approval.
 *
 * Presets differ only in the client policy engine's decision function
 * (`src/host/backend/policy/`): manual = ask before gated file edits ·
 * normal = auto-allow safe in-workspace edits on a checkpoint-protected turn ·
 * strict = ask + hard deny floors on gated edits · plan = deny gated edits +
 * plan preamble (advisory to the model — commands and subagent edits can
 * still mutate files under Plan; it is NOT a filesystem-read-only mode).
 */
export type EditPolicyPreset = 'manual' | 'normal' | 'strict' | 'plan';

/**
 * D2 (A2 — architect decision memo §"Decision 2"): which agent backend is
 * actually driving the panel. `'mock'` = the process-free canned-scenario
 * player (`MockBackend`) — either the configured default, OR the silent
 * untrusted-workspace fallback `selectBackendKind` (`src/host/trustGate.ts`)
 * applies even when `talaria.backend` is set to `'acp'`. `'acp'` = the real
 * agent (`AcpBackend`), spawned only in a trusted workspace.
 *
 * Canonical home is HERE (not `trustGate.ts`) so this dependency-free shared
 * module never has to import from `src/host/*`; `trustGate.ts` re-exports
 * this same type rather than minting its own, so there is exactly one
 * definition (grounded by the D2 brief: "REUSE this type; do not mint a new
 * one").
 */
export type BackendKind = 'mock' | 'acp';

/** VS Code color-theme kind, forwarded so the webview can adapt tokens. */
export type ThemeKind = 'light' | 'dark' | 'high-contrast';

/** Theme snapshot. Origin: host-side `ColorThemeKind`. */
export interface ThemeInfo {
  kind: ThemeKind;
  /** Fixed brand accent (teal) layered over `--vscode-*` surfaces. */
  accent: string;
}

/** Token / cost rollup for a finished turn. Origin: ACP usage `_meta` / TUI `session.usage`. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in USD, when the provider reports pricing. */
  costUsd?: number;
  /** Wall-clock duration of the turn, in milliseconds. */
  durationMs?: number;
}

/* ------------------------------------------------------------------ *
 * W2 shared context/command shapes (added verbatim). One closed set,
 * reused by the mentions composer (F-M), code actions (F-A, via
 * `composer.seed`), and slash commands (F-S, via `commands.available`).
 * ------------------------------------------------------------------ */

/** A 1-based inclusive line range (e.g. an editor selection). Origin: §2a. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * Kind of a structured @-mention/context reference the webview can attach
 * to a prompt. `file`/`folder` are delivered as bare `resource_link`s (the
 * agent reads them itself); `problems`/`selection`/`terminal`/`git` are
 * ambient kinds the agent cannot fetch itself, so they are embedded
 * `resource` blocks instead. Origin: §2a/§3.1.
 */
export type ContextRefKind = 'file' | 'folder' | 'problems' | 'selection' | 'terminal' | 'git';

/**
 * A structured @-mention/context reference attached to a `prompt` message.
 * Webview-supplied and therefore untrusted-ish — the host resolves and
 * workspace-confines every ref BEFORE any read or mapping (§2a's
 * "Workspace confinement FIRST" rule; see `src/host/context/types.ts` for
 * the resolution port shapes). Origin: §2a/§2e.
 */
export interface ContextRef {
  id: string;
  kind: ContextRefKind;
  path?: string;
  range?: LineRange;
}

/**
 * One entry in the ACP `available_commands` catalog (agent-control slash
 * commands only — user-facing `/`-commands are client templates, §3.2),
 * re-shaped for the webview's slash-command menu. Cached host-side,
 * re-pushed on `session/load`, and carried in `hydrate` so a re-created view
 * has the catalog without the adapter replaying it. Origin: §2e/§3.2.
 */
export interface SlashCommandInfo {
  name: string;
  description: string;
  inputHint?: string;
}

/* ------------------------------------------------------------------ *
 * Panel data payloads (control-plane snapshots)
 * ------------------------------------------------------------------ */

/** One tool in the Tools panel. Origin: TUI `tools.list` / `tools.show`. */
export interface ToolInfo {
  name: string;
  description: string;
  enabled: boolean;
  kind: ToolKind;
  /** Owning toolset bundle key (e.g. `hermes-acp`, `web`, `terminal`). */
  toolset: string;
  /** Where the tool comes from. */
  source: 'core' | 'mcp' | 'plugin';
}

/** A toolset bundle row. Origin: TUI `toolsets.list`. */
export interface ToolsetInfo {
  name: string;
  enabled: boolean;
  toolCount: number;
}

/** Tools panel payload. Origin: TUI `tools.list` + `toolsets.list`. */
export interface ToolsData {
  toolsets: ToolsetInfo[];
  tools: ToolInfo[];
}

/**
 * Connection state of an MCP server, trimmed (W1.5 / A4) to the REACHABLE set.
 * Per-server live connection state (`tools/mcp_tool.py`'s `_servers`/
 * `_server_connect_errors`) lives only inside the gateway process and is exposed
 * by no RPC, so the join in `reshapeMcpServers` (`config.get{key:"full"}` +
 * `tools.list` toolset presence) can only ever distinguish two states:
 *  - `connected`    — a matching `tools.list`-registered toolset exists;
 *  - `disconnected` — no toolset found, or the config sets `enabled: false`.
 * The former `running`/`error` variants had NO grounded source (nothing ever
 * produced them), so they were removed rather than left as dead branches the
 * `McpPanel` styled and gated a Retry button on (see `reshapePanelData.ts`).
 */
export type McpStatus = 'connected' | 'disconnected';

/** One MCP server row. Origin: `mcp_servers` config joined with `tools.list`. */
export interface McpServer {
  id: string;
  name: string;
  status: McpStatus;
  /** Launch command (stdio servers) or URL (remote servers). */
  command: string;
  /** Tools exposed by this server once connected. */
  toolCount: number;
  /** `cfg.enabled !== false`. */
  enabled: boolean;
  /** `cfg.url ? 'http' : cfg.command ? 'stdio' : 'unknown'` (mirrors web_server.py:10382). */
  transport: 'stdio' | 'http' | 'unknown';
}

/** MCP panel payload. Origin: TUI `reload.mcp` snapshot. */
export interface McpData {
  servers: McpServer[];
}

/** `mcp.add` params — discriminated on `transport` (§4.2). */
export type McpAddParams =
  | { name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: 'http'; url: string };

/** `transport` is threaded from the VALIDATED McpAddParams discriminant (the request's own
 *  `params.transport` after `validateMcpAdd` accepted it) — `validateMcpAdd`'s wire `body`
 *  deliberately drops it (the REST body has no transport field), so the §4.5 handler returns
 *  `{ ok: true, name: body.name, transport: params.transport }`. */
export interface McpAddResult { ok: true; name: string; transport: 'stdio' | 'http' }

/** Envelope of mcp.test AND mcp.auth — verbatim server shape (web_server.py:10537-10542, :10630-10652). */
export interface McpTestResult { ok: boolean; error?: string; tools: { name: string; description: string }[] }

/** One GET /api/mcp/catalog entry, verbatim server shape (web_server.py:10710-10740, incl. default_enabled :10732-10735). */
export interface McpCatalogEntry {
  name: string;
  description: string;
  source: string;
  transport: string;
  auth_type: string;
  required_env: { name: string; prompt: string; required: boolean }[];
  command: string | null;
  args: string[];
  url: string | null;
  install_url: string | null;
  install_ref: string | null;
  bootstrap: string[];
  default_enabled: string[] | null;
  post_install: string;
  needs_install: boolean;
  installed: boolean;
  enabled: boolean;
}
export interface McpCatalogData { entries: McpCatalogEntry[] }

export interface McpCatalogInstallParams { name: string; env: Record<string, string> }
export interface McpCatalogInstallResult { ok: true; name: string }

/**
 * One skill row. Origin (W1.5): the dashboard REST surface `GET /api/skills`
 * (`hermes_cli/web_server.py:12921-12950`), which returns REAL per-skill
 * `enabled`/`description`/`category`/`provenance`/`usage` — richer than the old
 * tui_gateway `skills.manage list` (name-only, grouped by category). The
 * degraded tui_gateway fallback (`reshapeSkillsList`) still populates
 * `id`/`name`/`category`/`description`/`enabled` but omits `provenance`/`usage`
 * (that RPC carries neither).
 *
 * A4 reconciliation: `installed` and the fabricated `source`
 * (`builtin`/`official`/`custom`, which the old reshaper hard-coded to
 * `'custom'`) were REMOVED. `GET /api/skills` only ever lists on-disk skills, so
 * `installed` was always `true` — the `!installed` Install affordance in
 * `SkillsPanel` could never fire. Real provenance is `hub`/`bundled`/`agent`.
 */
export interface SkillInfo {
  id: string;
  name: string;
  /** Skill category, e.g. `coding`, `research`, `official/web`. */
  category: string;
  description: string;
  enabled: boolean;
  /**
   * Where the skill came from. Origin: dashboard `GET /api/skills` `provenance`
   * (`hub` > `bundled` > `agent`, where `agent` covers agent-authored AND local
   * hand-made skills — `web_server.py:12945-12949`). Absent from the tui_gateway
   * fallback (that RPC carries no provenance).
   */
  provenance?: 'hub' | 'bundled' | 'agent';
  /**
   * Activity count — how many times the skill was used. Origin: dashboard
   * `GET /api/skills` `usage` (`activity_count`, `web_server.py:12944`). Absent
   * from the tui_gateway fallback.
   */
  usage?: number;
}

/** Skills panel payload. Origin (W1.5): dashboard `GET /api/skills`. */
export interface SkillsData {
  skills: SkillInfo[];
  categories: string[];
}

/** `skills.create` params — user-authored skill (§5.2 of the MCP/skills architecture brief). */
export interface SkillCreateParams {
  name: string;
  content: string;
  category?: string;
}

/** One Skill Hub search-result preview, verbatim server shape (§5.2). */
export interface HubPreview {
  name: string;
  description: string;
  source: string;
  identifier: string;
  trust_level: string;
  skill_md: string;
  files: string[];
}

/** Verbatim scan response shape (web_server.py:12162-12173). */
export interface HubScan {
  name: string;
  identifier: string;
  source: string;
  trust_level: string;
  verdict: 'safe' | 'caution' | 'dangerous';
  summary: string;
  policy: 'allow' | 'ask' | 'block';
  policy_reason: string;
  findings: { severity: string; category: string; file: string; line: number; description: string }[];
  severity_counts: { critical: number; high: number; medium: number; low: number };
}

/** `skills.hubInstall` result — resolved ONLY after presence re-check. */
export interface HubInstallResult {
  ok: true;
  name: string;
}

/**
 * One checkpoint row. Origin: the extension-side `CheckpointTracker`
 * (shadow-git; `src/host/checkpoints/CheckpointTracker.ts`) — NOT TUI
 * `rollback.list`. Per the Zone CKPT architecture decision, checkpoints are
 * an extension-side shadow-git mechanism entirely independent of Hermes' own rollback system, snapshotting
 * the workspace at each ACP prompt-turn boundary (before the turn, and —
 * W2-F2 — after it settles). `id` is the shadow repo's `write-tree` hash.
 */
export interface Checkpoint {
  id: string;
  label: string;
  /** Human-friendly relative age, e.g. `2m ago`. */
  age: string;
  /** ISO-8601 creation time. */
  timestamp: string;
  /** Number of files touched since this checkpoint, if known. */
  filesChanged?: number;
  /** User-turn ordinal this checkpoint was taken at, if known. */
  turnOrdinal?: number;
  /** Which side of the turn this checkpoint captured; absent on legacy (pre-W2) records. */
  phase?: CheckpointPhase;
  /**
   * W4-T5b: a short, stable, human-readable tag identifying which session
   * created this row (checkpoints are per-ROOT, shared across every
   * same-root tab) — captured by the controller AT SNAPSHOT TIME and stored verbatim.
   * **DISPLAY-ONLY (R8): never a correlation/identity key.** The
   * before/after correlation stays `(turnOrdinal, phase)` — deliberately NOT
   * the ACP session id, which rotates on auto-compaction (see {@link
   * CheckpointPhase}'s own R8 doc); a row's `sessionLabel` is never
   * re-derived from the live session later, so an already-written row keeps
   * its original label even after the session that made it moves on.
   * Absent on legacy (pre-W4-T5b) records and on rows no controller
   * supplied a label for (e.g. the connection-level baseline/one-shot
   * snapshots) — omitted rather than a placeholder string.
   */
  sessionLabel?: string;
}

/**
 * Which side of a turn a checkpoint captured (W2-F2 Phase 0): 'before' = the
 * worktree before the turn ran (the undo target), 'after' = the worktree after
 * the turn settled (what makes undoing that turn force-free — the post-edit
 * state is captured, so restoring the 'before' point discards nothing
 * uncaptured). Absent on legacy records (every pre-W2 checkpoint was
 * before-turn). The (turnOrdinal, phase) pair is the before/after correlation
 * key — deliberately NOT the ACP session id, which rotates on auto-compaction
 * (W2-F2 review R8). 'anchor' (W2-F2 Phase 1 — anchored redo) = a boundary-less
 * snapshot of the live worktree captured immediately BEFORE a checkpoint restore,
 * so 'redo' can return to it; anchor rows carry an `${tree}-a${seq}` id (a
 * monotonic `anchorSeq`, collision-free with `${tree}-${ordinal}` and negative
 * session baselines) and are NOT keyed by turnOrdinal.
 */
export type CheckpointPhase = 'before' | 'after' | 'anchor';

/**
 * Checkpoints panel payload. Origin: `CheckpointTracker.list()` (see
 * {@link Checkpoint}'s doc) — the tracker already returns this exact shape, so
 * the host does no reshaping for this panel (see `reshapePanelData.ts`'s
 * comment). `available`/`unavailableReason` cover the tracker's own
 * `GitUnavailableError` (git not found on PATH) or no-workspace-open case:
 * the panel should render a disabled state ("checkpoints unavailable — git
 * not found") instead of an empty list.
 */
export interface CheckpointsData {
  checkpoints: Checkpoint[];
  /** `false` when the tracker could not initialize (e.g. no `git` on PATH, or no workspace open). Omitted/`true` when checkpoints are working normally. */
  available?: boolean;
  /** Human-readable reason, populated when `available === false`. */
  unavailableReason?: string;
  /**
   * Redo availability (W2-F2 Phase 1 — anchored redo). Present iff a redo target
   * exists: the user undid at least one checkpoint and has not since started a
   * new turn (a new positive-ordinal snapshot clears the forward stack, per
   * editor undo/redo semantics). Absent/omitted ⇒ nothing to redo (the panel
   * renders the redo affordance disabled).
   */
  redo?: CheckpointRedoState;
}

/**
 * Anchored-redo pointer (W2-F2 Phase 1). `anchorId` is the {@link Checkpoint}
 * `id` of the forward-most worktree captured at the FIRST undo — the "redo the
 * undo" target, ref-pinned so `git gc` cannot drop it (satisfies R1). `cursorId`
 * is the checkpoint the worktree was last restored to. `anchorTurnOrdinal` is a
 * DISPLAY-ONLY hint for the redo affordance's label (redo-ux research) — never a
 * correlation key. The redo dirty-guard (R2) is enforced host-side at redo time,
 * not carried here.
 */
export interface CheckpointRedoState {
  anchorId: string;
  cursorId: string;
  anchorTurnOrdinal?: number;
}

/**
 * Live status of one delegation. Origin: a STATEFUL FOLD over the ACP
 * `session/update` stream's `delegate_task` `tool_call`/`tool_call_update`
 * events (`src/host/panels/subagentAccumulator.ts`) — NOT TUI
 * `subagent.*`/`delegation.status` (those reflect the tui_gateway
 * control-plane process, a DIFFERENT process from the live chat agent —
 * wave-1 architecture decision). A `delegate_task` call is an ordinary ACP tool call on
 * the wire, so a tracked delegation starts `running` and Hermes drives it to
 * `complete`/`failed` via a `tool_call_update`.
 *
 * `interrupted` (X4) is the one status NOT sourced from a `tool_call_update`:
 * when a turn is CANCELLED (or errors), Hermes emits no tool completion for an
 * in-flight `delegate_task` (`acp_adapter/server.py` cancel path), so the
 * delegation would otherwise spin as `running` forever across later turns.
 * `AcpBackend` synthesizes `interrupted` for any still-`running` delegation
 * when its turn ends cancelled/errored, and at the end of a `session/load`
 * replay for a historical delegation whose completion was never recorded.
 */
export type SubagentStatus = 'running' | 'complete' | 'failed' | 'interrupted';

/**
 * One delegation observed on the live ACP stream — one entry per
 * `delegate_task` tool call, keyed by its `toolCallId`. Origin:
 * `acp_adapter/tools.py`'s `build_tool_title`/`build_tool_start`
 * (`:119-126`, `:1180-1197`) for the start, `_format_delegate_result`
 * (`:563-606`) for the completion summary.
 *
 * FIDELITY NOTE — why this replaced the original tree-shaped `SubagentNode`
 * (`root`/`role`/`model`/`depth`/`children`): the MAIN agent's ACP stream
 * only carries the `delegate_task` calls IT makes directly. Any further
 * delegation happening INSIDE a spawned sub-agent runs in a separate
 * context that never surfaces its own tool-call events back to this stream,
 * so a recursive tree, a per-node `role`, a per-node `model`, and a nesting
 * `depth` are simply not observable from here — modeling them would be
 * fabrication. A batched
 * `delegate_task` call (multiple tasks in one call) is still exactly one
 * `toolCallId` / one node: Hermes never gives a batch's per-task breakdown
 * its own tool-call events either, only a combined prose summary in the
 * completion (surfaced below as `detail`).
 */
export interface SubagentNode {
  /** The `tool_call.toolCallId` this delegation was created from. */
  id: string;
  /**
   * The delegated goal, or a batch summary. Origin: `tool_call.title` — the
   * ONLY structured identifier available for this tool (`rawInput` is
   * intentionally never sent for `delegate_task`; see
   * `subagentAccumulator.ts`'s module doc for why). e.g.
   * `"delegate: refactor the parser"` or `"delegate batch (3 tasks)"`.
   */
  goal: string;
  status: SubagentStatus;
  /**
   * Host wall-clock ISO-8601 timestamp when the `tool_call` was first observed
   * live — NOT an ACP-sourced field (the wire carries no timestamp on
   * tool-call events). OMITTED for a delegation reconstructed during a
   * `session/load` replay: that event is historical and its true start time is
   * unknown, so the host does not fabricate `now()` for it (Minor fix).
   */
  startedAt?: string;
  /**
   * Free-text preview/result, when available: the start event's content
   * preview, later replaced by the completion's `_format_delegate_result`
   * prose (per-task status/model/duration/summary for a batch). Optional —
   * a still-`running` delegation may not have any content yet.
   */
  detail?: string;
}

/**
 * Subagents / delegation panel payload — REFINED from the original
 * tui_gateway-oriented placeholder (`root`/`paused`/`maxConcurrent`/
 * `maxDepth`), which assumed a full spawn tree plus pause/resume control
 * that the ACP channel cannot provide. A
 * flat list, not a tree — see {@link SubagentNode}'s fidelity note. Origin:
 * `SubagentAccumulator`'s current snapshot (`src/host/panels/
 * subagentAccumulator.ts`), pushed by `AcpBackend` whenever a `delegate_task`
 * `tool_call`/`tool_call_update` event changes it.
 */
export interface SubagentsData {
  delegations: SubagentNode[];
}

/**
 * One row in the session list / history browser. Origin: ACP `session/list`
 * (`SessionInfo`, `acp_adapter/server.py:1277-1289`). The ACP handler forwards
 * only these four fields onto the wire — richer session-manager fields (e.g.
 * message count, model) are computed server-side but NOT included in the
 * response; do not assume more without re-grounding against source.
 */
export interface SessionSummary {
  id: string;
  cwd: string;
  title?: string;
  /** Timestamp string as forwarded by ACP; exact format not contractually pinned. */
  updatedAt?: string;
}

/**
 * Sessions / history panel payload. Origin: ACP `session/list` (cursor +
 * optional `cwd` filter, server page size 50 — `acp_adapter/server.py:1249-1292`).
 * UNLIKE every other entry in {@link PanelDataMap}, this one's source is the
 * ACP channel (`AcpClient`), not a tui_gateway RPC — see `AcpBackend`'s
 * `PANEL_REFRESH_METHOD` comment. Selecting a session then replays its
 * transcript via ACP `session/load` as ordinary streaming `session/update`
 * notifications (i.e. through the streaming pipeline — `session/update` folds
 * into the `message.*`/`tool.*` {@link HostToWebview} messages), NOT through
 * this payload — this type only carries the browsable list.
 */
export interface SessionsData {
  sessions: SessionSummary[];
  /** Opaque pagination cursor — pass back as ACP `session/list`'s `cursor` param. */
  nextCursor?: string;
}

/** One selectable model. Origin: TUI `model.options`. */
export interface ModelInfo {
  id: string;
  label: string;
  /** Context-window size in tokens, when advertised. */
  contextWindow?: number;
}

/** A model provider and its models. Origin: TUI `model.options`. */
export interface ModelProvider {
  id: string;
  name: string;
  /** Whether an API key / credential is configured for this provider. */
  connected: boolean;
  models: ModelInfo[];
  /**
   * beta.7 B4: true for synthetic rows that are not a real credentialed
   * provider (today only Hermes' MoA row — inventory.py `_moa_provider_row`,
   * `source:'virtual'`). Virtual rows get NO "Add key" affordance:
   * `model.save_key` has no PROVIDER_REGISTRY entry for them and refuses
   * (`unknown provider: moa`, server.py 4002).
   */
  virtual?: boolean;
}

/** Models panel payload. Origin: TUI `model.options` + ACP `session/set_model`. */
export interface ModelsData {
  providers: ModelProvider[];
  /** Currently active model id (matches a `ModelInfo.id`). */
  currentModelId: string;
}

/** One editable config field. Origin: TUI `config.show` (flattened). */
export interface SettingField {
  /** Dotted config key, e.g. `delegation.max_concurrent_children`. */
  key: string;
  value: string | number | boolean;
  type: 'string' | 'number' | 'boolean' | 'enum';
  /** Allowed values when `type === 'enum'`. */
  options?: string[];
  description?: string;
}

/** One config.yaml section. Origin: TUI `config.show`. */
export interface SettingsSection {
  /** Section name — one of the 21 config.yaml top-level sections. */
  name: string;
  fields: SettingField[];
}

/** Settings panel payload. Origin: TUI `config.show` / `config.get` / `config.set`. */
export interface SettingsData {
  sections: SettingsSection[];
}

/* ------------------------------------------------------------------ *
 * Setup / Talaria Config panel (Task 8 — protocol v2). Ground truth:
 * `docs_claude/onboarding-backend-setup-architecture.md` §6. These shapes
 * are a deliberate WEBVIEW-SAFE PROJECTION of the host-side backend
 * registry (`src/host/setup/registry.ts`'s `BackendDescriptor`) — plain
 * data only, reproduced verbatim here rather than imported, so this
 * dependency-free shared module never pulls host code (and therefore
 * Node/VS Code APIs) into the webview's module graph. The host reshapes
 * `BackendDescriptor` -> `SetupBackendOption` at the panel-data boundary,
 * the same way `reshapePanelData.ts` reshapes every other panel's host
 * state into its wire payload.
 * ------------------------------------------------------------------ */

/**
 * One selectable backend option (an agent choice, e.g. Hermes, or a FIM/
 * autocomplete choice) as rendered by the Setup panel's picker cards.
 * Registry projection — see this section's header doc.
 */
export interface SetupBackendOption {
  id: string;
  kind: 'agent' | 'fim';
  status: 'available' | 'coming-soon';
  displayName: string;
  description: string;
  /** The "Connect to an existing endpoint" tab — present for every remote-capable entry. */
  remote?: {
    endpointDefault: string;
    endpointValue: string;
    endpointPlaceholder: string;
    auth: 'none' | 'apiKey-optional' | 'apiKey-required';
    apiKeySet: boolean;
    probe: 'ollama-tags' | 'llamacpp-health' | 'openai-models' | 'none';
  };
  /** The "Install locally" tab — present only for the local-capable entries. */
  localInstall?: {
    /** beta.5 T6: `'docs-only'` (additive) — no verified install source, a
     *  docs link + endpoint Test only (e.g. vLLM, §5.2 rev 3 ⑪). */
    flavor: 'pipx' | 'guided-terminal' | 'docs-only';
    effort: 'one-script' | 'manual-guided';
    /** @deprecated beta.6 T11 — the unified FIM/RAG surfaces read
     *  `SetupData.catalog.models` instead; still projected for wire compat
     *  (see `registry.ts` `LocalInstallMode.models`), do NOT remove. */
    models?: { role: 'fim' | 'embedding'; model: string; present: boolean }[];
  };
  /** Present iff this FIM backend also supports the NEXT card's "generic" (reuse) source. */
  nextEditTransport?: 'ollama' | 'openai-compat';
  docsUrl?: string;
}

/**
 * Lifecycle phase of the Agent card's selected backend (Hermes today).
 * Origin: §6 card 1's per-phase UI (pipx-missing -> ... -> ready/error).
 */
export type AgentSetupPhase =
  | 'unknown'
  | 'pipx-missing'
  | 'python-unsuitable'
  | 'missing'
  | 'installing'
  | 'installed-inactive'
  | 'awaiting-reload'
  | 'ready'
  | 'error';

/**
 * beta.6 §1.3 (T6): one verified-catalog model row as it crosses the wire —
 * the unified "Local Model" component's per-row data. Structural mirror of
 * the host engine's `CatalogModel` (`src/host/setup/modelCatalog.ts`) —
 * reproduced here, not imported, per this module's webview-safe
 * zero-host-imports rule (section header doc). The webview only ever sends
 * back `id` (`setup.provisionModel` re-resolves everything host-side); every
 * command string here is HOST-composed from charset-asserted catalog data —
 * the webview renders text, never composes it (Global Constraint 1).
 */
export interface SetupCatalogModel {
  /** Catalog id — the ONLY thing the webview may send back. */
  id: string;
  role: 'agent' | 'fim' | 'embedding' | 'next';
  displayName: string;
  publisher: string;
  license: string;
  /** rev 3 — picker preselect, "Default" chip, §3.5 recs strip. EXACTLY one per role. */
  defaultForRole?: boolean;
  contextWindow?: number;
  /** §6 honesty line. */
  vramLine: string;
  /** §6 base-build / mmproj / MoE / ctx notes. */
  note?: string;
  /** == id — the ONE pull/cancel/progress key (rule 7). */
  progressId: string;
  /** Library tier only. Presence is derived CLIENT-side against `setup.ollama.models` (C-6). */
  ollamaTag?: string;
  /** rev 2 (CC-3) — renders `Pull {tag} (~{size})` / `Download {name} (~{size})`. */
  ollamaApproxBytes?: number;
  /**
   * hf-ingest tier (sweep AND devstral — rev 3). LOAD-BEARING: the block's
   * client-side `/api/tags` presence check keys on it.
   */
  ollamaCreatedName?: string;
  llamacpp?: {
    file: string;
    approxBytes: number;
    /** §2.2.8 sidecar rule — "present in Talaria's model folder", never "verified". */
    present: boolean;
    available: boolean;
    /** rev 3: NO shipping row uses it (F-3/F-4 closed) — kept for future
     *  rows; §6 honest-absence copy, host-composed. */
    unavailableReason?: string;
    /** ONLY when present && sidecar-attested (§2.2.8). */
    runCommand?: string;
  };
  /** Composed ONLY after the SC-2 compose-time gate passes (§2.2.6). */
  vllm?: { runCommand: string };
}

/**
 * Setup / Talaria Config panel payload — one snapshot covering all five
 * readiness cards (§6): agent, provider, FIM/autocomplete, NEXT, RAG, plus
 * the Ollama local-daemon status the FIM/NEXT local-install tabs read from.
 */
export interface SetupData {
  /** Mutations disabled + explained when `false` (untrusted workspace). */
  trusted: boolean;
  /** Card 1 — agent (Hermes / OpenClaw / Talaria AI). */
  agent: {
    options: SetupBackendOption[];
    selectedId: string;
    phase: AgentSetupPhase;
    version?: string;
    detail?: string;
    logTail?: string[];
    /**
     * beta.5 §1.2 (T5): the HOST-composed pipx bootstrap for the
     * `pipx-missing` card — present iff `phase === 'pipx-missing'`.
     * `command` is the engine's exact pre-typed line for the detected
     * family; absent `command` = unknown distro, `guidance` (§6 copy) is
     * then the whole story. The webview renders this text only — it never
     * composes or submits command text of its own (Global Constraint 1).
     */
    bootstrap?: { command?: string; guidance: string };
    /**
     * beta.5 §1.2 (T5): the engine's Python install plan for the
     * `python-unsuitable` card — present iff `phase ===
     * 'python-unsuitable'`. Structural mirror of the host engine's
     * `PythonInstallPlan | PythonGuidancePlan` (`src/host/setup/
     * packageTable.ts`) — reproduced here, not imported, per this module's
     * webview-safe zero-host-imports rule (section header doc).
     */
    pythonInstall?:
      | { kind: 'command'; command: string; sourceNote: string; docsUrl: string }
      | { kind: 'guidance'; text: string; docsUrl: string };
  };
  /** Card 2 — provider (chat model for the agent). */
  provider: {
    phase: 'waiting-agent' | 'unconfigured' | 'configured' | 'unknown';
    providerId?: string;
  };
  /** Card 3 — autocomplete (FIM). */
  fim: {
    options: SetupBackendOption[];
    selectedId: string;
    enabled: boolean;
    model: string;
    endpointValue: string;
    tuning: {
      debounceMs: number;
      maxPromptTokens: number;
      temperature: number;
      crossFileEnabled: boolean;
      prefixInjection: boolean;
      prefixInjectionRemote: boolean;
      warmUp: boolean;
    };
  };
  /** Card 4 — NEXT (multi-line next-edit) info panel + dedicated-setup flow. */
  nextEdit: {
    source: 'off' | 'dedicated' | 'generic';
    backend: 'ollama' | 'openai-compat';
    endpoint: string;
    model: string;
    /** `endpoint`+`model` both non-empty. */
    dedicatedConfigured: boolean;
    /**
     * beta.6 rev 2 (CC-10, §4.2): which unified-block backend pane the NEXT
     * dedicated setup was configured through (`'ollama'` / `'llamacpp'` /
     * `'vllm'` / `'openai-compat'` — a new `talaria.nextEdit.
     * dedicatedBackendId` setting, T8) — restoration source for the block's
     * selected pane; absent = the existing transport heuristic. Shape pinned
     * by T6; populated by T8. OPTIONAL + additive.
     */
    dedicatedBackendId?: string;
    /** Whether the current FIM backend supports the `generic` (reuse) source. */
    genericSupported: boolean;
    refusalDetail?: string;
    /**
     * beta.5 §4.2 (T13): the dedicated NEXT model block — host-composed
     * capability + raw facts; the webview DERIVES presence client-side
     * against its live form state (critics C-6/S-F11). OPTIONAL + additive
     * (Global Constraint 6) — the host always populates it since beta.5.
     */
    dedicated?: {
      displayName: string;
      /**
       * Per-backend prefill (D1). ⚠ R-3: `ollama` is `''` while
       * `!downloadReady` — a prefill naming a model that resolves to
       * nothing would let Apply persist silent runtime next-edit failure;
       * the empty model instead trips `setup.setNextEdit`'s existing
       * "model is required" refusal (configuration fail-closed, not just
       * the download). When `downloadReady`, it is the ingest-created
       * local name (`ollamaCreatedName`).
       */
      modelDefaults: { ollama: string; openaiCompat: string };
      /**
       * Capability flag ONLY: the code-pinned sha256 is published
       * (non-empty). The UI additionally requires picked-backend===ollama
       * and a reachable daemon before showing the Download button.
       */
      downloadReady: boolean;
      downloadApproxBytes: number;
      /** D4 copy, host-composed (§6), rendered at CARD level (C-14). */
      warning: string;
      /**
       * Guided command lines (§6, newline-separated command + note).
       * `llamacpp` present ONLY when `downloadReady` — the `-hf` line is
       * gated by the same pin as the Download button (S-F2/S-F5).
       */
      guided: { vllm: string; llamacpp?: string };
    };
  };
  /** Card 5 — codebase index (RAG). */
  rag: {
    enabled: boolean;
    embedEndpoint: string;
    /**
     * beta.6 rev 2 (CC-10, §3.4/§4.2): which backend the RAG embedder block
     * is configured against (a new `talaria.rag.embedBackend` setting, T8) —
     * restoration source for the block's selected pane; absent = ollama.
     * Shape pinned by T6; populated by T8. OPTIONAL + additive.
     */
    embedBackend?: 'ollama' | 'llamacpp' | 'openai-compat';
    embedModel: string;
    /**
     * @deprecated beta.6 T14 — computed against the daemon the HOST probed,
     * not `embedEndpoint`, so it answers for the wrong daemon whenever the
     * two differ (and its exact match misses `:latest`). The unified UI
     * derives presence client-side, endpoint-scoped (§3.4 C-6,
     * `ragEmbedPresence` in `setupCards.ts`); the field stays on the wire
     * for compat only — no webview code reads it (source-scan-locked).
     */
    embedModelPresent: boolean;
    tuning: { dims: number; maxChunkTokens: number; debounceMs: number; excludeGlobs: string[] };
    indexDir: string;
    /** `shouldActivateRag` text, populated when RAG is blocked from activating. */
    preconditionDetail?: string;
    /**
     * beta.6 panel-fix (T2, audit A5): host-owned per-pane endpoint defaults
     * — mirrors `agentLocalModel.endpointDefaults` (CC-6) exactly, so the
     * RAG surface can init each pane's endpoint field without ever
     * fabricating a URL client-side (Global Constraint 1). `llamacpp` is
     * drift-locked to `LLAMACPP_RUN_FLAGS.embedding`'s port. OPTIONAL +
     * additive — the webview degrades to `''` when absent; ALWAYS populated
     * by the host since this field shipped.
     */
    endpointDefaults?: { ollama: string; llamacpp: string; 'openai-compat': string };
  };
  /**
   * Local Ollama daemon status, read by the FIM/NEXT local-install tabs.
   * `endpoint` (beta.5 §4.2, T13): the endpoint `status()` ACTUALLY probed —
   * presence claims are scoped to it; the webview must treat any OTHER
   * endpoint's presence as `'unknown'`, never inherited (critic C-6).
   * OPTIONAL + additive (Global Constraint 6) — always populated since beta.5.
   */
  ollama: { running: boolean; endpoint?: string; models: { name: string; sizeBytes: number }[] };
  /**
   * beta.6 §1.3 (T6): the verified model catalog, projected row-by-row from
   * `MODEL_CATALOG` (13 rows). OPTIONAL + additive (Global Constraint 6) —
   * always populated since beta.6.
   */
  catalog?: { models: SetupCatalogModel[] };
  /**
   * beta.6 §1.3/§2.5 (T6): the llama.cpp `llama-server` runtime state — a
   * SETTLED-VALUE memo, not an awaited probe: `status()` kicks the probe
   * lazily and returns `'checking'` immediately; the settle fires ONE
   * `onStatusChanged` (the seq-guarded push repaints). `probe-timeout` (and
   * win32, where no probe ever runs) map to `'unknown'`, NEVER `'missing'`
   * (CC-5 — a timeout is not "not found"). OPTIONAL + additive.
   */
  llamacppRuntime?: {
    binary: 'checking' | 'found' | 'missing' | 'unknown';
    version?: string;
    /** `~`-redacted. */
    path?: string;
    /**
     * rev 2 (CC-4) — the `agent.bootstrap` pattern: present iff
     * `binary === 'missing'`. `command` is the OS engine's exact pre-typed
     * line for the detected family; absent `command` = guidance-only distro
     * (debian/unknown/container) — the webview renders text only.
     */
    install?: { command?: string; guidance: string; docsUrl: string };
  };
  /**
   * beta.6 §1.3 (T8): the "Configure Local Agent Model" block's wire state —
   * host-owned endpoint defaults (CC-6), the saved selection (+ a run
   * command recomposed from the SAVED endpoint's port), and the §6
   * provider-guidance variant picked per `provider.phase` (CC-7). Shape
   * pinned by T6; POPULATED by T8 (which owns the three
   * `talaria.agent.localModel.*` settings). OPTIONAL + additive.
   */
  agentLocalModel?: {
    endpointDefaults: { ollama: string; llamacpp: string; vllm: string };
    saved?: {
      modelId: string;
      backend: 'ollama' | 'llamacpp' | 'vllm';
      endpoint: string;
      runCommand?: string;
      /** What to type into the provider wizard (ollama: the tag/created name; llamacpp: the GGUF model name; vllm: the serveRepo). */
      servedName: string;
    };
    providerGuidance?: string;
  };
  /** Composite "you're ready" banner: agent ready + provider configured + FIM probe OK. */
  ready: boolean;
  /**
   * beta.5 §1.2 (T5): the detected OS identity every pre-typed install
   * command on this panel was composed FOR. Structural mirror of the host
   * engine's `DistroFamily`/`PackageManager` (`src/host/setup/osDetect.ts`)
   * — reproduced here, not imported (webview-safe module, see section
   * header doc). OPTIONAL + additive (Global Constraint 6).
   */
  os?: {
    family: 'fedora' | 'debian' | 'arch' | 'suse' | 'unknown';
    manager: 'dnf' | 'apt-get' | 'pacman' | 'zypper' | 'unknown';
    prettyName?: string;
    /**
     * §6 container-note copy (S-F10 honesty), present when detection
     * degraded to `unknown` because a container/Flatpak boundary hides
     * which system the integrated terminal actually acts on (a container
     * marker was found and `/run/host/os-release` was absent).
     */
    containerNote?: string;
  };
}

/**
 * Streamed install/pull progress for the Setup panel (§6) — the payload of
 * the throttled (>=150ms) {@link HostToWebview} `setup.progress` push.
 * `op` distinguishes an agent/backend install from a model pull; `id` is the
 * backendId or model name the progress line belongs to.
 */
export interface SetupProgress {
  op: 'install' | 'pull';
  /** backendId (install) or model name (pull). */
  id: string;
  phase?: string;
  /** One streamed log line, appended to the card's live log tail. */
  line?: string;
  totalBytes?: number;
  completedBytes?: number;
}

/**
 * Maps each side panel to its data payload type. Used to keep
 * {@link HostToWebview} `panel.data` keyed consistently with the panel it targets.
 */
export interface PanelDataMap {
  tools: ToolsData;
  mcp: McpData;
  skills: SkillsData;
  checkpoints: CheckpointsData;
  subagents: SubagentsData;
  sessions: SessionsData;
  models: ModelsData;
  settings: SettingsData;
  setup: SetupData;
}

/** Panels that carry data (everything except `chat`). */
export type DataPanel = keyof PanelDataMap;

/** A resolved diff attached to a tool card (webview view-model + tool.diff folding). */
export interface ToolDiff {
  path: string;
  hunks: DiffHunk[];
}

/**
 * W6-FF (3-way ARCH I-1) + H4-B8: one LIVE session's tab-identity + per-tab
 * DISPLAY state, for `hydrate`'s {@link WebviewState.tabs} list.
 *
 * `tabId`/`sessionId`/`cwd` started as the EXACT shape `AcpBackend`'s own
 * crash/respawn recovery snapshot captures (`ConnectionSupervisor
 * .pendingRecovery: Array<{sessionId, cwd, tabId}>`) — that identity triple
 * is still reused verbatim rather than inventing a second "what are the live
 * tabs" source of truth, but recovery's snapshot is its OWN narrower inline
 * type (see `ConnectionSupervisor.pendingRecovery`'s doc) — it does NOT
 * import or share this interface, so it is never forced to populate the
 * display fields below. `rootId` was the first addition
 * (`SessionController.getRootId()`): the webview's reconciliation needs it
 * so a reconciled tab's checkpoints/panels key correctly immediately,
 * without waiting for a fresh `tab.bound`.
 *
 * H4-B8 (arch report `final-3way-2-arch.md` Minor-2): `preset`/
 * `currentModelId`/`activeModeId`/`availableCommands` are the host-owned
 * PER-TAB display fields — NOT a new source of truth. They are the exact
 * same `SessionController` fields that `policy.state`/`mode.state`/
 * `commands.available`/the model-switch push already emit for that
 * session; the seed just exposes them AT HYDRATE TIME too, so a
 * non-active reconciled tab (post webview-recreate) shows its real
 * preset/model/mode/commands immediately instead of `makeTabState`
 * defaults while it waits for its own next push (which, for a background
 * tab, may not come for a long time). `currentModelId`/`activeModeId`/
 * `availableCommands` are optional — an absent field is a safe "no
 * information yet, keep the default" fallback, mirroring `WebviewState`'s
 * own absent-vs-empty convention. `preset` alone is NOT optional: `Session
 * Controller.getPreset()` never returns `undefined` (it defaults to
 * `'manual'` internally), so every entry always has a real value — the
 * reconciling reducer still defends with `?? DEFAULT_PRESET` at the fold
 * site for robustness against a producer that skews from this type (a
 * postMessage/JSON boundary is not compile-time-enforced). `availableModes` (the
 * custom-modes CATALOG) is deliberately NOT here — it needs the full catalog
 * from `mode.state`, not a scalar id, and stays a residual for its own push.
 * `title` is deliberately NOT here — the host does not own a tab title
 * (paired backlog M7, carried out; a title-ownership decision is a separate
 * architecture call).
 */
export interface HydrateTabSeed {
  tabId: string;
  sessionId: string;
  cwd: string;
  rootId: string;
  /** `SessionController.getPreset()` — this tab's OWN edit-policy preset. */
  preset: EditPolicyPreset;
  /** `SessionController.currentModelId` — this tab's OWN active model, or absent if never set. */
  currentModelId?: string;
  /** `SessionController.activeCustomModeId` — this tab's OWN active custom mode, or absent/`null` if none. */
  activeModeId?: string;
  /** `SessionController.getAvailableCommands()` — this tab's OWN cached slash-command catalog, or absent if never received. */
  availableCommands?: SlashCommandInfo[];
  /**
   * A5 (T-1 V-12 RESTART-STATE seed fold-in): `SessionController.
   * hasLiveTurn()` — this tab's OWN live-turn status at hydrate time.
   * `ControlDispatcher.listTabs` populates it fresh per entry (P-1
   * isolation, same posture as `preset`/`currentModelId`/`activeModeId`/
   * `availableCommands` above); the webview reconcile folds it straight
   * onto `TabState.turnActive` so a tab that was genuinely mid-turn when a
   * memory-pressure webview re-create reconciled it regains its Stop
   * affordance immediately, instead of showing a dead composer until a
   * `turn.end` that — for a webview instance that no longer exists — will
   * never arrive. Absent falls back to `makeTabState`'s `false` default,
   * mirroring this interface's other optional fields.
   */
  turnActive?: boolean;
}

/**
 * The compact webview bootstrap snapshot the host sends as `hydrate` on every
 * view (re)create. HONESTY NOTE (L2 R-C4): this deliberately carries NO
 * transcript/plan/panel cache — the host has never persisted one, and the old
 * fields were always empty (seedState()) while claiming otherwise. Streaming
 * fold state lives only in the webview; `retainContextWhenHidden` keeps the
 * hide/show case alive, and a window reload starts an honest empty chat.
 */
export interface WebviewState {
  /** Active ACP session id, or `null` before the first turn. */
  sessionId: string | null;
  theme: ThemeInfo;
  mode: AgentMode;
  /**
   * D2 (A2): which backend is LIVE right now (`this.backend.kind` at seed
   * time) — REQUIRED, deliberately with no honest default: an absent value
   * has no safe fallback (defaulting to `'acp'` would HIDE the mock, which
   * is the exact bug this field exists to fix; defaulting to `'mock'` would
   * slander a real backend). Connection-global carrier-pair sibling of
   * `theme`/`preset` above — mirrored by the scalar `backend.state` push
   * below for the ONE case hydrate alone can't cover: the trust-upgrade
   * `setBackend` swap, which deliberately never re-hydrates (would yank the
   * user's `activePanel`).
   */
  backendKind: BackendKind;
  /** W2-F1: the active client-side edit-policy preset (v1 boots at 'manual'). */
  preset: EditPolicyPreset;
  /** Active model id, or `null` if not yet resolved. */
  currentModelId: string | null;
  activePanel: Panel;
  /**
   * W2 F-S: the cached ACP `available_commands` catalog, so a re-created view
   * has it without the adapter replaying it. Absent/omitted before the first
   * `available_commands_update` arrives.
   */
  availableCommands?: SlashCommandInfo[];
  /**
   * W6-FF (3-way ARCH I-1): every LIVE session registered host-side at
   * hydrate time (`AcpBackend.listTabs()`, sourced from `SessionRegistry`).
   * Absent/omitted on a genuine cold boot (the registry is empty — nothing
   * to reconcile, today's single-bootstrap-tab flow is unchanged) or on a
   * backend with no multi-tab registry (mock). Non-empty means "this webview
   * instance is fresh, but N host `SessionController`s are still alive" —
   * VS Code's `retainContextWhenHidden` is documented BEST-EFFORT
   * (`TalariaViewProvider.ts`), so a memory-pressure dispose+recreate fires
   * exactly this path. The reducer's `hydrate` fold reconciles its tab model
   * from this list instead of trusting its own freshly-booted (single/empty)
   * tab set, so every live session's stream re-binds to its real tab instead
   * of hitting `foldSessionScoped`'s drop-unknown path (the orphan this
   * closes — 3-way ARCH finding I-1).
   */
  tabs?: HydrateTabSeed[];
}

/* ------------------------------------------------------------------ *
 * HOST -> WEBVIEW
 * ------------------------------------------------------------------ */

/**
 * Messages the extension host sends to the webview. Discriminated on `type`.
 */
export type HostToWebview =
  /**
   * Full state restore after the view is (re)created.
   * Origin: host-side, from persisted `getState()` + backend replay.
   */
  | { type: 'hydrate'; state: WebviewState }

  /**
   * Reset the chat transcript for a fresh session.
   * Origin: ACP `session/new` / TUI `session.create`.
   * W4 §2d: per-session now (§7 B-affirm) — the routing key lets a
   * multi-tab webview clear only the tab this session belongs to.
   */
  | { type: 'clear'; sessionId: string }

  /**
   * A new agent turn has begun.
   * Origin: ACP `session/prompt` accepted / TUI `message.start`.
   */
  | { type: 'turn.start'; turnId: string; sessionId: string }

  /**
   * Echo of the user's submitted prompt (rendered as the user bubble).
   * Origin: ACP `session/prompt` request / TUI `prompt.submit`.
   */
  | { type: 'user'; turnId: string; sessionId: string; text: string; mode: AgentMode }

  /**
   * A reasoning / thinking block starts.
   * Origin: ACP `agent_thought_chunk` (first chunk) / TUI `reasoning.available`.
   */
  | { type: 'reasoning.start'; turnId: string; sessionId: string; blockId: string }

  /**
   * Incremental reasoning text.
   * Origin: ACP `agent_thought_chunk` / TUI `reasoning.delta` (or `thinking.delta`).
   */
  | { type: 'reasoning.delta'; turnId: string; sessionId: string; blockId: string; text: string }

  /**
   * Reasoning block finished (collapse it).
   * Origin: derived from the first non-thought chunk after thoughts.
   */
  | { type: 'reasoning.end'; turnId: string; sessionId: string; blockId: string }

  /**
   * Incremental assistant answer text.
   * Origin: ACP `agent_message_chunk` / TUI `message.delta`.
   */
  | { type: 'message.delta'; turnId: string; sessionId: string; text: string }

  /**
   * Assistant message finished; carries the final settled text.
   * Origin: TUI `message.complete` / end of ACP `agent_message_chunk` stream.
   */
  | { type: 'message.end'; turnId: string; sessionId: string; text: string }

  /**
   * A tool call started (card appears).
   * Origin: ACP `tool_call` / TUI `tool.start`.
   */
  | {
      type: 'tool.start';
      turnId: string;
      sessionId: string;
      toolId: string;
      kind: ToolKind;
      title: string;
      status: ToolStatus;
      /** Raw tool input preview (e.g. the command, the path), if available. */
      rawInput?: string;
    }

  /**
   * Tool status / output update.
   * Origin: ACP `tool_call_update` / TUI `tool.generating` + `tool.complete`.
   */
  | {
      type: 'tool.update';
      turnId: string;
      sessionId: string;
      toolId: string;
      status?: ToolStatus;
      /** Appended textual output (e.g. terminal stdout, file contents). */
      output?: string;
      /** Optional 0..1 progress fraction for long-running tools. */
      progress?: number;
    }

  /**
   * A reviewable file diff produced by an edit tool (`write_file`/`patch`).
   * Origin: ACP `tool_diff_content` (`edit_approval.py`).
   */
  | {
      type: 'tool.diff';
      turnId: string;
      sessionId: string;
      toolId: string;
      path: string;
      hunks: DiffHunk[];
    }

  /**
   * The agent needs an approval decision to continue.
   * Origin: ACP `session/request_permission` / TUI `approval.request`.
   */
  | {
      type: 'approval.request';
      turnId: string;
      sessionId: string;
      id: string;
      /** `command` = run permission; `edit` = diff/edit approval. */
      kind: 'command' | 'edit';
      title: string;
      detail?: string;
      /** Tool call this approval gates, when applicable. */
      toolId?: string;
      options: ApprovalOption[];
      /** Auto-deny deadline in ms (ACP command approval defaults to 60000). */
      timeoutMs?: number;
    }

  /**
   * ARCH-1 extension (audit-2 Cluster A): authoritative settlement of an
   * approval card and (via toolId) its diff hunks. Emitted on EVERY terminal
   * transition of a pending approval — user selection, session/cancel
   * (ACP spec MUST), the 60 s auto-deny deadline, or a turn/replay/connection
   * ending while the card is still open. The webview folds this over any
   * optimistic local state; optimistic actions never override a settled card.
   */
  | {
      type: 'approval.settle';
      sessionId: string;
      turnId: string;
      /** Approval id (matches the prior approval.request). */
      id: string;
      /** Tool call this approval gated — folds that tool's sibling hunks. */
      toolId?: string;
      outcome: 'selected' | 'cancelled' | 'expired' | 'superseded';
      /** Present iff outcome === 'selected'. */
      optionId?: string;
    }

  /**
   * The plan / todo checklist changed (full replacement).
   * Origin: ACP `plan` (`AgentPlanUpdate`).
   */
  | { type: 'plan.update'; turnId: string; sessionId: string; items: PlanItem[] }

  /**
   * End-of-turn result summary (final answer recap + usage).
   * Origin: ACP `message.complete` `_meta` / TUI `session.usage`.
   * ARCH-1 (final review, UI I-4): `status` is REQUIRED, not optional — an
   * optional field is a guard that cannot fail (a forgetful emitter would
   * silently render a green "Turn complete" card again). Carries the same
   * `mapStopReasonToStatus` value `turn.end` already carries, so a
   * cancelled/refused/errored turn's summary card can render honestly
   * instead of unconditionally green.
   */
  | { type: 'result.summary'; turnId: string; sessionId: string; status: 'complete' | 'cancelled' | 'error'; text?: string; usage?: UsageInfo }

  /**
   * A control-plane panel's data snapshot. Discriminated further on `panel`.
   * Origin: mostly the corresponding tui_gateway list RPC — see each
   * `*Data` type: tools←`tools.list`, mcp←`reload.mcp`,
   * skills←`skills.manage`, models←`model.options`, settings←`config.show`.
   * Three panels are NOT tui_gateway-sourced: sessions←ACP `session/list`
   * (see `SessionsData`'s doc), subagents←a stateful fold over the ACP
   * `session/update` stream's `delegate_task` events (see `SubagentsData`'s
   * doc), checkpoints←the extension-side `CheckpointTracker` (see
   * `CheckpointsData`'s doc). W4 §7 B2: `PanelDataMessage` is now two mapped
   * unions (session/root/cwd-keyed vs global) that already carry `type:
   * 'panel.data'` — see {@link PanelDataMessage} and {@link makePanelData}.
   */
  | PanelDataMessage

  /**
   * W2-F1: the active edit-policy preset changed (or is being echoed on
   * webview (re)bootstrap). The composer's preset picker renders this value —
   * the webview never assumes its own `policy.setPreset` took effect.
   */
  | { type: 'policy.state'; sessionId: string; preset: EditPolicyPreset }

  /**
   * Reply to a correlated {@link WebviewToHost} `control.request`, carrying the
   * echoed `requestId` and the {@link ControlResponse} envelope (Part A2). The
   * webview resolves/rejects the exact pending promise keyed by `requestId`.
   * This REPLACED the bespoke `checkpoint.restoreResult` PUSH: `checkpoint.restore`
   * is now an ordinary correlated request whose {@link CheckpointRestoreResult}
   * rides back in `result`.
   */
  | ({ type: 'control.response'; requestId: number } & ControlResponse)

  /**
   * The current turn ended.
   * Origin: ACP turn-loop completion / ACP `session/cancel` / TUI turn end.
   */
  | { type: 'turn.end'; turnId: string; sessionId: string; status: 'complete' | 'cancelled' | 'error' }

  /**
   * A SESSION-SCOPED error (agent init for this session, a turn, or a tool).
   * Origin: ACP error / TUI `error` event. Renders in the owning tab only.
   * W4 §7 B1: split from the former single `error` variant — a
   * connection-global failure (child not started yet, respawn/"reconnecting")
   * has no session to tag, so it rides {@link HostToWebview} `system.error`
   * instead (never dropped when the tagged tab happens to be closed).
   */
  | { type: 'error'; sessionId: string; turnId?: string; message: string; detail?: string }

  /**
   * A CONNECTION-GLOBAL error — no session to tag it to. Origin: the ACP
   * child not started yet, a respawn-in-progress "reconnecting…" notice, or
   * any other failure that predates/outlives any one session. Renders as a
   * banner across every open tab (§2e `AppState.systemError`), never folded
   * into (and never dropped alongside) one tab's transcript. W4 §7 B1.
   */
  | { type: 'system.error'; message: string; detail?: string }

  /**
   * ARCH-1 (final review): resolution push for the connection-global
   * degraded state announced via `system.error`. Emitted when connection +
   * session establishment completes (fresh boot, explicit restart, or
   * post-crash recovery) — see `ConnectionSupervisor.establishInitialSession`.
   * Reducer folds it to `systemError: undefined`. NOTE: reverses the
   * previously-ratified "no second signal on resolution" decision — owner
   * sign-off item 2 (remediation architecture §2): `system.error` is
   * reserved for connection-scoped degraded states, and any successful
   * establish retires it. This is not a second *signal*; it is the
   * *retirement* of the first — no new banner appears, one disappears.
   *
   * PROTOCOL CONTRACT (T5): `system.error` is reserved for connection-scoped
   * degraded states; any successful establish retires it via
   * `system.recovered`. A future emitter describing a NON-connection
   * degraded condition must NOT ride `system.error` — it would be silently
   * retired by the next unrelated successful establish. Define a new,
   * purpose-specific message instead.
   */
  | { type: 'system.recovered' }

  /**
   * The editor color theme changed.
   * Origin: host-side `window.onDidChangeActiveColorTheme`.
   */
  | { type: 'theme'; theme: ThemeInfo }

  /**
   * D2 (A2): the LIVE backend changed — CONNECTION-GLOBAL (no sessionId),
   * exactly like `theme` above. Today's only origin is the trust-upgrade
   * mock->acp swap (`TalariaViewProvider.setBackend`, fired from
   * `onDidGrantWorkspaceTrust`); posted AFTER the relay is re-pointed at the
   * new backend so `postToWebview` forwards through the correct instance.
   * Paired with `WebviewState.backendKind` (the hydrate-time seed) — this
   * push is what keeps the badge honest across a swap that deliberately
   * never re-hydrates.
   */
  | { type: 'backend.state'; kind: BackendKind }

  /**
   * W5.1 R5 (Task 13): the Guard-ratified «Next Edit Suggestions» toggles —
   * CONNECTION-GLOBAL (there is exactly one toggle store per extension, never
   * one per chat tab), folded exactly like `theme`/`backend.state` above.
   *
   * This push is the ONLY channel that carries toggle state to the webview:
   * the Settings panel keeps no webview-side persistence of its own (D1's
   * `getState`/`setState` is a different mechanism and is NOT used here), so
   * the Guard remains the single authority on what is on. Emitted from
   * `NextEditGuard.onDidChange` (i.e. after every ACCEPTED toggle — a refusal
   * ratifies nothing and pushes nothing) and once on every webview mount.
   *
   * A both-on state is unrepresentable here by construction: the Guard
   * sanitizes a hand-edited both-on store at hydrate and pushes the
   * post-reset value, so the panel needs no both-on rendering state.
   */
  | { type: 'nextEdit.state'; state: NextEditToggleState }

  /**
   * Task 8 (§6): streamed install/pull progress for the Setup panel's Agent
   * (install) and FIM/RAG local-install (model pull) cards — CONNECTION-GLOBAL
   * (no sessionId), same posture as `theme`/`backend.state`/`nextEdit.state`
   * above: installing a backend or pulling an Ollama model is not scoped to
   * any one chat session. Host-side emitter throttles to >=150ms between
   * pushes for the same `(op, id)` pair so a fast log/byte stream cannot
   * flood the webview with a message per line/chunk.
   */
  | ({ type: 'setup.progress' } & SetupProgress)

  /**
   * P1 entry-point fix: host-driven panel switch — CONNECTION-GLOBAL (no
   * sessionId), same posture as `theme`/`backend.state`/`setup.progress`
   * above: which side panel is showing is not scoped to any one chat
   * session. EXPLICIT-intent only: this message MAY yank whatever panel the
   * user currently has open, which is correct for an explicit "open Setup"
   * action but wrong for anything ambient — the invisible `setBackend`
   * trust-upgrade swap must never emit it. The reducer folds only the STATE
   * half (`activePanel`); the FETCH half (requesting the panel's data) is
   * owned by the App layer, tagged with a `trigger` so it can be told apart
   * from a user click (see the architecture doc's Part I §3.3).
   */
  | { type: 'panel.activate'; panel: Panel }

  /**
   * W2 F-A: code actions → composer. SEED ONLY — the webview inserts `text` +
   * mention chips into the draft and focuses the textarea; it MUST NOT
   * auto-submit (review-first is the security posture). The webview APPENDS
   * to a non-empty draft, never clobbers it. Origin: §2e.
   */
  | { type: 'composer.seed'; text: string; mentions?: ContextRef[] }

  /**
   * W2 F-S: the ACP `available_commands` catalog (cached host-side,
   * re-pushed on `session/load`; also carried in `hydrate.state.
   * availableCommands` for a cold (re)create). Origin: §2e/§3.2.
   *
   * W6-FE Part 1 (3-way ARCH I-3b): now SESSION-SCOPED (`sessionId`
   * required) — the catalog is per-controller host state (each session's
   * OWN `available_commands_update` fold), so it must fold into the OWNING
   * tab, not a single global slot. Previously unscoped on the wire, which
   * let the webview store it as one global value: switching tabs after a
   * second session pushed its own catalog showed the WRONG session's slash
   * palette (a cross-tab clobber). Folds via `foldSessionScoped` in
   * `webview/src/state/transcript.ts`, exactly like every other
   * session-scoped message.
   */
  | { type: 'commands.available'; sessionId: string; commands: SlashCommandInfo[] }

  /**
   * W4 §2d: a chat-session tab is now bound to a live ACP session (the
   * per-tab generalization of the `backendStarted` latch) — the tab's
   * composer unlocks. Origin: host `session/new` (or a `tab.load` replay)
   * resolving for `tabId`.
   *
   * W4-T3b (D1 — the checkpoints eternal-spinner fix): carries `rootId`, the
   * session's `RootCoordinator` root key (`SessionController.getRootId()`).
   * The webview's `tab.bound` fold sets `TabState.rootId` from this value —
   * the ONLY place a tab learns its real root — so the checkpoints panel's
   * fetch-loading write (`AppState.rootPanels[tab.rootId]`), the host's
   * `panel.data{panel:'checkpoints', rootId}` push, and the App-level read
   * all key on the SAME real root instead of the tab's `''` default.
   */
  | { type: 'tab.bound'; tabId: string; sessionId: string; rootId: string; title?: string }

  /**
   * W4 §2d/§7 B8: `tab.open` (or `tab.load`) failed — a rejected
   * `session/new` (backend not started, child dead mid-respawn) must get a
   * TERMINAL reply, or the tab's composer stays disabled forever (the
   * never-resolves class this project has systematically killed). The
   * webview offers a retry affordance on the still-unbound tab.
   * `open-failed` = the initial bind never succeeded; `session-lost` = a
   * previously-bound tab's session died and could not be restored.
   */
  | { type: 'tab.error'; tabId: string; message: string; kind: 'open-failed' | 'session-lost' }

  /**
   * W3-T6 (CF-11/D2 3-lens review fix, IMP-2): tabId-scoped transcript clear
   * — the counterpart to the generic `clear` above for the ONE case that
   * message can't reach: a tab whose occupant is already gone (a
   * session-lost tab has no resolvable `sessionId -> tabId` mapping left for
   * `foldSessionScoped` to route through). `AcpBackend.newSessionInTabInternal`
   * emits this UNCONDITIONALLY on every "New Session" rebind — whether or not
   * the tab currently holds a live occupant — so the SAME message reaches a
   * live-old-session rebind and a session-lost rebind alike, and the
   * webview's fold (`transcript.ts`'s `case 'tab.clear'`) resets the tab to a
   * genuinely clean slate (transcript, plan, the standing `error`/
   * `openFailed`/`sessionLost` banner markers) before the fresh `tab.bound`
   * lands. Never carries a `sessionId` — that is the whole point: identity is
   * the tabId itself, not a session this tab may no longer even remember.
   */
  | { type: 'tab.clear'; tabId: string }

  /**
   * SF-2: the session's active custom mode changed (or is being echoed after
   * a `mode.set`/on tab bind). `available` is the catalog of modes the
   * session may switch to. Origin: §4.
   */
  | { type: 'mode.state'; sessionId: string; modeId: string | null; available: CustomModeInfo[] }

  /**
   * ARCH-1 (final review): the authoritative per-session model state.
   * Emitted by `SessionController.setModel` on EVERY terminal transition of
   * a switch attempt: confirm (RPC resolved → modelId = the new id),
   * corrective snap-back (RPC rejected or no live client → modelId = the
   * previous id, possibly null). The webview's optimistic `local.setModel`
   * is legal ONLY because this push overwrites the same field
   * (`TabState.currentModelId`) — the "authoritative overwrite" half of the
   * optimistic-with-authoritative-overwrite pattern (React's own
   * `useOptimistic` contract: a failure means the final render reflects the
   * authoritative value, never the stale optimistic one).
   */
  | { type: 'model.state'; sessionId: string; modelId: string | null };

/**
 * SF-2: one custom mode the session may switch `mode.set` to. Origin: §4.
 */
export interface CustomModeInfo {
  id: string;
  name: string;
}

/**
 * SF-2 (W4 §4.1) — the HOST-SIDE config shape for one entry of the
 * `talaria.customModes` VS Code setting. NOT a wire message: T4b reads this
 * from `vscode.workspace.getConfiguration().inspect(...).workspaceValue`
 * (`src/host/backend/customModes.ts`), builds a `ModeFloor` snapshot from it
 * (`editPolicy.ts`), and reduces it to {@link CustomModeInfo} for the wire
 * via `toCatalog`. `deny`/`allowOnly` use the restricted rule grammar
 * `violatesModeFloor` matches: exact workspace-relative path
 * (`src/app.ts`), directory prefix ending `/` (`src/`), or basename suffix
 * (`*.env`). No globs/`**`/negation.
 */
export interface CustomModeConfig {
  id: string;
  name: string;
  deny?: string[];
  allowOnly?: string[];
}

/* ------------------------------------------------------------------ *
 * `panel.data` — two mapped unions, not one optional field (W4 §7 B2)
 * ------------------------------------------------------------------ *
 * The research/first-draft treated sessions/subagents/checkpoints as
 * uniformly "session-coupled", but their real scopes differ (§2f):
 *  - subagents  is per-SESSION  (a fold over THIS session's update stream);
 *  - checkpoints is per-ROOT    (one shadow-git timeline shared by every
 *    same-root tab — §3.2's root-scoped lease);
 *  - sessions   is per-CWD      (`SessionsPanelSource` filters by cwd);
 *  - tools/mcp/skills/models/settings are GLOBAL (no scope key at all).
 * Modeling this as a single optional `sessionId?` would let a variant miss
 * its real scope key and compile clean — exactly the silent blank-panel drop
 * B2 flagged. Two mapped unions (keyed vs global) make the RIGHT key
 * REQUIRED per panel; {@link makePanelData} is the only constructor and its
 * overloads make a missing/wrong scope key a compile error at every call
 * site. */

/** The four scope classes a {@link DataPanel} can carry (§2f). */
export type Scope = 'session' | 'root' | 'cwd' | 'global';

/**
 * W6-FE Part 2 (3-way ARCH I-3a): the EXPLICIT, EXHAUSTIVE panel -> scope
 * classification. Replaces the former `GlobalPanel = Exclude<DataPanel,
 * SessionScopedPanel | RootScopedPanel | CwdScopedPanel>` derivation, whose
 * `Exclude` shape let a FUTURE session/root/cwd-scoped panel default to
 * `GlobalPanel` just by never being added to the other three aliases —
 * exactly the scope-bleed class this taxonomy exists to prevent,
 * reintroduced silently at the point of extension.
 *
 * `as const satisfies Record<DataPanel, Scope>` makes every {@link DataPanel}
 * member REQUIRED here: a panel added to {@link PanelDataMap} without a
 * matching entry fails `npm run check-types` (TS2741 "Property '<panel>' is
 * missing") — a COMPILE error, not a silent global default. See
 * `protocol.test.ts` for the non-vacuous exhaustiveness proof.
 *
 * Every value below reproduces the EXACT runtime scope each panel already
 * had — this is a classification refactor, not a re-scope (§2f: subagents is
 * per-session, checkpoints per-root, sessions per-cwd, everything else
 * global).
 */
export const PANEL_SCOPE = {
  subagents: 'session',
  checkpoints: 'root',
  sessions: 'cwd',
  tools: 'global',
  mcp: 'global',
  skills: 'global',
  models: 'global',
  settings: 'global',
  setup: 'global',
} as const satisfies Record<DataPanel, Scope>;

/** Panels whose payload is a fold over one ACP session's update stream. Derived from {@link PANEL_SCOPE}. */
export type SessionScopedPanel = {
  [P in DataPanel]: (typeof PANEL_SCOPE)[P] extends 'session' ? P : never;
}[DataPanel];
/** Panels whose payload is one workspace root's shared checkpoint timeline. Derived from {@link PANEL_SCOPE}. */
export type RootScopedPanel = {
  [P in DataPanel]: (typeof PANEL_SCOPE)[P] extends 'root' ? P : never;
}[DataPanel];
/** Panels whose payload is filtered by one workspace cwd. Derived from {@link PANEL_SCOPE}. */
export type CwdScopedPanel = {
  [P in DataPanel]: (typeof PANEL_SCOPE)[P] extends 'cwd' ? P : never;
}[DataPanel];
/** Panels with no scope beyond the one connection. Derived from {@link PANEL_SCOPE}. */
export type GlobalPanel = {
  [P in DataPanel]: (typeof PANEL_SCOPE)[P] extends 'global' ? P : never;
}[DataPanel];

/** `panel.data` variants that carry an explicit routing/scope key. */
export type ScopedPanelDataMessage =
  | {
      [P in SessionScopedPanel]: { type: 'panel.data'; panel: P; data: PanelDataMap[P]; sessionId: string };
    }[SessionScopedPanel]
  | {
      [P in RootScopedPanel]: { type: 'panel.data'; panel: P; data: PanelDataMap[P]; rootId: string };
    }[RootScopedPanel]
  | {
      [P in CwdScopedPanel]: { type: 'panel.data'; panel: P; data: PanelDataMap[P]; cwd: string };
    }[CwdScopedPanel];

/** `panel.data` variants with no scope key — global to the connection. */
export type GlobalPanelDataMessage = {
  [P in GlobalPanel]: { type: 'panel.data'; panel: P; data: PanelDataMap[P] };
}[GlobalPanel];

/**
 * The full `panel.data` message union — every {@link HostToWebview} `panel.data`
 * variant, each already carrying its required scope key (or none, for a
 * {@link GlobalPanel}). This IS the `panel.data` member of {@link HostToWebview}
 * (see there) — construct instances only via {@link makePanelData}.
 */
export type PanelDataMessage = ScopedPanelDataMessage | GlobalPanelDataMessage;

/**
 * The ONLY constructor for a `panel.data` message (W4 §7 B2). Each overload
 * pins the scope argument's shape to its panel's real scope, so a call
 * naming the wrong scope key — or omitting a required one — fails to
 * typecheck. This is what let the three unchecked `as HostToWebview`
 * construction-site casts (`webview/src/mock/MockBackend.ts:105`,
 * `src/host/backend/AcpBackend.ts:1270`, `src/host/backend/MockBackend.ts:133`
 * as of the S0 wire break) be deleted: every caller is now checked, not
 * merely coerced.
 */
export function makePanelData<P extends SessionScopedPanel>(
  panel: P,
  data: PanelDataMap[P],
  scope: { sessionId: string },
): Extract<PanelDataMessage, { panel: P }>;
export function makePanelData<P extends RootScopedPanel>(
  panel: P,
  data: PanelDataMap[P],
  scope: { rootId: string },
): Extract<PanelDataMessage, { panel: P }>;
export function makePanelData<P extends CwdScopedPanel>(
  panel: P,
  data: PanelDataMap[P],
  scope: { cwd: string },
): Extract<PanelDataMessage, { panel: P }>;
export function makePanelData<P extends GlobalPanel>(
  panel: P,
  data: PanelDataMap[P],
): Extract<PanelDataMessage, { panel: P }>;
export function makePanelData(
  panel: DataPanel,
  data: PanelDataMap[DataPanel],
  scope?: { sessionId: string } | { rootId: string } | { cwd: string },
): PanelDataMessage {
  // Implementation-only assertion. TypeScript cannot correlate a generic
  // function's PARAMETERS the way it correlates object PROPERTIES (the same
  // limitation `PanelDataMessage`'s own mapped-index trick exists to work
  // around when READING) — inside one shared function body it cannot prove
  // `data`/`scope` line up with `panel` for an arbitrary caller. The four
  // overload signatures above are what make every CALL SITE checked: a call
  // naming the wrong scope key (or dropping a required one) fails to
  // typecheck against them, which is the actual safety property the wire
  // break needs. This single, centralized, reviewed assertion replaces the
  // three unchecked casts it deletes — never add another `as HostToWebview`
  // at a construction site; route it through this function instead.
  return { type: 'panel.data', panel, data, ...(scope ?? {}) } as PanelDataMessage;
}

/**
 * W6-FE Part 3 (3-way ARCH I-3b): extracts the members of a
 * {@link HostToWebview}-shaped union that carry a REQUIRED `sessionId:
 * string` — i.e. exactly the messages a per-session actor
 * (`SessionController`) is allowed to emit. A bare distributive conditional
 * type over a naked type parameter (the documented `Filter<T, U>` idiom —
 * TypeScript handbook, "Filtering Union Types using Conditional Types"):
 * instantiated with a union, it distributes per-member, so
 * `SessionScoped<HostToWebview>` is exactly the session-tagged subset —
 * `system.error`/`theme`/`tab.error`/the non-`subagents` `panel.data`
 * variants (no `sessionId`) are excluded; `commands.available`/`error`/
 * `turn.end`/... (a required `sessionId`) are included.
 */
export type SessionScoped<T> = T extends { sessionId: string } ? T : never;

/**
 * {@link SessionScoped} applied to the full {@link HostToWebview} union — the
 * type `SessionHostPort.emit` is constrained to (`src/host/backend/session/
 * types.ts`), so a `SessionController` can never emit an unscoped/global
 * message that would bleed across tabs (P-1).
 */
export type SessionScopedMessage = SessionScoped<HostToWebview>;

/* ------------------------------------------------------------------ *
 * WEBVIEW -> HOST
 * ------------------------------------------------------------------ */

/** A user-supplied attachment (upload), distinct from an @-mention (reference). */
export interface Attachment {
  id: string;
  name: string;
  kind: 'file' | 'image' | 'pdf';
  mime?: string;
  /** data: URI for images/pasted bytes. */
  dataUri?: string;
  /** Workspace path for file references dragged from the explorer. */
  path?: string;
}

/**
 * The CLOSED set of control-plane method names the webview may invoke via
 * `control.invoke` / `control.request`. THIS ONE `as const` array is the single
 * source of truth (finding A#2): the {@link ControlMethod} union is derived from
 * it (`(typeof CONTROL_METHODS)[number]`), and the host's RUNTIME allowlist
 * (`AcpBackend`'s `ALLOWED_CONTROL_METHODS`) is built from the SAME array — so a
 * method added to (or removed from) the contract can never silently drift out of
 * the runtime guard. Previously the union and the Set were two hand-maintained
 * lists that guarded drift only on DELETION (a name added to the union but
 * forgotten in the Set compiled, then was silently rejected at runtime).
 *
 * PRUNED to the live surface (finding Sec-M1): nine names that NO panel ever
 * sends — `tools.show`, `toolsets.list`, `delegation.status`, `delegation.pause`,
 * `subagent.interrupt`, `spawn_tree.list`, `agents.list`, `model.disconnect`,
 * `config.get` — were REMOVED so a compromised/XSS'd webview can no longer name
 * them at the boundary (`delegation.*`/`spawn_tree`/`subagent.*` addressed a
 * SEPARATE tui_gateway control-plane process anyway). The MCP-hub join still
 * READS `config.get`/`tools.list`, but via a host-internal `control.dispatch`
 * that BYPASSES this allowlist (not webview-nameable), so pruning the names here
 * does not affect it — see `research-security-hardening.md` and the
 * `PanelSourceContext.dispatch` note.
 *
 * `skills.toggle`/`toolsets.toggle` are NOT tui_gateway: they route to the
 * dashboard REST surface (`PUT /api/skills/toggle`, `PUT /api/tools/toolsets/
 * {name}`) via `AcpBackend`'s special-case, over the CORRELATED `control.request`
 * path so the panel learns success/failure for optimistic write-through with
 * rollback. `checkpoint.restore`/`checkpoint.redo`/`checkpoint.redoAll` are the
 * extension-side `CheckpointTracker` actions, and `session.list`/`session.load`
 * are ACP-channel-only — all five are host special-cases in `invokeControl`,
 * not generic tui_gateway dispatches.
 * Hermes' own `rollback.*` / `session.usage` / `session.compress` were kept OUT:
 * session-coupled, they would 404 or trip the two-channel double-write race the
 * topology forbids.
 */
export const CONTROL_METHODS = [
  // Tools / toolsets (list read + configure; single-RPC list also dispatched
  // host-internally by the Tools/MCP panel sources, which bypass the allowlist).
  'tools.list',
  'tools.configure',
  // MCP — the panel's Reload action (correlated so its result surfaces).
  'reload.mcp',
  // Skills — tui_gateway list/reload …
  'skills.manage',
  'skills.reload',
  // … and the REAL W1.5 dashboard-routed toggles (loopback REST, not tui_gateway).
  'skills.toggle',
  'toolsets.toggle',
  // Checkpoints panel action — extension-side `CheckpointTracker.restore()`.
  'checkpoint.restore',
  // W2-F2 Phase 1 — anchored redo: `CheckpointTracker.redo()` / `.redoAll()`.
  // Same family as `checkpoint.restore` (correlated `control.request`, params
  // `{force?}`, result rides back as `CheckpointRestoreResult`) — `redo` steps
  // the cursor one stored row toward the anchor, `redoAll` restores the anchor
  // itself. Both are refused host-side while a turn is live (P3 interlock,
  // `AcpBackend`'s `liveTurnId` guard — shared with `checkpoint.restore`).
  'checkpoint.redo',
  'checkpoint.redoAll',
  // Models / providers.
  'model.options',
  'model.save_key',
  // Config / settings.
  'config.set',
  'config.show',
  // History (Zone HIST) — ACP-channel-only: `session.list` (pagination "load
  // more", `{cursor}`) and `session.load` (row click, `{sessionId, cwd}`).
  'session.list',
  'session.load',
  // W2 F-M: the file/folder submenu behind the `@`-mention picker,
  // `{query, maxResults?}`. Implemented as another `invokeControl`
  // special-case (the `checkpoint.*` pattern) over `vscode.workspace.
  // findFiles` — workspace-confined by construction, default excludes,
  // `maxResults` clamped ≤ 200, `query` a plain substring (never a
  // user-supplied glob), results filtered through `isSecretForCompletion`
  // (no free secret-path enumeration for a compromised webview). See §2e.
  'context.searchFiles',
  // T1 — MCP admin + Nous catalog surface (add/remove/test/enable/auth over
  // the dashboard REST channel; §4.2 of the MCP/skills architecture brief).
  'mcp.add',
  'mcp.remove',
  'mcp.test',
  'mcp.setEnabled',
  'mcp.auth',
  'mcp.catalog',
  'mcp.catalogInstall',
  // T2 — skills admin + Hub surface (create/preview/scan/install/uninstall
  // over the dashboard REST channel; §5.2 of the MCP/skills architecture
  // brief). Additions only — the pre-existing `skills.toggle` above is
  // untouched.
  'skills.create',
  'skills.hubPreview',
  'skills.hubScan',
  'skills.hubInstall',
  'skills.hubUninstall',
] as const;

/** A control-plane RPC name the webview may invoke. Derived from {@link CONTROL_METHODS}. */
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/* ------------------------------------------------------------------ *
 * Control-plane request/response correlation (Zone Z2, Part A2)
 * ------------------------------------------------------------------ *
 * The webview's control invocations come in two flavours over the SAME
 * host<->webview bridge:
 *  - FIRE-AND-FORGET ({@link WebviewToHost} `control.invoke`): result-less
 *    actions whose effect is observed only through a server-initiated
 *    `panel.data` PUSH (e.g. `tools.configure`).
 *  - CORRELATED REQUEST/RESPONSE ({@link WebviewToHost} `control.request` ->
 *    {@link HostToWebview} `control.response`): invocations that need a direct
 *    return value — a panel data fetch (so the panel can render Loading /
 *    Error+Retry honestly), `checkpoint.restore` (so the panel learns the
 *    dirty-worktree-guard outcome), and the write-confirming actions
 *    `config.set` (D3/N13: confirm/rollback on reject), `reload.mcp`, and the
 *    `toolsets.toggle`/`skills.toggle` switches. Each request carries a monotonic
 *    `requestId`; the host echoes it on the response so the webview resolves
 *    the exact pending promise. This is the minimal in-house form of TypeFox
 *    `vscode-messenger`'s `RequestType<P,R>` (`sendRequest`/`onRequest`,
 *    correlated by an internal msgId) — no dependency, one narrow RPC surface.
 *
 * The `panel.data` PUSH path is unchanged and independent: server-initiated
 * refreshes (subagents live fold, post-snapshot checkpoint refresh, a
 * confirmed `reload.mcp`) still push without any request. */

/**
 * Task 8 (§6): the Setup panel's own correlated control-request methods.
 * ALL host special-cases — like `'nextEdit.toggle'` above, NONE of these are
 * forwarded to tui_gateway (`AgentBackend.invokeControl` dispatches each by
 * name, same pattern as `checkpoint.restore`/`session.list`). Every method is
 * correlated (`control.request`) and resolves `{ok:true}` on success or
 * `{ok:false; reason}` on a fail-closed refusal (e.g. `trusted:false`, a
 * validation failure, an in-flight install/pull already running for that id).
 *
 * `setup.setNextEdit` writes the NEXT card's DEDICATED connection
 * (`{backend, endpoint, model}`, Tier-1) — the source on/off/mode flips
 * themselves keep riding the EXISTING `'nextEdit.toggle'` correlated method
 * (post-Task-2 it writes `talaria.nextEdit.source`), NOT this one.
 * `setup.setRag` writes `{enabled|embedEndpoint|embedModel|indexDir}`
 * (Tier-1). `setup.setTunable` writes one `{key, value}` pair from the
 * Tier-2 tunables ALLOWLIST only (D9) — host-validated, never an arbitrary
 * config write.
 *
 * Task 11 (T11 MUST-CLOSE host gaps, plan §6): `setup.reload` reloads the
 * extension host window — trust-gated (FM-14) but MODAL-FREE (it writes no
 * settings and spawns nothing, so it follows the Tier-2 `setup.setTunable`
 * posture: gated, no confirmation dialog). `setup.openBootstrapTerminal`
 * opens a terminal pre-typed with a HOST-resolved install line — Tier-1 (a
 * terminal-opening action, §8), modal-gated like `setup.openInstallTerminal`
 * but with no registry `backendId` (pipx itself isn't a registry entry).
 * beta.5 T5 (§1.2): it takes `{target?: 'pipx' | 'python'}` (absent =
 * `'pipx'`, strictly validated host-side) and resolves the command from the
 * OS-detection engine for the DETECTED distro family — refused fail-closed
 * (`{ok:false}`, no modal, no terminal) when the engine has no verified
 * line (unknown distro, container degrade, or a guidance-only Python plan).
 *
 * TE-4 (AU-11, INV-15): a `const` array — same `as const` inversion {@link
 * CONTROL_METHODS} already got (finding A#2) — so {@link SetupMethod} and the
 * runtime boundary allowlist ({@link KNOWN_REQUEST_METHODS}) are BOTH derived
 * from this ONE source and can never drift against each other.
 */
export const SETUP_METHODS = [
  'setup.status',
  'setup.install',
  'setup.applyAgent',
  'setup.applyFim',
  'setup.setApiKey',
  'setup.testRemote',
  'setup.pullModel',
  // beta.6 T7 (§1.3/§2.5): catalog-id provisioning — the ONE place a verified
  // catalog model gets pulled/downloaded/ingested. The webview sends
  // `{modelId, backend, endpoint?}`; the host re-resolves EVERYTHING from
  // `MODEL_CATALOG` (unknown id ⇒ refuse; 'vllm' ⇒ refused, never ignored).
  'setup.provisionModel',
  // beta.6 T8 (§1.3/§2.5): saves (or, `{clear:true}`, unsets) the "Configure
  // Local Agent Model" block's selection — `{modelId, backend, endpoint}`
  // (`modelId` must be a role='agent' catalog row) writes the 3
  // `talaria.agent.localModel.*` settings Global; `status()` recomposes
  // `agentLocalModel.saved`/`providerGuidance` from them on every read.
  'setup.saveAgentModel',
  'setup.cancel',
  'setup.openProviderWizard',
  'setup.openInstallTerminal',
  'setup.openBootstrapTerminal',
  'setup.recheck',
  'setup.reload',
  // beta.7 B3: re-advertise auth methods after `hermes model` — Hermes
  // builds them only inside `initialize()`, acp_adapter/server.py:875.
  'setup.reconnectAgent',
  'setup.setNextEdit',
  'setup.setRag',
  'setup.setTunable',
] as const;

/** A Setup-panel control-request method. Derived from {@link SETUP_METHODS}. */
export type SetupMethod = (typeof SETUP_METHODS)[number];

/**
 * Method a correlated {@link WebviewToHost} `control.request` may invoke. It is
 * the full {@link ControlMethod} set plus the host-internal `'panel.data'`
 * panel-refresh signal (which {@link AgentBackend.invokeControl} already
 * special-cases) — used by the webview to fetch a panel's snapshot AND learn
 * success/failure of that fetch — plus `'nextEdit.toggle'` and, as of Task 8,
 * the full {@link SetupMethod} set (see that type's doc for why none of these
 * additions are tui_gateway-forwarded).
 */
export type ControlRequestMethod = ControlMethod | 'panel.data' | 'nextEdit.toggle' | SetupMethod;

/**
 * TE-4 (AU-11, INV-15): the CLOSED set of every method name a `control.request`
 * may legitimately carry — the boundary allowlist `TalariaViewProvider
 * .handleControlRequest` checks FIRST, before any dispatch. DERIVED from the
 * same `as const` arrays {@link ControlMethod}/{@link SetupMethod} come from
 * (never a second hand-maintained list — the exact drift this closes: before
 * this Set existed, the gate lived ONLY inside `ControlDispatcher`
 * (`AcpBackend`'s path), so a name that slipped past `isSetupMethod`'s bare
 * prefix check, or reached `MockBackend` directly, was never checked at all).
 * `'panel.data'` / `'nextEdit.toggle'` / `'context.searchFiles'` are the three
 * provider-level special-cases {@link ControlRequestMethod} already carries
 * outside {@link ControlMethod}/{@link SetupMethod} — enumerated here so the
 * allowlist covers the FULL wire type, not just the two backing arrays.
 */
export const KNOWN_REQUEST_METHODS: ReadonlySet<string> = new Set<ControlRequestMethod>([
  ...CONTROL_METHODS,
  ...SETUP_METHODS,
  'panel.data',
  'nextEdit.toggle',
  'context.searchFiles',
]);

/**
 * W5.1 R5 (Task 13): which of the two mutually-exclusive next-edit sources a
 * `nextEdit.toggle` request targets. `next` = the dedicated model; `generic`
 * = the reuse path over the user's own FIM model/endpoint.
 */
export type NextEditToggleSource = 'next' | 'generic';

/**
 * W5.1 R5: the ratified on/off state of both next-edit sources — the payload
 * of the `nextEdit.state` push and the resolved value of an ACCEPTED
 * `nextEdit.toggle` request.
 *
 * Structurally identical to (and freely assignable from) the Guard's own
 * `ToggleState` (`src/autocomplete/nextedit/mode.ts`). Declared here rather
 * than imported so this shared, webview-bundled contract keeps its zero
 * dependency on the autocomplete tree; TypeScript's structural typing makes
 * the two interchangeable at the host wiring seam without a cast.
 *
 * INVARIANT (R5): never both `true`. The Guard refuses the second source and
 * sanitizes a hand-edited both-on store at hydrate, so no producer of this
 * type can emit the illegal state.
 */
export interface NextEditToggleState {
  next: boolean;
  generic: boolean;
}

/**
 * Result envelope of a correlated control invocation, echoed back on
 * {@link HostToWebview} `control.response`. `ok:true` carries the resolved
 * value of `AgentBackend.invokeControl` (RAW RPC result — panel DATA still
 * arrives via the `panel.data` push, per that method's contract); `ok:false`
 * carries the rejection message so the requester can reject its pending
 * promise (and, for panels, render an Error+Retry state).
 *
 * `instanceId` (AU-9/INV-13, TE-2): the requesting page instance's id,
 * echoed back VERBATIM from the {@link WebviewToHost} `control.request` that
 * carried it — lets `RpcClient.handleResponse` drop a stale response from a
 * PRIOR webview instance (reload/re-create) instead of resolving a
 * same-`requestId` pending request a fresh instance's `seq` counter happens
 * to have reused. OPTIONAL (unlike the request's own required `instanceId`)
 * so an older/defensive producer of this envelope (e.g. the standalone
 * `MockBackend`, which never echoes one) is still a valid, TRUSTED response —
 * additive, same-vsix-lockstep wire field, no compat shim needed.
 */
export type ControlResponse =
  | { ok: true; result: unknown; instanceId?: string }
  | { ok: false; error: { message: string }; instanceId?: string };

/**
 * Result payload of a `checkpoint.restore` correlated request (Zone CKPT).
 * Mirrors the host-side `RestoreResult` (`CheckpointTracker.ts`) — the shared
 * shape both sides agree on now that the bespoke `checkpoint.restoreResult`
 * PUSH is gone (migrated onto request/response). `restored:false` means the
 * dirty-worktree guard refused; the panel must surface `reason` and offer an
 * explicit "Restore anyway" that re-requests with `{ force: true }` rather
 * than silently retrying.
 *
 * `skippedPaths` (Zone Z9 deferral #3): files the restore REFUSED to write or
 * delete because their real (symlink-resolved) location escaped the workspace
 * root (host review S-M1). Present only when non-empty — the restore still
 * `restored:true` for every other file, but these specific paths were left
 * untouched, so the webview can warn that they were not rolled back. Populated
 * host-side straight off the tracker's `RestoreResult.skippedPaths`.
 */
export type CheckpointRestoreResult =
  | { restored: true; filesChanged: number; changedPaths: string[]; skippedPaths?: string[] }
  | { restored: false; reason: string };

/**
 * Messages the webview sends to the extension host. Discriminated on `type`.
 */
export type WebviewToHost =
  /**
   * Webview finished loading and is ready to receive `hydrate`.
   * Origin: webview lifecycle.
   */
  | { type: 'ready' }

  /**
   * Submit a user prompt (start a turn). `attachments` carries any uploaded
   * files/images/pdfs from the composer chip row (distinct from `@`-mentions,
   * which are inline text tokens). `mentions` (W2 F-M, additive/optional)
   * carries the structured `@`-mention refs typed at the composer; the host
   * resolves each one (workspace-confined, secret-gated) and maps it onto the
   * outbound ACP content blocks alongside `attachments` — see §2a.
   * Origin → ACP `session/prompt` / TUI `prompt.submit`.
   */
  | {
      type: 'prompt';
      sessionId: string;
      text: string;
      mode: AgentMode;
      attachments?: Attachment[];
      mentions?: ContextRef[];
    }

  /**
   * W2 F-D: open the read-only editor diff preview for a PENDING edit
   * approval (the `talaria-diff:` virtual-document scheme). Origin: §2e.
   * W4-T3b (T1b carry — Q-9/R7, resolves the S0 TODO): carries `sessionId`
   * — `EditPreviewRegistry` is now keyed `(sessionId, toolCallId)` (a single
   * shared instance across every session's port), so disambiguating a
   * `toolId` collision across concurrent tabs needs it on the wire too.
   */
  | { type: 'diff.open'; sessionId: string; toolId: string; path: string }

  /**
   * Restart the WHOLE connection (every tab's live turn ends). W3-T6
   * (CF-11/D2): the composer's "New Session" button no longer sends this — it
   * posts the per-tab `tab.newSession` above instead. This message is now
   * reachable only via the `talaria.newSession` palette command (relabeled
   * "Restart Agent Connection" in package.json for the same reason), kept for
   * that connection-level affordance and back-compat.
   */
  | { type: 'newSession' }

  /**
   * F11: request the host re-assign `webview.html` — the documented recovery
   * for the `ErrorBoundary` fallback's "Reload" button. A bare
   * `window.location.reload()` inside a VS Code webview iframe is an
   * unverified recovery path — VS Code's webview docs give no guarantee it
   * re-navigates the iframe rather than the surrounding editor chrome, and
   * this repo has no test/observation confirming it works — so the host
   * driving the recovery itself (re-issuing the HTML document) is the
   * reliable, provable way to re-mount the React tree. Whole-webview
   * lifecycle action, no `sessionId` (same posture as `ready`/`newSession`).
   * Origin: `ErrorBoundary.reload`.
   */
  | { type: 'reload' }

  /**
   * Cancel the in-flight turn.
   * Origin → ACP `session/cancel` / TUI `session.interrupt`.
   */
  | { type: 'cancel'; sessionId: string }

  /**
   * Answer a pending approval request.
   * Origin → ACP `session/request_permission` response / TUI `approval.respond`.
   */
  | { type: 'approval.respond'; sessionId: string; id: string; optionId: string }

  /**
   * Accept or reject a single diff hunk on an edit tool card.
   * Origin → ACP edit-approval response (`edit_approval.py`).
   */
  | {
      type: 'diff.resolve';
      sessionId: string;
      toolId: string;
      hunkIndex: number;
      action: 'accept' | 'reject';
    }

  /**
   * Switch the active model.
   * Origin → ACP `session/set_model` / TUI `config.set key=model`.
   */
  | { type: 'setModel'; sessionId: string; modelId: string }

  /**
   * CF-13/D1: the Models panel's "Add key" affordance. Carries ONLY the
   * provider `slug` (the same field `ModelProvider.id` is reshaped from,
   * see `reshapeModelOptions` — the harness's `model.save_key` param) — the
   * API key itself is a SECRET and NEVER crosses this boundary: the host
   * prompts for it directly (`showInputBox({password:true})`) and dispatches
   * `model.save_key({slug, api_key})` on the control channel. The harness
   * PERSISTS the key to `~/.hermes/.env` (it authenticates to the provider,
   * not the extension) — Talaria stores nothing and never re-asserts it.
   */
  | { type: 'model.addKey'; slug: string }

  // P7-N10: the legacy `{ type: 'setMode'; mode: AgentMode }` wire message
  // was YAGNI-deleted from this union — a sessionId-less fan-out that
  // mutated EVERY live session, never actually sent by the webview (presets
  // replaced wire modes) and safe only because its one host-side caller
  // hardcoded 'default'. The user-facing mode picker is a completely
  // different, sessionId-scoped message (`mode.set`, further below in this
  // union) and is unaffected.

  /**
   * W2-F1: switch the client-side edit-policy preset (Manual/Normal/Strict/
   * Plan). Purely client-side — never changes the ACP wire mode, which stays
   * pinned at 'default'. Host answers with a `policy.state` push.
   */
  | { type: 'policy.setPreset'; sessionId: string; preset: EditPolicyPreset }

  /**
   * Change the visible side panel (webview-local; also lets the host lazily
   * fetch that panel's data). Renamed from `switchTab` (W4): from this wave
   * on "tab" means a chat-session tab only — this switches a PANEL.
   */
  | { type: 'switchPanel'; panel: Panel }

  /**
   * W4 §2d: open a fresh chat-session tab. Host: `session/new` → replies
   * with `tab.bound` (success) or `tab.error{kind:'open-failed'}` (§7 B8 —
   * every open gets a terminal reply, never a silently-forever-disabled
   * composer).
   */
  | { type: 'tab.open'; tabId: string }

  /**
   * W4 §2d: close a chat-session tab. `sessionId` is absent for a still-
   * unbound tab (no session was ever minted for it).
   */
  | { type: 'tab.close'; tabId: string; sessionId?: string }

  /**
   * W4 §2d: the webview activated this tab (panels re-scope their data —
   * §2f). `sessionId` is absent for a still-unbound tab.
   */
  | { type: 'tab.activate'; tabId: string; sessionId?: string }

  /**
   * W3-T6 (CF-11/D2): the composer's per-tab "New Session" — mints a FRESH
   * session bound to THIS tab, ending only this tab's own live turn, leaving
   * every sibling tab's live turn untouched. Replaces `newSession` (below) as
   * the composer's own affordance — that legacy connection-global message now
   * backs ONLY the `talaria.newSession` palette command's full restart (every
   * tab's turn ends). Host: `AcpBackend.newSessionInTab`, tail-serialized via
   * the SAME `runOnStartTail` queue every other topology mutation uses.
   * `sessionId` mirrors the tab's CURRENT binding at post time — a hint only;
   * the host always re-reads the tab's ACTUAL occupant (`getByTabId`), never
   * trusts this field for identity (the tab may have rebound again by the
   * time this reaches the head of the tail).
   *
   * MIN-C (3-lens review, arch M-1 — DOCUMENTED, not fixed; a future change
   * with its own review): the host's `newSessionInTabInternal` mints the
   * fresh session via `openSession`, which unconditionally adopts the result
   * onto `AcpBackend`'s CONNECTION-GLOBAL `activeSessionId`/`cwd` (the same
   * adoption `openTabInternal` already relies on for the composer's "+"
   * button). That is harmless today because the ONLY caller of this message
   * is the composer acting on `tabId === state.activeTabId` — the tab this
   * message names is always ALREADY the connection's active tab, so the
   * adoption is a no-op observationally. It would stop being harmless the
   * moment a caller ever posts this for a BACKGROUND (non-active) tab: the
   * connection-global active session/cwd would silently hijack to that
   * tab's fresh session, out from under whichever tab the user is actually
   * looking at. Nothing today constructs that caller — this note exists so
   * a FUTURE one doesn't ship the hijack by accident.
   */
  | { type: 'tab.newSession'; tabId: string; sessionId?: string }

  /**
   * W4 §2d: load a History session INTO a tab (the History panel's row
   * click, generalized from the old single-session `session.load`). Host
   * announces `tab.bound` BEFORE replaying (§7 B9 race rule (b)), then
   * streams the replay through the normal pipeline.
   *
   * B1: `title` is display-only — the row's title (or its own
   * "Untitled session" fallback), echoed back on `tab.bound` so the tab
   * chip can show it. The host never interpolates it anywhere else.
   */
  | { type: 'tab.load'; tabId: string; sessionId: string; cwd: string; title?: string }

  /**
   * SF-2: switch (or clear, `null`) the session's active custom mode. Host
   * answers with an authoritative `mode.state` push. Origin: §4.
   */
  | { type: 'mode.set'; sessionId: string; modeId: string | null }

  /**
   * FIRE-AND-FORGET passthrough to the control channel — invoke any tui_gateway
   * RPC whose result the webview does not await (its effect surfaces via a
   * `panel.data` push). Origin → tui_gateway `dispatch()` (`server.py:1161`).
   */
  | { type: 'control.invoke'; method: ControlMethod; params?: Record<string, unknown> }

  /**
   * CORRELATED control invocation (Part A2). The host runs
   * `AgentBackend.invokeControl(method, params)` and echoes `requestId` back on
   * a {@link HostToWebview} `control.response` (`ok:true`+`result` or
   * `ok:false`+`error`). Used where the webview needs the return value: a panel
   * data fetch (drives Loading/Error+Retry) and `checkpoint.restore` (learns
   * the dirty-worktree-guard outcome). `requestId` is monotonic per webview
   * session.
   *
   * `instanceId` (AU-9/INV-13, TE-2): the issuing page instance's id (minted
   * once per webview (re)creation — see `bridge.ts`). The host echoes it back
   * verbatim on the `control.response`, and `RpcClient.handleResponse` uses
   * it to drop a late reply from a PRIOR, now-disposed page instance rather
   * than let it resolve an unrelated pending request a fresh instance's own
   * `requestId` counter happens to have reused.
   */
  | {
      type: 'control.request';
      requestId: number;
      method: ControlRequestMethod;
      params?: Record<string, unknown>;
      instanceId: string;
    };

/* ------------------------------------------------------------------ *
 * Compatibility aliases
 * ------------------------------------------------------------------ *
 * The host (Agent A) imports the `...Message` spellings and a named
 * `DiffAction`; these aliases keep both naming conventions valid against the
 * single source of truth above. Prefer `HostToWebview` / `WebviewToHost` in new
 * code. */

/** Alias for {@link HostToWebview} (host-side import name). */
export type HostToWebviewMessage = HostToWebview;
/** Alias for {@link WebviewToHost} (host-side import name). */
export type WebviewToHostMessage = WebviewToHost;
/** Diff-hunk resolution action carried by `diff.resolve`. */
export type DiffAction = 'accept' | 'reject';
