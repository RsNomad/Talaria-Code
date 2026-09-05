import { homedir } from 'node:os';
import type { BackendDescriptor, InstallRecipe, ProbeSpec } from './registry';
import type { HfDigestVerdict, HfGgufSpec, LfsOidVerdict } from './hfDigest';
import { managerFor, parseOsRelease, resolveDistroFamily } from './osDetect';
import { installCommand, pythonInstallPlan } from './packageTable';
import type { PipxEnv, PipxLocateResult } from './pipxLocator';
import type { HermesPaths, InstallEvent } from './pipxInstaller';
import type { OllamaStatus, PullProgress } from './ollamaClient';
import type { ProbeOutcome } from './remoteProbe';
import { validateEndpointUrl } from './remoteProbe';
import { MODEL_CATALOG, VLLM_ONLY_SERVE_REPOS, assertCatalogSource } from './modelCatalog';
import type { CatalogModel, CatalogRole } from './modelCatalog';
import type { LlamaCppLocateResult } from './llamaCppLocator';
import type { GgufDestResult } from './modelStore';
import type { GgufStoreSpec } from './ggufIngest';
import { AUTOCOMPLETE_API_KEY_SECRET } from '../../autocomplete/apiKey';
import { createMutationGate, type MutationGate } from '../util/mutationGate';
import { LatchRegistry, SETUP_DISPOSED_REFUSAL } from './latchRegistry';
import { SettledProbeMemo } from './settledProbeMemo';
import {
  ProvisionRunner,
  assertProvisionSources,
  isAllowlistedHfOwner,
  LLAMACPP_HONEST_ABSENCE,
  PROVISION_UNKNOWN_ID_REFUSAL,
  canonicalPullLatchId,
} from './provisionRunner';
import { redactForModal, refuseUnsafeModalText } from './modalText';
import {
  DEFAULT_OLLAMA_ENDPOINT,
  PIPX_MISSING_UNKNOWN_DISTRO_GUIDANCE,
  coerceDedicatedBackendId,
  composeAgentBlock,
  composeBootstrap,
  composeFimTuning,
  composeNextEditBlock,
  composeOsBlock,
  composeRagBlock,
} from './statusBlocks';
import type { OsResolution } from './statusBlocks';
import type {
  AgentSetupPhase,
  SetupBackendOption,
  SetupCancelResult,
  SetupCatalogModel,
  SetupData,
  SetupMethod,
  SetupProgress,
} from '../../shared/protocol';
import { SETUP_METHODS } from '../../shared/protocol';

// --- WS-GD.2b B7: façade re-exports — these symbols now live in provisionRunner.ts /
// modalText.ts / latchRegistry.ts; re-exported here so existing external import
// paths (tests, skillsAdminHandler.ts, ControlDispatcher-side code) stay stable. ---
export { SETUP_DISPOSED_REFUSAL } from './latchRegistry';
export { isHostSourcedModel, assertProvisionSources } from './provisionRunner';
export { MODAL_UNSAFE_TEXT_PATTERN, redactForModal } from './modalText';

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
 *   FM-12 — tracked via {@link latches} ({@link LatchRegistry}), which ALSO
 *   holds each attempt's `AbortController` so `setup.cancel` can interrupt it.
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
  /**
   * F2-17: the GLOBAL-scope stored value of `key` (VS Code
   * `inspect(key)?.globalValue`) — `undefined` = not set at Global scope.
   * Backs {@link SetupController.writeSettingsBatch}'s exact rollback.
   * OPTIONAL (the `discoverHermes` idiom): every existing host fake keeps
   * compiling; when absent the batch skips rollback and SAYS so.
   */
  inspectSettingGlobal?(key: string): unknown;
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

/**
 * T13 (beta.5 §4.4.3d): what the controller hands the T14 ingest engine —
 * ALWAYS the registry-pinned artifact (`NEXT_DEDICATED_MODEL.gguf` +
 * `ollamaCreatedName`), never anything webview-derived. The engine's own
 * io/fs/fetch seams are bound in `setupHost.vscode.ts`, NOT passed here.
 */
export interface GgufIngestSpec {
  gguf: {
    hfRepo: string;
    file: string;
    quant: string;
    sha256: string;
    approxBytes: number;
    /** T3 (beta.6 §2.4): optional — meaningful only in `pinned` mode (the
     *  pinned llama.cpp/Ollama path passes it for `verifyHfDigest`'s exact-
     *  file-set check upstream of `ingestGguf`; `live-oid` mode passes
     *  none, since nothing else in the repo is ever read for that file). */
    allowedRepoFiles?: readonly string[];
  };
  ollamaCreatedName: string;
}

export interface SetupControllerDeps {
  /** Bound to its real `ExecLookup` by the caller. Can REJECT — always try/catch this (T4 M-2).
   *  T11 (§3, critic C-11): optional `signal`, checked between `locatePipx`'s
   *  internal steps — `handleInstall` passes its `AbortController.signal` so
   *  Cancel can reach a wedged probe. */
  locatePipx(signal?: AbortSignal): Promise<PipxLocateResult>;
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
  /**
   * T13 (beta.5 §4.4.3c): the HF-tree digest pre-flight — bound to the real
   * `verifyHfDigest(fetch, gguf)` (`src/host/setup/hfDigest.ts`) by the
   * caller. ANY `{ok:false}` (mismatch, missing lfs.oid, set mismatch, HTTP
   * error, timeout) maps to the one pinned integrity refusal and aborts the
   * download BEFORE the modal — the user is never asked to approve an
   * artifact that already failed verification.
   */
  verifyHfDigest(gguf: HfGgufSpec): Promise<HfDigestVerdict>;
  /**
   * T2→T7 (beta.6 §2.2.5, carried obligation T2-N1): the `live-oid` resolver
   * for the allowlist tier — bound to the real
   * `resolveLfsOid(fetch, hfRepo, file)` (`src/host/setup/hfDigest.ts`) by
   * the caller. Resolves ONE file's live `lfs.oid` (lfs-only, 10 s,
   * pagination-refuse, 64-hex shape assert). ⚠ `resolveLfsOid` does NOT
   * re-assert the charset of its inputs — the controller MUST pass strings
   * that already cleared {@link assertProvisionSources} (SC-1,
   * assert-before-resolve ordering; spy-order-locked by the T7 poisoned-
   * fixture tests). ANY `{ok:false}` (or a rejecting seam) maps to the one
   * pinned integrity refusal BEFORE the Tier-1 modal.
   */
  resolveLfsOid(hfRepo: string, file: string): Promise<LfsOidVerdict>;
  /**
   * T13 → T14 (beta.5 §4.4.3d): the digest-enforced ingest engine —
   * stream-download to a temp file hashing incrementally, refuse on byte
   * mismatch BEFORE any Ollama call, then `POST /api/blobs/sha256:{pin}`
   * (server re-verifies) + `POST /api/create`. Declared HERE (the interface
   * T14's real engine must satisfy); `setupHost.vscode.ts` binds it. Rejects
   * on any failure; an AbortError rejection = user cancel. `onProgress`
   * rides the SAME `{op:'pull', id: ollamaCreatedName}` progress stream as
   * a library pull — zero new UI plumbing.
   */
  ingestGguf(
    spec: GgufIngestSpec,
    endpoint: string,
    onProgress: (p: PullProgress) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * T6 (beta.6 §2.4/§2.5): the T5 `llama-server` locator, bound to
   * `locateLlamaServer(exec, signal)` by the caller. The binding NEVER
   * probes on win32 — it resolves `{ok:false, reason:'probe-timeout'}`
   * there, which this controller maps (like every probe-timeout) to the
   * honest wire state `'unknown'`, never `'missing'` (CC-5). The `signal`
   * is each probe attempt's own — a scoped `setup.recheck
   * {scope:'llamacpp'}` aborts the superseded attempt through it.
   */
  locateLlamaServer(signal?: AbortSignal): Promise<LlamaCppLocateResult>;
  /**
   * T6 (beta.6 §2.2.8): ONE sidecar-attested presence scan over the whole
   * `MODEL_CATALOG` — bound to `modelStore.scanPresence(io, MODEL_CATALOG)`
   * over the real fs/env seams by the caller. Keyed by catalog id; a row
   * absent from the map reads as not-present. Awaited inside `status()`
   * BEFORE the CR-002 synchronous tail (a cheap stat pass — §2.5); a
   * rejection is caught by {@link SetupController.safeScanStorePresence}
   * and degrades fail-closed to all-absent.
   */
  scanStorePresence(): Promise<ReadonlyMap<string, boolean>>;
  /**
   * T6 (beta.6 §2.5): READ-ONLY store-dest composition (`storeRoot` +
   * `ggufDest` over the real env) — used solely to compose the display
   * `runCommand` for a file the scan already attested present. Never used
   * ahead of a WRITE — the write path must go through
   * {@link checkedStoreDest} (symlink-refusing) instead.
   */
  storeDest(hfRepo: string, file: string): GgufDestResult;
  /**
   * T6→T7 (beta.6 SC-A-3): the WRITE gate — `storeRoot` +
   * `lstatCheckedGgufDest` (lstat-based, symlink-refusing, ENOENT-tolerant)
   * over the real fs seams. T7's `handleProvisionModel` MUST resolve its
   * destination through THIS (never {@link storeDest}) before ever calling
   * {@link downloadGgufToStore}.
   */
  checkedStoreDest(hfRepo: string, file: string): Promise<GgufDestResult>;
  /**
   * T6→T7 (beta.6 §2.4): the T3 atomic file sink (`downloadGgufToStore`),
   * bound to the real `GgufStoreIo` (the same `ggufIo` object `ingestGguf`
   * rides) by the caller. Consumed by T7's `handleProvisionModel`
   * llamacpp branch; declared here so the binding lands with the rest of
   * the T6 wiring.
   */
  downloadGgufToStore(
    spec: GgufStoreSpec,
    destDir: string,
    destFile: string,
    onProgress: (p: PullProgress) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * beta.7 B3: the deliberate teardown+respawn+re-`initialize()` reconnect —
   * bound to `(opts) => backend.reconnectAgent?.(opts) ?? Promise.resolve({
   * ok:false, reason:...})` (a thunk over the CURRENT backend, `extension.ts`)
   * so the trust-upgrade mock→real swap is reflected on the next call.
   * T16: `opts.force` threads straight through to `ConnectionSupervisor.
   * reconnect`'s own force posture — this seam does no parsing of its own
   * (that's {@link SetupController.handleReconnectAgent}'s job, fail-closed
   * via the `bool` helper). OPTIONAL
   * (posture of `loadTab?`/`getAdvertisedAuthMethods?` above) — NOT a
   * required member: a required member would break `check-types:all` in
   * every existing deps-literal/factory-call test site. `undefined` = no
   * ACP backend bound (mock backend) — {@link SetupController.
   * handleReconnectAgent} fails closed with an honest reason rather than
   * throwing.
   */
  reconnectAgent?(opts?: { force?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * TC-3 (AU-8 / INV-11): the SAME settings-OR-PATH resolution the runtime
   * uses to find `hermes` — bound to `resolveHermesBin({}, exec)`
   * (`src/host/runtime/resolveHermes.ts`) by the caller. Called ONLY when
   * `talaria.hermesPath` is empty (a configured setting is authoritative and
   * is never second-guessed by a PATH probe); resolves the discovered
   * absolute path, or REJECTS if the login-shell PATH lookup fails —
   * {@link SetupController.hermesDiscoveryMemo}'s `onRejected` maps a
   * rejection to the honest "not found" memo state, mirroring {@link
   * SetupControllerDeps.locateLlamaServer}'s reject→settle posture. OPTIONAL
   * (same idiom as {@link reconnectAgent} above, same reason: a required
   * member would break every existing deps-literal/factory-call test site);
   * `undefined` binding = the phase truth stays settings-only, i.e. the
   * pre-AU-8 behavior, never a crash.
   */
  discoverHermes?(): Promise<string>;
}

// --- misc constants -------------------------------------------------------

const PROGRESS_THROTTLE_MS = 150;
/** CA-M18: single-flight, short-TTL memo window over {@link
 *  SetupController.safeProbeOllama} — see that method's doc for why. */
export const OLLAMA_PROBE_MEMO_TTL_MS = 1_000;
const LOG_TAIL_MAX = 40;
const DEFAULT_FIM_MODEL = 'qwen2.5-coder:1.5b-base';
const TRUST_REFUSAL_REASON = 'Workspace is not trusted — Setup changes are disabled in Restricted Mode.';
/**
 * Task 13: the id of Hermes' ALWAYS-advertised terminal setup-wizard auth
 * method — pinned by the adapter itself (`acp_adapter/auth.py`:
 * `TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup"`). Every OTHER advertised
 * id is an agent-managed provider credential method (§2.1).
 */
export const HERMES_SETUP_AUTH_METHOD_ID = 'hermes-setup';
const CONTAINER_NOTE =
  "Talaria can't tell which system your terminal acts on (VS Code appears to run in a sandbox/container) — run the install commands in a terminal on your host system, then re-check.";

// --- T8 (beta.6 §2.5/§6): setup.saveAgentModel — copy + constants, verbatim --

/** §2.5 role-gate: a fim/embedding/next catalog id is refused outright — this
 *  method only ever records the AGENT block's selection. */
const SAVE_AGENT_ROLE_REFUSAL = 'modelId must be an agent-role catalog model.';
/** Strict-enum refusal — UNLIKE {@link PROVISION_BACKEND_REFUSAL}, 'vllm' IS
 *  allowed here: this method only RECORDS which backend serves the model, it
 *  never downloads (that stays `setup.provisionModel`'s job). */
const SAVE_AGENT_BACKEND_REFUSAL = "backend must be 'ollama', 'llamacpp', or 'vllm'.";
/** Modal copy for `{clear:true}` — same Tier-1-modal-gated-unset discipline
 *  as {@link SetupController.handleSetApiKey}'s `clear` branch (the
 *  established precedent this method's Clear path mirrors exactly). Not §6-
 *  pinned (the doc pins only the SAVE modal's wording) — chosen to match
 *  that precedent's phrasing + confirm label ('Clear') verbatim. */
const CLEAR_AGENT_MODEL_MODAL = 'Clear the saved local agent model?';
/** §1.3/§2.5 (CC-6): host-owned agent endpoint defaults — the block's
 *  endpoint field initializes from these (saved wins). `llamacpp` matches
 *  {@link LLAMACPP_RUN_FLAGS}'s agent port (8013); `vllm` matches vLLM's own
 *  default port. `ollama` reuses {@link DEFAULT_OLLAMA_ENDPOINT} — ONE
 *  source for that value, never a second literal. */
const AGENT_ENDPOINT_DEFAULTS: Readonly<{ ollama: string; llamacpp: string; vllm: string }> = {
  ollama: DEFAULT_OLLAMA_ENDPOINT,
  llamacpp: 'http://127.0.0.1:8013',
  vllm: 'http://127.0.0.1:8000',
};

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
  // beta.6 T7 (§2.5 step 0): the catalog provisioning gate is consequence-
  // bearing (network download + disk/daemon writes) — trust-gated like every
  // other mutation.
  'setup.provisionModel',
  // beta.6 T8 (§2.5): writes (or unsets) the 3 `talaria.agent.localModel.*`
  // settings — consequence-bearing like every other Tier-1 settings write;
  // follows `setup.provisionModel`'s exact registration pattern.
  'setup.saveAgentModel',
  'setup.openProviderWizard',
  'setup.openInstallTerminal',
  'setup.openBootstrapTerminal',
  'setup.reload',
  'setup.reconnectAgent',
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

/** TE-4 (AU-11, INV-15) belt: derived from the SAME `SETUP_METHODS` `as
 *  const` array {@link SetupMethod} comes from — checked at RUNTIME by
 *  {@link SetupController.handle} before its switch. The switch itself is
 *  exhaustive only at COMPILE time (`method: SetupMethod`); a `postMessage`
 *  payload is never actually type-checked, so a name outside this Set fell
 *  through every `case` with no runtime `default`, implicitly returning
 *  `undefined` — which the caller (`TalariaViewProvider.handleSetupMethod`)
 *  then read as a success (`ok:true`) AND used as the trigger to push a
 *  fresh `SetupData` status probe. `TalariaViewProvider.handleControlRequest`
 *  now refuses an unknown method before `handle` is ever reached (the
 *  primary chokepoint) — this Set is the second, independent belt for any
 *  other caller of `handle` directly. */
const SETUP_METHOD_SET: ReadonlySet<string> = new Set<SetupMethod>(SETUP_METHODS);

export interface ThrottleState {
  lastEmit: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: SetupProgress | undefined;
}

/** F2-16: an entry with no armed timer, no pending value, and a lastEmit
 *  older than the throttle window is SEMANTICALLY identical to no entry (a
 *  fresh entry's `-Infinity` lastEmit also fires immediately) — so pruning
 *  it is behavior-preserving, and the map stops growing one entry per
 *  (op,id) pair forever. Exported pure for direct unit tests. */
export function pruneExpiredThrottleEntries(
  throttle: Map<string, ThrottleState>,
  now: number,
  throttleMs: number,
): void {
  for (const [key, state] of throttle) {
    if (state.timer === undefined && state.pending === undefined && now - state.lastEmit >= throttleMs) {
      throttle.delete(key);
    }
  }
}

/** T6 (§2.5): the llama.cpp runtime memo's settled shape — the current
 *  inline field type, named for {@link SettledProbeMemo}'s type parameter. */
type LlamaCppSettled = { binary: 'found' | 'missing' | 'unknown'; version?: string; path?: string };

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
   * (and never to a read-only one). beta.6 T7 adds ONE more fire site:
   * {@link provisionLlamacpp} after a successful store download (§2.5 5d —
   * the sidecar just landed, so the presence scan's verdict flips).
   */
  private readonly statusChangedEmitter = new Emitter<void>();
  readonly onStatusChanged: Event<void> = this.statusChangedEmitter.event;

  /** CA-M18: any state change that re-pushes SetupData ALSO invalidates the
   *  probe memo — the resulting status() pass reflects post-change truth,
   *  while the two pushes it triggers still share ONE fresh probe. */
  private bumpStatus(): void {
    this.ollamaProbeMemo = undefined;
    this.statusChangedEmitter.fire();
  }

  /** Keyed `${op}:${id}` (`install:<backendId>` / `pull:<model>`) — presence = single-flight latch (FM-12); the held `AbortController` is what `setup.cancel` interrupts. */
  private readonly latches = new LatchRegistry(() => this.lifecycle.closed);
  /** WS-GD.2b B7: the provision/pull family, extracted to its own class —
   *  see {@link ProvisionRunner}'s own doc for the cycle rule this seam exists
   *  to satisfy (it never imports from this file). Assigned in the
   *  constructor BODY, not as a field initializer here — a field initializer
   *  would read `this.deps` (a constructor parameter property) BEFORE the
   *  constructor body has assigned it, which `tsc` refuses to compile
   *  (TS2729, "used before its initialization"; field initializers run
   *  before the constructor's own body for a base class with no `extends`). */
  private readonly provision: ProvisionRunner;
  private readonly throttle = new Map<string, ThrottleState>();
  /** F2-16: the WS-R2 gate idiom — flipped CLOSED synchronously by
   *  {@link dispose} BEFORE any teardown, so {@link LatchRegistry.arm} can
   *  never arm a new install/pull latch that no dispose will ever abort (the
   *  TC-6 detached-download class, closed structurally at one choke point). */
  private readonly lifecycle: MutationGate = createMutationGate();

  private installLogTail: string[] = [];
  private lastAgentIssue: { phase: AgentSetupPhase; detail: string } | undefined;
  /** Set once a `setup.install` succeeds THIS session; never cleared here (a real reload replaces the whole extension host, and therefore this controller instance). */
  private awaitingReload = false;
  /** T5: memoized OS detection (a PROMISE, so concurrent `status()` calls
   *  share one read) — cleared by `setup.recheck` so the next demand
   *  re-reads (the user may have installed VS Code outside the sandbox, or
   *  the file may have become readable). */
  private osResolution: Promise<OsResolution> | undefined;

  constructor(
    private readonly host: SetupHost,
    private readonly deps: SetupControllerDeps,
  ) {
    this.provision = new ProvisionRunner(
      {
        showModal: (m, l) => this.host.showModal(m, l),
        redact: (t) => this.redact(t),
        pushProgress: (p) => this.pushProgress(p),
        bumpStatus: () => this.bumpStatus(),
      },
      this.deps,
      this.latches,
    );
  }

  /**
   * T6 (beta.6 §2.5): the llama.cpp runtime settled-value memo — see {@link
   * SettledProbeMemo} for the shared kick/invalidate/rekick/supersede
   * contract (deliberately NOT the awaited {@link osResolution} pattern,
   * which cannot express `'checking'`). `status()` kicks the probe once
   * (lazily, {@link kickLlamaCppProbe}) and returns immediately with
   * `'checking'`; the probe's settle writes {@link SettledProbeMemo.value}
   * and fires {@link onStatusChanged} exactly ONCE via `onSettled` (the
   * seq-guarded push repaints). Unsettled `.value` = not settled yet. The
   * `path` is stored ALREADY `~`-redacted (T6 M-3 discipline). Cancellable:
   * true — {@link SetupControllerDeps.locateLlamaServer} takes an
   * `AbortSignal`, so a scoped recheck (or {@link dispose}) cancels a
   * superseded login-shell probe instead of leaving it lingering (T5 CR-1
   * signal threading). CAUTION (construction order): this field initializer
   * reads `this.deps`/`this.redact` inside its `probe`/`onSettled` closures
   * — safe because those closures only run LATER, at `kick()` time, well
   * after the constructor above has already bound `this.deps`/`this.host`.
   */
  private readonly llamaCppMemo = new SettledProbeMemo<LlamaCppSettled>({
    probe: async (signal) => {
      const result = await this.deps.locateLlamaServer(signal);
      return result.ok
        ? {
            binary: 'found',
            ...(result.version !== undefined ? { version: result.version } : {}),
            path: this.redact(result.path),
          }
        : { binary: result.reason === 'probe-timeout' ? 'unknown' : 'missing' };
    },
    onRejected: () => ({ binary: 'unknown' }),
    onSettled: () => this.bumpStatus(),
    cancellable: true,
  });

  /**
   * TC-3 (AU-8 / INV-11): the Hermes PATH-discovery settled-value memo — SAME
   * {@link SettledProbeMemo} contract as {@link llamaCppMemo} above.
   * Unsettled `.value` = never probed; `{found: string | null}` = settled
   * (`found` = the discovered absolute path, `null` = the login-shell PATH
   * lookup came up empty or rejected — the honest "not found" outcome, never
   * a thrown error out of `status()`). `status()` kicks the probe lazily
   * ({@link kickHermesDiscovery}) ONLY when `talaria.hermesPath` is unset,
   * and only while `this.deps.discoverHermes` is bound — an unbound dep
   * (older/partial wiring) leaves this memo permanently unsettled, which
   * {@link computeAgentPhase} reads exactly like the pre-AU-8 settings-only
   * truth (the unbound-dep guard stays in {@link kickHermesDiscovery} itself
   * — the memo never learns about optional deps; the `discover` re-read
   * inside `probe` below narrows only to satisfy the type checker for a path
   * that `kickHermesDiscovery`'s guard already makes unreachable — `deps` is
   * `readonly`, so it cannot become unbound between the guard and this call).
   * Cancellable: false — {@link SetupControllerDeps.discoverHermes} takes no
   * `AbortSignal`, so a superseded attempt keeps running in the background;
   * the epoch just makes ITS eventual settle inert.
   */
  private readonly hermesDiscoveryMemo = new SettledProbeMemo<{ found: string | null }>({
    probe: async () => {
      const discover = this.deps.discoverHermes;
      return { found: discover ? await discover() : null };
    },
    onRejected: () => ({ found: null }),
    onSettled: () => this.bumpStatus(),
    cancellable: false,
  });

  dispose(): void {
    // F2-16: flip the gate CLOSED synchronously, FIRST — before any teardown
    // below — so a concurrent `latches.arm` call can never interleave between
    // this flip and the teardown that follows (run-to-completion; see
    // {@link LatchRegistry.arm}'s own doc for the atomicity this buys).
    void this.lifecycle.close(Promise.resolve());
    for (const state of this.throttle.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.throttle.clear();
    // TC-6 (AU-6): abort every install/pull/provision still latched in
    // `this.latches` — at HEAD this map was never iterated here, so a
    // window-reload mid-install left the pipx child / multi-GB GGUF fetch
    // running detached from a disposed controller. Placed BEFORE the emitter
    // disposals below (mirrors the llama.cpp probe ordering just after) so
    // any synchronous abort-path progress a caller emits still finds a live
    // emitter or is dropped harmlessly; the existing `finally {
    // this.latches.release(key) }` blocks in every handler make a late
    // release here (once those handlers' own catch/finally runs) a no-op.
    // `AbortController#abort()` never throws — even a listener that throws
    // is reported asynchronously (Node/DOM event-dispatch semantics), never
    // synchronously out of `abort()` — so this loop cannot abort disposal
    // partway through, keeping `dispose()` safe/idempotent by construction.
    this.latches.abortAll();
    // T6: supersede + cancel any in-flight llama.cpp probe — its late settle
    // must neither write state nor fire into the (now-cleared) emitter.
    this.llamaCppMemo.supersede();
    // TC-3 (AU-8/INV-11): supersede any in-flight Hermes discovery probe too
    // — no abort seam exists (discoverHermes takes no signal), so bumping the
    // epoch is the only guard; its late settle is dropped (epoch mismatch)
    // instead of writing state or firing into the disposed emitter.
    this.hermesDiscoveryMemo.supersede();
    // CA-M18: drop the Ollama probe memo too — an in-flight probe's late
    // settle is harmless (it resolves the stored promise, nothing more),
    // but a disposed controller must never SERVE a memoized result again.
    this.ollamaProbeMemo = undefined;
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
    // T6 (§2.5): kick the llama.cpp probe FIRST (lazy, non-blocking — the
    // settled-value memo, see kickLlamaCppProbe) so it runs concurrently
    // with the awaits below; this call never waits on it.
    this.kickLlamaCppProbe();
    const hermesPath = (this.host.getSetting<string>('talaria.hermesPath') ?? '').trim();
    // TC-3 (AU-8/INV-11): kick the Hermes PATH-discovery probe too, same lazy
    // non-blocking posture — ONLY when the setting is empty (a configured
    // talaria.hermesPath is authoritative and is never second-guessed by a
    // PATH probe). See kickHermesDiscovery.
    if (!hermesPath) this.kickHermesDiscovery();
    const apiKeySet = await this.host.secrets.has(AUTOCOMPLETE_API_KEY_SECRET);
    // T5 §1.2: interpreted (memoized) OS identity — drives the `os` block
    // and, per phase, the engine-composed bootstrap / python plans below.
    const osInfo = await this.resolveOs();

    const ollamaDescriptor = this.deps.registry.getBackend('ollama');
    const ollamaEndpoint = ollamaDescriptor?.remote?.endpoint.defaultValue ?? DEFAULT_OLLAMA_ENDPOINT;
    const ollamaStatus = await this.safeProbeOllama(ollamaEndpoint);
    // T6 (§2.5 ordering constraint): the store scan is a cheap stat pass
    // awaited HERE, alongside safeProbeOllama — strictly BEFORE the CR-002
    // synchronous tail below, so the emitted snapshot always carries a
    // RESOLVED presence map (locked by the ordering test).
    const storePresence = await this.safeScanStorePresence();

    const configuredBackend = this.host.getSetting<string>('talaria.backend') ?? 'mock';
    // TC-3 (AU-8/INV-11): the discovered PATH fallback — `null`/unsettled
    // both read as "nothing found yet", exactly like a settings-only miss.
    const agentPhase = this.computeAgentPhase(hermesPath, configuredBackend, this.hermesDiscoveryMemo.value?.found);
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

    const fimAuthSatisfied =
      fimDescriptor.remote?.auth.kind !== 'apiKey' || !fimDescriptor.remote.auth.required || apiKeySet;

    // Task 13 (§2.1): the Provider card is driven SOLELY by the ACP-advertised
    // auth methods, read through the dep seam at call time — see
    // computeProviderCard's own doc for the mapping (and why it is
    // deliberately NOT gated on agentPhase).
    const provider = computeProviderCard(this.deps.getAdvertisedAuthMethods());

    const nextSource = this.deps.getNextEditSource();
    const genericSupported = fimDescriptor.nextEditTransport !== undefined;

    const fimGreen = fimDescriptor.status === 'available' && enabled && fimAuthSatisfied;
    const ready = computeReady(agentPhase, provider.phase, fimGreen);

    const data: SetupData = {
      trusted,
      agent: composeAgentBlock({
        options: agentOptions,
        phase: agentPhase,
        installRecordVersion: installRecord?.version,
        lastIssueDetail: this.lastAgentIssue?.detail,
        logTail: this.installLogTail,
        osInfo,
      }),
      provider,
      fim: {
        options: fimOptions,
        selectedId: fimDescriptor.id,
        enabled,
        model,
        endpointValue,
        tuning: composeFimTuning(this.host),
      },
      nextEdit: composeNextEditBlock({
        reader: this.host,
        nextSource,
        genericSupported,
        fimDisplayName: fimDescriptor.displayName,
      }),
      rag: composeRagBlock({
        reader: this.host,
        trusted,
        ollamaRunning: ollamaStatus.running,
        ollamaModels: ollamaStatus.running ? ollamaStatus.models : [],
      }),
      // T13 (§4.2): `endpoint` = the endpoint this status() ACTUALLY probed
      // — presence claims are scoped to it (critic C-6).
      ollama: ollamaStatus.running
        ? { running: true, endpoint: ollamaEndpoint, models: ollamaStatus.models }
        : { running: false, endpoint: ollamaEndpoint, models: [] },
      // T6 (beta.6 §1.3): the verified catalog, all 13 rows, projected
      // against the resolved presence map (llamacpp cells + SC-2-gated vllm
      // cells composed by the pure helpers below).
      catalog: { models: MODEL_CATALOG.map((m) => this.projectCatalogModel(m, storePresence)) },
      // T6 (beta.6 §2.5): the settled-value memo's current truth —
      // 'checking' until the kicked probe settles.
      llamacppRuntime: this.composeLlamaCppRuntime(osInfo),
      // T8 (beta.6 §1.3/§2.5): the "Configure Local Agent Model" block's wire
      // state — host-owned endpoint defaults + the saved selection recomposed
      // fresh from the 3 `talaria.agent.localModel.*` settings on every call.
      agentLocalModel: this.composeAgentLocalModel(provider.phase, storePresence),
      ready,
      os: composeOsBlock(osInfo),
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

  // --- T6: llama.cpp runtime settled-value memo (§2.5) ----------------------

  /**
   * Kick the `llama-server` probe ONCE, lazily — a no-op while a settled
   * value exists or an attempt is already in flight. The settle writes
   * {@link llamaCppMemo}'s value and fires {@link onStatusChanged} exactly once;
   * a settle whose epoch was superseded (scoped recheck / dispose) is
   * DROPPED entirely. Mapping (CC-5): found ⇒ `'found'`, `not-found` ⇒
   * `'missing'`, `probe-timeout` ⇒ `'unknown'` (never `'missing'`); a
   * REJECTING binding also settles `'unknown'` — a probe failure must never
   * become an unhandled rejection out of a fire-and-forget kick.
   */
  private kickLlamaCppProbe(): void {
    this.llamaCppMemo.kick();
  }

  /** Clear state + memo, cancel the superseded attempt, and re-kick WITHOUT
   *  awaiting — `setup.recheck {scope:'llamacpp'}`'s non-blocking re-check
   *  (the recheck RPC's own budget is untouched). */
  private rekickLlamaCppProbe(): void {
    this.llamaCppMemo.rekick();
  }

  /** The wire projection of the memo (§1.3 `llamacppRuntime`): unsettled ⇒
   *  `'checking'`; `install` present iff `'missing'` (§4.1 — NEVER on
   *  `'unknown'`, where an install button would assert a fact the probe
   *  could not establish). */
  private composeLlamaCppRuntime(osInfo: OsResolution): NonNullable<SetupData['llamacppRuntime']> {
    const settled = this.llamaCppMemo.value;
    if (settled === undefined) return { binary: 'checking' };
    return {
      binary: settled.binary,
      ...(settled.version !== undefined ? { version: settled.version } : {}),
      ...(settled.path !== undefined ? { path: settled.path } : {}),
      ...(settled.binary === 'missing' ? { install: composeLlamacppInstall(osInfo) } : {}),
    };
  }

  // --- T6: catalog wire projection (§1.3) -----------------------------------

  /** {@link SetupControllerDeps.scanStorePresence} can reject (a non-ENOENT
   *  fs failure inside the store) — `status()` must stay total, so that
   *  degrades FAIL-CLOSED to an empty map: every cell honestly reads
   *  absent (same posture as {@link safeProbeOllama}). */
  private async safeScanStorePresence(): Promise<ReadonlyMap<string, boolean>> {
    try {
      return await this.deps.scanStorePresence();
    } catch {
      return new Map<string, boolean>();
    }
  }

  /** One catalog row → its §1.3 wire shape. The llamacpp/vllm cells go
   *  through the exported pure gates ({@link composeLlamacppCell} /
   *  {@link composeVllmCell}); the run-command dest is resolved through the
   *  READ-ONLY {@link SetupControllerDeps.storeDest} and `~`-redacted before
   *  it ever reaches the composed string. */
  private projectCatalogModel(model: CatalogModel, presence: ReadonlyMap<string, boolean>): SetupCatalogModel {
    const present = presence.get(model.id) === true;
    let redactedDestPath: string | undefined;
    if (present && model.llamacpp !== undefined) {
      const dest = this.deps.storeDest(model.llamacpp.gguf.hfRepo, model.llamacpp.gguf.file);
      if (dest.ok) redactedDestPath = this.redact(dest.destPath);
    }
    const llamacpp = composeLlamacppCell(model, present, redactedDestPath);
    const vllm = composeVllmCell(model);
    return {
      id: model.id,
      role: model.role,
      displayName: model.displayName,
      publisher: model.publisher,
      license: model.license,
      ...(model.defaultForRole === true ? { defaultForRole: true } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      vramLine: model.vramLine,
      ...(model.note !== undefined ? { note: model.note } : {}),
      progressId: model.id, // rule 7: the ONE pull/cancel/progress key
      ...(model.ollama?.tier === 'library'
        ? { ollamaTag: model.ollama.tag, ollamaApproxBytes: model.ollama.approxBytes }
        : {}),
      ...(model.ollama?.tier === 'hf-ingest'
        ? { ollamaCreatedName: model.ollama.createdName, ollamaApproxBytes: model.ollama.gguf.approxBytes }
        : {}),
      ...(llamacpp !== undefined ? { llamacpp } : {}),
      ...(vllm !== undefined ? { vllm } : {}),
    };
  }

  // --- handle() -------------------------------------------------------------

  /**
   * T6 (beta.6 CC-2): the success arm carries an optional `models` list —
   * populated ONLY by `setup.testRemote` when its `ProbeOutcome` returned
   * one (the block's quiet `Serving: {models}` line). Additive: every other
   * arm still resolves a bare `{ok:true}`, and existing callers pass
   * through `unwrapSetupResult` untouched.
   */
  async handle(
    method: SetupMethod,
    params: unknown,
  ): Promise<{ ok: true; models?: string[] } | { ok: false; reason: string } | SetupCancelResult> {
    // TE-4 (AU-11, INV-15) belt — see SETUP_METHOD_SET's doc: a method
    // outside the known set fails closed HERE, before the trust gate or the
    // switch, instead of silently falling through to an unhandled `undefined`.
    if (!SETUP_METHOD_SET.has(method)) {
      return { ok: false, reason: 'unknown setup method' };
    }
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
        return this.provision.handlePullModel(params);
      case 'setup.provisionModel':
        return this.provision.handleProvisionModel(params);
      case 'setup.saveAgentModel':
        return this.handleSaveAgentModel(params);
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
      case 'setup.reconnectAgent':
        return this.handleReconnectAgent(params);
      case 'setup.recheck':
        return this.handleRecheck(params);
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
    if (this.latches.has(key)) {
      return { ok: false, reason: 'install already running' };
    }
    const descriptor = this.deps.registry.getBackend(backendId);
    const recipe = descriptor?.localInstall?.recipe;
    if (!descriptor || !recipe || recipe.kind !== 'pipx') {
      return { ok: false, reason: `'${backendId}' has no pipx install recipe.` };
    }

    const abort = this.latches.arm(key);
    if (abort === undefined) return { ok: false, reason: SETUP_DISPOSED_REFUSAL };
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
      this.bumpStatus();

      let located: PipxLocateResult;
      try {
        // T4 M-2 carry-forward: locatePipx can REJECT (pipx vanishing
        // mid-flow) — never let that become an unhandled rejection. T11
        // (§3, critic C-11): pass this install's own abort signal so
        // Cancel can reach a wedged login-shell probe.
        located = await this.deps.locatePipx(abort.signal);
      } catch (err) {
        const detail = this.redact(errorMessage(err));
        this.lastAgentIssue = { phase: 'error', detail };
        this.bumpStatus();
        return { ok: false, reason: detail };
      }
      if (!located.ok) {
        const detail = this.redact(located.detail);
        // The sticky PHASE keeps the enum (computeAgentPhase's contract);
        // the RETURNED reason is a §6-grade human sentence (T5, critic
        // C-17): pipx-missing reuses the bootstrap card's own per-family
        // guidance copy; python-unsuitable / probe-timeout return the
        // locator's own detail (already a full sentence). T11 (§3, critic
        // C-8): `probe-timeout` has no dedicated AgentSetupPhase member — a
        // recheck-time probe timeout is not an install failure, so it maps
        // to the generic 'error' phase (the detail line carries the specifics).
        const phase: AgentSetupPhase = located.reason === 'probe-timeout' ? 'error' : located.reason;
        this.lastAgentIssue = { phase, detail };
        this.bumpStatus();
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
        this.bumpStatus();
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
        this.bumpStatus();
        return { ok: false, reason: detail };
      }
      this.awaitingReload = true;
      this.bumpStatus();
      this.host.offerReload();
      return { ok: true };
    } finally {
      this.latches.release(key);
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
      this.bumpStatus();
      this.pushProgress({ op: 'install', id: backendId, phase: event.phase, line: detail });
    } else if (event.kind === 'done') {
      this.pushProgress({ op: 'install', id: backendId, phase: 'verify', line: 'Install verified.' });
    }
  }

  /**
   * F2-17: one multi-key Global settings write as a DISCLOSED transaction —
   * sequential writes; on the first failure, best-effort rollback of every
   * key already written (to its exact prior Global value via the optional
   * {@link SetupHost.inspectSettingGlobal} seam) and an honest per-key
   * disclosure in the reason. Reasons carry closed `talaria.*` key literals
   * and a redacted error only — never setting VALUES (webview-bound).
   */
  private async writeSettingsBatch(
    writes: ReadonlyArray<readonly [string, unknown]>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const inspect = this.host.inspectSettingGlobal?.bind(this.host);
    const written: Array<readonly [string, unknown]> = [];
    for (const [key, value] of writes) {
      const prior = inspect?.(key);
      try {
        await this.host.updateSettingGlobal(key, value);
      } catch (err) {
        const detail = this.redact(errorMessage(err));
        if (written.length === 0) {
          return { ok: false, reason: `settings write failed at '${key}' (${detail}) — no other keys were changed.` };
        }
        if (inspect === undefined) {
          return {
            ok: false,
            reason:
              `settings write failed at '${key}' (${detail}) — already written and NOT rolled back: ` +
              `${written.map(([k]) => k).join(', ')}. Re-apply to finish, or revert in settings.json.`,
          };
        }
        const restored: string[] = [];
        const failed: string[] = [];
        for (const [k, prev] of written) {
          try {
            await this.host.updateSettingGlobal(k, prev);
            restored.push(k);
          } catch {
            failed.push(k);
          }
        }
        const parts = [`settings write failed at '${key}' (${detail}).`];
        if (restored.length > 0) parts.push(`Rolled back: ${restored.join(', ')}.`);
        if (failed.length > 0) parts.push(`Rollback FAILED for: ${failed.join(', ')} — check settings.json.`);
        return { ok: false, reason: parts.join(' ') };
      }
      written.push([key, prior] as const);
    }
    return { ok: true };
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
    const wrote = await this.writeSettingsBatch(entries.map(([k, v]) => [k, v] as const));
    if (!wrote.ok) return wrote;
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

    // T1 (beta.6 panel-fix PT1): optional `model` — trim; sanitize BEFORE the
    // modal that will interpolate it. Absent/empty ⇒ byte-identical prior
    // behavior (no third write, unchanged modal). A model supplied with
    // backendId:'llamacpp' is accepted-and-written, never special-cased
    // (C2-10a) — the setting is shared across FIM backends.
    const model = str(params, 'model')?.trim();
    if (model) {
      const sanitized = refuseUnsafeModalText(model, 'model');
      if (!sanitized.ok) return sanitized;
    }

    // T2 (beta.6 panel-fix CR-003): redact BEFORE the '(default)' fallback --
    // trim -> redact -> fallback, so an endpoint that's ALL unsafe chars
    // redacts to empty and correctly falls back to '(default)'. Display-only:
    // the WRITE below still stores validated.url, never this redacted copy.
    const oldEndpoint = redactForModal((this.host.getSetting<string>('talaria.autocomplete.endpoint') ?? '').trim()) || '(default)';
    const confirmed = await this.host.showModal(
      model
        ? `Switch autocomplete endpoint from '${oldEndpoint}' to '${validated.url}' (backend: ${descriptor.displayName}, model: ${model})?`
        : `Switch autocomplete endpoint from '${oldEndpoint}' to '${validated.url}' (backend: ${descriptor.displayName})?`,
      'Apply',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };

    const writes: Array<readonly [string, unknown]> = [
      ['talaria.autocomplete.backend', backendId],
      ['talaria.autocomplete.endpoint', validated.url],
    ];
    if (model) writes.push(['talaria.autocomplete.model', model]);
    return this.writeSettingsBatch(writes);
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

  private async handleTestRemote(
    params: unknown,
  ): Promise<{ ok: true; models?: string[] } | { ok: false; reason: string }> {
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
      // T6 (beta.6 CC-2): additive widening — the ProbeOutcome's served-model
      // list rides along when the probe returned one (the block renders a
      // quiet `Serving: {models}` line after a green Test); a bare success
      // stays EXACTLY {ok:true} so existing callers are unaffected.
      return outcome.ok
        ? { ok: true, ...(outcome.models !== undefined ? { models: outcome.models } : {}) }
        : { ok: false, reason: this.redact(outcome.detail) };
    } catch (err) {
      return { ok: false, reason: this.redact(errorMessage(err)) };
    }
  }

  // --- setup.saveAgentModel (beta.6 T8 — §2.5/§6) ---------------------------

  /**
   * T8 (beta.6 §2.5/§6): `setup.saveAgentModel {modelId, backend, endpoint}`
   * — or `{clear: true}` to unset. Refusal order:
   *
   *   1. `clear` branch (checked FIRST, same discipline as {@link
   *      handleSetApiKey}'s `clear` branch): Tier-1 modal → unset all 3
   *      `talaria.agent.localModel.*` keys Global. Every other param is
   *      ignored on this branch.
   *   2. `modelId` must resolve to a CATALOG row whose `role === 'agent'` —
   *      an unknown id refuses the same as `setup.provisionModel`'s
   *      unknown-id case; a fim/embedding/next id is REFUSED (role-gate).
   *   3. `backend` ∈ {'ollama','llamacpp','vllm'} — the FULL 3-enum
   *      (UNLIKE `setup.provisionModel`, which refuses 'vllm': this method
   *      only RECORDS which backend serves the model, it never downloads).
   *   4. `endpoint` via {@link validateEndpointUrl}.
   *   5. Tier-1 modal (§6 "Agent save modal", verbatim — names the model,
   *      backend, and endpoint) → THEN the 3 Global writes.
   *
   * `status()` (via {@link composeAgentLocalModel}) recomposes
   * `saved.runCommand`/`servedName`/`providerGuidance` from these three
   * settings on every read — this handler only ever writes the raw
   * selection, never a composed command (Global Constraint 5).
   */
  private async handleSaveAgentModel(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (bool(params, 'clear') === true) {
      const confirmed = await this.host.showModal(CLEAR_AGENT_MODEL_MODAL, 'Clear');
      if (!confirmed) return { ok: false, reason: 'declined' };
      const wrote = await this.writeSettingsBatch([
        ['talaria.agent.localModel.modelId', undefined],
        ['talaria.agent.localModel.backend', undefined],
        ['talaria.agent.localModel.endpoint', undefined],
      ]);
      return wrote.ok ? { ok: true } : wrote;
    }

    const modelId = str(params, 'modelId');
    const entry = modelId === undefined ? undefined : MODEL_CATALOG.find((m) => m.id === modelId);
    if (entry === undefined) return { ok: false, reason: PROVISION_UNKNOWN_ID_REFUSAL };
    if (entry.role !== 'agent') return { ok: false, reason: SAVE_AGENT_ROLE_REFUSAL };

    const backend = str(params, 'backend');
    if (backend !== 'ollama' && backend !== 'llamacpp' && backend !== 'vllm') {
      return { ok: false, reason: SAVE_AGENT_BACKEND_REFUSAL };
    }

    const endpointRaw = str(params, 'endpoint');
    if (!endpointRaw) return { ok: false, reason: 'endpoint is required.' };
    const validated = validateEndpointUrl(endpointRaw);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    const confirmed = await this.host.showModal(
      composeSaveAgentModal(entry.displayName, backend, validated.url),
      'Save',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };

    const wrote = await this.writeSettingsBatch([
      ['talaria.agent.localModel.modelId', entry.id],
      ['talaria.agent.localModel.backend', backend],
      ['talaria.agent.localModel.endpoint', validated.url],
    ]);
    return wrote.ok ? { ok: true } : wrote;
  }

  /**
   * T8 (§1.3): the "Configure Local Agent Model" block's wire state, RECOMPUTED
   * fresh from the 3 settings on EVERY `status()` call (never cached) — a
   * setting edited outside the panel, or a catalog row that changed shape, is
   * always reflected honestly. `endpointDefaults` is ALWAYS present;
   * `saved`/`providerGuidance` are present only once all 3 settings resolve to
   * a live agent-role catalog row (a stale/corrupted setting degrades to "no
   * saved state" rather than fabricating one — fail-closed, same posture as
   * {@link composeLlamacppCell}'s source-gate degrade).
   */
  private composeAgentLocalModel(
    providerPhase: SetupData['provider']['phase'],
    storePresence: ReadonlyMap<string, boolean>,
  ): NonNullable<SetupData['agentLocalModel']> {
    const endpointDefaults = AGENT_ENDPOINT_DEFAULTS;
    const modelId = (this.host.getSetting<string>('talaria.agent.localModel.modelId') ?? '').trim();
    const endpoint = (this.host.getSetting<string>('talaria.agent.localModel.endpoint') ?? '').trim();
    const backendRaw = this.host.getSetting<string>('talaria.agent.localModel.backend');
    const backend =
      backendRaw === 'ollama' || backendRaw === 'llamacpp' || backendRaw === 'vllm' ? backendRaw : undefined;

    if (modelId === '' || endpoint === '' || backend === undefined) return { endpointDefaults };
    const entry = MODEL_CATALOG.find((m) => m.id === modelId && m.role === 'agent');
    if (entry === undefined) return { endpointDefaults };

    const saved = this.composeSavedAgentEntry(entry, backend, endpoint, storePresence);
    if (saved === undefined) return { endpointDefaults };

    return {
      endpointDefaults,
      saved,
      providerGuidance: composeAgentGuidance(providerPhase, endpoint, saved.servedName),
    };
  }

  /** One (entry, backend) pair -> the `saved` wire shape, or `undefined` for
   *  a poisoned/fixture row that fails its backend's source gate (defense in
   *  depth — every shipping row passes, T1's closure). Reuses the SAME
   *  exported gates {@link handleProvisionModel} relies on
   *  ({@link assertProvisionSources} for ollama/llamacpp, {@link
   *  composeVllmCell}'s own SC-2 gate for vllm) rather than re-deriving trust
   *  logic here. */
  private composeSavedAgentEntry(
    entry: CatalogModel,
    backend: 'ollama' | 'llamacpp' | 'vllm',
    endpoint: string,
    storePresence: ReadonlyMap<string, boolean>,
  ): NonNullable<NonNullable<SetupData['agentLocalModel']>['saved']> | undefined {
    if (backend === 'vllm') {
      const vllmCell = composeVllmCell(entry);
      const servedName = servedNameFor(entry, 'vllm');
      if (vllmCell === undefined || servedName === undefined) return undefined;
      return { modelId: entry.id, backend, endpoint, servedName, runCommand: vllmCell.runCommand };
    }

    const gate = assertProvisionSources(entry, backend);
    if (!gate.ok) return undefined;
    const servedName = servedNameFor(entry, backend);
    if (servedName === undefined) return undefined;

    if (backend === 'ollama') {
      // Ollama needs no run command — the daemon serves it (§1.1).
      return { modelId: entry.id, backend, endpoint, servedName };
    }

    // backend === 'llamacpp': a run command needs a store-resident,
    // sidecar-attested file (same honesty rule as the catalog cell) — a
    // saved config for a not-yet-downloaded model renders no runCommand,
    // never a path to a file that doesn't exist. The port is ALWAYS the
    // SAVED endpoint's own (CC-6) — never LLAMACPP_RUN_FLAGS's default.
    const cell = entry.llamacpp;
    let runCommand: string | undefined;
    if (cell !== undefined && storePresence.get(entry.id) === true) {
      const dest = this.deps.storeDest(cell.gguf.hfRepo, cell.gguf.file);
      const port = extractPort(endpoint);
      if (dest.ok && port !== undefined) {
        runCommand = `llama-server -m ${this.redact(dest.destPath)} --jinja --port ${port}`;
      }
    }
    return { modelId: entry.id, backend, endpoint, servedName, ...(runCommand !== undefined ? { runCommand } : {}) };
  }

  // --- setup.cancel (read-only / best-effort) -----------------------------------

  private handleCancel(params: unknown): SetupCancelResult {
    const op = str(params, 'op');
    const id = str(params, 'id');
    if (op && id) {
      // AU-30 follow-up: `pull:` latches may be keyed by the CANONICAL
      // catalog id ({@link canonicalPullLatchId} — the Sweep NEXT artifact,
      // TC-7), while the wire-level cancel payload (`cancelPullParams`,
      // `ConfiguredModelRow` in SetupPanel.tsx) always sends the raw
      // created/tag name. Resolve through the SAME method
      // `handleVettedIngest` uses before looking the latch up, or a cancel
      // for that row silently no-ops (dedup itself still holds; only
      // Cancel was missing it). Every other `op` (`install`) is unaffected.
      const latchId = op === 'pull' ? canonicalPullLatchId(id) : id;
      // F2-20: report what actually happened — an abort was DELIVERED to a
      // live latch. `{cancelled:false}` below is the honest "nothing to
      // cancel" outcome the webview's T31 face renders.
      if (this.latches.abort(`${op}:${latchId}`)) {
        return { ok: true, cancelled: true, matched: latchId };
      }
    }
    return { ok: true, cancelled: false };
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
   *
   * T6 (beta.6 §2.5): gains the optional validated `scope` param — a STRICT
   * enum (`'all'|'agent'|'os'|'ollama'|'llamacpp'`), absent = `'all'`
   * (byte-compatible with every existing caller); anything else is refused
   * before any work. Scopes: `agent` = the pipx relocate above; `os` = drop
   * the memoized OS detection; `llamacpp` = {@link rekickLlamaCppProbe}
   * WITHOUT awaiting (the probe settles later and fires its own push);
   * `ollama` = nothing beyond the completion fire (the daemon probe already
   * re-runs on every `status()`); `all` = everything. Scoping exists so a
   * RAG-pane Re-check can never overwrite the Agent card's sticky phase
   * (rev-2 critic fold).
   */
  private async handleRecheck(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    // CA-M18: an explicit user re-probe always drops the memo, regardless of
    // scope — the completion fire below must reflect a FRESH Ollama probe,
    // not a stale in-window one.
    this.ollamaProbeMemo = undefined;
    const scope = validateRecheckScope(params);
    if (scope === undefined) {
      return { ok: false, reason: "scope must be one of 'all', 'agent', 'os', 'ollama', 'llamacpp'." };
    }
    if (scope === 'all' || scope === 'os') {
      // T5: drop the memoized OS detection — the next demand (the status()
      // this recheck's caller refreshes with, or the next bootstrap-terminal
      // request) re-reads through the binding, picking up e.g. a container
      // escape or a newly readable /etc/os-release.
      this.osResolution = undefined;
    }
    if (scope === 'all' || scope === 'llamacpp') {
      // Non-blocking by design: clears the settled memo, cancels the
      // superseded attempt, and re-kicks — the recheck RPC never waits on a
      // login-shell probe.
      this.rekickLlamaCppProbe();
    }
    if (scope === 'all' || scope === 'agent') {
      // TC-3 (AU-8/INV-11): drop the settled Hermes PATH-discovery memo too
      // — mirrors osResolution's clear-only posture above (not
      // rekickLlamaCppProbe's immediate re-kick): the next status() call
      // re-probes lazily through kickHermesDiscovery, picking up e.g. a
      // hermes the user just pipx-installed in a terminal. invalidate()
      // resets the in-flight flag too (not just the epoch) — a superseded
      // probe's late settle is dropped by the epoch check BEFORE it would
      // ever clear the flag itself, so leaving it `true` here would wedge
      // every future kick into a permanent no-op.
      this.hermesDiscoveryMemo.invalidate();
      try {
        const located = await this.deps.locatePipx();
        if (located.ok) {
          this.lastAgentIssue = undefined;
        } else {
          // T11 (§3, critic C-8): same 'error'-phase mapping as handleInstall
          // — probe-timeout is not a distinct sticky phase.
          const phase: AgentSetupPhase = located.reason === 'probe-timeout' ? 'error' : located.reason;
          this.lastAgentIssue = { phase, detail: this.redact(located.detail) };
        }
      } catch (err) {
        this.lastAgentIssue = { phase: 'error', detail: this.redact(errorMessage(err)) };
      }
    }
    // T7 (§2.2.2): fired exactly ONCE at completion (not per lastAgentIssue
    // write above) — recheck is read-only/no-modal, so "the recheck
    // completed" is itself the single meaningful state-change signal,
    // whether it cleared the sticky issue or refreshed it.
    this.bumpStatus();
    return { ok: true };
  }

  // --- setup.openProviderWizard --------------------------------------------------

  private async handleOpenProviderWizard(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const hermesPath = (this.host.getSetting<string>('talaria.hermesPath') ?? '').trim();
    if (!hermesPath) return { ok: false, reason: 'Hermes is not installed yet — install it first.' };
    const hermesAcpPath = deriveHermesAcpPath(hermesPath);
    // CR-003b: DISPLAY-ONLY redaction, exactly like CR-003 — the modal
    // string never lets a forged talaria.hermesPath (newline/bidi override)
    // inject fake lines; the terminal launch below still gets the real,
    // unredacted path.
    const confirmed = await this.host.showModal(
      `Open a terminal running '${redactForModal(hermesAcpPath)} --setup' to configure your chat provider?`,
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

  // --- setup.reconnectAgent (beta.7 B3) --------------------------------------

  private async handleReconnectAgent(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const reconnect = this.deps.reconnectAgent;
    if (!reconnect) {
      return { ok: false, reason: 'The agent connection is not running yet.' };
    }
    // T16/UX-04: force = the banner's wedge-break — bypasses the live-turn
    // refusal host-side and ends the turn as user intent (turn.end{cancelled},
    // ADR-T16). Absent or non-boolean input fails closed to non-force.
    const force = bool(params, 'force');
    try {
      const result = await reconnect(force === true ? { force: true } : undefined);
      this.bumpStatus(); // handleRecheck's single completion-fire posture (:2069-2073)
      return result;
    } catch (err) {
      this.bumpStatus();
      return { ok: false, reason: this.redact(errorMessage(err)) };
    }
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
    // T1 (beta.6 panel-fix PT1): sanitize BEFORE the modal that interpolates it.
    const sanitizedModel = refuseUnsafeModalText(model, 'model');
    if (!sanitizedModel.ok) return sanitizedModel;
    // T8 (beta.6 CC-10): additive, OPTIONAL `dedicatedBackendId` — a strict
    // 4-enum when PRESENT (absent stays absent, no clobber — the restoration
    // fallback stays the existing transport heuristic); a malformed value
    // refuses outright, same "never trust webview input" discipline as
    // every other enum param in this file.
    const dedicatedBackendIdRaw = str(params, 'dedicatedBackendId');
    if (dedicatedBackendIdRaw !== undefined && coerceDedicatedBackendId(dedicatedBackendIdRaw) === undefined) {
      return { ok: false, reason: "dedicatedBackendId must be one of 'ollama', 'llamacpp', 'vllm', 'openai-compat'." };
    }

    // T2 (beta.6 panel-fix CR-003): redact BEFORE the '(none)' fallback --
    // trim -> redact -> fallback, so an endpoint that's ALL unsafe chars
    // redacts to empty and correctly falls back to '(none)'. Display-only:
    // the WRITE below still stores validated.url, never this redacted copy.
    const oldEndpoint = redactForModal((this.host.getSetting<string>('talaria.nextEdit.endpoint') ?? '').trim()) || '(none)';
    const confirmed = await this.host.showModal(
      `Set dedicated Next-Edit endpoint from '${oldEndpoint}' to '${validated.url}' (model: ${model})?`,
      'Apply',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };

    const writes: Array<readonly [string, unknown]> = [
      ['talaria.nextEdit.backend', backend],
      ['talaria.nextEdit.endpoint', validated.url],
      ['talaria.nextEdit.model', model],
    ];
    if (dedicatedBackendIdRaw !== undefined) writes.push(['talaria.nextEdit.dedicatedBackendId', dedicatedBackendIdRaw]);
    return this.writeSettingsBatch(writes);
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
    // T1 (beta.6 panel-fix PT1): both are interpolated into the Apply modal
    // below — sanitize BEFORE they enter the patch (and thus the summary).
    const embedModel = str(params, 'embedModel')?.trim();
    if (embedModel) {
      const sanitized = refuseUnsafeModalText(embedModel, 'embedModel');
      if (!sanitized.ok) return sanitized;
      patch['talaria.rag.embedModel'] = embedModel;
    }
    const indexDir = str(params, 'indexDir')?.trim();
    if (indexDir) {
      const sanitized = refuseUnsafeModalText(indexDir, 'indexDir');
      if (!sanitized.ok) return sanitized;
      patch['talaria.rag.indexDir'] = indexDir;
    }
    // T8 (beta.6 CC-10): additive, OPTIONAL `embedBackend` — strict 3-enum.
    const embedBackend = str(params, 'embedBackend');
    if (embedBackend !== undefined) {
      if (embedBackend !== 'ollama' && embedBackend !== 'llamacpp' && embedBackend !== 'openai-compat') {
        return { ok: false, reason: "embedBackend must be 'ollama', 'llamacpp', or 'openai-compat'." };
      }
      patch['talaria.rag.embedBackend'] = embedBackend;
    }

    if (Object.keys(patch).length === 0) {
      return { ok: false, reason: 'no changes supplied.' };
    }

    const summary = Object.entries(patch)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');
    const confirmed = await this.host.showModal(`Update codebase-index settings: ${summary}?`, 'Apply');
    if (!confirmed) return { ok: false, reason: 'declined' };

    return this.writeSettingsBatch(Object.entries(patch));
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

  // --- TC-3 (AU-8/INV-11): Hermes PATH-discovery settled-value memo ---------

  /**
   * Kick the Hermes PATH-discovery probe ONCE, lazily — mirrors {@link
   * kickLlamaCppProbe}'s settled-value posture exactly. A no-op when {@link
   * SetupControllerDeps.discoverHermes} isn't bound (keeps every existing
   * deps literal — real or fake — compiling and behaving unchanged, same
   * optionality idiom as {@link SetupControllerDeps.reconnectAgent}), when a
   * settled value already exists, or while an attempt is in flight.
   * `discoverHermes` (bound to `resolveHermesBin` in `setupHost.vscode.ts`)
   * module-caches SUCCESS for the extension-host lifetime and NEVER caches
   * failure (`resolveHermes.ts` `cachedHermesBin`) — so a hermes installed
   * after a failed probe becomes visible the moment this memo is cleared
   * (`setup.recheck {scope:'agent'}`), without a window reload.
   * `discoverHermes` offers no cancellation seam (unlike {@link
   * SetupControllerDeps.locateLlamaServer}'s `signal`), so a superseded
   * attempt keeps running in the background — the memo's epoch just makes
   * ITS eventual settle inert, mirroring {@link llamaCppMemo}'s supersession
   * guard.
   */
  private kickHermesDiscovery(): void {
    if (!this.deps.discoverHermes) return;
    this.hermesDiscoveryMemo.kick();
  }

  // --- helpers --------------------------------------------------------------

  private computeAgentPhase(
    hermesPath: string,
    configuredBackend: string,
    discoveredHermesPath?: string | null,
  ): AgentSetupPhase {
    if (this.latches.has(`install:hermes`)) return 'installing';
    if (this.awaitingReload) return 'awaiting-reload';
    // TC-3 (AU-8/INV-11): a configured setting is authoritative; PATH
    // discovery is only ever a FALLBACK when it's empty — mirrors the
    // runtime's own settings-OR-PATH order (resolveHermes.ts resolveHermesBin).
    if (hermesPath || discoveredHermesPath) return configuredBackend === 'acp' ? 'ready' : 'installed-inactive';
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

  /** CA-M18: single-flight, short-TTL memo over the network Ollama probe —
   *  the two back-to-back SetupData pushes ONE mutation triggers (provider
   *  post-handle + onStatusChanged) share one probe instead of two. The
   *  PROMISE is stored at issue time, so concurrent status() calls join the
   *  in-flight probe. Invalidated by {@link bumpStatus}, `setup.recheck`,
   *  and {@link dispose}. */
  private ollamaProbeMemo: { endpoint: string; startedAt: number; result: Promise<OllamaStatus> } | undefined;

  private safeProbeOllama(endpoint: string): Promise<OllamaStatus> {
    const now = Date.now();
    const memo = this.ollamaProbeMemo;
    if (memo !== undefined && memo.endpoint === endpoint && now - memo.startedAt < OLLAMA_PROBE_MEMO_TTL_MS) {
      return memo.result;
    }
    const result = (async (): Promise<OllamaStatus> => {
      try {
        return await this.deps.probeOllama(endpoint);
      } catch (err) {
        return { running: false, detail: this.redact(errorMessage(err)) };
      }
    })();
    this.ollamaProbeMemo = { endpoint, startedAt: now, result };
    return result;
  }

  /** T6 M-3 carry-forward: replace the real home directory with `~` in any
   *  text that might reach the webview (install/pull log lines, failure
   *  details) — Ollama/pipx error strings can embed local paths. */
  private redact(text: string): string {
    const home = homedir();
    return home ? text.split(home).join('~') : text;
  }

  private pushProgress(progress: SetupProgress): void {
    // F2-16: a straggler progress tick after dispose must not re-create
    // throttle entries or arm timers against a disposed emitter.
    if (this.lifecycle.closed) return;
    const key = `${progress.op}:${progress.id}`;
    const now = Date.now();
    pruneExpiredThrottleEntries(this.throttle, now, PROGRESS_THROTTLE_MS);
    let state = this.throttle.get(key);
    if (!state) {
      state = { lastEmit: -Infinity, timer: undefined, pending: undefined };
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
 *
 * EXPORTED since T8 (beta.5 §2.3, critic C-5): `AcpBackend` wires the
 * `ConnectionSupervisor`'s `isProviderUnconfigured` thunk to THIS function
 * over the same advertised-auth-methods accessor, so the no-provider
 * session-start banner and the Setup Provider card can never disagree
 * about what "unconfigured" means. (Import direction is backend → setup;
 * this file still never imports from `src/host/backend/`.)
 */
export function computeProviderCard(methods: AdvertisedAuthMethod[] | undefined): SetupData['provider'] {
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

// --- T6 (beta.6): llama.cpp install projection + catalog cell gates ----------

/** beta.6 §6 copy, verbatim: the "llama.cpp missing" line (single-sourced —
 *  the webview renders this string, never restates it). */
const LLAMACPP_MISSING_GUIDANCE = 'llama-server was not found on your PATH. Install llama.cpp, then re-check.';
/** Docs link for the guidance-only install cells (debian/unknown/container)
 *  — the same llama-server docs URL the registry's guided-terminal recipe
 *  pins (`registry.ts`, llamacpp `localInstall.recipe.docsUrl`). */
const LLAMACPP_SERVER_DOCS_URL = 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server';

/**
 * T6 (CC-4): the `llamacppRuntime.install` projection — the
 * {@link composeBootstrap} pattern over `installCommand(family,'llamacpp')`.
 * A known family (fedora/arch/suse) carries the engine's exact pre-typed
 * line + that entry's own docsUrl; a guidance-only family (debian — the
 * archive package name is unconfirmed —, unknown, or the S-F10 container
 * degrade, whose §6 note then IS the guidance) carries text + the
 * llama-server docs link only. No command is ever guessed (Constraint 1).
 */
function composeLlamacppInstall(osInfo: OsResolution): { command?: string; guidance: string; docsUrl: string } {
  const spec = installCommand(osInfo.family, 'llamacpp');
  if (spec !== undefined) {
    return { command: spec.command, guidance: LLAMACPP_MISSING_GUIDANCE, docsUrl: spec.docsUrl };
  }
  return { guidance: osInfo.containerNote ?? LLAMACPP_MISSING_GUIDANCE, docsUrl: LLAMACPP_SERVER_DOCS_URL };
}

/** §2.5 run-command composition (drift-locked strings): per-role flags for a
 *  store-resident GGUF. The agent port matches `endpointDefaults.llamacpp`
 *  (8013 — T8 recomposes from the SAVED endpoint's port); NEXT keeps
 *  beta.5's 8012. */
const LLAMACPP_RUN_FLAGS: Readonly<Record<CatalogRole, string>> = {
  fim: '--port 8080',
  embedding: '--embeddings --port 8081',
  agent: '--jinja --port 8013',
  next: '--port 8012',
};

/**
 * T6 (SC-2, §2.2.6): the vLLM `serveRepo` COMPOSE-TIME gate. Order is
 * load-bearing (T1-M1): `assertCatalogSource` (charset) runs FIRST — a
 * `..`-traversal, leading `-`/`:`, or any charset violation yields ABSENCE
 * before any membership check could bless it — then the serve-source
 * closure: allowlisted publisher OR membership in the ledgered
 * `VLLM_ONLY_SERVE_REPOS` exception table. Failure ⇒ `undefined` (the cell
 * renders honest absence) — never a composed command over a bad source.
 * Exported PURE so a poisoned-fixture test can drive it directly.
 */
export function composeVllmCell(model: CatalogModel): { runCommand: string } | undefined {
  const serveRepo = model.vllm?.serveRepo;
  if (serveRepo === undefined) return undefined;
  if (!assertCatalogSource({ serveRepo }).ok) return undefined;
  const slash = serveRepo.indexOf('/');
  const owner = slash === -1 ? serveRepo : serveRepo.slice(0, slash);
  if (!isAllowlistedHfOwner(owner) && !VLLM_ONLY_SERVE_REPOS.includes(serveRepo)) return undefined;
  return { runCommand: `vllm serve ${serveRepo}` };
}

/**
 * T6 (§1.3/§2.2.8): one catalog row's llamacpp wire cell. Runtime
 * defense-in-depth mirroring the triple-allowlist posture: the gguf source
 * strings are charset-asserted AND owner-allowlist-checked at compose time —
 * a failing row (fixture/future only; every shipping row passes, drift-
 * locked at T1) renders HONEST ABSENCE (`available:false` + the §6 copy)
 * with no runCommand ever. `available` otherwise tracks the verify pin:
 * live-oid rows are always downloadable; a pinned row is downloadable iff
 * its sha256 is published (sweep-next ships `''` ⇒ `false`, fail-closed —
 * carried WITHOUT an unavailableReason: the NEXT card's wire truth owns the
 * pinned-disabled copy). `runCommand` composes ONLY for a present
 * (sidecar-attested by the scan) file whose ~-redacted dest resolved
 * (§2.2.8) — presence is the scan's verdict, and the scan itself IS the
 * sidecar attestation.
 * Exported PURE so poisoned-fixture tests can drive it directly.
 */
export function composeLlamacppCell(
  model: CatalogModel,
  present: boolean,
  redactedDestPath: string | undefined,
): NonNullable<SetupCatalogModel['llamacpp']> | undefined {
  const cell = model.llamacpp;
  if (cell === undefined) return undefined;
  const slash = cell.gguf.hfRepo.indexOf('/');
  const owner = slash === -1 ? cell.gguf.hfRepo : cell.gguf.hfRepo.slice(0, slash);
  const sourceOk =
    assertCatalogSource({ hfRepo: cell.gguf.hfRepo, file: cell.gguf.file }).ok && isAllowlistedHfOwner(owner);
  if (!sourceOk) {
    // The file/byte fields are inert display data (the webview only ever
    // sends back `id`); the AFFORDANCES are what absence kills: forced
    // not-present, not-available, and no runCommand — never a composed
    // string over an unasserted source.
    return {
      file: cell.gguf.file,
      approxBytes: cell.gguf.approxBytes,
      present: false,
      available: false,
      unavailableReason: LLAMACPP_HONEST_ABSENCE,
    };
  }
  const available = cell.verify.mode === 'live-oid' || cell.verify.sha256 !== '';
  return {
    file: cell.gguf.file,
    approxBytes: cell.gguf.approxBytes,
    present,
    available,
    ...(present && redactedDestPath !== undefined
      ? { runCommand: `llama-server -m ${redactedDestPath} ${LLAMACPP_RUN_FLAGS[model.role]}` }
      : {}),
  };
}

// --- T8 (beta.6 §2.5/§6): setup.saveAgentModel pure helpers -------------------

/** §6 "Agent save modal", verbatim. */
function composeSaveAgentModal(displayName: string, backend: string, endpoint: string): string {
  return `Set the local agent model to '${displayName}' via ${backend} at ${endpoint}?`;
}

/**
 * T8 (§2.5, exported for direct testing): "what to type into the provider
 * wizard" for one (entry, backend) pair — ollama: the tag (library tier) or
 * the CREATED name (hf-ingest tier, rev 3 — e.g. Devstral's
 * `devstral-small-2507:24b`); llamacpp: the GGUF's model name (its filename —
 * llama-server's `/v1/models` id falls back to the file basename absent a
 * `--alias`, Context7-grounded against `/ggml-org/llama.cpp`'s server source);
 * vllm: the serveRepo. `undefined` for a missing/fixture cell (every shipping
 * agent row carries all three, T1's closure) — never a fabricated guess.
 */
export function servedNameFor(entry: CatalogModel, backend: 'ollama' | 'llamacpp' | 'vllm'): string | undefined {
  if (backend === 'ollama') {
    if (entry.ollama?.tier === 'library') return entry.ollama.tag;
    if (entry.ollama?.tier === 'hf-ingest') return entry.ollama.createdName;
    return undefined;
  }
  if (backend === 'llamacpp') return entry.llamacpp?.gguf.file;
  return entry.vllm?.serveRepo;
}

/**
 * T8 (CC-6): the SAVED agent endpoint's own port — NEVER a hardcoded default
 * (`LLAMACPP_RUN_FLAGS`'s literal is for the pre-save picker cell only).
 * `undefined` only for a malformed URL — unreachable in practice, since
 * `saved.endpoint` already passed {@link validateEndpointUrl} at save time.
 */
function extractPort(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.port !== '') return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return undefined;
  }
}

/**
 * §6 "Agent guidance — …", the three variants (exported for direct testing —
 * `'unknown'` is not reachable through {@link computeProviderCard} today, so
 * the fourth `provider.phase` value can only be exercised by calling this
 * pure function directly). Gated on `provider.phase` (CC-7): `'unconfigured'`
 * gets the full wizard-pointing copy; `'configured'` gets the update-if-you-
 * want-it copy; `'waiting-agent'` AND `'unknown'` share the waiting copy — the
 * Provider card's wizard button renders at NEITHER phase
 * (`SetupPanel.tsx` `ProviderCard`), so the copy must not point at it.
 */
export function composeAgentGuidance(
  phase: SetupData['provider']['phase'],
  endpoint: string,
  servedName: string,
): string {
  // beta.6 panel-fix PT8 (audit A8, the one-carrier ✓ rule): no leading ✓ —
  // this always renders via the webview's `DoneLine`, whose `pass-filled`
  // icon already carries the check; a literal ✓ beside it would double up.
  if (phase === 'configured') {
    return `Local model saved. Your provider is already configured — update it to ${endpoint}/v1 · ${servedName} if you want the agent on this model.`;
  }
  if (phase === 'unconfigured') {
    return (
      `Local model ready. Next: press "Configure provider" on the Provider card below → choose the ` +
      `OpenAI-compatible (custom URL) provider → base URL: ${endpoint}/v1 · model: ${servedName}. Test shows the served model if unsure.`
    );
  }
  // 'waiting-agent' / 'unknown'
  return 'Local model ready. The provider step unlocks once Hermes is installed and connected — the Provider card below will show "Configure provider".';
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

/** T6 (beta.6 §2.5): `setup.recheck`'s scope values — validated as a STRICT
 *  enum, same discipline as {@link validateBootstrapTarget}. Exported (T9,
 *  §1.3) so a protocol-level lock test can pin the exact canonical array —
 *  `handleRecheck`'s refusal message is a hand-written literal, not derived
 *  from this array, so nothing else would catch a silent add/remove/rename
 *  here. Mirrors the {@link MUTATING_METHODS}/{@link READ_ONLY_METHODS}
 *  export-for-a-lock-test precedent. */
export const RECHECK_SCOPES = ['all', 'agent', 'os', 'ollama', 'llamacpp'] as const;
export type RecheckScope = (typeof RECHECK_SCOPES)[number];

/**
 * T6 (beta.6 §2.5): strict server-side validation of `setup.recheck`'s
 * optional `{scope}` param (webview input is never trusted — Constraint 1).
 * Absent params / absent key / explicit `undefined` = `'all'` (byte-
 * compatible with every existing caller). A PRESENT key with anything but
 * the five literals — including a non-string — is `undefined` = refuse; it
 * is NOT coerced to the default, so a malformed request can never silently
 * run the full recheck. Exported (T9, §1.3) for direct unit-level locking
 * of the validator itself, distinct from the `controller.handle()`
 * round-trip behavioral tests.
 */
export function validateRecheckScope(params: unknown): RecheckScope | undefined {
  if (params === undefined || params === null) return 'all';
  if (typeof params !== 'object') return undefined;
  if (!('scope' in params)) return 'all';
  const raw = (params as Record<string, unknown>)['scope'];
  if (raw === undefined) return 'all';
  return typeof raw === 'string' && (RECHECK_SCOPES as readonly string[]).includes(raw)
    ? (raw as RecheckScope)
    : undefined;
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

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** CA-M11: generous ceilings — real ignore lists are dozens of entries. */
export const EXCLUDE_GLOBS_MAX_ENTRIES = 128;
export const EXCLUDE_GLOB_MAX_LENGTH = 256;

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
      return Array.isArray(value) &&
        value.length <= EXCLUDE_GLOBS_MAX_ENTRIES &&
        value.every((v) => typeof v === 'string' && v.length <= EXCLUDE_GLOB_MAX_LENGTH)
        ? { ok: true, value }
        : {
            ok: false,
            reason: `${key} must be an array of at most ${EXCLUDE_GLOBS_MAX_ENTRIES} strings, each at most ${EXCLUDE_GLOB_MAX_LENGTH} characters.`,
          };
    case 'talaria.autocomplete.crossFile.enabled':
    case 'talaria.autocomplete.crossFile.prefixInjection':
    case 'talaria.autocomplete.crossFile.warmUp':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${key} must be a boolean.` };
    default:
      return { ok: false, reason: 'not a tunable' };
  }
}
