# UX Improvements — Pass 1 (single source of truth)

Grounded in user feedback + best-practices (VS Code UX guidelines, opencode-vsc sidebar guide, Priority+ overflow pattern). Both sides build against THIS. Pin the full shapes — do not improvise the contract.

## Goals (what changes)
1. **Kill the double UI.** Remove the webview's own title/gear AppBar. The native VS Code view title bar ("TALARIA CODE") is the ONE top chrome. (VS Code guideline: don't repeat existing functionality / don't compete with native UI.)
2. **Priority+ responsive tabs.** The panel tabs (Chat/Tools/MCP/Skills/Checkpoints/Subagents/Models) show as many as fit; collapse to icon-only; overflow the rest into a `…` kebab menu on the RIGHT. Driven by `ResizeObserver`. Keyboard-accessible.
3. **Composer becomes the action hub** (bottom): attachments chip row, textarea, and a toolbar with attach + mode + model + New Session + Send/Stop. Drag-resizable height, persisted. Narrow-width collapses labels to icons.
4. **File attachments (real upload).** 📎 attach menu + drag-drop + paste-image → chips above the textarea. Hermes supports image/pdf/file input (`image.attach`/`pdf.attach`/`file.attach`, ACP image cap). Mock just acknowledges.
5. **Centered Talaria hero** on empty state (no transcript): logo/icon + one line + 2–3 starter chips, flex-centered, responsive to panel size. Replaces the persistent top banner.
6. **@-mention menu** (client-side this pass): typing `@` opens a small menu (file/folder/problems/terminal/selection); inserts a token into the textarea. No backend wiring yet. Keep it lean (Hermes reads the FS itself).

## Layout target (narrow sidebar, 300–420px first)
```
[ TALARIA CODE               ⚙ ]   ← native VS Code view title bar (NOT ours)
[ Chat  Tools  Mcp  Skills  … ]   ← Priority+ tabs, overflow kebab on right
        ◆ Talaria                  ← centered hero (empty state only)
     "What should Talaria do?"
   [ starter ] [ starter ]
├──────── transcript ─────────┤    (scrolls)
│  … streamed turn …          │
[ chip ] [ chip ]                  ← attachment chips (when present)
[ 📎 |  textarea ………………  ⏵ ]     ← attach • input • send/stop
[ Default ▾ ] [ Sonnet ▾ ]  [ + New session ]   ← controls row (collapses on narrow)
```

## PINNED CONTRACT ADDITIONS (both sides implement identically)
The shared-contract layer authors these in `src/shared/protocol.ts`; the webview layer mirrors them verbatim in `webview/src/protocol.ts`. Same names, same shapes.

```ts
/** A user-supplied attachment (upload), distinct from an @-mention (reference). */
export interface Attachment {
  id: string;
  name: string;
  kind: 'file' | 'image' | 'pdf';
  mime?: string;
  /** data: URI for images/pasted bytes. */
  dataUri?: string;
  /** Workspace path for file references dragged from the explorer. */
  path?: string;
}
```
- `WebviewToHost` `prompt` variant GAINS an optional field:
  `| { type: 'prompt'; text: string; mode: AgentMode; attachments?: Attachment[] }`
- `WebviewToHost` GAINS a new variant:
  `| { type: 'newSession' }`

Host handling:
- `TalariaViewProvider.handleWebviewMessage`: add `case 'newSession': this.newSession(); break;`. For `prompt`, pass `message.attachments` through.
- `AgentBackend.sendPrompt(text, mode, attachments?)` — add the optional 3rd param; `MockBackend` ignores attachments (logs count) and replays the canned turn as before.
- `package.json`: REMOVE `talaria.newSession` from `contributes.menus["view/title"]` (it moves into the composer — no duplicate native `+`). KEEP `talaria.openSettings` (gear) in `view/title`. Keep both COMMANDS registered (palette still works).

## Design rules (webview UI)
- Style through `--vscode-*` tokens + brand teal; support `.vscode-light/-dark/-high-contrast`; codicons only.
- Density > decoration. Truncate long labels. No layout that hides primary actions. No horizontal body scroll (inner regions scroll).
- Enter = send, Shift+Enter = newline. Send button toggles to Stop when `turnActive`.
- Composer height drag-resizable, persisted via `bridge.setState`.
- Priority+ tabs: measure with `ResizeObserver`; states visible → icon-only → in-menu; kebab `…` on the right; roving focus, `Esc` closes menu, focus returns to trigger.
- Everything must still render from the canned MockBackend stream and the 7 `panel.data` payloads.

## Ownership (parallel-safe)
- **Webview UI:** `webview/src/**` only — remove `AppBar`; add `PriorityTabs` (replacing `PanelTabs` usage), `Composer` rebuild, `AttachMenu`, `MentionMenu`, `OverflowMenu`, `Hero`/empty-state; wire `App.tsx`; add the two contract additions to `webview/src/protocol.ts` mirror; update the standalone `mock/*` only if needed. Invoke skills: **frontend-design** + **Context7** (verify React/Vite/webview APIs at write-time).
- **Contract + host + manifest:** `src/shared/protocol.ts` (the two additions), `src/host/**` (provider `newSession` + attachments passthrough; `AgentBackend`/`MockBackend` signature), `package.json` (`view/title` dedupe). Invoke skill: **Context7** for the VS Code API.

## Definition of done
`npm run check-types` clean + `npm run build` emits both bundles. In F5: one native title bar (no webview duplicate), tabs overflow into `…` when narrow, composer holds attach/mode/model/new-session/send with drag-resize, empty state shows the centered Talaria hero, `@` opens the mention menu, and the canned turn + panels still work.
