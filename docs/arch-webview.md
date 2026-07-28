# Webview UI — Architecture (Agent B)

The in-panel React app for the Hermes VS Code extension: a streaming agent chat
plus side panels to manage the agent. This doc covers the stack, component tree,
message flow, and theming. Lane: `webview/**` + this file.

## Stack

- **React 18 + TypeScript + Vite 5**, styled with **Tailwind 3** (utility classes
  bound to CSS custom properties, not hardcoded colors).
- **Icons: `@vscode/codicons`**, bundled locally. Vite emits `codicon.ttf` as a
  hashed asset; the host serves it via `asWebviewUri` under the `font-src` CSP.
  No Material Symbols, no external/CDN fonts.
- **Build → `../dist/webview/`** (relative to `webview/`), a single JS bundle
  (`assets/webview.js`) + single CSS (`assets/index.css`). `base: './'` so every
  asset URL is relative and rewritable by `asWebviewUri`. Agent C's root scripts
  orchestrate this via the npm **workspace** (`"workspaces": ["webview"]`); run
  `npm run build` in `webview/` for a standalone build (`tsc --noEmit && vite build`).
- **Runs on any OS with no Hermes process**: standalone (Vite dev or a plain
  browser) the app detects the absence of `acquireVsCodeApi` and drives itself
  from `MockBackend`, which replays the exact host→webview protocol.

## Directory map

```
webview/
├── index.html                 Vite template; host injects CSP + nonce at serve time
├── vite.config.ts             base './', outDir ../dist/webview, single bundle
├── tailwind.config.js         colors/fonts → CSS vars (theme-aware)
├── postcss.config.js  tsconfig.json  package.json
└── src/
    ├── main.tsx               mounts App; imports codicons + theme + styles; wires mock
    ├── App.tsx                subscribes to bridge, reduces state, renders surface
    ├── bridge.ts              typed acquireVsCodeApi wrapper (+ standalone mock hookup)
    ├── protocol.ts            LOCAL MIRROR of src/shared/protocol (Agent D = source of truth)
    ├── types.ts               view-model types + INITIAL_STATE
    ├── theme.css              brand tokens layered onto --vscode-* (light/dark/HC)
    ├── index.css              Tailwind layers + globals + telemetry label style
    ├── state/transcript.ts    reducer: folds streaming wire messages → AppState
    ├── mock/MockBackend.ts    canned turn stream + panel data (standalone host)
    ├── mock/fixtures.ts       typed panel payloads (also the panel.data shapes)
    ├── components/            AppBar, PanelTabs, Composer, Icon, Pill, Toggle
    │   └── chat/              ChatView + UserMessage, ReasoningBlock, AgentMarkdown,
    │                          ToolCard, DiffCard, ApprovalCard, PlanList, ResultSummary
    └── panels/                PanelShell + Tools/Mcp/Skills/Checkpoints/Subagents/
                               Models/Settings + EmptyState (onboarding)
```

## Component tree

```
App
├── AppBar                     brand · session switcher · settings gear
├── PanelTabs                  chat|tools|mcp|skills|checkpoints|subagents|models|settings
├── (error banner)            dismissible; rendered on `error` message
└── active surface:
    ├── tab=chat →  ChatView (transcript) + Composer
    │     ChatView maps TranscriptItem[] → UserMessage | ReasoningBlock |
    │       AgentMarkdown | ToolCard | DiffCard | ApprovalCard | PlanList |
    │       ResultSummary   (EmptyState when transcript is empty)
    │     Composer: auto-grow textarea, @/ hints, mode picker, model chip, send/stop
    └── tab=<panel> → matching *Panel, fed from state.panels[tab]
```

Chat cards are pure presentational components; only `DiffCard` and `ApprovalCard`
raise actions (per-hunk accept/reject, option pick) back up to `App`.

## Message flow

One typed protocol (`protocol.ts`, mirroring Agent D's `src/shared/protocol.ts`).
`bridge` is the only thing that touches `postMessage` / `acquireVsCodeApi`.

**host → webview** (folded by `state/transcript.ts` reducer):
`hydrate`, `clear`, `turn.start`, `user`, `reasoning.start|delta|end`,
`message.delta|end`, `tool.start|update|diff`, `approval.request`, `plan.update`,
`result.summary`, `panel.data`, `turn.end`, `error`, `theme`.

Streaming deltas are matched to their transcript item **by id** and appended, so
`reasoning.delta` / `message.delta` grow a live block and `tool.update` flips a
card's status (pending→running→done/failed). `plan.update` replaces the single
plan block; `panel.data` caches per-tab payloads for instant tab switches.

**webview → host** (posted by `App` handlers):
`ready` (on mount), `prompt`, `cancel`, `approval.respond`, `diff.resolve`,
`setModel`, `setMode`, `switchTab`, `control.invoke` (generic control-plane call
used by every panel action, e.g. `tools.setEnabled`, `mcp.reload`,
`rollback.restore`).

Approvals, diff resolutions, mode/model picks update the UI **optimistically**
via local reducer actions, then post to the host; the host confirms with a
follow-up `hydrate`/`panel.data`.

**Persistence:** `App` writes a compact `{tab, session}` snapshot to
`vscode.setState()`; combined with a host `hydrate` on reload, the view rebuilds
after disposal (no `retainContextWhenHidden` needed).

## Theming

`theme.css` defines Hermes brand tokens (`--h-*`) that **resolve to `--vscode-*`
theme variables** for all surfaces/text, and to **fixed brand hues** for the teal
accent and diff/status colors. Tailwind's color + font scales point at these
`--h-*` vars, so every utility stays theme-aware. Body-class overrides
(`.vscode-light` / `.vscode-dark` / `.vscode-high-contrast[-light]`, which VS Code
stamps on `<body>`) retune the accent and borders per theme. Standalone, `App`
applies the class from `theme` messages (default dark), and `var(--vscode-*, …)`
fallbacks keep it legible with no host.

Design language: an **instrument-cluster aesthetic** — monospace uppercase
micro-labels (`h-eyebrow`, status `Pill`s) read like telemetry for an autonomous
process; teal is the "live signal" color (streaming, active, agent voice) layered
over the user's native theme so the panel reads as Hermes without fighting VS Code.

## Responsiveness & quality floor

- Narrow-panel first (works at 300px): single column, `PanelTabs` scroll
  horizontally, diffs/code scroll inside their own `overflow-x-auto` containers,
  `body { overflow: hidden }` so the panel body never scrolls horizontally.
- No mobile bottom-nav / phone frames (dropped from the Stitch drafts).
- Visible keyboard focus (`:focus-visible`), `role="switch"` toggles, reduced-motion
  honored (streaming pulses + mock timing collapse under `prefers-reduced-motion`).

## Contract note for Agent D

`protocol.ts` is a thin local mirror so the webview builds before `src/shared`
lands. The `type` string literals are the contract and are byte-identical to the
names pinned in the brief. When `src/shared/protocol.ts` is published, replace the
declarations with `export * from '../../src/shared/protocol';` and delete the
local duplicates (view-model types in `types.ts` stay webview-owned).
