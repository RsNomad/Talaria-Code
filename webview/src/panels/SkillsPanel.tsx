/* Skills panel: real enable/disable switches over Hermes's dashboard REST
 * surface (`PUT /api/skills/toggle`). Optimistic write-through with
 * rollback-on-error; bulk toggles are serialized (see useToggle). Rows show the
 * real description + provenance + usage the dashboard `GET /api/skills` returns.
 *
 * Task B6 (§5.6): adds the T2 skills-hub UI on top of the existing toggle
 * surface — a "Create skill" disclosure, an "Install from hub" disclosure
 * (identifier -> Check -> preview+scan card -> Install), and a `Remove`
 * button on every `provenance === 'hub'` row. Mirrors `McpPanel.tsx`'s A7/A8
 * idioms throughout (collapsed disclosures with local `useState` forms,
 * locally-copied `TextField`/`TextAreaField` — "no shared component exists
 * to import", same posture as that file's own comment — and a row-scoped
 * notice card). The HOST renders the native consent modal for
 * create/install/uninstall (§5.5); every click here only SUMMONS it —
 * this file never gates, confirms, or second-guesses that decision.
 */
import { useState, type FormEvent } from 'react';
import type { HubInstallResult, HubPreview, HubScan, SkillCreateParams, SkillInfo, SkillsData } from '../protocol';
import { APPLIES_NEXT_SESSION } from '../copy';
import { totalLookup } from '../lookup';
import { busyInteraction } from '../components/busyInteraction';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill, type PillTone } from '../components/Pill';
import { Toggle } from '../components/Toggle';
import { PanelShell } from './PanelShell';
import { useToggle } from './useToggle';

interface SkillsPanelProps {
  data: SkillsData;
  /** Persist a skill enable/disable (correlated → resolves/rejects). */
  onToggle: (name: string, enabled: boolean) => Promise<unknown>;
  /** Re-fetch the list from the dashboard (Reload). */
  onRefresh: () => void;
  /** Correlated `skills.create` — the HOST renders the create-consent modal; this call only summons it. */
  onCreate: (params: SkillCreateParams) => Promise<unknown>;
  /** Correlated `skills.hubPreview` — read-only, not trust-gated. */
  onHubPreview: (identifier: string) => Promise<HubPreview>;
  /** Correlated `skills.hubScan` — read-only, not trust-gated. */
  onHubScan: (identifier: string) => Promise<HubScan>;
  /** Correlated `skills.hubInstall` — the HOST renders the install-consent modal; this call only summons it. */
  onHubInstall: (identifier: string) => Promise<HubInstallResult>;
  /** Correlated `skills.hubUninstall` — the HOST renders the remove-consent modal; this call only summons it. */
  onHubUninstall: (name: string) => Promise<unknown>;
}

/** Human labels for the dashboard `provenance` classification. Exported
 * (UI-I1 sibling) so `SkillsPanel.test.ts` can exercise the total lookup
 * directly — this repo's webview tests don't use jsdom. */
export const PROVENANCE_LABEL: Record<NonNullable<SkillInfo['provenance']>, string> = {
  hub: 'hub',
  bundled: 'bundled',
  agent: 'local',
};

/** UI-I1 sibling: an out-of-contract `provenance` degrades gracefully today
 * (`<Pill>{undefined}</Pill>` renders no text) but is still guarded for
 * honesty. */
export const UNKNOWN_PROVENANCE_LABEL = 'unknown';

// ---------------------------------------------------------------------------
// Task B6 pure helpers — exported for `SkillsPanel.test.ts` (no jsdom).
// ---------------------------------------------------------------------------

/** `HubScan.verdict` -> the `Pill` tone that renders it. */
const VERDICT_TONE: Record<HubScan['verdict'], PillTone> = {
  safe: 'add',
  caution: 'neutral',
  dangerous: 'del',
};

/**
 * Task B6 (§5.6): total map from a scan verdict to its `Pill` tone, via the
 * repo's `totalLookup` (same UI-I1 posture as `STATUS`/`PROVENANCE_LABEL`
 * above) — an out-of-contract verdict (a version-skewed/buggy host) falls
 * back to `'neutral'` instead of `VERDICT_TONE[bad]` being `undefined` and
 * `<Pill tone={undefined}>` degrading silently in an unproven way.
 */
export function verdictTone(verdict: string): PillTone {
  return totalLookup(VERDICT_TONE, verdict, 'neutral');
}

/** `HubScan.policy` -> the `Pill` tone that renders it: `allow` is the
 * uncontested default (neutral), `ask` wants a decision (warn), `block` is
 * a refusal (del). */
const POLICY_TONE: Record<HubScan['policy'], PillTone> = {
  allow: 'neutral',
  ask: 'warn',
  block: 'del',
};

/**
 * Task TH-2 (AU-38): total map from a scan `policy` to its `Pill` tone, same
 * `totalLookup` posture as {@link verdictTone} — an out-of-contract policy
 * (a version-skewed/buggy host) falls back to `'neutral'` rather than
 * `<Pill tone={undefined}>` degrading silently.
 */
export function policyTone(policy: string): PillTone {
  return totalLookup(POLICY_TONE, policy, 'neutral');
}

/** Per-finding `severity` -> the `Pill` tone that renders it in the
 * Findings disclosure. `dangerous`/`high` read as del (the two scanner
 * vocabularies this repo has seen — `HubScan.verdict` and per-finding
 * `severity` — don't share one enum), `medium`/`caution` as warn, `low` as
 * neutral. */
const FINDING_SEVERITY_TONE: Record<string, PillTone> = {
  dangerous: 'del',
  high: 'del',
  medium: 'warn',
  caution: 'warn',
  low: 'neutral',
};

/**
 * Task TH-2 (AU-38): total map from a per-finding `severity` string to its
 * `Pill` tone — any other/unknown severity (including a version-skewed
 * host) falls back to `'neutral'`, never `undefined`.
 */
export function findingSeverityTone(severity: string): PillTone {
  return totalLookup(FINDING_SEVERITY_TONE, severity, 'neutral');
}

/** Display order for the severity-counts line — worst first. */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/**
 * Task TH-2 (AU-38): renders `HubScan.severity_counts` as an honest,
 * consent-relevant summary — e.g. `"1 critical · 2 high"` — replacing the
 * bare finding count the card used to show. `findingsCount` (i.e.
 * `scan.findings.length`) is the source of truth for the all-clear, NOT the
 * four fixed `severity_counts` buckets: `HubScan.findings[].severity` is a
 * free-form string while `severity_counts` only tallies
 * critical/high/medium/low, so a finding with an out-of-vocabulary severity
 * (e.g. `'info'`) inflates none of the four buckets — an all-zero-buckets
 * result with real findings present must never read as the all-clear.
 *  - `findingsCount === 0` -> the literal `'No findings'` (a genuine
 *    all-clear, never a blank string that could read as "nothing rendered"
 *    rather than "nothing found").
 *  - otherwise, non-zero buckets render worst-first, zero buckets omitted so
 *    the line stays short.
 *  - findings exist but every bucket is still zero (every severity was
 *    out-of-vocabulary) -> falls back to the honest bare count, e.g.
 *    `"2 findings"` — never the misleading `'No findings'`.
 */
export function severityCountsSummary(counts: HubScan['severity_counts'], findingsCount: number): string {
  if (findingsCount === 0) return 'No findings';
  const parts = SEVERITY_ORDER.filter((sev) => counts[sev] > 0).map((sev) => `${counts[sev]} ${sev}`);
  if (parts.length > 0) return parts.join(' · ');
  return `${findingsCount} finding${findingsCount === 1 ? '' : 's'}`;
}

/**
 * Task B6 (§5.6) UX-hint mirror of the HOST's `skillSourceGate.ts`
 * `TRUSTED_SKILL_PREFIXES` (read-only, never edited from here — that file is
 * the authoritative gate). This list exists ONLY so `identifierHint` can
 * show the allowlist explanation BEFORE the user hits Check; a drift between
 * this list and the host's real one only ever over- or under-shows the
 * hint — it never changes what installs, since every hub call is re-checked
 * server-side by `assertSkillIdentifier` regardless of what this file thinks.
 */
const HINT_TRUSTED_SKILL_PREFIXES: readonly string[] = [
  'official',
  'openai/skills',
  'anthropics/skills',
  'huggingface/skills',
  'NVIDIA/skills',
];

/**
 * Segment-anchored prefix match, mirroring the SPIRIT of the host's
 * `assertSkillIdentifier` (never its exact charset/traversal checks — this
 * is a hint, not a gate): `prefix`'s `/`-separated segments must match `id`'s
 * leading segments exactly, AND `id` must have at least one segment beyond
 * the prefix (a bare prefix names a repo, not a skill). This is what keeps
 * `officialX/foo` from being treated as trusted merely because it starts
 * with the characters `official` — a plain `id.startsWith(prefix)` would
 * falsely reassure there.
 */
function isSegmentAnchoredPrefixMatch(id: string, prefix: string): boolean {
  const idSegments = id.split('/');
  const prefixSegments = prefix.split('/');
  if (idSegments.length <= prefixSegments.length) return false;
  return prefixSegments.every((seg, i) => idSegments[i] === seg);
}

/**
 * Task B6 (§5.6): the allowlist explanation for an identifier whose prefix
 * is NOT one of {@link HINT_TRUSTED_SKILL_PREFIXES} — shown BEFORE the user
 * hits Check, so they learn the rule without a round-trip. `undefined` for a
 * trusted-prefix identifier (no hint needed). This is a UX convenience only:
 * the HOST `skillSourceGate.ts` stays the authoritative gate regardless of
 * what this function says.
 */
export function identifierHint(id: string): string | undefined {
  const trusted = HINT_TRUSTED_SKILL_PREFIXES.some((prefix) => isSegmentAnchoredPrefixMatch(id, prefix));
  if (trusted) return undefined;
  return 'Only official or trusted publishers (anthropics/skills, openai/skills, huggingface/skills, NVIDIA/skills) install without extra review — the source will still be checked before Install.';
}

/**
 * Task B6 (§5.6): seeds the Create-skill content textarea with valid
 * frontmatter for the typed `name` — a `---`-fenced doc so the host's
 * `validateSkillCreate` content check (must start with `---`) passes.
 */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: one line\n---\n\nDescribe what the agent should do, step by step.\n`;
}

// ---------------------------------------------------------------------------
// Local UI primitives — copied from `McpPanel.tsx` (A7's own comment: "no
// shared component exists to import — same posture as this file's own plain
// <button>s"). Same classes/tokens, so this stays reuse-not-restyle.
// ---------------------------------------------------------------------------

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : fallback;
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

/** Same sibling as McpPanel's `TextAreaField`, with an optional `rows`
 *  (default 3, matching McpPanel's fixed value) — the Create-skill Content
 *  field wants more visible lines for a multi-line frontmatter doc; this is
 *  an HTML attribute, not a new style/token. */
function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-2xs text-muted">
      {label}
      <textarea
        value={value}
        placeholder={placeholder}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-overlay px-2 py-1 font-mono text-2xs text-fg"
      />
    </label>
  );
}

interface HubNotice {
  tone: 'ok' | 'error';
  text: string;
}

/** Row-scoped notice card — same sr-only-LiveRegion + colored-card pair as
 *  McpPanel's own `RowNoticeCard` (not exported there — copied locally). */
function HubNoticeCard({ notice }: { notice: HubNotice | undefined }) {
  return (
    <>
      <LiveRegion text={notice?.text ?? ''} className="sr-only" />
      {notice && (
        <div
          className={`mt-1.5 flex items-start gap-1.5 rounded border px-2 py-1 text-2xs ${
            notice.tone === 'ok' ? 'border-border bg-overlay text-muted' : 'border-del bg-del-soft text-fg'
          }`}
        >
          <Icon
            name={notice.tone === 'ok' ? 'check' : 'error'}
            size={11}
            className={`mt-0.5 flex-none ${notice.tone === 'ok' ? 'text-accent' : 'text-del'}`}
          />
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Create-skill disclosure (§5.6 item 1)
// ---------------------------------------------------------------------------

/**
 * Task B6 (§5.6): collapsed by default, mirrors `McpPanel.tsx`'s
 * `AddServerDisclosure` structure exactly. Content seeds/refreshes from
 * {@link skillTemplate} as the user types the Name field — but only until
 * they touch Content themselves (`contentEdited`), so a deliberate edit is
 * never clobbered by a later Name keystroke. Submit calls `onCreate`; the
 * HOST renders the create-consent modal (§5.5) — a declined modal comes back
 * as a rejection (`ControlDispatcher.ts`'s `skillsCreate`, "was declined or
 * cancelled") and is surfaced here the same honest way a real failure would
 * be, never a crash.
 */
function CreateSkillDisclosure({ onCreate }: { onCreate: SkillsPanelProps['onCreate'] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');
  const [contentEdited, setContentEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleNameChange = (next: string) => {
    setName(next);
    if (!contentEdited) setContent(next.trim() ? skillTemplate(next.trim()) : '');
  };

  const handleContentChange = (next: string) => {
    setContentEdited(true);
    setContent(next);
  };

  const resetFields = () => {
    setName('');
    setCategory('');
    setContent('');
    setContentEdited(false);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (creating) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    if (!content.trim()) {
      setError('Content is required.');
      return;
    }

    const trimmedCategory = category.trim();
    const params: SkillCreateParams = { name: trimmedName, content };
    if (trimmedCategory) params.category = trimmedCategory;

    setCreating(true);
    setError(undefined);
    void onCreate(params).then(
      () => {
        setCreating(false);
        resetFields();
        setOpen(false);
      },
      (err: unknown) => {
        setCreating(false);
        setError(errorMessage(err, 'Create failed.'));
      },
    );
  };

  // AU-40: purely in-flight — `handleSubmit` already guards
  // `if (creating) return;` above, equivalent to `!createInteraction.interactive`.
  const createInteraction = busyInteraction(false, creating);

  return (
    <div className="mt-2 overflow-hidden rounded-card border border-dashed border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-2xs uppercase tracking-wide text-muted hover:text-accent"
      >
        <Icon name="add" size={13} />
        Create skill
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="ml-auto" />
      </button>
      {open && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border px-3 py-3">
          <TextField label="Name" value={name} onChange={handleNameChange} placeholder="my-skill" />
          <TextField
            label="Category (optional)"
            value={category}
            onChange={setCategory}
            placeholder="research"
          />
          <TextAreaField
            label="Content"
            value={content}
            onChange={handleContentChange}
            placeholder={skillTemplate('my-skill')}
            rows={8}
          />

          <LiveRegion text={error ?? ''} className="sr-only" />
          {error && (
            <div className="flex items-start gap-1.5 rounded border border-del bg-del-soft px-2 py-1 text-2xs text-fg">
              <Icon name="error" size={11} className="mt-0.5 flex-none text-del" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={createInteraction.nativeDisabled}
            aria-disabled={createInteraction.ariaDisabled}
            aria-busy={createInteraction.ariaBusy}
            className="mt-1 flex items-center justify-center gap-1.5 self-start rounded border border-border px-3 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60 aria-disabled:cursor-default aria-disabled:opacity-60"
          >
            <Icon name={creating ? 'loading' : 'add'} size={12} spin={creating} />
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Install-from-hub disclosure (§5.6 item 2)
// ---------------------------------------------------------------------------

/**
 * Task B6 (§5.6): collapsed by default. `Check` fires BOTH `onHubPreview`
 * and `onHubScan` for the typed identifier and renders a result card on
 * resolve — name, description, a trust-tier `Pill` (`preview.trust_level`),
 * a verdict `Pill` (`verdictTone(scan.verdict)`), the finding count, and a
 * collapsible plain-text `SKILL.md` preview. `identifierHint` shows the
 * allowlist explanation for a non-trusted-prefix identifier BEFORE Check is
 * ever pressed — a UX head start, not a gate: the HOST `skillSourceGate.ts`
 * re-checks every identifier regardless. `Install` fires `onHubInstall` and
 * disables itself (`Installing…`) while the promise is pending. Any
 * rejection (host gate refusal, a declined modal, a ground-truth failure)
 * surfaces a neutral notice — never a crash, never a silent bypass.
 */
function InstallFromHubDisclosure({
  onHubPreview,
  onHubScan,
  onHubInstall,
}: {
  onHubPreview: SkillsPanelProps['onHubPreview'];
  onHubScan: SkillsPanelProps['onHubScan'];
  onHubInstall: SkillsPanelProps['onHubInstall'];
}) {
  const [open, setOpen] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | undefined>();
  const [result, setResult] = useState<{ preview: HubPreview; scan: HubScan; forIdentifier: string } | undefined>();
  const [mdOpen, setMdOpen] = useState(false);
  // TH-2 (AU-38): the per-finding detail disclosure, same collapsed-by-default
  // posture as `mdOpen` above — not reset on a new Check, matching that
  // sibling's own behavior.
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState<HubNotice | undefined>();

  const trimmedIdentifier = identifier.trim();
  const hint = trimmedIdentifier ? identifierHint(trimmedIdentifier) : undefined;
  // TH-1 (AU-37): `result` is a verdict for `result.forIdentifier`, captured
  // from the TYPED `trimmedIdentifier` at Check time — never from
  // `preview.identifier` (server-side canonicalization could mask a user
  // edit and defeat this check). If the field has since been edited away
  // from that identifier, the shown preview/scan no longer describes what
  // Install would act on — a consent-integrity gap, not just a stale cache.
  const stale = result !== undefined && trimmedIdentifier !== result.forIdentifier;
  // AU-40: MIXED site. `!trimmedIdentifier` is genuine indefinite
  // disablement (nothing typed, nothing to check — stays native); `checking`
  // is in-flight (goes busy). `handleCheck` already guards both conditions.
  const checkInteraction = busyInteraction(!trimmedIdentifier, checking);
  // AU-40: MIXED site (TH-1). `stale` is genuine indefinite disablement (the
  // shown preview/scan no longer describes what Install would act on — stays
  // native, so TH-1's stale test keeps asserting `toBeDisabled()`);
  // `installing` is in-flight (goes busy). `handleInstall` already guards
  // both conditions.
  const installInteraction = busyInteraction(stale, installing);

  const handleCheck = () => {
    if (!trimmedIdentifier || checking) return;
    setChecking(true);
    setCheckError(undefined);
    setResult(undefined);
    setInstallNotice(undefined);
    void Promise.all([onHubPreview(trimmedIdentifier), onHubScan(trimmedIdentifier)])
      .then(([preview, scan]) => setResult({ preview, scan, forIdentifier: trimmedIdentifier }))
      .catch((err: unknown) => setCheckError(errorMessage(err, 'Check failed.')))
      .finally(() => setChecking(false));
  };

  const handleInstall = () => {
    // `stale` is belt-and-suspenders here — the button is also natively
    // `disabled` while stale (see below) — so a click can't reach this at
    // all through the UI; this guard only matters if that ever changes.
    if (!trimmedIdentifier || installing || stale) return;
    setInstalling(true);
    setInstallNotice(undefined);
    void onHubInstall(trimmedIdentifier)
      .then(
        // AU-58 (INV-18), mirrors McpPanel's TG-2 (AU-49): installing a skill
        // only affects future agent builds — a chat already open won't see
        // it, so the panel refetch showing this skill "Installed" must not
        // imply otherwise.
        (res) => setInstallNotice({ tone: 'ok', text: `Installed "${res.name}". ${APPLIES_NEXT_SESSION}` }),
        (err: unknown) => setInstallNotice({ tone: 'error', text: errorMessage(err, 'Install failed.') }),
      )
      .finally(() => setInstalling(false));
  };

  return (
    <div className="mt-2 overflow-hidden rounded-card border border-dashed border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-2xs uppercase tracking-wide text-muted hover:text-accent"
      >
        <Icon name="cloud-download" size={13} />
        Install from hub
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="ml-auto" />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
          <TextField
            label="Identifier"
            value={identifier}
            onChange={setIdentifier}
            placeholder="anthropics/skills/pdf"
          />

          {hint && (!result || stale) && (
            <div className="flex items-start gap-1.5 rounded border border-border bg-overlay px-2 py-1 text-2xs text-muted">
              <Icon name="info" size={11} className="mt-0.5 flex-none text-accent" />
              <span className="min-w-0 flex-1 break-words">{hint}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleCheck}
            disabled={checkInteraction.nativeDisabled}
            aria-disabled={checkInteraction.ariaDisabled}
            aria-busy={checkInteraction.ariaBusy}
            className="flex items-center justify-center gap-1.5 self-start rounded border border-border px-3 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60 aria-disabled:cursor-default aria-disabled:opacity-60"
          >
            <Icon name={checking ? 'loading' : 'beaker'} size={12} spin={checking} />
            {checking ? 'Checking…' : 'Check'}
          </button>

          <LiveRegion text={checkError ?? ''} className="sr-only" />
          {checkError && (
            <div className="flex items-start gap-1.5 rounded border border-del bg-del-soft px-2 py-1 text-2xs text-fg">
              <Icon name="error" size={11} className="mt-0.5 flex-none text-del" />
              <span className="min-w-0 flex-1 break-words">{checkError}</span>
            </div>
          )}

          {result && (
            <div className="rounded-card border border-border bg-surface px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Icon name="package" size={15} className="flex-none text-accent" />
                <span className="min-w-0 truncate font-mono text-xs text-fg">{result.preview.name}</span>
                {!stale && (
                  <span className="ml-auto flex flex-none items-center gap-1.5">
                    <Pill tone="accent">{result.preview.trust_level}</Pill>
                    <Pill tone={verdictTone(result.scan.verdict)}>{result.scan.verdict}</Pill>
                  </span>
                )}
              </div>

              {stale ? (
                // TH-1 (AU-37): the identifier was edited after Check ran —
                // the trust/verdict pills above and the detail below describe
                // a DIFFERENT artifact than what Install would now act on.
                // Neutral caption tone (not del/warn): this is staleness, not
                // an error.
                <div className="mt-1.5 flex items-start gap-1.5 rounded border border-border bg-overlay px-2 py-1 text-2xs text-muted">
                  <Icon name="info" size={11} className="mt-0.5 flex-none text-accent" />
                  <span className="min-w-0 flex-1 break-words">
                    Identifier changed — result no longer applies. Run Check again.
                  </span>
                </div>
              ) : (
                <>
                  {result.preview.description && (
                    <div className="mt-1 font-mono text-2xs text-faint">{result.preview.description}</div>
                  )}

                  {/* TH-2 (AU-38): the scanner's own one-line human verdict —
                      dropped entirely before this fix. Untrusted scanner
                      text, rendered as plain JSX text content only (no
                      markdown/HTML interpretation). */}
                  {result.scan.summary && (
                    <p className="mt-1.5 text-2xs leading-snug text-muted break-words">{result.scan.summary}</p>
                  )}

                  {/* TH-2 (AU-38): the policy verdict (allow/ask/block) the
                      HOST will itself act on, plus its reason — the user
                      used to approve an install with neither in view. */}
                  <div className="mt-1.5 flex items-start gap-1.5">
                    <Pill tone={policyTone(result.scan.policy)}>{result.scan.policy}</Pill>
                    {result.scan.policy_reason && (
                      <span className="min-w-0 flex-1 text-2xs text-faint break-words">
                        {result.scan.policy_reason}
                      </span>
                    )}
                  </div>

                  {/* TH-2 (AU-38): replaces the old bare
                      `{findings.length} finding(s)` line — a per-severity
                      breakdown (worst first), or an explicit "No findings"
                      all-clear rather than a blank. */}
                  <div className="mt-1 font-mono text-2xs uppercase tracking-wide text-faint">
                    {severityCountsSummary(result.scan.severity_counts, result.scan.findings.length)}
                  </div>

                  {result.scan.findings.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setFindingsOpen((v) => !v)}
                        aria-expanded={findingsOpen}
                        className="mt-2 flex items-center gap-1 font-mono text-2xs text-muted hover:text-accent"
                      >
                        <Icon name={findingsOpen ? 'chevron-down' : 'chevron-right'} size={11} />
                        {`Findings (${result.scan.findings.length})`}
                      </button>
                      {findingsOpen && (
                        <div className="mt-1 max-h-48 overflow-auto rounded border border-border bg-overlay px-2 py-1.5">
                          {result.scan.findings.map((finding, i) => (
                            <div
                              key={i}
                              className="flex flex-col gap-0.5 border-b border-border py-1.5 first:pt-0 last:border-0 last:pb-0"
                            >
                              <div className="flex items-center gap-1.5">
                                <Pill tone={findingSeverityTone(finding.severity)}>{finding.severity}</Pill>
                                <span className="min-w-0 truncate font-mono text-2xs text-muted">
                                  {finding.category}
                                </span>
                              </div>
                              {/* Untrusted scanner strings — plain text nodes
                                  only, same posture as `summary` above. */}
                              <div className="font-mono text-2xs text-faint">{`${finding.file}:${finding.line}`}</div>
                              <div className="text-2xs leading-snug text-muted break-words">
                                {finding.description}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => setMdOpen((v) => !v)}
                    aria-expanded={mdOpen}
                    className="mt-2 flex items-center gap-1 font-mono text-2xs text-muted hover:text-accent"
                  >
                    <Icon name={mdOpen ? 'chevron-down' : 'chevron-right'} size={11} />
                    SKILL.md preview
                  </button>
                  {mdOpen && (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-overlay px-2 py-1.5 font-mono text-2xs text-muted">
                      {result.preview.skill_md}
                    </pre>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={handleInstall}
                disabled={installInteraction.nativeDisabled}
                aria-disabled={installInteraction.ariaDisabled}
                aria-busy={installInteraction.ariaBusy}
                title={stale ? 'Identifier changed — run Check again' : undefined}
                className="mt-2 flex items-center gap-1.5 rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50"
              >
                <Icon name={installing ? 'loading' : 'cloud-download'} size={12} spin={installing} />
                {installing ? 'Installing…' : 'Install'}
              </button>
              <HubNoticeCard notice={installNotice} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillsPanel({
  data,
  onToggle,
  onRefresh,
  onCreate,
  onHubPreview,
  onHubScan,
  onHubInstall,
  onHubUninstall,
}: SkillsPanelProps) {
  const { isOn, toggle, lastError } = useToggle(onToggle);
  const [uninstalling, setUninstalling] = useState<Record<string, boolean>>({});
  const [hubNotice, setHubNotice] = useState<Record<string, HubNotice>>({});

  /** Task B6 (§5.4 `skills.hubUninstall`): the click only SUMMONS the host's
   *  native remove-consent modal — a decline resolves as a rejection and is
   *  surfaced the same honest way a real failure would be. A successful
   *  uninstall shows nothing here: the host's own absence-verified refetch
   *  has already pushed the row's absence, so the row disappearing IS the
   *  confirmation (same posture as McpPanel's `handleRemove`). */
  const handleHubUninstall = (name: string) => {
    // AU-40: guard replacing the native `disabled` this button used to rely
    // on to block a second click while a remove is in flight.
    if (uninstalling[name] === true) return;
    setUninstalling((u) => ({ ...u, [name]: true }));
    void onHubUninstall(name)
      .then(
        () => {
          setHubNotice((n) => {
            if (!(name in n)) return n;
            const next = { ...n };
            delete next[name];
            return next;
          });
        },
        (err: unknown) =>
          setHubNotice((n) => ({ ...n, [name]: { tone: 'error', text: errorMessage(err, 'Remove failed.') } })),
      )
      .finally(() => setUninstalling((u) => ({ ...u, [name]: false })));
  };

  return (
    <PanelShell title="Skills" meta={`${data.skills.length} skills`}>
      {/* C3: panel-level note lives ABOVE the skill list — after the list it
          visually attached to the LAST skill row and read like that row's
          own caption (same misread as ToolsPanel's C1).
          TG-4 (AU-54, INV-18): adopts the ONE canonical effect-latency
          sentence shared with the MCP admin notices (Rev-1 B6) — an
          intentional, announced copy change from the original shipped C3
          wording ("...apply to new sessions; a chat already running may keep
          its current skills until its next session."), not accidental
          drift. */}
      <p className="mb-2 px-1 text-2xs leading-snug text-faint">
        {`Toggles persist immediately. ${APPLIES_NEXT_SESSION}`}
      </p>
      {data.skills.map((sk) => {
        const err = lastError(sk.id);
        const isHub = sk.provenance === 'hub';
        const rowUninstalling = uninstalling[sk.name] === true;
        // AU-40: purely in-flight — nothing genuinely-indefinite gates uninstall.
        const uninstallInteraction = busyInteraction(false, rowUninstalling);
        return (
          <div
            key={sk.id}
            className="mb-1.5 flex items-start gap-2 rounded-card border border-border bg-surface px-3 py-2"
          >
            <Icon name="extensions" size={15} className="mt-0.5 flex-none text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-xs text-fg">{sk.name}</span>
                <Pill tone="neutral">{sk.category}</Pill>
                {sk.provenance && (
                  <Pill tone="neutral">
                    {totalLookup(PROVENANCE_LABEL, sk.provenance, UNKNOWN_PROVENANCE_LABEL)}
                  </Pill>
                )}
                {typeof sk.usage === 'number' && sk.usage > 0 && (
                  <span className="text-2xs text-faint">used {sk.usage}×</span>
                )}
              </div>
              {sk.description && (
                <div className="mt-0.5 text-2xs leading-snug text-muted">{sk.description}</div>
              )}
              {/* V-11 (TOGGLE-HONESTY): a rejected persist used to roll the
                  switch back with NOTHING surfaced anywhere. Same grammar
                  SettingsPanel's FieldRow already carries (SettingsPanel.tsx:
                  159): a permanently-mounted LiveRegion (WCAG 2.2 SC 4.1.3),
                  only its text swaps — never conditionally mounted. */}
              <LiveRegion text={err ? `Not saved: ${err}` : ''} className="text-2xs text-del" title={err} />
              {isHub && <HubNoticeCard notice={hubNotice[sk.name]} />}
            </div>
            <div className="flex flex-none items-center gap-2 pt-0.5">
              <Toggle
                on={isOn(sk.id, sk.enabled)}
                label={`Enable ${sk.name}`}
                onChange={(next) => toggle(sk.id, next)}
              />
              {/* Task B6 (§5.6 item 3): only hub-provenance rows get a
                  Remove — a bundled/agent skill has no hub install to
                  reverse this way. */}
              {isHub && (
                <button
                  type="button"
                  onClick={() => handleHubUninstall(sk.name)}
                  disabled={uninstallInteraction.nativeDisabled}
                  aria-disabled={uninstallInteraction.ariaDisabled}
                  aria-busy={uninstallInteraction.ariaBusy}
                  className="flex items-center gap-1 rounded border border-del px-2 py-0.5 font-mono text-2xs text-del hover:bg-del-soft disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50"
                >
                  <Icon name={rowUninstalling ? 'loading' : 'trash'} size={12} spin={rowUninstalling} />
                  {rowUninstalling ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <CreateSkillDisclosure onCreate={onCreate} />
      <InstallFromHubDisclosure onHubPreview={onHubPreview} onHubScan={onHubScan} onHubInstall={onHubInstall} />

      <button
        type="button"
        onClick={onRefresh}
        className="mt-1 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent"
      >
        <Icon name="refresh" size={13} />
        Reload skills
      </button>
    </PanelShell>
  );
}
