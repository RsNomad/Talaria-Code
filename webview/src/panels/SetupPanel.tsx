/*
 * Setup / Talaria Config panel — five readiness cards (Task 10, plan doc
 * §6): Agent (Hermes install/activate/health), Provider (chat model for the
 * agent), Autocomplete/FIM, NEXT (multi-line next-edit info + dedicated
 * setup), and the codebase index (RAG). This is the SAME screen for
 * first-run onboarding and ongoing config editing — "wizard mood" vs
 * "editor mood" is just which cards have work left, not a different
 * component (D3).
 *
 * Like every other data panel, `SetupData` arrives as `RemoteData` over the
 * correlated `panel.data`/`setup.status` fetch (`RemotePanel`, Part X2) —
 * unlike `SettingsPanel`, there is no F-7-style split: the WHOLE snapshot
 * (agent phase, provider, FIM, NEXT, RAG) is host-assembled from settings +
 * the registry + a best-effort Ollama probe, none of it gated on the live
 * agent connection, so one gate covers the panel honestly.
 *
 * Every mutating control routes through the single `dispatch` prop (the
 * `SetupMethod` correlated-request surface, §6's protocol table) — this file
 * never imports `bridge`/`rpc` directly, matching every other pure-render
 * panel in this directory (`CheckpointsPanel.tsx`'s own doc explains why).
 * `!trusted` disables every mutating control via `mutationDisabledReason`
 * (setupCards.ts) — same reason text everywhere, never color alone.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type {
  NextEditToggleSource,
  NextEditToggleState,
  SetupBackendOption,
  SetupCatalogModel,
  SetupData,
  SetupMethod,
} from '../protocol';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill } from '../components/Pill';
import { Toggle } from '../components/Toggle';
import { DECLINED, errorMessage } from '../state/panels';
import type { RemoteData } from '../state/remoteData';
import { LocalModelBlock, RunCommandLine, TestAndServingLine } from './localModel';
import { type NextEditRowCopy, NEXT_EDIT_ROWS } from './nextEditCopy';
import { PanelShell, RemotePanel, SectionLabel } from './PanelShell';
import { commitFieldEdit, initNextEditRowState, reconcileNextEditRowState } from './settingsField';
import {
  AGENT_BLOCK_HEADING,
  AGENT_PRE_READY_NOTE,
  AGENT_PRESAVE_RUN_COMMAND_CAPTION,
  agentDoneLine,
  agentEndpointInit,
  agentInitialBackend,
  agentPhaseLabel,
  agentPrimaryAction,
  agentRowCaption,
  agentSavedSummaryLine,
  BACKEND_DISPLAY,
  buildCopyLogText,
  catalogPreselectId,
  type AgentModelBackend,
  CANCEL_LABEL,
  cancelPullParams,
  CATALOG_DEFAULT_CHIP_LABEL,
  catalogPresence,
  catalogPresenceText,
  catalogRowIdForModel,
  configuredModelOutsideCatalog,
  dedicatedFieldDefaults,
  dedicatedInitialCandidateId,
  // beta.6 T18 (§3.5) — start-screen model recommendations
  deriveRecommendations,
  divergenceCaptionText,
  FIM_LLAMACPP_MODEL_NOTE,
  FIM_LLAMACPP_NUDGE,
  FIM_MODEL_FIELD_CAPTION,
  FIM_MODEL_FIELD_LABEL,
  FIM_OLLAMA_PULL_NUDGE,
  FIM_PENDING_CAPTION,
  fimDoneLine,
  fimHasLocalInstall,
  fimInstallTestEndpoint,
  fimModelFieldVisible,
  initDedicatedFormFieldState,
  initPendingModel,
  isComingSoon,
  meterSegments,
  mutationDisabledReason,
  NEXT_DOWNLOAD_BUTTON_LABEL,
  NEXT_DOWNLOAD_UNAVAILABLE_TEXT,
  NEXT_POST_DOWNLOAD_NUDGE,
  nextDoneLine,
  nextDownloadButtonVisible,
  nextEditButtonLabel,
  nextLlamacppDigestHint,
  nextModelLine,
  nextPresence,
  nextPresenceText,
  ollamaTagsEqual,
  pendingSelectionLine,
  PIPX_INSTALL_DOCS_URL,
  progressKey,
  providerDoneLine,
  PROVIDER_RECHECK_CAPTION,
  PYTHON_VERSION_HELP_URL,
  pullPercent,
  RAG_APPLY_NUDGE,
  RAG_LLAMACPP_MODEL_NOTE,
  RAG_MODEL_FIELD_CAPTION,
  RAG_MODEL_FIELD_LABEL,
  RAG_OLLAMA_PULL_NUDGE,
  RAG_THIRD_TAB_LABEL,
  ragBlockBackend,
  ragDoneLine,
  ragEmbedPresence,
  ragEndpointInit,
  ragInitialBackend,
  RECS_DISCLOSURE_SUMMARY,
  RECS_MOE_NOTE,
  RECS_ROLE_LABEL,
  RECS_STRIP_HEADING,
  RECS_STRIP_INTRO,
  reconcileDedicatedFormFields,
  reconcilePendingModel,
  roleLineText,
  splitGuidedLine,
  stackLineText,
  testConnectionLabel,
  TRUST_DISABLED_REASON,
  type NextPresence,
  type RagEmbedBackend,
  type RoleRec,
  type SetupProgressMap,
} from './setupCards';

export interface SetupPanelProps {
  /** The Setup panel's own RemoteData — idle/loading/error/success (Part X2). */
  data: RemoteData<SetupData> | undefined;
  /** Re-invoke the `setup.status` fetch (the gate's Retry). */
  onRetry: () => void;
  /** Client-side accumulation of `setup.progress` pushes, keyed by `${op}:${id}` (setupCards.ts). */
  progress: SetupProgressMap;
  /** The Guard-ratified NEXT toggle state (same push SettingsPanel reads — R5/D7). */
  nextEdit: NextEditToggleState;
  onToggleNextEdit: (source: NextEditToggleSource, on: boolean) => Promise<unknown>;
  /** Fire one correlated `SetupMethod` request. Resolves ok / rejects with the refusal reason. */
  dispatch: (method: SetupMethod, params?: Record<string, unknown>) => Promise<unknown>;
}

export function SetupPanel({ data, onRetry, progress, nextEdit, onToggleNextEdit, dispatch }: SetupPanelProps) {
  return (
    <PanelShell title="Setup / Talaria Config">
      <RemotePanel remote={data} loadingHint="Loading setup status…" onRetry={onRetry}>
        {(setup) => (
          <SetupCards
            setup={setup}
            progress={progress}
            nextEdit={nextEdit}
            onToggleNextEdit={onToggleNextEdit}
            dispatch={dispatch}
          />
        )}
      </RemotePanel>
    </PanelShell>
  );
}

/** beta.7 B2: one "Set up →" click's expand request. `seq` makes every
 *  click distinct so re-jumping to the same card re-fires. */
interface JumpSignal {
  cardId: string;
  seq: number;
}

/** beta.7 B2: expand-on-jump. Effect 1 opens the section the moment a NEW
 *  signal names `cardId`; effect 2 — which can only run AFTER the expand's
 *  own commit (`isOpen` true) — scrolls the toggle into view and focuses it
 *  (preventScroll so focus doesn't cancel the smooth scroll). Two effects,
 *  not one: the DOM the scroll lands on only exists after the first commit. */
function useExpandOnJump(
  jump: JumpSignal | undefined,
  cardId: string,
  isOpen: boolean,
  expand: () => void,
  toggleRef: RefObject<HTMLButtonElement | null>,
): void {
  const [pendingSeq, setPendingSeq] = useState(0);
  const handledSeq = useRef(0);
  useEffect(() => {
    if (!jump || jump.cardId !== cardId || jump.seq === handledSeq.current) return;
    handledSeq.current = jump.seq;
    expand();
    setPendingSeq(jump.seq);
  }, [jump, cardId, expand]);
  useEffect(() => {
    if (pendingSeq === 0 || !isOpen) return;
    setPendingSeq(0);
    toggleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toggleRef.current?.focus({ preventScroll: true });
  }, [pendingSeq, isOpen, toggleRef]);
}

function SetupCards({
  setup,
  progress,
  nextEdit,
  onToggleNextEdit,
  dispatch,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  nextEdit: NextEditToggleState;
  onToggleNextEdit: SetupPanelProps['onToggleNextEdit'];
  dispatch: SetupPanelProps['dispatch'];
}) {
  const disabledReason = mutationDisabledReason(setup.trusted);
  const [jump, setJump] = useState<JumpSignal | undefined>(undefined);
  const requestJump = (cardId: string) => setJump((prev) => ({ cardId, seq: (prev?.seq ?? 0) + 1 }));

  return (
    <>
      {setup.os?.containerNote && (
        <div
          role="note"
          aria-label="Container/sandbox notice"
          className="mb-3 flex items-start gap-2 rounded-card border border-warn bg-warn-soft px-3 py-2 text-2xs text-fg"
        >
          <Icon name="warning" size={14} className="mt-0.5 flex-none text-warn" />
          <span>{setup.os.containerNote}</span>
        </div>
      )}

      {!setup.trusted && (
        <div
          role="note"
          aria-label="Restricted Mode notice"
          className="mb-3 flex items-start gap-2 rounded-card border border-warn bg-warn-soft px-3 py-2 text-2xs text-fg"
        >
          <Icon name="lock" size={14} className="mt-0.5 flex-none text-warn" />
          <span>{TRUST_DISABLED_REASON}</span>
        </div>
      )}

      {setup.ready && (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-card border border-add bg-add-soft px-3 py-2 text-xs text-fg"
        >
          <Icon name="pass-filled" size={14} className="flex-none text-add" />
          <span>You&apos;re ready — agent, provider, and autocomplete are all set up.</span>
        </div>
      )}

      <RecommendationsBlock setup={setup} onJump={requestJump} />
      <AgentCard setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} jump={jump} />
      <ProviderCard setup={setup} dispatch={dispatch} disabledReason={disabledReason} />
      <FimCard setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} />
      <NextEditCard
        setup={setup}
        progress={progress}
        nextEdit={nextEdit}
        onToggleNextEdit={onToggleNextEdit}
        dispatch={dispatch}
        disabledReason={disabledReason}
        jump={jump}
      />
      <RagCard setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} jump={jump} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Shared primitives
 * ------------------------------------------------------------------ */

/**
 * `id`, when given, becomes BOTH the `<section>`'s own id (the recs strip's
 * `Set up →` `scrollIntoView` target) and, via `${id}-heading`, the
 * focusable heading id (beta.6 T18, B-F6). Every pre-T18 caller omits it.
 */
function Card({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-3 rounded-card border border-border bg-surface p-3">
      <SectionLabel id={id !== undefined ? `${id}-heading` : undefined}>{title}</SectionLabel>
      {children}
    </section>
  );
}

type Tone = 'neutral' | 'add' | 'warn' | 'del' | 'accent';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  add: 'text-add',
  warn: 'text-warn',
  del: 'text-del',
  accent: 'text-accent',
};

/** icon + text status readout — §6: "no color-only status". */
function StatusLine({ icon, text, tone }: { icon: string; text: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Icon name={icon} size={13} className={`flex-none ${TONE_TEXT[tone]}`} />
      <span className={TONE_TEXT[tone]}>{text}</span>
    </div>
  );
}

/**
 * T10 (§2.5 B5): the quiet one-line "done / what next" status under a card —
 * `pass-filled` + `text-add`, icon+text (never color-only). Renders nothing
 * for an empty line (the `*DoneLine` helpers return `''` while not done).
 */
function DoneLine({ text, className = 'mt-1' }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={className}>
      <StatusLine icon="pass-filled" text={text} tone="add" />
    </div>
  );
}

/**
 * One async, dispatch-issuing action. Local pending/error state — busy via
 * `aria-disabled` (keeps focus, mirrors `Toggle.tsx`'s F-8 posture);
 * `disabledReason`, when given, is a GENUINE indefinite disablement (the
 * trust gate) and renders NATIVE `disabled` + `aria-disabled` + a `title`
 * tooltip naming why (§6's accessibility rule).
 *
 * T9 (§2.4 B4 — "Test (and friends) speak on success"): `successLabel`,
 * when given, is announced through the SAME always-mounted `LiveRegion`
 * (polite) on a resolve, in `text-add`, and auto-clears after 4s (the timer
 * is armed only while `success` is true and is cleaned up on every path out
 * — a fresh success re-arms it, an unmount clears it — mirroring
 * `ApprovalCard.tsx`'s local-expiry timer; no leaked timer, no
 * set-state-after-unmount). No `successLabel` ⇒ today's behavior (nothing).
 * A resolved value === {@link DECLINED} (the user dismissed a native
 * confirmation modal, T2/§2.2.4) renders NEITHER success nor failure — the
 * C-2 lock — regardless of whether `successLabel` was given. A rejection
 * always renders the `✗ ${message}` failure line.
 */
function ActionButton({
  label,
  onRun,
  disabledReason,
  tone = 'neutral',
  icon,
  successLabel,
}: {
  label: string;
  onRun: () => Promise<unknown>;
  disabledReason?: string;
  tone?: Tone;
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

  const toneClass =
    tone === 'accent'
      ? 'border-accent text-accent hover:bg-accent-soft'
      : tone === 'warn'
        ? 'border-warn text-warn hover:bg-warn-soft'
        : 'border-border text-muted hover:bg-overlay';

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
        className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide transition-colors aria-disabled:cursor-default aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
      >
        {icon && <Icon name={icon} size={12} spin={pending} />}
        {pending ? 'Working…' : label}
      </button>
      <LiveRegion text={liveText} className={liveClass} title={error} />
    </div>
  );
}

/** One selectable/informational backend-option row, shared by the Agent and FIM pickers. */
function BackendOptionRow({
  option,
  selected,
  onSelect,
}: {
  option: SetupBackendOption;
  selected: boolean;
  onSelect?: (id: string) => void;
}) {
  const comingSoon = isComingSoon(option);
  const className = `flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-left text-xs transition-colors aria-disabled:cursor-default aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50 ${
    selected ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-overlay text-fg hover:border-accent'
  }`;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{option.displayName}</span>
      {comingSoon && <Pill tone="neutral">Coming soon</Pill>}
    </>
  );
  // A19 (C1-13): when there is no `onSelect` (identity rows — e.g. the Agent
  // card's own options), this row isn't a control at all — render the same
  // non-interactive span `ModelRow` uses (`localModel.tsx`) instead of a
  // styled, focusable button whose click was always a no-op.
  if (!onSelect) {
    return <span className={className}>{content}</span>;
  }
  return (
    <button
      type="button"
      disabled={comingSoon}
      aria-disabled={comingSoon ? true : undefined}
      aria-pressed={selected}
      title={comingSoon ? 'Coming soon' : undefined}
      onClick={() => {
        if (comingSoon) return;
        onSelect(option.id);
      }}
      className={className}
    >
      {content}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** id of an external caption element — `aria-describedby` plumbing
   *  (beta.6 panel-fix PT4, critic C1-15). The CALLER owns rendering an
   *  element with this id; omitted ⇒ byte-identical behavior. */
  describedBy?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-2xs text-muted">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-overlay px-2 py-1 font-mono text-2xs text-fg"
      />
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * beta.6 T18 (§3.5) — start-screen model recommendations, Home 1
 * (dynamic strip, mounted ABOVE the Agent card). Pure derivation lives in
 * `setupCards.ts` (`deriveRecommendations` + friends) — B-F7's render gate
 * is enforced THERE: an `undefined` result means this component renders
 * nothing at all, not even the `Card` wrapper. Home 2 (the static
 * walkthrough markdown, `media/walkthrough-setup.md`) shares the §6 rule
 * but not this code — see `src/host/walkthroughRecs.test.ts`.
 * ------------------------------------------------------------------ */

/** The stack meter's three fill colors — the EXISTING semantic tone tokens
 *  (`bg-accent`/`bg-add`/`bg-warn`, already used elsewhere in this file for
 *  the pull-progress bar and BackendOptionRow selection state) repurposed
 *  purely for visual segment separation; no new palette (GC7). */
const RECS_METER_SEGMENT_CLASS: Record<'agent' | 'fim' | 'embedding', string> = {
  agent: 'bg-accent',
  fim: 'bg-add',
  embedding: 'bg-warn',
};

/**
 * B-F6 — the recs strip's `Set up →` jump for the FIM row: IN-PANEL ONLY.
 * Scrolls the owning card's `<section id={cardId}>` into view and moves
 * focus to its heading (`${cardId}-heading`, `tabIndex={-1}` via
 * `SectionLabel`/`Card`). NO dispatch, no expand — the FIM card's picker
 * has no collapsed state to expand (beta.7 B2: the other three roles route
 * through `useExpandOnJump` instead, via `onJump`/`RecRoleLine`).
 */
function jumpToCard(cardId: string): void {
  const section = document.getElementById(cardId);
  section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById(`${cardId}-heading`)?.focus();
}

function RecommendationsBlock({ setup, onJump }: { setup: SetupData; onJump: (cardId: string) => void }) {
  const recs = deriveRecommendations(setup);
  if (!recs) return null;

  return (
    <Card title={RECS_STRIP_HEADING}>
      <p className="mb-2 text-2xs text-muted">{RECS_STRIP_INTRO}</p>
      <div className="mb-2.5 flex flex-col gap-2">
        <RecRoleLine rec={recs.agent} onJump={onJump} />
        <RecRoleLine rec={recs.fim} onJump={onJump} />
        <RecRoleLine rec={recs.embedding} onJump={onJump} />
        <RecRoleLine rec={recs.next} onJump={onJump} />
      </div>
      <p className="mb-1.5 text-2xs text-fg">{stackLineText(recs.agent, recs.fim, recs.embedding, recs.stack)}</p>
      {/* B-F1/§3.5 signature element: a single segmented bar sharing the
          stack line's own rounded numbers by construction (one derivation,
          two renderings). Purely decorative reinforcement of the text line
          directly above it — `aria-hidden`, never the ONLY carrier of this
          information (color-not-only). */}
      <div aria-hidden="true" className="mb-3 flex h-1.5 w-full overflow-hidden rounded-full bg-border">
        {meterSegments(recs.agent, recs.fim, recs.embedding).map((seg) => (
          <div
            key={seg.role}
            style={{ width: `${seg.pct}%` }}
            className={`h-full ${RECS_METER_SEGMENT_CLASS[seg.role]}`}
          />
        ))}
      </div>
      <details>
        <summary className="cursor-pointer select-none font-mono text-2xs uppercase tracking-wide text-muted hover:text-accent">
          {RECS_DISCLOSURE_SUMMARY}
        </summary>
        <ul className="mt-2 flex flex-col gap-1 pl-4 text-2xs text-muted [list-style-type:disc]">
          <li>{recs.tiers.tier8}</li>
          <li>{recs.tiers.tier1216}</li>
          <li>{recs.tiers.tier24}</li>
          <li>{recs.tiers.tier32}</li>
        </ul>
        <p className="mt-2 text-2xs text-faint">{RECS_MOE_NOTE}</p>
      </details>
    </Card>
  );
}

/**
 * One role line: `{Role} · {displayName} — {size} GiB` + `Default` chip +
 * vramLine + `Set up →` (+ divergence caption). The NEXT/Sweep row is the
 * one exception (§3.5): while `rec.nextReady === false`, the `Default` chip
 * and vramLine are REPLACED by the NEXT card's own fail-closed text
 * (`NEXT_DOWNLOAD_UNAVAILABLE_TEXT`, single-sourced from `setupCards.ts`,
 * never restated) — the strip must never claim "recommended" for an
 * unpinned model.
 */
function RecRoleLine({ rec, onJump }: { rec: RoleRec; onJump: (cardId: string) => void }) {
  const caption = divergenceCaptionText(rec);
  const showDefaultChip = rec.nextReady === undefined || rec.nextReady === true;

  return (
    <div className="flex flex-col gap-1 border-b border-border pb-2 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-2xs text-fg">{roleLineText(rec)}</span>
        {showDefaultChip && <Pill tone="accent">{CATALOG_DEFAULT_CHIP_LABEL}</Pill>}
      </div>
      {rec.nextReady === false ? (
        <p className="text-2xs text-faint">{NEXT_DOWNLOAD_UNAVAILABLE_TEXT}</p>
      ) : (
        <span className="text-2xs text-muted">{rec.vramLine}</span>
      )}
      {caption && <span className="text-2xs text-faint">{caption}</span>}
      <button
        type="button"
        aria-label={`Set up → ${RECS_ROLE_LABEL[rec.role]} card`}
        onClick={() => (rec.role === 'fim' ? jumpToCard(rec.cardId) : onJump(rec.cardId))}
        className="self-start font-mono text-2xs text-accent hover:underline"
      >
        Set up →
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card 1 — Agent
 * ------------------------------------------------------------------ */

function AgentCard({
  setup,
  progress,
  dispatch,
  disabledReason,
  jump,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  jump?: JumpSignal;
}) {
  const agent = setup.agent;
  const action = agentPrimaryAction(agent.phase);
  const live = progress[progressKey('install', agent.selectedId)];
  const logTail = live && live.logTail.length > 0 ? live.logTail : (agent.logTail ?? []);
  const selectedOption = agent.options.find((o) => o.id === agent.selectedId);
  const phaseTone: Tone =
    agent.phase === 'ready' ? 'add' : agent.phase === 'error' ? 'del' : agent.phase === 'installing' ? 'accent' : 'neutral';
  const phaseIcon =
    agent.phase === 'ready'
      ? 'pass-filled'
      : agent.phase === 'error'
        ? 'error'
        : agent.phase === 'installing'
          ? 'sync'
          : 'circle-outline';

  const runAction = (): Promise<unknown> => {
    switch (action.kind) {
      case 'install':
      case 'retry':
        return dispatch('setup.install', { backendId: agent.selectedId });
      case 'activate':
        return dispatch('setup.applyAgent', { backendId: agent.selectedId });
      // T11 (host-gap 1): `awaiting-reload`'s persistent [Reload window]
      // dispatches the NEW `setup.reload` seam — a real host action now,
      // not the old `setup.recheck` dead-end that never actually reloaded
      // anything.
      case 'reload':
        return dispatch('setup.reload');
      case 'recheck':
        return dispatch('setup.recheck');
      case 'none':
      case 'installing':
        return Promise.resolve();
    }
  };

  // §8: `setup.recheck` (and `setup.cancel`, below) are READ-ONLY —
  // `SetupController`'s `MUTATING_METHODS` set deliberately excludes them so
  // the status page "stays honest" in Restricted Mode. `install`/`retry`/
  // `activate`/`reload` all write settings, spawn installers, or reload the
  // window, so those are trust-gated (FM-14) — `setup.reload` is MUTATING at
  // the controller too (T11), so its button must match.
  const actionDisabledReason =
    action.kind === 'install' || action.kind === 'retry' || action.kind === 'activate' || action.kind === 'reload'
      ? disabledReason
      : undefined;

  return (
    <Card title="Agent" id="setup-card-agent">
      <div className="mb-2 flex flex-col gap-1.5">
        {agent.options.map((o) => (
          <BackendOptionRow key={o.id} option={o} selected={o.id === agent.selectedId} />
        ))}
      </div>

      <StatusLine icon={phaseIcon} text={agentPhaseLabel(agent.phase)} tone={phaseTone} />
      <DoneLine text={agentDoneLine(agent.phase)} />
      {agent.version && <div className="mt-0.5 font-mono text-2xs text-faint">{agent.version}</div>}

      {agent.phase === 'pipx-missing' && (
        // T11 (host-gap 2), T10 (§1.2/§6): the dead-end "then retry" is
        // replaced with the two real actions §6 asks for — a pre-typed
        // bootstrap terminal (the user provides sudo) and a Re-check once
        // it's done. The command itself is HOST-composed for the detected
        // distro (`agent.bootstrap.command`) — the webview only ever
        // renders it, never guesses one (Global Constraint 1). An
        // unrecognized distro carries no `command`: honest guidance + a
        // docs link takes its place, Re-check still works — never a
        // dead-end. `agentPrimaryAction` returns `'none'` for this phase
        // specifically so the generic single-action slot below doesn't
        // ALSO render.
        <div className="mt-1 flex flex-col gap-1.5">
          {agent.bootstrap?.guidance && <p className="text-2xs text-muted">{agent.bootstrap.guidance}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {agent.bootstrap?.command ? (
              <ActionButton
                label={`Open terminal: ${agent.bootstrap.command}`}
                onRun={() => dispatch('setup.openBootstrapTerminal')}
                disabledReason={disabledReason}
              />
            ) : (
              <a href={PIPX_INSTALL_DOCS_URL} className="text-2xs text-accent underline" target="_blank" rel="noreferrer">
                pipx install docs
              </a>
            )}
            <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck')} />
          </div>
        </div>
      )}
      {agent.phase === 'python-unsuitable' && (
        // T10 (§1.2/§6): the engine's `pythonInstall` plan drives TWO
        // branches, Re-check in BOTH — never a dead-end. `kind === 'command'`
        // — an in-range Python exists in the distro's own archive — gets a
        // pre-typed terminal button (host-composed, never guessed) beside
        // the honest `agent.detail` explanation. Every other case
        // (`'guidance'`, or no plan at all) shows the §6 guidance text +
        // docs link instead — no terminal button, because there is no
        // verified command to offer.
        <div className="mt-1 flex flex-col gap-1.5">
          {agent.pythonInstall?.kind === 'command' ? (
            <>
              {agent.detail && <p className="text-2xs text-muted">{agent.detail}</p>}
              <ActionButton
                label={`Open terminal: ${agent.pythonInstall.command}`}
                onRun={() => dispatch('setup.openBootstrapTerminal', { target: 'python' })}
                disabledReason={disabledReason}
              />
            </>
          ) : (
            <>
              <p className="text-2xs text-muted">{agent.pythonInstall?.text ?? agent.detail ?? ''}</p>
              <a
                href={agent.pythonInstall?.docsUrl ?? selectedOption?.docsUrl ?? PYTHON_VERSION_HELP_URL}
                className="text-2xs text-accent underline"
                target="_blank"
                rel="noreferrer"
              >
                Python version help
              </a>
            </>
          )}
          <div>
            <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck')} />
          </div>
        </div>
      )}
      {agent.phase === 'awaiting-reload' && (
        <p className="mt-1 text-2xs text-muted">Hermes installed — reload the window to activate it.</p>
      )}
      {agent.phase === 'error' && agent.detail && (
        <div className="mt-1 flex flex-col gap-1.5 rounded border border-del bg-del-soft px-2 py-1.5 text-2xs text-fg">
          <span>{agent.detail}</span>
          {/* T11 (§6-parity minor): copies the SAME text this box shows
              (detail + the accumulated log tail) — a bug report is one
              paste instead of hand-copying a scrolling <pre>. */}
          <div>
            <ActionButton
              label="Copy log"
              icon="copy"
              onRun={() => navigator.clipboard.writeText(buildCopyLogText(agent.detail, logTail))}
            />
          </div>
        </div>
      )}

      {agent.phase === 'installing' ? (
        <div className="mt-2 flex flex-col gap-1.5" aria-live="polite">
          {/* The phase label above already says "Installing…" — only add a
              SECOND line when there is genuinely more to say (the live
              sub-phase from a `setup.progress` push), never a duplicate of
              the same text. */}
          {live?.phase && <StatusLine icon="sync" text={`(${live.phase})`} tone="accent" />}
          {/* `setup.cancel` is read-only/best-effort (§8) — never trust-gated. */}
          <ActionButton
            label="Cancel"
            onRun={() => dispatch('setup.cancel', { op: 'install', id: agent.selectedId })}
          />
        </div>
      ) : (
        action.kind !== 'none' && (
          <div className="mt-2">
            <ActionButton label={action.label} onRun={runAction} disabledReason={actionDisabledReason} tone="accent" />
          </div>
        )
      )}

      {logTail.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-2xs text-muted">Install log ({logTail.length} lines)</summary>
          <pre className="mt-1 max-h-40 overflow-y-auto rounded border border-border bg-overlay p-1.5 font-mono text-2xs text-faint">
            {logTail.join('\n')}
          </pre>
        </details>
      )}

      <AgentLocalModelSection
        setup={setup}
        progress={progress}
        dispatch={dispatch}
        disabledReason={disabledReason}
        jump={jump}
      />
    </Card>
  );
}

/**
 * beta.6 T12 (§3.1): the Agent card's local-agent-model collapsible section
 * ({@link AGENT_BLOCK_HEADING}) — the shared `LocalModelBlock` with the 6 agent
 * catalog rows as a PICKER (`selectedId`/`onSelect`), a 3-pane backend
 * switch, the CC-6 endpoint field, Save → `setup.saveAgentModel` (Tier-1
 * modal host-side), and the CC-10 saved summary + [Change model]/[Clear].
 *
 * Renders in EVERY `agent.phase` (CC-7 — model prep is Hermes-independent;
 * the §6 pre-ready note explains the provider step comes after the install).
 * The guidance line is the HOST-composed `providerGuidance` (variant picked
 * by `provider.phase` in `composeAgentGuidance`, `SetupController.ts`) — the
 * webview renders it verbatim and never re-derives the variant. Honesty pin
 * (§3.1): nothing here ever claims the AGENT is USING the model — the
 * Provider card's ACP-derived phase stays the only truth about that.
 */
function AgentLocalModelSection({
  setup,
  progress,
  dispatch,
  disabledReason,
  jump,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  jump?: JumpSignal;
}) {
  const local = setup.agentLocalModel;
  const saved = local?.saved;
  const agentModels = (setup.catalog?.models ?? []).filter((m) => m.role === 'agent');
  const savedRow = saved === undefined ? undefined : agentModels.find((m) => m.id === saved.modelId);

  // Collapsible via a REAL toggle + conditional render (the NEXT card's
  // edit-button pattern), NOT a native <details>: closed content must be
  // genuinely absent — a closed <details>' children stay in the DOM, where
  // their Re-check/backend-tab buttons would pollute the card's other
  // queries (and cost renders) while contributing nothing.
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  // beta.7 B2: the recs strip's "Set up →" jump expands this section and
  // focuses this toggle — see `useExpandOnJump`.
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  useExpandOnJump(jump, 'setup-card-agent', open, () => setOpen(true), toggleRef);

  // A-F8 — THE ONE preselect rule (`catalogPreselectId`): `saved.modelId`
  // when a save exists, else the `defaultForRole` row. Reconciled while
  // rendering whenever the SAVED id itself moves (a Save landing, a Clear,
  // an external settings edit) — the `settingsField.ts` adjust-while-
  // rendering pattern — so a fresh picker, [Change model]'s prefill, and a
  // post-Clear reset all share exactly this rule; an in-flight user pick
  // survives unrelated re-renders (the key doesn't move).
  const [sel, setSel] = useState(() => ({
    lastSavedId: saved?.modelId,
    id: catalogPreselectId(agentModels, saved?.modelId),
  }));
  // The second clause re-runs the rule if the catalog arrived AFTER mount
  // (an old-host wire without `catalog` gaining it on a later push) — it can
  // fire at most once, because with a non-empty row set `catalogPreselectId`
  // always names a row.
  if (sel.lastSavedId !== saved?.modelId || (sel.id === undefined && agentModels.length > 0)) {
    setSel({ lastSavedId: saved?.modelId, id: catalogPreselectId(agentModels, saved?.modelId) });
  }

  const [backend, setBackend] = useState<AgentModelBackend>(() => agentInitialBackend(local));

  // CC-6: endpoint init = the saved endpoint (for ITS backend) else the
  // host-owned default — reset when the backend tab moves or that init value
  // itself changes (a save landing / external edit), never on an unrelated
  // re-render (an in-flight edit survives).
  const endpointInit = agentEndpointInit(local, backend);
  const endpointKey = `${backend}|${endpointInit}`;
  const [ep, setEp] = useState(() => ({ key: endpointKey, value: endpointInit }));
  if (ep.key !== endpointKey) setEp({ key: endpointKey, value: endpointInit });

  const pickerOpen = saved === undefined || changing;

  // [Change model] toggles the picker (the NEXT card's edit-button pattern —
  // closing it again is the escape route). Re-opening prefills by the SAME
  // A-F8 rule, discarding any pick left over from a previous open.
  const toggleChange = () => {
    const next = !changing;
    if (next) setSel({ lastSavedId: saved?.modelId, id: catalogPreselectId(agentModels, saved?.modelId) });
    setChanging(next);
  };

  const runSave = async (): Promise<unknown> => {
    const result = await dispatch('setup.saveAgentModel', { modelId: sel.id, backend, endpoint: ep.value });
    // DECLINED (the user dismissed the host's Tier-1 modal) keeps the picker
    // open — neither success nor failure (the C-2 lock, same as ActionButton).
    if (result !== DECLINED) setChanging(false);
    return result;
  };

  return (
    <div className="mt-3 border-t border-border pt-2">
      <button
        type="button"
        ref={toggleRef}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {AGENT_BLOCK_HEADING}
      </button>
      {open && (
      <div className="mt-2 flex flex-col gap-2">
        {setup.agent.phase !== 'ready' && <p className="text-2xs text-muted">{AGENT_PRE_READY_NOTE}</p>}

        {saved !== undefined && (
          <div className="flex flex-col gap-1.5">
            <StatusLine
              icon="pass-filled"
              text={agentSavedSummaryLine(savedRow?.displayName ?? saved.modelId, BACKEND_DISPLAY[saved.backend], saved.endpoint)}
              tone="add"
            />
            {saved.runCommand && (
              <RunCommandLine command={saved.runCommand} label={saved.backend === 'llamacpp' ? 'Start the server:' : undefined} />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-expanded={changing}
                onClick={toggleChange}
                className="rounded border border-border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
              >
                Change model
              </button>
              <ActionButton
                label="Clear"
                onRun={() => dispatch('setup.saveAgentModel', { clear: true })}
                disabledReason={disabledReason}
              />
            </div>
          </div>
        )}

        {pickerOpen && (
          <div className="flex flex-col gap-2">
            <div className="inline-flex gap-1 self-start rounded border border-border p-0.5">
              {(['ollama', 'llamacpp', 'vllm'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  aria-pressed={backend === b}
                  onClick={() => setBackend(b)}
                  className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-wide ${
                    backend === b ? 'bg-accent-soft text-accent' : 'text-faint hover:text-muted'
                  }`}
                >
                  {BACKEND_DISPLAY[b]}
                </button>
              ))}
            </div>

            <TextField
              label="Endpoint"
              value={ep.value}
              onChange={(v) => setEp({ key: ep.key, value: v })}
              placeholder="http://host:port"
            />

            <LocalModelBlock
              backend={backend}
              models={agentModels}
              ollama={setup.ollama}
              llamacppRuntime={setup.llamacppRuntime}
              endpoint={ep.value}
              progress={progress}
              dispatch={dispatch}
              disabledReason={disabledReason}
              selectedId={sel.id}
              onSelect={(id) => setSel({ lastSavedId: sel.lastSavedId, id })}
              rowCaption={(m) => agentRowCaption(m, backend)}
              runCommandCaption={backend === 'llamacpp' ? AGENT_PRESAVE_RUN_COMMAND_CAPTION : undefined}
            />

            {/* The Ollama pane has no in-block Test (§4.1) — same surface-level
                Test + Serving line the FIM ollama pane carries (T10 Minor #4). */}
            {backend === 'ollama' && <TestAndServingLine backend="ollama" endpoint={ep.value} dispatch={dispatch} />}

            {sel.id !== undefined && (
              <div>
                <ActionButton
                  label="Save"
                  onRun={runSave}
                  disabledReason={disabledReason}
                  tone="accent"
                  successLabel="✓ Saved"
                />
              </div>
            )}
          </div>
        )}

        <DoneLine text={local?.providerGuidance ?? ''} className="mt-0" />
      </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card 2 — Provider
 * ------------------------------------------------------------------ */

function ProviderCard({
  setup,
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const provider = setup.provider;
  const text =
    provider.phase === 'waiting-agent'
      ? 'Waiting for the agent…'
      : provider.phase === 'unconfigured'
        ? 'Chat provider not configured'
        : provider.phase === 'configured'
          ? `Configured: ${provider.providerId ?? 'provider'}`
          : 'Unknown';
  const tone: Tone = provider.phase === 'configured' ? 'add' : provider.phase === 'unconfigured' ? 'warn' : 'neutral';
  const icon = provider.phase === 'configured' ? 'pass-filled' : provider.phase === 'unconfigured' ? 'warning' : 'circle-outline';

  return (
    <Card title="Provider">
      <StatusLine icon={icon} text={text} tone={tone} />
      <DoneLine text={providerDoneLine(provider.phase)} />
      {provider.phase === 'unconfigured' && (
        <div className="mt-2">
          <ActionButton
            label="Configure provider"
            onRun={() => dispatch('setup.openProviderWizard')}
            disabledReason={disabledReason}
            tone="accent"
          />
        </div>
      )}
      {provider.phase !== 'waiting-agent' && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-2xs text-faint">{PROVIDER_RECHECK_CAPTION}</p>
          <div>
            <ActionButton
              label="Re-check provider"
              icon="refresh"
              successLabel="Reconnected"
              onRun={() => dispatch('setup.reconnectAgent')}
              disabledReason={disabledReason}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Card 3 — Autocomplete (FIM)
 * ------------------------------------------------------------------ */

function FimCard({
  setup,
  progress,
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const fim = setup.fim;
  // A6 (beta.6 panel-fix PT4): the picker highlight is reconciled against
  // the WIRE's saved `selectedId` with the same keyed adjust-while-rendering
  // idiom as the endpoint fields — an external settings edit re-highlights
  // the picker; an in-flight local browse survives unrelated re-renders.
  const [sel, setSel] = useState(() => ({ wireId: fim.selectedId, id: fim.selectedId }));
  if (sel.wireId !== fim.selectedId) setSel({ wireId: fim.selectedId, id: fim.selectedId });
  const selectedId = sel.id;
  const [mode, setMode] = useState<'connect' | 'install'>('connect');
  const option = fim.options.find((o) => o.id === selectedId) ?? fim.options[0];

  // §3.2 (PT4): the card's ONE pending-model draft, shared by the Connect
  // tab's Model field and the Install tab's row selection/pulls. Keyed
  // `${selectedId}|${saved}` — a backend switch resets the draft to saved,
  // an Apply landing / external edit reconciles, an in-flight edit survives
  // unrelated re-renders (the PT3 pure pair, `setupCards.ts`).
  const pendingKey = `${selectedId}|${fim.model}`;
  const [pendingState, setPendingState] = useState(() => initPendingModel(pendingKey, fim.model));
  const pending = reconcilePendingModel(pendingState, pendingKey, fim.model);
  if (pending !== pendingState) setPendingState(pending);
  const pendingModel = pending.value;
  const setPendingModel = (value: string) => setPendingState({ key: pendingKey, value });
  // C1-6 snapshot/no-clobber: a pull's success only adopts the pulled target
  // if the draft is UNCHANGED since the pull was clicked (`snapshot` = the
  // click-render's value) — a free-text edit typed during a multi-GB pull is
  // never silently overwritten.
  const adoptPulledModel = (snapshot: string, target: string) =>
    setPendingState((prev) => (prev.value === snapshot ? { key: prev.key, value: target } : prev));

  // Audit A4: the done line's presence is computed against the WIRE's SAVED
  // backend + endpoint (never the Connect tab's live field) — only an
  // ollama-configured card consults it; `fimDoneLine` ignores it otherwise.
  const wireOption = fim.options.find((o) => o.id === fim.selectedId);
  const donePresence: NextPresence =
    fim.selectedId === 'ollama'
      ? catalogPresence(setup.ollama, wireOption?.remote?.endpointValue || wireOption?.remote?.endpointDefault || '', {
          ollamaTag: fim.model,
        })
      : 'unknown';

  if (!option) {
    return (
      <Card title="Autocomplete (FIM)" id="setup-card-fim">
        <p className="text-2xs text-faint">No autocomplete backends available.</p>
      </Card>
    );
  }

  const hasLocal = fimHasLocalInstall(option);
  const showInstallTab = hasLocal && mode === 'install';

  return (
    <Card title="Autocomplete (FIM)" id="setup-card-fim">
      <DoneLine text={fimDoneLine(fim, donePresence)} className="mb-2" />
      <div className="mb-2 flex flex-col gap-1.5">
        {fim.options.map((o) => (
          <BackendOptionRow
            key={o.id}
            option={o}
            selected={o.id === option.id}
            onSelect={(id) => {
              setSel({ wireId: fim.selectedId, id });
              setMode('connect');
            }}
          />
        ))}
      </div>

      {hasLocal && (
        <>
          <p className="mb-1.5 text-2xs text-muted">Install locally, or connect to an existing endpoint?</p>
          <div className="mb-2 inline-flex gap-1 rounded border border-border p-0.5">
            <button
              type="button"
              aria-pressed={mode === 'connect'}
              onClick={() => setMode('connect')}
              className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-wide ${
                mode === 'connect' ? 'bg-accent-soft text-accent' : 'text-faint hover:text-muted'
              }`}
            >
              Connect
            </button>
            <button
              type="button"
              aria-pressed={mode === 'install'}
              onClick={() => setMode('install')}
              className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-wide ${
                mode === 'install' ? 'bg-accent-soft text-accent' : 'text-faint hover:text-muted'
              }`}
            >
              Install locally
            </button>
          </div>
        </>
      )}

      {showInstallTab ? (
        <FimInstallTab
          key={option.id}
          option={option}
          setup={setup}
          progress={progress}
          dispatch={dispatch}
          disabledReason={disabledReason}
          pendingModel={pendingModel}
          onSelectModel={setPendingModel}
          onPullSuccessModel={adoptPulledModel}
        />
      ) : (
        <FimConnectTab
          key={option.id}
          option={option}
          dispatch={dispatch}
          disabledReason={disabledReason}
          pendingModel={pendingModel}
          savedModel={fim.model}
          savedId={fim.selectedId}
          onPendingModel={setPendingModel}
        />
      )}
    </Card>
  );
}

/** The FIM Model field's caption id — `aria-describedby` plumbing (C1-15). */
const FIM_MODEL_CAPTION_ID = 'fim-model-field-caption';

function FimConnectTab({
  option,
  dispatch,
  disabledReason,
  pendingModel,
  savedModel,
  savedId,
  onPendingModel,
}: {
  option: SetupBackendOption;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  /** The card-owned pending draft (§3.2 PT4) — survives tab switches. */
  pendingModel: string;
  /** The wire's SAVED `fim.model` — the field's placeholder + diff baseline. */
  savedModel: string;
  /**
   * The wire's SAVED `fim.selectedId` (L3-I-1, beta.6 fix-wave T5) — scopes
   * the shared `talaria.autocomplete.endpoint` value to the backend it was
   * actually saved for. Deliberately named `savedId`, NOT `selectedId`:
   * `FimCard`'s own local `selectedId` (`sel.id`) is the BROWSE highlight, a
   * different value — overloading the name here would invite passing the
   * wrong one (critic B7).
   */
  savedId: string;
  onPendingModel: (next: string) => void;
}) {
  // R-2/L3-I-1 (§2.6, §2 L3-I-1): `talaria.autocomplete.endpoint` is ONE
  // setting shared by every FIM backend — every option's `remote.endpointValue`
  // echoes that SAME saved string on the wire regardless of which backend it
  // represents. `fimInstallTestEndpoint` (already the Install tab's scoping,
  // `setupCards.ts`) is trustworthy only for the backend it was actually
  // saved for; browsing a DIFFERENT backend's Connect tab must fall back to
  // THAT option's own default rather than pre-filling (and later showing/
  // testing/saving) a foreign, possibly-nonsensical address.
  const [endpoint, setEndpoint] = useState(() => fimInstallTestEndpoint(savedId, option));
  const needsKey = option.remote?.auth === 'apiKey-optional' || option.remote?.auth === 'apiKey-required';
  const modelFieldVisible = fimModelFieldVisible(option.id);
  const trimmed = pendingModel.trim();
  // "not saved yet" gates on a NON-EMPTY differing draft: an empty field
  // never rides an Apply (visible-value-only rule below), so captioning it
  // as pending would promise a save that can't happen. GATE-M1: `:latest`-
  // tolerant via `ollamaTagsEqual` — parity with the Install tab's pending
  // line so a `:latest`-only edit never shows a spurious "not saved yet".
  const draftDiffers = trimmed !== '' && !ollamaTagsEqual(trimmed, savedModel);

  return (
    <div className="flex flex-col gap-2">
      <TextField label="Endpoint" value={endpoint} onChange={setEndpoint} placeholder={option.remote?.endpointPlaceholder} />

      {modelFieldVisible ? (
        <div className="flex flex-col gap-1">
          <TextField
            label={FIM_MODEL_FIELD_LABEL}
            value={pendingModel}
            onChange={onPendingModel}
            placeholder={savedModel || undefined}
            describedBy={FIM_MODEL_CAPTION_ID}
          />
          <div className="flex flex-wrap items-baseline gap-2">
            <p id={FIM_MODEL_CAPTION_ID} className="text-2xs text-faint">
              {FIM_MODEL_FIELD_CAPTION}
            </p>
            {/* PT4-M1: an always-mounted LiveRegion (text swaps, never
             *  conditionally mounted — Finding-7/MDN), mirroring the Install
             *  tab's `pendingLine` (`:1399`) so SR users get the same
             *  announcement Connect's sibling tab already gives them. */}
            <LiveRegion text={draftDiffers ? FIM_PENDING_CAPTION : ''} className="text-2xs text-warn" />
          </div>
        </div>
      ) : (
        // llamacpp: `/infill` sends no model name — a field here would be a
        // fake affordance; the honest note renders INSTEAD (§8).
        <p className="text-2xs text-muted">{FIM_LLAMACPP_MODEL_NOTE}</p>
      )}

      {needsKey && (
        <div className="flex flex-wrap items-center gap-2 text-2xs">
          {option.remote?.apiKeySet ? (
            <span className="text-add">key set ✓</span>
          ) : (
            <span className="text-muted">
              {option.remote?.auth === 'apiKey-required' ? 'API key required' : 'No API key set'}
            </span>
          )}
          <ActionButton
            label={option.remote?.apiKeySet ? 'Change key' : 'Set API key…'}
            onRun={() => dispatch('setup.setApiKey')}
            disabledReason={disabledReason}
            successLabel="✓ Key stored"
          />
          {option.remote?.apiKeySet && (
            <ActionButton
              label="Clear key"
              onRun={() => dispatch('setup.setApiKey', { clear: true })}
              disabledReason={disabledReason}
            />
          )}
        </div>
      )}

      <div className="flex gap-2">
        <ActionButton
          label={testConnectionLabel(endpoint)}
          onRun={() => dispatch('setup.testRemote', { backendId: option.id, endpoint })}
          successLabel="✓ Endpoint reachable"
        />
        <ActionButton
          label="Apply"
          // C1-1 visible-value-only: `model` rides the params ONLY while the
          // Model field is actually rendered for this backend AND non-empty —
          // the llamacpp tab never carries one, even with a draft alive.
          onRun={() =>
            dispatch('setup.applyFim', {
              backendId: option.id,
              endpoint,
              ...(modelFieldVisible && trimmed !== '' ? { model: trimmed } : {}),
            })
          }
          disabledReason={disabledReason}
          tone="accent"
          successLabel="✓ Applied"
        />
      </div>
    </div>
  );
}

/**
 * beta.6 T11 (§3.2): the Install tab IS the shared `LocalModelBlock` — one
 * pane per local-capable backend. The card's OWN 5-option picker above is the
 * block's ① (ONE picker — this tab never renders a second one); catalog rows
 * are role-filtered to `'fim'` from the wire's `catalog.models`. The beta.5
 * models list under `localInstall` is deliberately NOT consumed anymore
 * (deprecated-in-comment at `registry.ts`, kept on the wire for compat) —
 * only the CC-8 configured-model row still speaks the legacy free-text
 * `setup.pullModel` tier. Pulls never write settings: "done" stays presence +
 * Connect-tab state (§4.2), so switching panes changes nothing but the view.
 */
function FimInstallTab({
  option,
  setup,
  progress,
  dispatch,
  disabledReason,
  pendingModel,
  onSelectModel,
  onPullSuccessModel,
}: {
  option: SetupBackendOption;
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  /** §3.2 PT4 — the card-owned pending draft, consumed by the Ollama pane
   *  only (llamacpp/vLLM panes carry no model-name selection). */
  pendingModel: string;
  onSelectModel: (target: string) => void;
  onPullSuccessModel: (snapshot: string, target: string) => void;
}) {
  // R-2 (§2.6): a browsed-but-not-configured backend tests its OWN default,
  // never the active backend's saved endpoint under this backend's label.
  const endpoint = fimInstallTestEndpoint(setup.fim.selectedId, option);
  const fimModels = (setup.catalog?.models ?? []).filter((m) => m.role === 'fim');

  if (option.id === 'ollama') {
    return (
      <OllamaInstallPanel
        setup={setup}
        models={fimModels}
        endpoint={endpoint}
        progress={progress}
        dispatch={dispatch}
        disabledReason={disabledReason}
        pendingModel={pendingModel}
        onSelectModel={onSelectModel}
        onPullSuccessModel={onPullSuccessModel}
      />
    );
  }
  if (option.id === 'llamacpp') {
    return (
      <FimLlamacppPane
        setup={setup}
        models={fimModels}
        endpoint={endpoint}
        progress={progress}
        dispatch={dispatch}
        disabledReason={disabledReason}
      />
    );
  }
  if (option.id === 'vllm') {
    return <FimVllmPane option={option} setup={setup} models={fimModels} endpoint={endpoint} progress={progress} dispatch={dispatch} />;
  }
  // A14 (queued #6): the pane switch is explicit and total — an unknown/
  // unexpected `option.id` with `localInstall` set (a future backend, or a
  // caller bug) renders NO pane, instead of silently falling through to
  // vLLM's copy.
  return null;
}

/**
 * FIM × Ollama pane (§3.2). The block owns BOTH daemon branches: not-running
 * keeps the beta.5 affordances (install terminal + Re-check, rows visible
 * with Pull disabled-with-reason), and the RUNNING branch now has Re-check
 * too — the §0.3 fix (beta.5's running branch was rows-only, leaving no way
 * to re-probe a daemon stopped after the panel loaded). Below the block sits
 * the surface-level [Test connection] the rows' "not verified here — Test
 * the endpoint first." copy points at (T10 Minor #4 — the Ollama pane has no
 * in-block Test).
 */
function OllamaInstallPanel({
  setup,
  models,
  endpoint,
  progress,
  dispatch,
  disabledReason,
  pendingModel,
  onSelectModel,
  onPullSuccessModel,
}: {
  setup: SetupData;
  models: readonly SetupCatalogModel[];
  endpoint: string;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  /** §3.2 PT4 — the card-owned pending draft; row highlight is DERIVED from
   *  it ({@link catalogRowIdForModel}), never a second selection state. */
  pendingModel: string;
  /** Row click → the row's install target becomes the draft. */
  onSelectModel: (target: string) => void;
  /** Pull success → `(snapshot, target)`; the card applies the C1-6
   *  no-clobber rule (`snapshot` = this render's `pendingModel`, i.e. the
   *  value at pull-CLICK — the in-flight closure pins it). */
  onPullSuccessModel: (snapshot: string, target: string) => void;
}) {
  const saved = setup.fim.model;
  // CC-8 (§3.2): a running-branch affordance — the legacy tier needs a live
  // daemon to pull onto; the not-running branch's job is installing Ollama.
  const showConfiguredRow = setup.ollama.running && configuredModelOutsideCatalog(models, saved);
  // §8: typing free text simply un-highlights every row (no guessed match).
  const rowSelectedId = catalogRowIdForModel(models, pendingModel);
  // The pending line announces a picked-but-unsaved model (`:latest`-tolerant
  // against saved); LiveRegion stays ALWAYS mounted — only `text` swaps.
  const pendingLine =
    pendingModel.trim() !== '' && !ollamaTagsEqual(pendingModel, saved) ? pendingSelectionLine('fim', pendingModel) : '';

  return (
    <div className="flex flex-col gap-2">
      {showConfiguredRow && (
        <ConfiguredModelRow
          model={saved}
          ollama={setup.ollama}
          endpoint={endpoint}
          progress={progress}
          dispatch={dispatch}
          disabledReason={disabledReason}
          pullSuccessLabel={FIM_OLLAMA_PULL_NUDGE}
          onPullSuccess={() => onPullSuccessModel(pendingModel, saved)}
        />
      )}
      <LocalModelBlock
        backend="ollama"
        models={models}
        ollama={setup.ollama}
        llamacppRuntime={setup.llamacppRuntime}
        endpoint={endpoint}
        progress={progress}
        dispatch={dispatch}
        disabledReason={disabledReason}
        selectedId={rowSelectedId}
        onSelect={(id) => {
          const row = models.find((m) => m.id === id);
          const target = row?.ollamaCreatedName ?? row?.ollamaTag; // the catalogOllamaTarget rule
          if (target !== undefined) onSelectModel(target);
        }}
        ollamaPullSuccessLabel={FIM_OLLAMA_PULL_NUDGE}
        onOllamaPullSuccess={(model) => {
          const target = model.ollamaCreatedName ?? model.ollamaTag;
          if (target !== undefined) onPullSuccessModel(pendingModel, target);
        }}
      />
      <LiveRegion text={pendingLine} className="text-2xs text-muted" />
      <div>
        <ActionButton
          label={testConnectionLabel(endpoint)}
          icon="plug"
          onRun={() => dispatch('setup.testRemote', { backendId: 'ollama', endpoint })}
          successLabel="✓ Endpoint reachable"
        />
      </div>
    </div>
  );
}

/**
 * The CC-8 "configured model" row (§3.2 FIM / §3.4 RAG — T14 generalized
 * T11's FIM-only component with a surface-supplied `pullSuccessLabel`, no
 * behavior change at the FIM call site) — the legacy free-text tier's one
 * surviving in-panel affordance, rendered ABOVE the catalog rows whenever
 * the surface's saved model setting names something outside the catalog.
 * Wired to the UNCHANGED `setup.pullModel` method; its progress/cancel stay
 * TAG-keyed (`pull:<model>` — the host's legacy `handlePullModel` latch),
 * unlike the catalog rows' `pull:<catalogId>`.
 */
function ConfiguredModelRow({
  model,
  ollama,
  endpoint,
  progress,
  dispatch,
  disabledReason,
  pullSuccessLabel,
  onPullSuccess,
}: {
  model: string;
  ollama: SetupData['ollama'];
  endpoint: string;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  pullSuccessLabel: string;
  /** beta.6 panel-fix PT4 (C1-2): fires exactly when the pull dispatch
   *  resolves with a result ≠ DECLINED (the success-flash condition) —
   *  never on rejection, never on DECLINED. Mirrors the block's PT6
   *  `onOllamaPullSuccess`. Omitted ⇒ byte-identical behavior. */
  onPullSuccess?: () => void;
}) {
  // The same endpoint-scoped client-side derivation catalog rows use (C-6) —
  // the free-text model is just a bare library tag, so `ollamaTag` fits.
  const presence = catalogPresence(ollama, endpoint, { ollamaTag: model });
  const present = presence === 'present';
  const live = progress[progressKey('pull', model)];
  const percent = pullPercent(live?.totalBytes, live?.completedBytes);
  const inFlight = live !== undefined && !present;

  return (
    <div className="flex flex-col gap-1 rounded border border-border bg-overlay px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{model}</span>
        <Pill tone="neutral">Configured</Pill>
      </div>
      <StatusLine
        icon={present ? 'pass-filled' : 'circle-outline'}
        text={catalogPresenceText(presence)}
        tone={present ? 'add' : 'neutral'}
      />
      {!present && (
        <div>
          <ActionButton
            label={`Pull ${model}`}
            icon="cloud-download"
            onRun={
              onPullSuccess
                ? () =>
                    dispatch('setup.pullModel', { model, endpoint }).then((result) => {
                      if (result !== DECLINED) onPullSuccess();
                      return result;
                    })
                : () => dispatch('setup.pullModel', { model, endpoint })
            }
            disabledReason={disabledReason}
            successLabel={pullSuccessLabel}
          />
        </div>
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
                aria-label={`Pulling ${model}`}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"
              >
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
              <span className="font-mono text-2xs text-faint">{percent}%</span>
            </div>
          )}
          <div>
            <ActionButton label={CANCEL_LABEL} icon="close" onRun={() => dispatch('setup.cancel', cancelPullParams(model))} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * FIM × llama.cpp pane (§3.2): the block renders the `llamacppRuntime` §4.1
 * status (incl. the CC-4 install projection), the three FIM rows' verified
 * ggml-org base-Q8 downloads (rev 3 — no absence cells on this surface; the
 * base-build note rides each row's wire `note`), and Test. The §6 nudge
 * renders once any row is actually present — it explains the next step
 * (Connect-tab Apply), which doesn't exist before a download lands.
 */
function FimLlamacppPane({
  setup,
  models,
  endpoint,
  progress,
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  models: readonly SetupCatalogModel[];
  endpoint: string;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const anyPresent = models.some((m) => m.llamacpp?.present === true);
  return (
    <div className="flex flex-col gap-2">
      <LocalModelBlock
        backend="llamacpp"
        models={models}
        ollama={setup.ollama}
        llamacppRuntime={setup.llamacppRuntime}
        endpoint={endpoint}
        progress={progress}
        dispatch={dispatch}
        disabledReason={disabledReason}
      />
      {anyPresent && <p className="text-2xs text-muted">{FIM_LLAMACPP_NUDGE}</p>}
    </div>
  );
}

/**
 * FIM × vLLM pane (§3.2): the beta.5 ⑪ copy KEPT VERBATIM (locked string —
 * do not edit) + the docs link + the block's row run-commands and Test.
 * vLLM serves models from its own command line, so there is never a
 * Pull/Download here (§4.1) — the run command IS the row.
 */
function FimVllmPane({
  option,
  setup,
  models,
  endpoint,
  progress,
  dispatch,
}: {
  option: SetupBackendOption;
  setup: SetupData;
  models: readonly SetupCatalogModel[];
  endpoint: string;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
}) {
  return (
    <div className="flex flex-col gap-2 text-2xs text-muted">
      <p>vLLM&apos;s install depends on your GPU/CUDA setup — follow the official guide, then test the connection.</p>
      {option.docsUrl && (
        <a href={option.docsUrl} className="text-accent underline" target="_blank" rel="noreferrer">
          Setup docs
        </a>
      )}
      <LocalModelBlock
        backend="vllm"
        models={models}
        ollama={setup.ollama}
        llamacppRuntime={setup.llamacppRuntime}
        endpoint={endpoint}
        progress={progress}
        dispatch={dispatch}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card 4 — NEXT
 * ------------------------------------------------------------------ */

function NextEditCard({
  setup,
  progress,
  nextEdit,
  onToggleNextEdit,
  dispatch,
  disabledReason,
  jump,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  nextEdit: NextEditToggleState;
  onToggleNextEdit: SetupPanelProps['onToggleNextEdit'];
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  jump?: JumpSignal;
}) {
  const [showForm, setShowForm] = useState(false);
  const next = setup.nextEdit;
  const buttonLabel = nextEditButtonLabel(next.dedicatedConfigured);
  // T15 (§4.3 D4, critic C-14): the CPU/GPU caveat renders at CARD level
  // whenever the dedicated toggle is ON or the form is open — a user could
  // otherwise enable dedicated NEXT without ever seeing it (it used to live
  // only inside the collapsed form).
  const showWarning = next.dedicated !== undefined && (nextEdit.next || showForm);
  // beta.7 B2: the recs strip's "Set up →" jump expands this form and
  // focuses this toggle — see `useExpandOnJump`.
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  useExpandOnJump(jump, 'setup-card-next', showForm, () => setShowForm(true), toggleRef);

  return (
    <Card title="Next Edit (NEXT)" id="setup-card-next">
      <DoneLine text={nextDoneLine(next.source)} className="mb-2" />
      <p className="mb-2 text-2xs text-muted">
        Want NEXT (multi-line next-edit)? Two modes: <strong className="text-fg">Generic</strong> reuses your FIM
        model — no extra setup if autocomplete is configured. <strong className="text-fg">Dedicated</strong> uses a
        separate Sweep model and needs its own setup.
      </p>

      <div className="mb-2 overflow-hidden rounded-card border border-border">
        {NEXT_EDIT_ROWS.map((row) => (
          <NextEditToggleRow
            key={row.source}
            row={row}
            on={nextEdit[row.source]}
            otherOn={nextEdit[row.source === 'next' ? 'generic' : 'next']}
            onToggle={(on) => onToggleNextEdit(row.source, on)}
          />
        ))}
      </div>

      {next.refusalDetail && (
        <div className="mb-2 rounded border border-warn bg-warn-soft px-2 py-1.5 text-2xs text-fg">
          {next.refusalDetail}
        </div>
      )}

      {showWarning && (
        <div
          role="note"
          aria-label="Dedicated NEXT resource warning"
          className="mb-2 flex items-start gap-2 rounded-card border border-warn bg-warn-soft px-3 py-2 text-2xs text-fg"
        >
          <Icon name="warning" size={14} className="mt-0.5 flex-none text-warn" />
          <span>{next.dedicated?.warning}</span>
        </div>
      )}

      <button
        type="button"
        ref={toggleRef}
        aria-expanded={showForm}
        onClick={() => setShowForm((s) => !s)}
        className="rounded border border-border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        {buttonLabel}
      </button>

      {showForm && (
        <DedicatedNextForm setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} />
      )}
    </Card>
  );
}

function NextEditToggleRow({
  row,
  on,
  otherOn,
  onToggle,
}: {
  row: NextEditRowCopy;
  on: boolean;
  otherOn: boolean;
  onToggle: (on: boolean) => Promise<unknown>;
}) {
  const [state, setState] = useState(() => initNextEditRowState(on, otherOn));
  const reconciled = reconcileNextEditRowState(state, on, otherOn);
  if (reconciled !== state) setState(reconciled);
  const { pending, lastError } = reconciled;
  const toggleId = `setup-next-edit-toggle-${row.source}`;

  const commit = (next: boolean) => {
    void commitFieldEdit(setState, next, (v) => onToggle(v === true));
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <label htmlFor={toggleId} className="block cursor-pointer text-xs text-fg">
          {row.label}
        </label>
        <div className="text-2xs text-muted">{row.description}</div>
        <LiveRegion text={lastError ? `Not saved: ${lastError}` : ''} className="text-2xs text-del" title={lastError} />
      </div>
      {/* F-7 parity (SettingsPanel.tsx): this toggle store is host-internal
          extension state, not a settings write — it must remain ACTIONABLE
          regardless of workspace trust, exactly like the equivalent rows in
          the Agent-config panel (never gated here either). */}
      <Toggle id={toggleId} on={reconciled.displayValue === true} label={row.label} busy={pending} onChange={commit} />
    </div>
  );
}

/**
 * T15 (beta.5 §4.3 D1–D4) re-shaped by beta.6 T13 (§3.3): the dedicated NEXT
 * setup form — four candidate panes over ONE pinned model (`sweep-next`, the
 * catalog's only next-role row; there is never a model picker here).
 * Endpoint/Model local state is a `DedicatedFormFieldState` (`setupCards.ts`)
 * reconciled against the picked backend's own defaults on every render via
 * `reconcileDedicatedFormFields` — the `settingsField.ts` "adjust state
 * while rendering" pattern, so switching backends resets the fields to
 * THAT backend's defaults without clobbering an in-flight edit.
 *
 * T13 pane map: Ollama keeps its beta.5 bespoke tri-state (presence via the
 * alias-aware `nextPresence`, fail-closed empty-pin text, Apply nudge) with
 * ONLY the dispatch/key moved to the T7-M2 single entry
 * (`setup.provisionModel`, latched `pull:sweep-next` — the legacy
 * `setup.pullModel` route latches a DIFFERENT tag key, so exposing both for
 * the same artifact would allow a duplicate download); llama.cpp is the NEW
 * block pane (binary status + verified Download + run command, the -hf
 * guided line retired, the SC-3 digest hint retained as the run-command
 * caption); vLLM keeps its guided line + Test unchanged; OpenAI-compatible
 * keeps fields + Test + Apply (CC-8). Restoration (CC-10): the initial pane
 * reads `nextEdit.dedicatedBackendId`, Apply writes it back as the additive
 * `setup.setNextEdit` param.
 */
function DedicatedNextForm({
  setup,
  progress,
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const candidates = setup.fim.options.filter((o) => o.nextEditTransport !== undefined);
  const preferred = candidates.find((o) => o.id === dedicatedInitialCandidateId(setup.nextEdit, candidates));
  const [selectedId, setSelectedId] = useState(preferred?.id ?? '');
  const selected = candidates.find((o) => o.id === selectedId) ?? preferred;
  const dedicated = setup.nextEdit.dedicated;
  // T13 (§3.3): the pinned model's CATALOG row — the id the T7-M2 single
  // entry point + progress/cancel key ride on. Role-filtered from the wire
  // (never a webview literal); absent catalog ⇒ no provisioning affordance
  // at all (fail-closed), the rest of the form still renders.
  const nextModels = setup.catalog?.models.filter((m) => m.role === 'next') ?? [];
  const pinnedRow = nextModels[0];

  const defaults = dedicatedFieldDefaults(setup, selected);
  const [fields, setFields] = useState(() => initDedicatedFormFieldState(selectedId, defaults));
  const reconciled = reconcileDedicatedFormFields(fields, selectedId, defaults);
  if (reconciled !== fields) setFields(reconciled);
  const { endpoint, model } = reconciled;
  const setEndpoint = (v: string) => setFields((f) => ({ ...f, endpoint: v }));
  const setModel = (v: string) => setFields((f) => ({ ...f, model: v }));

  const backendIsOllama = selected?.nextEditTransport === 'ollama';
  const isLlamacppPane = selected?.id === 'llamacpp';
  const presence: NextPresence = backendIsOllama ? nextPresence(setup, endpoint, model) : 'unknown';
  const presenceTone: Tone = presence === 'present' ? 'add' : presence === 'absent' ? 'warn' : 'neutral';
  const presenceIcon = presence === 'present' ? 'pass-filled' : presence === 'absent' ? 'circle-outline' : 'question';
  const showDownload = nextDownloadButtonVisible(dedicated, backendIsOllama, presence) && pinnedRow !== undefined;
  // T13: progress + cancel key = `pull:<catalogId>` (rule 7/CC-9) — the SAME
  // key `handleProvisionModel` latches, replacing beta.5's tag-derived key.
  const livePull = pinnedRow !== undefined ? progress[progressKey('pull', pinnedRow.id)] : undefined;
  const pullPct = pullPercent(livePull?.totalBytes, livePull?.completedBytes);
  const pullInFlight = livePull !== undefined && presence !== 'present';

  // §4.3 point 5, narrowed by T13: ONLY vLLM keeps a read-only guided line
  // (§3.3 — unchanged). The llama.cpp -hf guided line is retired from that
  // pane: the block's verified Download replaced the self-download command,
  // and its digest-hint half survives as the run-command caption below.
  const guidedText = selected?.id === 'vllm' ? dedicated?.guided.vllm : undefined;
  const guided = guidedText !== undefined ? splitGuidedLine(guidedText) : undefined;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border border-border bg-overlay p-2">
      {candidates.length === 0 ? (
        <p className="text-2xs text-faint">No backend supports a dedicated NEXT connection.</p>
      ) : (
        <>
          {dedicated && <p className="text-2xs text-muted">{nextModelLine(dedicated.displayName)}</p>}
          <div className="flex flex-col gap-1.5">
            {candidates.map((o) => (
              <BackendOptionRow key={o.id} option={o} selected={o.id === selectedId} onSelect={setSelectedId} />
            ))}
          </div>
          <TextField label="Endpoint" value={endpoint} onChange={setEndpoint} />
          <TextField label="Model" value={model} onChange={setModel} />

          {backendIsOllama && dedicated && !dedicated.downloadReady && (
            <p className="text-2xs text-faint">{NEXT_DOWNLOAD_UNAVAILABLE_TEXT}</p>
          )}

          {backendIsOllama && dedicated?.downloadReady && (
            <div className="flex flex-col gap-1.5">
              <StatusLine icon={presenceIcon} text={nextPresenceText(presence)} tone={presenceTone} />
              {showDownload && pinnedRow !== undefined && (
                <div>
                  <ActionButton
                    label={NEXT_DOWNLOAD_BUTTON_LABEL}
                    onRun={() => dispatch('setup.provisionModel', { modelId: pinnedRow.id, backend: 'ollama', endpoint })}
                    disabledReason={disabledReason}
                    successLabel={NEXT_POST_DOWNLOAD_NUDGE}
                  />
                </div>
              )}
              {pinnedRow !== undefined && pullInFlight && (
                <div className="flex flex-col gap-1">
                  {pullPct !== undefined && (
                    <div className="flex items-center gap-2" aria-live="polite">
                      <div
                        role="progressbar"
                        aria-valuenow={pullPct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`Pulling ${pinnedRow.id}`}
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"
                      >
                        <div className="h-full bg-accent" style={{ width: `${pullPct}%` }} />
                      </div>
                      <span className="font-mono text-2xs text-faint">{pullPct}%</span>
                    </div>
                  )}
                  {/* CC-9: Cancel on every in-flight row — the RPC row for
                      provisionModel is 0, so this is the only bound on a
                      wedged download. */}
                  <div>
                    <ActionButton
                      label={CANCEL_LABEL}
                      icon="close"
                      onRun={() => dispatch('setup.cancel', cancelPullParams(pinnedRow.id))}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {isLlamacppPane && (
            <LocalModelBlock
              backend="llamacpp"
              models={nextModels}
              ollama={setup.ollama}
              llamacppRuntime={setup.llamacppRuntime}
              endpoint={endpoint}
              progress={progress}
              dispatch={dispatch}
              disabledReason={disabledReason}
              pinnedDownload={{ label: NEXT_DOWNLOAD_BUTTON_LABEL, unavailableReason: NEXT_DOWNLOAD_UNAVAILABLE_TEXT }}
              runCommandCaption={nextLlamacppDigestHint(dedicated)}
            />
          )}

          {guided && (
            <div className="flex flex-col gap-1 rounded border border-border bg-surface px-2 py-1.5 text-2xs">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-fg" title={guided.command}>
                  {guided.command}
                </span>
                <ActionButton
                  label="Copy"
                  icon="copy"
                  onRun={() => navigator.clipboard.writeText(guided.command.replace(/^Run:\s*/, ''))}
                />
              </div>
              {guided.caption && <span className="text-faint">{guided.caption}</span>}
            </div>
          )}

          <div className="flex gap-2">
            {/* T11 (§6-parity minor): reuses the SAME `setup.testRemote`
                correlated method the FIM Connect tab already dispatches —
                read-only, never trust-gated (§8). T13: the llama.cpp pane's
                Test lives in the block (endpoint-in-label + Serving line) —
                a second generic [Test] would double the affordance. */}
            {!isLlamacppPane && (
              <ActionButton
                label={testConnectionLabel(endpoint)}
                onRun={() => dispatch('setup.testRemote', { backendId: selected?.id, endpoint })}
                successLabel="✓ Endpoint reachable"
              />
            )}
            <ActionButton
              label="Apply"
              onRun={() =>
                dispatch('setup.setNextEdit', {
                  backend: selected?.nextEditTransport ?? 'ollama',
                  endpoint,
                  model,
                  // T13 (CC-10): the additive restoration param — which pane
                  // configured the connection; `status()` projects it back as
                  // `nextEdit.dedicatedBackendId`.
                  ...(selected !== undefined ? { dedicatedBackendId: selected.id } : {}),
                })
              }
              disabledReason={disabledReason}
              tone="accent"
              successLabel="✓ Saved"
            />
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card 5 — Codebase index (RAG)
 * ------------------------------------------------------------------ */

function RagCard({
  setup,
  progress,
  dispatch,
  disabledReason,
  jump,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  jump?: JumpSignal;
}) {
  const rag = setup.rag;
  // T14 (§3.4): presence of the CONFIGURED embed model, endpoint-scoped
  // against the daemon `status()` actually probed (C-6). The done line and
  // the summary suffix both key off THIS — never the deprecated wire
  // boolean, which answers for the wrong daemon whenever the configured
  // endpoint isn't the probed one (the beta.5 lie this card replaced).
  const presence = ragEmbedPresence(setup.ollama, rag);

  return (
    <Card title="Codebase index (RAG)" id="setup-card-embedding">
      <DoneLine text={ragDoneLine(rag, presence)} className="mb-2" />
      {rag.preconditionDetail && (
        <div className="mb-2 rounded border border-warn bg-warn-soft px-2 py-1.5 text-2xs text-fg">
          {rag.preconditionDetail}
        </div>
      )}

      {/* T11 (§6-parity minor): `aria-disabled` on the ROW (the Toggle's own
          `<button>` stays single-mechanism — native `disabled` only, per
          `Toggle.tsx`'s tested invariant that native `disabled` and
          `aria-disabled` are never both engaged on that element) + a
          `title` reason on the switch itself, matching `ActionButton`'s
          "always name why" rule. */}
      <div
        className="mb-2 flex items-center gap-2 border-b border-border pb-2"
        aria-disabled={disabledReason !== undefined ? true : undefined}
      >
        <span className="min-w-0 flex-1 text-xs text-fg">Enable codebase index</span>
        <Toggle
          id="setup-rag-enabled"
          on={rag.enabled}
          label="Enable codebase index"
          disabled={disabledReason !== undefined}
          title={disabledReason}
          onChange={(next) => void dispatch('setup.setRag', { enabled: next })}
        />
      </div>

      <div className="text-2xs text-muted">
        Embeddings: <span className="font-mono text-fg">{rag.embedModel}</span> via{' '}
        <span className="font-mono text-fg">{rag.embedEndpoint}</span>
        {/* Honest tri-state suffix (T14): provable absence keeps the warn
            text via `catalogPresenceText`. beta.6 panel-fix PT8 (audit A7):
            the unverifiable-endpoint case shortens to "not verified here" AT
            THIS collapsed card level — no Test control sits behind this
            suffix, so pointing at one here would be a dead-end; the full
            "— Test the endpoint first." pointer stays at ROW level inside
            the expanded section below, where a Test button actually is. */}
        {presence !== 'present' && (
          <span className={`ml-2 ${presence === 'absent' ? 'text-warn' : 'text-faint'}`}>
            {presence === 'unknown' ? 'not verified here' : catalogPresenceText(presence)}
          </span>
        )}
      </div>

      <RagEmbedSection
        setup={setup}
        progress={progress}
        dispatch={dispatch}
        disabledReason={disabledReason}
        jump={jump}
      />

      <details className="mt-2">
        <summary className="cursor-pointer text-2xs text-muted">Advanced</summary>
        <div className="mt-1 flex flex-col gap-1 text-2xs text-faint">
          <span>
            Index directory: <span className="font-mono">{rag.indexDir}</span>
          </span>
          <span>Dims: {rag.tuning.dims || 'server default'}</span>
          <span>Max chunk tokens: {rag.tuning.maxChunkTokens}</span>
        </div>
      </details>
    </Card>
  );
}

/**
 * beta.6 T14 (§3.4): the RAG card's collapsible embedding-model section —
 * the shared `LocalModelBlock` with the three embedding catalog rows, a
 * 3-pane backend switch persisted as `talaria.rag.embedBackend` (CC-10),
 * and the controls the card lacked before beta.6 (Part 0.1): an Endpoint
 * field, Test, and Apply (`setup.setRag`, Tier-1 modal host-side).
 *
 * Presence on the Ollama pane is the block's endpoint-scoped client
 * derivation (`catalogPresence`, C-6) against the live Endpoint FIELD —
 * rows honestly read as unverifiable the moment the field leaves the
 * probed daemon. Rows are informational (no `onSelect`; the embed-model
 * setting stays free text — CC-8, the beta.5 path preserved through the
 * configured-model row above the block). One Test per pane (T13 note 2):
 * Ollama gets the surface-level `TestAndServingLine` (the block renders
 * none there, §4.1); llama.cpp and the third pane use the block's own.
 * The third pane persists `'openai-compat'` but renders the block's vLLM
 * pane — run commands + Test only (§3.4). Collapsible = toggle button +
 * conditional render, NOT `<details>` (T12's jsdom finding: closed-
 * `<details>` children stay queryable AND ship hidden interactive
 * controls). No `pinnedDownload` — RAG rows are allowlist/live-oid tier
 * with generic Download semantics (T13 note 1).
 */
/** The RAG Embedding-model field's caption id — `aria-describedby` plumbing
 *  (PT5, C1-15 parity). DISTINCT from {@link FIM_MODEL_CAPTION_ID} — the two
 *  fields can share a document. */
const RAG_MODEL_CAPTION_ID = 'rag-model-field-caption';

function RagEmbedSection({
  setup,
  progress,
  dispatch,
  disabledReason,
  jump,
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
  jump?: JumpSignal;
}) {
  const rag = setup.rag;
  const embedModels = (setup.catalog?.models ?? []).filter((m) => m.role === 'embedding');
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<RagEmbedBackend>(() => ragInitialBackend(rag));
  // beta.7 B2: the recs strip's "Set up →" jump expands this section and
  // focuses this toggle — see `useExpandOnJump`.
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  useExpandOnJump(jump, 'setup-card-embedding', open, () => setOpen(true), toggleRef);

  // beta.6 panel-fix PT5 (audit A5, C2-5): endpoint init is PER-PANE —
  // the SAVED `embedEndpoint` when this pane IS the saved backend, that
  // pane's host-owned default otherwise (`ragEndpointInit`, PT3/PT2). The
  // key folds in BOTH the pane and the resolved init, so a pane switch AND
  // an embedBackend-only wire move (external settings edit) re-resolve
  // while an in-flight edit at the same pane survives unrelated re-renders
  // (the T12 keyed-state pattern). This closes the bug where Apply on the
  // llama.cpp pane could save Ollama's :11434 as a llama.cpp endpoint.
  const endpointInit = ragEndpointInit(rag, pane);
  const endpointKey = `${pane}|${endpointInit}`;
  const [ep, setEp] = useState(() => ({ key: endpointKey, value: endpointInit }));
  if (ep.key !== endpointKey) setEp({ key: endpointKey, value: endpointInit });

  // §3.2 (PT5 — PT4's card idiom, pane-keyed): the section's ONE pending-
  // model draft, shared by the field on every pane and the Ollama pane's
  // row selection/pulls. A pane switch resets the draft to saved (C1-4);
  // an Apply landing / external settings edit reconciles via the saved
  // half of the key; an in-flight edit survives unrelated re-renders
  // (the PT3 pure pair, `setupCards.ts`).
  const pendingKey = `${pane}|${rag.embedModel}`;
  const [pendingState, setPendingState] = useState(() => initPendingModel(pendingKey, rag.embedModel));
  const pending = reconcilePendingModel(pendingState, pendingKey, rag.embedModel);
  if (pending !== pendingState) setPendingState(pending);
  const pendingModel = pending.value;
  const setPendingModel = (value: string) => setPendingState({ key: pendingKey, value });
  // C1-6 snapshot/no-clobber (PT4's rule verbatim): a pull's success only
  // adopts the pulled target if the draft is UNCHANGED since the pull was
  // clicked (`snapshot` = the click-render's value, pinned by the click
  // closure — never read live at resolve). A free-text edit typed during
  // a multi-GB pull is never silently overwritten.
  const adoptPulledModel = (snapshot: string, target: string) =>
    setPendingState((prev) => (prev.value === snapshot ? { key: prev.key, value: target } : prev));

  const blockBackend = ragBlockBackend(pane);
  // CC-8 (§3.4): running-branch-only — the legacy tier needs a live daemon
  // to pull onto (T11's FIM rule, reused verbatim).
  const showConfiguredRow =
    pane === 'ollama' && setup.ollama.running && configuredModelOutsideCatalog(embedModels, rag.embedModel);
  const anyLlamacppPresent = embedModels.some((m) => m.llamacpp?.present === true);

  // §8 (PT5): row highlight DERIVED from the draft — free text outside the
  // catalog honestly un-highlights every row, never a guessed match. The
  // pending line is `:latest`-tolerant against saved (`ollamaTagsEqual` —
  // the same normalization presence/row-matching use); its LiveRegion
  // stays ALWAYS mounted, only `text` swaps.
  const rowSelectedId = catalogRowIdForModel(embedModels, pendingModel);
  const pendingLine =
    pendingModel.trim() !== '' && !ollamaTagsEqual(pendingModel, rag.embedModel)
      ? pendingSelectionLine('rag', pendingModel)
      : '';
  const trimmed = pendingModel.trim();

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        ref={toggleRef}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        Configure embedding model
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="inline-flex gap-1 self-start rounded border border-border p-0.5">
            {(['ollama', 'llamacpp', 'openai-compat'] as const).map((b) => (
              <button
                key={b}
                type="button"
                aria-pressed={pane === b}
                onClick={() => setPane(b)}
                className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-wide ${
                  pane === b ? 'bg-accent-soft text-accent' : 'text-faint hover:text-muted'
                }`}
              >
                {b === 'openai-compat' ? RAG_THIRD_TAB_LABEL : BACKEND_DISPLAY[b]}
              </button>
            ))}
          </div>

          <TextField
            label="Endpoint"
            value={ep.value}
            onChange={(v) => setEp({ key: ep.key, value: v })}
            placeholder="http://host:port"
          />

          {/* PT5 §3.2: the Embedding model field renders on EVERY pane — the
              name rides every /v1/embeddings request body, so hiding it on
              any pane would make Apply silently carry a value the user can't
              see. llama.cpp ignores the name for model CHOICE — the honest
              note below the field says so instead of hiding the field. */}
          <div className="flex flex-col gap-1">
            <TextField
              label={RAG_MODEL_FIELD_LABEL}
              value={pendingModel}
              onChange={setPendingModel}
              placeholder={rag.embedModel || undefined}
              describedBy={RAG_MODEL_CAPTION_ID}
            />
            <p id={RAG_MODEL_CAPTION_ID} className="text-2xs text-faint">
              {RAG_MODEL_FIELD_CAPTION}
            </p>
            {pane === 'llamacpp' && <p className="text-2xs text-muted">{RAG_LLAMACPP_MODEL_NOTE}</p>}
          </div>

          {showConfiguredRow && (
            <ConfiguredModelRow
              model={rag.embedModel}
              ollama={setup.ollama}
              endpoint={ep.value}
              progress={progress}
              dispatch={dispatch}
              disabledReason={disabledReason}
              pullSuccessLabel={RAG_OLLAMA_PULL_NUDGE}
              onPullSuccess={() => adoptPulledModel(pendingModel, rag.embedModel)}
            />
          )}

          <LocalModelBlock
            backend={blockBackend}
            models={embedModels}
            ollama={setup.ollama}
            llamacppRuntime={setup.llamacppRuntime}
            endpoint={ep.value}
            progress={progress}
            dispatch={dispatch}
            disabledReason={disabledReason}
            // PT5 §3.2: rows are MODEL selectors on the Ollama pane only —
            // on llama.cpp/vLLM the model choice is expressed by the
            // run/serve command, not these settings, so rows stay
            // informational there (no fake affordance).
            selectedId={pane === 'ollama' ? rowSelectedId : undefined}
            onSelect={
              pane === 'ollama'
                ? (id) => {
                    const row = embedModels.find((m) => m.id === id);
                    const target = row?.ollamaCreatedName ?? row?.ollamaTag; // the catalogOllamaTarget rule
                    if (target !== undefined) setPendingModel(target);
                  }
                : undefined
            }
            ollamaPullSuccessLabel={RAG_OLLAMA_PULL_NUDGE}
            onOllamaPullSuccess={(model) => {
              const target = model.ollamaCreatedName ?? model.ollamaTag;
              if (target !== undefined) adoptPulledModel(pendingModel, target);
            }}
          />
          <LiveRegion text={pendingLine} className="text-2xs text-muted" />

          {/* §6 nudge, llama.cpp pane: rendered once any embedding row is
              genuinely present — it names a next step (Apply) that only
              becomes real after a download lands (T11's placement rule:
              the block is atomic, so this sits after it). */}
          {pane === 'llamacpp' && anyLlamacppPresent && <p className="text-2xs text-muted">{RAG_APPLY_NUDGE}</p>}

          {/* The Ollama pane has no in-block Test (§4.1) — the same
              surface-level Test + Serving line the FIM/Agent ollama panes
              carry (T10 Minor #4; one Test per pane, T13 note 2). */}
          {pane === 'ollama' && <TestAndServingLine backend="ollama" endpoint={ep.value} dispatch={dispatch} />}

          <div>
            <ActionButton
              label="Apply"
              // PT5: Apply persists everything it shows — the model rides
              // along whenever non-empty; a trimmed-empty field omits the
              // key entirely (the host keeps the saved value). FIM ≠ RAG:
              // this is the surface's ONLY save, and it is `setup.setRag`.
              onRun={() =>
                dispatch('setup.setRag', {
                  embedEndpoint: ep.value,
                  embedBackend: pane,
                  ...(trimmed !== '' ? { embedModel: trimmed } : {}),
                })
              }
              disabledReason={disabledReason}
              tone="accent"
              successLabel="✓ Applied"
            />
          </div>
        </div>
      )}
    </div>
  );
}
