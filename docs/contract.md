# Host ↔ Webview Protocol — Contract (Agent D)

The single, typed message contract between the extension host and the webview.
Source of truth: [`src/shared/protocol.ts`](../src/shared/protocol.ts). Mock replay
data: [`src/shared/mockScenario.ts`](../src/shared/mockScenario.ts).

- **Direction** — `H→W` = host to webview, `W→H` = webview to host.
- **Origin** — the Hermes backend surface the host translates to/from:
  `ACP` = Agent Client Protocol (`acp_adapter/`, `server.py`);
  `TUI` = tui_gateway JSON-RPC method / `_emit` event
  (`research/harness/hermes-tui-gateway-methods.md`).
- All messages are discriminated on `type`. Strict TS, no `any`. When the real
  backend is wired (Fedora), this table is the lookup that maps each message to
  its ACP event or tui_gateway call.

---

## Host → Webview (`HostToWebview`)

| `type` | Payload | Dir | Hermes origin |
|---|---|---|---|
| `hydrate` | `{ state: WebviewState }` | H→W | host-side, from persisted `getState()` + backend replay |
| `clear` | `{}` | H→W | ACP `session/new` · TUI `session.create` |
| `turn.start` | `{ turnId, sessionId }` | H→W | ACP `session/prompt` accepted · TUI `message.start` |
| `user` | `{ turnId, text, mode }` | H→W | echo of ACP `session/prompt` · TUI `prompt.submit` |
| `reasoning.start` | `{ turnId, blockId }` | H→W | ACP `agent_thought_chunk` (first) · TUI `reasoning.available` |
| `reasoning.delta` | `{ turnId, blockId, text }` | H→W | ACP `agent_thought_chunk` · TUI `reasoning.delta` / `thinking.delta` |
| `reasoning.end` | `{ turnId, blockId }` | H→W | derived (first non-thought chunk) |
| `message.delta` | `{ turnId, text }` | H→W | ACP `agent_message_chunk` · TUI `message.delta` |
| `message.end` | `{ turnId, text }` | H→W | TUI `message.complete` · end of ACP message stream |
| `tool.start` | `{ turnId, toolId, kind, title, status, rawInput? }` | H→W | ACP `tool_call` · TUI `tool.start` |
| `tool.update` | `{ turnId, toolId, status?, output?, progress? }` | H→W | ACP `tool_call_update` · TUI `tool.generating` / `tool.complete` |
| `tool.diff` | `{ turnId, toolId, path, hunks: DiffHunk[] }` | H→W | ACP `tool_diff_content` (`edit_approval.py`) |
| `approval.request` | `{ turnId, id, kind:'command'\|'edit', title, detail?, toolId?, options: ApprovalOption[], timeoutMs? }` | H→W | ACP `session/request_permission` · TUI `approval.request` |
| `plan.update` | `{ turnId, items: PlanItem[] }` | H→W | ACP `plan` (`AgentPlanUpdate`) |
| `result.summary` | `{ turnId, text?, usage?: UsageInfo }` | H→W | ACP `message.complete` `_meta` · TUI `session.usage` |
| `panel.data` | `{ panel } & data` (see panel table) | H→W | per-panel TUI list RPC (below) |
| `turn.end` | `{ turnId, status:'complete'\|'cancelled'\|'error' }` | H→W | ACP turn-loop end / `session/cancel` |
| `error` | `{ message, detail?, turnId? }` | H→W | ACP error · TUI `error` event |
| `theme` | `{ theme: ThemeInfo }` | H→W | host `window.onDidChangeActiveColorTheme` |

### `panel.data` variants — discriminated on `panel`

| `panel` | `data` type | Hermes origin (TUI RPC) |
|---|---|---|
| `tools` | `ToolsData` | `tools.list` + `toolsets.list` |
| `mcp` | `McpData` | `reload.mcp` snapshot (+ ACP `session/new(mcpServers)`) |
| `skills` | `SkillsData` | `skills.manage` (action `list`) |
| `checkpoints` | `CheckpointsData` | `rollback.list` |
| `subagents` | `SubagentsData` | `delegation.status` + `spawn_tree.list` / `agents.list` |
| `models` | `ModelsData` | `model.options` |
| `settings` | `SettingsData` | `config.show` |

---

## Webview → Host (`WebviewToHost`)

| `type` | Payload | Dir | Hermes origin (host translates to) |
|---|---|---|---|
| `ready` | `{}` | W→H | webview lifecycle (triggers `hydrate`) |
| `prompt` | `{ text, mode }` | W→H | ACP `session/prompt` · TUI `prompt.submit` |
| `cancel` | `{}` | W→H | ACP `session/cancel` · TUI `session.interrupt` |
| `approval.respond` | `{ id, optionId }` | W→H | ACP `session/request_permission` reply · TUI `approval.respond` |
| `diff.resolve` | `{ toolId, hunkIndex, action:'accept'\|'reject' }` | W→H | ACP edit-approval reply (`edit_approval.py`) |
| `setModel` | `{ modelId }` | W→H | ACP `session/set_model` · TUI `config.set key=model` |
| `switchTab` | `{ panel }` | W→H | webview-local; host lazily fetches panel data |
| `control.invoke` | `{ method: ControlMethod, params? }` | W→H | tui_gateway `dispatch()` — thin passthrough |

### `ControlMethod` (tui_gateway RPC names allowed in `control.invoke`)

`tools.list` · `tools.show` · `tools.configure` · `toolsets.list` · `reload.mcp` ·
`skills.manage` · `skills.reload` · `rollback.list` · `rollback.restore` ·
`rollback.diff` · `delegation.status` · `delegation.pause` · `subagent.interrupt` ·
`spawn_tree.list` · `agents.list` · `model.options` · `model.save_key` ·
`model.disconnect` · `config.get` · `config.set` · `config.show` · `session.usage` ·
`session.context_breakdown` · `session.compress`

---

## Key shared shapes

| Type | Definition | Origin |
|---|---|---|
| `ToolKind` | `'read'\|'edit'\|'execute'\|'search'\|'fetch'\|'think'\|'other'` | ACP `ToolCallKind` |
| `ToolStatus` | `'pending'\|'running'\|'done'\|'failed'` | ACP `ToolCallStatus` |
| `DiffHunk` | `{ header: string; lines: { sign:'+'\|'-'\|' '; text: string }[] }` | ACP `tool_diff_content` |
| `ApprovalOption` | `{ id; label; kind:'allow_once'\|'allow_session'\|'allow_always'\|'deny'\|'deny_always' }` | ACP `session/request_permission` |
| `PlanItem` | `{ text: string; status:'done'\|'active'\|'pending' }` | ACP `plan` |
| `Panel` | `'chat'\|'tools'\|'mcp'\|'skills'\|'checkpoints'\|'subagents'\|'models'\|'settings'` | webview tabs |
| `AgentMode` | `'default'\|'accept_edits'\|'dont_ask'` | ACP `session/set_mode` policy |
| `UsageInfo` | `{ inputTokens; outputTokens; totalTokens; costUsd?; durationMs? }` | ACP usage `_meta` / TUI `session.usage` |
| `ThemeInfo` | `{ kind:'light'\|'dark'\|'high-contrast'; accent: string }` | host `ColorThemeKind` |
| `WebviewState` | hydrate snapshot: `sessionId, theme, mode, currentModelId, activePanel, transcript, plan, panelData` | host-persisted |
| `TranscriptItem` | settled chat entry union (`user`/`reasoning`/`message`/`tool`/`approval`/`plan`/`result`) | folded from streaming H→W |

### Panel data shapes (control-plane snapshots)

| Type | Shape (abbrev.) | TUI RPC |
|---|---|---|
| `ToolsData` | `{ toolsets: ToolsetInfo[]; tools: ToolInfo[] }` | `tools.list` / `toolsets.list` |
| `McpData` | `{ servers: McpServer[] }`, status `connected\|running\|error\|disconnected` | `reload.mcp` |
| `SkillsData` | `{ skills: SkillInfo[]; categories: string[] }` | `skills.manage` |
| `CheckpointsData` | `{ checkpoints: Checkpoint[] }` with `id/label/age/timestamp` | `rollback.list` |
| `SubagentsData` | `{ root: SubagentNode; paused; maxConcurrent; maxDepth }`, roles `ROOT/PLANNER/EXECUTOR/REVIEWER` | `delegation.status` / `spawn_tree.list` |
| `ModelsData` | `{ providers: ModelProvider[]; currentModelId }` | `model.options` |
| `SettingsData` | `{ sections: SettingsSection[] }` over the 21 config.yaml sections | `config.show` |

---

## Mock scenario (MockBackend replay)

`mockScenario.ts` exports:

- **`mockTurn: MockStep[]`** — ordered `{ delayMs, msg }` steps for one coding turn.
  The MockBackend sleeps `delayMs` before emitting each `msg`. It pauses after the
  `approval.request` (id = **`mockApprovalId`**) until the webview posts
  `approval.respond`, then replays the remaining steps.
- **`panelData: PanelDataMap`** — realistic snapshot for all 7 panels; the backend
  answers a `switchTab` / `control.invoke` by emitting the matching `panel.data`.
- **`mockTheme: ThemeInfo`** — seed theme for `hydrate`.

**Turn beats:** `turn.start` → `user` (refactor `login()`) → reasoning (2 deltas) →
`read_file` tool (running→done) → assistant prose → `patch` tool + `tool.diff`
(2 hunks) → `plan.update` → `npm test` `tool.start` (pending) + `approval.request`
**[pause]** → tool running → tests pass → `plan.update` → final `message` →
`result.summary` (usage) → `turn.end`.

**Hermes-accurate names:** model `claude-sonnet-5` / `claude-haiku-5` / `claude-opus-5`
(provider `anthropic`); tools `read_file` / `patch` / `terminal` / `web_search`;
MCP servers `github` (connected) / `postgres` (running) / `filesystem` (error).
No `gpt-4o`.
