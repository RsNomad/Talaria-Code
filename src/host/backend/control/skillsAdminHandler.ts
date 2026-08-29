import type { DataPanel, HubInstallResult } from '../../../shared/protocol';
import type { DashboardAdminClient, DashboardClientLike } from '../../dashboard/HermesDashboardClient';
import { hasHubNameCache } from '../../dashboard/dashboardPanelSources';
import { stripModalControls, MODAL_DETAIL_MAX } from './mcpEntryValidation';
import { assertSkillIdentifier, validateSkillCreate, TRUSTED_SKILL_PREFIXES } from './skillSourceGate';
import { redactForModal } from '../../setup/SetupController';
import type { ConfigWriteTail } from './configWriteTail';
import { runAdminOp, resolveDashboardAdminClient, pollActionUntilVerified, POLL_UNCONFIRMED_MESSAGE, TRUST_GATED_METHODS } from './adminOpRunner';
import type { ControlDispatcherHostPort } from './ControlDispatcher';

/**
 * Task B4 (create/hubPreview/hubScan/hubInstall) + Task B5 (`skills.
 * hubUninstall`, the 5th `TRUST_GATED_METHODS` skills entry): the full 5 T2
 * skills admin methods {@link handle} routes.
 */
export type SkillsAdminMethod =
  | 'skills.create'
  | 'skills.hubPreview'
  | 'skills.hubScan'
  | 'skills.hubInstall'
  | 'skills.hubUninstall';

export function isSkillsAdminMethod(method: string): method is SkillsAdminMethod {
  return (
    method === 'skills.create' ||
    method === 'skills.hubPreview' ||
    method === 'skills.hubScan' ||
    method === 'skills.hubInstall' ||
    method === 'skills.hubUninstall'
  );
}

/**
 * WS-GD.2a A7: the narrowed slice of {@link ControlDispatcherHostPort} the
 * skills-admin domain actually reads — every member `handle` (and the
 * private methods it routes to) touches, and nothing else.
 */
export type SkillsAdminPort = Pick<ControlDispatcherHostPort, 'logger' | 'panelSources' | 'getDashboard' | 'isTrusted' | 'confirm'>;

/**
 * WS-GD.2a A7: the T2 skills-admin domain — pure move off `ControlDispatcher`
 * behind the same `ControlDispatcherHostPort` slice ({@link SkillsAdminPort}),
 * the shared `ConfigWriteTail`, and a `refetchPanel` callback bound to the
 * dispatcher's `PanelDataCoordinator.fetchPanelData`. Zero behavior change —
 * see each member's own doc (moved verbatim) for the full rationale.
 */
export class SkillsAdminHandler {
  /**
   * Task B4/B5, reshaped by B5-KS: the skills-side counterpart of {@link
   * busyMcpNames}, as TWO kind-scoped collections instead of one shared
   * map. `skills.hubInstall` locks the hub `identifier` in
   * `busySkillInstallIds` (`skills.hubPreview`/`skills.hubScan` CHECK it,
   * mirroring `mcp.test`'s check-only posture); `skills.hubUninstall`
   * locks the skill `name` in `busySkillUninstallNames`. The old single
   * map claimed the two key spaces were disjoint "because identifiers
   * always contain '/' and names never do" — TRUE only post-validation,
   * but the map was written pre-validation (acquire is synchronous; the
   * identifier/name gates run later, inside the routed handler), so a raw
   * slash-free install key could collide with a real uninstall name and
   * vice versa, producing a wrong-kind "already in progress" refusal that
   * masked the accurate validation refusal for up to 120s. Separate
   * collections make cross-kind collision structurally impossible for ANY
   * strings and each branch's pinned refusal message accurate by
   * construction; entries may still TRANSIENTLY hold raw pre-validation
   * strings, released ms later by {@link handle}'s settled-
   * release when the downstream gate refuses. Install-vs-uninstall of the
   * same REAL skill was never mutually excluded (identifier and name are
   * different strings) and still is not — Hermes plus the ground-truth
   * presence/absence re-checks arbitrate that (see the B5-KS brief, R-1).
   * `skills.create` has no identifier/name lock key and touches neither.
   */
  private readonly busySkillInstallIds = new Set<string>();
  private readonly busySkillUninstallNames = new Set<string>();

  constructor(
    private readonly port: SkillsAdminPort,
    private readonly tail: ConfigWriteTail,
    private readonly refetchPanel: (panel: DataPanel) => Promise<unknown>,
  ) {}

  /**
   * Task B4, mirroring {@link handleMcpAdmin} exactly (F3 idiom): per-
   * identifier/per-name single-flight acquired SYNCHRONOUSLY (see {@link
   * acquireSkillSingleFlight}'s own doc for why), then routed either OFF
   * {@link ConfigWriteTail} (the four {@link SKILLS_TAIL_EXEMPT_METHODS})
   * or ON it (`skills.create` — a short `POST /api/skills`, same bucket as
   * `mcp.add`).
   */
  async handle(method: SkillsAdminMethod, params: unknown): Promise<unknown> {
    // WS-GD.2a A5: the acquire/tail-or-direct/release choreography itself
    // moved onto the shared {@link runAdminOp} primitive — behavior
    // unchanged (see that function's own doc, and {@link handleMcpAdmin}'s
    // mirrored call for why `acquire` runs synchronously).
    return runAdminOp({
      acquire: () => this.acquireSkillSingleFlight(method, params),
      tailExempt: SKILLS_TAIL_EXEMPT_METHODS.has(method),
      tail: this.tail,
      run: () => this.handleSkillsAdminInner(method, params),
    });
  }

  /**
   * Task B4 (§5.4 "Single-flight per identifier"), widened by Task B5 for
   * `skills.hubUninstall` (keyed on the skill `name` — its param is `{name}`,
   * NOT `{identifier}`; `extractSkillIdentifier` does not apply). Mirrors
   * {@link acquireMcpSingleFlight} exactly — see that method's own doc for
   * why the test-and-set MUST run synchronously, before this call ever joins
   * {@link ConfigWriteTail}. `skills.create` has no `identifier`/`name`
   * key (it creates a NEW skill by `name`, but that's a create-time payload
   * field, not a busy-lock key) and is never guarded here.
   * `skills.hubPreview`/`skills.hubScan` only CHECK the identifier space — a
   * preview/scan racing a same-identifier install is refused, but two
   * concurrent previews/scans of the SAME identifier never block each other
   * (mirrors `mcp.test`'s check-only posture). B5-KS: each kind now locks
   * its OWN collection — see {@link busySkillInstallIds}'s field doc for why
   * that makes cross-kind collision structurally impossible.
   */
  private acquireSkillSingleFlight(method: SkillsAdminMethod, params: unknown): (() => void) | undefined {
    if (method === 'skills.create') return undefined; // no identifier/name lock key — never guarded

    if (method === 'skills.hubUninstall') {
      const name = extractSkillName(params);
      if (!name) return undefined; // the real handler rejects with a clearer validation message
      if (this.busySkillUninstallNames.has(name)) {
        throw new Error(`Uninstalling skill "${name}" is already in progress.`);
      }
      this.busySkillUninstallNames.add(name);
      return () => this.busySkillUninstallNames.delete(name);
    }

    const identifier = extractSkillIdentifier(params);
    if (!identifier) return undefined; // the real handler rejects with a clearer validation message
    if (this.busySkillInstallIds.has(identifier)) {
      throw new Error(`Installing skill "${identifier}" is already in progress.`);
    }
    if (method !== 'skills.hubInstall') return undefined; // check-only: previews/scans never block each other
    this.busySkillInstallIds.add(identifier);
    return () => this.busySkillInstallIds.delete(identifier);
  }

  /**
   * Task B4 (§5.4) + Task B5: trust gate (the `TRUST_GATED_METHODS` skills
   * entries `skills.create`/`skills.hubInstall`/`skills.hubUninstall`) -> the
   * per-method route. `skills.hubPreview`/`skills.hubScan` are read-only and
   * NOT trust-gated (§4.7-class read methods), but still run {@link
   * assertSkillIdentifier} BEFORE resolving a dashboard client at all — a
   * bad/URL identifier never reaches the network fan-out, read-only or not.
   */
  private async handleSkillsAdminInner(method: SkillsAdminMethod, params: unknown): Promise<unknown> {
    if (TRUST_GATED_METHODS.has(method) && !this.port.isTrusted()) {
      throw new Error(`Refusing '${method}': the workspace is not trusted — trust this workspace to manage skills.`);
    }

    if (method === 'skills.hubPreview' || method === 'skills.hubScan') {
      const identifier = extractSkillIdentifier(params);
      if (!identifier) {
        throw new Error(`'${method}' requires an { identifier } payload.`);
      }
      const gate = assertSkillIdentifier(identifier);
      if (!gate.ok) {
        // Task TE-6 (AU-27, CF-14 no-echo): the raw identifier goes ONLY to
        // the output-channel logger, capped — `gate.reason` (thrown below)
        // is already generic and never carries it into `control.response`.
        this.port.logger?.append(`[AcpBackend] '${method}' refused skill identifier: ${gate.detail}`);
        throw new Error(gate.reason);
      }
      const client = await resolveDashboardAdminClient(() => this.port.getDashboard(), method);
      return method === 'skills.hubPreview' ? client.previewHubSkill(identifier) : client.scanHubSkill(identifier);
    }

    const client = await resolveDashboardAdminClient(() => this.port.getDashboard(), method);

    if (method === 'skills.create') {
      return this.skillsCreate(client, params);
    }

    if (method === 'skills.hubUninstall') {
      return this.skillsHubUninstall(client, params);
    }

    return this.skillsHubInstall(client, params);
  }

  /**
   * Task B4 (§5.4 item 2, §5.5): `validateSkillCreate` (throws its own
   * `reason` on `!ok`, before any modal) -> the §5.5 create modal ->
   * `createSkill` -> a `skills` panel refetch -> `{ok:true}`. A `createSkill`
   * REJECTION (Hermes 400 etc.) is Invariant #3: the server's error detail
   * goes to the output-channel logger ONLY, a generic message is thrown to
   * the caller/webview.
   */
  private async skillsCreate(client: DashboardAdminClient, params: unknown): Promise<{ ok: true }> {
    const validated = validateSkillCreate(params);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const { body } = validated;
    const message = `Create skill "${body.name}"?`;
    const lines = [
      `Category: ${body.category ?? '(none)'}`,
      'The agent will follow these instructions in future sessions.',
      redactForModal(body.content),
    ];
    const described = composeSkillsModalDetail(message, lines);
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(described.message, described.detail, 'Create skill');
    if (!confirmed) {
      throw new Error(`Creating skill "${body.name}" was declined or cancelled.`);
    }
    try {
      await client.createSkill(body);
    } catch (err) {
      this.port.logger?.append(`[AcpBackend] skills.create "${body.name}" was rejected by Hermes: ${errorMessage(err)}`);
      throw new Error('Creating the skill failed — see the Talaria output log.');
    }
    await this.refetchPanel('skills');
    return { ok: true };
  }

  /**
   * Task B4 (§5.4 item 3, §5.5): `assertSkillIdentifier` -> `scanHubSkill`
   * -> the DOUBLE GATE (fail-closed: `policy !== 'allow'` OR `verdict ===
   * 'dangerous'` refuses BEFORE any modal or install — `installHubSkill` is
   * NEVER called on this path) -> the §5.5 install modal -> `installHubSkill`
   * -> {@link pollSkillInstall} (ground-truth verified, §3 Layer 6). Single-
   * flight per identifier is enforced by the CALLER ({@link
   * handle}'s synchronous {@link acquireSkillSingleFlight}) —
   * this method never re-checks it.
   */
  private async skillsHubInstall(client: DashboardAdminClient & DashboardClientLike, params: unknown): Promise<HubInstallResult> {
    const identifier = extractSkillIdentifier(params);
    if (!identifier) {
      throw new Error(`'skills.hubInstall' requires an { identifier } payload.`);
    }
    const gate = assertSkillIdentifier(identifier);
    if (!gate.ok) {
      // Task TE-6 (AU-27, CF-14 no-echo): raw identifier -> logger only, capped.
      this.port.logger?.append(`[AcpBackend] 'skills.hubInstall' refused skill identifier: ${gate.detail}`);
      throw new Error(gate.reason);
    }

    const scan = await client.scanHubSkill(identifier);
    if (scan.policy !== 'allow' || scan.verdict === 'dangerous') {
      throw new Error(
        `Refusing to install skill "${scan.name}": scan policy is "${scan.policy}", verdict "${scan.verdict}" — blocked.`,
      );
    }

    const prefixRow = findSkillPrefixRow(identifier);
    const tierLabel = prefixRow ? `${gate.tier} — ${prefixRow.label}` : gate.tier;
    const message = `Install skill "${scan.name}" from ${identifier}?`;
    const lines = [
      `Source tier: ${tierLabel}`,
      `Scan verdict: ${scan.verdict} (${scan.findings.length} findings)`,
      'Files are copied to ~/.hermes/skills; nothing executes at install time.',
    ];
    const described = composeSkillsModalDetail(message, lines);
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(described.message, described.detail, 'Install skill');
    if (!confirmed) {
      throw new Error(`Installing skill "${scan.name}" was declined or cancelled.`);
    }

    const result = await client.installHubSkill(identifier);
    return this.pollSkillInstall(client, scan.name, result.name);
  }

  /**
   * Task B4 (§5.4 item 3, §3 Layer 6), mirroring {@link pollCatalogInstall}
   * exactly, at the skills-specific cadence: 1s -> 2s backoff, capped at
   * {@link SKILLS_INSTALL_POLL_CAP_MS} (120s — NOT the catalog's 180s, §5.4).
   * On `running:false`, GROUND-TRUTH verify: a FRESH `listSkills()` must
   * contain a row named `skillName` — blocked installs exit 0
   * (`skills_hub.py:634-713`), so the exit code alone is never trusted. On a
   * timeout or a still-absent row, the action's tail `lines` go to the
   * output-channel logger ONLY; the thrown message never carries them.
   */
  private async pollSkillInstall(
    client: DashboardAdminClient & DashboardClientLike,
    skillName: string,
    action: string,
  ): Promise<HubInstallResult> {
    await pollActionUntilVerified({
      client,
      action,
      capMs: SKILLS_INSTALL_POLL_CAP_MS,
      verify: async () => {
        const rows = await client.listSkills();
        return rows.some((row) => row.name === skillName);
      },
      rejectUnverified: (tailLines) => this.rejectSkillInstall(skillName, tailLines),
      throwUnconfirmed: (err) => this.throwPollUnconfirmed(action, err),
    });

    await this.refetchPanel('skills');
    return { ok: true, name: skillName };
  }

  /**
   * Task B4 (§3 Layer 6): the shared timeout/ground-truth-failure refusal —
   * mirrors {@link rejectCatalogInstall} exactly. `tailLines` goes to the
   * output-channel logger only — never into the thrown message.
   */
  private rejectSkillInstall(name: string, tailLines: string[]): never {
    this.port.logger?.append(
      `[AcpBackend] skill install "${name}" did not verify as installed — action tail:\n${tailLines.join('\n')}`,
    );
    throw new Error('Install did not complete — see the Talaria output log.');
  }

  /**
   * F2-09: a poll/verify TRANSPORT rejection is NOT an action failure. Report
   * "dispatched — confirmation unknown" ({@link POLL_UNCONFIRMED_MESSAGE}),
   * distinct from {@link rejectSkillInstall}'s ground-truth "did not
   * complete". The underlying error goes to the logger only.
   */
  private throwPollUnconfirmed(action: string, err: unknown): never {
    this.port.logger?.append(
      `[AcpBackend] poll for action "${action}" could not be confirmed (transport): ${errorMessage(err)}`,
    );
    throw new Error(POLL_UNCONFIRMED_MESSAGE);
  }

  /**
   * Task B5 (§3 Layer 5 critic IMPORTANT-2, §5.4 last bullet): the FAIL-
   * CLOSED hub-provenance name-cache guard for `skills.hubUninstall` —
   * mirrors {@link requireListedMcpName} exactly, at the skills-specific
   * shape. An UNFETCHED cache (`lastListedHubNames()` returns `undefined` —
   * the skills panel was never listed this host session) is a REFUSAL here,
   * not a skip — same deliberate divergence from the lenient
   * `toggleDashboardInner` idiom. A single `!hub.has(name)` check covers BOTH
   * a listed-but-non-hub row (bundled/agent provenance — Hermes never
   * exposes an uninstall path for those) AND a name outside the last-listed
   * set entirely: the hub set IS exactly "listed names whose provenance is
   * hub" ({@link HubNameCache}'s own doc), so there is no separate provenance
   * check to write.
   */
  private requireListedHubSkillName(method: string, name: string | undefined): asserts name is string {
    if (!name) {
      throw new Error(`'${method}' requires a { name } payload.`);
    }
    const source = this.port.panelSources.get('skills');
    const hub = hasHubNameCache(source) ? source.lastListedHubNames() : undefined;
    if (hub === undefined) {
      throw new Error(`Refusing '${method}': the skills panel has not been listed yet — open it first.`);
    }
    if (!hub.has(name)) {
      throw new Error(`${method}: '${name}' is not a hub-installed skill in the last-listed skills.`);
    }
  }

  /**
   * Task B5 (§5.4 last bullet, §5.5): {@link requireListedHubSkillName}
   * (fail-closed hub-provenance gate, BEFORE any modal) -> the §5.5 uninstall
   * modal -> `uninstallHubSkill` (its `{ok, name}` result's `name` is the
   * ACTION id to poll — same shape as `installHubSkill`, NOT the skill name)
   * -> {@link pollSkillUninstall} (ABSENCE ground-truth, §3 Layer 6).
   * Single-flight per NAME is enforced by the CALLER ({@link
   * handle}'s synchronous {@link acquireSkillSingleFlight}) — this
   * method never re-checks it.
   */
  private async skillsHubUninstall(
    client: DashboardAdminClient & DashboardClientLike,
    params: unknown,
  ): Promise<{ ok: true; name: string }> {
    const name = extractSkillName(params);
    this.requireListedHubSkillName('skills.hubUninstall', name);

    const message = `Remove skill "${name}"?`;
    const lines = ['Deletes its files from ~/.hermes/skills.'];
    const described = composeSkillsModalDetail(message, lines);
    if (!described.ok) {
      throw new Error(described.reason);
    }
    const confirmed = await this.port.confirm(described.message, described.detail, 'Remove skill');
    if (!confirmed) {
      throw new Error(`Removing skill "${name}" was declined or cancelled.`);
    }

    const result = await client.uninstallHubSkill(name);
    return this.pollSkillUninstall(client, name, result.name);
  }

  /**
   * Task B5 (§5.4 last bullet, §3 Layer 6): the ABSENCE mirror of {@link
   * pollSkillInstall} — identical 1s -> 2s backoff cadence and the SAME
   * {@link SKILLS_INSTALL_POLL_CAP_MS} cap (an uninstall never clones/builds
   * either — no reason to invent a different ceiling). On `running:false`,
   * GROUND-TRUTH verify: a FRESH `listSkills()` must NOT contain a row named
   * `skillName` — the mirror image of the install path's presence check. On
   * a timeout or the row still being present, the action's tail `lines` go
   * to the output-channel logger ONLY; the thrown message never carries them
   * (Invariant #3).
   */
  private async pollSkillUninstall(
    client: DashboardAdminClient & DashboardClientLike,
    skillName: string,
    action: string,
  ): Promise<{ ok: true; name: string }> {
    await pollActionUntilVerified({
      client,
      action,
      capMs: SKILLS_INSTALL_POLL_CAP_MS,
      verify: async () => {
        const rows = await client.listSkills();
        return !rows.some((row) => row.name === skillName);
      },
      rejectUnverified: (tailLines) => this.rejectSkillUninstall(skillName, tailLines),
      throwUnconfirmed: (err) => this.throwPollUnconfirmed(action, err),
    });

    await this.refetchPanel('skills');
    return { ok: true, name: skillName };
  }

  /**
   * Task B5 (§3 Layer 6): the shared timeout/ground-truth-failure refusal for
   * uninstall — mirrors {@link rejectSkillInstall} exactly. `tailLines` goes
   * to the output-channel logger only — never into the thrown message.
   */
  private rejectSkillUninstall(name: string, tailLines: string[]): never {
    this.port.logger?.append(
      `[AcpBackend] skill uninstall "${name}" did not verify as removed — action tail:\n${tailLines.join('\n')}`,
    );
    throw new Error('Uninstall did not complete — see the Talaria output log.');
  }
}

/** Task B4: pull `{identifier}` out of a `skills.hubPreview`/`skills.hubScan`/`skills.hubInstall` payload. */
function extractSkillIdentifier(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as { identifier?: unknown };
  return typeof p.identifier === 'string' ? p.identifier : undefined;
}

/** Task B5: pull `{name}` out of a `skills.hubUninstall` payload (mirrors {@link extractMcpName}). */
function extractSkillName(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as { name?: unknown };
  return typeof p.name === 'string' ? p.name : undefined;
}

/**
 * Task B4 (§5.5), mirroring `mcpEntryValidation.ts`'s private `composeModal`
 * using the SAME exported primitives ({@link stripModalControls}, {@link
 * MODAL_DETAIL_MAX}) — that function itself isn't exported (A3/B3's file,
 * not touched here) — with ONE deliberate ordering fix: each `lines` entry
 * is stripped INDIVIDUALLY, and only THEN joined with `\n\n`. `stripModalControls`
 * strips every `\x00-\x1f` byte, which includes `\n`/`\r` — stripping AFTER
 * `lines.join('\n\n')` (as `composeModal` does) would erase the very
 * separators that give the modal its line structure; stripping each
 * (already-validated/constant or `redactForModal`-flattened) line first,
 * then joining with a joiner introduced by THIS trusted code (never itself
 * passed back through the strip), keeps the multi-line §5.5 layout intact
 * while still neutralizing any control byte that made it into an individual
 * line's own content. FAIL-CLOSED: a composed detail exceeding the shared
 * ceiling is REFUSED, never truncated.
 */
function composeSkillsModalDetail(
  message: string,
  lines: string[],
): { ok: true; message: string; detail: string } | { ok: false; reason: string } {
  const strippedMessage = stripModalControls(message);
  const detail = lines.map((line) => stripModalControls(line)).join('\n\n');
  if (detail.length > MODAL_DETAIL_MAX) {
    return { ok: false, reason: 'The details for this action are too large to review in a dialog.' };
  }
  return { ok: true, message: strippedMessage, detail };
}

/**
 * Task B4 (§5.5 "Source tier" modal line): re-derive WHICH {@link
 * TRUSTED_SKILL_PREFIXES} row an already-gate-approved identifier matched,
 * for DISPLAY only — `assertSkillIdentifier` already made the actual
 * security decision (this is only ever called after `gate.ok === true`, so
 * a match is guaranteed; the `undefined` fallback below is unreachable in
 * practice, kept as defense-in-depth). Mirrors that function's own
 * segment-prefix matching loop verbatim.
 */
function findSkillPrefixRow(identifier: string): { prefix: string; tier: 'official' | 'trusted'; label: string } | undefined {
  const segments = identifier.split('/');
  for (const row of TRUSTED_SKILL_PREFIXES) {
    const prefixSegments = row.prefix.split('/');
    if (segments.length <= prefixSegments.length) continue;
    if (prefixSegments.every((seg, i) => segments[i] === seg)) return row;
  }
  return undefined;
}

/**
 * Task B4 (§5.4 "cap 120s") + Task B5 reuse: the shared skills-hub ACTION
 * poll cap — {@link pollSkillInstall} AND {@link pollSkillUninstall} (see
 * the latter's doc for why the caps are identical).
 */
const SKILLS_INSTALL_POLL_CAP_MS = 120_000;

/**
 * Task B4 + Task B5 (`skills.hubUninstall`): the skills-side twin of
 * {@link TAIL_EXEMPT_MCP_METHODS}, same membership rule (no client-
 * bracketable config.yaml write of its own):
 *  - 'skills.hubPreview'   read-only (`GET /api/skills/hub/preview`)
 *  - 'skills.hubScan'      read-only (`GET /api/skills/hub/scan`)
 *  - 'skills.hubInstall'   only write = server-side, at END of the (up to
 *                          120s) install action (`POST /api/skills/hub/install`
 *                          + `skills_hub.py:634-713`) — exempting this is the
 *                          whole point (§5.4): holding the tail for a slow
 *                          install would freeze every other short config
 *                          mutation behind it.
 *  - 'skills.hubUninstall' same reasoning as `hubInstall`, mirrored: only
 *                          write = server-side, at END of the (up to 120s)
 *                          uninstall action (`POST /api/skills/hub/uninstall`).
 * `skills.create` (a short, synchronous `POST /api/skills` write) is
 * deliberately NOT listed — same bucket as `mcp.add`, rides the tail.
 * Same-identifier/same-name exclusion for the exempt methods is carried by
 * {@link busySkillInstallIds}/{@link busySkillUninstallNames}.
 */
const SKILLS_TAIL_EXEMPT_METHODS: ReadonlySet<SkillsAdminMethod> = new Set([
  'skills.hubPreview',
  'skills.hubScan',
  'skills.hubInstall',
  'skills.hubUninstall',
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
