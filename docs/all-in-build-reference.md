# Hermes VS Code Extension — All-In Build Reference (справочник)

**Status:** REFERENCE for the full "all-in" extension. This is NOT a start signal — do not dispatch build agents until the user explicitly says "go". Consolidates everything discussed so future work is a lookup, not a re-derivation.

**Goal:** a full-featured VS Code extension exposing all editor-relevant Hermes functionality, using REAL logic — ACP (conversation) + tui_gateway (control plane) + REST (remote extras) + native VS Code (editor features). Mock stays as the dev fallback. Grounded in the research under `research/` + `artifacts/` and VS Code best-practices (`docs/best-practices.md`). **Target platform: Fedora/Linux.**

---

## 1. Architecture (the rails — already scaffolded)
```
VS Code extension host (Node/TS)                 webview (React+Vite+Tailwind)
  AgentBackend (swappable via `hermes.backend`)     one typed protocol
    ├─ MockBackend      (default; canned; dev)       (src/shared/protocol.ts,
    ├─ AcpBackend       → spawn `hermes acp`           mirrored in webview)
    └─ ControlChannel   → spawn `python -m tui_gateway.entry`
  + native vscode.* APIs (git SCM, code actions, CodeLens, LSP/DAP)
  + optional `hermes serve` REST (remote-only)
```
- **Backend swap is one line** in `extension.ts`; `MockBackend` proves the whole UI on any OS with no Hermes.
- Design: `--vscode-*` theming + teal accent, codicons only, Priority+ responsive tabs, sidebar-first density, a11y.

## 2. Channels → what each carries
| Channel | Carries | Where |
|---|---|---|
| **ACP** (`hermes acp`) | chat/turn, reasoning, tool cards, diffs, approvals, plan, model/mode pickers, session lifecycle | conversation |
| **tui_gateway** (`python -m tui_gateway.entry`) | ALL control-plane panels' data + actions (128 methods) | panels |
| **REST** (`hermes serve` `/api/*`) | remote-only extras (git when Hermes runs remotely, files) | remote setups |
| **native VS Code** (`vscode.*`) | git (local), code actions, CodeLens, SCM, LSP/DAP bridge | editor features |

## 3. Panels (the 15 from the capability map) — fit + mechanism + phase
| # | Panel | In editor? | Mechanism | Phase | Mock now |
|---|---|---|---|---|---|
| 1 | Chat | ✅ | ACP session/prompt stream | 1 | ✅ |
| 2 | Sessions (history/resume/branch/search) | ✅ | tui `session.list/resume/branch`, FTS5 search | 2 | ❌ (dropdown stub) |
| 3 | Checkpoints | ✅ | tui `rollback.list/restore/diff` | 2 | ✅ |
| 4 | Subagents | ✅ | tui `delegation.status`/`spawn_tree.*` | 2 | ✅ |
| 5 | Tools & Toolsets | ✅ | tui `tools.list/configure`,`toolsets.list` | 2 | ✅ |
| 6 | Skills (+ Curator) | ✅ | tui `skills.manage/reload`; curator via `cli.exec hermes curator` | 2 | ✅ (curator ❌) |
| 7 | MCP | ✅ | tui `reload.mcp` + ACP `session/new(mcpServers)` | 2 | ✅ |
| 8 | Plugins | ✅ | tui `plugins.list/manage` | 2 | ❌ |
| 9 | Memory & Learning | ⚠️ | `memory.provider` config + `learning.frames`/`insights.get` + `/api/memory/*` | 2 | ❌ |
| 10 | Models & Providers | ✅ | tui `model.options/save_key` + ACP `session/set_model` | 2 | ✅ |
| 11 | Settings (21 config sections) | ✅ | tui `config.get/set/show` | 2 | ✅ |
| 12 | Cron | ✅ | tui `cron.manage` | 2 | ❌ |
| 13 | Git review | ✅ | working-tree → **native VS Code Git API** (Axis B); files remote → transparent via Remote-SSH; forge (GitHub/GitLab) → agent's tools/MCP (Axis C). See §13 | 3 | ❌ |
| 14 | Approvals | ✅ | ACP `session/request_permission` (+ tui interactive) | 1 | ✅ (in chat) |
| 15 | Language Intelligence (LSP/DAP) | ⚠️ | **MCP server hosted in the extension** proxying `vscode.execute*Provider` + `vscode.debug.*` → registered with Hermes | 3 | ❌ |

**Mock coverage today: 9 / 15** panels (Chat, Checkpoints, Subagents, Tools, Skills, MCP, Models, Settings, Approvals). Missing: Sessions, Plugins, Memory/Learning, Cron, Git, Language.

## 4. Chat components (in mock)
✅ user msg, reasoning block, tool cards (states), diff card (per-hunk accept/reject), approval card, plan, result summary, composer (attach/mode/model/new-session/@/resize), Priority+ tabs, hero empty-state.
❌ not exercised yet: tool **failed**, result **partial/failed**, **empty** panels, **loading**, **error** banner, approval **deny** branch, slash `/` palette, multi-tab.

## 5. Features borrowed from reference extensions → phase
| Feature | Phase / channel |
|---|---|
| Per-hunk diff accept/reject, tool cards, approval policy, modes, MCP hub, checkpoints, model picker | done (mock) → real via ACP/tui |
| @-mention, attach/paste-image | done (mock) → attach wired to ACP image/pdf in Phase 1 |
| Slash `/` palette | Phase 2 (tui `commands.catalog`/`complete.slash`) |
| Code actions / right-click "Add to / Explain / Fix" | Phase 3 (native `CodeActionProvider`) |
| SCM commit-message generation | Phase 3 (native SCM + ACP oneshot) |
| Diff-in-editor + CodeLens accept | Phase 3 (native decorations/CodeLens) |
| Multi-tab chats | Phase 3 (webview) |
| Debug-terminal → chat | Phase 3 (native terminal API) |
| Autocomplete (FIM ghost-text) | **IN scope** — own `InlineCompletionItemProvider` + pluggable FIM backend (v1: `qwen2.5-coder:1.5b-base` via Ollama). Separate subsystem from ACP. See **§11** |
| Codebase semantic RAG (`codebase_search`) | **IN scope [BUILD]** — extension-hosted hybrid index exposed to Hermes as an **MCP tool** (v1: tree-sitter chunks + Qwen3-Embedding-0.6B + sqlite-vec/FTS5 + RRF). See **§12** |

## 6. Clarified ambiguities (previously vague)
- **Git — three orthogonal axes (files-location / working-tree SCM / forge); see §13.** The repo is the USER'S PROJECT repo. Working tree = native VS Code Git API; forge (GitHub/GitLab) = the agent's `gh`/`glab`/MCP; file location (local vs Remote-SSH vs virtual) handled by VS Code + capability flags. `hermes serve /api/git/*` only for a detached remote-daemon Hermes — NOT the default. (Earlier "git = local SCM, nothing remote" was an over-simplification — it collapsed these three axes.)
- **Language Intelligence (LSP/DAP).** Concrete: the extension host runs a small **MCP server** (localhost stdio/SSE) whose tools proxy `vscode.executeDefinitionProvider`/`executeReferenceProvider`/`executeHoverProvider`/`executeDocumentSymbolProvider`/`executeWorkspaceSymbolProvider`/`prepareCallHierarchy`, `vscode.languages.getDiagnostics()`, `executeDocumentRenameProvider`/`executeCodeActionProvider`, and DAP via `vscode.debug.*`. Register it with Hermes (ACP `session/new(mcpServers)` or tui `reload.mcp`). **Same-machine only.** Phases: diagnostics+nav (S/M) → refactors (M, via diff-approval) → DAP debug (L). NOTE: Hermes ships an `agent/lsp/` module — inspect before building.
- **Embedder / codebase RAG (verified in Hermes source).** Hermes has an **embedding auxiliary task** (`auxiliary.embedding`, `agent/auxiliary_client.py`) and memory-provider vector stores (mem0→faiss/qdrant/chroma) **for MEMORY only**. It has **NO built-in repo/codebase semantic index** — no tree-sitter chunking, no `codebase_search`. Code search is **lexical**: `search_files` (ripgrep) + `session_search` (FTS5). ⇒ Semantic repo RAG is a **BUILD/plugin** decision, not a Hermes capability to surface.

## 7. NOT editor features (drop from scope)
Omni-channel messaging (Telegram/Slack/Discord rendering — Hermes-as-service; editor only gets session continuity), pets/achievements/starmap, billing/credits, observability, batch/mini-SWE runner, trajectory compression. "Единый агент на всех поверхностях" is a *property* (same sessions DB), not a build item.

## 8. Phasing
- **Phase 0 (now, Windows):** polish mock UI; **write `AcpBackend` + `ControlChannel` blind** (pure TS, compiles without Hermes; ground ACP in Context7). Optionally mock the missing 6 panels' *states* for design.
- **Phase 1 (Fedora):** `AcpBackend` live — chat over real `hermes acp`. **Gate: Hermes installed + `hermes acp` works.**
- **Phase 2 (Fedora):** `ControlChannel` live — panels real; ADD the missing panels (Sessions, Plugins, Memory/Learning, Cron, Projects) + slash palette.
- **Phase 3:** native editor — git SCM, code actions, CodeLens diff-in-editor, commit-msg, multi-tab; **LSP/DAP bridge**.
- **Phase 4:** polish (settings, onboarding, errors) + package `.vsix` + install on Fedora.
- **Track E — Autocomplete (parallel, independent of the ACP agent):** own FIM provider; v1 single-line via Ollama `qwen2.5-coder:1.5b-base` → multiline+post-proc → cross-file → pluggable backends+config. See §11.
- **Track R — Semantic RAG (parallel):** extension indexes the repo (tree-sitter + Qwen3-Embedding-0.6B → sqlite-vec/FTS5), exposes `codebase_search` as an MCP tool to Hermes. See §12.

## 9. Gates / prerequisites
- **Hermes installed on Fedora and `hermes acp` runs** (Phase 1 gate). — pending, user will install.
- **Inference runner reachable** (powers autocomplete + RAG): inference runs on a **remote runner node** (Ollama / llama.cpp / vLLM), reached over HTTP at a **configurable endpoint** (`hermes.inference.endpoint`) — NOT local, NOT bundled in the extension. Pull there: `qwen2.5-coder:1.5b-base` (FIM) + `qwen3-embedding:0.6b` (embedder; fallback `nomic-embed-text`). **One node serves both** FIM completion and RAG embeddings. Runner API contracts pinned from source in `research/vscode-hermes/runner-apis-howto.md` (clones under `/Runners`).
- **Topology (corrected): agent stack is LOCAL, only models are REMOTE.** Hermes harness + its tools + its MCP + our extension + our MCP (`codebase_search`) + the vector index + the repo all live on the dev machine. The **single network hop is inference HTTP** (FIM prefix/suffix + embeddings) to the remote runner. No tunnelling — MCP/index/LSP/git are co-located with the local agent.

## 10. Decisions (resolved 2026-07-11)
- **Semantic repo RAG: BUILD IT.** Extension-hosted hybrid index → `codebase_search` MCP tool for Hermes. v1 = tree-sitter chunks + **Qwen3-Embedding-0.6B** (tiny embedder, runs on the remote runner) + a hybrid store behind a **`VectorStore`** interface + **RRF** fusion. **Store: LanceDB (CHOSEN 2026-07-11)** — embedded, no daemon, native ANN + native hybrid, index = a local file next to the MCP reader (Continue's choice). Behind a `VectorStore` interface (alts Qdrant/pgvector/sqlite-vec) if needs change. See §12 + `research/vscode-hermes/semantic-codebase-rag-howto.md`.
- **Topology: agent LOCAL, models REMOTE.** "Remote" = the inference runner/models (configurable endpoint), NOT the agent. Hermes + tools + MCP + index + repo are local → **git = native VS Code SCM (no `hermes serve` REST)**; the only remote call is inference. (Supersedes the earlier "remote-Hermes / git-over-REST" reading.)
- **Autocomplete: IN SCOPE.** Own `InlineCompletionItemProvider` + pluggable FIM backend; v1 = `qwen2.5-coder:1.5b-base` via Ollama. **Not** Tabby-wholesale. See §11 + `research/vscode-hermes/autocomplete-fim-howto.md`.
- **Still open (minor):** Curator surface (inside Skills panel vs separate) — decide during Phase 2.

## 11. Autocomplete (FIM ghost-text) — architecture
Full how-to (grounded, with exact FIM tokens + endpoint bodies): `research/vscode-hermes/autocomplete-fim-howto.md`.

- **What it is:** a fast, small-model **fill-in-the-middle** ghost-text loop — a **separate subsystem from the Hermes ACP agent** (the agent is too slow/agentic for keystroke latency). Native hook: `vscode.languages.registerInlineCompletionItemProvider`.
- **Architecture:** own a **thin `InlineCompletionItemProvider`** over an IDE-agnostic `FimEngine`, with a **pluggable `FimBackend`** (`ollama` | `llamacpp` | `codestral` | `openai-compat` | `tabby`). Do **NOT** adopt TabbyML wholesale — it ships its own `tabby-agent` LSP + client UX + Rust server that duplicate/compete with Hermes's identity; keep Tabby as *one optional backend* pointed at its `POST /v1/completions`. Mirrors Continue.dev's split (core engine + thin VS Code adapter).
- **v1 backend:** `qwen2.5-coder:1.5b-base` (or `3b`) via **Ollama `POST /api/generate`** with `{prompt: prefix, suffix, keep_alive:"30m", stream:true}` — Ollama applies the model's FIM template server-side, so we send **raw** prefix/suffix. `llama.cpp /infill` (`input_extra`) is the cross-file upgrade; Codestral `/v1/fim/completions` is the optional cloud-quality backend.
- **FIM tokens (Qwen2.5-Coder):** `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>` + repo-level `<|repo_name|>`/`<|file_sep|>` for cross-file; send those as **stop tokens**.
- **`InferenceBackend` = 3 real FIM branches (source-grounded, `research/vscode-hermes/runner-apis-howto.md`):** **Ollama** → `/api/generate` (or `/v1/completions`) with `suffix`, server-side FIM template (avoid `raw:true` — it disables suffix-FIM); **llama.cpp** → `/infill` only (`input_prefix`/`input_suffix`; its `/v1/completions` *rejects* `suffix`); **vLLM** → **no server-side FIM** (`suffix` silently ignored, no `/infill`) → we **hand-build** `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>` and POST as plain `prompt` to `/v1/completions` (needs a per-model FIM-token table). Ports: Ollama `11434` / llama.cpp `8080` / vLLM `8000`, auth optional.
- **Tuning defaults (from Continue.dev):** 1024-token prompt budget (prefix ~30% / suffix ~20%), **350 ms debounce**, temp **0.01**, longest-prefix **LRU cache** (cap 1000), single-line-first, bracket-balancing post-process, `CancellationToken → AbortController` single-flight. Latency target **150–300 ms**.
- **v1 slice:** (1.0) single-line, one backend, no cross-file → (1.1) multiline + post-proc → (1.2) cross-file snippets → (1.3) pluggable backends + config + disk cache.
- **Risk:** latency vs quality on CPU-only Fedora. Mitigate: 1.5–3B base, `keep_alive`, debounce, single-flight cancel, hard stop-token enforcement.
- ⚠️ **Harness gotcha:** the local `tabby-*` clone is **Tabby the terminal emulator (Eugeny/tabby.sh)**, NOT TabbyML. The useful local reference is the **Continue.dev** clone (autocomplete mined by `file:line` in the how-to). To use Tabby-as-backend, clone `TabbyML/tabby` (done → `Main Agent(harness)/TabbyML-tabby`; source-grounded notes → `research/vscode-hermes/tabby-source-notes.md`).
- **Tabby backend — source-grounded (supersedes the docs-based §3.6 in the how-to).** Real API: `POST /v1/completions`, port **8080**, `Bearer`, **non-streaming** single JSON `{id, choices:[{index,text}], mode}` (one choice per call). `segments{prefix(req), suffix?, filepath?, git_url?, declarations[], relevant_snippets_from_changed_files[], relevant_snippets_from_recently_opened_files[], clipboard?, edit_history?}`. The checked-in `openapi.json` is **stale (v0.17)** — trust the Rust structs. **Correction:** Tabby's cross-file context is assembled **client-side by `tabby-agent`**, not the server; the server only does repo-RAG (BM25 + binarized embeddings, RRF k=60, one Tantivy index, no vector DB) when `git_url` is set AND the repo is indexed. ⇒ pointing our own thin provider at Tabby's server gains little → **Ollama-direct FIM stays the v1 default; Tabby only for server-managed git-repo indexing or a shared multi-provider endpoint.** `TabbyBackend.capabilities.streaming = false`.

### 11.1 Alternatives considered + upgrade ladder
Five architecture options were weighed; **A won** (it's what §11 describes):
- **A — own thin provider + pluggable local FIM backend** ✅ best: control, Hermes identity, local/offline; B & E slot in as *backends/upgrades*, not replacements.
- **B — adopt a self-hosted engine wholesale** (Tabby server, or Refact's single-binary `refact-lsp` with built-in AST+VecDB RAG) ⚠️ → keep as an *optional backend*, not the whole engine (a 2nd brain competes with Hermes; heavy server).
- **C — fork an OSS engine as a library** (Continue `core/autocomplete`) ⚠️ → borrow ideas, not the codebase.
- **D — don't build; coexist with Twinny / llama.vscode** ❌ → breaks the "one complete extension / Hermes identity" thesis (double UI).
- **E — next-edit instead of FIM** (Continue **Instinct** 7B open; Zed **Zeta-2** Apache-2.0) 🔮 → v3 stretch: the real quality lever, but needs a specialist model + richer rendering the InlineCompletion API only partly supports.

**Upgrade ladder:** FIM (v1, qwen2.5-coder:1.5b via Ollama) → cross-file context (llama.cpp `/infill` **or** Refact-style AST+VecDB) → next-edit (Instinct/Zeta) in v3.

**Trophy idea from Refact (`refact-lsp`):** feed FIM cross-file context cheaply by **ranking lines by "usefulness" and skeletonizing** (keep class/function signatures, drop bodies to fit the token budget) instead of dumping whole chunks — reuse this in §12 too. Landscape refs: Twinny (MIT, Ollama FIM), llama.vscode (official ggml-org), Continue.dev (Apache-2.0, primary reference), Cody, Tabby, Refact.ai (BSD-3).

## 12. Semantic Codebase RAG — architecture
Full how-to (grounded, with SQL/RRF + MCP tool schema): `research/vscode-hermes/semantic-codebase-rag-howto.md`.

- **What it is:** give Hermes **semantic/hybrid code retrieval** via a **`codebase_search` MCP tool** the extension hosts. Dense+sparse **fusion happens inside our tool**, so Hermes is **unmodified** — it just gains one more tool beside its ripgrep (`search_files`) + FTS5 (`session_search`). Model uses ripgrep for exact strings, `codebase_search` for conceptual "where/how is X".
- **Split (all LOCAL except the embed HTTP call):** the **indexer lives in the extension host** (file watchers; embed calls go over HTTP to the **remote runner**); the **query side is a tiny stdio MCP server** the local Hermes spawns, which opens the on-disk index read-only and runs the hybrid query.
- **Chunking:** **tree-sitter AST** (one chunk per function/method/class, ~**512 tokens**, no overlap, prepend a `path › symbol` header); ~40-line/10-overlap window fallback for unsupported languages. (Continue's "smart collapsed chunk" model.)
- **Embedder — serves ONLY this RAG index; consumer is the AGENT (Hermes) via `codebase_search`. Autocomplete/FIM uses NO embeddings.** Model: default **Qwen3-Embedding-0.6B** (tiny dedicated embedder, **runs on the remote runner**, called over HTTP), MRL-truncated to **768 dims** (best sub-1B on code, 32k ctx, Apache-2.0, `qwen3-embedding:0.6b`); fallback **nomic-embed-text** (137M, needs `search_document:`/`search_query:` prefixes). **Standardize 768 dims** so embedders stay swappable without a schema change.
- **Vector store: LanceDB (CHOSEN).** Embedded, no daemon, native **ANN** (IVF-PQ) + native **hybrid** (`RRFReranker`) — what Continue.dev ships; index = a local file next to the MCP reader. Sits behind a **`VectorStore`** interface so it can swap to Qdrant (network service), pgvector (if Postgres), or sqlite-vec (min-footprint) without touching callers. Node bindings: `@lancedb/lancedb` (prebuilt native — mind the VS Code/Electron ABI; the MCP query server is a plain Node child process, so standard Node ABI applies there).
- **Embed endpoint (unified, source-grounded):** `POST /v1/embeddings` (batch `input`, OpenAI-shaped) works on **all three runners** → the `Embedder` client is **one path**. (Ollama also `/api/embed`; llama.cpp needs `--embeddings`+pooling≠none; vLLM's continuous batching is fastest for the initial repo build.) See `research/vscode-hermes/runner-apis-howto.md`.
- **Hybrid = RRF (k=60), inside the tool:** native in LanceDB (`RRFReranker`) / Qdrant (server RRF), or hand-rolled (`vec0` KNN + `fts5` BM25 in sqlite-vec; CTE+`tsvector` in pgvector). Either way fusion happens **inside our tool** — this *is* "combining with lexical search", and Hermes is never touched.
- **Lifecycle:** content-hash (sha256) invalidation → re-embed only changed files; `FileSystemWatcher` debounced incremental; honor `.gitignore`/`.hermesignore`; persist at **workspace `.hermes/index/`** (globalStorage fallback).
- **Integration:** MCP TS SDK (`registerTool('codebase_search', …)` + `StdioServerTransport`); register via ACP `session/new` `mcpServers` with **absolute paths** (Fedora spawn), hot-reload via tui_gateway `reload.mcp`.
- **v1 slice:** Qwen3-Embedding-0.6B@768 (remote runner) + tree-sitter (TS/JS/Py/Go/Rust) + **LanceDB** behind `VectorStore` + native RRF hybrid + watcher + stdio MCP `codebase_search`.
- **Later:** LanceDB/Qdrant swap behind a `VectorStore` interface, cross-encoder rerank + MMR, an Aider-style repo-map MCP tool (tree-sitter + PageRank, no embeddings) for cheap whole-repo orientation.

## 13. Code location & git — three axes (grounded in VS Code docs)
My earlier "git = local SCM, nothing remote" collapsed three orthogonal axes. Kept separate:

- **Axis A — where the FILES live (VS Code Remote).** Handle via VS Code, not us: `Uri` + `workspace.fs` everywhere, `extensionKind: ["workspace"]`. Then:
  - **Local / Remote-SSH / Dev Container / WSL / Codespaces:** our extension runs in the **workspace extension host next to the files** (on the remote host when remote) → Hermes + index + MCP + ripgrep co-located with the files automatically; models still on the runner node. **Transparent — same architecture.**
  - **Virtual workspace (github.dev / vscode.dev, no checkout):** no disk FS, **no child_process/spawn**, no ripgrep, no local Hermes. Declare `capabilities.virtualWorkspaces: { supported: "limited", description }` (+ `capabilities.untrustedWorkspaces`) → **degraded mode**: chat with a remote Hermes if present; autocomplete + local RAG + local-Hermes spawn are OFF, with a clear banner.
- **Axis B — working-tree git (SCM).** Native VS Code **Git extension API** (`extensions.getExtension('vscode.git').exports.getAPI(1)`) for diffs/stage/commit + commit-msg gen. Works local AND Remote-SSH (git runs where the files are). No REST.
- **Axis C — forge (GitHub/GitLab remote service).** The **AGENT's** job: Hermes reaches forges via its own tools — `gh`/`glab` in its terminal or a github/gitlab MCP — independent of our SCM UI and of whether Hermes is local. We may optionally register a forge MCP / surface PRs, but we do NOT reimplement a forge client. `hermes serve /api/git/*` matters only if Hermes is a detached remote daemon — not the default.

**v1 scope:** real filesystem (local OR Remote-SSH/Dev Container/WSL/Codespaces) = full features; virtual workspace = graceful limited/off. Sources: VS Code [Virtual Workspaces](https://code.visualstudio.com/api/extension-guides/virtual-workspaces), [Supporting Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions), [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host).

---

*This is the справочник. When the user says "go", turn §3/§5/§8/§11/§12/§13 into pinned per-agent specs (full data/message shapes) and dispatch by non-overlapping zone, verifying the build each time.*
