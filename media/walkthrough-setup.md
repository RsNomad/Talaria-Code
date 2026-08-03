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

Prerequisites: Python **3.11–3.13** and **pipx** (on Fedora,
`sudo dnf install pipx`). Models are downloaded on demand and can be several
gigabytes.
