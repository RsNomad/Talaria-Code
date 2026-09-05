import type {
  McpAddParams,
  McpAddResult,
  McpCatalogData,
  McpCatalogEntry,
  McpCatalogInstallResult,
  McpTestResult,
  DataPanel,
} from '../../../shared/protocol';
import type { DashboardAdminClient, DashboardEnvRow } from '../../dashboard/HermesDashboardClient';
import { hasToggleNameCache } from '../../dashboard/dashboardPanelSources';
import {
  validateMcpAdd,
  describeAddForModal,
  stripModalControls,
  validateCatalogInstall,
  describeCatalogForModal,
  extractMcpEnabled,
  RELOAD_LINE,
  secretEnvKeyFor,
  envReference,
  checkSecretValue,
} from './mcpEntryValidation';
import type { ConfigWriteTail } from './configWriteTail';
import { runAdminOp, resolveDashboardAdminClient, pollActionUntilVerified, TRUST_GATED_METHODS, POLL_UNCONFIRMED_MESSAGE } from './adminOpRunner';
import type { ControlDispatcherHostPort } from './ControlDispatcher';
import { isRecord } from '../../../shared/typeGuards';

/** The 7 MCP admin methods {@link ControlDispatcher.handleMcpAdmin} routes (A5: add/remove/setEnabled/test/auth; A6: catalog/catalogInstall). */
export type McpAdminMethod = 'mcp.add' | 'mcp.remove' | 'mcp.setEnabled' | 'mcp.test' | 'mcp.auth' | 'mcp.catalog' | 'mcp.catalogInstall';

export function isMcpAdminMethod(method: string): method is McpAdminMethod {
  return (
    method === 'mcp.add' ||
    method === 'mcp.remove' ||
    method === 'mcp.setEnabled' ||
    method === 'mcp.test' ||
    method === 'mcp.auth' ||
    method === 'mcp.catalog' ||
    method === 'mcp.catalogInstall'
  );
}

/**
 * WS-GD.2a A6: the narrowed slice of {@link ControlDispatcherHostPort} the
 * mcp-admin domain actually reads — every member `handle` (and the private
 * methods it routes to) touches, and nothing else.
 */
export type McpAdminPort = Pick<
  ControlDispatcherHostPort,
  'dispatch' | 'logger' | 'panelSources' | 'getDashboard' | 'isTrusted' | 'confirm' | 'promptSecret' | 'withProgress'
>;

/**
 * WS-GD.2a A6: the T1 MCP admin domain — pure move off `ControlDispatcher`
 * behind the same `ControlDispatcherHostPort` slice ({@link McpAdminPort}),
 * the shared `ConfigWriteTail`, and a `refetchPanel` callback bound to the
 * dispatcher's `PanelDataCoordinator.fetchPanelData`. Zero behavior change —
 * see each member's own doc (moved verbatim) for the full rationale.
 */
export class McpAdminHandler {
  /**
   * Task A6 (§4.7 item 1): the last catalog LISTED this session — the
   * fail-closed guard `mcp.catalogInstall`'s {@link validateCatalogInstall}
   * checks a requested name against. `undefined` until this session's first
   * `mcp.catalog` call (mirrors the `mcp` panel's own `lastListedNames()`
   * fail-closed posture, {@link requireListedMcpName}).
   */
  private lastCatalogEntries: McpCatalogEntry[] | undefined;

  /**
   * F3 (widens A6 §4.7-item-3 / §4.8 IMPORTANT-3): per-NAME busy registry across ALL
   * name-scoped MCP mutations. Kind drives the refusal message and preserves the two
   * pinned duplicate messages verbatim. Test-and-set/release both live in {@link
   * acquireMcpSingleFlight}/{@link handleMcpAdmin}, checked SYNCHRONOUSLY before the
   * call joins {@link ConfigWriteTail} (see that method's own doc for why it
   * can't be checked inside the queued handler).
   */
  private readonly busyMcpNames = new Map<string, 'auth' | 'install' | 'change'>();

  constructor(
    private readonly port: McpAdminPort,
    private readonly tail: ConfigWriteTail,
    private readonly refetchPanel: (panel: DataPanel) => Promise<unknown>,
  ) {}

  /**
   * Task A5+A6 (§4.5, §4.7), branched by F3: the T1 MCP admin core. Every
   * SHORT config-mutating method (`mcp.add`/`remove`/`setEnabled`) still rides
   * the SAME host-side serialization tail as {@link toggleDashboard} ({@link
   * ConfigWriteTail}), so a compromised or buggy webview firing parallel
   * `control.request`s can't interleave two writes to the same underlying
   * `~/.hermes/config.yaml`. The four {@link TAIL_EXEMPT_MCP_METHODS}
   * (`mcp.catalog`/`mcp.test`/`mcp.auth`/`mcp.catalogInstall`) run
   * `handleMcpAdminInner` DIRECTLY, off the tail — none of them performs a
   * client-bracketable config write (see that const's own doc) — with
   * same-name exclusion carried by {@link busyMcpNames} instead of the tail.
   */
  async handle(method: McpAdminMethod, params: unknown): Promise<unknown> {
    // Task A6 (§4.7 item 3, §4.8 critic IMPORTANT-3): the per-name
    // single-flight test-and-set MUST happen here, synchronously, BEFORE this
    // call ever joins `ConfigWriteTail` — that tail serializes a queued
    // handler's FULL execution, so a duplicate call gated INSIDE the queued
    // handler would simply queue silently behind the in-flight one: by the
    // time it ran, the first would already be done and the guard would never
    // observe the overlap. A synchronous pre-check makes the refusal
    // immediate instead of a silent wait. This holds for BOTH branches below
    // — the exempt branch never queues at all, so the same reasoning applies
    // even more directly there.
    // WS-GD.2a A5: the acquire/tail-or-direct/release choreography itself
    // moved onto the shared {@link runAdminOp} primitive — behavior
    // unchanged (see that function's own doc).
    return runAdminOp({
      acquire: () => this.acquireMcpSingleFlight(method, params),
      tailExempt: TAIL_EXEMPT_MCP_METHODS.has(method),
      tail: this.tail,
      run: () => this.handleMcpAdminInner(method, params),
    });
  }

  /**
   * Task A6 (§4.7 item 3, §4.8 IMPORTANT-3), widened by F3: the single-flight
   * test-and-set for every name-scoped MCP mutation — see {@link
   * handleMcpAdmin}'s own doc for why this runs synchronously, before
   * queueing. `mcp.catalog` has no name and is never guarded; `mcp.test` only
   * CHECKS (probes never block each other, but a probe mid-auth/install would
   * read Hermes's deliberately-wiped token store and report a false
   * negative); every other name-scoped method acquires the name and returns a
   * release callback. `undefined` when the payload carries no usable name
   * (the real per-method handler rejects with a clearer validation message
   * once it runs).
   */
  private acquireMcpSingleFlight(method: McpAdminMethod, params: unknown): (() => void) | undefined {
    if (method === 'mcp.catalog') return undefined; // no name, never guarded
    const name = extractMcpName(params);
    if (!name) return undefined; // unchanged posture: real handler rejects with the clearer validation message
    const busy = this.busyMcpNames.get(name);
    if (busy !== undefined) {
      throw new Error(
        busy === 'auth'
          ? `Sign-in for "${name}" is already in progress.` // pinned (IMPORTANT-3 test)
          : busy === 'install'
            ? `Installing "${name}" is already in progress.` // pinned (F1 test)
            : `Another change to MCP server "${name}" is still in progress.`,
      );
    }
    if (method === 'mcp.test') return undefined; // check-only: probes never block each other
    const kind = method === 'mcp.auth' ? 'auth' : method === 'mcp.catalogInstall' ? 'install' : 'change';
    this.busyMcpNames.set(name, kind);
    return () => this.busyMcpNames.delete(name);
  }

  /**
   * Task A5+A6 (§3 Layer 5, §4.5 items 1-3, §4.7): trust gate -> admin-client
   * resolution -> the per-method route. `mcp.catalog` (no trust gate, §4.7)
   * and `mcp.add` (creating a NEW name) are the two methods with no name to
   * validate against the last-listed cache; every other method runs the
   * FAIL-CLOSED last-listed-name guard first.
   */
  private async handleMcpAdminInner(method: McpAdminMethod, params: unknown): Promise<unknown> {
    if (TRUST_GATED_METHODS.has(method) && !this.port.isTrusted()) {
      throw new Error(`Refusing '${method}': the workspace is not trusted — trust this workspace to manage MCP servers.`);
    }

    const client = await resolveDashboardAdminClient(() => this.port.getDashboard(), method);

    if (method === 'mcp.catalog') {
      return this.mcpCatalog(client);
    }

    if (method === 'mcp.add') {
      return this.mcpAdd(client, params);
    }

    if (method === 'mcp.catalogInstall') {
      return this.mcpCatalogInstall(client, params);
    }

    const name = extractMcpName(params);
    this.requireListedMcpName(method, name);

    switch (method) {
      case 'mcp.remove':
        return this.mcpRemove(client, name);
      case 'mcp.setEnabled':
        return this.mcpSetEnabled(client, name, extractMcpEnabled(params));
      case 'mcp.test':
        // F-8 CONFIRMED (§4.5 item 7): no modal, no reload — the envelope
        // (including an `{ok:false}` connect failure) is a RESOLVED result
        // the panel renders, never a rejection.
        return client.testMcpServer(name);
      case 'mcp.auth':
        return this.mcpAuth(client, name);
      default: {
        const exhaustive: never = method;
        throw new Error(`unhandled MCP admin method: ${String(exhaustive)}`);
      }
    }
  }

  // WS-GD.2a A5: `resolveDashboardAdminClient` moved onto `adminOpRunner.ts`
  // (its own doc moved there verbatim) — call sites below now pass a bound
  // `() => this.port.getDashboard()` thunk.

  /**
   * Task A5 (§3 Layer 5 critic IMPORTANT-2, §4.5 item 3): the FAIL-CLOSED
   * name-cache guard for `mcp.remove`/`mcp.setEnabled`/`mcp.test`/`mcp.auth`.
   * DELIBERATELY diverges from {@link toggleDashboardInner}'s lenient
   * `if (known && !known.has(name))` idiom: an UNFETCHED cache
   * (`lastListedNames()` returns `undefined` — the `mcp` panel was never
   * listed this host session) is a REFUSAL here, not a skip. `mcp.setEnabled`
   * has no modal, so this cache is its ONLY gate — without the fail-closed
   * rule a compromised webview's FIRST message could toggle an arbitrary
   * server before any panel render ever populated the cache.
   */
  private requireListedMcpName(method: string, name: string | undefined): asserts name is string {
    if (!name) {
      throw new Error(`'${method}' requires a { name } payload.`);
    }
    const source = this.port.panelSources.get('mcp');
    const known = hasToggleNameCache(source) ? source.lastListedNames() : undefined;
    if (known === undefined) {
      throw new Error(`Refusing '${method}': the MCP panel has not been listed yet — open it first.`);
    }
    if (!known.has(name)) {
      throw new Error(`${method}: '${name}' is not in the last-listed MCP servers.`);
    }
  }

  /**
   * Task A5 (§4.5 item 4): `validateMcpAdd` -> `describeAddForModal` (an
   * `ok:false` ceiling refusal REJECTS here, before any modal) -> the native
   * consent modal -> `addMcpServer` -> `reload.mcp{confirm:true}` -> an `mcp`
   * panel refetch -> `{ok:true, name, transport}` (`transport` is the
   * VALIDATED discriminant — see the `McpAddResult` doc, protocol.ts). `env`
   * VALUES pass through `validated.body` exactly once and are never logged.
   *
   * AU-59 (CF-13 parity for the manual add, ADR-023): when the validated
   * params carry `secretEnvNames`, the values are collected HERE, host-side
   * and masked ({@link McpAdminPort.promptSecret}), ONLY after consent — a
   * dismissed/blank/non-ASCII answer for ANY name declines the WHOLE add
   * before any network call ({@link collectSecretEnv}). Then
   * {@link addWithSecretEnv} runs the CONFIG-FIRST, fail-closed sequence.
   * Still rides `ConfigWriteTail` unchanged: the consent modal already holds
   * the tail while the user reads; the secret prompts extend that same held
   * window (no new class of blocking). The result shape is unchanged.
   */
  private async mcpAdd(client: DashboardAdminClient, params: unknown): Promise<McpAddResult> {
    const validated = validateMcpAdd(params);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const transport = extractValidatedAddTransport(params);
    const described = describeAddForModal(toMcpAddParams(validated.body, transport, validated.secretEnvNames));
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(described.message, described.detail, 'Add server');
    if (!confirmed) {
      throw new Error(`Adding MCP server "${validated.body.name}" was declined or cancelled.`);
    }
    const secrets = await this.collectSecretEnv(validated.body.name, validated.secretEnvNames);
    if (secrets.length === 0) {
      await client.addMcpServer(validated.body);
    } else {
      await this.addWithSecretEnv(client, validated.body, secrets);
    }
    await this.reloadMcpAndRefetch();
    return { ok: true, name: validated.body.name, transport };
  }

  /**
   * AU-59: the masked prompt loop — mirrors {@link mcpCatalogInstall}'s
   * (consent first; dismiss or blank = decline the WHOLE add) plus the
   * client-side value gate ({@link checkSecretValue}: `save_env_value`
   * silently strips non-ASCII, so a lookalike-glyph paste would persist
   * MANGLED — refuse it before anything is written). The prompt text carries
   * only the server name (NAME_PATTERN-safe) and env/.env key names, so it
   * needs no control-byte strip. Returns the values ONLY to the caller's
   * stack — nothing is stored on `this`.
   */
  private async collectSecretEnv(serverName: string, names: readonly string[]): Promise<CollectedSecret[]> {
    const collected: CollectedSecret[] = [];
    for (const name of names) {
      const key = secretEnvKeyFor(serverName, name);
      const value = await this.port.promptSecret(`"${serverName}": value for ${name} (saved to ~/.hermes/.env as ${key})`);
      if (value === undefined || value === '') {
        throw new Error(`Adding MCP server "${serverName}" was declined or cancelled.`);
      }
      const checked = checkSecretValue(value);
      if (!checked.ok) {
        throw new Error(`Refusing the value for ${name}: ${checked.reason} Nothing was saved.`);
      }
      collected.push({ name, key, value: checked.value });
    }
    return collected;
  }

  /**
   * AU-59 (ADR-023) — CONFIG-FIRST, fail-closed:
   *  (1) `POST /api/mcp/servers` with `env = plaintext ∪ { name: "${key}" }`
   *      — the secret literal NEVER enters config.yaml, only the reference.
   *      Every Hermes-side refusal that can fire on an add (409 name exists,
   *      400 `validate_mcp_server_entry` IOC/shape) fires HERE, before any
   *      secret is written anywhere.
   *  (2) `PUT /api/env` per secret under `MCP_<NAME>_<KEY>`.
   *  (3) Layer 6: `GET /api/env` must list EVERY key `is_set:true` —
   *      managed/container mode answers (2) with `{ok:true}` while writing
   *      nothing (`save_env_value` → `is_managed()` early return).
   *  On ANY failure in (2)/(3): {@link compensateSecretAdd} — `DELETE
   *  /api/env` for every key already written (secret residue first), then
   *  `DELETE /api/mcp/servers/{name}` — so nothing half-registered and no
   *  secret persisted remains; the thrown message names keys only, the
   *  underlying cause goes to the output channel. The reverse order (env
   *  first) was rejected: a 409 on the POST would then already have
   *  overwritten a same-named `.env` key, and a crash between the steps would
   *  leave the SECRET as the residue rather than a secret-free `${…}`
   *  reference.
   */
  private async addWithSecretEnv(
    client: DashboardAdminClient,
    body: { name: string; command?: string; args?: string[]; env?: Record<string, string> },
    secrets: readonly CollectedSecret[],
  ): Promise<void> {
    const env: Record<string, string> = { ...(body.env ?? {}) };
    for (const s of secrets) env[s.name] = envReference(s.key);
    await client.addMcpServer({ ...body, env });

    const written: string[] = [];
    try {
      for (const s of secrets) {
        await client.setEnvVar(s.key, s.value);
        written.push(s.key);
      }
      const rows = await client.listEnvKeys();
      const missing = secrets.map((s) => s.key).filter((key) => !isEnvKeySet(rows, key));
      if (missing.length > 0) {
        throw new SecretEnvNotPersistedError(missing);
      }
    } catch (err) {
      this.port.logger?.append(`[AcpBackend] mcp.add "${body.name}": secret env step failed — rolling back: ${errorMessage(err)}`);
      const compensation = await this.compensateSecretAdd(client, body.name, written);
      throw new Error(secretAddRollbackMessage(body.name, err, compensation));
    }
  }

  /**
   * AU-59 compensation — best-effort, log-only per step, keys only. Removes
   * the secret residue FIRST (the `.env` keys already written), then the
   * server entry. Returns whether the entry came out AND which `.env` keys'
   * DELETE also rejected (stranded — the secret VALUE may still be at rest);
   * a leftover entry holds only `${…}` references (no secret), so the caller
   * discloses both facts and the user cleans up manually.
   */
  private async compensateSecretAdd(
    client: DashboardAdminClient,
    name: string,
    written: readonly string[],
  ): Promise<{ serverRemoved: boolean; stranded: string[] }> {
    const stranded: string[] = [];
    for (const key of written) {
      try {
        await client.removeEnvVar(key);
      } catch (err) {
        stranded.push(key);
        this.port.logger?.append(`[AcpBackend] mcp.add "${name}" rollback: could not remove .env key ${key}: ${errorMessage(err)}`);
      }
    }
    try {
      await client.removeMcpServer(name);
      return { serverRemoved: true, stranded };
    } catch (err) {
      this.port.logger?.append(`[AcpBackend] mcp.add "${name}" rollback: could not remove the server entry: ${errorMessage(err)}`);
      return { serverRemoved: false, stranded };
    }
  }

  /** Task A5 (§4.5 item 5): confirm -> `removeMcpServer` -> reload -> refetch. */
  private async mcpRemove(client: DashboardAdminClient, name: string): Promise<unknown> {
    const message = stripModalControls(`Remove MCP server "${name}"?`);
    const confirmed = await this.port.confirm(message, RELOAD_LINE, 'Remove');
    if (!confirmed) {
      throw new Error(`Removing MCP server "${name}" was declined or cancelled.`);
    }
    const result = await client.removeMcpServer(name);
    await this.reloadMcpAndRefetch();
    return result;
  }

  /**
   * Task A6 (§4.7 item 1): read-only, NOT trust-gated — "same class as
   * `tools.list`" (§4.7). Caches the returned rows on {@link
   * lastCatalogEntries} so `mcp.catalogInstall`'s fail-closed name guard has
   * a session-scoped, server-authored set to check against (never the
   * webview's own claim).
   */
  private async mcpCatalog(client: DashboardAdminClient): Promise<McpCatalogData> {
    const data = await client.listMcpCatalog();
    this.lastCatalogEntries = data.entries;
    return data;
  }

  /**
   * Task A6 (§4.7 items 2-4), reworked by Rev-1 B4 (CF-13 parity, TH-4 —
   * SUPERSEDES the old A3-IMP2 binding): `validateCatalogInstall` against
   * the last-LISTED catalog (fail-closed — `mcp.catalog` was never called
   * this session -> `lastCatalogEntries` is `undefined` -> the entry lookup
   * finds nothing) -> `describeCatalogForModal(entry)` (a FUTURE-TENSE
   * disclosure driven by the entry's OWN `required_env` schema — the
   * webview submits NO env at all anymore, so there is nothing "submitted"
   * left to reflect) -> native consent ({@link ControlDispatcherHostPort
   * .confirm}). ONLY AFTER `confirmed`: for EACH `entry.required_env` var,
   * the masked host-side prompt ({@link ControlDispatcherHostPort
   * .promptSecret}) — a dismissed OR blank answer for ANY var is a DECLINE
   * of the WHOLE install (no partial install, `installCatalogEntry` never
   * called) — THEN `installCatalogEntry` with the collected values. CF-13:
   * keys never enter the webview; this method is the host-side gate that
   * collects them, masked, after consent. A synchronous (`background:
   * false`) install resolves immediately; a background (git-bootstrap)
   * install is handed to {@link pollCatalogInstall} for the ground-truth-
   * verified wait (Layer 6). Single-flight per entry name is enforced by
   * the CALLER ({@link handleMcpAdmin}'s synchronous {@link
   * acquireMcpSingleFlight}) — this method never re-checks it.
   */
  private async mcpCatalogInstall(client: DashboardAdminClient, params: unknown): Promise<McpCatalogInstallResult> {
    const validated = validateCatalogInstall(params, this.lastCatalogEntries ?? []);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const { entry } = validated;
    const described = describeCatalogForModal(entry);
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(
      described.message,
      described.detail,
      entry.needs_install ? 'Install & build' : 'Install',
    );
    if (!confirmed) {
      throw new Error(`Installing MCP "${entry.name}" was declined or cancelled.`);
    }
    // CF-13: keys never enter the webview — collected HERE, host-side and
    // masked, ONLY after consent. A dismissed or blank answer for ANY
    // required var declines the WHOLE install; nothing partial ever reaches
    // `installCatalogEntry`.
    const env: Record<string, string> = {};
    for (const v of entry.required_env) {
      const value = await this.port.promptSecret(`"${entry.name}": ${v.prompt} (${v.name})`);
      if (value === undefined || value === '') {
        throw new Error(`Installing MCP "${entry.name}" was declined or cancelled.`);
      }
      env[v.name] = value;
    }
    const result = await client.installCatalogEntry({ name: entry.name, env, enable: true });
    if (!result.background) {
      await this.reloadMcpAndRefetch();
      return { ok: true, name: entry.name };
    }
    if (!result.action) {
      throw new Error(`Catalog install of "${entry.name}" started in the background but returned no action id.`);
    }
    return await this.pollCatalogInstall(client, entry.name, result.action);
  }

  // WS-GD.2a A5: `actionStatusWithinDeadline` moved onto `adminOpRunner.ts`
  // (rebuilt on WS-R1's `settleRace`; own doc moved there verbatim).

  /**
   * Task A6 (§4.7 item 2, background branch): poll `actionStatus` at a
   * 1s -> 2s backoff, capped at 180s total (clone+build headroom). On
   * `running:false`, GROUND-TRUTH verify (Layer 6, unexecuted-assurance
   * doctrine): a FRESH `listMcpCatalog()` must show this row's `installed
   * === true` — the exit code alone is never trusted. On a timeout or a
   * still-`installed:false` row, the action's tail `lines` go to the
   * output-channel logger ONLY; the thrown message never carries them.
   * CA-M05: the deadline bounds the `actionStatus` call itself (via {@link
   * actionStatusWithinDeadline}), not just the gap between calls — a hung
   * call can no longer blow past the cap undetected.
   * WS-GD.2a A5: the poll loop itself now runs on the shared {@link
   * pollActionUntilVerified} primitive — the `lastCatalogEntries` caching
   * side effect lives inside the `verify` closure below, exactly where the
   * inline loop used to set it, so it still runs on every verify attempt.
   */
  private async pollCatalogInstall(
    client: DashboardAdminClient,
    name: string,
    action: string,
  ): Promise<McpCatalogInstallResult> {
    await pollActionUntilVerified({
      client,
      action,
      capMs: CATALOG_POLL_CAP_MS,
      verify: async () => {
        const verify = await client.listMcpCatalog();
        this.lastCatalogEntries = verify.entries;
        const row = verify.entries.find((entry) => entry.name === name);
        return row !== undefined && row.installed === true;
      },
      rejectUnverified: (tailLines) => this.rejectCatalogInstall(name, tailLines),
      throwUnconfirmed: (err) => this.throwPollUnconfirmed(action, err),
    });

    await this.reloadMcpAndRefetch();
    return { ok: true, name };
  }

  /**
   * Task A6 (§4.7 item 2, §3 Layer 6): the shared timeout/ground-truth-
   * failure refusal. `tailLines` goes to the output-channel logger only —
   * never into the thrown message (the constraint the reject-message test
   * proves).
   */
  private rejectCatalogInstall(name: string, tailLines: string[]): never {
    this.port.logger?.append(
      `[AcpBackend] catalog install "${name}" did not verify as installed — action tail:\n${tailLines.join('\n')}`,
    );
    throw new Error('Catalog install did not complete — see the Talaria output log.');
  }

  /**
   * F2-09: a poll/verify TRANSPORT rejection is NOT an action failure. Report
   * "dispatched — confirmation unknown" ({@link POLL_UNCONFIRMED_MESSAGE}),
   * distinct from {@link rejectCatalogInstall}'s ground-truth "did not
   * complete". The underlying error goes to the logger only.
   */
  private throwPollUnconfirmed(action: string, err: unknown): never {
    this.port.logger?.append(
      `[AcpBackend] poll for action "${action}" could not be confirmed (transport): ${errorMessage(err)}`,
    );
    throw new Error(POLL_UNCONFIRMED_MESSAGE);
  }

  /**
   * Task A6 (§4.8): OAuth login. No modal — the plan calls this "self-
   * evident" (user-initiated browser handoff; the only persisted
   * consequence, `auth: oauth`, is written server-side only on verified
   * success). Cancellation only abandons OUR wait via `AbortSignal`; the
   * Hermes-side flow continues until ITS OWN timeout — the returned
   * envelope's copy says exactly that. Single-flight per name (critic
   * IMPORTANT-3, Hermes's own token snapshot/remove/restore dance,
   * `web_server.py:10592-10629`, is not safe under a concurrent same-name
   * call) is enforced by the CALLER ({@link handleMcpAdmin}'s synchronous
   * {@link acquireMcpSingleFlight}) — this method never re-checks it.
   */
  private async mcpAuth(client: DashboardAdminClient, name: string): Promise<McpTestResult> {
    const result = await this.port.withProgress<McpTestResult>(
      `MCP "${name}" — complete the sign-in in your browser`,
      async (token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await client.authMcpServer(name, controller.signal);
        } catch (err) {
          if (token.isCancellationRequested) {
            return {
              ok: false,
              error: 'Cancelled. The browser sign-in may still be completing — run Test after finishing it.',
              tools: [],
            };
          }
          throw err;
        } finally {
          sub.dispose();
        }
      },
    );
    if (result.ok) {
      await this.refetchPanel('mcp');
    }
    return result;
  }

  /**
   * Task A5 (§4.5 item 6): NO modal (toggle class — consent already happened
   * at add/install time) -> `setMcpServerEnabled` -> reload -> refetch.
   */
  private async mcpSetEnabled(client: DashboardAdminClient, name: string, enabled: boolean): Promise<unknown> {
    const result = await client.setMcpServerEnabled(name, enabled);
    await this.reloadMcpAndRefetch();
    return result;
  }

  /**
   * F2-08: the shared post-mutation reload+refetch. On a `reload.mcp` failure
   * AFTER a config mutate already landed, the persisted config and the running
   * Hermes DIVERGE — so we still RE-FETCH the `mcp` panel (the webview then
   * renders the true persisted state) and DISCLOSE the divergence, instead of
   * letting a raw reload error propagate over a stale panel or pretending
   * success. On reload success it is the plain reload → refetch it replaces.
   */
  private async reloadMcpAndRefetch(): Promise<void> {
    try {
      await this.port.dispatch('reload.mcp', { confirm: true });
    } catch (err) {
      this.port.logger?.append(
        `[AcpBackend] reload.mcp failed after a config mutate — config/runtime may diverge: ${errorMessage(err)}`,
      );
      await this.refetchPanel('mcp').catch(() => {});
      throw new Error(MCP_RELOAD_DIVERGENCE_MESSAGE);
    }
    await this.refetchPanel('mcp');
  }
}

/** Task A5: pull `{name}` out of an `mcp.remove`/`mcp.setEnabled`/`mcp.test`/`mcp.auth` payload. */
function extractMcpName(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as { name?: unknown };
  return typeof p.name === 'string' ? p.name : undefined;
}

/**
 * Task A5: `validateMcpAdd` already confirmed `params.transport` is exactly
 * `'stdio'` or `'http'` before returning `ok:true` — this reads that SAME
 * validated discriminant off the original (still-`unknown`) params object,
 * for the `McpAddResult.transport` field and for reconstructing a typed
 * `McpAddParams` to hand `describeAddForModal` (§4.2's own doc: "`transport`
 * is threaded from the VALIDATED McpAddParams discriminant").
 */
function extractValidatedAddTransport(params: unknown): 'stdio' | 'http' {
  const p = params as { transport?: unknown };
  return p.transport === 'http' ? 'http' : 'stdio';
}

/**
 * Task A5: rebuild a typed `McpAddParams` from `validateMcpAdd`'s already-
 * trimmed/validated `body` (which deliberately drops `transport` — the REST
 * wire body has no such field) plus the separately-read discriminant, so the
 * modal text (`describeAddForModal`) reflects the SAME validated bytes that
 * go on the wire (§3 Layer 3: "the modal text derives from the same
 * validated object that goes on the wire").
 */
function toMcpAddParams(
  body: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> },
  transport: 'stdio' | 'http',
  secretEnvNames: string[],
): McpAddParams {
  return transport === 'http'
    ? { name: body.name, transport: 'http', url: body.url ?? '' }
    : { name: body.name, transport: 'stdio', command: body.command ?? '', args: body.args ?? [], env: body.env ?? {}, secretEnvNames };
}

/**
 * F2-08: disclosed when a `reload.mcp` fails AFTER a config mutate already
 * landed — the persisted config and the running Hermes have diverged.
 */
const MCP_RELOAD_DIVERGENCE_MESSAGE =
  'The MCP configuration was saved, but reloading the running Hermes server failed — reload the window or restart Hermes to apply the change.';

/**
 * AU-59: one collected secret — lives ONLY in `mcpAdd`'s call stack (never on
 * the handler instance, never logged, never in a thrown message). `key` is the
 * namespaced `.env` key; `name` the server-env key the `${key}` reference is
 * written under.
 */
interface CollectedSecret {
  name: string;
  key: string;
  value: string;
}

/** AU-59: Layer-6 read of a `GET /api/env` row — fail-closed on any non-row shape (a rogue/odd body counts as "not set"). */
function isEnvKeySet(rows: Record<string, DashboardEnvRow>, key: string): boolean {
  const row: unknown = isRecord(rows) ? rows[key] : undefined;
  return isRecord(row) && row.is_set === true;
}

/** AU-59: Layer 6 found a key Hermes claimed to have saved absent from `.env` (managed/container mode's `{ok:true}` no-op). Keys only. */
class SecretEnvNotPersistedError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Hermes answered ok but ~/.hermes/.env does not contain ${missing.join(', ')} (managed/container mode?)`);
  }
}

/**
 * AU-59 (SEC follow-up): the user-facing rollback message — keys only; a
 * transport cause is routed to the output log, never quoted here. `stranded`
 * lists `.env` keys whose compensating DELETE also rejected — their secret
 * VALUE may still be at rest in `~/.hermes/.env`, so this must NEVER claim
 * "Nothing was saved." when `stranded` is non-empty.
 */
function secretAddRollbackMessage(name: string, err: unknown, compensation: { serverRemoved: boolean; stranded: readonly string[] }): string {
  const cause = err instanceof SecretEnvNotPersistedError ? err.message : 'Hermes did not store its secret env — see the Talaria output log';
  const strandedNote =
    compensation.stranded.length > 0
      ? `the secret(s) for ${compensation.stranded.join(', ')} may remain in ~/.hermes/.env — remove them manually (see the Talaria output log).`
      : undefined;
  const serverNote = compensation.serverRemoved
    ? undefined
    : `The server entry "${name}" could NOT be removed automatically — remove it from the MCP panel (it holds only ` + '${…} references, no secret)';
  let tail: string;
  if (serverNote !== undefined && strandedNote !== undefined) {
    tail = `${serverNote}; ${strandedNote}`;
  } else if (serverNote !== undefined) {
    tail = `${serverNote}.`;
  } else if (strandedNote !== undefined) {
    tail = `The server entry was removed, but ${strandedNote}`;
  } else {
    tail = 'Nothing was saved.';
  }
  return `Adding MCP server "${name}" was rolled back: ${cause}. ${tail}`;
}

const CATALOG_POLL_CAP_MS = 180_000;

/**
 * F3: MCP admin methods EXEMPT from the `ConfigWriteTail` serialization.
 * Membership rule — an op is exempt iff it performs NO client-bracketable
 * config.yaml write:
 *  - 'mcp.catalog'        read-only (web_server.py:10682-10756)
 *  - 'mcp.test'           read-only probe, no save call (web_server.py:10485-10542)
 *  - 'mcp.auth'           only write = server-side, at END of the browser flow (web_server.py:10629)
 *  - 'mcp.catalogInstall' only config write = server-side, end of install/subprocess (web_server.py:10795-10828)
 * Everything NOT listed rides the tail (fail-safe default for future methods).
 * Same-name exclusion for the exempt mutators is carried by busyMcpNames.
 */
const TAIL_EXEMPT_MCP_METHODS: ReadonlySet<McpAdminMethod> = new Set([
  'mcp.catalog',
  'mcp.test',
  'mcp.auth',
  'mcp.catalogInstall',
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
