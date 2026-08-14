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
import { totalLookup } from '../lookup';
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
            disabled={creating}
            className="mt-1 flex items-center justify-center gap-1.5 self-start rounded border border-border px-3 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60"
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
  const [result, setResult] = useState<{ preview: HubPreview; scan: HubScan } | undefined>();
  const [mdOpen, setMdOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState<HubNotice | undefined>();

  const trimmedIdentifier = identifier.trim();
  const hint = trimmedIdentifier ? identifierHint(trimmedIdentifier) : undefined;

  const handleCheck = () => {
    if (!trimmedIdentifier || checking) return;
    setChecking(true);
    setCheckError(undefined);
    setResult(undefined);
    setInstallNotice(undefined);
    void Promise.all([onHubPreview(trimmedIdentifier), onHubScan(trimmedIdentifier)])
      .then(([preview, scan]) => setResult({ preview, scan }))
      .catch((err: unknown) => setCheckError(errorMessage(err, 'Check failed.')))
      .finally(() => setChecking(false));
  };

  const handleInstall = () => {
    if (!trimmedIdentifier || installing) return;
    setInstalling(true);
    setInstallNotice(undefined);
    void onHubInstall(trimmedIdentifier)
      .then(
        (res) => setInstallNotice({ tone: 'ok', text: `Installed "${res.name}".` }),
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

          {hint && !result && (
            <div className="flex items-start gap-1.5 rounded border border-border bg-overlay px-2 py-1 text-2xs text-muted">
              <Icon name="info" size={11} className="mt-0.5 flex-none text-accent" />
              <span className="min-w-0 flex-1 break-words">{hint}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleCheck}
            disabled={checking || !trimmedIdentifier}
            className="flex items-center justify-center gap-1.5 self-start rounded border border-border px-3 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60"
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
                <span className="ml-auto flex flex-none items-center gap-1.5">
                  <Pill tone="accent">{result.preview.trust_level}</Pill>
                  <Pill tone={verdictTone(result.scan.verdict)}>{result.scan.verdict}</Pill>
                </span>
              </div>
              {result.preview.description && (
                <div className="mt-1 font-mono text-2xs text-faint">{result.preview.description}</div>
              )}
              <div className="mt-1 font-mono text-2xs uppercase tracking-wide text-faint">
                {result.scan.findings.length} finding{result.scan.findings.length === 1 ? '' : 's'}
              </div>

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

              <button
                type="button"
                onClick={handleInstall}
                disabled={installing}
                className="mt-2 flex items-center gap-1.5 rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:cursor-default disabled:opacity-50"
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
          own caption (same misread as ToolsPanel's C1). */}
      <p className="mb-2 px-1 text-2xs leading-snug text-faint">
        Toggles persist immediately and apply to new sessions; a chat already running may keep its
        current skills until its next session.
      </p>
      {data.skills.map((sk) => {
        const err = lastError(sk.id);
        const isHub = sk.provenance === 'hub';
        const rowUninstalling = uninstalling[sk.name] === true;
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
                  disabled={rowUninstalling}
                  className="flex items-center gap-1 rounded border border-del px-2 py-0.5 font-mono text-2xs text-del hover:bg-del-soft disabled:cursor-default disabled:opacity-50"
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
