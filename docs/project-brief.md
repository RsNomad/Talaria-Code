# Hermes VS Code Extension — Project Brief (single source of truth)

Everyone building this reads this first. It pins the decisions so parallel work doesn't diverge.

## What we're building
The in-editor face of **Hermes**, a full AI agent system. A VS Code webview panel: chat with the agent (streaming answer, reasoning, tool cards, file diffs with approval, plan) + side panels to manage the agent (Tools, MCP, Skills, Checkpoints, Subagents, Models, Settings).

## Prior research (READ — do not re-derive)
Under the repo root `d:\annas\Project Agent\`:
- `artifacts/hermes-vscode-connect-and-control-spec.md` — the two-channel connect/control design (ACP + tui_gateway), file structure, workstreams.
- `artifacts/hermes-vscode-extension-architecture.md` — high-level architecture + requirements.
- `research/harness/hermes-capability-catalog.md` — every Hermes feature → RPC/channel.
- `research/harness/hermes-tui-gateway-methods.md` — 128 control-plane methods + events.
- `research/vscode-hermes/feature-inventory-summary.md` — cross-extension feature matrix.
- `Vscode-ext-new/docs/best-practices.md` — the VS Code rules (CSP, theming, bundling, activation).

## Pinned decisions (do NOT re-litigate)
1. **Language:** TypeScript everywhere.
2. **Two bundles:** host via **esbuild** → `dist/extension.js` (CJS, `external:['vscode']`); webview via **Vite + React 18 + TypeScript + Tailwind** → `dist/webview/`.
3. **Target platform: Fedora / Linux.** POSIX process model; login-shell PATH resolution. macOS secondary. **Windows is NOT a target** — but the whole UI must run on any OS via mock data (dev happens on Windows now).
4. **Mock-first.** Ship an `AgentBackend` interface with a `MockBackend` (canned streaming + panel data) as the DEFAULT. Real `AcpBackend` (spawns `hermes acp`) and `ControlChannel` (spawns `python -m tui_gateway.entry`) are stubs now, wired later on Fedora. **Nothing spawns a process in mock mode.**
5. **Transport (real, later):** newline-delimited JSON-RPC over stdio (`JsonRpcStdio`); ACP for conversation, tui_gateway for control plane. Same message bridge to the webview regardless of backend.
6. **Message bridge:** ONE typed protocol between host and webview, defined in `src/shared/protocol.ts`. Host translates backend events → these messages; webview renders. Webview → host: `prompt`, `cancel`, `approve`, `setModel`, `setMode`, `switchTab`, `control:invoke`.
7. **Panels:** Chat (default) + Tools + MCP + Skills + Checkpoints + Subagents + Models + Settings + onboarding/empty state. Chat components: user message, reasoning block, agent markdown, tool card (states pending/running/done/failed), diff card (per-hunk accept/reject), approval card, plan list, result summary.
8. **Design system:** brand teal accent over `--vscode-*` surfaces; **codicons** for icons; support light/dark/high-contrast. Kill any mobile patterns (bottom nav, phone frames) from the Stitch drafts. See `frontend-design` skill.
9. **No secrets in the repo.** API keys resolved by Hermes itself, not stored by the extension.

## Directory ownership (parallel-safe — stay in your lane)
```
Vscode-ext-new/
├── package.json, tsconfig*.json, esbuild.js, .vscodeignore, .gitignore, README.md   ← Agent C (build/manifest)
├── .vscode/launch.json, tasks.json                                                   ← Agent C
├── src/
│   ├── extension.ts, host/**                                                          ← Agent A (host/transport)
│   └── shared/protocol.ts, shared/mockScenario.ts                                     ← Agent D (contract)
├── webview/  (vite root: index.html, vite.config.ts, src/**, tailwind config)         ← Agent B (webview UI)
└── docs/  (each agent writes its OWN doc: arch-host.md / arch-webview.md / build-setup.md / contract.md)
```
Rules to avoid conflicts:
- Only **Agent C** writes `package.json` and root build config.
- Only **Agent D** writes `src/shared/*`. Agents A & B **import** `../shared/protocol` types by name; they do NOT define the protocol.
- **Agent B**'s Vite config outputs to `../dist/webview/`. **Agent C**'s npm scripts orchestrate both builds.
- Each agent writes only inside its lane + its own `docs/*.md`.

## Definition of done for this pass (architecture + skeleton)
A coherent scaffold that (once Agent C's `npm install` + build run) F5-launches on Windows and shows the Hermes panel driven by mock data — chat streams a canned turn (reasoning → tool card → diff with accept/reject → approval → plan), and the side tabs switch to static-but-real-looking panels. No Hermes process involved.
