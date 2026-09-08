/**
 * WS-GD.2b B7: the provision/pull family extracted from `SetupController` —
 * `setup.pullModel` (the legacy free-text/allowlist tier + the vetted NEXT
 * ingest route) and `setup.provisionModel` (the catalog-driven ollama/
 * llamacpp provisioning engine), plus their shared digest-resolution/ingest
 * helpers (B5) and the pull-gate/provision copy consts. Reads/writes reach
 * the extension only through the injected {@link ProvisionRunnerPort}
 * (showModal/redact/pushProgress/bumpStatus — the same seams
 * `SetupController` itself uses) and the shared {@link SetupControllerDeps}/
 * {@link LatchRegistry} — this module NEVER imports from `SetupController.ts`
 * (the binding cycle rule for this task): the one exception is a type-only
 * import of {@link SetupControllerDeps}, which `verbatimModuleSyntax` erases
 * completely at compile time, so it creates no runtime edge back to the
 * façade.
 */

import { isLoopbackHost } from '../../autocomplete/backends/secureTransport';
import { validateEndpointUrl } from './remoteProbe';
import { MODEL_CATALOG, TRUSTED_HF_PUBLISHERS, assertCatalogSource } from './modelCatalog';
import type { CatalogGguf, CatalogModel, TrustedPublisher } from './modelCatalog';
import type { HfDigestVerdict, HfGgufSpec, LfsOidVerdict } from './hfDigest';
import { NEXT_DEDICATED_MODEL } from './registry';
import { DEFAULT_OLLAMA_ENDPOINT } from './statusBlocks';
import { SETUP_DISPOSED_REFUSAL } from './latchRegistry';
import type { LatchRegistry } from './latchRegistry';
import { refuseUnsafeModalText } from './modalText';
import type { PullProgress } from './ollamaClient';
import type { SetupProgress } from '../../shared/protocol';
import { errorMessage } from '../../shared/errorMessage';
import type { SetupControllerDeps } from './SetupController';

/**
 * WS-F8 F8-3 (FI-17): the Interface-Segregation narrowing of {@link
 * SetupControllerDeps} to EXACTLY the 7 members {@link ProvisionRunner}'s
 * body reads off `this.deps` (grep-confirmed: `registry`, `verifyHfDigest`,
 * `ingestGguf`, `resolveLfsOid`, `checkedStoreDest`, `downloadGgufToStore`,
 * `pullModel` — not more, not fewer). `SetupController` still constructs
 * `new ProvisionRunner(this.deps, …)` unchanged: the full `SetupControllerDeps`
 * it holds structurally satisfies this narrower Pick.
 */
export type ProvisionDeps = Pick<
  SetupControllerDeps,
  | 'checkedStoreDest'
  | 'downloadGgufToStore'
  | 'ingestGguf'
  | 'pullModel'
  | 'registry'
  | 'resolveLfsOid'
  | 'verifyHfDigest'
>;

/** The seam {@link ProvisionRunner} reaches the host/façade through — the
 *  same four operations `SetupController` itself performs, narrowed to what
 *  the provision/pull family needs (never the full {@link SetupHost}). */
export interface ProvisionRunnerPort {
  showModal(message: string, confirmLabel: string): Promise<boolean>;
  redact(text: string): string;
  pushProgress(progress: SetupProgress): void;
  bumpStatus(): void;
}

// --- T13 (beta.5 §4.4/§6): the verified NEXT download path — copy, verbatim --

/** §6 "host-sourced pull refusal (rev 5)" — kills the S-F1 class outright. */
const HOST_SOURCED_PULL_REFUSAL =
  "Talaria never instructs Ollama to fetch from an external host — the vetted Sweep model installs through Talaria's own verified download.";
/** §6 "NEXT download unavailable (D3)" — the sha256 pin is still empty.
 *  Exported (WS-F8 F8-4, FI-22) so {@link refusePinnedOllamaPreconditions}'s
 *  own focused unit test can assert against the real string instead of
 *  re-typing it. */
export const NEXT_DOWNLOAD_UNAVAILABLE =
  "No vetted build of this model is published yet, so Talaria won't download it automatically. To use NEXT today, pick the vLLM backend in the dedicated NEXT setup (it runs Sweep's official release) — or use Generic mode, which reuses your FIM model.";
/** §6 "NEXT download remote-endpoint refusal (S-F3)" — ingest is loopback-only.
 *  Exported (WS-F8 F8-4, FI-22) — see {@link NEXT_DOWNLOAD_UNAVAILABLE}. */
export const NEXT_REMOTE_ENDPOINT_REFUSAL =
  'Verified downloads only run against a local Ollama (loopback). For a remote server, download and verify the model on that machine — see the guided instructions.';
/** §4.4.3c — ONE line for every integrity failure mode (no detail leaks what to forge). */
const NEXT_INTEGRITY_REFUSAL = 'integrity check failed — refusing to download';
/** §6 "Pull modal (D3, rev 5)" — every word of the strong claim is what the
 *  engine actually does (Talaria hashes the downloaded bytes; Ollama
 *  re-verifies at blob ingest). Composed from the registry pins so the modal
 *  can never name a different artifact than the gate downloads. */
const NEXT_PULL_MODAL_COPY =
  `Download '${NEXT_DEDICATED_MODEL.displayName}' (~4.7 GB) and install it into your local Ollama? ` +
  `Source: huggingface.co/${NEXT_DEDICATED_MODEL.gguf.hfRepo} — Syntinal's build converted from Sweep's official release. ` +
  "Talaria verifies the file's checksum against its pinned value after downloading, and Ollama verifies it again during install.";

// --- T7 (beta.6 §2.5/§6): setup.provisionModel — copy, verbatim --------------

/** §6 "provision refusal: unknown id". */
export const PROVISION_UNKNOWN_ID_REFUSAL = 'Unknown model — the catalog is fixed in this release.';
/** §6 "provision refusal: vllm backend" — refused, never ignored. */
const PROVISION_VLLM_REFUSAL =
  'vLLM serves models from its own command line — nothing to download here. Copy the run command instead.';
/** Strict-enum refusal for anything outside the two provisionable backends. */
const PROVISION_BACKEND_REFUSAL = "backend must be 'ollama' or 'llamacpp'.";
/** §2.5 4a — fixture/future rows only (every shipping row carries an ollama
 *  cell): the ollama-side honest-absence line, mirroring the §6 llamacpp one. */
const PROVISION_OLLAMA_HONEST_ABSENCE =
  'No build of this model from a verified publisher exists for Ollama — use it via llama.cpp instead.';
/** SC-A-9: the exhaustive-VerifySpec default arm — a future third mode
 *  refuses, it never falls through permissively. */
const PROVISION_UNKNOWN_VERIFY_REFUSAL = 'unknown verify mode — refusing to download';
/** T1-M1 (carried): an option-shaped tag is refused in {@link SetupController.
 *  runLibraryPull} before the pull dep is ever invoked. */
const LIBRARY_TAG_DASH_REFUSAL = "model tag must not begin with '-'";

/**
 * T13 (beta.5 §4.4 "classify", rev 6 — the owner personally corrected the
 * earlier dot-counting bug): HOST-SOURCED iff the model contains a `/` AND
 * the substring before the FIRST `/` is host-like — contains a `.` OR a `:`
 * (port) OR equals `localhost` case-insensitively. A model with NO `/` is
 * ALWAYS a library name; dots in the name or tag are IRRELEVANT
 * (`qwen2.5-coder:1.5b-base` / `qwen3-embedding:0.6b` = library;
 * `ns/name:tag` = library; `hf.co/x`, `huggingface.co/x`,
 * `registry.example.com/x`, `localhost:11434/x` = host-sourced). Callers
 * normalize (trim) BEFORE classifying. Exported for the truth-table lock.
 */
export function isHostSourcedModel(model: string): boolean {
  const slash = model.indexOf('/');
  if (slash === -1) return false;
  const head = model.slice(0, slash);
  return head.includes('.') || head.includes(':') || head.toLowerCase() === 'localhost';
}

/**
 * S4.3 parity (reused, not reinvented — `src/autocomplete/index.ts`): is the
 * endpoint's host the loopback interface, per `secureTransport.ts`'s single
 * source of truth. Malformed URLs fail CLOSED (non-loopback ⇒ refused) —
 * though `validateEndpointUrl` runs first on this path, so none should reach here.
 */
function isLoopbackEndpoint(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * WS-F8 F8-4 (FI-22 setup-half): the pinned-Ollama fail-closed precondition
 * ladder, single-sourced — this SAME two-check ladder used to live inline,
 * duplicated verbatim, in both `handleVettedIngest` (the NEXT/dedicated-FIM
 * path) and `provisionOllama`'s pinned arm (the catalog path). EXACT beta.5
 * vetted ORDER — empty pin refuses BEFORE the loopback check; both refuse
 * BEFORE any modal/verify/ingest. Callers pass their own sha256 pin plus the
 * ALREADY-validated endpoint URL; a pure module function (no `this`), like
 * its neighbour {@link isLoopbackEndpoint}. Exported so the dedicated
 * `refusePinnedOllamaPreconditions.test.ts` can pin the ORDER directly — the
 * behavioural tests each trigger only ONE of the two checks, so neither
 * proves which reason wins when both fail.
 */
export function refusePinnedOllamaPreconditions(
  sha256: string,
  endpoint: string,
): { ok: true } | { ok: false; reason: string } {
  if (sha256 === '') return { ok: false, reason: NEXT_DOWNLOAD_UNAVAILABLE };
  if (!isLoopbackEndpoint(endpoint)) return { ok: false, reason: NEXT_REMOTE_ENDPOINT_REFUSAL };
  return { ok: true };
}

/** beta.6 §6 copy, verbatim: the llamacpp honest-absence line — rev 3:
 *  fixture/future-rows only, NO shipping row renders it (every shipping
 *  row's gguf source passes the compose-time gate below). */
export const LLAMACPP_HONEST_ABSENCE =
  'No build of this model from a verified publisher exists for llama.cpp — use it via Ollama instead.';

export function isAllowlistedHfOwner(owner: string): boolean {
  return TRUSTED_HF_PUBLISHERS.some((p) => p.hfOwner === owner);
}

// --- T7 (beta.6 §2.5): provisionModel pure helpers ---------------------------

/**
 * T7 (§2.5 step 2, SC-1): the runtime source assert for ONE `(row, backend)`
 * provisioning branch — charset assert on EVERY string the branch will use +
 * publisher ∈ {@link TRUSTED_HF_PUBLISHERS} + hfRepo-prefix re-assert
 * (`owner/… === publisher/…`). Unreachable for shipping data (T1's
 * drift-locks close it at build time) but REQUIRED at runtime: a poisoned
 * catalog edit has to defeat a reviewed data diff AND this independent
 * check, and `resolveLfsOid`/`verifyHfDigest` never see an unasserted
 * string (assert-before-resolve). An absent backend cell asserts vacuously —
 * its branch refuses with the honest-absence copy instead (steps 4a/5a).
 * Exported PURE so the closure test can drive every catalog row directly.
 */
export function assertProvisionSources(
  model: CatalogModel,
  backend: 'ollama' | 'llamacpp',
): { ok: true } | { ok: false; reason: string } {
  if (!isAllowlistedHfOwner(model.publisher)) {
    return { ok: false, reason: `publisher '${model.publisher}' is not on the trusted-publisher allowlist` };
  }
  if (backend === 'ollama') {
    const cell = model.ollama;
    if (cell === undefined) return { ok: true };
    if (cell.tier === 'library') {
      return assertCatalogSource({ tag: cell.tag });
    }
    // hf-ingest cells also hand the created name to the daemon (`/api/create`)
    // — asserted under the tag charset (no '/', no '.'/'..').
    const charset = assertCatalogSource({ hfRepo: cell.gguf.hfRepo, file: cell.gguf.file, tag: cell.createdName });
    if (!charset.ok) return charset;
    if (!cell.gguf.hfRepo.startsWith(`${model.publisher}/`)) {
      return { ok: false, reason: "hfRepo owner does not match the row's publisher" };
    }
    return { ok: true };
  }
  const cell = model.llamacpp;
  if (cell === undefined) return { ok: true };
  const charset = assertCatalogSource({ hfRepo: cell.gguf.hfRepo, file: cell.gguf.file });
  if (!charset.ok) return charset;
  if (!cell.gguf.hfRepo.startsWith(`${model.publisher}/`)) {
    return { ok: false, reason: "hfRepo owner does not match the row's publisher" };
  }
  return { ok: true };
}

/** The allowlist row for a catalog publisher — modal copy (name + trustBasis)
 *  comes from HERE, never from the webview. */
function trustedPublisherFor(owner: string): TrustedPublisher | undefined {
  return TRUSTED_HF_PUBLISHERS.find((p) => p.hfOwner === owner);
}

/**
 * T7 (§2.5 4c/5b, SC-5): the pinned-mode verify input. The FULL beta.5 chain
 * needs `allowedRepoFiles` (exact-file-set equality, both directions), which
 * catalog rows don't carry — it comes from the registry's own Sweep pin,
 * drift-locked equal to the catalog's pinned row (T1: sweep≡registry,
 * pinned⇔SyntinalCo). A pinned row naming any OTHER artifact cannot be
 * exact-set-verified and refuses outright — fail-closed, unreachable for
 * shipping data, fixture-tested.
 */
function pinnedVerifySpec(gguf: CatalogGguf, sha256: string): { ok: true; spec: HfGgufSpec } | { ok: false } {
  if (gguf.hfRepo !== NEXT_DEDICATED_MODEL.gguf.hfRepo || gguf.file !== NEXT_DEDICATED_MODEL.gguf.file) {
    return { ok: false };
  }
  return {
    ok: true,
    spec: {
      hfRepo: gguf.hfRepo,
      file: gguf.file,
      sha256,
      allowedRepoFiles: NEXT_DEDICATED_MODEL.gguf.allowedRepoFiles,
    },
  };
}

/** Modal size rendering: decimal GB to one decimal from the EXACT catalog
 *  bytes (beta.5 precedent — 4 680 000 000 renders `4.7 GB`). */
function formatApproxGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** §6 "Provision modal — pinned", ollama-ingest arm: the beta.5 strong-claim
 *  wording UNCHANGED + the endpoint clause (SC-A-7 — the modal names the
 *  daemon it installs onto). DISTINCT from the live-oid copy (A-2): "against
 *  its pinned value" is the strong claim only this mode may make. */
function composePinnedOllamaModal(displayName: string, gguf: CatalogGguf, endpoint: string): string {
  return (
    `Download '${displayName}' (~${formatApproxGb(gguf.approxBytes)}) and install it into your local Ollama? ` +
    `Source: huggingface.co/${gguf.hfRepo} — Syntinal's build converted from Sweep's official release. ` +
    "Talaria verifies the file's checksum against its pinned value after downloading, " +
    `and Ollama verifies it again during install at ${endpoint}.`
  );
}

/** §6 "Provision modal — live-oid", ollama-ingest arm (verbatim template):
 *  names the artifact, the publisher + trustBasis, the honest (weaker)
 *  verification basis, and the ingest endpoint. */
function composeLiveOidOllamaModal(
  displayName: string,
  gguf: CatalogGguf,
  publisher: TrustedPublisher,
  endpoint: string,
): string {
  return (
    `Download '${displayName}' (${gguf.quant}, ~${formatApproxGb(gguf.approxBytes)}) from huggingface.co/${gguf.hfRepo}? ` +
    `Publisher: ${publisher.name} — ${publisher.trustBasis} ` +
    "Talaria verifies the file's checksum against the publisher's manifest after downloading, " +
    `and Ollama verifies it again during install at ${endpoint}.`
  );
}

/** §2.5 5c: the llamacpp download modal — mode-distinct copy (A-2) naming
 *  publisher + trustBasis + repo + size + the ~-redacted destination. */
function composeLlamacppDownloadModal(
  mode: 'pinned' | 'live-oid',
  displayName: string,
  gguf: CatalogGguf,
  publisher: TrustedPublisher,
  redactedDest: string,
): string {
  const basis = mode === 'pinned' ? 'against its pinned value' : "against the publisher's manifest";
  return (
    `Download '${displayName}' (${gguf.quant}, ~${formatApproxGb(gguf.approxBytes)}) from huggingface.co/${gguf.hfRepo}? ` +
    `Publisher: ${publisher.name} — ${publisher.trustBasis} ` +
    `Talaria verifies the file's checksum ${basis} after downloading, ` +
    `then places it in ${redactedDest}.`
  );
}

export class ProvisionRunner {
  constructor(
    private readonly port: ProvisionRunnerPort,
    private readonly deps: ProvisionDeps,
    private readonly latches: LatchRegistry,
  ) {}

  // --- setup.pullModel ---------------------------------------------------------

  /**
   * T13 (beta.5 §4.4 — the ALLOWLIST pull gate, refusal order verbatim):
   * normalize(trim) → classify (rev 6 predicate, {@link isHostSourcedModel})
   * → (1) `validateEndpointUrl` (⚠ S-F3: this was the only URL-bearing
   * handler skipping it) → (2) host-sourced? ALWAYS refused (rev 5: the
   * automated `ollama pull hf.co/…` class is REMOVED, not gated — kills
   * S-F1 outright, including the `huggingface.co` alias bypass) → (3) the
   * registry-pinned `ollamaCreatedName` (case-insensitive)? the VETTED
   * INGEST branch ({@link handleVettedIngest}) → (4) plain `name[:tag]` /
   * `ns/name` = the pre-existing, ledger-documented library tier (§5.2),
   * byte-identical to before.
   */
  async handlePullModel(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    // normalize: trim BEFORE classification — ' hf.co/x' must not dodge the gate.
    const model = str(params, 'model')?.trim();
    if (!model) return { ok: false, reason: 'model is required.' };
    const endpoint =
      str(params, 'endpoint')?.trim() ||
      this.deps.registry.getBackend('ollama')?.remote?.endpoint.defaultValue ||
      DEFAULT_OLLAMA_ENDPOINT;
    // (1) endpoint validity — before anything else touches it.
    const validated = validateEndpointUrl(endpoint);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    // (2) host-sourced models: ALWAYS refused, no modal, no exceptions.
    if (isHostSourcedModel(model)) {
      return { ok: false, reason: HOST_SOURCED_PULL_REFUSAL };
    }
    // (3) the ONE vetted artifact installs through the digest-enforced ingest.
    if (model.toLowerCase() === NEXT_DEDICATED_MODEL.ollamaCreatedName.toLowerCase()) {
      return this.handleVettedIngest(validated.url);
    }
    // (4) plain library `name[:tag]` / `ns/name` — existing behavior, unchanged.
    const key = `pull:${model}`;
    if (this.latches.has(key)) return { ok: false, reason: 'pull already running' };

    // Latch BEFORE the modal (mirrors handleInstall) — otherwise two
    // `setup.pullModel` calls dispatched before the user answers the first
    // modal both pass the `has()` check above, and if both are approved the
    // second `arm()` clobbers the first's AbortController, leaving
    // `setup.cancel` unable to reach the first pull. The `finally` below
    // still releases the key on every exit path, including a decline, so a
    // declined pull never wedges the latch.
    const abort = this.latches.arm(key);
    if (abort === undefined) return { ok: false, reason: SETUP_DISPOSED_REFUSAL };
    try {
      // T1 (beta.6 panel-fix PT1): sanitize BEFORE the modal below — a
      // STRICTER, EARLIER gate than the leading-'-' check inside
      // {@link runLibraryPull}, never a looser one; that check stays exactly
      // where it is. The vetted-ingest branch (step 3, above) never reaches
      // this modal, so it needs no sanitation of its own.
      const sanitized = refuseUnsafeModalText(model, 'model');
      if (!sanitized.ok) return sanitized;
      const confirmed = await this.port.showModal(
        `Pull model '${model}' from the Ollama registry to your local disk?`,
        'Pull',
      );
      if (!confirmed) return { ok: false, reason: 'declined' };

      // T7 (beta.6): the pull body is the EXTRACTED {@link runLibraryPull} —
      // shared with the catalog tier. Behavior here is unchanged: same modal
      // (above), same latch, tag-keyed progress id.
      await this.runLibraryPull(model, endpoint, model, abort.signal);
      return { ok: true };
    } catch (err) {
      if (isAbortError(err)) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: this.port.redact(errorMessage(err)) };
    } finally {
      this.latches.release(key);
      // §7.2.2: terminal marker on EVERY settle path (success, failure,
      // cancel, or a post-latch decline) — the webview deletes its
      // accumulated progress entry, clearing a frozen bar + dead Cancel.
      this.port.pushProgress({ op: 'pull', id: model, done: true });
    }
  }

  /**
   * T13 (beta.5 §4.4.3a-d): the vetted-ingest branch, refusal order EXACT —
   * (a)+(b) the shared {@link refusePinnedOllamaPreconditions} ladder
   * (unpublished pin → refuse; non-loopback endpoint → refuse — the ingest
   * engine downloads on THIS machine and uploads to the daemon, so a remote
   * daemon gets the guided/manual path); (c) HF-tree digest pre-flight → ANY
   * failure refuses; (d) ONLY THEN the Tier-1 modal (§6 verbatim) and, on
   * confirm, the T14 engine. Every refusal lands BEFORE the modal — the user
   * is never asked to approve something already known to be unavailable,
   * remote, or unverified.
   */
  private async handleVettedIngest(endpoint: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const created = NEXT_DEDICATED_MODEL.ollamaCreatedName;
    // (a)+(b) fail-closed until the out-of-band publication fills the pin
    // (§5.4), and loopback-only — checked on the ALREADY-validated URL.
    const pre = refusePinnedOllamaPreconditions(NEXT_DEDICATED_MODEL.gguf.sha256, endpoint);
    if (!pre.ok) return pre;
    // Single-flight latch keyed by the CATALOG id (AU-30 fix, {@link
    // canonicalPullLatchId}) — see that method's doc for why. Progress/
    // cancel stay keyed by `created` on the wire (unchanged, T13 `pullGate.
    // test.ts` drift-lock); only the LATCH's internal key is canonical —
    // `handleCancel` resolves the SAME canonical id before its lookup so a
    // cancel dispatched with the wire-level `created` name still finds it.
    // `finally` still releases under this SAME key on every exit path.
    const canonicalId = canonicalPullLatchId(created);
    const key = `pull:${canonicalId}`;
    if (this.latches.has(key)) return { ok: false, reason: 'pull already running' };
    const abort = this.latches.arm(key);
    if (abort === undefined) return { ok: false, reason: SETUP_DISPOSED_REFUSAL };
    try {
      // (c) integrity pre-flight — dep can also REJECT (a fetch binding
      // throwing synchronously); that is the same refusal, never a crash.
      let verdict: HfDigestVerdict;
      try {
        verdict = await this.deps.verifyHfDigest(NEXT_DEDICATED_MODEL.gguf);
      } catch {
        verdict = { ok: false, reason: 'verify seam rejected' };
      }
      if (!verdict.ok) return { ok: false, reason: NEXT_INTEGRITY_REFUSAL };
      // (d) Tier-1 modal (§6 verbatim) → the T14 ingest engine.
      const confirmed = await this.port.showModal(NEXT_PULL_MODAL_COPY, 'Download');
      if (!confirmed) return { ok: false, reason: 'declined' };
      // §7.2.2: settled-flag straggler guard around ingestGguf's own await —
      // same discipline as {@link runLibraryPull}; required regardless of
      // the (verified-by-inspection) FROZEN dep's actual timing contract.
      await this.runWithSettledGuard(
        (p) => this.pushPullProgress(created, p),
        (cb) =>
          this.deps.ingestGguf(
            { gguf: NEXT_DEDICATED_MODEL.gguf, ollamaCreatedName: created },
            endpoint,
            cb,
            abort.signal,
          ),
      );
      return { ok: true };
    } catch (err) {
      if (isAbortError(err)) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: this.port.redact(errorMessage(err)) };
    } finally {
      this.latches.release(key);
      // §7.2.2: terminal marker on EVERY settle path — see handlePullModel's
      // own finally for the full rationale; progress rides the `created`
      // name here (T13 `pullGate.test.ts` drift-lock).
      this.port.pushProgress({ op: 'pull', id: created, done: true });
    }
  }

  // --- setup.provisionModel (beta.6 T7 — the §2.5 refusal-order engine) ---------

  /**
   * T7 (beta.6 §2.5): `setup.provisionModel {modelId, backend, endpoint?}` —
   * the ONE place a catalog model gets pulled/downloaded/ingested. Refusal
   * order is LOCKED by spy-ordering tests (an out-of-order check is a
   * security hole):
   *
   *   0. trust gate (MUTATING_METHODS) — caller-enforced in {@link handle}.
   *   1. params: `modelId` ∈ MODEL_CATALOG (strict); backend ∈
   *      {'ollama','llamacpp'}; 'vllm' REFUSED with the §6 line, never
   *      ignored.
   *   2. {@link assertProvisionSources} (SC-1): charset assert on EVERY
   *      string the branch will use + publisher ∈ allowlist + hfRepo-prefix
   *      re-assert — BEFORE any latch/network/fs work (assert-before-resolve:
   *      `resolveLfsOid` does not re-assert charset, so nothing may reach it
   *      unasserted).
   *   3. single-flight latch `pull:<modelId>` BEFORE the modal (rule 7);
   *      `finally`-released on every exit path. `<modelId>` is the ONE
   *      progress/cancel key on every branch (CC-1/CC-9).
   *   4/5. the backend branches ({@link provisionOllama} /
   *      {@link provisionLlamacpp}) — every remaining refusal lands BEFORE
   *      the Tier-1 modal.
   *
   * The NEXT re-route rides this handler: `{modelId:'sweep-next',
   * backend:'ollama'}` reaches the SAME vetted-ingest engine semantics as
   * beta.5's {@link handleVettedIngest}, latched/keyed `pull:sweep-next`.
   * The legacy `setup.pullModel` route stays byte-compatible (its own modal,
   * its own tag-derived key) and refusal-equivalent.
   */
  async handleProvisionModel(params: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    // (1) strict params — the webview only ever sends a catalog id back.
    const modelId = str(params, 'modelId');
    const entry = modelId === undefined ? undefined : MODEL_CATALOG.find((m) => m.id === modelId);
    if (entry === undefined) return { ok: false, reason: PROVISION_UNKNOWN_ID_REFUSAL };
    const backend = str(params, 'backend');
    if (backend === 'vllm') return { ok: false, reason: PROVISION_VLLM_REFUSAL };
    if (backend !== 'ollama' && backend !== 'llamacpp') return { ok: false, reason: PROVISION_BACKEND_REFUSAL };
    // (2) SC-1 — refuse on ANY unasserted source string BEFORE any other work.
    const sources = assertProvisionSources(entry, backend);
    if (!sources.ok) return { ok: false, reason: sources.reason };
    // (3) latch BEFORE the modal; finally-release on every exit path.
    const key = `pull:${entry.id}`;
    if (this.latches.has(key)) return { ok: false, reason: 'pull already running' };
    const abort = this.latches.arm(key);
    if (abort === undefined) return { ok: false, reason: SETUP_DISPOSED_REFUSAL };
    try {
      return backend === 'ollama'
        ? await this.provisionOllama(entry, params, abort.signal)
        : await this.provisionLlamacpp(entry, abort.signal);
    } catch (err) {
      if (isAbortError(err)) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: this.port.redact(errorMessage(err)) };
    } finally {
      this.latches.release(key);
      // §7.2.2: terminal marker on EVERY settle path — `entry.id` is the
      // ONE progress/cancel key on every branch (CC-1/CC-9), so this single
      // finally covers both `provisionOllama` and `provisionLlamacpp`.
      this.port.pushProgress({ op: 'pull', id: entry.id, done: true });
    }
  }

  /** pinned-mode digest core: pinnedVerifySpec → verifyHfDigest (seam-rejection → refusal).
   *  Caller has ALREADY refused the empty pin (order-locked). */
  private async resolvePinnedDigest(
    gguf: CatalogGguf,
    sha256: string,
  ): Promise<{ ok: true; expected: string } | { ok: false; reason: string }> {
    const pinnedSpec = pinnedVerifySpec(gguf, sha256);
    if (!pinnedSpec.ok) return { ok: false, reason: NEXT_INTEGRITY_REFUSAL };
    let verdict: HfDigestVerdict;
    try {
      verdict = await this.deps.verifyHfDigest(pinnedSpec.spec);
    } catch {
      verdict = { ok: false, reason: 'verify seam rejected' };
    }
    if (!verdict.ok) return { ok: false, reason: NEXT_INTEGRITY_REFUSAL };
    return { ok: true, expected: sha256 };
  }

  /** live-oid core: resolveLfsOid (seam-rejection → refusal). */
  private async resolveLiveOidDigest(
    gguf: CatalogGguf,
  ): Promise<{ ok: true; expected: string } | { ok: false; reason: string }> {
    let oid: LfsOidVerdict;
    try {
      oid = await this.deps.resolveLfsOid(gguf.hfRepo, gguf.file);
    } catch {
      oid = { ok: false, reason: 'resolve seam rejected' };
    }
    if (!oid.ok) return { ok: false, reason: NEXT_INTEGRITY_REFUSAL };
    return { ok: true, expected: oid.oid };
  }

  /** the shared guarded ingest call both provisionOllama arms end with. */
  private async runOllamaIngest(args: {
    entry: CatalogModel;
    cell: Extract<CatalogModel['ollama'], { tier: 'hf-ingest' }>;
    sha256: string;
    endpoint: string;
    signal: AbortSignal;
  }): Promise<void> {
    const { entry, cell, sha256, endpoint, signal } = args;
    // §7.2.2: settled-flag straggler guard around ingestGguf's own
    // await — same discipline as {@link runLibraryPull}; the shared
    // `entry.id`-keyed terminal `done` push lives in the CALLER's
    // (`handleProvisionModel`'s) finally, which runs strictly after
    // this flag flips. NOTE beyond the round's doc's literal 4-site
    // list: this is the SAME `ingestGguf` dep, the SAME shared
    // `entry.id`-keyed `done` push, and is a genuinely reachable
    // path today (the `devstral-24b` catalog row hits this `live-oid`
    // arm; the sibling `pinned` arm is currently dormant, sha256 `''`;
    // the 11 `library`-tier rows route through the already-guarded
    // `runLibraryPull` site, not here) — so it gets the identical
    // guard for consistency and genuine safety, not just the
    // dormant sibling.
    await this.runWithSettledGuard(
      (p) => this.pushPullProgress(entry.id, p),
      (cb) =>
        this.deps.ingestGguf(
          {
            gguf: {
              hfRepo: cell.gguf.hfRepo,
              file: cell.gguf.file,
              quant: cell.gguf.quant,
              sha256,
              approxBytes: cell.gguf.approxBytes,
            },
            ollamaCreatedName: cell.createdName,
          },
          endpoint,
          cb,
          signal,
        ),
    );
  }

  /** §2.5 step 4 — the ollama branch (library tier + both hf-ingest modes).
   *  Runs INSIDE the `pull:<modelId>` latch; the caller owns catch/finally. */
  private async provisionOllama(
    entry: CatalogModel,
    params: unknown,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cell = entry.ollama;
    // (4a) honest absence — fixture/future rows only.
    if (cell === undefined) return { ok: false, reason: PROVISION_OLLAMA_HONEST_ABSENCE };
    const endpoint =
      str(params, 'endpoint')?.trim() ||
      this.deps.registry.getBackend('ollama')?.remote?.endpoint.defaultValue ||
      DEFAULT_OLLAMA_ENDPOINT;
    const validated = validateEndpointUrl(endpoint);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    // (4b) library tier — ONE modal (§6 copy NAMES the endpoint, SC-A-7),
    // then the EXTRACTED pull body under progress id = the catalog id.
    if (cell.tier === 'library') {
      const confirmed = await this.port.showModal(
        `Pull model '${cell.tag}' from the Ollama registry onto '${validated.url}'?`,
        'Pull',
      );
      if (!confirmed) return { ok: false, reason: 'declined' };
      await this.runLibraryPull(cell.tag, validated.url, entry.id, signal);
      return { ok: true };
    }

    // (4c) hf-ingest — exhaustive over VerifySpec, default-REFUSE (SC-A-9).
    switch (cell.verify.mode) {
      case 'pinned': {
        // EXACT beta.5 vetted order: empty pin → loopback (shared ladder,
        // WS-F8 F8-4/FI-22) → exact-set verify → Tier-1 modal → ingest.
        // Every refusal BEFORE the modal.
        const pre = refusePinnedOllamaPreconditions(cell.verify.sha256, validated.url);
        if (!pre.ok) return pre;
        const digest = await this.resolvePinnedDigest(cell.gguf, cell.verify.sha256);
        if (!digest.ok) return { ok: false, reason: digest.reason };
        const confirmed = await this.port.showModal(
          composePinnedOllamaModal(entry.displayName, cell.gguf, validated.url),
          'Download',
        );
        if (!confirmed) return { ok: false, reason: 'declined' };
        await this.runOllamaIngest({
          entry,
          cell,
          sha256: digest.expected,
          endpoint: validated.url,
          signal,
        });
        return { ok: true };
      }
      case 'live-oid': {
        // loopback → resolveLfsOid → refuse on ANY failure — all BEFORE the
        // DISTINCT live-oid modal (A-2). The resolved oid IS the expected
        // digest the ingest engine hashes the received bytes against, and
        // Ollama re-verifies it server-side at blob ingest.
        if (!isLoopbackEndpoint(validated.url)) return { ok: false, reason: NEXT_REMOTE_ENDPOINT_REFUSAL };
        const digest = await this.resolveLiveOidDigest(cell.gguf);
        if (!digest.ok) return { ok: false, reason: digest.reason };
        const publisher = trustedPublisherFor(entry.publisher);
        if (publisher === undefined) return { ok: false, reason: NEXT_INTEGRITY_REFUSAL };
        const confirmed = await this.port.showModal(
          composeLiveOidOllamaModal(entry.displayName, cell.gguf, publisher, validated.url),
          'Download',
        );
        if (!confirmed) return { ok: false, reason: 'declined' };
        await this.runOllamaIngest({
          entry,
          cell,
          sha256: digest.expected,
          endpoint: validated.url,
          signal,
        });
        return { ok: true };
      }
      default:
        return { ok: false, reason: PROVISION_UNKNOWN_VERIFY_REFUSAL };
    }
  }

  /** §2.5 step 5 — the llamacpp branch: expected digest (mode-exhaustive,
   *  default-REFUSE) → WRITE-gated dest (SC-A-3: {@link SetupControllerDeps.
   *  checkedStoreDest}, NEVER the read-only `storeDest`) → mode-distinct
   *  Tier-1 modal naming the ~-redacted dest → the T3 atomic file sink.
   *  Runs INSIDE the `pull:<modelId>` latch; the caller owns catch/finally. */
  private async provisionLlamacpp(
    entry: CatalogModel,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cell = entry.llamacpp;
    // (5a) honest absence — the §6 unavailableReason copy.
    if (cell === undefined) return { ok: false, reason: LLAMACPP_HONEST_ABSENCE };
    // (5b) the expected digest, per verify mode — every failure refuses here,
    // BEFORE dest resolution and BEFORE the modal.
    let expected: string;
    switch (cell.verify.mode) {
      case 'pinned': {
        if (cell.verify.sha256 === '') return { ok: false, reason: NEXT_DOWNLOAD_UNAVAILABLE };
        // SC-5: the FULL beta.5 chain on EVERY backend — the exact-file-set
        // pre-flight runs on the file path too, not just the Ollama ingest.
        const digest = await this.resolvePinnedDigest(cell.gguf, cell.verify.sha256);
        if (!digest.ok) return { ok: false, reason: digest.reason };
        expected = digest.expected;
        break;
      }
      case 'live-oid': {
        const digest = await this.resolveLiveOidDigest(cell.gguf);
        if (!digest.ok) return { ok: false, reason: digest.reason };
        expected = digest.expected;
        break;
      }
      default:
        return { ok: false, reason: PROVISION_UNKNOWN_VERIFY_REFUSAL };
    }
    // (5c) the WRITE gate (T6 SC-A-3): lstat-checked, symlink-refusing dest —
    // a refusal here lands BEFORE the modal, and the modal below names the
    // ~-redacted destination this exact result resolved.
    const dest = await this.deps.checkedStoreDest(cell.gguf.hfRepo, cell.gguf.file);
    if (!dest.ok) return { ok: false, reason: this.port.redact(dest.reason) };
    const publisher = trustedPublisherFor(entry.publisher);
    if (publisher === undefined) return { ok: false, reason: NEXT_INTEGRITY_REFUSAL };
    const confirmed = await this.port.showModal(
      composeLlamacppDownloadModal(cell.verify.mode, entry.displayName, cell.gguf, publisher, this.port.redact(dest.destPath)),
      'Download',
    );
    if (!confirmed) return { ok: false, reason: 'declined' };
    // AU-13/TD-2 (INV-7/ADR-7 — check-to-write re-assertion): `showModal`
    // above is an UNBOUNDED, human-speed await — a local attacker has that
    // whole window to swap `<owner>`/`<repo>` for a symlink after the FIRST
    // `checkedStoreDest` call (5c) but before the write. Re-run the SAME
    // write gate now, immediately before `downloadGgufToStore`, and refuse on
    // any change (the lstat re-check now fails) rather than let `ensureDir`
    // (which follows symlinks) + the write proceed through a raced-in link.
    const reassert = await this.deps.checkedStoreDest(cell.gguf.hfRepo, cell.gguf.file);
    if (!reassert.ok) return { ok: false, reason: this.port.redact(reassert.reason) };
    // (5d) the T3 atomic sink: same-dir `.part` → digest equality → rename →
    // sidecar. Progress rides the ONE `pull:<modelId>` key. Writes through
    // the FRESHLY re-asserted destination (`reassert`), not the stale
    // pre-modal one — the same "read exactly the path that was validated"
    // discipline `pathConfine.ts`'s own doc establishes for reads.
    // §7.2.2: settled-flag straggler guard around downloadGgufToStore's own
    // await — same discipline as {@link runLibraryPull}; the shared
    // `entry.id`-keyed terminal `done` push lives in the CALLER's
    // (`handleProvisionModel`'s) finally, which runs strictly after this
    // flag flips.
    await this.runWithSettledGuard(
      (p) => this.pushPullProgress(entry.id, p),
      (cb) =>
        this.deps.downloadGgufToStore(
          {
            catalogId: entry.id,
            gguf: {
              hfRepo: cell.gguf.hfRepo,
              file: cell.gguf.file,
              quant: cell.gguf.quant,
              sha256: expected,
              approxBytes: cell.gguf.approxBytes,
            },
          },
          reassert.destDir,
          reassert.destFile,
          cb,
          signal,
        ),
    );
    // Presence flips: the sidecar now exists, so the next status() scan reads
    // present — fire so the panel re-fetches without waiting for a user poke.
    this.port.bumpStatus();
    return { ok: true };
  }

  /**
   * T7 (§2.5 4b): the EXTRACTED library-pull body — ONE implementation shared
   * by the legacy free-text tier ({@link handlePullModel}, tag-keyed progress)
   * and the catalog tier ({@link provisionOllama}, catalog-id-keyed progress).
   * Modal and latch stay with each CALLER (one modal total per route).
   *
   * T1-M1 (carried obligation): an option-shaped tag (leading '-') is refused
   * before the pull dep is invoked. Defense-in-depth — the pull itself is an
   * HTTP `POST /api/pull` with a JSON body ({@link SetupControllerDeps.
   * pullModel} → `ollamaClient.pullModel`), never a composed shell string,
   * and no catalog tag can carry a leading '-' past T1's drift-lock — but a
   * tag that LOOKS like a CLI flag must never reach any pull surface.
   */
  private async runLibraryPull(tag: string, endpoint: string, progressId: string, signal: AbortSignal): Promise<void> {
    if (tag.startsWith('-')) {
      throw new Error(LIBRARY_TAG_DASH_REFUSAL);
    }
    // §7.2.2: silence a straggler progress tick that fires AFTER
    // `deps.pullModel`'s own promise has settled — it must never race the
    // terminal `done` push the caller's `finally` emits right after this
    // returns (throttle single-pending-slot hazard, SetupController.ts's
    // `pushProgress`). Verified by inspection: the real `pullModel`
    // (`ollamaClient.ts`) streams every `onProgress` call from a fully
    // awaited read loop, strictly before its own promise settles — this
    // guard is required regardless, since a FROZEN dep is not a contract.
    await this.runWithSettledGuard(
      (p) => this.pushPullProgress(progressId, p),
      (cb) => this.deps.pullModel(endpoint, tag, cb, signal),
    );
  }

  /** One `{op:'pull'}` progress push under the given key — the shared
   *  projection every pull/ingest/download branch rides (rule 7). */
  private pushPullProgress(id: string, p: PullProgress): void {
    this.port.pushProgress({
      op: 'pull',
      id,
      phase: p.status,
      ...(p.totalBytes !== undefined ? { totalBytes: p.totalBytes } : {}),
      ...(p.completedBytes !== undefined ? { completedBytes: p.completedBytes } : {}),
    });
  }

  /** WV3-MIN-FUNC: the ONE settled-flag straggler guard (§7.2.2) — silences
   *  any progress tick that fires AFTER the wrapped dep's promise settles,
   *  so it can never race the caller's terminal `done` push (throttle
   *  single-pending-slot hazard — see runLibraryPull's original doc).
   *  Extracted verbatim from the five hand-copied sites. */
  private async runWithSettledGuard(
    onProgress: (p: PullProgress) => void,
    run: (guarded: (p: PullProgress) => void) => Promise<void>,
  ): Promise<void> {
    let settled = false;
    try {
      await run((p) => {
        if (!settled) onProgress(p);
      });
    } finally {
      settled = true;
    }
  }
}

/**
 * AU-30 (TC-7) + follow-up: the created-name → catalog-id resolution the
 * `pull:` latch is keyed by. `setup.provisionModel`'s route to the Sweep
 * artifact (`handleProvisionModel` → `provisionOllama`, ~:1690) latches
 * `pull:<catalog id>`; {@link handleVettedIngest} (the legacy `setup.
 * pullModel` route to the SAME artifact) derives the identical id here so
 * both RPCs join ONE latch instead of each winning its own and starting a
 * duplicate multi-GB download. `handleCancel` resolves through this SAME
 * method before its `latches.abort` lookup — a second, divergent copy of
 * this lookup there would just re-open the exact class of bug this
 * closes (a cancel key that doesn't match what the latch is actually
 * keyed under). Resolved from MODEL_CATALOG by created-name match rather
 * than hardcoded a second time — `modelCatalog.test.ts` locks `sweep-
 * next`'s `createdName` to `NEXT_DEDICATED_MODEL.ollamaCreatedName`, so
 * the lookup always hits for the shipping row; the `?? created` fallback
 * covers a fixture/test catalog that omits the row, AND any id that was
 * never an hf-ingest created name to begin with (e.g. a plain library
 * tag like `llama3:8b`) — those pass through unchanged, exactly what
 * `handleCancel` needs for the non-canonical `pull:<tag>` latches
 * {@link handlePullModel}'s library branch and {@link runLibraryPull}
 * use.
 */
export function canonicalPullLatchId(created: string): string {
  return (
    MODEL_CATALOG.find((m) => m.ollama?.tier === 'hf-ingest' && m.ollama.createdName === created)?.id ?? created
  );
}

function str(params: unknown, key: string): string | undefined {
  if (params && typeof params === 'object' && key in params) {
    const v = (params as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
