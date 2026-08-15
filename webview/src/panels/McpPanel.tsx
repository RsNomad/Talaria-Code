/* MCP panel: configured servers with connection status, and a real
 * "Reload servers" action. Status is only ever connected/disconnected — the
 * join that feeds it (config.get + tools.list) can't observe a live error/
 * running state — so the former per-server error card + Retry (which gated on a
 * status that never occurs) were removed (W1.5 / A4).
 *
 * A#5: "Reload servers" now runs over the CORRELATED request path (`onReload`
 * resolves with the gateway's `{status, message?}` envelope, or rejects), so the
 * server's confirmation / failure is SURFACED inline instead of being dropped by
 * a fire-and-forget invoke. The click is still the confirmation (the host sends
 * `confirm:true`); we only make the RESULT visible. */
import { useState, type FormEvent } from 'react';
import type {
  McpAddParams,
  McpAddResult,
  McpCatalogData,
  McpCatalogEntry,
  McpCatalogInstallParams,
  McpCatalogInstallResult,
  McpData,
  McpStatus,
  McpTestResult,
} from '../protocol';
import { APPLIES_NEXT_SESSION } from '../copy';
import { totalLookup } from '../lookup';
import { Icon } from '../components/Icon';
import { LiveRegion } from '../components/LiveRegion';
import { Pill, type PillTone } from '../components/Pill';
import { Toggle } from '../components/Toggle';
import { PanelShell } from './PanelShell';
import { useToggle } from './useToggle';

/** Exported (UI-I1) so `McpPanel.test.ts` can exercise the total lookup
 * directly — this repo's webview tests don't use jsdom. */
export const STATUS: Record<McpStatus, { tone: PillTone; label: string; icon: string }> = {
  connected: { tone: 'add', label: 'Connected', icon: 'circle-filled' },
  disconnected: { tone: 'neutral', label: 'Disconnected', icon: 'circle-outline' },
};

/** UI-I1: a server `status` outside the known `McpStatus` enum (a
 * version-skewed or buggy host — `bridge.ts` only checks `.type`) falls back
 * to this instead of `STATUS[bad]` being `undefined` and `.tone` throwing
 * mid-render. */
export const UNKNOWN_MCP_STATUS: { tone: PillTone; label: string; icon: string } = {
  tone: 'neutral',
  label: 'Unknown',
  icon: 'question',
};

/**
 * Task A7 (§4.9): one command-line argument per line, trimmed, blank lines
 * dropped. Deliberately NEVER splits on whitespace within a line — the
 * server spawns stdio MCPs argv-based, no shell (`tools/mcp_tool.py
 * _run_stdio`, no `shell=True`), so a line like `--flag value` must stay ONE
 * argv element if that's what the user meant; splitting it ourselves would
 * be exactly the shell-style re-interpretation the wire contract (`args:
 * string[]`, `MCPServerCreate`) is designed to avoid.
 */
export function parseArgsLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface ParseEnvOk {
  ok: true;
  env: Record<string, string>;
}
export interface ParseEnvError {
  ok: false;
  error: string;
}
export type ParseEnvResult = ParseEnvOk | ParseEnvError;

/**
 * Task A7 (§4.9): `KEY=VALUE` per line (blank lines skipped). The FIRST `=`
 * on a line splits — a value may itself contain `=` — so `B=x=y` parses as
 * `{B: 'x=y'}`, never truncated at the first occurrence found anywhere. A
 * line with no `=` at all is malformed and fails the WHOLE parse closed
 * (§F-7: env values are plaintext-warned but never silently partial —
 * either every line the user wrote is honored, or none is submitted).
 */
export function parseEnvLines(text: string): ParseEnvResult {
  const env: Record<string, string> = {};
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq < 0) return { ok: false, error: `"${line}" is not KEY=VALUE.` };
    const key = line.slice(0, eq).trim();
    if (!key) return { ok: false, error: `"${line}" is missing a key.` };
    env[key] = line.slice(eq + 1);
  }
  return { ok: true, env };
}

export interface TestNotice {
  tone: 'ok' | 'error';
  text: string;
}

/**
 * Task A7 (§4.9): maps the `mcp.test`/`mcp.auth` envelope honestly.
 * `{ok:false, error}` passes the Hermes-authored guidance text through
 * VERBATIM — Invariant #3's exemption for 200-envelope fields, not a raw
 * HTTP body (`web_server.py:10537-10542`).
 */
export function testNotice(result: McpTestResult): TestNotice {
  if (result.ok) return { tone: 'ok', text: `Connected — ${result.tools.length} tools` };
  return { tone: 'error', text: result.error ?? 'Test failed.' };
}

/**
 * Task A8 (§4.8): maps the `mcp.auth` envelope honestly — same shape and
 * same "pass the Hermes-authored `error` text through verbatim" posture as
 * {@link testNotice} (Invariant #3's 200-envelope exemption), including the
 * honest cancel text (`ControlDispatcher.ts`'s `AbortSignal` branch) which
 * must reach the user unmodified, not just its `{ok:false}` siblings.
 */
export function authNotice(result: McpTestResult): TestNotice {
  if (result.ok) return { tone: 'ok', text: `Authorized — ${result.tools.length} tools` };
  return { tone: 'error', text: result.error ?? 'Sign-in failed.' };
}

/**
 * Task A8 (§4.7): the two badges a catalog row renders beyond its name/
 * description/transport — `needs_install` (renamed `build` here to match the
 * amber "builds from source" pill it drives) and `installed`. Kept as a pure
 * mapping (not inlined in JSX) so `McpPanel.test.ts` can exercise the
 * decision without jsdom, same posture as `testNotice`/`authNotice`.
 */
export function catalogRowBadges(entry: McpCatalogEntry): { build: boolean; installed: boolean } {
  return { build: entry.needs_install, installed: entry.installed };
}

interface McpPanelProps {
  data: McpData;
  /** Correlated reload — resolves with the gateway's reload result, or rejects. */
  onReload: () => Promise<unknown>;
  /** Correlated `mcp.add` — resolves with the validated `{ok:true,name,transport}`, or rejects with the refusal. */
  onAdd: (params: McpAddParams) => Promise<McpAddResult>;
  /** Correlated `mcp.test` — ALWAYS resolves with the connect envelope (F-8: no modal, no reject on `{ok:false}`); a genuine transport failure still rejects. */
  onTest: (name: string) => Promise<McpTestResult>;
  /** Correlated `mcp.remove` — the HOST renders the consent modal; this call only summons it. */
  onRemove: (name: string) => Promise<unknown>;
  /** Correlated `mcp.setEnabled`, driven through {@link useToggle} for optimistic+rollback. */
  onSetEnabled: (name: string, enabled: boolean) => Promise<unknown>;
  /** Correlated `mcp.auth` — drives the per-row `Login` button (task A8, §4.8) on `transport === 'http'` rows. */
  onAuth: (name: string) => Promise<McpTestResult>;
  /** Correlated `mcp.catalog` (task A8, §4.7) — read-only, not trust-gated. Fired exactly once, on the Catalog disclosure's first expand. */
  onCatalog: () => Promise<McpCatalogData>;
  /** Correlated `mcp.catalogInstall` (task A8, §4.7) — the HOST renders the build-consent modal; this call only summons it. */
  onCatalogInstall: (params: McpCatalogInstallParams) => Promise<McpCatalogInstallResult>;
}

/** A user-facing notice derived from the reload outcome. */
interface ReloadNotice {
  tone: 'ok' | 'error';
  text: string;
}

/**
 * Turn the gateway's reload result into a notice. `reload.mcp` returns
 * `{status: 'reloaded'|'confirm_required', message?}` (`tui_gateway/server.py:
 * 11148-11221`). Since the host sends `confirm:true`, the normal outcome is
 * `reloaded`; we still surface `message` verbatim when present so the server's
 * own words show through.
 */
function interpretReload(result: unknown): ReloadNotice {
  const r = (result ?? {}) as { status?: unknown; message?: unknown };
  const message = typeof r.message === 'string' && r.message ? r.message : undefined;
  if (r.status === 'reloaded') return { tone: 'ok', text: message ?? 'MCP servers reloaded.' };
  if (r.status === 'confirm_required') {
    return { tone: 'error', text: message ?? 'Reload needs confirmation.' };
  }
  return { tone: 'ok', text: message ?? 'Reload requested.' };
}

/** `fallback` lets each call site keep its own honest default (A7: Reload/Test/Remove/Add each name their own action). */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : fallback;
}

/** Task A7: the `SetupPanel.tsx:457-486` label+input TextField pattern, copied
 *  locally (no shared component exists to import — same posture as this
 *  file's own plain `<button>`s). */
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

/** Task A7: the textarea sibling of {@link TextField} — same classes, for
 *  Args (one per line) / Env (`KEY=VALUE` per line). */
function TextAreaField({
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
      <textarea
        value={value}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-overlay px-2 py-1 font-mono text-2xs text-fg"
      />
    </label>
  );
}

/**
 * Task A7 (§4.9): the "Add server" disclosure — collapsed by default (a
 * `ReasoningBlock.tsx`-style `aria-expanded` button, same dashed-border
 * grammar as this panel's own "Reload servers" button). Name; transport
 * radio Stdio/HTTP; Stdio -> Command + Args + Env, HTTP -> URL. Submit calls
 * `onAdd`; on resolve it hands the ADDED name (the server's own, not
 * necessarily the locally-typed one) to `onAdded` so the panel can auto-fire
 * `mcp.test` (Layer 6 honesty: "added" is not "reachable" until we checked);
 * on reject it renders the refusal locally, in this form's own notice —
 * there is no row yet for a rejected add to attach to.
 */
function AddServerDisclosure({
  onAdd,
  onAdded,
}: {
  onAdd: McpPanelProps['onAdd'];
  onAdded: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const resetFields = () => {
    setName('');
    setCommand('');
    setArgsText('');
    setEnvText('');
    setUrl('');
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (adding) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }

    let params: McpAddParams;
    if (transport === 'stdio') {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        setError('Command is required.');
        return;
      }
      const envResult = parseEnvLines(envText);
      if (!envResult.ok) {
        setError(envResult.error);
        return;
      }
      params = {
        name: trimmedName,
        transport: 'stdio',
        command: trimmedCommand,
        args: parseArgsLines(argsText),
        env: envResult.env,
      };
    } else {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setError('URL is required.');
        return;
      }
      params = { name: trimmedName, transport: 'http', url: trimmedUrl };
    }

    setAdding(true);
    setError(undefined);
    void onAdd(params).then(
      (result) => {
        setAdding(false);
        resetFields();
        setOpen(false);
        onAdded(result.name);
      },
      (err: unknown) => {
        setAdding(false);
        setError(errorMessage(err, 'Add failed.'));
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
        Add server
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="ml-auto" />
      </button>
      {open && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border px-3 py-3">
          <TextField label="Name" value={name} onChange={setName} placeholder="my-server" />

          <fieldset className="flex items-center gap-3">
            <legend className="sr-only">Transport</legend>
            <label className="flex items-center gap-1.5 font-mono text-2xs text-muted">
              <input
                type="radio"
                name="mcp-add-transport"
                checked={transport === 'stdio'}
                onChange={() => setTransport('stdio')}
              />
              Stdio
            </label>
            <label className="flex items-center gap-1.5 font-mono text-2xs text-muted">
              <input
                type="radio"
                name="mcp-add-transport"
                checked={transport === 'http'}
                onChange={() => setTransport('http')}
              />
              HTTP
            </label>
          </fieldset>

          {transport === 'stdio' ? (
            <>
              <TextField label="Command" value={command} onChange={setCommand} placeholder="npx" />
              <TextAreaField
                label="Args (one per line)"
                value={argsText}
                onChange={setArgsText}
                placeholder={'-y\n@scope/pkg'}
              />
              <TextAreaField
                label="Env (KEY=VALUE per line)"
                value={envText}
                onChange={setEnvText}
                placeholder={'API_KEY=...'}
              />
            </>
          ) : (
            <TextField label="URL" value={url} onChange={setUrl} placeholder="https://example.com/mcp" />
          )}

          <LiveRegion text={error ?? ''} className="sr-only" />
          {error && (
            <div className="flex items-start gap-1.5 rounded border border-del bg-del-soft px-2 py-1 text-2xs text-fg">
              <Icon name="error" size={11} className="mt-0.5 flex-none text-del" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={adding}
            className="mt-1 flex items-center justify-center gap-1.5 self-start rounded border border-border px-3 py-1 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60"
          >
            <Icon name={adding ? 'loading' : 'add'} size={12} spin={adding} />
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}
    </div>
  );
}

/** A row-scoped notice card, shared by the Test and Remove buttons —
 *  mirrors the panel-level reload notice's sr-only-LiveRegion + colored-card
 *  pair (`interpretReload`'s rendering, below), just addressed per server
 *  name instead of once for the whole panel. */
function RowNoticeCard({ notice }: { notice: TestNotice | undefined }) {
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

/**
 * Task A8 (§4.7): the "Catalog" disclosure at the bottom of `McpPanel` —
 * collapsed by default. The FIRST expand fires `onCatalog` exactly once
 * (guarded by `fetched`, set synchronously in the SAME click handler that
 * starts the request, before the `await` — a second click inside the same
 * render can't race past it); later collapse/expand cycles reuse the already-
 * fetched `entries`, never refetching. Each row renders one `TextField` per
 * `required_env` var (env VALUES live only in this component's own state —
 * collected, never logged, sent once on `Install`) and surfaces the install
 * outcome through the same `RowNoticeCard` + `LiveRegion` pattern the server
 * rows use for Test/Remove, addressed by the catalog entry's own name.
 */
function CatalogDisclosure({
  onCatalog,
  onCatalogInstall,
}: {
  onCatalog: McpPanelProps['onCatalog'];
  onCatalogInstall: McpPanelProps['onCatalogInstall'];
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<McpCatalogEntry[]>([]);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [envValues, setEnvValues] = useState<Record<string, Record<string, string>>>({});
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [rowNotice, setRowNotice] = useState<Record<string, TestNotice>>({});

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || fetched) return;
    setFetched(true);
    setLoading(true);
    void onCatalog()
      .then(
        (result) => setEntries(result.entries),
        (err: unknown) => setFetchError(errorMessage(err, 'Failed to load the catalog.')),
      )
      .finally(() => setLoading(false));
  };

  const setEnvValue = (entryName: string, envKey: string, value: string) => {
    setEnvValues((all) => ({ ...all, [entryName]: { ...all[entryName], [envKey]: value } }));
  };

  const handleInstall = (entry: McpCatalogEntry) => {
    const env: Record<string, string> = {};
    for (const v of entry.required_env) {
      env[v.name] = envValues[entry.name]?.[v.name] ?? '';
    }
    setInstalling((m) => ({ ...m, [entry.name]: true }));
    void onCatalogInstall({ name: entry.name, env })
      .then(
        // TG-2 (AU-49, ADR-4): the gateway reload this triggers is real for
        // the config plane + gateway sessions, but the LIVE editor chat only
        // picks up `config.mcp_servers` at its next agent build — the panel
        // refetch showing this server "Installed" must not imply the open
        // chat sees it too.
        (result) =>
          setRowNotice((n) => ({
            ...n,
            [entry.name]: { tone: 'ok', text: `Installed "${result.name}". ${APPLIES_NEXT_SESSION}` },
          })),
        (err: unknown) =>
          setRowNotice((n) => ({ ...n, [entry.name]: { tone: 'error', text: errorMessage(err, 'Install failed.') } })),
      )
      .finally(() => setInstalling((m) => ({ ...m, [entry.name]: false })));
  };

  return (
    <div className="mt-2 overflow-hidden rounded-card border border-dashed border-border">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-2xs uppercase tracking-wide text-muted hover:text-accent"
      >
        <Icon name="package" size={13} />
        Catalog
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="ml-auto" />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
          {loading && <div className="font-mono text-2xs text-muted">Loading catalog…</div>}
          {fetchError && (
            <div className="flex items-start gap-1.5 rounded border border-del bg-del-soft px-2 py-1 text-2xs text-fg">
              <Icon name="error" size={11} className="mt-0.5 flex-none text-del" />
              <span className="min-w-0 flex-1 break-words">{fetchError}</span>
            </div>
          )}
          {!loading && !fetchError && entries.length === 0 && (
            <div className="font-mono text-2xs text-faint">No catalog entries.</div>
          )}
          {entries.map((entry) => {
            const badges = catalogRowBadges(entry);
            const rowInstalling = installing[entry.name] === true;
            return (
              <div key={entry.name} className="rounded-card border border-border bg-surface px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Icon name="package" size={15} className="flex-none text-accent" />
                  <span className="min-w-0 truncate font-mono text-xs text-fg">{entry.name}</span>
                  <span className="ml-auto flex flex-none items-center gap-1.5">
                    <Pill>{entry.transport}</Pill>
                    {badges.installed && (
                      <Pill tone="add" icon="check">
                        Installed
                      </Pill>
                    )}
                    {badges.build && (
                      <Pill tone="warn" icon="tools">
                        builds from source
                      </Pill>
                    )}
                  </span>
                </div>
                {entry.description && (
                  <div className="mt-1 font-mono text-2xs text-faint">{entry.description}</div>
                )}

                {entry.required_env.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {entry.required_env.map((v) => (
                      <div key={v.name} className="flex flex-col gap-0.5">
                        <TextField
                          label={v.prompt}
                          value={envValues[entry.name]?.[v.name] ?? ''}
                          onChange={(next) => setEnvValue(entry.name, v.name, next)}
                        />
                        <span className="font-mono text-2xs text-faint">Saved to Hermes' .env</span>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => handleInstall(entry)}
                  disabled={rowInstalling}
                  className="mt-2 flex items-center gap-1.5 rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:cursor-default disabled:opacity-50"
                >
                  <Icon name={rowInstalling ? 'loading' : 'cloud-download'} size={12} spin={rowInstalling} />
                  {rowInstalling ? 'Installing…' : 'Install'}
                </button>
                <RowNoticeCard notice={rowNotice[entry.name]} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function McpPanel({ data, onReload, onAdd, onTest, onRemove, onSetEnabled, onAuth, onCatalog, onCatalogInstall }: McpPanelProps) {
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<ReloadNotice | undefined>();
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const [authing, setAuthing] = useState<Record<string, boolean>>({});
  const [rowNotice, setRowNotice] = useState<Record<string, TestNotice>>({});
  const { isOn, toggle, lastError } = useToggle(onSetEnabled);

  const handleReload = () => {
    setReloading(true);
    setNotice(undefined);
    void onReload()
      .then(
        (result) => setNotice(interpretReload(result)),
        (err: unknown) => setNotice({ tone: 'error', text: errorMessage(err, 'Reload failed.') }),
      )
      .finally(() => setReloading(false));
  };

  /** Task A7: shared by each row's Test button AND the Add form's
   *  auto-fired post-add test (Layer 6 — "added" is not "reachable" until
   *  we checked). Addressed by server NAME (the RPC's own key), so a notice
   *  set for a name that isn't rendered yet (the Add form's brand-new
   *  server, before the next `panel.data` push lands it) still shows the
   *  instant that row appears — `rowNotice` outlives this render. */
  const handleTest = (name: string) => {
    setTesting((t) => ({ ...t, [name]: true }));
    setRowNotice((n) => {
      if (!(name in n)) return n;
      const next = { ...n };
      delete next[name];
      return next;
    });
    void onTest(name)
      .then(
        (result) => setRowNotice((n) => ({ ...n, [name]: testNotice(result) })),
        (err: unknown) =>
          setRowNotice((n) => ({ ...n, [name]: { tone: 'error', text: errorMessage(err, 'Test failed.') } })),
      )
      .finally(() => setTesting((t) => ({ ...t, [name]: false })));
  };

  /** Task A7: the click only SUMMONS the host's native consent modal — a
   *  decline resolves as a rejection ("...was declined or cancelled.",
   *  `ControlDispatcher.ts` `mcpRemove`) and is surfaced the same honest way
   *  a real failure would be. A successful remove shows nothing here: the
   *  host's own `fetchPanelData('mcp')` (run before it resolves) has
   *  already pushed the row's absence, so the row disappearing IS the
   *  confirmation. */
  const handleRemove = (name: string) => {
    setRemoving((r) => ({ ...r, [name]: true }));
    void onRemove(name)
      .then(
        () => {
          setRowNotice((n) => {
            if (!(name in n)) return n;
            const next = { ...n };
            delete next[name];
            return next;
          });
        },
        (err: unknown) =>
          setRowNotice((n) => ({ ...n, [name]: { tone: 'error', text: errorMessage(err, 'Remove failed.') } })),
      )
      .finally(() => setRemoving((r) => ({ ...r, [name]: false })));
  };

  /** Task A8 (§4.8): the per-row `Login` button on `transport === 'http'`
   *  rows. Same LiveRegion + `RowNoticeCard` addressing as Test/Remove above
   *  — the resolved envelope (`{ok:true}` or the honest `{ok:false, error}`,
   *  including a cancel) lands in the SAME row notice, mapped through
   *  {@link authNotice}. The host's `withProgress` owns the actual
   *  "waiting for the browser" UX; this button's own pending label is the
   *  panel-local echo of that wait. */
  const handleAuth = (name: string) => {
    setAuthing((a) => ({ ...a, [name]: true }));
    setRowNotice((n) => {
      if (!(name in n)) return n;
      const next = { ...n };
      delete next[name];
      return next;
    });
    void onAuth(name)
      .then(
        (result) => setRowNotice((n) => ({ ...n, [name]: authNotice(result) })),
        (err: unknown) =>
          setRowNotice((n) => ({ ...n, [name]: { tone: 'error', text: errorMessage(err, 'Sign-in failed.') } })),
      )
      .finally(() => setAuthing((a) => ({ ...a, [name]: false })));
  };

  return (
    <PanelShell title="Active MCP servers" meta={`${data.servers.length} configured`}>
      {data.servers.map((srv) => {
        const s = totalLookup(STATUS, srv.status, UNKNOWN_MCP_STATUS);
        const rowTesting = testing[srv.name] === true;
        const rowRemoving = removing[srv.name] === true;
        const rowAuthing = authing[srv.name] === true;
        const toggleErr = lastError(srv.name);
        return (
          <div key={srv.id} className="mb-2 rounded-card border border-border bg-surface px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Icon name="server-process" size={15} className="flex-none text-accent" />
              <span className="min-w-0 truncate font-mono text-xs text-fg">{srv.name}</span>
              <span className="ml-auto flex flex-none items-center gap-2">
                <Pill tone={s.tone} icon={s.icon}>
                  {s.label}
                </Pill>
                <Toggle
                  on={isOn(srv.name, srv.enabled)}
                  label={`Enable ${srv.name}`}
                  onChange={(next) => toggle(srv.name, next)}
                />
              </span>
            </div>
            <div className="mt-1.5 truncate font-mono text-2xs text-faint" title={srv.command}>
              {srv.command}
            </div>
            <div className="mt-1 font-mono text-2xs uppercase tracking-wide text-faint">
              {srv.toolCount} tools
            </div>

            {/* V-11 (TOGGLE-HONESTY) grammar, exactly as SkillsPanel.tsx uses
                it: a rejected `mcp.setEnabled` rolls the switch back and
                names why, through this permanently-mounted LiveRegion. */}
            <LiveRegion
              text={toggleErr ? `Not saved: ${toggleErr}` : ''}
              className="mt-1 text-2xs text-del"
              title={toggleErr}
            />

            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleTest(srv.name)}
                disabled={rowTesting}
                className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:cursor-default disabled:opacity-50"
              >
                <Icon name={rowTesting ? 'loading' : 'beaker'} size={12} spin={rowTesting} />
                {rowTesting ? 'Testing…' : 'Test'}
              </button>
              <button
                type="button"
                onClick={() => handleRemove(srv.name)}
                disabled={rowRemoving}
                className="flex items-center gap-1.5 rounded border border-del px-2 py-0.5 font-mono text-2xs text-del hover:bg-del-soft disabled:cursor-default disabled:opacity-50"
              >
                <Icon name={rowRemoving ? 'loading' : 'trash'} size={12} spin={rowRemoving} />
                {rowRemoving ? 'Removing…' : 'Remove'}
              </button>
              {/* Task A8 (§4.8): OAuth login only makes sense for HTTP-transport
                  servers — stdio servers "authenticate via env keys, not OAuth"
                  (`web_server.py:10568-10572`), which is exactly why the
                  dispatcher itself 400s a stdio `mcp.auth` call; gating the
                  button here keeps the panel from ever offering an action the
                  host would refuse. */}
              {srv.transport === 'http' && (
                <button
                  type="button"
                  onClick={() => handleAuth(srv.name)}
                  disabled={rowAuthing}
                  className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 font-mono text-2xs text-muted hover:bg-overlay disabled:cursor-default disabled:opacity-50"
                >
                  <Icon name={rowAuthing ? 'loading' : 'sign-in'} size={12} spin={rowAuthing} />
                  {rowAuthing ? 'Waiting for browser sign-in…' : 'Login'}
                </button>
              )}
            </div>
            <RowNoticeCard notice={rowNotice[srv.name]} />
          </div>
        );
      })}

      <AddServerDisclosure onAdd={onAdd} onAdded={handleTest} />
      <CatalogDisclosure onCatalog={onCatalog} onCatalogInstall={onCatalogInstall} />

      {/* `display:contents` (Tailwind `contents`): this `<section>` takes no
          part in layout — every child still lays out directly inside
          PanelShell's own flex column, byte-identical to before A7 — it
          exists purely so a query can scope to "the Reload notice + button"
          without also matching each server row's OWN `role="status"`
          region above (`within(section).getByRole('status')`, the same
          idiom `SettingsPanel.dom.test.tsx` uses for its per-row regions). */}
      <section className="contents">
        {/* Reload result / error surfaced inline (A#5). T-15/F6: the
            screen-reader announcement is carried by the permanently-mounted
            `LiveRegion` below (Finding-7 discipline — the region itself must
            never be conditionally mounted, only its text swaps); the colored
            card here is the sighted-user rendering of the same notice and no
            longer carries its own role="status", which would double-announce
            the same text. */}
        <LiveRegion text={notice?.text ?? ''} className="sr-only" />
        {notice && (
          <div
            className={`mt-1 flex items-start gap-2 rounded-card border px-3 py-2 text-2xs ${
              notice.tone === 'ok'
                ? 'border-border bg-surface text-muted'
                : 'border-del bg-del-soft text-fg'
            }`}
          >
            <Icon
              name={notice.tone === 'ok' ? 'check' : 'error'}
              size={13}
              className={`mt-0.5 flex-none ${notice.tone === 'ok' ? 'text-accent' : 'text-del'}`}
            />
            <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          </div>
        )}

        {/* Real reload: the gateway gates `reload.mcp` behind a confirm
            (`approvals.mcp_reload_confirm`, default true) and returns
            `{status:'confirm_required'}` with no `confirm` — so the click IS the
            confirmation. `confirm:true` makes it actually reload
            (`tui_gateway/server.py:11148-11221`), after which the host re-fetches
            the panel. The correlated request lets us show the result above. */}
        <button
          type="button"
          onClick={handleReload}
          disabled={reloading}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 font-mono text-2xs uppercase tracking-wide text-muted hover:border-accent hover:text-accent disabled:cursor-default disabled:opacity-60 disabled:hover:border-border disabled:hover:text-muted"
        >
          <Icon name={reloading ? 'loading' : 'refresh'} size={13} spin={reloading} />
          {reloading ? 'Reloading…' : 'Reload servers'}
        </button>
      </section>
    </PanelShell>
  );
}
