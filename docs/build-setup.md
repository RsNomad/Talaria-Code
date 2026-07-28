# Build Setup & DevX (Agent C)

Owner: the build system + extension manifest. This documents how the two bundles
are produced, how F5 works, and the dependency approach. Lane: repo-root config
files + `.vscode/` + `media/hermes.svg` + this doc. Nothing under `src/**`,
`webview/**`, or other agents' docs.

## Dependency approach — ONE INSTALL via npm WORKSPACES

Decision: **npm workspaces**, so a single `npm install` at the repo root
bootstraps the whole project, while the host and webview keep separate,
non-overlapping dependency lists.

- Root `package.json` declares `"workspaces": ["webview"]` and holds only the
  **host tooling**: `esbuild`, `typescript`, `@types/vscode`, `@types/node`,
  `@vscode/vsce`, `concurrently`.
- `webview/package.json` (owned by Agent B) holds the **webview stack**:
  `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@types/react(-dom)`,
  `tailwindcss`, `postcss`, `autoprefixer`, `@vscode/codicons`.
- `npm install` at the root installs both (webview deps hoist into the root
  `node_modules/`). `npm run build:webview` does `cd webview && vite build`;
  npm puts the root `node_modules/.bin` on PATH so `vite` resolves.

Why workspaces (not one flat root `package.json`, and not two separate
installs): Agent B had already authored a self-contained `webview/package.json`.
Workspaces honor that split **and** still deliver the "one `npm install`" DevX
goal — no duplicate lockfiles, no per-package install step, no forcing Agent B
to delete their manifest. This is the single documented approach for the repo.

What this pins for the **webview** (already true on disk — do not change):
- **Tailwind v3** (`tailwindcss@^3.4` + `postcss` + `autoprefixer`) via classic
  `tailwind.config.js` + `postcss.config.js` — not the v4 `@tailwindcss/*` path.
- `vite.config.ts`: `build.outDir: '../dist/webview'`, `emptyOutDir: true`,
  `base: './'` so assets load through `asWebviewUri` (relative URLs).
- If webview deps change, edit `webview/package.json` (Agent B's lane), not root.

## The two bundles

### Host — esbuild (`esbuild.js`)
- Entry `src/extension.ts` → `dist/extension.js`.
- `format: cjs`, `platform: node`, `target: node18`, `external: ['vscode']`.
- Dev: sourcemaps on, no minify. `--production`: minify, no sourcemap.
- `--watch`: esbuild context watch; prints `[watch] build started/finished`
  markers consumed by the `tasks.json` background problem matcher.

### Webview — Vite (`webview/`, owned by Agent B)
- `npm run build:webview` runs `cd webview && vite build`.
- Outputs ES modules + CSS to `dist/webview/` (single entry).
- The host loads them via `webview.asWebviewUri`, with `localResourceRoots`
  pointing at `dist/` and `media/`, under a strict CSP + per-load nonce
  (Agent A's host code).

## Shared protocol path

`src/shared/protocol.ts` (owned by Agent D) is the source of truth.
- Host: `import { ... } from './shared/protocol'` (bundled by esbuild).
- Webview: currently uses a **local mirror** `webview/src/protocol.ts` (Agent B)
  so the webview builds independently during parallel scaffolding. Its header
  notes it must stay byte-identical to the shared module and should later become
  a re-export (`export * from '../../src/shared/protocol'`), which Vite bundles
  from outside the webview root without extra config.

The root `tsconfig.json` typechecks `src/**` (including `shared`); the webview
has its own `tsconfig` for JSX/DOM.

## `tsconfig.json`
Typecheck-only (`noEmit`) for `src/**`. `strict`, `target ES2022`,
`moduleResolution: bundler`, `jsx: react-jsx` (harmless for the host; lets the
shared file live alongside JSX-consuming code). esbuild/Vite do the actual
transpiling; `tsc --noEmit` (`npm run check-types`) is the type gate.

## F5 flow (the DevX goal)

1. `npm install` (once).
2. Press **F5** → launch config **"Run Extension"**.
3. `preLaunchTask: "npm: build"` builds both bundles into `dist/`.
4. VS Code opens the **Extension Development Host** with
   `--extensionDevelopmentPath=${workspaceFolder}`.
5. `activationEvents: []` + the contributed `hermes.panel` webview view →
   VS Code auto-generates `onView:hermes.panel`; opening the Hermes Activity Bar
   container activates the extension lazily.
6. The panel renders the webview with **mock data** — `hermes.backend` defaults
   to `mock`, so **no process is spawned**. Works on any OS, Windows included.

For live reload use **"Run Extension (watch)"** → `preLaunchTask: "npm: watch"`
(runs `watch:host` + `watch:webview` in parallel as background tasks); reload the
dev host window to pick up host changes.

## Packaging

- `npm run package` → `vsce package` → `.vsix`.
- `vscode:prepublish` runs the production host build + webview build.
- No runtime deps: everything is bundled. `.vscodeignore` ships only `dist/` +
  `media/` (+ `package.json`/`README.md`); it excludes `src/`, `webview/`,
  `docs/`, config, maps, and `node_modules/`.

## Files owned here

```
package.json          manifest + scripts + host deps + workspaces:[webview]
esbuild.js            host bundler
tsconfig.json         typecheck config for src/**
.vscode/launch.json   "Run Extension" (+ watch variant)
.vscode/tasks.json    build / watch (+ watch:host / watch:webview) tasks
.vscodeignore         package contents (ship dist/ + media/ only)
.gitignore            node_modules, dist, out, *.vsix
media/hermes.svg      teal Hermes activity-bar glyph
README.md             what it is + install + F5
docs/build-setup.md   this file
```
