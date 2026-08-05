/*
 * Pure card-state-derivation helpers for the Setup / Talaria Config panel
 * (Task 10, plan doc §6). No React, no `vscode`, no bridge — everything here
 * is a plain function over the shared wire types, unit-testable in a plain
 * node environment (`SetupPanel.test.ts`, the `webview-pure` vitest
 * project). `SetupPanel.tsx` is the ONLY consumer of these; keep it that way
 * so the decisions stay provable without a DOM (mirrors `Toggle.tsx`'s
 * `toggleInteraction` extraction and `settingsField.ts`'s reconcile
 * functions — same discipline, new panel).
 */
import type { AgentSetupPhase, SetupBackendOption, SetupData, SetupProgress } from '../protocol';
/*
 * T15: `registry.ts` is PURE DATA with zero imports of any kind (Global
 * Constraint 5) — safe to pull straight into the webview bundle, exactly
 * like `webview/src/protocol.ts` already re-exports the shared
 * `src/shared/protocol.ts` across the same host/webview boundary. Needed
 * here because `ollamaCreatedName`/`ollamaPullAlias` (the presence-match
 * targets, §4.2 rev 5) never cross the wire by name — only their RESOLVED
 * value does, as `dedicated.modelDefaults.ollama`, and only while
 * `downloadReady` (R-3). A user who `ollama pull`ed the model by hand under
 * the alias, before ever seeing a Download button, must still be recognized
 * — so the presence check needs the actual constants, not just the wire.
 */
import { NEXT_DEDICATED_MODEL } from '../../../src/host/setup/registry';

// --- Agent card (§6 card 1) -------------------------------------------------

/** Human status line for the Agent card's current {@link AgentSetupPhase}. */
const AGENT_PHASE_LABEL: Record<AgentSetupPhase, string> = {
  unknown: 'Checking…',
  'pipx-missing': 'pipx not found',
  'python-unsuitable': 'No suitable Python found',
  missing: 'Not installed',
  installing: 'Installing…',
  'installed-inactive': 'Installed — not active',
  'awaiting-reload': 'Installed — reload to activate',
  ready: 'Ready',
  // T11 (§3, critic C-8): honestly generic — a recheck-time probe-timeout
  // also lands in this phase and is NOT an install failure; the detail line
  // (not this label) carries the specifics.
  error: 'Failed',
};

export function agentPhaseLabel(phase: AgentSetupPhase): string {
  return AGENT_PHASE_LABEL[phase];
}

export type AgentActionKind =
  | 'none'
  | 'install'
  | 'installing'
  | 'activate'
  | 'reload'
  | 'recheck'
  | 'retry';

export interface AgentAction {
  kind: AgentActionKind;
  /** Empty string for `'none'`/`'installing'` — nothing to render as a button label. */
  label: string;
}

/**
 * The Agent card's ONE primary action per phase (§6 card 1 — "status line ->
 * ONE primary action -> collapsible detail/log"). `pipx-missing` and
 * `python-unsuitable` deliberately do NOT get a wired terminal-opening action
 * here: `SetupController` (Task 9) has no `setup.*` method for either today
 * (`setup.openInstallTerminal` only accepts a backend with a
 * `guided-terminal` recipe, and Hermes's is `pipx` — see that method's own
 * refusal). `pipx-missing` instead gets an honest "Retry install" (the one
 * real re-entry point: `setup.install` again, now that pipx may have been
 * installed by hand) and `python-unsuitable` gets no button at all, per §6's
 * own spec ("honest text + docs link").
 */
export function agentPrimaryAction(phase: AgentSetupPhase): AgentAction {
  switch (phase) {
    case 'pipx-missing':
      // T11 (host-gap 2), T10 (§1.2): `pipx-missing` now renders TWO
      // bespoke buttons — [Open terminal: {agent.bootstrap.command}]
      // (dispatches `setup.openBootstrapTerminal`, command host-composed
      // for the detected distro) + [Re-check] (dispatches
      // `setup.recheck`) — directly in `SetupPanel.tsx`'s `AgentCard`,
      // instead of the generic single primary-action slot every other phase
      // uses. `'none'` here suppresses that generic slot so it doesn't
      // render a THIRD, redundant button.
      return { kind: 'none', label: '' };
    case 'python-unsuitable':
      return { kind: 'none', label: '' };
    case 'missing':
      return { kind: 'install', label: 'Install Hermes' };
    case 'installing':
      return { kind: 'installing', label: 'Installing…' };
    case 'installed-inactive':
      return { kind: 'activate', label: 'Activate + Reload' };
    case 'awaiting-reload':
      // T11 (host-gap 1): a PERSISTENT reload button, not a dead-end
      // Re-check — `setup.reload` now exists (`SetupController.ts`), so
      // there is finally a real host seam behind this label.
      return { kind: 'reload', label: 'Reload window' };
    case 'ready':
      return { kind: 'recheck', label: 'Re-check' };
    case 'error':
      return { kind: 'retry', label: 'Retry' };
    case 'unknown':
      return { kind: 'none', label: '' };
  }
}

// --- FIM card (§6 card 3) ---------------------------------------------------

/**
 * Whether this backend option offers the "Install locally" tab — the signal
 * that drives the owner's exact two-mode question ("Install locally, or
 * connect to an existing endpoint?"). True for ollama/llamacpp/vllm-shaped
 * entries (they carry `localInstall`); false for codestral/openai-compat
 * (remote-only, `localInstall` absent) and for coming-soon agent stubs.
 */
export function fimHasLocalInstall(option: SetupBackendOption): boolean {
  return option.localInstall !== undefined;
}

export function isComingSoon(option: SetupBackendOption): boolean {
  return option.status === 'coming-soon';
}

/**
 * `python-unsuitable`'s docs-link fallback (T11 §6-parity minor): used only
 * when the selected agent option's own `docsUrl` is absent (true for Hermes
 * today — its registry entry carries no `docsUrl`, see `registry.ts`). A
 * generic-but-genuinely-useful landing page for "which Python do I have /
 * need" rather than inventing a Hermes-specific URL nobody has vetted.
 */
export const PYTHON_VERSION_HELP_URL = 'https://www.python.org/downloads/';

/**
 * The `error` phase's [Copy log] payload (T11 §6-parity minor): the same
 * text the card already shows (`agent.detail` + the accumulated log tail),
 * joined so a user reporting a bug can paste ONE block instead of
 * hand-copying a scrolling `<pre>`. Never fabricates a blank line for an
 * absent detail or an empty tail.
 */
export function buildCopyLogText(detail: string | undefined, logTail: readonly string[]): string {
  const lines = [detail, ...logTail].filter((line): line is string => Boolean(line && line.length > 0));
  return lines.join('\n');
}

// --- NEXT card (§6 card 4) --------------------------------------------------

/** `dedicatedConfigured` flips the button from first-time setup to editing. */
export function nextEditButtonLabel(dedicatedConfigured: boolean): string {
  return dedicatedConfigured ? 'Edit dedicated NEXT' : 'Set up dedicated NEXT';
}

// --- byte / progress formatting (Agent install log + FIM/RAG model pulls) --

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable byte size, or `''` when the total isn't known yet (never fabricates a number). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'TB';
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

/**
 * 0-100 integer percent for a model pull's progress bar, or `undefined`
 * while the total is unknown — Ollama's `/api/pull` stream only reports a
 * `total` once the layer manifest resolves (§2.4), so a bar must not appear
 * before that (an invented percent would be a lie, not an estimate).
 */
export function pullPercent(totalBytes: number | undefined, completedBytes: number | undefined): number | undefined {
  if (totalBytes === undefined || completedBytes === undefined || totalBytes <= 0) return undefined;
  const pct = Math.round((completedBytes / totalBytes) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** The task brief's own pin: "log tail last 200 lines". */
export const PROGRESS_LOG_TAIL_MAX = 200;

/** Keep only the LAST `max` lines — a live install/pull log can run long. */
export function clampLogTail(lines: readonly string[], max: number = PROGRESS_LOG_TAIL_MAX): string[] {
  return lines.length > max ? lines.slice(lines.length - max) : [...lines];
}

// --- client-side accumulation of `setup.progress` pushes -------------------

/** One (op, id) pair's live install/pull progress, folded from the throttled `setup.progress` stream. */
export interface SetupProgressEntry {
  op: 'install' | 'pull';
  id: string;
  phase?: string;
  /** Accumulated `line`s, capped at {@link PROGRESS_LOG_TAIL_MAX}. */
  logTail: string[];
  totalBytes?: number;
  completedBytes?: number;
}

export type SetupProgressMap = Record<string, SetupProgressEntry>;

export const EMPTY_SETUP_PROGRESS: SetupProgressMap = {};

/** The map key for one (op, id) pair — matches `SetupController`'s own `${op}:${id}` in-flight key. */
export function progressKey(op: 'install' | 'pull', id: string): string {
  return `${op}:${id}`;
}

/**
 * Fold one `setup.progress` push into the accumulated map (`state/
 * transcript.ts`'s `setup.progress` case — Task 8 left this an explicit
 * no-op for Task 10 to replace). Each push is a PARTIAL update
 * (`SetupController.pushProgress` only sets the fields that changed): a
 * `line`, when present, APPENDS to the log tail; `phase`/`totalBytes`/
 * `completedBytes`, when present, overwrite; when absent they carry the
 * previous value forward rather than reverting to `undefined` (a
 * byte-count-only push must not blank out the phase text, and vice versa).
 */
export function foldSetupProgress(map: SetupProgressMap, msg: SetupProgress): SetupProgressMap {
  const key = progressKey(msg.op, msg.id);
  const prev = map[key];
  const logTail = msg.line !== undefined ? clampLogTail([...(prev?.logTail ?? []), msg.line]) : (prev?.logTail ?? []);
  const entry: SetupProgressEntry = {
    op: msg.op,
    id: msg.id,
    phase: msg.phase ?? prev?.phase,
    logTail,
    totalBytes: msg.totalBytes ?? prev?.totalBytes,
    completedBytes: msg.completedBytes ?? prev?.completedBytes,
  };
  return { ...map, [key]: entry };
}

// --- trust gate (§6 progressive-disclosure/accessibility rules, D9 FM-14) --

export const TRUST_DISABLED_REASON =
  'Workspace is not trusted — Setup changes are disabled in Restricted Mode.';

/**
 * The `aria-disabled` + tooltip reason every mutating control in the panel
 * shares while the workspace is untrusted — `undefined` (nothing disabled)
 * once trusted. One function so every card names the SAME reason (§6: "no
 * color-only status" — the text carries the meaning, not a tint alone).
 */
export function mutationDisabledReason(trusted: boolean): string | undefined {
  return trusted ? undefined : TRUST_DISABLED_REASON;
}

// --- B5 "done / what next" one-line status affordances (§2.5, §6) ---------
//
// Five PURE per-card helpers. Each returns the exact §6-verbatim copy once
// its card is genuinely done, and `''` otherwise — `SetupPanel.tsx` renders
// the non-empty case as a quiet icon+text `pass-filled`/`text-add` line
// under the card (never color-only, Global Constraint 7). None of these
// booleans cross the wire directly (only the ALL-cards composite `ready`
// does, mirrored from `SetupController`'s own `computeReady`) — each helper
// recomputes its OWN card's "green" from wire-visible fields only, scoped to
// that one card (an agent-ready line must not depend on the provider, etc).

/** Card 1 — Agent: mirrors `AgentSetupPhase === 'ready'`. */
export function agentDoneLine(phase: AgentSetupPhase): string {
  return phase === 'ready' ? '✓ Hermes is ready. Next: configure a chat provider below.' : '';
}

/** Card 2 — Provider: mirrors `provider.phase === 'configured'`. */
export function providerDoneLine(phase: SetupData['provider']['phase']): string {
  return phase === 'configured' ? '✓ Provider connected — chat is ready to use.' : '';
}

/** Auth-satisfied predicate over the WIRE's collapsed `auth` union — the
 *  same rule `SetupController.status()` applies host-side over its own
 *  richer `{kind, required}` shape before it gets collapsed onto the wire
 *  (`fimAuthSatisfied` there): only an `apiKey-required` backend with no key
 *  set is blocked; `none`/`apiKey-optional`/no `remote` entry at all are
 *  always satisfied. */
function fimAuthSatisfied(option: SetupBackendOption | undefined): boolean {
  if (!option?.remote) return true;
  return option.remote.auth !== 'apiKey-required' || option.remote.apiKeySet;
}

/**
 * Card 3 — Autocomplete (FIM): mirrors `SetupController.status()`'s own
 * `fimGreen` (`fimDescriptor.status === 'available' && enabled &&
 * fimAuthSatisfied`), recomputed here purely from the wire's `fim` block —
 * the boolean itself never crosses the wire (only the ALL-cards composite
 * `ready` does, and that also folds in agent+provider, which this per-card
 * line must not).
 */
export function fimDoneLine(fim: SetupData['fim']): string {
  const option = fim.options.find((o) => o.id === fim.selectedId);
  const green = option !== undefined && option.status === 'available' && fim.enabled && fimAuthSatisfied(option);
  return green ? '✓ Autocomplete is active — open a file and start typing.' : '';
}

/** Card 4 — NEXT: one line per active source, empty while `'off'`. */
export function nextDoneLine(source: SetupData['nextEdit']['source']): string {
  if (source === 'dedicated') return '✓ Next-edit suggestions are on (dedicated Sweep model).';
  if (source === 'generic') return '✓ Next-edit suggestions are on (reusing your FIM model).';
  return '';
}

/**
 * Card 5 — RAG: green only once the index is genuinely usable — enabled,
 * the embed model is actually present on the daemon (not just configured),
 * and nothing is blocking activation (`preconditionDetail` unset). A
 * "ready" claim without the embed model present would be a lie the icon
 * alone couldn't correct (§6, Global Constraint 7).
 */
export function ragDoneLine(rag: SetupData['rag']): string {
  const green = rag.enabled && rag.embedModelPresent && rag.preconditionDetail === undefined;
  return green ? '✓ Codebase index is ready — the agent can search your project.' : '';
}

// --- pipx-missing unknown-distro fallback (§6, T10) ------------------------

/** Docs link shown alongside the unknown-distro `pipx-missing` guidance —
 *  used only when `agent.bootstrap.command` is absent (unrecognized
 *  distro). */
export const PIPX_INSTALL_DOCS_URL = 'https://pipx.pypa.io/stable/installation/';

// --- ⑨⑩ non-Ollama install-tab Test endpoint resolution (§2.6, R-2) -------

/**
 * `talaria.autocomplete.endpoint` is ONE setting shared by every FIM
 * backend (`FIM_ENDPOINT_KEY` in the host registry) — every
 * `SetupBackendOption.remote.endpointValue` on the wire echoes that SAME
 * saved string regardless of which backend the option represents. It is
 * only trustworthy for the backend it was actually saved FOR — the one
 * `selectedId`'d on the wire right now. Viewing a DIFFERENT backend's
 * Install tab (browsing, not configuring) must fall back to THAT option's
 * own default rather than silently testing a foreign server under this
 * backend's label (a green result would be a lie about a DIFFERENT
 * backend's reachability — §2.6 R-2, pinned by test).
 */
export function fimInstallTestEndpoint(selectedId: string, option: SetupBackendOption): string {
  const scoped = selectedId === option.id ? (option.remote?.endpointValue ?? '') : '';
  return scoped || option.remote?.endpointDefault || '';
}

// --- Card 4 — DedicatedNextForm parity (§4.2/§4.3/§6, T15) -----------------

export type NextPresence = 'present' | 'absent' | 'unknown';

/** Ollama tag equality — case-insensitive, `:latest`-tolerant (critic C-13):
 *  a bare `name` and `name:latest` name the SAME local model. */
function normalizeOllamaTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  return lower.endsWith(':latest') ? lower.slice(0, -':latest'.length) : lower;
}

function ollamaTagsEqual(a: string, b: string): boolean {
  return normalizeOllamaTag(a) === normalizeOllamaTag(b);
}

/** Either of the vetted Sweep model's two known local names (rev 5): the
 *  ingest-created `ollamaCreatedName`, or the hand-pull `ollamaPullAlias`. */
function isVettedOllamaAlias(tag: string): boolean {
  return ollamaTagsEqual(tag, NEXT_DEDICATED_MODEL.ollamaCreatedName) || ollamaTagsEqual(tag, NEXT_DEDICATED_MODEL.ollamaPullAlias);
}

/**
 * Whether a model on the daemon (`daemonTag`) should count as satisfying
 * `formModel`: an exact (case/`:latest`-tolerant) match, OR — when
 * `formModel` names the vetted Sweep model under EITHER of its two known
 * local names — a match against the OTHER name too. Without this second
 * branch, a user who `ollama pull`ed the model by hand under the hf.co
 * alias would be told "not present" forever, because the form still shows
 * the standard `ollamaCreatedName` prefill (rev 5, "a user who pulled by
 * hand is not lied to").
 */
function isEquivalentOllamaTag(daemonTag: string, formModel: string): boolean {
  if (ollamaTagsEqual(daemonTag, formModel)) return true;
  return isVettedOllamaAlias(formModel) && isVettedOllamaAlias(daemonTag);
}

/**
 * §4.2: presence is derived CLIENT-SIDE against the live form state — the
 * host's Ollama probe targets the registry-default endpoint, not whatever
 * endpoint the user currently has typed into the dedicated NEXT form, so
 * only the webview can honestly say whether THIS endpoint's daemon has THIS
 * model. `'present'`/`'absent'` only once the daemon is reachable AND
 * `formEndpoint` matches the endpoint `status()` actually probed
 * (`setup.ollama.endpoint`) — any mismatch (including an unprobed
 * `undefined`, which a string formEndpoint can never equal) is honestly
 * `'unknown'`, never a guess. Callers gate this to the ollama branch only
 * (the "picked backend is ollama" half of §4.2 lives at the call site, not
 * here — a non-ollama backend simply never calls this).
 */
export function nextPresence(setup: Pick<SetupData, 'ollama'>, formEndpoint: string, formModel: string): NextPresence {
  const ollama = setup.ollama;
  if (!ollama.running || formEndpoint !== ollama.endpoint) return 'unknown';
  const present = ollama.models.some((m) => isEquivalentOllamaTag(m.name, formModel));
  return present ? 'present' : 'absent';
}

/** §6 "NEXT presence (D2)" — verbatim per state. */
export function nextPresenceText(presence: NextPresence): string {
  switch (presence) {
    case 'present':
      return '✓ Model present on this Ollama';
    case 'absent':
      return 'not present';
    case 'unknown':
      return 'not verified here — Test the endpoint first.';
  }
}

/** §6 "NEXT presence (D2)" — the Download button's own verbatim label. */
export const NEXT_DOWNLOAD_BUTTON_LABEL = 'Download model (~4.7 GB)';

/** §6 "NEXT post-download nudge" (critic C-18): the pull itself does NOT
 *  write `talaria.nextEdit.model` — Apply remains the Tier-1 write. */
export const NEXT_POST_DOWNLOAD_NUDGE = '✓ Downloaded — press Apply to start using it.';

/** §6 "NEXT download unavailable (D3)": renders where the ollama Model
 *  field's prefill would be while `!downloadReady` (R-3). */
export const NEXT_DOWNLOAD_UNAVAILABLE_TEXT =
  "No vetted build of this model is published yet — it can't be downloaded automatically. Use the guided instructions below, or the vLLM path (official release).";

/** §6 "NEXT model line (D1)" — composed from the wire's own `displayName`
 *  rather than a second hardcoded copy of the same string. */
export function nextModelLine(displayName: string): string {
  return `${displayName} — the one supported dedicated model.`;
}

/**
 * §4.3 D2: the Download button shows iff the dedicated model has a
 * published, verified build (`downloadReady`), the picked backend is
 * ollama, and the model isn't already `'present'` on the daemon. `presence
 * === 'unknown'` (endpoint untested) still offers the download — refusing
 * it there would strand a user who simply hasn't hit Test yet.
 */
export function nextDownloadButtonVisible(
  dedicated: SetupData['nextEdit']['dedicated'],
  backendIsOllama: boolean,
  presence: NextPresence,
): boolean {
  return dedicated !== undefined && dedicated.downloadReady && backendIsOllama && presence !== 'present';
}

/** One `guided.*` wire string's two §6 fragments (T13 implementer note):
 *  the runnable command (rendered + copy-to-clipboard payload) and the
 *  caption/digest-verify hint, newline-joined on the wire. */
export interface GuidedLine {
  command: string;
  caption: string;
}

export function splitGuidedLine(text: string): GuidedLine {
  const idx = text.indexOf('\n');
  if (idx === -1) return { command: text, caption: '' };
  return { command: text.slice(0, idx), caption: text.slice(idx + 1) };
}

/** The Endpoint/Model fields' resolved default for ONE candidate backend
 *  option (§4.3 D1). */
export interface DedicatedFieldDefaults {
  endpoint: string;
  model: string;
}

/**
 * Prefer the ALREADY-SAVED endpoint/model when `option` is the ACTIVELY
 * configured NEXT backend (`dedicatedConfigured` — both endpoint AND model
 * non-empty — and its transport matches `option`) — editing an existing
 * dedicated setup must show what's actually saved, not silently overwrite
 * it with the registry default. Otherwise (first-time setup, an
 * only-partially-filled `nextEdit` left over from Generic/off, or
 * Browse-ing a DIFFERENT backend than the one configured) falls back to
 * that option's own connection default / the registry's per-transport
 * `modelDefaults`. Gating on `dedicatedConfigured` (not just the transport
 * string) matters because `nextEdit.model` can carry a leftover value
 * (e.g. the Generic source's own FIM model) even while dedicated NEXT was
 * never actually set up — that value must not masquerade as "saved".
 *
 * ⚠ R-3: `modelDefaults.ollama` is `''` while `!downloadReady` — this
 * deliberately produces an EMPTY model default (never a fabricated name
 * that would resolve to nothing); the openai-compat default is untouched.
 */
export function dedicatedFieldDefaults(
  setup: Pick<SetupData, 'nextEdit'>,
  option: SetupBackendOption | undefined,
): DedicatedFieldDefaults {
  const isCurrentBackend =
    setup.nextEdit.dedicatedConfigured &&
    option?.nextEditTransport !== undefined &&
    option.nextEditTransport === setup.nextEdit.backend;
  const endpoint = (isCurrentBackend ? setup.nextEdit.endpoint : '') || option?.remote?.endpointDefault || '';
  const savedModel = isCurrentBackend ? setup.nextEdit.model : '';
  const dedicated = setup.nextEdit.dedicated;
  const registryDefault =
    option?.nextEditTransport === 'ollama' ? dedicated?.modelDefaults.ollama : dedicated?.modelDefaults.openaiCompat;
  const model = savedModel || registryDefault || '';
  return { endpoint, model };
}

/** `DedicatedNextForm`'s Endpoint/Model local state, tagged with the
 *  `selectedId` it was last reconciled against. */
export interface DedicatedFormFieldState extends DedicatedFieldDefaults {
  lastSelectedId: string;
}

export function initDedicatedFormFieldState(selectedId: string, defaults: DedicatedFieldDefaults): DedicatedFormFieldState {
  return { lastSelectedId: selectedId, ...defaults };
}

/**
 * Reconcile the Endpoint/Model fields when the picked backend changes —
 * `settingsField.ts`'s own "adjust state while rendering" pattern
 * (`reconcileFieldEditState`), keyed off `selectedId` (a LOCAL-state
 * dependency here, not a host push): a no-op while the id hasn't moved
 * since the last reconcile — an in-flight local edit survives an unrelated
 * re-render — but the moment the user switches backends, the fields reset
 * to THAT backend's defaults. Without this, switching from ollama to
 * llama.cpp would leave ollama's endpoint/model sitting in llama.cpp's
 * fields.
 */
export function reconcileDedicatedFormFields(
  state: DedicatedFormFieldState,
  selectedId: string,
  defaults: DedicatedFieldDefaults,
): DedicatedFormFieldState {
  if (selectedId === state.lastSelectedId) return state;
  return initDedicatedFormFieldState(selectedId, defaults);
}
