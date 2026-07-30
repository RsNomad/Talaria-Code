import * as vscode from 'vscode';
import type {
  ContextRef,
  ControlRequestMethod,
  EditPolicyPreset,
  HostToWebviewMessage,
  HydrateTabSeed,
  SlashCommandInfo,
  WebviewToHostMessage,
  ThemeInfo,
  ThemeKind,
  WebviewState,
} from '../shared/protocol';
import { AgentBackend } from './backend/AgentBackend';
import { getNonce } from './util/nonce';
import { buildSearchFilesResponse } from './context/searchFilesResponse';
import type { FindFilesFn } from './context/searchFilesResponse';
import { buildDiffUriParts } from './preview/parseDiffUri';
import type { NextEditTogglePort } from '../shared/nextEditTogglePort';
import type { NextEditToggleState } from '../shared/protocol';
import { redactControlResponse } from './redactControlResponse';

/** Fixed brand accent (teal), layered over `--vscode-*` surfaces in the view. */
const BRAND_ACCENT = '#14b8a6';

/** W2 T3 (§2e): `composer.seed` text is size-capped host-side before it ever
 * reaches the webview. */
const SEED_MAX_BYTES = 64 * 1024;

/**
 * PURE 64 KB seed-text cap (W2 T3, §2e "Seed text is size-capped host-side —
 * 64 KB, truncate + notice"). Measures UTF-8 BYTES (not JS string length —
 * `.length` undercounts multi-byte characters), truncates to `maxBytes`, and
 * appends a human-readable notice so a truncated seed is never silently
 * indistinguishable from a complete one. `seedComposer` is the only caller;
 * exported for the headless test.
 */
export function capSeedText(text: string, maxBytes: number = SEED_MAX_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const kept = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return { text: `${kept}\n\n…(truncated — seed exceeded 64 KB)`, truncated: true };
}

/**
 * PURE pending-seed latch decision (W2 T3, §2e): whether a `composer.seed`
 * push can go straight to the (live) webview, or must be latched until the
 * webview announces `ready` — the cold-activation race guard (a command
 * fired before the panel has ever been opened this session, or before its
 * React tree finished mounting, would otherwise silently drop the seed the
 * same way any other `postMessage` does when the view isn't live — see
 * `postToWebview`'s doc comment). Exported for the headless test.
 */
export function decideSeedDelivery(isWebviewLive: boolean): 'post' | 'latch' {
  return isWebviewLive ? 'post' : 'latch';
}

/**
 * P7-N12 · I-8: the five structural-capability guards this file used to
 * shadow-probe (`presetCapable`/`customModeCapable`/`commandsCapable`/
 * `tabsCapable`/`loadTabCapable`, each with its own duck-typed local
 * interface) are now typed OPTIONAL members directly on {@link AgentBackend}
 * (`setPreset?`/`getPreset?`/`setCustomMode?`/`getAvailableCommands?`/
 * `listTabs?`/`loadTab?` — see that file's "Optional structural
 * capabilities" section). Only the real `AcpBackend` implements any of them;
 * the mock backends implement none. Every call site below reaches for the
 * member directly (`this.backend.foo?.(...)` / `this.backend.foo !==
 * undefined`) — behavior-identical to the old shadow-probes: an absent
 * optional is exactly the old probe returning `false`.
 */

/**
 * Hosts the Hermes React webview and is the ONLY bridge between it and the
 * {@link AgentBackend}. It is deliberately a dumb pipe:
 *
 * - backend → webview: forwards every {@link HostToWebviewMessage} from
 *   `backend.onMessage` verbatim via `postMessage`.
 * - webview → backend: decodes each {@link WebviewToHostMessage} and calls the
 *   matching imperative backend method.
 *
 * All the intelligence (mock playback, ACP translation) lives in the backend,
 * so this class is identical whether the backend is mock or real.
 *
 * ### Security (best-practices.md, non-negotiable)
 * - `enableScripts: true`, `localResourceRoots` scoped to `dist/webview`,
 *   `media`, and the bundled codicons — never the whole extension.
 * - Strict CSP `default-src 'none'` with a fresh per-load nonce; every script
 *   carries it; no inline handlers, no CDN, no remote fonts.
 * - Local resources referenced only through `asWebviewUri`.
 *
 * ### State (hydrate semantics — R-C4)
 * On every `resolveWebviewView`/`ready` the host posts `hydrate` with a compact
 * bootstrap snapshot (theme/preset/scalars). The TRANSCRIPT is not persisted
 * anywhere host-side: `retainContextWhenHidden` keeps the common hide/show
 * case alive in the webview itself, and a window reload deliberately starts
 * an empty chat (the live child process died with the window anyway).
 */
export class TalariaViewProvider implements vscode.WebviewViewProvider {
  /** View id contributed in package.json (Agent C) and used in `activate`. */
  public static readonly viewId = 'talaria.panel';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  /** Subscription to the CURRENT backend's `onMessage`; replaced on swap. */
  private backendMessageSub: vscode.Disposable;
  /** R-C4: latch — `ready` arms the backend once; re-created views must not
   * tear down and replace the LIVE session (backend.start() = full teardown +
   * session/new). Cleared when a start rejects (a later ready retries) and on
   * a backend swap with no open view. */
  private backendStarted = false;
  /**
   * W2 T2d (§2e): the `context.searchFiles` source — `WorkspacePort.findFiles`
   * from the trust-gated `vscode`-backed ports `extension.ts` constructs
   * alongside the real `ContextResolver`. `undefined` in the mock/untrusted
   * path (or before `extension.ts` wires it), in which case searches
   * honestly answer empty rather than erroring — the same graceful-degrade
   * posture every other W2 context source uses. Mutable (not a constructor
   * parameter property) so {@link setSearchFiles} can rewire it on a
   * mock→real backend upgrade, mirroring {@link setBackend}'s swap seam.
   */
  private searchFiles?: FindFilesFn;

  /**
   * W5.1 R5 (Task 13): the «Next Edit Suggestions» toggle capability, wired by
   * `extension.ts` once the Guard has hydrated (always LATER than this
   * constructor — hydration reads a `Memento` asynchronously), hence a setter
   * rather than a constructor parameter. `undefined` until then, and forever
   * in a build where next-edit failed to register: `nextEdit.toggle` is then
   * answered with an honest refusal instead of being forwarded to an agent
   * that does not own this state.
   */
  private nextEditToggles?: NextEditTogglePort;
  /** Subscription to {@link nextEditToggles}'s `onDidChange`; replaced (and
   *  disposed) if the port is ever rewired, so one push never becomes two. */
  private nextEditTogglesSub?: vscode.Disposable;

  /**
   * W2 T3 (§2e pending-seed latch): true once the CURRENT webview instance
   * has announced `ready`. Reset on every fresh `resolveWebviewView` (a
   * re-created view's React tree has not mounted yet, even though `this.view`
   * is immediately non-null) — this is deliberately a SEPARATE latch from
   * {@link backendStarted} (R-C4), which answers "has the backend been armed
   * for this session", not "is the webview currently able to receive a
   * message".
   */
  private isWebviewLive = false;
  /** W2 T3: the most recent `seedComposer` call that arrived before the
   * webview was live, delivered as soon as the next `ready` fires. At most
   * one seed is held — a second `seedComposer` before delivery overwrites
   * the first (last-wins; matches `postToWebview`'s no-queueing posture for
   * every other message type). */
  private pendingSeed?: { text: string; mentions?: ContextRef[] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private backend: AgentBackend,
    private readonly logger?: vscode.OutputChannel,
    searchFiles?: FindFilesFn,
  ) {
    this.searchFiles = searchFiles;
    // Backend → webview: relay every protocol message straight through.
    this.backendMessageSub = backend.onMessage((message) => this.postToWebview(message));
    // Re-broadcast theme changes so the webview restyles instantly.
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
    );
  }

  /**
   * Rewire the `context.searchFiles` source. `extension.ts` calls this
   * alongside {@link setBackend} in the `onDidGrantWorkspaceTrust` handler,
   * so a mock→real backend upgrade also brings `@file` search online
   * without requiring a view reload.
   */
  setSearchFiles(fn: FindFilesFn | undefined): void {
    this.searchFiles = fn;
  }

  /**
   * W5.1 R5 (Task 13): wire the next-edit toggle capability. Called by
   * `extension.ts` from the Guard-hydration continuation in
   * `registerTalariaAutocomplete`.
   *
   * Subscribes to the port's `onDidChange` and relays every ACCEPTED change
   * to the webview as a `nextEdit.state` push — the panel's ONLY source of
   * toggle state — then pushes the current state immediately so a panel that
   * mounted BEFORE hydration finished (the common cold-start ordering: the
   * view resolves fast, the Memento read lands a tick later) is corrected
   * rather than left showing the both-off boot default forever.
   */
  setNextEditToggles(port: NextEditTogglePort | undefined): void {
    this.nextEditTogglesSub?.dispose();
    this.nextEditTogglesSub = undefined;
    this.nextEditToggles = port;
    if (!port) return;
    const sub = port.onDidChange((state) => this.postNextEditState(state));
    this.nextEditTogglesSub = { dispose: () => sub.dispose() };
    this.disposables.push(this.nextEditTogglesSub);
    this.postNextEditState(port.getState());
  }

  /** Push the ratified toggles. A no-op when the view isn't live —
   *  `postToWebview` drops it, and the next `ready` re-pushes (see the
   *  `'ready'` case), so a dropped push can never leave the rows stale. */
  private postNextEditState(state: NextEditToggleState): void {
    this.postToWebview({ type: 'nextEdit.state', state });
  }

  /**
   * Swap the active backend at runtime. Used when Workspace Trust is granted
   * mid-session and the process-free mock is upgraded to the real
   * {@link AcpBackend} (security-review.md C1 / trust-gating in `extension.ts`).
   * Re-points the `onMessage` relay at the new backend; if the panel is already
   * open, clears the transcript and starts a fresh session on it. The caller
   * owns disposing the OLD backend.
   */
  setBackend(backend: AgentBackend): void {
    this.backendMessageSub.dispose();
    this.backend = backend;
    this.backendMessageSub = backend.onMessage((message) => this.postToWebview(message));
    // D2 (A2): a connection-global scalar push, mirroring `postTheme()` —
    // NOT a re-`hydrate` (seedState() hardcodes activePanel:'chat', which
    // would yank the user's open panel on the very swap that is supposed to
    // be invisible except for the badge). This is the only signal the
    // trust-upgrade mock->acp swap gets; `WebviewState.backendKind` at the
    // next genuine hydrate is the OTHER half of the pair.
    this.postToWebview({ type: 'backend.state', kind: backend.kind });
    if (this.view) {
      // T-1 (V-12 RESTART-STATE): no host-side `clear` here anymore — the
      // retired `PENDING_SESSION_PLACEHOLDER` was a dead letter
      // (`foldSessionScoped`'s drop-unknown routing discarded it; no tab is
      // ever bound to that literal string). Transcript honesty on restart
      // is now the ACP backend's own job: `ConnectionSupervisor`'s restart
      // fan-out (`SessionController.endForRestart`) emits an honest,
      // session-scoped `clear`/`tab.error` per tab from `startBackend()`
      // below, once it actually knows which sessions are being replaced.
      this.startBackend();
    } else {
      this.backendStarted = false;
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    // W2 T3: a freshly-(re)resolved view's React tree has not mounted/sent
    // `ready` yet, even though `this.view` is now non-null — keep the
    // pending-seed latch closed until it actually does.
    this.isWebviewLive = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(
          this.extensionUri,
          'node_modules',
          '@vscode',
          'codicons',
          'dist',
        ),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Webview → backend: decode and dispatch.
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((raw: WebviewToHostMessage) =>
        this.handleWebviewMessage(raw),
      ),
    );

    // T3 review Minor (deliverable 8, folded into W2 T4): a memory-pressure
    // dispose (no reopen) previously left `this.view` stale and
    // `isWebviewLive` stuck `true` — a `seedComposer`/any `postToWebview` in
    // that window would silently post into the dead view instead of LATCHING
    // (the exact class `decideSeedDelivery`'s latch exists to prevent).
    // Clearing both here on dispose closes that window: the next `ready`
    // (from a freshly (re)resolved view) is what makes the webview live
    // again, exactly like the very first activation.
    this.disposables.push(
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.isWebviewLive = false;
      }),
    );

    // Seed the freshly-(re)created view.
    this.postTheme();
    this.postToWebview({ type: 'hydrate', state: this.seedState() });
  }

  /**
   * `talaria.newSession` command handler: start a fresh backend session.
   *
   * T-1 (V-12 RESTART-STATE): no host-side `clear` here anymore — see
   * {@link setBackend}'s matching doc for why the old
   * `PENDING_SESSION_PLACEHOLDER` pre-emit was a dead letter, and why the
   * ACP backend's own restart fan-out now owns transcript honesty instead.
   */
  newSession(): void {
    this.startBackend();
  }

  /**
   * W2 T3 (F-A code actions, §2e/§3.3): deliver a `composer.seed` push from
   * an editor action. SEED ONLY — this posts `composer.seed`, never a
   * `prompt` (the webview inserts the text into the DRAFT and the user
   * submits it themselves; review-first). Reveals the panel, then either
   * posts immediately (webview already live) or LATCHES until the next
   * `ready` (the cold-activation race — the command can fire before the
   * panel has ever been opened this session). Seed text is capped at 64 KB
   * host-side ({@link capSeedText}); a truncated seed also raises a warning
   * notification so the truncation is never silent.
   */
  seedComposer(seed: { text: string; mentions?: ContextRef[] }): void {
    const capped = capSeedText(seed.text);
    if (capped.truncated) {
      void vscode.window.showWarningMessage(
        'Talaria: the seeded prompt exceeded the 64 KB limit and was truncated.',
      );
    }
    const payload = { text: capped.text, mentions: seed.mentions };

    this.revealView();

    if (decideSeedDelivery(this.isWebviewLive) === 'post') {
      this.postToWebview({ type: 'composer.seed', text: payload.text, mentions: payload.mentions });
    } else {
      this.pendingSeed = payload;
    }
  }

  /**
   * F11: re-assign `webview.html` in response to the ErrorBoundary's Reload
   * button — the SAME nonce mint + html builder ({@link buildHtml}) the
   * initial `resolveWebviewView` uses, so this carries the identical CSP
   * (`default-src 'none'`, a fresh per-call nonce) and the identical script/
   * style `asWebviewUri`s; nothing weaker, no inline-script hole. Setting
   * `webview.html` again re-mounts a fresh (untripped) React tree — the
   * actual recovery mechanism, since the webview iframe has no VS-Code-
   * confirmed `window.location.reload()` navigation semantics. A no-op if
   * the view was torn down between the fallback's render and this message
   * arriving (memory-pressure dispose — see `onDidDispose` above).
   */
  private reloadWebview(): void {
    if (!this.view) return;
    // Match `resolveWebviewView`'s latch discipline (review T-17 MINOR-1): the
    // freshly re-mounted tree hasn't sent `ready` yet, so re-close the
    // pending-seed latch. A `seedComposer` arriving in the reload window then
    // latches into `pendingSeed` for `flushPendingSeed()` on the next `ready`
    // instead of being `postMessage`d into a mid-reload webview that drops it.
    this.isWebviewLive = false;
    this.view.webview.html = this.buildHtml(this.view.webview);
  }

  /** Start the backend, latching R-C4's ready-once behavior; a rejection
   * un-latches so the next `ready` (or command) can retry. */
  private startBackend(): void {
    this.backendStarted = true;
    void Promise.resolve(this.backend.start()).catch((err) => {
      this.backendStarted = false;
      this.logger?.appendLine(`[backend] start failed: ${String(err)}`);
    });
  }

  dispose(): void {
    try {
      this.backendMessageSub.dispose();
    } catch {
      /* ignore */
    }
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  // --- webview → backend routing --------------------------------------------

  private handleWebviewMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'ready':
        this.isWebviewLive = true;
        this.postTheme();
        this.postToWebview({ type: 'hydrate', state: this.seedState() });
        // R-C4: only the FIRST ready arms the backend. A re-created view
        // (memory-pressure dispose; retainContextWhenHidden is best-effort)
        // re-hydrates but must NOT replace the live ACP session.
        if (!this.backendStarted) this.startBackend();
        // W2 T3 (§2e): deliver any seed that arrived before this webview
        // instance was live (the cold-activation race).
        this.flushPendingSeed();
        // W5.1 R5 (Task 13): re-seed the Settings rows on every mount. The
        // panel holds no webview-side persistence, so a re-created view has
        // no idea which sources are on until this push lands.
        if (this.nextEditToggles) this.postNextEditState(this.nextEditToggles.getState());
        break;

      case 'prompt':
        this.backend.sendPrompt(message.sessionId, message.text, message.mode, message.attachments, message.mentions);
        break;

      case 'newSession':
        this.newSession();
        break;

      case 'reload':
        // F11: the ErrorBoundary fallback's "Reload" button. Documented,
        // host-driven recovery for a render-error'd webview — re-assign
        // `webview.html` through the SAME builder `resolveWebviewView` uses,
        // instead of the unverified/unreliable `window.location.reload()`
        // that used to run inside the webview iframe.
        this.reloadWebview();
        break;

      case 'cancel':
        this.backend.cancel(message.sessionId);
        break;

      case 'approval.respond':
        this.backend.respondApproval(message.sessionId, message.id, message.optionId);
        break;

      case 'diff.resolve':
        this.backend.resolveDiff(
          message.sessionId,
          message.toolId,
          message.hunkIndex,
          message.action,
        );
        break;

      case 'diff.open':
        this.openDiffPreview(message.sessionId, message.toolId, message.path);
        break;

      case 'setModel':
        this.backend.setModel(message.sessionId, message.modelId);
        break;

      // P7-N10: the legacy `setMode` wire message + its clamp-to-'default'
      // handler were YAGNI-deleted (a sessionId-less fan-out footgun, never
      // actually sent by the webview — presets replaced wire modes; the
      // mode picker uses the unrelated, sessionId-scoped `mode.set` message
      // below). Any stray/legacy `setMode` now falls through to the
      // `default:` unhandled-message log, which is harmless: it was already
      // a pure no-op re-confirmation of the default every session already
      // pins independently (constructor init + per-turn/per-load reassert).

      case 'policy.setPreset':
        // W2-F1: route the edit-policy preset switch to the backend's client-side
        // engine, when the active backend has one (the real AcpBackend). The
        // backend answers with an authoritative `policy.state` push.
        if (this.backend.setPreset) {
          this.backend.setPreset(message.sessionId, message.preset);
        } else {
          this.logger?.appendLine(
            `[policy] setPreset '${message.preset}' ignored — backend has no policy engine`,
          );
        }
        break;

      case 'mode.set':
        // SF-2 (T4b): route the custom-mode switch to the backend's engine,
        // when the active backend has one (the real AcpBackend). The
        // backend answers with an authoritative `mode.state` push, same
        // posture as `policy.setPreset` above.
        if (this.backend.setCustomMode) {
          this.backend.setCustomMode(message.sessionId, message.modeId);
        } else {
          this.logger?.appendLine(
            `[policy] mode.set '${String(message.modeId)}' ignored — backend has no custom-mode engine`,
          );
        }
        break;

      case 'tab.open':
        // W4 §2d/§7 B8: fire-and-forget from THIS caller's perspective — the
        // backend NEVER rejects (every failure path resolves after emitting
        // a terminal `tab.error`), so there is nothing to `.catch` here that
        // isn't already a programmer-error bug. A rejection would still be
        // logged rather than becoming an unhandled rejection.
        void this.backend
          .openTab(message.tabId)
          .catch((err) => this.logger?.appendLine(`[tab.open] ${message.tabId} failed: ${String(err)}`));
        break;

      case 'tab.close':
        // W4 §2d: only a BOUND tab has a session to close — a still-unbound
        // tab (its `tab.open` never resolved) carries no `sessionId`.
        if (message.sessionId) this.backend.closeTab(message.sessionId);
        break;

      case 'tab.activate':
        // W4 §2f (B6): panel re-scoping is driven by the EXPLICIT scope key
        // each panel fetch carries (`control.request` params), never by host-
        // side "which tab is active" bookkeeping — an ambient accessor is
        // exactly the eternal-spinner pattern B6 exists to kill. This message
        // therefore intentionally has no host-side effect today; it rides the
        // wire for protocol completeness / a future host-side need.
        break;

      case 'tab.load':
        // W4-T5b (§2d): a History-panel row loaded into a CHOSEN tab — NOT a
        // CONTROL_METHODS entry (it carries a tabId, invokeControl's
        // session.load does not), so it routes directly to the backend's
        // loadTab (T5a's hardened loadSessionIntoTab with an explicit tabId)
        // when the active backend supports it; no-ops for MockBackend (same
        // optional-member posture as `setPreset`/`setCustomMode` above).
        // loadTab itself never throws/rejects (mirrors tab.open's
        // fire-and-forget discipline) —
        // the `.catch` here is defense in depth only.
        if (this.backend.loadTab) {
          void this.backend
            .loadTab(message.tabId, message.sessionId, message.cwd)
            .catch((err) => this.logger?.appendLine(`[tab.load] ${message.tabId} failed: ${String(err)}`));
        } else {
          this.logger?.appendLine(`[tab.load] ${message.tabId} ignored — backend has no loadTab support`);
        }
        break;

      case 'switchPanel':
        // Side-panel activation → ask the backend for that panel's data. It
        // answers by emitting a `panel.data` message (push-driven, backend
        // agnostic). Superseded by the correlated `control.request` path
        // (Part X2) for webview-initiated fetches, but kept with a `.catch`
        // so any stray `switchPanel` can never become an unhandled rejection
        // (the eternal-spinner bug this zone fixed). Renamed from `switchTab`
        // (W4): from this wave on "tab" means a chat-session tab only.
        void this.backend
          .invokeControl('panel.data', { panel: message.panel })
          .catch((err) =>
            this.logger?.appendLine(`[switchPanel] ${message.panel} failed: ${String(err)}`),
          );
        break;

      case 'control.invoke':
        // Fire-and-forget control-plane passthrough (Tools/MCP/Skills/… actions).
        void this.backend
          .invokeControl(message.method, message.params)
          .catch((err) =>
            this.logger?.appendLine(
              `[control.invoke] ${message.method} failed: ${String(err)}`,
            ),
          );
        break;

      case 'control.request':
        // Correlated control-plane invocation (Part A2): run it and ALWAYS
        // reply with a `control.response` carrying the echoed `requestId`, so
        // the webview's pending promise resolves (ok:true) or rejects
        // (ok:false) — never hangs. This is the reference path checkpoint
        // restore + every panel fetch now use.
        void this.handleControlRequest(message.requestId, message.method, message.params);
        break;

      default:
        this.logger?.appendLine(
          `[webview] unhandled message: ${JSON.stringify(message)}`,
        );
    }
  }

  /**
   * W2 T4 (F-D, §3.5): open the read-only editor diff preview for a PENDING
   * edit approval. Both sides are `talaria-diff:` virtual documents — content
   * is served entirely by `DiffPreviewProvider` off the host-only
   * `EditPreviewRegistry` (never a file read); the REAL file is never a diff
   * side. `vscode.diff`'s title makes the pending/preview nature explicit so
   * it can never be mistaken for an ordinary file compare.
   */
  private openDiffPreview(sessionId: string, toolId: string, path: string): void {
    const before = vscode.Uri.from(buildDiffUriParts('before', sessionId, toolId, path));
    const after = vscode.Uri.from(buildDiffUriParts('after', sessionId, toolId, path));
    const basename = path.split('/').pop() || path;
    // F-3 (final-4way-fixes.md): still fire-and-forget (no caller awaits
    // this), but a rejection (e.g. no diff content provider registered) is
    // now logged instead of becoming an unhandled promise rejection —
    // matches every other command dispatch in this file (e.g. `tab.open`,
    // `switchPanel`).
    void vscode.commands
      .executeCommand(
        'vscode.diff',
        before,
        after,
        `${basename} (proposed by Talaria — pending approval)`,
        { preview: true },
      )
      .then(undefined, (err) => this.logger?.appendLine(`[diff.open] ${String(err)}`));
  }

  /**
   * Run a correlated control invocation and post its {@link ControlResponse}
   * back with the echoed `requestId` (Part A2). Both the resolved value and any
   * rejection are turned into a `control.response` — the webview NEVER waits
   * forever. `invokeControl` results are plain JSON (RPC results, a
   * `RestoreResult`, or `undefined`), so they are structured-clone-safe for
   * `postMessage`.
   */
  private async handleControlRequest(
    requestId: number,
    method: ControlRequestMethod,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      // W5.1 R5 (Task 13): `nextEdit.toggle` is HOST-INTERNAL and is
      // special-cased BEFORE backend dispatch (the `'panel.data'` /
      // `'context.searchFiles'` precedent). The NEXT/Generic toggles are
      // EXTENSION state — the Guard's `globalState` store — not Hermes
      // config, so this request must NEVER reach `AgentBackend.invokeControl`:
      // forwarding it would ask the agent to persist a setting it does not
      // own, cannot validate, and has no way to refuse correctly. Locked by
      // the zero-`invokeControl`-calls assertions in this file's test.
      const result =
        method === 'nextEdit.toggle'
          ? await this.handleNextEditToggle(params)
          : method === 'context.searchFiles'
            ? await this.handleSearchFiles(params)
            : await this.backend.invokeControl(method, params);
      this.postToWebview({ type: 'control.response', requestId, ok: true, result: redactControlResponse(method, result) });
    } catch (err) {
      this.logger?.appendLine(`[control.request] ${method} failed: ${String(err)}`);
      this.postToWebview({
        type: 'control.response',
        requestId,
        ok: false,
        error: { message: errorMessage(err) },
      });
    }
  }

  /**
   * W2 T2d (§2e): `context.searchFiles` is answered directly from the
   * injected {@link searchFiles} `WorkspacePort.findFiles`, NOT forwarded to
   * `backend.invokeControl` — file search never touches the agent, so the
   * mock/real backend distinction is irrelevant, and the port (not the
   * backend) is the thing that actually has a `vscode`-backed `findFiles`.
   * The pure query-coercion/clamping/secret-filtering contract lives in
   * `buildSearchFilesResponse` (headlessly tested); this is just the wiring.
   */
  /**
   * W5.1 R5 (Task 13): answer a `nextEdit.toggle` from the injected
   * {@link NextEditTogglePort}. Resolving carries the newly ratified state;
   * REJECTING carries the refusal message, which `handleControlRequest`'s
   * catch turns into `control.response{ok:false}` — the webview's pending
   * promise then rejects, the row's `rollbackField` visibly snaps the switch
   * back, and the reason renders inline. That inline row error is one half of
   * the owner's «alert in the user's face»; the Guard's own host-side warning
   * (shown from `applyOne`) is the other. One string, two surfaces.
   *
   * Params are re-validated here, not trusted: a compromised webview can post
   * any JSON, and `source`/`on` select which model serves next-edit. Anything
   * off-shape fails CLOSED — no toggle is attempted and nothing is persisted.
   */
  private async handleNextEditToggle(
    params: Record<string, unknown> | undefined,
  ): Promise<NextEditToggleState> {
    const source = params?.source;
    const on = params?.on;
    if ((source !== 'next' && source !== 'generic') || typeof on !== 'boolean') {
      throw new Error('Next Edit: malformed toggle request.');
    }
    if (!this.nextEditToggles) {
      throw new Error('Next Edit Suggestions are not available in this window.');
    }
    return this.nextEditToggles.request(source, on);
  }

  private handleSearchFiles(params: Record<string, unknown> | undefined): Promise<string[]> {
    if (!this.searchFiles) return Promise.resolve([]);
    return buildSearchFilesResponse(this.searchFiles, params ?? {});
  }

  // --- host → webview helpers -----------------------------------------------

  private postToWebview(message: HostToWebviewMessage): void {
    // Fire-and-forget; only delivered when the view is live (best-practices.md).
    void this.view?.webview.postMessage(message);
  }

  /**
   * W2 T3 (§2e): bring the panel into view for a `seedComposer` call. When a
   * `WebviewView` is already resolved this is a plain `show(true)`
   * (preserve focus in the editor — the user is mid-selection); with no view
   * yet at all (cold activation — the panel has never been opened this
   * session) VS Code auto-generates a `<viewId>.focus` command for every
   * contributed view, which resolves it.
   */
  private revealView(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand(`${TalariaViewProvider.viewId}.focus`);
    }
  }

  /** W2 T3 (§2e pending-seed latch): deliver + clear a seed that arrived
   * before the webview was live, once it announces `ready`. No-op if none is
   * pending (the common case). */
  private flushPendingSeed(): void {
    const seed = this.pendingSeed;
    if (!seed) return;
    this.pendingSeed = undefined;
    this.postToWebview({ type: 'composer.seed', text: seed.text, mentions: seed.mentions });
  }

  private postTheme(): void {
    this.postToWebview({ type: 'theme', theme: this.currentTheme() });
  }

  private currentTheme(): ThemeInfo {
    return {
      kind: themeKindName(vscode.window.activeColorTheme.kind),
      accent: BRAND_ACCENT,
    };
  }

  /** A clean bootstrap snapshot for `hydrate` on (re)create — scalars only (R-C4). */
  private seedState(): WebviewState {
    return {
      sessionId: null,
      theme: this.currentTheme(),
      mode: 'default',
      // D2 (A2): carry the LIVE backend kind so a (re)built view's "Mock"
      // badge starts correct instead of the honest-but-generic boot default
      // (`AppState.backendKind` in the webview) — see `WebviewState.
      // backendKind`'s doc for why this is REQUIRED, not optional.
      backendKind: this.backend.kind,
      // W2-F1: carry the backend's LIVE preset so a view (re)build shows the
      // real active policy (C4); falls back to the ask-everything boot default
      // when the active backend has no policy engine (mock).
      preset: this.activePreset(),
      currentModelId: null,
      activePanel: 'chat',
      // W2 F-S: hydrate carry — a re-created view gets the cached ACP
      // `available_commands` catalog without the adapter replaying it.
      // Absent/undefined until the first catalog arrives, or on a backend
      // with no commands seam (mock).
      availableCommands: this.availableCommands(),
      // W6-FF (3-way ARCH I-1): every LIVE session the registry currently
      // holds — lets the webview reconcile its WHOLE tab model on a
      // memory-pressure webview re-create (`retainContextWhenHidden` is
      // best-effort, :366) instead of orphaning them (drop-unknown). Absent
      // on a genuine cold boot (empty registry) or a backend with no
      // multi-tab registry (mock) — see {@link liveTabs}.
      tabs: this.liveTabs(),
    };
  }

  /** W2-F1: the backend's live edit-policy preset, or the boot default. */
  private activePreset(): EditPolicyPreset {
    return this.backend.getPreset?.() ?? 'manual';
  }

  /** W2 F-S: the backend's cached `available_commands` catalog, when it has one. */
  private availableCommands(): SlashCommandInfo[] | undefined {
    return this.backend.getAvailableCommands?.();
  }

  /**
   * W6-FF (3-way ARCH I-1): the backend's live tab list, or `undefined` when
   * there is nothing to reconcile — mirrors {@link availableCommands}'s
   * absent-vs-empty convention (an empty `[]` on the wire would be
   * indistinguishable from "reconcile to zero tabs", which is never the
   * intent; omitting it means "this hydrate carries no tab-list
   * information, keep whatever the webview already has").
   */
  private liveTabs(): HydrateTabSeed[] | undefined {
    const tabs = this.backend.listTabs?.();
    return tabs !== undefined && tabs.length > 0 ? tabs : undefined;
  }

  // --- HTML ------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'index.css'),
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        'node_modules',
        '@vscode',
        'codicons',
        'dist',
        'codicon.css',
      ),
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      // SEC-3 (audit-3 B-2): no `'unsafe-inline'`. All webview styling is
      // static stylesheets served under `${webview.cspSource}` (Vite's
      // extracted `index.css` + codicon.css, the two <link>s below) plus
      // React `style={{…}}` props — the latter are CSSOM property
      // assignments (`el.style.x = y`), which CSP style-src does NOT govern.
      // There is no literal `<style>`/`style=""` in the shell, no runtime
      // style injection (createElement('style')/insertRule/setAttribute),
      // no CSS-in-JS lib, and no dangerouslySetInnerHTML anywhere in the
      // webview — so nothing needs an inline allowance. Final acceptance is
      // a live F5 run (CSP is enforced only in a real webview host; tsc and
      // vitest are blind to it).
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${codiconUri}" rel="stylesheet" />
  <title>Talaria Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map VS Code's `ColorThemeKind` enum to the {@link ThemeKind} the webview themes on. */
function themeKindName(kind: vscode.ColorThemeKind): ThemeKind {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.Dark:
      return 'dark';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast';
    default:
      return 'dark';
  }
}
