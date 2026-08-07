/*
 * `LocalModelBlock` — the shared "Local Model" component (beta.6 T10, plan
 * doc §4.1/§4.2/§6). Renders ONE catalog-role's rows for ONE backend pane
 * (Ollama / llama.cpp / vLLM): the backend's own installed/checking/unknown/
 * ready status, every catalog row's presence + pull/download affordance +
 * in-flight progress/Cancel, and (for llama.cpp/vLLM) a Test button + the
 * post-Test "Serving: …" line. FIM/Agent/NEXT/RAG (T11-T14) each embed this
 * INSIDE their own existing `<Card>` — this component renders content only,
 * never an outer card, so it never double-nests.
 *
 * `ActionButton`/`Tone`/`StatusLine` below are a REPRODUCTION of
 * `SetupPanel.tsx`'s own same-named primitives (successLabel/DECLINED/
 * disabledReason contract, `ActionButton:238` there) — not an import. T10 is
 * scoped to be strictly additive (`localModel.tsx` + `setupCards.ts` only);
 * touching `SetupPanel.tsx` to export these is explicitly T11-T14's call to
 * make when they migrate the FIM/Agent/NEXT/RAG cards onto this block (same
 * "reproduced here, not imported" discipline `protocol.ts` already uses for
 * `SetupCatalogModel` mirroring the host's `CatalogModel`). Keep the two
 * copies behaviorally identical until that migration retires one of them.
 *
 * T11 (FIM migration) evaluated the consolidation and KEPT the reproduction
 * — a recorded decision, not an oversight: `SetupPanel.tsx` now imports
 * `LocalModelBlock` from here, so importing its primitives back would make
 * `SetupPanel.tsx ⇄ localModel.tsx` a module cycle; a third shared file was
 * judged not worth it for two small primitives. The copies remain
 * behaviorally identical (SetupPanel's extra `tone` prop aside — unused
 * here, identical at `tone='neutral'`), locked by both dom suites; T12-T14
 * inherit the same standing choice unless they extract a shared module.
 *
 * T12 (Agent surface) kept that standing choice and made two ADDITIVE
 * extensions instead: the opt-in per-row `rowCaption`/`runCommandCaption`
 * slots (§3.1's Devstral-default + A-F7 publisher-provenance + pre-save-port
 * captions are SURFACE copy, composed in setupCards.ts and passed in — the
 * block still never hardcodes surface wording), and `RunCommandLine`/
 * `TestAndServingLine` became exports so the Agent section reuses them in
 * the SetupPanel → localModel import direction (no cycle, no third copy).
 *
 * T13 (NEXT surface) kept it too and added ONE more opt-in slot the same
 * way: `pinnedDownload` (§3.3's pinned-model llama.cpp cell — label + the
 * surface's fail-closed reason live in the NEXT card's own copy, passed in;
 * see the prop doc). Omitted, the llama.cpp branch is byte-identical.
 *
 * T14 (RAG surface) closed the loop with ZERO block changes — all four
 * surfaces now render through this component. The RAG section passes only
 * pre-existing props: informational rows (no `selectedId`), its own §6
 * nudge via `ollamaPullSuccessLabel`, and deliberately NO `pinnedDownload`
 * (RAG rows are allowlist/live-oid tier — the generic Download +
 * honest-absence semantics are the right ones there; T13 report note 1).
 */
import { useEffect, useState } from 'react';
import type { SetupCatalogModel, SetupData, SetupMethod } from '../protocol';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill } from '../components/Pill';
import { DECLINED, errorMessage } from '../state/panels';
import {
  CANCEL_LABEL,
  CATALOG_DEFAULT_CHIP_LABEL,
  LLAMACPP_CHECKING_TEXT,
  LLAMACPP_DOWNLOAD_SUCCESS_TEXT,
  LLAMACPP_HONEST_ABSENCE_TEXT,
  LLAMACPP_MISSING_TEXT,
  LLAMACPP_UNKNOWN_TEXT,
  OLLAMA_DAEMON_DOWN_PULL_REASON,
  OLLAMA_MISSING_TEXT,
  backendReadyText,
  cancelPullParams,
  catalogPresence,
  catalogPresenceText,
  llamacppDownloadButtonLabel,
  llamacppPresenceText,
  ollamaPullButtonLabel,
  progressKey,
  pullPercent,
  recheckScopeParams,
  servingLine,
  testConnectionLabel,
  type SetupProgressMap,
} from './setupCards';

export type LocalModelBackend = 'ollama' | 'llamacpp' | 'vllm';

export interface LocalModelBlockProps {
  /** Which backend pane this render is for — one block instance per pane. */
  backend: LocalModelBackend;
  /** The catalog rows to show, already role-filtered by the caller. */
  models: readonly SetupCatalogModel[];
  /** Only consulted when `backend === 'ollama'`. */
  ollama: SetupData['ollama'];
  /** Only consulted when `backend === 'llamacpp'`. */
  llamacppRuntime: SetupData['llamacppRuntime'];
  /** The endpoint Pull/Download/Test target for this pane. */
  endpoint: string;
  progress: SetupProgressMap;
  dispatch: (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>;
  /** Trust-gate reason (§8 FM-14) — applies to MUTATING actions only (Pull/Download/install-terminal). */
  disabledReason?: string;
  /** Picker semantics (Agent's 6-model picker, T12): which row is selected. Omit for informational-only rows (FIM/RAG/NEXT). */
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Surface-specific Pull-success nudge (FIM/RAG each have their own §6 wording) — omit for none. */
  ollamaPullSuccessLabel?: string;
  /**
   * T12 (§3.1): a per-row quiet caption, surface-composed (the Agent picker's
   * Devstral-recommended caption + the A-F7 publisher-provenance caption via
   * `agentRowCaption`). OPT-IN — omitted, no row renders any caption; the
   * block itself never composes surface copy (same rule as
   * `ollamaPullSuccessLabel`).
   */
  rowCaption?: (model: SetupCatalogModel) => string | undefined;
  /**
   * T12 (§6 "Run command caption (agent, pre-save)"): rendered under each
   * RENDERED run command. OPT-IN; the caller owns the honesty of passing it
   * only where it is true (the Agent surface passes it on the llama.cpp pane
   * only — `vllm serve` carries no port for Save to update).
   */
  runCommandCaption?: string;
  /**
   * T13 (§3.3): pinned-model semantics for the llama.cpp pane (the NEXT
   * surface). When set: (a) the pane's Download button carries `label` in
   * EVERY state — the NEXT card's own §6 button vocabulary, preserved from
   * beta.5, instead of the generic `Download {name} (~{size})` template;
   * (b) an `available: false` cell WITHOUT a wire `unavailableReason`
   * renders `unavailableReason` (the surface's §6 fail-closed line) PLUS the
   * same button disabled-with-reason, instead of the generic honest-absence
   * text — `composeLlamacppCell` deliberately ships the pinned-unpublished
   * cell reason-less because the NEXT card's wire truth owns that copy, and
   * the generic line ("use it via Ollama") would be a lie for a
   * pinned-but-unpublished build. A wire `unavailableReason` still WINS
   * (host-asserted absence keeps its own copy, no button). llama.cpp-pane
   * scope only; the ollama branch never consults it (NEXT's ollama pane is
   * not block-rendered). OPT-IN — omitted, behavior is byte-identical.
   */
  pinnedDownload?: { label: string; unavailableReason: string };
  /**
   * beta.6 panel-fix (T6): fires exactly when an OLLAMA-pane Pull dispatch
   * resolves with a result ≠ DECLINED (the same condition as the success
   * flash). Never on rejection, never on DECLINED, never on llama.cpp/vLLM
   * Download. The surface owns any snapshot/no-clobber rule. Omitted ⇒
   * byte-identical behavior.
   */
  onOllamaPullSuccess?: (model: SetupCatalogModel) => void;
}

export function LocalModelBlock(props: LocalModelBlockProps) {
  const { backend, models, endpoint, progress, dispatch, disabledReason, selectedId, onSelect } = props;

  return (
    <div className="flex flex-col gap-2">
      {backend === 'ollama' && <OllamaBackendHeader ollama={props.ollama} dispatch={dispatch} disabledReason={disabledReason} />}
      {backend === 'llamacpp' && <LlamacppBackendHeader runtime={props.llamacppRuntime} dispatch={dispatch} disabledReason={disabledReason} />}

      <div className="flex flex-col gap-1.5">
        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            backend={backend}
            ollama={props.ollama}
            endpoint={endpoint}
            progress={progress}
            dispatch={dispatch}
            disabledReason={disabledReason}
            selected={selectedId === model.id}
            onSelect={onSelect}
            ollamaPullSuccessLabel={props.ollamaPullSuccessLabel}
            caption={props.rowCaption?.(model)}
            runCommandCaption={props.runCommandCaption}
            pinnedDownload={props.pinnedDownload}
            onOllamaPullSuccess={props.onOllamaPullSuccess}
          />
        ))}
      </div>

      {backend !== 'ollama' && <TestAndServingLine backend={backend} endpoint={endpoint} dispatch={dispatch} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Backend headers (§4.1 rows 1-4)
 * ------------------------------------------------------------------ */

function OllamaBackendHeader({
  ollama,
  dispatch,
  disabledReason,
}: {
  ollama: SetupData['ollama'];
  dispatch: LocalModelBlockProps['dispatch'];
  disabledReason?: string;
}) {
  if (!ollama.running) {
    return (
      <div className="flex flex-col gap-1.5">
        <StatusLine icon="circle-outline" text={OLLAMA_MISSING_TEXT} tone="neutral" />
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            label="Open terminal: install Ollama"
            onRun={() => dispatch('setup.openInstallTerminal', { backendId: 'ollama' })}
            disabledReason={disabledReason}
          />
          <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck', recheckScopeParams('ollama'))} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusLine icon="pass-filled" text={backendReadyText('ollama', ollama.version)} tone="add" />
      {/* Ready still offers Re-check (unlike the pre-T10 `OllamaInstallPanel`
          running-branch gap, §0.3) — a daemon can be stopped/restarted
          without a webview reload, and there is no other way to force a
          fresh probe from this pane. */}
      <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck', recheckScopeParams('ollama'))} />
    </div>
  );
}

function LlamacppBackendHeader({
  runtime,
  dispatch,
  disabledReason,
}: {
  runtime: SetupData['llamacppRuntime'];
  dispatch: LocalModelBlockProps['dispatch'];
  disabledReason?: string;
}) {
  const binary = runtime?.binary ?? 'checking';

  if (binary === 'checking') {
    return <StatusLine icon="sync" text={LLAMACPP_CHECKING_TEXT} tone="accent" />;
  }

  if (binary === 'unknown') {
    // rev 3 (CC-5): a probe-timeout is NOT "not found" — this branch NEVER
    // renders the install button, unconditionally, even if `runtime.install`
    // happens to be populated from a stale prior state.
    return (
      <div className="flex flex-col gap-1.5">
        <StatusLine icon="question" text={LLAMACPP_UNKNOWN_TEXT} tone="neutral" />
        <div>
          <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck', recheckScopeParams('llamacpp'))} />
        </div>
      </div>
    );
  }

  if (binary === 'missing') {
    const install = runtime?.install;
    return (
      <div className="flex flex-col gap-1.5">
        <StatusLine icon="circle-outline" text={LLAMACPP_MISSING_TEXT} tone="neutral" />
        {install?.command ? (
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              label={`Open terminal: ${install.command}`}
              onRun={() => dispatch('setup.openInstallTerminal', { backendId: 'llamacpp' })}
              disabledReason={disabledReason}
            />
            <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck', recheckScopeParams('llamacpp'))} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {install?.guidance && <p className="text-2xs text-muted">{install.guidance}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {install?.docsUrl && (
                <a href={install.docsUrl} className="text-2xs text-accent underline" target="_blank" rel="noreferrer">
                  docs
                </a>
              )}
              <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck', recheckScopeParams('llamacpp'))} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // binary === 'found'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusLine icon="pass-filled" text={backendReadyText('llamacpp', runtime?.version)} tone="add" />
      <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck', recheckScopeParams('llamacpp'))} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Model rows (§4.1 rows 5-8)
 * ------------------------------------------------------------------ */

function ModelRow({
  model,
  backend,
  ollama,
  endpoint,
  progress,
  dispatch,
  disabledReason,
  selected,
  onSelect,
  ollamaPullSuccessLabel,
  caption,
  runCommandCaption,
  pinnedDownload,
  onOllamaPullSuccess,
}: {
  model: SetupCatalogModel;
  backend: LocalModelBackend;
  ollama: SetupData['ollama'];
  endpoint: string;
  progress: SetupProgressMap;
  dispatch: LocalModelBlockProps['dispatch'];
  disabledReason?: string;
  selected: boolean;
  onSelect?: (id: string) => void;
  ollamaPullSuccessLabel?: string;
  caption?: string;
  runCommandCaption?: string;
  pinnedDownload?: LocalModelBlockProps['pinnedDownload'];
  onOllamaPullSuccess?: LocalModelBlockProps['onOllamaPullSuccess'];
}) {
  const live = progress[progressKey('pull', model.id)];
  const percent = pullPercent(live?.totalBytes, live?.completedBytes);

  let presenceText: string | undefined;
  let isPresent = false;
  let action: { label: string; onRun: () => Promise<unknown>; disabledReason?: string; successLabel?: string } | undefined;
  let absenceOnly: string | undefined; // llama.cpp honest-absence: no action at all

  if (backend === 'ollama') {
    const presence = catalogPresence(ollama, endpoint, model);
    isPresent = presence === 'present';
    presenceText = catalogPresenceText(presence);
    if (!isPresent) {
      action = {
        label: ollamaPullButtonLabel(model),
        onRun: onOllamaPullSuccess
          ? () =>
              dispatch('setup.provisionModel', { modelId: model.id, backend: 'ollama', endpoint }).then((result) => {
                if (result !== DECLINED) onOllamaPullSuccess(model);
                return result;
              })
          : () => dispatch('setup.provisionModel', { modelId: model.id, backend: 'ollama', endpoint }),
        // §4.1: Ollama rows with no daemon are visible, Pull disabled-with-reason —
        // independent of (but additive to) the trust gate.
        disabledReason: disabledReason ?? (!ollama.running ? OLLAMA_DAEMON_DOWN_PULL_REASON : undefined),
        successLabel: ollamaPullSuccessLabel,
      };
    }
  } else if (backend === 'llamacpp') {
    const cell = model.llamacpp;
    if (cell === undefined || cell.available === false) {
      if (cell !== undefined && cell.unavailableReason === undefined && pinnedDownload !== undefined) {
        // T13 (§3.3): the pinned-unpublished cell — the surface's own
        // fail-closed line + the SAME download button, disabled naming that
        // line as the reason (it can never run regardless of trust, so the
        // pin reason outranks the trust gate's). A wire `unavailableReason`
        // never reaches this branch (host-asserted absence wins above).
        absenceOnly = pinnedDownload.unavailableReason;
        action = {
          label: pinnedDownload.label,
          onRun: () => Promise.resolve(undefined),
          disabledReason: pinnedDownload.unavailableReason,
        };
      } else {
        absenceOnly = cell?.unavailableReason ?? LLAMACPP_HONEST_ABSENCE_TEXT;
      }
    } else {
      isPresent = cell.present;
      presenceText = llamacppPresenceText(isPresent);
      if (!isPresent) {
        // SC-A-11: NEVER disabled by backend/runtime state — only the trust gate.
        action = {
          label: pinnedDownload?.label ?? llamacppDownloadButtonLabel(model, cell.approxBytes),
          onRun: () => dispatch('setup.provisionModel', { modelId: model.id, backend: 'llamacpp', endpoint }),
          disabledReason,
          successLabel: LLAMACPP_DOWNLOAD_SUCCESS_TEXT,
        };
      }
    }
  }
  // vllm: no presence/action at all — the run command IS the row's content.

  const inFlight = live !== undefined && !isPresent && backend !== 'vllm';
  const runCommand = backend === 'llamacpp' && isPresent ? model.llamacpp?.runCommand : backend === 'vllm' ? model.vllm?.runCommand : undefined;

  return (
    <div className="flex flex-col gap-1 rounded border border-border bg-overlay px-2 py-1.5">
      <div className="flex items-center gap-2">
        {onSelect ? (
          <button
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(model.id)}
            className={`min-w-0 flex-1 truncate rounded border px-2 py-1 text-left text-xs transition-colors ${
              selected ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg hover:border-accent'
            }`}
          >
            {model.displayName}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-fg">{model.displayName}</span>
        )}
        {model.defaultForRole && <Pill tone="accent">{CATALOG_DEFAULT_CHIP_LABEL}</Pill>}
      </div>

      {model.vramLine && <p className="text-2xs text-faint">{model.vramLine}</p>}
      {model.note && <p className="text-2xs text-muted">{model.note}</p>}
      {caption && <p className="text-2xs text-muted">{caption}</p>}

      {presenceText && <StatusLine icon={isPresent ? 'pass-filled' : 'circle-outline'} text={presenceText} tone={isPresent ? 'add' : 'neutral'} />}
      {absenceOnly && <p className="text-2xs text-muted">{absenceOnly}</p>}

      {action && (
        <div>
          <ActionButton label={action.label} icon="cloud-download" onRun={action.onRun} disabledReason={action.disabledReason} successLabel={action.successLabel} />
        </div>
      )}

      {runCommand && (
        <>
          {/* beta.6 panel-fix PT8 (audit A10): "Start the server:" on
              llamacpp rows, "Run:" on vllm rows — the only two backends this
              row's `runCommand` branch above ever populates for. */}
          <RunCommandLine command={runCommand} label={backend === 'llamacpp' ? 'Start the server:' : 'Run:'} />
          {runCommandCaption && <p className="text-2xs text-faint">{runCommandCaption}</p>}
        </>
      )}

      {inFlight && (
        <div className="flex flex-col gap-1">
          {percent !== undefined && (
            <div className="flex items-center gap-2" aria-live="polite">
              <div
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Pulling ${model.id}`}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"
              >
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
              <span className="font-mono text-2xs text-faint">{percent}%</span>
            </div>
          )}
          <div>
            <ActionButton label={CANCEL_LABEL} icon="close" onRun={() => dispatch('setup.cancel', cancelPullParams(model.id))} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Exported (T12): the Agent section's saved summary renders
 *  `saved.runCommand` through this same element — same import direction as
 *  `LocalModelBlock` itself (SetupPanel → localModel), so no module cycle.
 *  beta.6 panel-fix PT8 (audit A10): the OPTIONAL `label` slot names what the
 *  command actually does ("Start the server:" / "Run:") — §6 pinned this
 *  caption but no site rendered it; omitted ⇒ byte-identical (no label). */
export function RunCommandLine({ command, label }: { command: string; label?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-2 py-1 text-2xs">
      {label && <span className="flex-none text-faint">{label}</span>}
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={command}>
        {command}
      </span>
      <ActionButton label="Copy" icon="copy" onRun={() => navigator.clipboard.writeText(command)} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Test + Serving line (llama.cpp / vLLM panes)
 * ------------------------------------------------------------------ */

/** Exported (T12): the Agent surface's OLLAMA pane renders its surface-level
 *  Test + Serving line through this same component (the block only renders it
 *  for llamacpp/vllm panes) — `backend: 'ollama'` dispatches
 *  `setup.testRemote {backendId:'ollama'}` exactly like the FIM surface's own
 *  surface-level Test. Same no-cycle import direction as `RunCommandLine`. */
export function TestAndServingLine({
  backend,
  endpoint,
  dispatch,
}: {
  backend: LocalModelBackend;
  endpoint: string;
  dispatch: LocalModelBlockProps['dispatch'];
}) {
  const [servingModels, setServingModels] = useState<string[] | undefined>(undefined);

  const runTest = async (): Promise<unknown> => {
    const result = await dispatch('setup.testRemote', { backendId: backend, endpoint });
    const models = (result as { models?: string[] } | undefined)?.models;
    setServingModels(models && models.length > 0 ? models : undefined);
    return result;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton label={testConnectionLabel(endpoint)} icon="plug" onRun={runTest} successLabel="✓ Endpoint reachable" />
      </div>
      {servingModels && <p className="text-2xs text-muted">{servingLine(servingModels)}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared local primitives (reproduced from SetupPanel.tsx — see file doc)
 * ------------------------------------------------------------------ */

type Tone = 'neutral' | 'add' | 'warn' | 'del' | 'accent';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  add: 'text-add',
  warn: 'text-warn',
  del: 'text-del',
  accent: 'text-accent',
};

function StatusLine({ icon, text, tone }: { icon: string; text: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Icon name={icon} size={13} className={`flex-none ${TONE_TEXT[tone]}`} />
      <span className={TONE_TEXT[tone]}>{text}</span>
    </div>
  );
}

function ActionButton({
  label,
  onRun,
  disabledReason,
  icon,
  successLabel,
}: {
  label: string;
  onRun: () => Promise<unknown>;
  disabledReason?: string;
  icon?: string;
  successLabel?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);
  const genuinelyDisabled = disabledReason !== undefined;

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(false), 4000);
    return () => clearTimeout(timer);
  }, [success]);

  const onClick = () => {
    if (genuinelyDisabled || pending) return;
    setPending(true);
    setError(undefined);
    setSuccess(false);
    void onRun().then(
      (result: unknown) => {
        setPending(false);
        if (result === DECLINED) return; // C-2 lock: neither success nor failure
        if (successLabel !== undefined) setSuccess(true);
      },
      (err: unknown) => {
        setPending(false);
        setError(errorMessage(err));
      },
    );
  };

  const liveText = error ? `✗ ${error}` : success && successLabel !== undefined ? successLabel : '';
  const liveClass = error ? 'text-2xs text-del' : 'text-2xs text-add';

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={genuinelyDisabled}
        aria-disabled={genuinelyDisabled || pending ? true : undefined}
        aria-busy={pending ? true : undefined}
        title={genuinelyDisabled ? disabledReason : undefined}
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-muted transition-colors hover:bg-overlay aria-disabled:cursor-default aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {icon && <Icon name={icon} size={12} spin={pending} />}
        {pending ? 'Working…' : label}
      </button>
      <LiveRegion text={liveText} className={liveClass} title={error} />
    </div>
  );
}
