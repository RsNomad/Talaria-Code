# Host Architecture (Agent A — extension host layer)

The extension-host half of the Hermes VS Code extension: `src/extension.ts` +
`src/host/**`. It owns activation, the webview bridge, the backend abstraction,
the stdio transport, and Linux-first runtime resolution. It does **not** touch
`package.json` (Agent C), `src/shared/**` (Agent D — the protocol contract), or
`webview/**` (Agent B — the React UI).

## Layer map

```
extension.ts                      activate(): pick backend, register view + command
└─ host/
   ├─ HermesViewProvider.ts       WebviewViewProvider: CSP+nonce HTML, dumb message pipe
   ├─ backend/
   │  ├─ AgentBackend.ts          THE seam — interface every backend implements
   │  ├─ MockBackend.ts           DEFAULT — replays mockScenario, no process/network
   │  └─ AcpBackend.ts            STUB  — real backend (hermes acp + control plane)
   ├─ control/
   │  └─ ControlChannel.ts        STUB  — tui_gateway control plane (§4 method map)
   ├─ transport/
   │  └─ JsonRpcStdio.ts          REAL  — newline-delimited JSON-RPC over child stdio
   ├─ runtime/
   │  └─ resolveHermes.ts         REAL path logic (exec stubbed) — venv python + login shell
   └─ util/
      ├─ nonce.ts                 per-load CSP nonce
      └─ errors.ts                notImplemented() for the real-backend stubs
```

## Data flow (both directions are one hop)

```
webview ──postMessage──► HermesViewProvider ──method call──► AgentBackend
        ◄─postMessage──                     ◄──onMessage event──
```

The provider is intentionally a **dumb pipe**. All intelligence lives in the
backend:

- **Webview → host:** the provider decodes a `WebviewToHostMessage` and calls
  the matching `AgentBackend` method (`prompt→sendPrompt`, `cancel→cancel`,
  `approval.respond→respondApproval`, `diff.resolve→resolveDiff`,
  `setModel/setMode`, `switchTab→invokeControl('panel.data')`,
  `control.invoke→invokeControl`).
- **Host → webview:** the backend emits fully-formed `HostToWebviewMessage`
  values on `onMessage`; the provider forwards each verbatim. A backend is
  responsible for *translating* its native events into this one protocol, so the
  webview renders identically regardless of backend.

## The backend-swap seam (the core design decision)

`AgentBackend` (`backend/AgentBackend.ts`) is the only thing the provider knows.
`MockBackend` is the default; `AcpBackend` is the real one. Swapping them is a
**single line** in `extension.ts`:

```ts
const backend: AgentBackend = new MockBackend();          // default, any OS
// const backend: AgentBackend = new AcpBackend(cfg, out); // real, Fedora
```

Nothing else changes — provider, protocol, and webview are backend-agnostic.
This is what pinned decision #4 ("mock-first") buys us: the whole UI ships and
runs on Windows/macOS/Linux today, and the real process wiring drops in later
without a UI rewrite.

Both backends share one rule for side panels: panel data is **pushed** as a
`panel.data` message (never returned synchronously), so the Tools/MCP/Skills/…
panels behave identically whether the data came from `mockScenario` or a live
tui_gateway RPC.

## Contract dependencies (Agent D — `src/shared/*`)

This layer imports **types by name** and does not define them. Required exports:

**`src/shared/protocol.ts`**
- `HostToWebviewMessage` — discriminated union over `type`: `hydrate`, `clear`,
  `turn.start`, `user`, `reasoning.start|delta|end`, `message.delta|end`,
  `tool.start|update|diff`, `approval.request`, `plan.update`, `result.summary`,
  `panel.data`, `turn.end`, `error`, `theme`.
- `WebviewToHostMessage` — union over `type`: `ready`, `prompt`, `cancel`,
  `approval.respond`, `diff.resolve`, `setModel`, `setMode`, `switchTab`,
  `control.invoke`.
- `AgentMode` — approval mode (`default` | `accept_edits` | `dont_ask`).
- `DiffAction` — per-hunk `accept` | `reject`.

Field-level expectations this layer relies on (provider `handleWebviewMessage`):
`prompt {text, mode}`, `approval.respond {id, optionId}`,
`diff.resolve {toolId, hunkIndex, action}`, `setModel {id}`, `setMode {mode}`,
`switchTab {tab}`, `control.invoke {method, params}`. Host-emitted helpers used
directly: `theme {kind}`, `panel.data {tab, data}`, `turn.end {reason}`.

**`src/shared/mockScenario.ts`** — exports the `mockScenario` value plus
`MockScenario` / `MockStep` types. Assumed shape (the player in `MockBackend`
codes against exactly this — please align):

```ts
interface MockScenario {
  timeline: MockStep[];              // ordered playback of the canned turn
  panels: Record<string, unknown>;   // tab id → payload served as panel.data
}
interface MockStep {
  delayMs: number;                   // wait before emitting `message`
  message: HostToWebviewMessage;     // already a protocol message
  gate?: 'approval' | 'diff';        // pause AFTER emit until the user responds
}
```

The player streams steps on `setTimeout(delayMs)`; a `gate` step parks playback
until `respondApproval` / `resolveDiff` advances it, reproducing the real
approval/diff pause. The canned turn should emit, in order:
`turn.start → user → reasoning.start/delta/end → message.delta/end →
tool.start/update → tool.diff (gate:'diff') → approval.request (gate:'approval')
→ plan.update → result.summary → turn.end`.

## Webview security & state (best-practices.md, enforced in the provider)

- `enableScripts: true`; `localResourceRoots` scoped to `dist/webview`, `media`,
  and bundled `@vscode/codicons/dist` — never the whole extension.
- Strict CSP `default-src 'none'` with a fresh per-load **nonce** on the single
  module script; `img data:`, `style 'unsafe-inline'`, `font` + `img` from
  `webview.cspSource`; no CDN, no remote fonts, no inline handlers.
- Local assets (JS/CSS/codicons) referenced only via `asWebviewUri`.
- **State:** the webview persists its own view-model with `setState()` and
  rebuilds from `getState()` when VS Code disposes the view; on every
  `resolveWebviewView` (and on the webview's `ready` message) the host posts a
  `hydrate` message + current `theme` to seed/refresh it. `theme` is re-posted on
  `onDidChangeActiveColorTheme`.
- `retainContextWhenHidden: true` keeps the panel cheap-and-live; the
  `getState/hydrate` path remains the correctness backstop if it is disposed.

## The transport primitive — `JsonRpcStdio` (real now)

One primitive for **both** future channels (spec §2): spawn a child, frame
newline-delimited JSON on `\n` (buffering partial lines), correlate `request()`
by `id`, `notify()` fire-and-forget, fan out `event`/notification frames via
`onEvent()`, `dispose()` = SIGTERM → SIGKILL after 5s. stdout is protocol-only;
stderr + a send/recv **traffic tap** go to a `Logger` (the "Hermes" output
channel). Per-request timeout defaults to 120s (long turns). It has **no
`vscode` dependency** so it is reusable and testable.

## Runtime resolution — `resolveHermes` (Linux-first; exec stubbed)

Target is **Fedora/Linux** (memory: target-platform-fedora). The path math is
real; only the OS lookup is stubbed:

- `deriveVenvPython(hermesBin)` — the tui_gateway must run under the *same*
  interpreter that owns the `hermes` console script, i.e. its sibling
  `<venv>/bin/python`. Pure string logic.
- `loginShellSpawn(cmd, args)` — wraps a launch as `$SHELL -l -c 'exec …'` so a
  GUI-launched VS Code (stripped `$PATH`) still finds venv/pyenv/conda/Homebrew;
  `exec` lets SIGTERM/SIGKILL reach the real child. Args are single-quote
  escaped.
- `resolveHermes(config)` → `{ hermesBin, python, cwd, acp, control }` where
  `acp` = login-shell `hermes acp` and `control` = login-shell
  `python -m tui_gateway.entry`. `resolveHermesBin` honours a `hermes.pythonPath`
  / explicit-path override; otherwise it would run `command -v hermes` inside the
  login shell (the exact command is built; the exec is `notImplemented()` until
  Fedora wiring).

## How the real ACP / tui_gateway wiring lands later

`AcpBackend` + `ControlChannel` are stubs that already carry the full shape and
JSDoc, so filling them in is fill-in-the-blanks, not redesign:

1. **`AcpBackend.start()`** — `resolveHermes(config)` → spawn `hermes acp` via
   `JsonRpcStdio` (wrapped by the ACP TS SDK's `ClientSideConnection`, not
   hand-rolled — spec §3.1); `initialize` advertising
   `fs.readTextFile:true, writeTextFile:false, terminal:true`; start
   `ControlChannel`; `session/new`.
2. **Translation layer** — map ACP `session/update` notifications to protocol
   messages (table in `AcpBackend` JSDoc):
   `agent_thought_chunk→reasoning.*`, `agent_message_chunk→message.*`,
   `tool_call→tool.start`, `tool_call_update→tool.update`/`tool.diff`,
   `plan→plan.update`, usage `_meta→result.summary`, turn loop→`turn.start/end`.
3. **Approvals/diffs** — ACP `session/request_permission` (command + edit paths,
   spec §3.6) → `approval.request` / `tool.diff`; `respondApproval` /
   `resolveDiff` resolve the pending ACP permission (per-hunk accept/reject).
4. **Control plane** — port `ui-tui/src/gatewayClient.ts` into `ControlChannel`:
   spawn `python -m tui_gateway.entry`, await the `gateway.ready` event, then
   `dispatch(method, params)` over `JsonRpcStdio` for the §4.3 method map
   (`tools.*`, `skills.*`, `rollback.*`, `model.*`, `config.*`, `delegation.*`,
   …). `invokeControl` is a thin passthrough to `dispatch`; results are emitted
   as `panel.data`. Crash-respawn and WS-attach mode
   (`HERMES_TUI_GATEWAY_URL`) swap only the transport.
5. **Config** — read `hermes.pythonPath` / `hermes.cwd` via
   `workspace.getConfiguration` into `HermesRuntimeConfig` and pass to the
   backend constructor. (Settings themselves are contributed by Agent C.)

Golden rule preserved throughout: **Hermes owns the filesystem**; the editor is a
viewer/approver of diffs, never the FS writer (spec §0).
