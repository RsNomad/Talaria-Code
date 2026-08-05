import * as path from 'node:path';

import * as vscode from 'vscode';
import { TalariaViewProvider } from './host/TalariaViewProvider';
import { AgentBackend } from './host/backend/AgentBackend';
import { MockBackend } from './host/backend/MockBackend';
import { AcpBackend } from './host/backend/AcpBackend';
import type { HermesRuntimeConfig } from './host/runtime/resolveHermes';
import { registerTalariaAutocomplete } from './autocomplete';
import { createVsCodeNextEditConfigPort, migrateNextEditToggles } from './autocomplete/nextedit/guard';
import { createIndexer, type Indexer } from './rag/indexer';
import { RAG_SETTING_RELOAD } from './rag/ragReloadSettings';
import { selectBackendKind, shouldActivateLib, shouldActivateRag } from './host/trustGate';
import { SetupController } from './host/setup/SetupController';
import { createSetupControllerDeps, createVsCodeSetupHost } from './host/setupHost.vscode';
import { wireBackendFailureNudge } from './host/backendFailureNudge';
import { isHttpUrl } from './shared/url';
import type { AcpMcpServerStdio } from './host/backend/acp/acpClient';
import { CODEBASE_SEARCH_TOOL_NAME } from './mcp/toolSchema';
import { createLibServerHost } from './mcp/lsp/libServerHost';
import { buildLibMcpServer, createSharedLspToolState } from './mcp/lsp/tools';
import { createLibToolDeps } from './host/lib/libToolDeps.vscode';
import { CheckpointTracker, GitUnavailableError } from './host/checkpoints/CheckpointTracker';
import { HermesDashboardManager, type DashboardService } from './host/dashboard/HermesDashboardManager';
import { ContextResolver } from './host/context/resolver';
import { createVscodeContextPorts } from './host/context/ports.vscode';
import { TerminalCapture } from './host/context/terminalCapture';
import type { FindFilesFn } from './host/context/searchFilesResponse';
import { createGitPort } from './host/scm/gitPort';
import { registerEditorActions } from './host/commands/editorActions.vscode';
import type { SeedTarget } from './host/commands/editorActions';
import { TalariaCodeActionProvider } from './host/commands/TalariaCodeActionProvider';
import { registerDiffDecisionCommands } from './host/commands/diffDecision.vscode';
import { EditPreviewRegistry } from './host/preview/EditPreviewRegistry';
import { DiffPreviewProvider, TALARIA_DIFF_SCHEME } from './host/preview/DiffPreviewProvider';
import { registerGenerateCommitMessageCommand } from './host/scm/generateCommitCommand.vscode';
import { createTestApi, type TalariaTestApi } from './host/testApi';

/**
 * P7-N12 · I-9 — the shape a trust-gated MCP-server zone (RAG, LIB, and any
 * future one) is configured with: a `talaria.<section>.enabled` toggle, an
 * `enabled ∧ hasWorkspace ∧ isTrusted` gate, and a log prefix for the
 * "why not started" line. See {@link registerTrustGatedZone}.
 */
interface TrustGatedZoneOptions {
  /** The `talaria.<section>` config namespace this zone's `enabled` flag
   * lives under (`talaria.rag` / `talaria.lib`) — also the exact key echoed,
   * verbatim, in the "disabled" reason string. */
  readonly configSection: 'talaria.rag' | 'talaria.lib';
  /** Log-line prefix (`Talaria RAG` / `Talaria LSP` — LIB's zone is
   * architecturally "LIB" but has always logged as "Talaria LSP"; preserved
   * verbatim by this refactor, not renamed). */
  readonly logPrefix: string;
  /** Read fresh on every eligibility check (never cached) — same posture the
   * original per-zone closures already had. */
  readonly hasWorkspace: () => boolean;
  readonly isTrusted: () => boolean;
  readonly shouldActivate: (enabled: boolean, hasWorkspace: boolean, isTrusted: boolean) => boolean;
  readonly output: vscode.OutputChannel;
  /**
   * The zone's actual start logic — invoked ONCE, the first time eligibility
   * passes. Deliberately left to the caller: RAG's `activateCodebaseRag` is
   * fire-and-forget (its own try/catch covers the index-build step) while
   * LIB awaits `libHost.start()` and needs its own `.catch` — those two
   * shapes differ enough that folding them into this helper would obscure a
   * real difference (per the brief's own escape hatch); only the identical
   * latch→eligibility→log ceremony above `start()` is centralized here.
   */
  readonly start: () => void;
}

/**
 * P7-N12 · I-9 — the
 * identical latch→eligibility→log ceremony Zone RG (RAG) and Zone LIB each
 * hand-duplicated ("a 2nd MCP server means a 3rd copy"). Behavior-preserving
 * extraction: the SAME `enabled` config read, the SAME `shouldActivate*`
 * gate, the SAME three-way "disabled / no workspace / not trusted" reason
 * string, and the SAME once-only latch every zone had before this
 * extraction — only centralized into one place. Returns a `run()` function
 * the caller invokes once at activation time and again, idempotently
 * (latch-guarded), from `onDidGrantWorkspaceTrust` — the CALL ORDER between
 * zones (RAG before LIB) is still whatever order the caller invokes the
 * returned functions in; this helper only owns the per-zone gate, not
 * cross-zone sequencing.
 */
function registerTrustGatedZone(opts: TrustGatedZoneOptions): () => void {
  let started = false;
  return () => {
    if (started) return;
    const enabled = vscode.workspace.getConfiguration(opts.configSection).get<boolean>('enabled', true);
    if (!opts.shouldActivate(enabled, opts.hasWorkspace(), opts.isTrusted())) {
      const reason = !enabled
        ? `disabled (${opts.configSection}.enabled=false)`
        : !opts.hasWorkspace()
          ? 'no workspace open'
          : 'workspace not trusted (Restricted Mode)';
      opts.output.appendLine(`${opts.logPrefix}: not started — ${reason}.`);
      return;
    }
    started = true;
    opts.start();
  };
}

/**
 * Extension entry point.
 *
 * Wiring is intentionally tiny: pick a backend, hand it to the view provider,
 * register the view + commands, then bring the two independent zones
 * (autocomplete, codebase RAG) online alongside it. Activation is lazy — the
 * manifest declares the specific `onStartupFinished` event (package.json:25-27),
 * so activation is deferred until after VS Code's own startup, never `"*"`
 * (best-practices.md).
 *
 * Task 5 (onboarding-entrypoint-fix-architecture.md §4.2): returns a
 * {@link TalariaTestApi} ONLY when `context.extensionMode ===
 * vscode.ExtensionMode.Test` — a Task-6 `@vscode/test-electron` integration
 * smoke resolves this from `extensions.getExtension(id).activate()` to await
 * "webview ready" / "panel fetched with cause X" headlessly. Production
 * activation (`Production`/`Development` mode) always returns `undefined` —
 * no test surface leaks to real users.
 */
export function activate(context: vscode.ExtensionContext): TalariaTestApi | undefined {
  const output = vscode.window.createOutputChannel('Talaria Code');
  context.subscriptions.push(output);

  // ── Backend selection: the mock→real swap seam (TRUST-GATED) ─────────────
  // DEFAULT is the mock so the panel runs on any OS with no Hermes process
  // (pinned decision #4). `talaria.backend: "acp"` switches to the real
  // backend, which spawns `hermes acp` (Fedora/Linux only, per Zone ACP).
  //
  // SECURITY (security-review.md C1): the `acp` backend spawns child processes
  // via the (now machine-scoped) `talaria.pythonPath`/`talaria.cwd`. It is only
  // ever constructed in a TRUSTED workspace; otherwise we fall back to the
  // process-free mock. `selectBackendKind` is the single decision point.
  const readRuntimeConfig = (): HermesRuntimeConfig => {
    const hermesCfg = vscode.workspace.getConfiguration('talaria');
    return {
      hermesPath: hermesCfg.get<string>('hermesPath', '').trim() || undefined,
      pythonPath: hermesCfg.get<string>('pythonPath', '').trim() || undefined,
      cwd: hermesCfg.get<string>('cwd', '').trim() || firstWorkspaceRoot(),
    };
  };
  const configuredBackend = (): string =>
    vscode.workspace.getConfiguration('talaria').get<string>('backend', 'mock');

  // W1.5: the dashboard REST channel (adopt-or-spawn `HermesDashboardManager`)
  // powering the REAL Skills & Tools panels. Constructed ONLY in the acp path,
  // which only holds in a trusted workspace (`selectBackendKind`) — the same
  // process-spawn gate the ACP/tui_gateway children already sit behind, so it
  // never spawns in mock/untrusted. A#10: the OWNING `AcpBackend` disposes it
  // (`AcpBackend.dispose` -> `dashboard.dispose()`), so a trust-upgrade swap
  // (which disposes the old backend) also kills its dashboard — no separate
  // `context.subscriptions` entry that could outlive the backend. `dispose()`
  // kills any `serve` child we spawned; an adopted dashboard is left running.
  //
  // S3 (CWE-306/346): `talaria.dashboardAdopt` selects discovery strategy —
  // `'spawn-only'` (secure default) never adopts a foreign peer; `'shape'` is
  // the legacy INSECURE opt-in. Any unrecognised config value fails CLOSED to
  // the secure default rather than being cast/trusted.
  const createDashboard = (): DashboardService => {
    const cfg = vscode.workspace.getConfiguration('talaria');
    const port = cfg.get<number>('dashboardPort', 9119);
    const adopt: 'spawn-only' | 'shape' =
      cfg.get<string>('dashboardAdopt', 'spawn-only') === 'shape' ? 'shape' : 'spawn-only';
    return new HermesDashboardManager({ config: readRuntimeConfig(), port, adopt, logger: output });
  };

  // W2 T2d (§2a/§2d point 4): the real `ContextResolver`, gated EXACTLY like
  // `createCheckpointTracker`/`createDashboard` above — constructed only
  // inside `makeAcpBackend` (trusted workspace + `backend==='acp'`, the same
  // `selectBackendKind` decision point). The MockBackend path never calls
  // this, so it stays resolver-free by construction. `searchFilesPort` is
  // captured in the outer closure below so the SAME trust-gated
  // `WorkspacePort.findFiles` can also be wired into `TalariaViewProvider`'s
  // `context.searchFiles` handler (§2e) — a separate seam from the resolver
  // (the resolver lives inside `AcpBackend`; search doesn't touch the agent
  // at all), but gated by the identical condition.
  let searchFilesPort: FindFilesFn | undefined;

  // W2 T4 (F-D, §3.5): the host-only, ask-path-scoped diff-preview registry.
  // ONE shared instance for the extension's lifetime — constructed here
  // (before any backend), injected into every `AcpBackend` `makeAcpBackend()`
  // builds (including the trust-upgrade mock→real swap below), and read by
  // the ONE `DiffPreviewProvider` registered once, further down. Never reset
  // across a backend swap: the OLD backend's own `dispose()` ->
  // `teardownSession()` -> `cancelPendingApprovals()` already clears every
  // entry it owned before the swap replaces it, so nothing stale survives.
  const editPreviewRegistry = new EditPreviewRegistry();

  const makeAcpBackend = (): AcpBackend => {
    const terminalCapture = new TerminalCapture(output);
    context.subscriptions.push(terminalCapture);
    const ports = createVscodeContextPorts(terminalCapture, createGitPort());
    searchFilesPort = ports.workspace.findFiles;

    return new AcpBackend(
      readRuntimeConfig(),
      output,
      undefined,
      createCheckpointTracker(context, output),
      createDashboard(),
      new ContextResolver(ports),
      editPreviewRegistry,
    );
  };

  let backend: AgentBackend =
    selectBackendKind(configuredBackend(), vscode.workspace.isTrusted) === 'acp'
      ? makeAcpBackend()
      : new MockBackend();
  context.subscriptions.push(backend);

  // ── Task 11 (A): "Open Backend Setup" nudge on the existing backend- ─────
  // failure surface. `wireBackendFailureNudge` (pure, `vscode`-free — see
  // its own doc) taps `backend.onMessage`'s `system.error` case, the ONLY
  // host-emitted signal that already fires on a `resolveHermes` throw /
  // spawn failure / `initialize()` failure (`ConnectionSupervisor
  // .startInternal`'s catch block). Rewired on every trust-upgrade mock→real
  // swap below (mirrors `setBackend`'s own `backendMessageSub` re-point) so
  // the nudge always tracks whichever backend is CURRENT.
  let backendFailureNudgeSub = wireBackendFailureNudge(backend, {
    showErrorMessage: (message, action) => vscode.window.showErrorMessage(message, action),
    // The brief's own pin: reuse the `talaria.openSetup` COMMAND path
    // (registered below) rather than calling `provider.openSetupPanel()`
    // directly — keeps this nudge decoupled from the view provider.
    openSetup: () => void vscode.commands.executeCommand('talaria.openSetup'),
  });
  context.subscriptions.push({ dispose: () => backendFailureNudgeSub.dispose() });

  // ── CF-09 / L5 F-5: prompt "reload to apply" on talaria.backend change ───
  // Backend selection above is resolved ONCE at activate() (re-evaluated
  // only via `makeAcpBackend` on a trust grant). The README's onboarding
  // step 3 tells the user to flip `talaria.backend` from `mock` to `acp` —
  // without this listener nothing reacts until a manual reload, which reads
  // as a silently-broken setting. A PROMPT (never an auto-reload, never a
  // live hot-swap of `backend` here) is the safe v1: respawn semantics plus
  // a possible in-flight session make a silent reload dangerous, and
  // re-deriving the backend live is out of scope — this listener only ever
  // asks. Only the `talaria.backend` key triggers it (every other config
  // key is ignored). Disposed via `context.subscriptions` like every other
  // listener in this function — no leak.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('talaria.backend')) return;
      void vscode.window
        .showInformationMessage(
          'Talaria: backend setting changed — reload the window to apply.',
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    }),
  );

  // ── §7: prompt "reload to apply" on a reload-gated talaria.rag.* change ──
  // Mirrors the `talaria.backend` listener directly above: all 8
  // `talaria.rag.*` settings are read exactly once, at activation
  // (`activateCodebaseRag` below), and captured into the
  // indexer/MCP-server opts — see `RAG_SETTING_RELOAD` in
  // `./rag/ragReloadSettings` for the exhaustive per-key classification and
  // why each one is currently `'reload'` (none is re-read live). This
  // listener walks THAT list rather than hardcoding keys, so a future
  // `talaria.rag.*` addition is forced to be classified there (pinned by
  // `ragReloadSettings.test.ts` against `package.json`) before it can be
  // silently skipped here. Only `'reload'`-classified keys trigger the
  // prompt; a `'live'` key (none exist today) would be intentionally
  // excluded. A PROMPT ONLY — never an auto-reload, same rationale as the
  // backend listener above. `.some(...)` collapses a single
  // `onDidChangeConfiguration` event touching several rag keys at once into
  // exactly one prompt (no per-key duplicate).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const anyReloadKeyAffected = Object.entries(RAG_SETTING_RELOAD).some(
        ([key, classification]) =>
          classification === 'reload' && e.affectsConfiguration(`talaria.rag.${key}`),
      );
      if (!anyReloadKeyAffected) return;
      void vscode.window
        .showInformationMessage(
          'Talaria: RAG setting changed — reload the window to apply.',
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    }),
  );

  // ── View provider ────────────────────────────────────────────────────────
  const provider = new TalariaViewProvider(
    context.extensionUri,
    backend,
    output,
    searchFilesPort,
  );
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TalariaViewProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── Task 9: Setup / Talaria Config controller ────────────────────────────
  // Backend-AGNOSTIC by design (works under `mock` AND `acp` — Setup's whole
  // job is bootstrapping FROM mock): constructed once here from the real
  // vscode-backed `SetupHost` + Task 3-7 engine deps (`setupHost.vscode.ts`,
  // deliberately outside `src/host/setup/` — see that file's own doc), wired
  // into the view provider the same way the nextEdit toggle port is
  // (`setSetupController`), and disposed via `context.subscriptions` like
  // every other host-owned resource in this function.
  // Task 13: the Provider card's authMethods seam — a THUNK over the outer
  // `backend` binding (not a snapshot), read at every `status()` call, so the
  // trust-upgrade mock→real swap below (`backend = upgraded`) and every
  // `talaria.newSession` re-initialize are reflected automatically. Optional
  // chaining because only the real `AcpBackend` implements the capability
  // (`AgentBackend.getAdvertisedAuthMethods?`) — under mock this yields
  // `undefined` and the card honestly reads `waiting-agent`.
  const setupController = new SetupController(
    createVsCodeSetupHost(context),
    createSetupControllerDeps(() => backend.getAdvertisedAuthMethods?.()),
  );
  context.subscriptions.push({ dispose: () => setupController.dispose() });
  provider.setSetupController(setupController);

  // ── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('talaria.newSession', () =>
      provider.newSession(),
    ),
    // Task 9 (§6 entry point 3): the ONE state-aware Setup entry — command
    // palette + the view/title icon (package.json). First time = wizard
    // mood; later = the same cards as current-config editor (no separate
    // "restart" concept). Locked by `src/host/commandParity.test.ts`.
    vscode.commands.registerCommand('talaria.openSetup', () => provider.openSetupPanel()),
    // Audit H-1: both of these were DECLARED in package.json and registered
    // nowhere. `talaria.openSettings` is bound to a permanently visible gear on
    // the panel title (`package.json:197`, view/title, navigation@1), so every
    // click produced VS Code's "command 'talaria.openSettings' not found".
    // Locked by `src/host/commandParity.test.ts`.
    vscode.commands.registerCommand('talaria.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:syntinal.talaria-code'),
    ),
    vscode.commands.registerCommand('talaria.showLogs', () => output.show()),
  );

  // ── W2 T4 (F-D, §3.5): read-only proposed-edit diff preview ──────────────
  // The `talaria-diff:` virtual-document provider + its editor-title Accept/
  // Reject commands. Registered ONCE, unconditionally (never gated behind
  // trust/`talaria.ready` like the editor actions below) — both are inert
  // until a `diff.open` actually fires, which only ever happens from a LIVE
  // pending-approval DiffCard in the real backend; registering them earlier
  // is harmless (no fs/process touch) and, unlike the editor actions, they
  // are never re-registered on a later trust grant, so there is no
  // double-registration hazard to guard against here.
  const diffPreviewProvider = new DiffPreviewProvider(editPreviewRegistry);
  context.subscriptions.push(diffPreviewProvider);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TALARIA_DIFF_SCHEME, diffPreviewProvider),
  );
  // `getBackend` is a thunk (not a snapshot) so the trust-upgrade mock→real
  // swap below (which reassigns the outer `backend` binding) is reflected at
  // invocation time — same posture as `startRagIfEligible`'s backend read.
  registerDiffDecisionCommands(context, () => backend);

  // ── W2 T3 (§3.3): `talaria.ready` context key = trusted ∧ real backend ────
  // The FULL gate (refines the S0 "always true" scaffolding): the SAME
  // trust+backend decision `selectBackendKind`/`makeAcpBackend` use above,
  // so `talaria.ready` is true iff the workspace is trusted AND
  // `talaria.backend` is actually `acp` — exactly the Cody `cody.activated`
  // pattern doc §3.3 pins. Drives the `editor/context` "Talaria" submenu's
  // `when: editorHasSelection && talaria.ready` (package.json) and gates the
  // editor-actions/QuickFix registration below. Re-computed and re-set on
  // `onDidGrantWorkspaceTrust` (below) since trust can only ever be granted
  // mid-session, never revoked.
  const isHermesReady = (): boolean => selectBackendKind(configuredBackend(), vscode.workspace.isTrusted) === 'acp';
  const updateReadyContext = (): void => {
    void vscode.commands.executeCommand('setContext', 'talaria.ready', isHermesReady());
  };
  updateReadyContext();

  // ── W2 T3 (§3.3): F-A code actions — editor submenu + QuickFix ───────────
  // CF-08 fix: these are the FIVE commands `package.json`'s
  // `contributes.commands` declares (palette-visible — no `when:false`
  // there), but the shipped DEFAULT is `talaria.backend: 'mock'`. Gating
  // REGISTRATION itself on `isHermesReady()` (as this used to) left them
  // palette-visible-but-unregistered on every default install: invoking one
  // gave VS Code's raw `command 'talaria.addToChat' not found` error on
  // first contact, instead of any message this extension controls. Fixed by
  // registering unconditionally, ONCE, at activation — `editorActionsTarget`
  // below is the actual gate now: it degrades to an honest "needs the real
  // Hermes backend" notice per invocation instead of seeding the composer,
  // whenever `isHermesReady()` is false, so a mock-mode invocation is never
  // silent and never raw-errors. The editor-context SUBMENU's OWN
  // `when: talaria.ready` (package.json) is UNCHANGED — it still correctly
  // hides in mock mode; this fix is only about what happens when the
  // commands are reached some other way (Command Palette, QuickFix).
  // `editorActionsRegistered` is now a plain idempotency latch (register
  // once), not an eligibility gate — the second call site below (on trust
  // grant) is a no-op after the first.
  let editorActionsRegistered = false;
  /**
   * A `SeedTarget` that wraps the real `provider` with the CF-08 degrade —
   * kept here (not in `editorActions.vscode.ts`) so the fix stays entirely
   * inside this file: `runSeedAction` (`editorActions.vscode.ts`) still
   * always finishes its own snapshot/secret-floor work before handing a seed
   * to `seedComposer`, exactly as before, but a seed only ever reaches the
   * REAL provider (and therefore the panel) when `isHermesReady()` is true.
   * `isHermesReady` is read at CALL time (not captured once), so a
   * trust-triggered mock→real upgrade takes effect on the very next
   * invocation — the same posture every other `isHermesReady()`/`getBackend`
   * thunk in this file already has.
   */
  const editorActionsTarget: SeedTarget = {
    seedComposer(seed) {
      if (!isHermesReady()) {
        void vscode.window.showWarningMessage(
          'Talaria: editor actions need the real Hermes backend (talaria.backend = "acp").',
        );
        return;
      }
      provider.seedComposer(seed);
    },
  };
  const registerEditorActionsOnce = (): void => {
    if (editorActionsRegistered) return;
    editorActionsRegistered = true;
    registerEditorActions(context, editorActionsTarget);
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider('*', new TalariaCodeActionProvider(), {
        providedCodeActionKinds: TalariaCodeActionProvider.providedCodeActionKinds,
      }),
    );
  };
  registerEditorActionsOnce();

  // ── W2 T5c (F-C, §3.4): commit-gen `scm/title` $(sparkle) command ────────
  // CF-08 fix: same posture as the editor actions above — register
  // UNCONDITIONALLY (once) so `talaria.generateCommitMessage` is never
  // palette-visible-but-unregistered under the default `mock` backend.
  // `runGenerateCommitMessage` (`generateCommitCommand.vscode.ts`) already
  // degrades correctly on its own: its `oneShotCapable(backend)` structural
  // check (only `AcpBackend` implements `oneShot`) reads `getBackend()` at
  // CALL time and shows the exact same "needs the real Hermes backend"
  // notice before doing anything else — no change needed there. The
  // `scm/title` button's OWN `when: talaria.ready` (package.json) is
  // UNCHANGED — it still correctly hides in mock mode; only reachability via
  // the Command Palette changes here.
  let generateCommitCommandRegistered = false;
  const registerGenerateCommitMessageCommandOnce = (): void => {
    if (generateCommitCommandRegistered) return;
    generateCommitCommandRegistered = true;
    registerGenerateCommitMessageCommand(context, () => backend, output);
  };
  registerGenerateCommitMessageCommandOnce();

  // ── Zone AC: inline (FIM) autocomplete ───────────────────────────────────
  // Self-registers its own disposables (config watcher, provider, secret) —
  // see src/autocomplete/index.ts. Safe in untrusted workspaces: no process
  // spawn, no FS walk, secret-classified documents are never completed (S4.1),
  // an API key is never sent over cleartext http to a remote host (S4.2), and
  // in Restricted Mode a remote (non-loopback) endpoint is skipped entirely
  // (S4.3) — only the default loopback path stays live untrusted. Reads
  // `talaria.autocomplete.*` itself.
  //
  // §5.3 one-time NEXT store migration (onboarding/setup Task 2): drain the
  // legacy `globalState` toggle pair into the `talaria.nextEdit.source`
  // setting, then delete the memento key — the delete is the latch, so every
  // later activation is a no-op. Fire-and-forget beside the Guard's own async
  // hydration: the Guard reads the setting live and reacts to the config
  // change this write produces, so no ordering between the two is needed. A
  // failed settings write keeps the memento (the latch is not burned) and
  // retries on the next activation.
  void migrateNextEditToggles(context.globalState, createVsCodeNextEditConfigPort()).then(
    undefined,
    (err: unknown) =>
      output.appendLine(
        `[nextEdit] toggle-store migration failed (will retry next activation): ${String(err)}`,
      ),
  );
  //
  // A5: `reportFailure` is the real implementation of provider.ts's injected
  // seam — every surfaced (actionable) autocomplete failure also gets one
  // line in the SAME `Talaria Code` output channel every other zone logs to.
  //
  // W5.1 R5 (Task 13): the third argument publishes the next-edit toggle
  // capability to the view provider once the Guard has hydrated, so the
  // Settings panel's «Next Edit Suggestions» rows can drive it over the
  // host-internal correlated `nextEdit.toggle` request. The port is built
  // inside `registerTalariaAutocomplete` (the only holder of the Guard) and
  // routes through `requestNextEditToggle`, never `guard.requestToggle`.
  registerTalariaAutocomplete(
    context,
    (msg) => output.appendLine(msg),
    (port) => provider.setNextEditToggles(port),
  );

  // ── Zone RG: codebase RAG indexer + MCP search server (TRUST-GATED) ──────
  // The indexer walks the workspace and POSTs file contents to an embeddings
  // endpoint, so it only runs in a trusted workspace (C1 exfil vector B).
  const startRagIfEligible = registerTrustGatedZone({
    configSection: 'talaria.rag',
    logPrefix: 'Talaria RAG',
    hasWorkspace: () => !!firstWorkspaceRoot(),
    isTrusted: () => vscode.workspace.isTrusted,
    // CF-05 / L5 F-6: `shouldActivateRag` now also gates on the backend
    // KIND — the mock backend has no agent that could ever call
    // `codebase_search`, so activating RAG under it would walk/embed/index/
    // watch the workspace for zero consumers. Read `backend` (the outer
    // `let` above) at CHECK time — same "current, not captured" posture as
    // the `start()` callback below and the trust-upgrade re-invocation from
    // `onDidGrantWorkspaceTrust`.
    shouldActivate: (enabled, hasWorkspace, isTrusted) =>
      shouldActivateRag(enabled, hasWorkspace, isTrusted, backend instanceof AcpBackend ? 'acp' : 'mock'),
    output,
    start: () => {
      // Zone RAG (pinned contract): register
      // `codebase_search` with whichever backend is CURRENT when this callback
      // fires — `backend` is the outer `let` above, so a trust-triggered
      // mock→real upgrade (below) is already reflected by the time it runs.
      // Returns whether it actually attached to a live `AcpBackend` — the
      // caller (`activateCodebaseRag`) uses this to keep its "registered"
      // log honest (CF-05: never claim registration that didn't happen).
      void activateCodebaseRag(context, output, (server) => {
        if (backend instanceof AcpBackend) {
          backend.setMcpServer('codebase_search', server);
          return true;
        }
        return false;
      });
    },
  });
  startRagIfEligible();

  // ── Zone LIB: read-only LSP-over-HTTP MCP server (TRUST-GATED) ───────────
  // Binds a loopback listener exposing live language-server intelligence
  // (diagnostics/definitions/references/symbols/hover) as read-only MCP
  // tools, so it only runs in a trusted workspace with an open folder —
  // mirrors Zone RG's trust gate exactly (`shouldActivateLib`, `trustGate.ts`).
  //
  // OWNERSHIP (research doc §4.1): `libHost` is constructed ONCE here and
  // pushed onto `context.subscriptions` — extension-host lifetime, deliberately
  // NOT owned/disposed by `AcpBackend` the way the dashboard is (`AcpBackend`
  // above). `start()` is idempotent (same port/token on every call), so this
  // singleton survives the mock→acp backend upgrade on trust-grant below, and
  // is exactly the seam a future W4 multi-session window reuses unchanged.
  //
  // S-1 fix: the
  // stateless HTTP transport (`server.ts`) calls `buildMcpServer` below on
  // EVERY POST/tool call, so `createSharedLspToolState()` — the concurrency
  // pool, first-empty indexing tracker, and doc-symbols LRU — is constructed
  // exactly ONCE here, at the composition root, and threaded through every
  // `createLibToolDeps` call. `buildLibMcpServer`/`createLibToolDeps`
  // themselves still run fresh per POST (the correct per-request McpServer
  // idiom) — only these three primitives are long-lived.
  const sharedLspToolState = createSharedLspToolState();
  const libHost = createLibServerHost({
    buildMcpServer: () => buildLibMcpServer(createLibToolDeps(output, sharedLspToolState)),
    log: (m) => output.appendLine(`Talaria LSP: ${m}`),
    // T-9 (squatter full closure, following up T-E1): the accessor already
    // burns on permanent-down (`libServerHost`'s own `advertisement()`
    // clears), but this session already captured a COPY below
    // (`backend.setMcpServer('vscode_lsp', advertisement)`) that would
    // otherwise be re-sent, token included, on every future
    // `session/new`/`session/load`/`session/resume` — to whatever now owns
    // the port. Withdraw it from whichever backend is CURRENT when this
    // fires — same outer-`let` re-target posture as the registration site
    // below and the RAG zone's `setMcpServer` call above.
    onPermanentDown: () => {
      if (backend instanceof AcpBackend) {
        backend.setMcpServer('vscode_lsp', undefined);
      }
      output.appendLine(
        'Talaria LSP: server permanently down — tool registration withdrawn for future sessions.',
      );
    },
  });
  context.subscriptions.push(libHost);

  const startLibIfEligible = registerTrustGatedZone({
    configSection: 'talaria.lib',
    logPrefix: 'Talaria LSP',
    hasWorkspace: () => !!firstWorkspaceRoot(),
    isTrusted: () => vscode.workspace.isTrusted,
    shouldActivate: shouldActivateLib,
    output,
    start: () => {
      // Init runs eagerly here (research doc §4.2) — there is no wire to add an
      // MCP server to a LIVE session, so registration must exist before the
      // webview-mount-triggered `AcpBackend.start()` races it. Bind first...
      void (async (): Promise<void> => {
        await libHost.start();
        const advertisement = libHost.advertisement();
        if (advertisement === undefined) {
          // Fail-soft (§4.1): a failed bind (or the one allowed same-port rebind
          // also failing) leaves LIB permanently down for this ext-host session —
          // no tools registered, nothing to un-register later.
          output.appendLine('Talaria LSP: bind failed — LIB stays down for this session.');
          return;
        }
        // ...then register with whichever backend is CURRENT when this resolves —
        // `backend` is the outer `let` above, same posture as `startRagIfEligible`,
        // so a trust-triggered mock→real upgrade is already reflected here.
        if (backend instanceof AcpBackend) {
          backend.setMcpServer('vscode_lsp', advertisement);
        }
      })().catch((err: unknown) => {
        output.appendLine(`Talaria LSP: unexpected start failure — ${String(err)}`);
      });
    },
  });
  startLibIfEligible();

  // ── Bring trust-gated features online if trust is granted mid-session ────
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      output.appendLine('Talaria: workspace trust granted — enabling trust-gated features.');
      // Upgrade mock → real backend if the user configured `acp`.
      if (
        selectBackendKind(configuredBackend(), true) === 'acp' &&
        !(backend instanceof AcpBackend)
      ) {
        const upgraded = makeAcpBackend();
        context.subscriptions.push(upgraded);
        provider.setBackend(upgraded);
        // `makeAcpBackend` just reassigned `searchFilesPort` (closure) to the
        // freshly-constructed trust-gated `WorkspacePort.findFiles` — rewire
        // the view provider's `context.searchFiles` source the same way
        // `setBackend` rewires the backend, so `@file` search comes online
        // on this trust-upgrade path too (§2e).
        provider.setSearchFiles(searchFilesPort);
        backend.dispose();
        backend = upgraded;
        // Re-point the Task 11 backend-failure nudge at the freshly-upgraded
        // backend — mirrors `setBackend`'s own `backendMessageSub` re-point
        // above; without this, a `system.error` on the NEW `AcpBackend`
        // (e.g. a respawn losing the connection later) would fire the OLD,
        // disposed mock's now-dead subscription instead.
        backendFailureNudgeSub.dispose();
        backendFailureNudgeSub = wireBackendFailureNudge(backend, {
          showErrorMessage: (message, action) => vscode.window.showErrorMessage(message, action),
          openSetup: () => void vscode.commands.executeCommand('talaria.openSetup'),
        });
        output.appendLine('Talaria: backend upgraded to AcpBackend.');
      }
      startRagIfEligible();
      // §4.2 ordering: the backend upgrade above (if any) and `startRagIfEligible()`
      // both happen BEFORE this — `startLibIfEligible` reads the CURRENT
      // `backend` (same closure-over-outer-`let` posture as RAG), so calling
      // it any earlier would risk registering the spec on the soon-disposed
      // Mock backend instead of the freshly-upgraded `AcpBackend`.
      startLibIfEligible();
      // W2 T3 (§3.3): re-derive `talaria.ready` now that trust flipped — the
      // Cody `cody.activated` re-set pattern (drives the package.json
      // `when: talaria.ready` submenu/button clauses, which are still
      // trust-gated). CF-08: the two `*Once()` calls below are now idempotent
      // no-ops here — both commands were already registered, unconditionally,
      // at activation — kept only so a hypothetical future call-order change
      // can't reintroduce a "registered nowhere" gap; `editorActionsTarget`'s
      // OWN `isHermesReady()` re-check (evaluated at every invocation, not
      // captured here) is what actually brings the degrade path online/offline
      // as trust changes.
      updateReadyContext();
      registerEditorActionsOnce();
      registerGenerateCommitMessageCommandOnce();
    }),
  );

  // ── Task 9 (§6 entry point 1): first-run auto-open once ──────────────────
  // `globalState['talaria.setup.autoOpened']` unset AND `talaria.backend`
  // still `mock` -> reveal the panel on the Setup screen, then set the flag.
  // The flag records the ATTEMPT (not completion) — it is set unconditionally
  // here, so this never re-fires on a later activation even if the user
  // closes the panel without finishing setup. `configuredBackend()` reads
  // the setting fresh (not the resolved `backend` binding, which the trust
  // gate may have downgraded to mock for an untrusted workspace even when
  // the SETTING itself already says `acp` — auto-open should only fire for
  // a genuinely unconfigured install, not a trust-gated one). Routed through
  // `setupController.shouldAutoOpen()`/`.markAutoOpened()` rather than
  // `context.globalState` directly — SetupController is the single owner of
  // the `talaria.setup.*` globalState namespace (coexistence.lock.test.ts's
  // R5 doc: this keeps direct `globalState.get`/`.update` call sites
  // confined to SetupController.ts/setupHost.vscode.ts, never extension.ts).
  if (setupController.shouldAutoOpen() && configuredBackend() === 'mock') {
    provider.openSetupPanel();
    void setupController.markAutoOpened();
  }

  output.appendLine(
    `Talaria Code extension activated (${backend instanceof AcpBackend ? 'AcpBackend' : 'MockBackend'}${
      vscode.workspace.isTrusted ? '' : ', Restricted Mode'
    }).`,
  );

  // Task 5 (§4.2): test-only observability surface, gated at the EXPORT by
  // ExtensionMode — an INSTALLED (.vsix) extension is always `Production`
  // (§4.1 limitation (c)), so this branch is unreachable outside a
  // `@vscode/test-electron` run. `provider.onWebviewSignal` already fires in
  // every mode (deliberately accepted, inert production emitter — §4.2); only
  // the export is mode-gated. beta.5 T16 (§5.5, S-F15): also wires
  // `getSetupData()` to `setupController.status()` ONLY — never `.handle()`.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    const t = createTestApi(provider.onWebviewSignal, () => setupController.status());
    context.subscriptions.push(t);
    return t.api;
  }
  return undefined;
}

/**
 * The most-recently constructed checkpoint tracker (Fix-A follow-up / A#10): held
 * at module scope ONLY so {@link deactivate} can flush its pending object
 * localization before shutdown. Set in {@link createCheckpointTracker}.
 */
let activeCheckpointTracker: CheckpointTracker | undefined;

export async function deactivate(): Promise<void> {
  // Everything registered in `context.subscriptions` (the backend + its
  // dashboard, the indexer, output channel) is disposed by VS Code
  // automatically. The one durability-sensitive step is the checkpoint
  // tracker's OFF-BARRIER object localization (Fix-A relocated `repack -a -d`
  // off the turn's critical path, leaving a residual window where a real-repo
  // `git gc` in the seconds before the debounced localization runs could orphan
  // a just-made checkpoint). Flushing it here on shutdown closes that window
  // (`CheckpointTracker.localizeAlternateObjects`'s note). Best-effort — never
  // throw out of deactivate.
  const tracker = activeCheckpointTracker;
  if (tracker) {
    try {
      await tracker.flushLocalization();
    } catch {
      /* best-effort durability flush on shutdown */
    }
    tracker.dispose();
  }
}

/**
 * Bring up the Zone RG indexer (extension-host side), register the
 * `codebase_search` MCP server (Zone RG's `dist/mcp/codebase-server.js`,
 * spawned by Hermes itself — never by the extension) via `registerMcpServer`,
 * then build the index. Requires `talaria.rag.enabled` and an open workspace;
 * no-ops otherwise (there is nothing to index, nothing to register).
 */
async function activateCodebaseRag(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  // CF-05: returns whether the server was ACTUALLY attached to a live
  // backend — the "registered" log below is conditioned on this, not on
  // merely having called the callback (see the caller's `start()`).
  registerMcpServer: (server: AcpMcpServerStdio) => boolean,
): Promise<void> {
  const ragCfg = vscode.workspace.getConfiguration('talaria.rag');
  const enabled = ragCfg.get<boolean>('enabled', true);
  const workspaceRoot = firstWorkspaceRoot();

  if (!enabled || !workspaceRoot) {
    output.appendLine(
      `Talaria RAG: ${!enabled ? 'disabled (talaria.rag.enabled=false)' : 'no workspace open'} — skipping indexer.`,
    );
    return;
  }

  const indexDirSetting = ragCfg.get<string>('indexDir', '.hermes/index') || '.hermes/index';
  const indexDir = path.isAbsolute(indexDirSetting)
    ? indexDirSetting
    : path.join(workspaceRoot, indexDirSetting);
  // May be a REMOTE embeddings node (by design). Only reject a non-http(s)
  // scheme / garbage and fall back to the default; no loopback allow-listing.
  const DEFAULT_EMBED_ENDPOINT = 'http://127.0.0.1:11434';
  const rawEmbedEndpoint = ragCfg.get<string>('embedEndpoint', DEFAULT_EMBED_ENDPOINT);
  const embedEndpoint = isHttpUrl(rawEmbedEndpoint) ? rawEmbedEndpoint : DEFAULT_EMBED_ENDPOINT;
  if (embedEndpoint !== rawEmbedEndpoint) {
    output.appendLine(
      `Talaria RAG: invalid embedEndpoint (not http/https) — falling back to ${DEFAULT_EMBED_ENDPOINT}.`,
    );
  }
  const embedModel = ragCfg.get<string>('embedModel', 'qwen3-embedding:0.6b');
  const dims = ragCfg.get<number>('dims', 0);
  const maxChunkTokens = ragCfg.get<number>('maxChunkTokens', 512);
  const debounceMs = ragCfg.get<number>('debounceMs', 500);
  const excludeGlobs = ragCfg.get<string[]>('excludeGlobs', []);

  // ── MCP server registration (Zone RAG) ────────────────────────────────────
  // Register `codebase_search` with the ACP backend BEFORE the (potentially
  // slow) initial index build below, so it's already known by the time
  // `AcpBackend.start()` fires `session/new` — which can happen as soon as
  // the webview mounts (`TalariaViewProvider`'s `ready` handler), independent
  // of how long indexing takes. Trust + `talaria.rag.enabled` gating already
  // happened above/in the caller (this function only ever runs when
  // `shouldActivateRag` said yes — see `startRagIfEligible`); no trust
  // decision is made here.
  //
  // PACKAGING (architecture-review.md P0 / wave-1.md "[PACKAGE — P0]"): spawn
  // via VS Code's OWN bundled Node (`process.execPath` + `ELECTRON_RUN_AS_NODE`)
  // instead of a bare `node` on PATH, so this works on a Fedora box with no
  // system Node install — the extension (and the child it hands this spec to)
  // is then fully self-contained. `process.execPath` inside Electron plus
  // `ELECTRON_RUN_AS_NODE: '1'` makes the same binary behave as plain
  // `node <script> <args>` (standard Electron/VS Code trick).
  const mcpServer = buildRagMcpServer({
    nodeExecPath: process.execPath,
    serverScriptPath: context.asAbsolutePath(path.join('dist', 'mcp', 'codebase-server.js')),
    indexDir,
    embedEndpoint,
    embedModel,
    dims,
  });
  // CF-05: log the "registered" claim ONLY when it actually happened — the
  // caller's callback returns `false` (never registers) whenever `backend`
  // isn't a live `AcpBackend` at the moment this runs, so this reports the
  // TRUE state instead of unconditionally claiming success.
  if (registerMcpServer(mcpServer)) {
    output.appendLine(
      `Talaria RAG: registered '${CODEBASE_SEARCH_TOOL_NAME}' MCP server (re-sent on every session/new).`,
    );
  }

  // The extension's OWN tree-sitter-wasms grammars — never the workspace's
  // (integration checklist #5 / wave-1.md task 5). `context.asAbsolutePath`
  // resolves relative to the installed extension, independent of cwd/OS.
  const grammarsDir = context.asAbsolutePath(
    path.join('node_modules', 'tree-sitter-wasms', 'out'),
  );

  const indexer: Indexer = createIndexer({
    workspaceRoot,
    indexDir,
    embedEndpoint,
    embedModel,
    dims,
    maxChunkTokens,
    debounceMs,
    extraIgnoreGlobs: excludeGlobs,
    grammarsDir,
  });

  context.subscriptions.push(indexer.watch());
  context.subscriptions.push({ dispose: () => indexer.dispose() });

  try {
    await indexer.build();
    output.appendLine('Talaria RAG: initial index build complete.');
  } catch (err) {
    output.appendLine(`Talaria RAG: initial index build failed — ${String(err)}`);
  }
}

/**
 * Build the `codebase_search` `AcpMcpServerStdio` value (Zone RAG). Pure
 * function of primitive config — no `vscode`/OS/FS touch — so it's
 * unit-testable without an extension host. Pinned shape:
 * `{name, command, args[],
 * env:[{name,value}]}` — `env` is a LIST of `{name,value}` pairs (ACP
 * `EnvVariable`), NOT a dict, unlike Node's own `child_process` env
 * convention.
 */
export function buildRagMcpServer(params: {
  nodeExecPath: string;
  serverScriptPath: string;
  indexDir: string;
  embedEndpoint: string;
  embedModel: string;
  dims: number;
}): AcpMcpServerStdio {
  return {
    name: CODEBASE_SEARCH_TOOL_NAME,
    command: params.nodeExecPath,
    args: [params.serverScriptPath],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'HERMES_INDEX_DIR', value: params.indexDir },
      { name: 'HERMES_EMBED_ENDPOINT', value: params.embedEndpoint },
      { name: 'EMBED_MODEL', value: params.embedModel },
      { name: 'HERMES_EMBED_DIMS', value: String(params.dims) },
    ],
  };
}

function firstWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Zone CKPT: construct + lazily initialize the extension-side checkpoint
 * tracker (shadow-git; `src/host/checkpoints/CheckpointTracker.ts`, frozen —
 * used, never modified). Storage dir = this extension's own storage path
 * (`context.globalStorageUri`, never the workspace); workspace root = the
 * first open folder.
 *
 * Both call sites are already inside the `selectBackendKind(...) === 'acp'`
 * branch, which only ever holds in a TRUSTED workspace (`trustGate.ts`) — so
 * this needs no separate trust check of its own, even though the tracker
 * spawns real `git` subprocesses with `cwd` inside the workspace (the same
 * "spawns processes against workspace content" risk class as the ACP backend
 * itself, security-review.md C1).
 *
 * `init()` is fire-and-forget here: it's also auto-invoked lazily by every
 * `CheckpointTracker` method, so activation never blocks on it. A rejection
 * (in particular `GitUnavailableError` — `git` not found on PATH) is only
 * logged here; `AcpBackend.refreshCheckpointsPanel` is what actually turns
 * ANY tracker failure into the panel's `available:false` state, so the exact
 * timing of this `.catch()` racing a panel open doesn't matter. On success,
 * also runs one opportunistic, non-blocking `cleanup()` (`git gc --prune`).
 */
function createCheckpointTracker(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): CheckpointTracker | undefined {
  const workspaceRoot = firstWorkspaceRoot();
  if (!workspaceRoot) {
    output.appendLine('Talaria Checkpoints: no workspace open — checkpoints disabled.');
    return undefined;
  }

  const tracker = new CheckpointTracker(context.globalStorageUri.fsPath, workspaceRoot);
  // Hold the latest tracker at module scope so `deactivate` can flush its
  // pending object localization on shutdown (A#10 durability window).
  activeCheckpointTracker = tracker;
  tracker
    .init()
    .then(() => {
      output.appendLine('Talaria Checkpoints: shadow-git tracker initialized.');
      void tracker.cleanup().catch((err: unknown) => {
        output.appendLine(`Talaria Checkpoints: cleanup failed — ${String(err)}`);
      });
    })
    .catch((err: unknown) => {
      const reason = err instanceof GitUnavailableError ? err.message : String(err);
      output.appendLine(`Talaria Checkpoints: unavailable — ${reason}`);
    });
  return tracker;
}
