import { homedir } from 'node:os';
import type { BackendDescriptor, InstallRecipe, ProbeSpec } from './registry';
import { managerFor, parseOsRelease, resolveDistroFamily } from './osDetect';
import type { DistroFamily, OsRelease, PackageManager } from './osDetect';
import { installCommand, pythonInstallPlan } from './packageTable';
import type { PipxEnv, PipxLocateResult } from './pipxLocator';
import type { HermesPaths, InstallEvent } from './pipxInstaller';
import type { OllamaStatus, PullProgress } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import { validateEndpointUrl } from './remoteProbe';
import { AUTOCOMPLETE_API_KEY_SECRET } from '../../autocomplete/apiKey';
import type { AgentSetupPhase, SetupBackendOption, SetupData, SetupMethod, SetupProgress } from '../../shared/protocol';

/**
 * SetupController — the host-side brain for Setup / Talaria Config
 * (onboarding-backend-setup-architecture.md §7/§8, Task 9).
 *
 * PURE — no `vscode` import. Every OS/VS Code touch is reached through the
 * injected {@link SetupHost} seam (native modals/password input/terminals/
 * settings/secrets/globalState/trust) and the injected {@link
 * SetupControllerDeps} (the Task 3-7 engines, already bound to their own
 * spawn/fetch/fileExists adapters by the caller — see `src/host/
 * setupHost.vscode.ts`, which is deliberately NOT under `src/host/setup/` so
 * `registry.test.ts` (h)'s directory-scoped `vscode`-import purity scan never
 * has to look at it). This keeps the controller unit-testable with a fake
 * host and fake deps, with zero mocking of `vscode` itself.
 *
 * ## Security posture (binding — see plan §8)
 * - Every WRITE lands at `ConfigurationTarget.Global` — enforced by the
 *   REAL `SetupHost.updateSettingGlobal` implementation, not by this file
 *   (this file only ever calls `updateSettingGlobal`, never anything scope
 *   -aware).
 * - Every MUTATING method is refused when `!host.isTrusted()` (FM-14).
 *   Read-only reads (`status`, `setup.testRemote`, `setup.recheck`,
 *   `setup.cancel`) are exempt — §8: "read-only probes ... may run, keeping
 *   the status page honest in Restricted Mode."
 * - Every Tier-1 (consequence-bearing) mutation shows a native modal BEFORE
 *   doing anything; a decline is `{ok:false, reason:'declined'}` with
 *   PROVABLY no side effect (nothing is written/spawned before the modal
 *   resolves `true`).
 * - `setup.setTunable` writes ONLY a key on the {@link TIER2_TUNABLE_KEYS}
 *   allowlist (D9) — anything else is refused `{ok:false, reason:'not a
 *   tunable'}` (FM-16), no modal either way (Tier-2 is modal-free by
 *   design).
 * - `setup.install`/`setup.pullModel` are single-flight per `(op, id)` —
 *   FM-12 — tracked via {@link inFlight}, which ALSO holds each attempt's
 *   `AbortController` so `setup.cancel` can interrupt it.
 * - Fail-closed ORDER on install: `locatePipx` -> `installHermes` (which
 *   only resolves after its own `--check` verify passes) -> ONLY THEN are
 *   `hermesPath`/`pythonPath`/`backend` written together, THEN the
 *   `globalState` install record, THEN `offerReload()`.
 * - `locatePipx()` is `try/catch`-wrapped (T4 M-2 carry-forward): it can
 *   REJECT if pipx vanishes mid-flow, and that must never become an
 *   extension-host unhandled rejection.
 * - Secrets: `setup.setApiKey` only ever calls `secrets.store`/`.delete` —
 *   the raw key is NEVER placed on `SetupData` (only `apiKeySet: boolean`,
 *   sourced from `secrets.has()`) and NEVER logged. `SetupHost.secrets` has
 *   no `get` — by design, this controller can never read a stored key back
 *   (see {@link handleTestRemote}'s note on why a probe never carries one).
 * - Local filesystem paths in install/pull log lines and failure details are
 *   redacted (`~` for the real home dir) before ever reaching {@link
 *   pushProgress}/`SetupData` (T6 M-3 carry-forward).
 *
 * ## Provider card (Task 13 — wired)
 * The Provider card's real signal is the ACP `initialize` result's
 * `authMethods`, injected through {@link SetupControllerDeps.
 * getAdvertisedAuthMethods} (bound by `extension.ts` to a thunk over
 * `AgentBackend.getAdvertisedAuthMethods?.()` — never a backend import
 * here). Mapping (§2.1, {@link computeProviderCard}): `undefined` (no
 * initialize yet / mock backend) ⇒ `'waiting-agent'`; any advertised method
 * id ≠ `hermes-setup` ⇒ `'configured'` with `providerId` = that id; only
 * `hermes-setup` (or nothing) advertised ⇒ `'unconfigured'`. This is what
 * lets the composite `ready` signal genuinely fire once agent + provider +
 * FIM are all green.
 */

// --- Event/Disposable (vscode-free — structurally compatible with
// vscode.Event<T>/vscode.Disposable at the wiring boundary) --------------

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// --- SetupHost (the vscode seam — pinned interface, task-9-brief.md) ----

export interface SetupHost {
  showModal(message: string, confirmLabel: string): Promise<boolean>;
  showPasswordInput(prompt: string): Promise<string | undefined>;
  /** NOT executed — the terminal is pre-typed only; the user presses Enter. */
  createTerminal(name: string, preTypedCommand: string): void;
  /** The provider wizard — this one DOES run immediately (it's an interactive setup flow, not a sudo-gated install step). */
  runInTerminal(name: string, shellPath: string, shellArgs: string[]): void;
  getSetting<T>(key: string): T | undefined;
  updateSettingGlobal(key: string, value: unknown): Promise<void>;
  secrets: {
    store(key: string, v: string): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  };
  globalState: {
    get<T>(key: string): T | undefined;
    update(key: string, v: unknown): Promise<void>;
  };
  isTrusted(): boolean;
  offerReload(): void;
  /**
   * Task 11 (`setup.reload` — the `awaiting-reload` gap-state fix): reload
   * the extension host window immediately. Distinct from {@link
   * offerReload}, which shows an OPTIONAL post-install prompt the user can
   * dismiss — this seam is invoked from a PERSISTENT webview button the user
   * already clicked deliberately, so it reloads without a second
   * confirmation (trust-gated only — see {@link MUTATING_METHODS}).
   */
  reload(): void;
}

// --- D9 Tier-2 allowlist (data, locked by test) --------------------------

/**
 * D9 Tier-2 tunables — trust-gated + host-validated writes, NO modal.
 * `talaria.autocomplete.crossFile.prefixInjectionRemote` is DELIBERATELY
 * absent — D9 pins it Tier-1 (it changes whether workspace snippets can
 * egress to a remote endpoint, not a cosmetic tuning).
 */
export const TIER2_TUNABLE_KEYS: readonly string[] = [
  'talaria.autocomplete.debounceMs',
  'talaria.autocomplete.maxPromptTokens',
  'talaria.autocomplete.temperature',
  'talaria.autocomplete.crossFile.enabled',
  'talaria.autocomplete.crossFile.prefixInjection',
  'talaria.autocomplete.crossFile.warmUp',
  'talaria.rag.dims',
  'talaria.rag.maxChunkTokens',
  'talaria.rag.debounceMs',
  'talaria.rag.excludeGlobs',
];

// --- deps (the Task 3-7 engines, bound to their real spawn/fetch/fileExists by the caller) --

/**
 * Task 13: one ACP-advertised auth method, as it reaches this controller
 * through the {@link SetupControllerDeps.getAdvertisedAuthMethods} seam.
 * Deliberately declared HERE, structurally identical to `acp/acpClient.ts`'s
 * own `AdvertisedAuthMethod`, rather than imported from it — the binding
 * purity constraint is that this pure controller never imports from
 * `host/backend/` (authMethods reach it via the injected dep only);
 * TypeScript's structural typing makes the two interchangeable at the
 * `extension.ts` wiring boundary.
 */
export interface AdvertisedAuthMethod {
  id: string;
  name: string;
}

export interface SetupControllerRegistry {
  AGENT_BACKENDS: readonly BackendDescriptor[];
  FIM_BACKENDS: readonly BackendDescriptor[];
  getBackend(id: string): BackendDescriptor | undefined;
}

export interface SetupControllerDeps {
  /** Bound to its real `ExecLookup` by the caller. Can REJECT — always try/catch this (T4 M-2). */
  locatePipx(): Promise<PipxLocateResult>;
  /**
   * beta.5 §1.2 (T5): the os-release read, bound to the real container-
   * boundary-aware binding by the caller (`setupHost.vscode.ts`'s
   * `createReadOsRelease` — prefers `/run/host/os-release`, detects the
   * `/run/.containerenv` / `/.dockerenv` / `$container` markers). The pure
   * controller only INTERPRETS the result (Global Constraint 5): `text` is
   * parsed through the T3 engine; `containerMismatch: true` (a marker with
   * NO host os-release) and an absent `text` both degrade to family
   * `'unknown'` — fail-closed, never a guessed command. Result is memoized
   * across `status()` calls and re-read on `setup.recheck`.
   */
  readOsRelease(): Promise<{ text?: string; containerMismatch?: boolean }>;
  /** Bound to its real `SpawnFn`/`FileExists` by the caller. */
  installHermes(
    recipe: Extract<InstallRecipe, { kind: 'pipx' }>,
    env: PipxEnv,
    onEvent: (e: InstallEvent) => void,
    signal: AbortSignal,
  ): Promise<HermesPaths>;
  /** Bound to real `fetch` by the caller. */
  probeOllama(endpoint: string, timeoutMs?: number): Promise<OllamaStatus>;
  /** Bound to real `fetch` by the caller. */
  pullModel(
    endpoint: string,
    model: string,
    onProgress: (p: PullProgress) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Bound to real `fetch` by the caller. */
  probeRemote(spec: ProbeSpec, endpoint: string, apiKey: string | undefined): Promise<ProbeOutcome>;
  registry: SetupControllerRegistry;
  /**
   * The CURRENT `talaria.nextEdit.source` value, read through the NextEdit
   * Guard's own `NextEditConfigPort` (bound by the caller to
   * `createVsCodeNextEditConfigPort().get()` — `src/autocomplete/nextedit/
   * guard.ts`) rather than a raw setting-key literal. This is NOT optional
   * plumbing: `coexistence.lock.test.ts`'s R5 "single-writer/single-reader"
   * scan enforces that the `talaria.nextEdit.source` key literal and
   * `context.globalState` are each reached from exactly one non-test module
   * (`guard.ts`/`extension.ts`) so nothing can bypass the Guard's mutual-
   * exclusion invariant — `SetupController.ts` must stay off that scan's
   * radar, so it reads this value ONLY through the Guard's own accessor,
   * never by naming the key itself.
   */
  getNextEditSource(): 'off' | 'dedicated' | 'generic';
  /**
   * Task 13 (§2.1): the ACP `initialize` result's advertised auth methods,
   * read at CALL TIME through the backend seam (`extension.ts` binds this to
   * `() => backend.getAdvertisedAuthMethods?.()` — a thunk over the CURRENT
   * backend, so the trust-upgrade mock→real swap and every
   * `talaria.newSession` re-initialize are reflected on the next
   * {@link SetupController.status} call). `undefined` = no ACP connection
   * has initialized (or the active backend is the mock) — the Provider card
   * reads that as `waiting-agent`; see {@link computeProviderCard}.
   */
  getAdvertisedAuthMethods(): AdvertisedAuthMethod[] | undefined;
}

// --- misc constants -------------------------------------------------------

const PROGRESS_THROTTLE_MS = 150;
const LOG_TAIL_MAX = 40;
const DEFAULT_FIM_MODEL = 'qwen2.5-coder:1.5b-base';
const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_RAG_EMBED_MODEL = 'qwen3-embedding:0.6b';
const DEFAULT_RAG_INDEX_DIR = '.hermes/index';
const TRUST_REFUSAL_REASON = 'Workspace is not trusted — Setup changes are disabled in Restricted Mode.';
/**
 * Task 13: the id of Hermes' ALWAYS-advertised terminal setup-wizard auth
 * method — pinned by the adapter itself (`acp_adapter/auth.py`:
 * `TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup"`). Every OTHER advertised
 * id is an agent-managed provider credential method (§2.1).
 */
export const HERMES_SETUP_AUTH_METHOD_ID = 'hermes-setup';
/**
 * beta.5 §6 copy, verbatim (drift-locked by SetupController.test.ts). The
 * bootstrap COMMAND itself is no longer a constant here — T5 deleted the old
 * hardcoded Fedora `PIPX_BOOTSTRAP_COMMAND`; every pre-typed line is now
 * resolved server-side from the T4 engine ({@link installCommand} /
 * {@link pythonInstallPlan}) for the DETECTED family, or refused fail-closed.
 */
const PIPX_MISSING_KNOWN_DISTRO_GUIDANCE =
  'pipx was not found on your PATH. Open a terminal to install it, then re-check.';
const PIPX_MISSING_UNKNOWN_DISTRO_GUIDANCE =
  "pipx was not found, and this Linux distribution wasn't recognized — install pipx with your system's package manager, then re-check.";
const CONTAINER_NOTE =
  "Talaria can't tell which system your terminal acts on (VS Code appears to run in a sandbox/container) — run the install commands in a terminal on your host system, then re-check.";

/** D9: which {@link SetupMethod}s are consequence-bearing mutations, gated
 *  on `host.isTrusted()` (FM-14). Everything else (`setup.status` — handled
 *  outside `handle()` entirely —, `setup.testRemote`, `setup.recheck`,
 *  `setup.cancel`) is a read-only or best-effort-cancel action that must
 *  keep working in a Restricted Mode workspace (§8). Exported (with {@link
 *  READ_ONLY_METHODS}) so a lock test can prove the two sets partition the
 *  FULL {@link SetupMethod} union with no gaps — a future mutating method
 *  added to the union without being added HERE would otherwise ship
 *  un-gated (fail-open by omission; final review wave fix). */
export const MUTATING_METHODS = new Set<SetupMethod>([
  'setup.install',
  'setup.applyAgent',
  'setup.applyFim',
  'setup.setApiKey',
  'setup.pullModel',
  'setup.openProviderWizard',
  'setup.openInstallTerminal',
  'setup.openBootstrapTerminal',
  'setup.reload',
  'setup.setNextEdit',
  'setup.setRag',
  'setup.setTunable',
]);

/** The complement of {@link MUTATING_METHODS}: every read-only (or
 *  best-effort-cancel) {@link SetupMethod} — see that constant's doc for
 *  why each one is exempt from the FM-14 trust gate. */
export const READ_ONLY_METHODS: readonly SetupMethod[] = [
  'setup.status',
  'setup.testRemote',
  'setup.cancel',
  'setup.recheck',
];

interface ThrottleState {
  lastEmit: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: SetupProgress;
}

/**
 * T5: one interpreted os-release read — everything the §1.2 wiring needs.
 * `release` keeps the full parsed identity (the Python planner's C-3 gate
 * needs `id`/`versionId`, never just the collapsed family); `containerNote`
 * is set ONLY for the S-F10 degrade (container marker with no host
 * os-release) — a merely unreadable file degrades to `unknown` WITHOUT the
 * note, because "VS Code appears to run in a sandbox/container" would be a
 * fabrication there (§1.2's trigger sentence is the authority).
 */
interface OsResolution {
  release: OsRelease;
  family: DistroFamily;
  manager: PackageManager;
  containerNote?: string;
}

export class SetupController {
  private readonly progressEmitter = new Emitter<SetupProgress>();
  /** Throttled >=150ms between pushes for the same `(op, id)` pair, via a real `setTimeout` — never drops the final value, only delays it. */
  readonly onProgress: Event<SetupProgress> = this.progressEmitter.event;

  /**
   * T7 (§2.2.2): fired on every mid-flight/outcome state change that a
   * `SetupData` re-fetch would actually reflect — `TalariaViewProvider
   * .setSetupController` subscribes this straight to a `pushSetupPanelData()`
   * re-push. Deliberately narrow: only {@link handleInstall} (after the
   * modal is CONFIRMED — ⚠ critic C-16, never at the in-flight latch, which
   * is set BEFORE the modal — and at every {@link lastAgentIssue} write /
   * the {@link awaitingReload} flip) and {@link handleRecheck} (once, at
   * completion) fire it. Every OTHER mutating method already gets pushed by
   * `TalariaViewProvider.handleSetupMethod`'s own unconditional post-`handle
   * ()` refresh (T7 fix 1) — firing here too would be a redundant push, not
   * a new one, so this event is intentionally NOT wired to any other method
   * (and never to a read-only one).
   */
  private readonly statusChangedEmitter = new Emitter<void>();
  readonly onStatusChanged: Event<void> = this.statusChangedEmitter.event;

  /** Keyed `${op}:${id}` (`install:<backendId>` / `pull:<model>`) — presence = single-flight latch (FM-12); the held `AbortController` is what `setup.cancel` interrupts. */
  private readonly inFlight = new Map<string, AbortController>();
  private readonly throttle = new Map<string, ThrottleState>();

  private installLogTail: string[] = [];
  private lastAgentIssue?: { phase: AgentSetupPhase; detail: string };
  /** Set once a `setup.install` succeeds THIS session; never cleared here (a real reload replaces the whole extension host, and therefore this controller instance). */
  private awaitingReload = false;
  /** T5: memoized OS detection (a PROMISE, so concurrent `status()` calls
   *  share one read) — cleared by `setup.recheck` so the next demand
   *  re-reads (the user may have installed VS Code outside the sandbox, or
   *  the file may have become readable). */
  private osResolution?: Promise<OsResolution>;

  constructor(
    private readonly host: SetupHost,
    private readonly deps: SetupControllerDeps,
  ) {}

  dispose(): void {
    for (const state of this.throttle.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.throttle.clear();
    this.progressEmitter.dispose();
    this.statusChangedEmitter.dispose();
  }

  /**
   * §6 entry point 1 (first-run auto-open once): true iff `globalState
   * ['talaria.setup.autoOpened']` was never set before. SetupController is
   * the single owner of the ENTIRE `talaria.setup.*` globalState namespace
   * (mirrors `NextEditGuard` owning `hermes.nextEdit.toggles` — see
   * `coexistence.lock.test.ts`'s R5 doc) — `extension.ts` calls this + {@link
   * markAutoOpened} instead of touching `context.globalState` itself, so
   * `globalState.get`/`.update` call sites stay confined to this class and
   * its `setupHost.vscode.ts` adapter.
   */
  shouldAutoOpen(): boolean {
    return this.host.globalState.get<boolean>('talaria.setup.autoOpened') === undefined;
  }

  /** Marks the first-run auto-open ATTEMPT as done (records the attempt, not completion — never fires again). */
  async markAutoOpened(): Promise<void> {
    await this.host.globalState.update('talaria.setup.autoOpened', true);
  }

  // --- status() -----------------------------------------------------------

  async status(): Promise<SetupData> {
    const trusted = this.host.isTrusted();
    const apiKeySet = await this.host.secrets.has(AUTOCOMPLETE_API_KEY_SECRET);
    // T5 §1.2: interpreted (memoized) OS identity — drives the `os` block
    // and, per phase, the engine-composed bootstrap / python plans below.
    const osInfo = await this.resolveOs();

    const ollamaDescriptor = this.deps.registry.getBackend('ollama');
    const ollamaEndpoint = ollamaDescriptor?.remote?.endpoint.defaultValue ?? DEFAULT_OLLAMA_ENDPOINT;
    const ollamaStatus = await this.safeProbeOllama(ollamaEndpoint);

    const hermesPath = (this.host.getSetting<string>('talaria.hermesPath') ?? '').trim();
    const configuredBackend = this.host.getSetting<string>('talaria.backend') ?? 'mock';
    const agentPhase = this.computeAgentPhase(hermesPath, configuredBackend);
    const installRecord = this.host.globalState.get<{ version: string; venvRoot: string; installedAt: string }>(
      'talaria.setup.hermesInstall',
    );

    const agentOptions = this.deps.registry.AGENT_BACKENDS.map((d) => this.projectBackend(d, ollamaStatus, apiKeySet));
    const fimOptions = this.deps.registry.FIM_BACKENDS.map((d) => this.projectBackend(d, ollamaStatus, apiKeySet));

    const fimBackendId = this.host.getSetting<string>('talaria.autocomplete.backend') ?? 'ollama';
    const fimDescriptor =
      this.deps.registry.getBackend(fimBackendId) ?? this.deps.registry.getBackend('ollama');
    if (!fimDescriptor) throw new Error('registry has no ollama FIM entry — invariant violated');

    const enabled = this.host.getSetting<boolean>('talaria.autocomplete.enabled') ?? true;
    const model = (this.host.getSetting<string>('talaria.autocomplete.model') ?? '').trim() || DEFAULT_FIM_MODEL;
    const endpointValue = (this.host.getSetting<string>('talaria.autocomplete.endpoint') ?? '').trim();

    const tuning = {
      debounceMs: this.host.getSetting<number>('talaria.autocomplete.debounceMs') ?? 350,
      maxPromptTokens: this.host.getSetting<number>('talaria.autocomplete.maxPromptTokens') ?? 1024,
      temperature: this.host.getSetting<number>('talaria.autocomplete.temperature') ?? 0.01,
      crossFileEnabled: this.host.getSetting<boolean>('talaria.autocomplete.crossFile.enabled') ?? true,
      prefixInjection: this.host.getSetting<boolean>('talaria.autocomplete.crossFile.prefixInjection') ?? false,
      prefixInjectionRemote:
        this.host.getSetting<boolean>('talaria.autocomplete.crossFile.prefixInjectionRemote') ?? false,
      warmUp: this.host.getSetting<boolean>('talaria.autocomplete.crossFile.warmUp') ?? false,
    };

    const fimAuthSatisfied =
      fimDescriptor.remote?.auth.kind !== 'apiKey' || !fimDescriptor.remote.auth.required || apiKeySet;

    // Task 13 (§2.1): the Provider card is driven SOLELY by the ACP-advertised
    // auth methods, read through the dep seam at call time — see
    // computeProviderCard's own doc for the mapping (and why it is
    // deliberately NOT gated on agentPhase).
    const provider = computeProviderCard(this.deps.getAdvertisedAuthMethods());

    const nextSource = this.deps.getNextEditSource();
    const nextBackend = coerceNextEditTransport(this.host.getSetting<string>('talaria.nextEdit.backend'));
    const nextEndpoint = (this.host.getSetting<string>('talaria.nextEdit.endpoint') ?? '').trim();
    const nextModel = (this.host.getSetting<string>('talaria.nextEdit.model') ?? '').trim();
    const genericSupported = fimDescriptor.nextEditTransport !== undefined;
    const dedicatedConfigured = nextEndpoint !== '' && nextModel !== '';

    const ragEnabled = this.host.getSetting<boolean>('talaria.rag.enabled') ?? true;
    const ragEmbedEndpoint = (this.host.getSetting<string>('talaria.rag.embedEndpoint') ?? '').trim() || DEFAULT_OLLAMA_ENDPOINT;
    const ragEmbedModel = (this.host.getSetting<string>('talaria.rag.embedModel') ?? '').trim() || DEFAULT_RAG_EMBED_MODEL;
    const ragTuning = {
      dims: this.host.getSetting<number>('talaria.rag.dims') ?? 0,
      maxChunkTokens: this.host.getSetting<number>('talaria.rag.maxChunkTokens') ?? 512,
      debounceMs: this.host.getSetting<number>('talaria.rag.debounceMs') ?? 500,
      excludeGlobs: this.host.getSetting<string[]>('talaria.rag.excludeGlobs') ?? [],
    };
    const ragIndexDir = (this.host.getSetting<string>('talaria.rag.indexDir') ?? '').trim() || DEFAULT_RAG_INDEX_DIR;

    const fimGreen = fimDescriptor.status === 'available' && enabled && fimAuthSatisfied;
    const ready = computeReady(agentPhase, provider.phase, fimGreen);

    const data: SetupData = {
      trusted,
      agent: {
        options: agentOptions,
        selectedId: 'hermes',
        phase: agentPhase,
        ...(installRecord?.version ? { version: installRecord.version } : {}),
        ...(this.lastAgentIssue ? { detail: this.lastAgentIssue.detail } : {}),
        ...(this.installLogTail.length > 0 ? { logTail: [...this.installLogTail] } : {}),
        // T5 §1.2: present iff the phase calls for them — the webview only
        // ever RENDERS these (it never composes command text, Constraint 1).
        ...(agentPhase === 'pipx-missing' ? { bootstrap: composeBootstrap(osInfo) } : {}),
        ...(agentPhase === 'python-unsuitable'
          ? { pythonInstall: pythonInstallPlan(osInfo.release, osInfo.family) }
          : {}),
      },
      provider,
      fim: {
        options: fimOptions,
        selectedId: fimDescriptor.id,
        enabled,
        model,
        endpointValue,
        tuning,
      },
      nextEdit: {
        source: nextSource,
        backend: nextBackend,
        endpoint: nextEndpoint,
        model: nextModel,
        dedicatedConfigured,
        genericSupported,
        ...(nextSource === 'generic' && !genericSupported
          ? {
              refusalDetail: `The selected FIM backend ('${fimDescriptor.displayName}') does not support Generic Next-Edit.`,
            }
          : {}),
      },
      rag: {
        enabled: ragEnabled,
        embedEndpoint: ragEmbedEndpoint,
        embedModel: ragEmbedModel,
        embedModelPresent: ollamaStatus.running ? ollamaStatus.models.some((m) => m.name === ragEmbedModel) : false,
        tuning: ragTuning,
        indexDir: ragIndexDir,
        ...(trusted ? {} : { preconditionDetail: 'The codebase index needs a trusted, open workspace.' }),
      },
      ollama: ollamaStatus.running
        ? { running: true, models: ollamaStatus.models }
        : { running: false, models: [] },
      ready,
      os: {
        family: osInfo.family,
        manager: osInfo.manager,
        ...(osInfo.release.prettyName !== undefined ? { prettyName: osInfo.release.prettyName } : {}),
        ...(osInfo.containerNote !== undefined ? { containerNote: osInfo.containerNote } : {}),
      },
    };
    return data;
  }

  // --- T5: OS detection (memoized interpretation of the readOsRelease seam) --

  private resolveOs(): Promise<OsResolution> {
    this.osResolution ??= this.computeOsResolution();
    return this.osResolution;
  }

  private async computeOsResolution(): Promise<OsResolution> {
    let read: { text?: string; containerMismatch?: boolean };
    try {
      read = await this.deps.readOsRelease();
    } catch {
      // A rejecting binding must never fail status() — same posture as
      // safeProbeOllama. Degrades to `unknown` below.
      read = {};
    }
    if (read.containerMismatch === true || read.text === undefined) {
      return {
        release: { idLike: [] },
        family: 'unknown',
        manager: 'unknown',
        // §1.2/S-F10: the note ONLY for the container degrade — see
        // OsResolution's doc for why a plain read failure stays note-less.
        ...(read.containerMismatch === true ? { containerNote: CONTAINER_NOTE } : {}),
      };
    }
    const release = parseOsRelease(read.text);
    const family = resolveDistroFamily(release);
    return { release, family, manager: managerFor(family) };
  }

  // --- handle() -------------------------------------------------------------

  async handle(method: SetupMethod, params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (MUTATING_METHODS.has(method) && !this.host.isTrusted()) {
      return { ok: false, reason: TRUST_REFUSAL_REASON };
    }
    switch (method) {
      case 'setup.status':
        // Routing lives in the caller (TalariaViewProvider calls `status()`
        // directly for the richer SetupData shape) — this arm exists only so
        // the switch stays exhaustive over SetupMethod.
        return { ok: true };
      case 'setup.install':
        return this.handleInstall(params);
      case 'setup.applyAgent':
        return this.handleApplyAgent(params);
      case 'setup.applyFim':
        return this.handleApplyFim(params);
      case 'setup.setApiKey':
        return this.handleSetApiKey(params);
      case 'setup.testRemote':
        return this.handleTestRemote(params);
      case 'setup.pullModel':
        return this.handlePullModel(params);
      case 'setup.cancel':
        return this.handleCancel(params);
      case 'setup.openProviderWizard':
        return this.handleOpenProviderWizard();
      case 'setup.openInstallTerminal':
        return this.handleOpenInstallTerminal(params);
      case 'setup.openBootstrapTerminal':
        return this.handleOpenBootstrapTerminal(params);
      case 'setup.reload':
        return this.handleReload();
      case 'setup.recheck':
        return this.handleRecheck();
      case 'setup.setNextEdit':
        return this.handleSetNextEdit(params);
      case 'setup.setRag':
        return this.handleSetRag(params);
      case 'setup.setTunable':
        return this.handleSetTunable(params);
    }
  }

  // --- setup.install --------------------------------------------------------

  private async handleInstall(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const backendId = str(params, 'backendId') ?? 'hermes';
    const key = `install:${backendId}`;
    if (this.inFlight.has(key)) {
      return { ok: false, reason: 'install already running' };
    }
    const descriptor = this.deps.registry.getBackend(backendId);
    const recipe = descriptor?.localInstall?.recipe;
    if (!descriptor || !recipe || recipe.kind !== 'pipx') {
      return { ok: false, reason: `'${backendId}' has no pipx install recipe.` };
    }

    const abort = new AbortController();
    this.inFlight.set(key, abort);
    this.lastAgentIssue = undefined;
    this.installLogTail = [];
    try {
      const confirmed = await this.host.showModal(
        `Install ${descriptor.displayName} (${recipe.packageSpec}) from PyPI via pipx, approximately 300-500 MB under ~/.local/share/pipx. Continue?`,
        'Install',
      );
      if (!confirmed) return { ok: false, reason: 'declined' };
      // T7 (§2.2.2, critic C-16): the install visibly "starts" HERE — right
      // after the user's CONFIRM — never at the in-flight latch above (which
      // is set BEFORE the modal, so firing there would push a phase the user
      // hasn't agreed to yet).
      this.statusChangedEmitter.fire();

      let located: PipxLocateResult;
      try {
        // T4 M-2 carry-forward: locatePipx can REJECT (pipx vanishing
        // mid-flow) — never let that become an unhandled rejection.
        located = await this.deps.locatePipx();
      } catch (err) {
        const detail = this.redact(errorMessage(err));
        this.lastAgentIssue = { phase: 'error', detail };
        this.statusChangedEmitter.fire();
        return { ok: false, reason: detail };
      }
      if (!located.ok) {
        const detail = this.redact(located.detail);
        // The sticky PHASE keeps the enum (computeAgentPhase's contract);
        // the RETURNED reason is a §6-grade human sentence (T5, critic
        // C-17): pipx-missing reuses the bootstrap card's own per-family
        // guidance copy; python-unsuitable returns the locator's detail
        // (already a full sentence naming the range and the probes).
        this.lastAgentIssue = { phase: located.reason, detail };
        this.statusChangedEmitter.fire();
        const reason =
          located.reason === 'pipx-missing' ? composeBootstrap(await this.resolveOs()).guidance : detail;
        return { ok: false, reason };
      }

      let paths: HermesPaths;
      try {
        paths = await this.deps.installHermes(
          recipe,
          located.env,
          (event) => this.onInstallEvent(backendId, event),
          abort.signal,
        );
      } catch (err) {
        const detail = this.redact(errorMessage(err));
        this.lastAgentIssue = { phase: 'error', detail };
        this.statusChangedEmitter.fire();
        return { ok: false, reason: detail };
      }

      // Fail-closed order: installHermes only resolves after its own
      // `--check` verify passed — writes happen ONLY now, together. Wrapped
      // so an updateSettingGlobal/globalState.update rejection (e.g. VS Code
      // failing to write User Settings) surfaces as {ok:false} instead of
      // throwing out of handle() — a partial write leaves `talaria.backend`
      // unset/'mock' either way (fail-safe per class doc §8), so this is
      // purely about a graceful error return, not a security change.
      try {
        await this.host.updateSettingGlobal('talaria.hermesPath', paths.hermes);
        await this.host.updateSettingGlobal('talaria.pythonPath', paths.python);
        await this.host.updateSettingGlobal('talaria.backend', 'acp');
        await this.host.globalState.update('talaria.setup.hermesInstall', {
          version: recipe.pinnedVersion,
          venvRoot: paths.venvRoot,
          installedAt: new Date().toISOString(),
        });
      } catch (err) {
        const detail = this.redact(errorMessage(err));
        this.lastAgentIssue = { phase: 'error', detail };
        this.statusChangedEmitter.fire();
        return { ok: false, reason: detail };
      }
      this.awaitingReload = true;
      this.statusChangedEmitter.fire();
      this.host.offerReload();
      return { ok: true };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private onInstallEvent(backendId: string, event: InstallEvent): void {
    if (event.kind === 'log') {
      const line = this.redact(event.line);
      this.installLogTail.push(line);
      if (this.installLogTail.length > LOG_TAIL_MAX) this.installLogTail.shift();
      this.pushProgress({ op: 'install', id: backendId, line });
    } else if (event.kind === 'phase') {
      this.pushProgress({ op: 'install', id: backendId, phase: event.phase });
    } else if (event.kind === 'failed') {
      const detail = this.redact(event.detail);
      this.lastAgentIssue = { phase: 'error', detail };
      // T7 (§2.2.2): the FIRST observable point of a real installHermes-time
      // failure — the card's "installing" phase flip has already unmounted
      // the Install button, so a host-pushed `phase:'error'` snapshot is the
      // only surface (§0.1 ②); `handleInstall`'s own catch below fires again
      // once the rejection propagates, which the provider's seq guard
      // safely collapses with this one.
      this.statusChangedEmitter.fire();
      this.pushProgress({ op: 'install', id: backendId, phase: event.phase, line: detail });
    } else if (event.kind === 'done') {
      this.pushProgress({ op: 'install', id: backendId, phase: 'verify', line: 'Install verified.' });
    }
  }

  // --- setup.applyAgent ------------------------------------------------------

  private async handleApplyAgent(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const backendId = str(params, 'backendId') ?? 'hermes';
    const descriptor = this.deps.registry.getBackend(backendId);
    if (!descriptor || descriptor.kind !== 'agent' || descriptor.status !== 'available') {
      return { ok: false, reason: `'${backendId}' is not an available agent backend.` };
    }
    const entries = Object.entries(descriptor.settingsToActivate);
    if (entries.length === 0) {
      return { ok: false, reason: `'${backendId}' has nothing to activate.` };
    }
    const confirmed = await this.host.showModal(
      `Activate ${descriptor.displayName} as the active agent (${entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')})?`,
      'Activate',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };
    for (const [settingKey, value] of entries) {
      await this.host.updateSettingGlobal(settingKey, value);
    }
    this.host.offerReload();
    return { ok: true };
  }

  // --- setup.applyFim --------------------------------------------------------

  private async handleApplyFim(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const backendId = str(params, 'backendId');
    if (!backendId) return { ok: false, reason: 'backendId is required.' };
    const descriptor = this.deps.registry.getBackend(backendId);
    if (!descriptor || descriptor.kind !== 'fim' || !descriptor.remote) {
      return { ok: false, reason: `'${backendId}' is not a connectable FIM backend.` };
    }
    const rawEndpoint = str(params, 'endpoint')?.trim() || descriptor.remote.endpoint.defaultValue;
    const validated = validateEndpointUrl(rawEndpoint);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    const oldEndpoint = (this.host.getSetting<string>('talaria.autocomplete.endpoint') ?? '').trim() || '(default)';
    const confirmed = await this.host.showModal(
      `Switch autocomplete endpoint from '${oldEndpoint}' to '${validated.url}' (backend: ${descriptor.displayName})?`,
      'Apply',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };

    await this.host.updateSettingGlobal('talaria.autocomplete.backend', backendId);
    await this.host.updateSettingGlobal('talaria.autocomplete.endpoint', validated.url);
    return { ok: true };
  }

  // --- setup.setApiKey --------------------------------------------------------

  private async handleSetApiKey(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (bool(params, 'clear') === true) {
      const confirmed = await this.host.showModal('Clear the stored autocomplete API key?', 'Clear');
      if (!confirmed) return { ok: false, reason: 'declined' };
      await this.host.secrets.delete(AUTOCOMPLETE_API_KEY_SECRET);
      return { ok: true };
    }
    const value = await this.host.showPasswordInput(
      'Enter the API key for this backend. It is stored in your OS keychain and never leaves this machine.',
    );
    if (value === undefined || value.trim() === '') return { ok: false, reason: 'declined' };
    await this.host.secrets.store(AUTOCOMPLETE_API_KEY_SECRET, value.trim());
    return { ok: true };
  }

  // --- setup.testRemote (read-only) -------------------------------------------

  private async handleTestRemote(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const backendId = str(params, 'backendId');
    const descriptor = backendId ? this.deps.registry.getBackend(backendId) : undefined;
    if (!descriptor || !descriptor.remote) {
      return { ok: false, reason: `'${String(backendId)}' is not a connectable backend.` };
    }
    const endpoint =
      str(params, 'endpoint')?.trim() ||
      (this.host.getSetting<string>('talaria.autocomplete.endpoint') ?? '').trim() ||
      descriptor.remote.endpoint.defaultValue;
    try {
      // SetupHost.secrets has no getter (by design — see class doc), so a
      // probe from here can never carry a real API key. Every v1 registry
      // entry whose probe would actually need one (codestral) has
      // `probe: {kind:'none'}` for exactly this reason.
      const outcome = await this.deps.probeRemote(descriptor.remote.probe, endpoint, undefined);
      return outcome.ok ? { ok: true } : { ok: false, reason: this.redact(outcome.detail) };
    } catch (err) {
      return { ok: false, reason: this.redact(errorMessage(err)) };
    }
  }

  // --- setup.pullModel ---------------------------------------------------------

  private async handlePullModel(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const model = str(params, 'model');
    if (!model) return { ok: false, reason: 'model is required.' };
    const endpoint =
      str(params, 'endpoint')?.trim() ||
      this.deps.registry.getBackend('ollama')?.remote?.endpoint.defaultValue ||
      DEFAULT_OLLAMA_ENDPOINT;
    const key = `pull:${model}`;
    if (this.inFlight.has(key)) return { ok: false, reason: 'pull already running' };

    // Latch BEFORE the modal (mirrors handleInstall) — otherwise two
    // `setup.pullModel` calls dispatched before the user answers the first
    // modal both pass the `has()` check above, and if both are approved the
    // second `inFlight.set` clobbers the first's AbortController, leaving
    // `setup.cancel` unable to reach the first pull. The `finally` below
    // still deletes the key on every exit path, including a decline, so a
    // declined pull never wedges the latch.
    const abort = new AbortController();
    this.inFlight.set(key, abort);
    try {
      const confirmed = await this.host.showModal(
        `Pull model '${model}' from the Ollama registry to your local disk?`,
        'Pull',
      );
      if (!confirmed) return { ok: false, reason: 'declined' };

      await this.deps.pullModel(
        endpoint,
        model,
        (p) => {
          this.pushProgress({
            op: 'pull',
            id: model,
            phase: p.status,
            ...(p.totalBytes !== undefined ? { totalBytes: p.totalBytes } : {}),
            ...(p.completedBytes !== undefined ? { completedBytes: p.completedBytes } : {}),
          });
        },
        abort.signal,
      );
      return { ok: true };
    } catch (err) {
      if (isAbortError(err)) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: this.redact(errorMessage(err)) };
    } finally {
      this.inFlight.delete(key);
    }
  }

  // --- setup.cancel (read-only / best-effort) -----------------------------------

  private handleCancel(params: unknown): { ok: true } {
    const op = str(params, 'op');
    const id = str(params, 'id');
    if (op && id) {
      this.inFlight.get(`${op}:${id}`)?.abort();
    }
    return { ok: true };
  }

  // --- setup.recheck (read-only, re-probes pipx) --------------------------------

  /**
   * Final review wave, IMPORTANT (recovery dead-end): `computeAgentPhase`
   * derives `pipx-missing`/`python-unsuitable` from the STICKY
   * {@link lastAgentIssue} — set only on a failed {@link handleInstall} and,
   * before this fix, cleared only at the START of the next one. `status()`
   * deliberately never re-probes pipx itself (unlike the Ollama card, whose
   * re-probe is a cheap `fetch` that `status()` already re-runs on every
   * call — re-locating pipx is a shell spawn, too expensive to repeat on
   * every panel render). That left the cached issue with no escape short of
   * a full window reload once the user had, say, opened the bootstrap
   * terminal and installed pipx. `setup.recheck` is the explicit user
   * action this belongs on instead: re-run {@link SetupControllerDeps.
   * locatePipx} (the SAME dep `handleInstall` uses) and refresh
   * {@link lastAgentIssue} from its outcome — cleared on success (so
   * `computeAgentPhase` falls through to `'missing'`, making the Install
   * button actionable again), or refreshed with whatever the CURRENT
   * failure reason is on continued failure (a user can flip between
   * `pipx-missing` and `python-unsuitable` across bootstrap-terminal
   * attempts, so this must overwrite, not merely confirm, the prior
   * reason). T4 M-2 carry-forward applies here too: `locatePipx` can
   * REJECT, and that must never become an unhandled rejection out of a
   * read-only recheck.
   */
  private async handleRecheck(): Promise<{ ok: true }> {
    // T5: drop the memoized OS detection — the next demand (the status()
    // this recheck's caller refreshes with, or the next bootstrap-terminal
    // request) re-reads through the binding, picking up e.g. a container
    // escape or a newly readable /etc/os-release.
    this.osResolution = undefined;
    try {
      const located = await this.deps.locatePipx();
      this.lastAgentIssue = located.ok ? undefined : { phase: located.reason, detail: this.redact(located.detail) };
    } catch (err) {
      this.lastAgentIssue = { phase: 'error', detail: this.redact(errorMessage(err)) };
    }
    // T7 (§2.2.2): fired exactly ONCE at completion (not per lastAgentIssue
    // write above) — recheck is read-only/no-modal, so "the recheck
    // completed" is itself the single meaningful state-change signal,
    // whether it cleared the sticky issue or refreshed it.
    this.statusChangedEmitter.fire();
    return { ok: true };
  }

  // --- setup.openProviderWizard --------------------------------------------------

  private async handleOpenProviderWizard(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const hermesPath = (this.host.getSetting<string>('talaria.hermesPath') ?? '').trim();
    if (!hermesPath) return { ok: false, reason: 'Hermes is not installed yet — install it first.' };
    const hermesAcpPath = deriveHermesAcpPath(hermesPath);
    const confirmed = await this.host.showModal(
      `Open a terminal running '${hermesAcpPath} --setup' to configure your chat provider?`,
      'Open Terminal',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };
    this.host.runInTerminal('Hermes Provider Setup', hermesAcpPath, ['--setup']);
    return { ok: true };
  }

  // --- setup.openInstallTerminal --------------------------------------------------

  private async handleOpenInstallTerminal(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const backendId = str(params, 'backendId');
    const descriptor = backendId ? this.deps.registry.getBackend(backendId) : undefined;
    const recipe = descriptor?.localInstall?.recipe;
    if (!descriptor || !recipe || recipe.kind !== 'guided-terminal') {
      return { ok: false, reason: `'${String(backendId)}' has no guided-terminal install.` };
    }

    let command = recipe.command;
    if (recipe.packageKey) {
      // T6 (§1.2 A3): hand command resolution to the OS engine for the
      // DETECTED family. Fail-open CLOSED (S-F9): a family with no engine
      // entry for this key NEVER falls back to this recipe's own static
      // `command` (Fedora-shaped) — it refuses, guidance-only, same
      // fail-closed posture as `handleOpenBootstrapTerminal`.
      const osInfo = await this.resolveOs();
      const spec = installCommand(osInfo.family, recipe.packageKey);
      if (spec === undefined) {
        return {
          ok: false,
          reason:
            osInfo.containerNote ??
            `No verified '${descriptor.displayName}' install command for this system — see ${recipe.docsUrl} for manual install options.`,
        };
      }
      command = spec.command;
    }

    const confirmed = await this.host.showModal(
      `Open a terminal pre-filled with:\n${command}\nYou'll need to press Enter to run it — grant sudo yourself if it asks.`,
      'Open Terminal',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };
    // Pre-typed only — createTerminal never executes it (SetupHost's own contract).
    this.host.createTerminal(`${descriptor.displayName} install`, command);
    return { ok: true };
  }

  // --- setup.openBootstrapTerminal (T11 IMPORTANT host-gap 2) ---------------

  /**
   * The `pipx-missing` gap-state fix (plan §6 card 1 / §7 FM-1), rewired by
   * beta.5 T5 (§1.2): unlike {@link handleOpenInstallTerminal} there is no
   * registry `backendId` to look up (pipx itself isn't a
   * `BackendDescriptor`) — instead the command is resolved SERVER-SIDE from
   * the T4 engine for the DETECTED family, never from webview-supplied text
   * (Global Constraint 1; the old hardcoded Fedora `PIPX_BOOTSTRAP_COMMAND`
   * is deleted). `params.target` selects which engine line: `'pipx'`
   * (default when absent) or `'python'` (the A2 handoff — the command that
   * makes `locatePipx`'s existing python3.13/3.12/3.11 probe succeed; no
   * new `--python` plumbing needed, `pipxInstaller.ts:106-110`). Validated
   * as a STRICT enum — any other value (or a non-string) is refused before
   * any engine/modal work.
   *
   * FAIL-CLOSED: when the engine yields no command — unknown family, the
   * S-F10 container degrade, or a GUIDANCE python plan (e.g. Ubuntu 26.04,
   * the rev-3 case) — the refusal is `{ok:false}` with a §6-grade reason,
   * the modal is never shown and the terminal is never created. Same Tier-1
   * discipline as before on the happy path: the native modal names the
   * EXACT command + its `sourceNote` verbatim; a decline is
   * `{ok:false,'declined'}` with the terminal never created.
   */
  private async handleOpenBootstrapTerminal(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const target = validateBootstrapTarget(params);
    if (target === undefined) {
      return { ok: false, reason: "target must be 'pipx' or 'python'." };
    }
    const osInfo = await this.resolveOs();

    let command: string;
    let sourceNote: string;
    let terminalName: string;
    let followUpHint: string;
    if (target === 'pipx') {
      const spec = installCommand(osInfo.family, 'pipx');
      if (spec === undefined) {
        return { ok: false, reason: osInfo.containerNote ?? PIPX_MISSING_UNKNOWN_DISTRO_GUIDANCE };
      }
      command = spec.command;
      sourceNote = spec.sourceNote;
      terminalName = 'Install pipx';
      followUpHint =
        " Once it finishes, also run 'pipx ensurepath' (then restart your terminal) so pipx-installed apps land on PATH.";
    } else {
      const plan = pythonInstallPlan(osInfo.release, osInfo.family);
      if (plan.kind !== 'command') {
        // Guidance-only family (rev 3: Ubuntu 26.04+/Debian/Mint/Pop/Arch/
        // unknown) — there is no verified line to pre-type. plan.text is
        // the §6 guidance copy verbatim.
        return { ok: false, reason: osInfo.containerNote ?? plan.text };
      }
      command = plan.command;
      sourceNote = plan.sourceNote;
      terminalName = 'Install Python';
      followUpHint = '';
    }

    const confirmed = await this.host.showModal(
      `Open a terminal pre-filled with:\n${command}\nSource: ${sourceNote}\nYou'll need to press Enter to run it — grant sudo yourself if it asks.${followUpHint}`,
      'Open Terminal',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };
    // Pre-typed only — createTerminal never executes it (SetupHost's own contract).
    this.host.createTerminal(terminalName, command);
    return { ok: true };
  }

  // --- setup.reload (T11 IMPORTANT host-gap 1) -------------------------------

  /**
   * The `awaiting-reload` gap-state fix (plan §6 card 1 FM-7): trust-gated
   * (via {@link MUTATING_METHODS}, checked by the caller in {@link handle})
   * but deliberately MODAL-FREE — it writes no settings and spawns nothing,
   * so it follows the Tier-2 `setup.setTunable` posture (gated, no
   * confirmation dialog) rather than Tier-1's native-modal one. The user
   * already made the one decision that matters (clicking the persistent
   * [Reload window] button); a second "are you sure you want to reload?"
   * prompt would just be friction.
   */
  private handleReload(): { ok: true } {
    this.host.reload();
    return { ok: true };
  }

  // --- setup.setNextEdit ------------------------------------------------------

  private async handleSetNextEdit(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const backend = str(params, 'backend');
    if (backend !== 'ollama' && backend !== 'openai-compat') {
      return { ok: false, reason: 'backend must be "ollama" or "openai-compat".' };
    }
    const endpointRaw = str(params, 'endpoint');
    if (!endpointRaw) return { ok: false, reason: 'endpoint is required.' };
    const validated = validateEndpointUrl(endpointRaw);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    const model = str(params, 'model')?.trim();
    if (!model) return { ok: false, reason: 'model is required.' };

    const oldEndpoint = (this.host.getSetting<string>('talaria.nextEdit.endpoint') ?? '').trim() || '(none)';
    const confirmed = await this.host.showModal(
      `Set dedicated Next-Edit endpoint from '${oldEndpoint}' to '${validated.url}' (model: ${model})?`,
      'Apply',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };

    await this.host.updateSettingGlobal('talaria.nextEdit.backend', backend);
    await this.host.updateSettingGlobal('talaria.nextEdit.endpoint', validated.url);
    await this.host.updateSettingGlobal('talaria.nextEdit.model', model);
    return { ok: true };
  }

  // --- setup.setRag -----------------------------------------------------------

  private async handleSetRag(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const patch: Record<string, string | boolean> = {};
    const enabled = bool(params, 'enabled');
    if (enabled !== undefined) patch['talaria.rag.enabled'] = enabled;
    const embedEndpointRaw = str(params, 'embedEndpoint');
    if (embedEndpointRaw !== undefined) {
      const validated = validateEndpointUrl(embedEndpointRaw);
      if (!validated.ok) return { ok: false, reason: validated.reason };
      patch['talaria.rag.embedEndpoint'] = validated.url;
    }
    const embedModel = str(params, 'embedModel')?.trim();
    if (embedModel) patch['talaria.rag.embedModel'] = embedModel;
    const indexDir = str(params, 'indexDir')?.trim();
    if (indexDir) patch['talaria.rag.indexDir'] = indexDir;

    if (Object.keys(patch).length === 0) {
      return { ok: false, reason: 'no changes supplied.' };
    }

    const summary = Object.entries(patch)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    const confirmed = await this.host.showModal(`Update codebase-index settings: ${summary}?`, 'Apply');
    if (!confirmed) return { ok: false, reason: 'declined' };

    for (const [settingKey, value] of Object.entries(patch)) {
      await this.host.updateSettingGlobal(settingKey, value);
    }
    return { ok: true };
  }

  // --- setup.setTunable (Tier-2, no modal) -----------------------------------------

  private async handleSetTunable(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const key = str(params, 'key');
    if (!key || !TIER2_TUNABLE_KEYS.includes(key)) {
      return { ok: false, reason: 'not a tunable' };
    }
    const value = (params as Record<string, unknown> | undefined)?.['value'];
    const validated = validateTunableValue(key, value);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    await this.host.updateSettingGlobal(key, validated.value);
    return { ok: true };
  }

  // --- helpers --------------------------------------------------------------

  private computeAgentPhase(hermesPath: string, configuredBackend: string): AgentSetupPhase {
    if (this.inFlight.has(`install:hermes`)) return 'installing';
    if (this.awaitingReload) return 'awaiting-reload';
    if (hermesPath) return configuredBackend === 'acp' ? 'ready' : 'installed-inactive';
    if (this.lastAgentIssue) return this.lastAgentIssue.phase;
    return 'missing';
  }

  private projectBackend(d: BackendDescriptor, ollama: OllamaStatus, apiKeySet: boolean): SetupBackendOption {
    const option: SetupBackendOption = {
      id: d.id,
      kind: d.kind,
      status: d.status,
      displayName: d.displayName,
      description: d.description,
    };
    if (d.remote) {
      const endpointValue = (this.host.getSetting<string>(d.remote.endpoint.settingKey) ?? '').trim();
      option.remote = {
        endpointDefault: d.remote.endpoint.defaultValue,
        endpointValue,
        endpointPlaceholder: d.remote.endpoint.placeholder,
        auth:
          d.remote.auth.kind === 'apiKey' ? (d.remote.auth.required ? 'apiKey-required' : 'apiKey-optional') : 'none',
        apiKeySet,
        probe: d.remote.probe.kind,
      };
    }
    if (d.localInstall) {
      option.localInstall = {
        flavor: d.localInstall.recipe.kind,
        effort: d.localInstall.effort,
        ...(d.localInstall.models
          ? {
              models: d.localInstall.models.defaults.map((m) => ({
                role: m.role,
                model: m.model,
                present: ollama.running ? ollama.models.some((om) => om.name === m.model) : false,
              })),
            }
          : {}),
      };
    }
    if (d.nextEditTransport) option.nextEditTransport = d.nextEditTransport;
    if (d.docsUrl) option.docsUrl = d.docsUrl;
    return option;
  }

  private async safeProbeOllama(endpoint: string): Promise<OllamaStatus> {
    try {
      return await this.deps.probeOllama(endpoint);
    } catch (err) {
      return { running: false, detail: this.redact(errorMessage(err)) };
    }
  }

  /** T6 M-3 carry-forward: replace the real home directory with `~` in any
   *  text that might reach the webview (install/pull log lines, failure
   *  details) — Ollama/pipx error strings can embed local paths. */
  private redact(text: string): string {
    const home = homedir();
    return home ? text.split(home).join('~') : text;
  }

  private pushProgress(progress: SetupProgress): void {
    const key = `${progress.op}:${progress.id}`;
    const now = Date.now();
    let state = this.throttle.get(key);
    if (!state) {
      state = { lastEmit: -Infinity };
      this.throttle.set(key, state);
    }
    const elapsed = now - state.lastEmit;
    if (elapsed >= PROGRESS_THROTTLE_MS) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.lastEmit = now;
      state.pending = undefined;
      this.progressEmitter.fire(progress);
      return;
    }
    state.pending = progress;
    if (!state.timer) {
      const delay = PROGRESS_THROTTLE_MS - elapsed;
      state.timer = setTimeout(() => {
        const current = this.throttle.get(key);
        if (!current || !current.pending) return;
        current.lastEmit = Date.now();
        const toSend = current.pending;
        current.pending = undefined;
        current.timer = undefined;
        this.progressEmitter.fire(toSend);
      }, delay);
    }
  }
}

// --- module-local helpers ---------------------------------------------------

/**
 * Task 13 (§2.1): the Provider card from the ACP-advertised auth methods.
 * `undefined` = no `initialize` result has been surfaced (agent not
 * connected yet, or the active backend is the mock) ⇒ `waiting-agent`. Once
 * an advertisement exists: Hermes' adapter (`acp_adapter/auth.py::
 * build_auth_methods`) emits an agent-managed `<provider>` method iff
 * credentials already resolve, and ALWAYS the `hermes-setup` terminal-wizard
 * method — so any id ≠ `hermes-setup` IS the configured provider
 * (`providerId` = that id, first match wins: the adapter emits at most one),
 * and an advertisement of only `hermes-setup` (or, defensively, nothing at
 * all) means no provider is configured ⇒ `unconfigured`, never a fabricated
 * `configured`.
 *
 * Deliberately NOT gated on `agentPhase`: the advertisement can only exist
 * at all when a live ACP connection produced it, which is strictly stronger
 * evidence than the settings-derived `agentPhase` (e.g. Hermes resolved off
 * PATH without `talaria.hermesPath` set reads `missing` there while the wire
 * is genuinely up) — the composite `ready` still requires
 * `agentPhase === 'ready'` regardless, see {@link computeReady}.
 *
 * Final review wave, T13 M-1 (null-guard): `methods` reaches this function
 * through a dep seam whose OWN type (`AdvertisedAuthMethod[] | undefined`)
 * cannot enforce that every array ELEMENT is non-null at runtime (the
 * `acpClient.ts` projection this is ultimately sourced from is itself only
 * defensively — not statically — guarded, see its own doc comment). A null/
 * undefined entry is dropped rather than dereferenced: `m?.id` reads
 * `undefined` for such an entry, which never equals
 * `HERMES_SETUP_AUTH_METHOD_ID` — the `m?.id !== undefined` guard is what
 * keeps a dropped entry from being mistaken for a "managed" (non-`hermes-
 * setup`) method.
 */
function computeProviderCard(methods: AdvertisedAuthMethod[] | undefined): SetupData['provider'] {
  if (methods === undefined) return { phase: 'waiting-agent' };
  const managed = methods.find((m) => m?.id !== undefined && m.id !== HERMES_SETUP_AUTH_METHOD_ID);
  return managed ? { phase: 'configured', providerId: managed.id } : { phase: 'unconfigured' };
}

/**
 * `ready` composition, pulled out to its own function so the provider
 * phase's comparison against `'configured'` is checked against its DECLARED
 * type (`SetupData['provider']['phase']`, a function parameter) rather than
 * the narrower control-flow-inferred type a local `const` ternary would
 * carry. Reachable since Task 13: {@link computeProviderCard} produces
 * `'configured'` whenever the agent advertises a provider-managed auth
 * method.
 */
function computeReady(
  agentPhase: AgentSetupPhase,
  providerPhase: SetupData['provider']['phase'],
  fimGreen: boolean,
): boolean {
  return agentPhase === 'ready' && providerPhase === 'configured' && fimGreen;
}

function coerceNextEditTransport(raw: string | undefined): 'ollama' | 'openai-compat' {
  return raw === 'openai-compat' ? 'openai-compat' : 'ollama';
}

/**
 * T5 §1.2: the `pipx-missing` card's engine-composed bootstrap. A known
 * family carries the exact pre-typed line + the §6 known-distro copy; an
 * unknown family (incl. the container degrade) carries ONLY the §6
 * unknown-distro copy — no command is ever guessed (Global Constraint 1).
 */
function composeBootstrap(osInfo: OsResolution): { command?: string; guidance: string } {
  const spec = installCommand(osInfo.family, 'pipx');
  return spec !== undefined
    ? { command: spec.command, guidance: PIPX_MISSING_KNOWN_DISTRO_GUIDANCE }
    : { guidance: PIPX_MISSING_UNKNOWN_DISTRO_GUIDANCE };
}

/**
 * T5: strict server-side enum validation of `setup.openBootstrapTerminal`'s
 * `{target}` param (SECURITY, Global Constraint 1 — webview input is never
 * trusted). Absent params / absent key = `'pipx'` (back-compat with the T11
 * param-less call). A PRESENT key with anything but the two literals —
 * including a non-string — is `undefined` = refuse; it is NOT coerced to
 * the default, so a malformed request can never silently open the pipx path.
 */
function validateBootstrapTarget(params: unknown): 'pipx' | 'python' | undefined {
  if (params === undefined || params === null) return 'pipx';
  if (typeof params !== 'object') return undefined;
  if (!('target' in params)) return 'pipx';
  const raw = (params as Record<string, unknown>)['target'];
  if (raw === undefined) return 'pipx';
  return raw === 'pipx' || raw === 'python' ? raw : undefined;
}

function deriveHermesAcpPath(hermesPath: string): string {
  const posix = hermesPath.replace(/\\/g, '/');
  const idx = posix.lastIndexOf('/');
  const dir = idx >= 0 ? posix.slice(0, idx) : '';
  return dir ? `${dir}/hermes-acp` : 'hermes-acp';
}

function str(params: unknown, key: string): string | undefined {
  if (params && typeof params === 'object' && key in params) {
    const v = (params as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function bool(params: unknown, key: string): boolean | undefined {
  if (params && typeof params === 'object' && key in params) {
    const v = (params as Record<string, unknown>)[key];
    return typeof v === 'boolean' ? v : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateTunableValue(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (key) {
    case 'talaria.autocomplete.debounceMs':
    case 'talaria.rag.debounceMs':
      return isNonNegativeNumber(value)
        ? { ok: true, value }
        : { ok: false, reason: `${key} must be a non-negative number.` };
    case 'talaria.autocomplete.maxPromptTokens':
    case 'talaria.rag.maxChunkTokens':
      return isPositiveInteger(value)
        ? { ok: true, value }
        : { ok: false, reason: `${key} must be a positive integer.` };
    case 'talaria.autocomplete.temperature':
      return typeof value === 'number' && value >= 0 && value <= 2
        ? { ok: true, value }
        : { ok: false, reason: `${key} must be a number between 0 and 2.` };
    case 'talaria.rag.dims':
      return isNonNegativeInteger(value)
        ? { ok: true, value }
        : { ok: false, reason: `${key} must be a non-negative integer.` };
    case 'talaria.rag.excludeGlobs':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? { ok: true, value }
        : { ok: false, reason: `${key} must be an array of strings.` };
    case 'talaria.autocomplete.crossFile.enabled':
    case 'talaria.autocomplete.crossFile.prefixInjection':
    case 'talaria.autocomplete.crossFile.warmUp':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${key} must be a boolean.` };
    default:
      return { ok: false, reason: 'not a tunable' };
  }
}
