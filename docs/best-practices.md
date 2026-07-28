# VS Code Extension — Best Practices (grounded in official docs)

Synthesized from the VS Code Extension API reference + Microsoft/VS Code docs (Context7, latest). These are hard rules for this project.

## Webview (the panel UI lives here)
- **Sandbox + message bridge only.** The webview is an isolated iframe. It talks to the extension host ONLY via `postMessage` / `acquireVsCodeApi()`. No direct Node/VS Code API from the view.
- **Strict CSP with a per-load nonce.** Set `<meta http-equiv="Content-Security-Policy">` with:
  `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-<NONCE>';`
  Every `<script>` carries the nonce. **No inline event handlers, no external CDN, no remote fonts.**
- **Load local resources via `asWebviewUri`** and whitelist their folder in `localResourceRoots` (point it at `dist/`/`media/`, not the whole extension). Bundled JS/CSS/fonts/icons are referenced through `asWebviewUri`.
- **`enableScripts: true`** in `WebviewViewProvider.resolveWebviewView` options.
- **Persist state.** Use `retainContextWhenHidden: true` for a cheap always-live panel, OR (preferred for memory) `acquireVsCodeApi().getState()/setState()` to restore the view after it's disposed. Design the webview so it can rebuild from `getState()` + a `hydrate` message.
- **`postMessage` is fire-and-forget & only delivered when live.** For request/response, correlate with an `id` and have the webview post a reply. Target vscode `engines` ≥ 1.57 so `ArrayBuffer` transfers efficiently (we mostly send JSON).
- HTML served by the provider must be a full document; inject nonce + `asWebviewUri` links at build/serve time.

## Theming (must feel native)
- Style through **VS Code theme CSS variables** (`--vscode-foreground`, `--vscode-editor-background`, `--vscode-sideBar-background`, `--vscode-panel-border`, `--vscode-button-background`, `--vscode-focusBorder`, `--vscode-editor-font-family`, …). The body also gets `.vscode-light` / `.vscode-dark` / `.vscode-high-contrast` classes — support all.
- Our brand accent (teal) is a fixed token layered on top of `--vscode-*` surfaces, so it reads as "ours" while surfaces follow the user's theme.
- React to `ColorThemeKind` changes if we compute anything theme-dependent host-side.
- **Icons:** use **codicons** (`@vscode/codicons`) bundled locally and referenced via `asWebviewUri` — NOT Material Symbols / external icon fonts (that was the Stitch drift).

## Activation & contributions
- **Contribute a view container + webview view**: `contributes.viewsContainers.activitybar` + `contributes.views.<container>` with `"type": "webview"`. VS Code auto-generates the `onView:<id>` activation event for contributed views, so **`activationEvents` can stay minimal/empty** — do NOT use `"*"`.
- Keep activation lazy: the extension wakes when the Talaria view is opened.
- Register commands in `contributes.commands`; surface them in `contributes.menus` (e.g. `view/title` "New Session" with a codicon `$(add)`).
- User settings go in `contributes.configuration` (read via `workspace.getConfiguration`), e.g. `talaria.pythonPath`, `talaria.cwd`.

## Bundling
- **Two bundles.** Host: esbuild → `dist/extension.js` (CommonJS, `external: ['vscode']`, `platform: node`). Webview: Vite (React) → `dist/webview/` (ES modules, single entry).
- Ship only `dist/` + `media/` (+ codicons); `.vscodeignore` excludes source/node_modules.
- Provide watch tasks + F5 launch config so dev = press F5 → Extension Development Host.

## Process model (later, real backend)
- The extension host spawns Hermes as child processes (`hermes acp` + `python -m tui_gateway.entry`) — **Fedora/Linux target**, resolve PATH via login shell. For now this is behind a `MockBackend`; nothing spawns until we wire the real one.

## Non-negotiables recap
No external network from the webview · nonce on every script · codicons not Material · `--vscode-*` theming · lazy activation (no `"*"`) · two bundles · mock-first so it runs on any OS with no Hermes.
