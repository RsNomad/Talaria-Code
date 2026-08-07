## Backend Setup

Talaria Code installs and wires up its backend from **one panel** — no
hand-edited JSON, no manual Python installs.

Open the **Talaria** panel from the activity bar (it opens automatically on
first run), then work through the five cards:

- **Agent** — install the Hermes agent via pipx in one click.
- **Provider** — run Hermes's own wizard to choose your chat model/provider.
- **Autocomplete (FIM)** — install a local model or connect an endpoint.
- **Next Edit** *(optional)* — multi-line next-edit suggestions.
- **Codebase index (RAG)** *(optional)* — index your code locally.

### Recommended local models

Pick by your GPU — sizes are the download; running adds context memory +
~2 GiB buffers.

<!-- rec:devstral-24b:14333915904 -->
- **Agent** — Devstral-24B (2507) — 13.3 GiB (default)

<!-- rec:qwen25-coder-1.5b:986000000 -->
- **FIM** — Qwen2.5-Coder 1.5B (base) — 0.9 GiB (default)

<!-- rec:qwen3-embedding-0.6b:639000000 -->
- **Embedder** — Qwen3-Embedding 0.6B — 0.6 GiB (default)

<!-- rec:sweep-next:4680000000 -->
- **Next Edit** — Sweep Next-Edit v2 (7B) — 4.4 GiB (optional, dedicated next-edit)

<!-- rec:stack:15958915904 -->
A 24 GB GPU runs the full stack (Agent + FIM + Embedder) ≈ 14.9 GiB — about
7.1 GiB left for context.

Prerequisites: Python **3.11–3.13** and **pipx** (on Fedora,
`sudo dnf install pipx`). Models are downloaded on demand and can be several
gigabytes.
