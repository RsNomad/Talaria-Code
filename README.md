<div align="center">

# Talaria Code

**Private AI coding agent for VS Code — agentic edits, inline completions, and chat on your own local models.**
Local-first. Your models, your machine.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.125-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Local-first](https://img.shields.io/badge/Local--first-no%20cloud-2ea44f)](#privacy--security)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%C2%B7%20Fedora-51A2DA?logo=linux&logoColor=white)](#requirements)

**English** · [Русский](./README.ru.md) · [中文](./README.zh-CN.md)

</div>

---

## What is Talaria Code?

Talaria Code puts an **agentic AI coding assistant** in a native VS Code side
panel — chat, multi-step edits you approve, tool use, and codebase-aware answers
— all running against models **you** host with **Ollama**, **vLLM**, or
**llama.cpp**. It is a client for the [Hermes](https://github.com/nousresearch/hermes-agent) agent and is built local-first:
your code and prompts go to the model endpoints *you* control, not to someone
else's cloud.

If you want the ergonomics of a modern AI coding assistant without shipping your
source code to a third-party service, this is for you.

## Features

- 💬 **Agentic chat** — a coding agent living in a native VS Code panel, with tabs and session history.
- ✍️ **Edits with approval** — every file change is *proposed* and gated behind your explicit yes/no. Nothing is written silently.
- ⚡ **Inline completions + Next Edit** — fill-in-the-middle (FIM) autocomplete and next-edit suggestions, served by your local models.
- 🔎 **Codebase-aware** — a local RAG index (LanceDB + tree-sitter) so answers are grounded in *your* actual code.
- 🧩 **Tools & MCP** — connect [Model Context Protocol](https://modelcontextprotocol.io) servers, and expose the editor's own language intelligence (diagnostics, definitions, references) to the agent.
- 🕘 **Checkpoints** — snapshot and restore workspace state around agent turns.
- 🔒 **Privacy-first by design** — outbound content is scanned for secrets before it ever leaves; approvals fail *closed*; the agent is confined to the workspace.

## Privacy & Security

This is the whole point of Talaria Code, not an afterthought:

- **Egress scanning.** Content headed for a model is scanned first; secrets and
  credential-shaped files are stripped or blocked before anything leaves.
- **Fail-closed consent.** Permission prompts have a deadline — no answer within
  the window is treated as **deny**, never as silent approval.
- **Workspace confinement.** File access and edits are bounded to your workspace;
  path-escape attempts (`..`, absolute system paths) are rejected.
- **Machine-scoped model settings.** Which backend and model you talk to is a
  machine-level setting — a workspace you open can't silently repoint the agent
  at a different endpoint.

> **Honest framing:** Talaria Code is *local-first* — every model, embedding, and
> MCP endpoint is one you configure and host. It is **not** a hard guarantee that
> zero bytes ever leave the machine (you may point it at a remote node you own,
> or connect a remote MCP server). The design goal is that **you** control every
> destination, and that secrets are scanned out of the path either way.

## Requirements

| Requirement | Notes |
|---|---|
| **VS Code** | `^1.125` |
| **OS** | Primary target **Linux (Fedora)**. The mock UI runs anywhere, but the live backend targets Linux; other platforms are currently untested. |
| **Hermes agent** | The backend Talaria Code drives (`hermes acp` + `python -m tui_gateway.entry`). The extension is a Hermes *client*. |
| **A local model runtime** | **Ollama**, **vLLM**, or **llama.cpp**, serving: a chat/agent model (via Hermes), a FIM completion model (default `qwen2.5-coder:1.5b-base`), and an embedding model for RAG (default `qwen3-embedding:0.6b`). |

## Installation

Talaria Code is not yet on the Marketplace. Build and install from source:

```bash
npm install        # host + webview (npm workspaces)
npm run build      # build both bundles
npm run package    # produce a .vsix via vsce

code --install-extension talaria-code-*.vsix
```

## Getting started

1. Install and run the **Hermes** agent and a **model runtime** (e.g. Ollama with
   the models above).
2. Open the **Talaria** panel from the activity bar.
3. Point the extension at your Hermes install, then switch `talaria.backend` from
   `mock` to `acp` (see Configuration).

On first run the extension uses a scripted **mock** backend so you can explore the
UI with no Hermes process running — it works on any OS. Switch to `acp` to go
live against your real agent.

## Configuration

Settings live under the **`talaria.*`** namespace (Talaria Code is a Hermes
client). The ones you'll usually touch:

| Setting | Default | What it does |
|---|---|---|
| `talaria.backend` | `mock` | Which agent backend to talk to. Set to `acp` for the real Hermes backend. |
| `talaria.hermesPath` | `""` | Absolute path to the `hermes` executable. |
| `talaria.pythonPath` | `""` | Python interpreter used to launch the real Hermes backend. |
| `talaria.cwd` | `""` | Working directory for the agent (defaults to the first workspace folder). |
| `talaria.autocomplete.enabled` | `true` | Enable inline (FIM) autocomplete. |
| `talaria.autocomplete.backend` | `ollama` | FIM backend serving completions. |
| `talaria.autocomplete.model` | `qwen2.5-coder:1.5b-base` | Model used for completions. |
| `talaria.autocomplete.endpoint` | `""` | Base URL for the completion backend (may be a node you host). |
| `talaria.rag.enabled` | `true` | Enable the codebase RAG index and search. |
| `talaria.rag.embedEndpoint` | `http://127.0.0.1:11434` | Embeddings backend base URL. |
| `talaria.rag.embedModel` | `qwen3-embedding:0.6b` | Model used to embed code chunks. |

The full set is available in the Settings UI (search `hermes`).

## How it works

```
VS Code  ──►  Talaria Code (this extension)
                   │  Agent Client Protocol (ACP)
                   ▼
              Hermes agent  ──►  your local model runtime
                                 (Ollama / vLLM / llama.cpp)
```

Two bundles, one repo: a TypeScript **host** (esbuild → `dist/extension.js`) and
a React 18 **webview** panel (Vite → `dist/webview/`). They talk over a single
typed `postMessage` protocol — the webview never touches Node or VS Code APIs
directly. The host drives the Hermes agent over ACP for chat, edits, tools, and
MCP; inline completions and codebase embeddings talk **directly** to the model
endpoints you configure.

## Development

Requirements: Node ≥ 18 (Node 24 recommended), VS Code ≥ 1.125.

```bash
npm install
```

Press **F5** in VS Code to build both bundles and open the Extension Development
Host with mock data — no Hermes process is started, so it works on any OS.

| Script | What it does |
|---|---|
| `npm run build` | Build both bundles once |
| `npm run watch` | Rebuild both bundles on change |
| `npm run check-types` | `tsc --noEmit` typecheck of `src/**` |
| `npm run package` | Produce a `.vsix` via `vsce` |
## Contributing

Issues and pull requests are welcome. Please open an issue to discuss substantial
changes before starting.

## License

Talaria Code is licensed under **GPL-3.0-or-later**.
Copyright © 2026 **Syntinal**.

You may use, study, share, and modify it freely; if you distribute a modified
version, it must remain under the GPL. See [`LICENSE`](./LICENSE) for the full
text and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for bundled
third-party components and their licenses.
