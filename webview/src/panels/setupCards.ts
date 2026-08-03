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
import type { AgentSetupPhase, SetupBackendOption, SetupProgress } from '../protocol';

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
  error: 'Install failed',
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
      return { kind: 'retry', label: 'Retry install' };
    case 'python-unsuitable':
      return { kind: 'none', label: '' };
    case 'missing':
      return { kind: 'install', label: 'Install Hermes' };
    case 'installing':
      return { kind: 'installing', label: 'Installing…' };
    case 'installed-inactive':
      return { kind: 'activate', label: 'Activate + Reload' };
    case 'awaiting-reload':
      return { kind: 'reload', label: 'Re-check' };
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
