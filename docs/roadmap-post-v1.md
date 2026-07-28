# Talaria Code — Post-v1 Roadmap («как / что / куда / зачем»)

**Status:** planning doc for everything AFTER the v1 core. Not a start signal. Companion to `all-in-build-reference.md` (architecture) and `specs/wave-1.md` (what v1 built). Grounded in the neighbor feature-map (Cline/Roo/Kilo/Continue/Refact/ACP-client), the 3 review reports, and §05 Language Intelligence Bridge.

## 0. Baseline — what v1 already shipped
Core is built, green (259/259), hardening + packaging in flight:
- **Chat (ACP):** streaming + reasoning + tool cards + per-hunk diffs + approvals + model picker + modes + image input.
- **Autocomplete (FIM):** own `InlineCompletionItemProvider` + pluggable backend (Ollama/llama.cpp/vLLM/Codestral).
- **RAG engine (built):** tree-sitter chunker + `/v1/embeddings` + LanceDB hybrid + stdio MCP `codebase_search`.
- **Control transport (tui_gateway):** `ControlChannel` (spawn + `gateway.ready` + dispatch + events).
- **Rails:** backend swap (`talaria.backend` mock↔acp), Workspace-Trust hardening, per-platform packaging.

**Channel legend:** **ACP** = Hermes already streams it, just render · **tui_gw** = control-plane RPC · **BUILD** = our work on VS Code APIs · **ENGINE** = needs a model/index backend.

**The "зачем" of post-v1 in one line:** v1 = *complete core, not a shallow wrapper*. Post-v1 = *breadth + depth + one real differentiator (LIB)* — fill the neighbor feature-map and go past it, in **leverage order** (cheapest-highest-value first).

---

## Wave 1 — GO-LIVE: light up what's already wired  ⭐ highest leverage
**Зачем:** the transport + RAG engine exist but are "dark". This wave makes them actually work — mostly "draw it well" + ONE typed seam, unlocking ~6 Layer-2 features at once.
| # | What | Where | How |
|---|---|---|---|
| 1.1 | **Register `codebase_search` with Hermes** (it's built + tested but never registered → RAG is dark) | ENGINE/BUILD | ACP `session/new mcpServers` + tui `reload.mcp`; wire the `mcpServerSpec` already built in `extension.ts` |
| 1.2 | **Typed panel-data reshaping** (`invokeControl` raw tui result → `PanelDataMap`) — unblocks ALL tui panels at once | tui_gw/BUILD | a mapping layer per `DataPanel` → the panel's tui `*.list/status` RPC + shape it to the webview contract |
| 1.3 | Checkpoints + restore panel | tui_gw | `rollback.list/restore/diff` |
| 1.4 | Skills / tools management panel | tui_gw | `tools.list/configure`, `skills.manage` |
| 1.5 | MCP-hub (servers + OAuth + toggles) | tui_gw | `reload.mcp` + server config |
| 1.6 | Subagents + delegation tree | tui_gw | `delegation.status` / `spawn_tree.*` |
| 1.7 | Session history + resume panel | tui_gw | `session.list` + ACP resume (explicit ids — NO Kilo-style content-hash kludge) |
**Gate:** live Hermes on Fedora. **Cost:** low (plumbing exists). **Payoff:** biggest — Layer-2 goes 🟡→🟢.

## Wave 2 — NATIVE: first-class VS Code ergonomics
**Зачем:** the things users touch every hour; parity with Cline/Continue on in-editor feel.
| # | What | Where | How |
|---|---|---|---|
| 2.1 | **@-mentions real resolution** (@file/@problems/@terminal/@git) | BUILD | gather context (fs/diagnostics/terminal/git) → inject into the ACP prompt |
| 2.2 | **Code actions + context menu** (fix / explain / improve) | BUILD | `CodeActionProvider` + `editor/context` menu → oneshot ACP turn |
| 2.3 | Commit-message generation | BUILD | SCM input box + ACP oneshot over the staged diff |
| 2.4 | Slash-command palette + autocomplete | ACP/tui_gw | ACP `available_commands` / tui `commands.catalog` |
| 2.5 | Diff-in-editor + CodeLens accept | BUILD | native decorations/CodeLens complementing the webview diffs |
**Cost:** medium. **Payoff:** daily-driver ergonomics.

## Wave 3 — LANGUAGE INTELLIGENCE BRIDGE (§05) — the differentiator  🔬
**Зачем:** give Hermes *structural code semantics* (not terminal text) — language-agnostic, via ONE thin MCP module. Install a new LSP → it works automatically, no changes on our side.
```
Hermes ──MCP──▶ [ our bridge ] ──vscode API──▶ VS Code ──▶ clangd / rust-analyzer / codelldb / shellcheck / …
```
| Phase | What | How | Weight |
|---|---|---|---|
| 3.1 | **Diagnostics + navigation** (go-to-def, refs, hover/types, doc/workspace symbols, call hierarchy) | `vscode.executeDefinitionProvider`/`…ReferenceProvider`/`…HoverProvider`/`…DocumentSymbolProvider`/`…WorkspaceSymbolProvider` + `languages.getDiagnostics()` → MCP tools | easy |
| 3.2 | **Refactors** (rename, code-action apply) | `executeDocumentRenameProvider`/`executeCodeActionProvider` → via diff-approval | medium |
| 3.3 | **Debug (DAP)** | `vscode.debug.*` | heavy |
**Unlocks:** auto-fix-by-diagnostics (Layer-3). **Where:** BUILD (MCP server in host) + tui `reload.mcp`. **Note:** Hermes ships an `agent/lsp/` module — inspect before building. **Runs parallel** to Waves 1–2 (self-contained module).

**User's machine is already LIB-ready (verified from their VS Code profiles):** clangd (C/C++), Pylance + pyrefly + ruff (Python), CodeLLDB (DAP debug, C/C++/Rust), bash-ide + shellcheck, and sonarlint + semgrep + errorlens (diagnostics) are all installed. The bridge routes through VS Code's provider APIs, so it leverages every one of these automatically — **immediate value, zero LSP setup.** New LSPs the user adds later (rust-analyzer, golang.go) are picked up with no change on our side. No competing inline-completion extension is installed anywhere → our autocomplete is the sole inline provider. NB: the user works in **VS Code Profiles** — the extension installs per-profile.

## Wave 4 — MULTI-SESSION + advanced agent UX
**Зачем:** power-user workflows; leverages ACP's clean multi-session (no impedance kludge).
- **Multi-tab / concurrent sessions** — each tab = its own `session/new` (map `tabId→sessionId`) — BUILD (webview).
- **Orchestrator/subagents deep view** — richer than the Wave-1 panel — tui_gw `delegation`.
- **Custom modes with file-scoping** — BUILD.

## Wave 5 — AUTOCOMPLETE v2 / NEXT-EDIT (ENGINE)
**Зачем:** the real autocomplete quality lever.
- **Cross-file context** — llama.cpp `input_extra` / Refact-style "usefulness"-ranked skeletonization (reuse the §12 RAG index).
- **Next-edit / tab-to-jump** — open models: Continue **Instinct** (7B) / Zed **Zeta-2** (Apache-2.0). Needs richer rendering the InlineCompletion API only partly supports.

## Wave 6 — PARALLEL AGENTS / WORKTREES / PR AUTOMATION (BUILD, ambitious)
**Зачем:** top-end differentiator (Refact/Roo territory). Heavy → last.
- Parallel agents in git-worktrees + PR automation.

---

## Cross-cutting track (threads through every wave)
| Item | Why | When |
|---|---|---|
| **Migrate off deprecated ACP SDK** (`@zed-industries/agent-client-protocol` → `@agentclientprotocol/sdk`) | frozen, no future patches; it's the core chat channel | at first live-Fedora validation, before building more on the ACP seam |
| **Integration / contract tests on the seams** (ACP `session/update` mapping, ControlChannel, MCP) | the live-Fedora risk the 254 unit tests can't cover | early + continuous |
| **Per-platform packaging CI** (`vsce package --target <os-arch>`) | LanceDB/tree-sitter are per-OS native | before first shipped `.vsix` |
| **Large-repo RAG scale** (index progress/cancel/timeout, cross-encoder rerank + MMR, Aider-style repo-map tool) | real repos are big | with Wave 1 go-live feedback |
| **Observability** (structured logs, zero telemetry) | debuggability on Fedora | continuous |

## Sequencing rationale (the «зачем» of the order)
1. **Wave 1 first** — cheapest, unlocks the most (transport already exists). Do the moment Hermes runs on Fedora.
2. **Wave 2** — native ergonomics = perceived quality, daily value.
3. **Wave 3 (LIB)** — runs *in parallel*; it's the differentiator + unblocks Layer-3 auto-fix.
4. **Waves 4–6** — power/scale/ambition, bigger cost, later.
5. **Cross-cutting** — ACP-SDK migration + contract tests happen EARLY (stabilize the seam before adding weight); packaging CI before any shipped build.

**Everything post-v1 gates on the same prerequisite:** Hermes installed on Fedora, `hermes acp` live, runner (Ollama/llama.cpp/vLLM) reachable, `codebase_search` registered. Until then it's build-blind + unit-tested; live validation is Fedora.
