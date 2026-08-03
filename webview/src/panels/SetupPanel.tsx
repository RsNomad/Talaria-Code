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
import { useState, type ReactNode } from 'react';
import type {
  NextEditToggleSource,
  NextEditToggleState,
  SetupBackendOption,
  SetupData,
  SetupMethod,
} from '../protocol';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill } from '../components/Pill';
import { Toggle } from '../components/Toggle';
import { errorMessage } from '../state/panels';
import type { RemoteData } from '../state/remoteData';
import { type NextEditRowCopy, NEXT_EDIT_ROWS } from './nextEditCopy';
import { PanelShell, RemotePanel, SectionLabel } from './PanelShell';
import { commitFieldEdit, initNextEditRowState, reconcileNextEditRowState } from './settingsField';
import {
  agentPhaseLabel,
  agentPrimaryAction,
  buildCopyLogText,
  fimHasLocalInstall,
  isComingSoon,
  mutationDisabledReason,
  nextEditButtonLabel,
  progressKey,
  PYTHON_VERSION_HELP_URL,
  pullPercent,
  TRUST_DISABLED_REASON,
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

  return (
    <>
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

      <AgentCard setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} />
      <ProviderCard setup={setup} dispatch={dispatch} disabledReason={disabledReason} />
      <FimCard setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} />
      <NextEditCard
        setup={setup}
        nextEdit={nextEdit}
        onToggleNextEdit={onToggleNextEdit}
        dispatch={dispatch}
        disabledReason={disabledReason}
      />
      <RagCard setup={setup} dispatch={dispatch} disabledReason={disabledReason} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Shared primitives
 * ------------------------------------------------------------------ */

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3 rounded-card border border-border bg-surface p-3">
      <SectionLabel>{title}</SectionLabel>
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
 * One async, dispatch-issuing action. Local pending/error state — busy via
 * `aria-disabled` (keeps focus, mirrors `Toggle.tsx`'s F-8 posture);
 * `disabledReason`, when given, is a GENUINE indefinite disablement (the
 * trust gate) and renders NATIVE `disabled` + `aria-disabled` + a `title`
 * tooltip naming why (§6's accessibility rule).
 */
function ActionButton({
  label,
  onRun,
  disabledReason,
  tone = 'neutral',
  icon,
}: {
  label: string;
  onRun: () => Promise<unknown>;
  disabledReason?: string;
  tone?: Tone;
  icon?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const genuinelyDisabled = disabledReason !== undefined;

  const onClick = () => {
    if (genuinelyDisabled || pending) return;
    setPending(true);
    setError(undefined);
    void onRun().then(
      () => setPending(false),
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
      <LiveRegion text={error ? `Failed: ${error}` : ''} className="text-2xs text-del" title={error} />
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
  return (
    <button
      type="button"
      disabled={comingSoon}
      aria-disabled={comingSoon ? true : undefined}
      aria-pressed={selected}
      title={comingSoon ? 'Coming soon' : undefined}
      onClick={() => {
        if (comingSoon || !onSelect) return;
        onSelect(option.id);
      }}
      className={`flex w-full items-center gap-2 rounded border px-2.5 py-1.5 text-left text-xs transition-colors aria-disabled:cursor-default aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50 ${
        selected ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-overlay text-fg hover:border-accent'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{option.displayName}</span>
      {comingSoon && <Pill tone="neutral">Coming soon</Pill>}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-2xs text-muted">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-overlay px-2 py-1 font-mono text-2xs text-fg"
      />
    </label>
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
}: {
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
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
    <Card title="Agent">
      <div className="mb-2 flex flex-col gap-1.5">
        {agent.options.map((o) => (
          <BackendOptionRow key={o.id} option={o} selected={o.id === agent.selectedId} />
        ))}
      </div>

      <StatusLine icon={phaseIcon} text={agentPhaseLabel(agent.phase)} tone={phaseTone} />
      {agent.version && <div className="mt-0.5 font-mono text-2xs text-faint">{agent.version}</div>}

      {agent.phase === 'pipx-missing' && (
        // T11 (IMPORTANT host-gap 2): the honest text remains, but the
        // dead-end "then retry" is replaced with the two real actions §6
        // asks for — a pre-typed bootstrap terminal (the user provides
        // sudo) and a Re-check once it's done. `agentPrimaryAction`
        // returns `'none'` for this phase specifically so the generic
        // single-action slot below doesn't ALSO render.
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="text-2xs text-muted">
            pipx was not found on your PATH. Open a terminal to install it, then re-check.
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              label="Open terminal: sudo dnf install pipx"
              onRun={() => dispatch('setup.openBootstrapTerminal')}
              disabledReason={disabledReason}
            />
            <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck')} />
          </div>
        </div>
      )}
      {agent.phase === 'python-unsuitable' && (
        // T11 (§6-parity minor): honest text (when the host supplied one)
        // PLUS a docs link — the descriptor's own `docsUrl` if the
        // registry ever sets one, else a sensible generic fallback.
        <div className="mt-1 flex flex-col gap-1">
          {agent.detail && <p className="text-2xs text-muted">{agent.detail}</p>}
          <a
            href={selectedOption?.docsUrl ?? PYTHON_VERSION_HELP_URL}
            className="text-2xs text-accent underline"
            target="_blank"
            rel="noreferrer"
          >
            Python version help
          </a>
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
    </Card>
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
  const [selectedId, setSelectedId] = useState(fim.selectedId);
  const [mode, setMode] = useState<'connect' | 'install'>('connect');
  const option = fim.options.find((o) => o.id === selectedId) ?? fim.options[0];

  if (!option) {
    return (
      <Card title="Autocomplete (FIM)">
        <p className="text-2xs text-faint">No autocomplete backends available.</p>
      </Card>
    );
  }

  const hasLocal = fimHasLocalInstall(option);
  const showInstallTab = hasLocal && mode === 'install';

  return (
    <Card title="Autocomplete (FIM)">
      <div className="mb-2 flex flex-col gap-1.5">
        {fim.options.map((o) => (
          <BackendOptionRow
            key={o.id}
            option={o}
            selected={o.id === option.id}
            onSelect={(id) => {
              setSelectedId(id);
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
        <FimInstallTab key={option.id} option={option} setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} />
      ) : (
        <FimConnectTab key={option.id} option={option} dispatch={dispatch} disabledReason={disabledReason} />
      )}
    </Card>
  );
}

function FimConnectTab({
  option,
  dispatch,
  disabledReason,
}: {
  option: SetupBackendOption;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const [endpoint, setEndpoint] = useState(option.remote?.endpointValue || option.remote?.endpointDefault || '');
  const needsKey = option.remote?.auth === 'apiKey-optional' || option.remote?.auth === 'apiKey-required';

  return (
    <div className="flex flex-col gap-2">
      <TextField label="Endpoint" value={endpoint} onChange={setEndpoint} placeholder={option.remote?.endpointPlaceholder} />

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
        <ActionButton label="Test" onRun={() => dispatch('setup.testRemote', { backendId: option.id, endpoint })} />
        <ActionButton
          label="Apply"
          onRun={() => dispatch('setup.applyFim', { backendId: option.id, endpoint })}
          disabledReason={disabledReason}
          tone="accent"
        />
      </div>
    </div>
  );
}

function FimInstallTab({
  option,
  setup,
  progress,
  dispatch,
  disabledReason,
}: {
  option: SetupBackendOption;
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  if (option.id === 'ollama') {
    return <OllamaInstallPanel option={option} setup={setup} progress={progress} dispatch={dispatch} disabledReason={disabledReason} />;
  }

  return (
    <div className="flex flex-col gap-2 text-2xs text-muted">
      <p>
        {option.localInstall?.effort === 'manual-guided'
          ? 'Manual install — needs your own build/hardware decisions.'
          : 'Clean one-script install.'}
      </p>
      <ActionButton
        label={`Open terminal: install ${option.displayName}`}
        onRun={() => dispatch('setup.openInstallTerminal', { backendId: option.id })}
        disabledReason={disabledReason}
      />
      {option.docsUrl && (
        <a href={option.docsUrl} className="text-accent underline" target="_blank" rel="noreferrer">
          Setup docs
        </a>
      )}
      <p>Once it&apos;s running, switch to the Connect tab and Test.</p>
    </div>
  );
}

function OllamaInstallPanel({
  option,
  setup,
  progress,
  dispatch,
  disabledReason,
}: {
  option: SetupBackendOption;
  setup: SetupData;
  progress: SetupProgressMap;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  if (!setup.ollama.running) {
    return (
      <div className="flex flex-col gap-2 text-2xs text-muted">
        <p>Ollama daemon not detected.</p>
        <div className="flex gap-2">
          <ActionButton
            label="Open terminal: install Ollama"
            onRun={() => dispatch('setup.openInstallTerminal', { backendId: 'ollama' })}
            disabledReason={disabledReason}
          />
          <ActionButton label="Re-check" onRun={() => dispatch('setup.recheck')} />
        </div>
      </div>
    );
  }

  const endpoint = option.remote?.endpointValue || option.remote?.endpointDefault || '';
  const models = option.localInstall?.models ?? [];

  return (
    <div className="flex flex-col gap-2">
      {models.map((m) => {
        const live = progress[progressKey('pull', m.model)];
        const percent = pullPercent(live?.totalBytes, live?.completedBytes);
        return (
          <div key={m.model} className="flex flex-col gap-1 rounded border border-border bg-overlay px-2 py-1.5">
            <div className="flex items-center justify-between gap-2 text-2xs">
              <span className="font-mono text-fg">
                {m.model} <span className="text-faint">({m.role})</span>
              </span>
              {m.present ? (
                <span className="text-add">Present</span>
              ) : (
                <ActionButton
                  label={`Pull ${m.model}`}
                  onRun={() => dispatch('setup.pullModel', { model: m.model, endpoint })}
                  disabledReason={disabledReason}
                />
              )}
            </div>
            {percent !== undefined && (
              <div className="flex items-center gap-2" aria-live="polite">
                <div
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Pulling ${m.model}`}
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"
                >
                  <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
                </div>
                <span className="font-mono text-2xs text-faint">{percent}%</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card 4 — NEXT
 * ------------------------------------------------------------------ */

function NextEditCard({
  setup,
  nextEdit,
  onToggleNextEdit,
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  nextEdit: NextEditToggleState;
  onToggleNextEdit: SetupPanelProps['onToggleNextEdit'];
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const [showForm, setShowForm] = useState(false);
  const next = setup.nextEdit;
  const buttonLabel = nextEditButtonLabel(next.dedicatedConfigured);

  return (
    <Card title="Next Edit (NEXT)">
      <p className="mb-2 text-2xs text-muted">
        Want NEXT (multi-line next-edit)? Two modes: <strong className="text-fg">Generic</strong> reuses your FIM
        model — onboarding already set it up, no extra setup. <strong className="text-fg">Dedicated</strong> uses a
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

      <button
        type="button"
        onClick={() => setShowForm((s) => !s)}
        className="rounded border border-border px-2.5 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        {buttonLabel}
      </button>

      {showForm && <DedicatedNextForm setup={setup} dispatch={dispatch} disabledReason={disabledReason} />}
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

function DedicatedNextForm({
  setup,
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const candidates = setup.fim.options.filter((o) => o.nextEditTransport !== undefined);
  const preferred = candidates.find((o) => o.nextEditTransport === setup.nextEdit.backend) ?? candidates[0];
  const [selectedId, setSelectedId] = useState(preferred?.id ?? '');
  const selected = candidates.find((o) => o.id === selectedId) ?? preferred;
  const [endpoint, setEndpoint] = useState(setup.nextEdit.endpoint || selected?.remote?.endpointDefault || '');
  const [model, setModel] = useState(setup.nextEdit.model);

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border border-border bg-overlay p-2">
      {candidates.length === 0 ? (
        <p className="text-2xs text-faint">No backend supports a dedicated NEXT connection.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {candidates.map((o) => (
              <BackendOptionRow key={o.id} option={o} selected={o.id === selectedId} onSelect={setSelectedId} />
            ))}
          </div>
          <TextField label="Endpoint" value={endpoint} onChange={setEndpoint} />
          <TextField label="Model" value={model} onChange={setModel} />
          <div className="flex gap-2">
            {/* T11 (§6-parity minor): reuses the SAME `setup.testRemote`
                correlated method the FIM Connect tab already dispatches —
                read-only, never trust-gated (§8). */}
            <ActionButton
              label="Test"
              onRun={() => dispatch('setup.testRemote', { backendId: selected?.id, endpoint })}
            />
            <ActionButton
              label="Apply"
              onRun={() =>
                dispatch('setup.setNextEdit', {
                  backend: selected?.nextEditTransport ?? 'ollama',
                  endpoint,
                  model,
                })
              }
              disabledReason={disabledReason}
              tone="accent"
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
  dispatch,
  disabledReason,
}: {
  setup: SetupData;
  dispatch: SetupPanelProps['dispatch'];
  disabledReason?: string;
}) {
  const rag = setup.rag;

  return (
    <Card title="Codebase index (RAG)">
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

      <div className="mb-2 text-2xs text-muted">
        Embeddings: <span className="font-mono text-fg">{rag.embedModel}</span> via{' '}
        <span className="font-mono text-fg">{rag.embedEndpoint}</span>
        {!rag.embedModelPresent && <span className="ml-2 text-warn">not present</span>}
      </div>

      {!rag.embedModelPresent && (
        <ActionButton
          label={`Pull ${rag.embedModel}`}
          onRun={() => dispatch('setup.pullModel', { model: rag.embedModel, endpoint: rag.embedEndpoint })}
          disabledReason={disabledReason}
        />
      )}

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
