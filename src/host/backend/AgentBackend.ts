import * as vscode from 'vscode';
import type {
  HostToWebviewMessage,
  AgentMode,
  Attachment,
  BackendKind,
  ContextRef,
  DiffAction,
  EditPolicyPreset,
  HydrateTabSeed,
  SlashCommandInfo,
} from '../../shared/protocol';

/**
 * The single seam between the extension host and *whatever* is driving Hermes.
 *
 * The host (see {@link ../HermesViewProvider}) never talks to a process or a
 * mock directly — it talks to an `AgentBackend`. That is what makes the
 * mock→real swap a one-line change in `extension.ts`:
 *
 * ```ts
 * // const backend = new AcpBackend(...);   // real, Fedora, spawns processes
 * const backend = new MockBackend();          // default, runs on any OS
 * ```
 *
 * ## Contract
 * - **Inbound (webview → host → backend):** the imperative methods below. The
 *   `HermesViewProvider` decodes `WebviewToHostMessage` and calls these.
 * - **Outbound (backend → host → webview):** the {@link onMessage} event. A
 *   backend emits fully-formed {@link HostToWebviewMessage} values; the provider
 *   forwards them verbatim over `postMessage`. Backends are responsible for
 *   *translating* their native events (mock timeline steps, ACP
 *   `session/update` notifications, tui_gateway events) into this one protocol.
 *
 * Keeping the outbound side as "already-protocol messages" means the provider
 * is a dumb pipe and every backend produces an identical webview experience.
 */
export interface AgentBackend extends vscode.Disposable {
  /**
   * D2 (A2 — architect decision memo §"Decision 2"): which backend this
   * instance IS — `MockBackend.kind = 'mock'`, `AcpBackend.kind = 'acp'`.
   * REQUIRED (no honest default exists for an absent value — see
   * `WebviewState.backendKind`'s doc for why). `HermesViewProvider` reads it
   * at hydrate-seed time (`seedState().backendKind`) and again on every
   * {@link ../HermesViewProvider.setBackend} swap (posts a `backend.state`
   * push) so the webview's "Mock" badge never lags the LIVE backend.
   */
  readonly kind: BackendKind;

  /**
   * Fires for every host→webview protocol message the backend produces.
   * The provider subscribes and relays each one to the webview unchanged.
   */
  readonly onMessage: vscode.Event<HostToWebviewMessage>;

  /**
   * Bring the backend online. For {@link MockBackend} this just arms the
   * scenario player; for the real `AcpBackend` this spawns `hermes acp`,
   * initializes the ACP connection, and opens a session.
   *
   * Safe to call again to start a *new* session (the provider calls it from the
   * `hermes.newSession` command after clearing the transcript).
   */
  start(): Promise<void> | void;

  /**
   * Send a user turn. `mode` is the approval policy the turn runs under
   * (`default` = ask, `accept_edits`, `dont_ask`). B2 (Tier-2 remediation
   * architecture §12.1, task T-13, doc fix): in the real backend, `mode` is
   * NOT mapped onto `session/set_mode` — every incoming turn is CLAMPED to
   * `'default'` (`SessionController.runTurn`'s `mode !== 'default'` clamp log
   * + `pinWireModeDefault`'s wire-pin re-assert), and `session/set_mode` is
   * only ever called to re-assert Hermes' OWN wire mode back to `'default'`
   * if it drifted — never to switch to whatever `mode` the caller passed.
   * `attachments` are the composer's uploaded files/images/pdfs (mapped to
   * ACP `image.attach`/`pdf.attach`/`file.attach` in the real backend; the
   * mock ignores them).
   *
   * `mentions` (W2 F-M, optional/additive — `docs/research/wave-2/
   * 00-architecture-and-paths.md` §2a/§2e) carries the composer's structured
   * `@`-mention refs. S0 scaffolding only: {@link MockBackend} ignores it and
   * `AcpBackend` accepts-but-does-not-yet-resolve it — the host-side
   * resolution seam (workspace confinement, secret gate, the pure mapper onto
   * outbound ACP content blocks) lands in a later task (T2).
   *
   * W4 §2d: every session-targeting method is `sessionId`-first now. S0
   * keeps exactly ONE implicit session end-to-end — the provider always
   * passes the single known sessionId (learned from `tab.bound`/`turn.start`)
   * — real per-tab routing is T1's job.
   */
  sendPrompt(sessionId: string, text: string, mode: AgentMode, attachments?: Attachment[], mentions?: ContextRef[]): void;

  /** Cancel the in-flight turn (real: ACP `session/cancel`). */
  cancel(sessionId: string): void;

  /**
   * Answer an inline command-approval request previously surfaced via an
   * `approval.request` message. `optionId` is one of the option ids that came
   * with the request (`allow_once` / `allow_session` / `deny` / …).
   */
  respondApproval(sessionId: string, id: string, optionId: string): void;

  /**
   * Resolve one hunk of a proposed edit diff (`tool.diff` message). Per-hunk
   * accept/reject is a hard UX requirement (spec §3.6).
   */
  resolveDiff(sessionId: string, toolId: string, hunkIndex: number, action: DiffAction): void;

  /** Switch the active model (real: ACP `session/set_model`). */
  setModel(sessionId: string, id: string): void;

  // P7-N10: `setMode(mode: AgentMode)` — a sessionId-less wire-mode fan-out
  // that mutated EVERY live session — was YAGNI-deleted from this interface
  // (and its implementations/wire handler). It was safe only because its
  // sole caller hardcoded 'default'; a future non-default caller would have
  // silently mutated every session, with no sessionId on the wire to scope
  // it. The user-facing mode picker is unaffected — it always used a
  // different, sessionId-scoped path (`mode.set` -> {@link setCustomMode}).

  /**
   * W4 §2d/§2e (Deliverable 5): open a fresh chat-session tab — mints a new
   * backend session and replies with a `tab.bound{tabId, sessionId, rootId}`
   * (real: `session/new`) or a terminal `tab.error{tabId, kind:'open-failed'}`
   * (§7 B8: `tab.open` MUST get a reply, or the tab's composer latches
   * disabled forever). NEVER throws/rejects back to the caller — failure is
   * always surfaced via the emitted `tab.error`, never a rejected promise.
   */
  openTab(tabId: string): Promise<void>;

  /**
   * W4 §2d/§2e (Deliverable 5): close a chat-session tab's backend session
   * (real: settles its pending approvals, best-effort `session/cancel`s any
   * live turn, disposes its controller — see `SessionRegistry.close`). A
   * no-op for a `sessionId` the backend does not recognize (a still-unbound
   * tab closed before its `tab.open` resolved has none to send).
   */
  closeTab(sessionId: string): void;

  /**
   * Thin passthrough to the control plane. In the real backend this dispatches
   * to the tui_gateway channel (`tools.list`, `skills.manage`, `rollback.list`,
   * …); the resolved value is the RPC result. Side-panel data is delivered by
   * emitting a `panel.data` message rather than by resolving here, so the UI
   * stays push-driven and identical across backends.
   */
  invokeControl(method: string, params?: unknown): Promise<unknown>;

  /** Tear down: unsubscribe listeners, kill child processes, clear timers. */
  dispose(): void;

  // ── Optional structural capabilities (P7-N12 · I-8) ───────────────────────
  // These five members are OPTIONAL — only the real `AcpBackend` implements
  // any of them; `MockBackend` implements none. `HermesViewProvider` reaches
  // for each with a plain `backend.foo?.(...)`/`backend.foo !== undefined`
  // check and no-ops (or falls back to a boot default) when it's absent — the
  // same backend-agnostic posture the rest of this interface's REQUIRED
  // members already keep, now with a typed home instead of a hand-rolled
  // `typeof backend.foo === 'function'` shadow-probe + duck-typed local
  // interface per capability (five of those had accumulated in
  // `HermesViewProvider.ts` — arch review `final-3way-2-arch.md` I-8: "promote
  // all five to optional `AgentBackend` members ... every future feature gets
  // a typed home instead of a new probe"). Behavior-identical: an absent
  // optional is exactly the old shadow-probe returning `false`.

  /** W2-F1: the client-side edit-policy engine — only the real `AcpBackend`
   * has one; the mock backends have none. */
  setPreset?(sessionId: string, preset: EditPolicyPreset): void;
  /** W2-F1: the backend's live edit-policy preset (paired with {@link setPreset}). */
  getPreset?(): EditPolicyPreset;

  /** W4-T4b (SF-2): the custom-mode engine — only the real `AcpBackend` has
   * one; `MockBackend` has none, so `mode.set` simply no-ops for it. */
  setCustomMode?(sessionId: string, modeId: string | null): void;

  /** W2 F-S: the cached ACP `available_commands` catalog — only the real
   * `AcpBackend` caches one; the mock backends have none. */
  getAvailableCommands?(): SlashCommandInfo[] | undefined;

  /** W6-FF (3-way ARCH I-1): the live `SessionRegistry` tab list — only the
   * real `AcpBackend` has a registry to list; the mock backends have none. */
  listTabs?(): HydrateTabSeed[];

  /** W4-T5b (§2d): route a History-panel row load into an EXPLICIT tab —
   * only the real `AcpBackend` can (T5a's hardened `loadSessionIntoTab`);
   * `MockBackend` has no session history to load, so this no-ops for it. */
  loadTab?(tabId: string, sessionId: string, cwd: string): Promise<void>;
}
