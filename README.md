<div align="center">

# Talaria Code

**Private AI coding agent for VS Code — agentic edits, inline completions, and chat on your own local models.**
Local-first. Your models, your machine.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.125-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Local-first](https://img.shields.io/badge/Local--first-no%20cloud-2ea44f)](#privacy--security)
[![Platform](https://img.shields.io/badge/Platform-Linux-51A2DA?logo=linux&logoColor=white)](#requirements)

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
| **OS** | Primary target **Linux** (developed on Fedora). The mock UI runs anywhere, but the live backend targets Linux; other platforms are currently untested. |
| **Python + pipx** | Python **3.11–3.13** and **pipx** on your `PATH`. The **Backend Setup** panel installs the Hermes agent for you via pipx — the extension is a Hermes *client*. On Fedora: `sudo dnf install pipx`. |
| **A local model runtime** | **Ollama**, **vLLM**, or **llama.cpp**, serving: a chat/agent model (via Hermes), a FIM completion model (default `qwen2.5-coder:1.5b-base`), and an embedding model for RAG (default `qwen3-embedding:0.6b`). Ollama can be detected and its models pulled from the Setup panel. |

## Installation

Talaria Code is not yet on the Marketplace. Build and install from source:

```bash
npm install        # host + webview (npm workspaces)
npm run build      # build both bundles
npm run package    # produce a .vsix via vsce

code --install-extension talaria-code-*.vsix
```

## Getting started

Talaria Code installs and wires up its backend from **one panel** — no
hand-edited JSON, no manual Python installs.

1. **Install the extension** (`.vsix` — see [Installation](#installation)).
2. **Open the Talaria panel** from the activity bar. On first run, **Backend
   Setup** opens automatically. Reopen it any time from the **rocket icon** in
   the panel's title bar, or the **`Talaria: Backend Setup`** command.
3. **Work through the five cards** — each shows its status, one primary action,
   and a details/log view:
   - **Agent** — pick **Hermes** and click **Install Hermes**. The panel
     installs `hermes-agent[acp]` via pipx, verifies it, writes the paths, and
     offers a one-click window reload to go live. (OpenClaw and Talaria AI are
     shown as *coming soon*.)
   - **Provider** — click **Configure provider** to run Hermes's own setup
     wizard in a terminal and choose the chat model/provider the agent uses.
     Talaria never forces a provider on you.
   - **Autocomplete (FIM)** — pick a backend (Ollama / llama.cpp / vLLM /
     Codestral / OpenAI-compatible). For local-capable backends the card asks
     **"Install locally, or connect to an existing endpoint?"** For Ollama it
     can detect the daemon and pull the default model
     (`qwen2.5-coder:1.5b-base`) with a live progress bar.
   - **Next Edit** *(optional)* — multi-line next-edit suggestions. **Generic**
     reuses the FIM model you just set up (no extra setup); **Dedicated** uses a
     separate model you set up here.
   - **Codebase index (RAG)** *(optional)* — enable the local code index and, on
     Ollama, pull the embedding model (`qwen3-embedding:0.6b`).

Until you install a real backend, the extension runs a scripted **mock** backend
so you can explore the UI with no agent process running — it works on any OS.

### Honest caveats

- **Python and pipx are real prerequisites.** The panel can't `sudo` for you: on
  Fedora, run the one guided command `sudo dnf install pipx` first. Hermes needs
  Python **3.11–3.13**.
- **Installing Hermes downloads ≈300–500 MB** from PyPI into
  `~/.local/share/pipx`.
- **Models are gigabytes and hardware-bound.** The FIM model is ≈1 GB,
  embeddings ≈0.7 GB, and your agent's chat model may be far larger. Sizes are
  shown before any download and nothing is pulled automatically — one click
  makes the *clicks* easy, it can't make the downloads small or a GPU appear.
- **Local llama.cpp/vLLM installs are guided, not silent.** Ollama's is a clean
  one-script install; llama.cpp and vLLM need your own build/hardware decisions,
  and the cards say so. "One click" means we open the right terminal command and
  automate everything after it (pull, config, probe).
- **A window reload activates the agent** the first time you switch it on.

## Settings

Talaria Code has **one source of truth** for its configuration — the `talaria.*`
VS Code settings (plus VS Code SecretStorage for API keys). Every screen is a
view over that one source, so **nothing is doubled and each setting has exactly
one home.** There are two surfaces, split by *who owns the setting*:

### Talaria Config — the extension's own settings

All `talaria.*` keys: the agent backend and Hermes connection, autocomplete
(FIM), Next Edit, and the codebase index (RAG). Edit these two equivalent ways —
both write the same settings, so use whichever you prefer:

- **The Backend Setup panel** (friendly): the five cards above.
- **The native settings page** — run **`Talaria: Open Settings`** or search
  `@ext:syntinal.talaria-code`. It's organized into five titled sections:
  **Backend & Agent**, **Autocomplete (FIM)**, **Next Edit**,
  **RAG (Codebase Index)**, and **Advanced**.

The keys you'll usually touch:

| Setting | Default | What it does |
|---|---|---|
| `talaria.backend` | `mock` | Which agent backend to talk to. Set to `acp` for the real Hermes backend (the Setup panel does this for you). |
| `talaria.hermesPath` | `""` | Absolute path to the `hermes` executable (written by the installer). |
| `talaria.pythonPath` | `""` | Python interpreter used to launch the real Hermes backend (written by the installer). |
| `talaria.cwd` | `""` | Working directory for the agent (defaults to the first workspace folder). |
| `talaria.autocomplete.enabled` | `true` | Enable inline (FIM) autocomplete. |
| `talaria.autocomplete.backend` | `ollama` | FIM backend serving completions. |
| `talaria.autocomplete.model` | `qwen2.5-coder:1.5b-base` | Model used for completions. |
| `talaria.autocomplete.endpoint` | `""` | Base URL for the completion backend (may be a node you host). |
| `talaria.rag.enabled` | `true` | Enable the codebase RAG index and search. |
| `talaria.rag.embedEndpoint` | `http://127.0.0.1:11434` | Embeddings backend base URL. |
| `talaria.rag.embedModel` | `qwen3-embedding:0.6b` | Model used to embed code chunks. |

Settings that repoint an executable or a model endpoint are **machine-scoped**,
so a workspace you open can't silently change them; API keys live in VS Code
SecretStorage, never in plaintext settings. The full set is in the native
settings page.

### Agent Config — the Hermes agent's runtime settings

Hermes's own runtime configuration — approval policy, max turns, delegation,
checkpoints, security — lives in the **"Agent config"** tab inside the Talaria
panel. These are the *agent's* settings (its `config.yaml`, edited over the
control channel), not `talaria.*` extension settings — which is why they have
their own home and are never doubled with the Talaria Config surface.

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

## Manual setup (advanced)

The Backend Setup panel is optional — everything it writes is a normal
`talaria.*` setting you can set by hand if you'd rather wire things up yourself:

1. **Install the Hermes agent yourself**, e.g.
   `pipx install "hermes-agent[acp]==0.18.2"` (the `[acp]` extra is required, or
   `hermes acp` fails on import), or via Hermes's own installer.
2. **Point the extension at it**: set `talaria.hermesPath` to the `hermes`
   executable and `talaria.pythonPath` to the matching interpreter. For a pipx
   install both live under `~/.local/share/pipx/venvs/hermes-agent/bin/`.
3. **Go live**: set `talaria.backend` to `acp` and reload the window.
4. **Configure the chat model/provider** with Hermes's own wizard:
   `hermes-acp --setup`.
5. **Run a model runtime** (Ollama / vLLM / llama.cpp) and set the
   `talaria.autocomplete.*` and `talaria.rag.*` keys to your endpoints and
   models (defaults: FIM `qwen2.5-coder:1.5b-base`, embeddings
   `qwen3-embedding:0.6b`).

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
