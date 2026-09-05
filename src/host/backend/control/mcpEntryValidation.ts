import { MODAL_UNSAFE_TEXT_PATTERN } from '../../setup/SetupController';
import type { McpAddParams, McpCatalogEntry } from '../../../shared/protocol';
import { isRecord } from '../../../shared/typeGuards';
import { CREDENTIAL_NAME_CORE } from '../../redactControlResponse';

/**
 * Task A3 (features-add-mcp-skills-architecture.md §4.4, §3 Layer 1/3) — the
 * SECURITY SPINE of T1: pure, framework-free (no `vscode` import) host-side
 * re-validation of every `mcp.add` / `mcp.catalogInstall` param, applied
 * BEFORE any network call, modal, or log line — the webview is untrusted
 * input, so this module is the actual gate, not the wire types.
 *
 * S-1..S-4 mirror the plan's §3 Layer 1 spec verbatim:
 *   S-1 name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (first-char-alnum already
 *       rejects '.'/'..' by construction — the pattern alone is sufficient).
 *   S-2 stdio: command/args/env shape + charset + size limits.
 *   S-3 http: URL parses, scheme http/https, non-empty hostname, no userinfo.
 *   S-4 (F-1, STRICTER than Hermes): command basename in the mirrored
 *       {@link SHELL_INTERPRETERS} set → refused outright. Applied to BOTH
 *       manual adds and a catalog row's own TRANSPORT command — never to
 *       catalog `bootstrap` commands, which always run through a shell by
 *       Hermes design (mcp_catalog.py:359-371) and are gated instead by
 *       Nous PR-provenance + full verbatim disclosure (§4.7).
 */

// ---------------------------------------------------------------------------
// Shared charsets / limits (§3 Layer 1)
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * The null character, obtained via a character-code call instead of an
 * inline escape sequence so this source file never has to carry a literal
 * control byte in its own text.
 */
const NUL_CHARACTER = String.fromCharCode(0);

/** NUL/CR/LF — the three control bytes that can smuggle extra argv/env lines. */
const CONTROL_BYTES_PATTERN = new RegExp(`[${NUL_CHARACTER}\r\n]`);

const COMMAND_MAX_LEN = 256;
const ARG_MAX_LEN = 1024;
const ARGS_MAX_COUNT = 64;
const ENV_VALUE_MAX_LEN = 4096;
const ENV_MAX_COUNT = 32;

/** AU-59: cap on secret env NAMES per manual add (plaintext env allows 32; more than 8 secrets is not a real server shape). */
const SECRET_ENV_MAX_COUNT = 8;
/**
 * AU-59: `save_env_value` (`hermes_cli/config.py`) SILENTLY strips non-ASCII
 * and CR/LF before writing `.env` — a value carrying lookalike Unicode glyphs
 * (a PDF/rich-text paste) would be persisted MANGLED and fail at first use.
 * Refuse it client-side instead: printable ASCII (0x20–0x7E) only.
 */
const SECRET_VALUE_PATTERN = /^[\x20-\x7E]+$/;

/**
 * S-4 (F-1 CONFIRMED, stricter than Hermes): mirrors
 * `mcp_security.py:33-45` (`_SHELL_INTERPRETERS`) exactly. A catalog/manual
 * `command` whose basename (case-insensitive) is in this set is refused
 * outright — shell interpreters make `args` an arbitrary-code channel.
 */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length > 0 ? (parts[parts.length - 1] ?? path) : path;
}

function isShellInterpreter(command: string): boolean {
  return SHELL_INTERPRETERS.has(basename(command).toLowerCase());
}

// ---------------------------------------------------------------------------
// validateMcpAdd (S-1..S-4)
// ---------------------------------------------------------------------------

export type McpValidation =
  | {
      ok: true;
      body: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> };
      /**
       * AU-59: the validated secret env NAMES (stdio; always `[]` for http) —
       * a SIBLING of `body`, never inside it: `body` is the exact REST wire
       * body `POST /api/mcp/servers` receives, and Hermes must never see this
       * field.
       */
      secretEnvNames: string[];
    }
  | { ok: false; reason: string };

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function checkName(value: unknown): Checked<string> {
  if (typeof value !== 'string' || value === '.' || value === '..' || !NAME_PATTERN.test(value)) {
    return { ok: false, reason: 'MCP server name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ and must not be "." or "..".' };
  }
  return { ok: true, value };
}

function checkCommand(value: unknown): Checked<string> {
  if (typeof value !== 'string') return { ok: false, reason: 'command must be a non-empty string.' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'command must be a non-empty string.' };
  if (trimmed.length > COMMAND_MAX_LEN) return { ok: false, reason: `command exceeds ${COMMAND_MAX_LEN} characters.` };
  if (CONTROL_BYTES_PATTERN.test(trimmed)) return { ok: false, reason: 'command contains NUL/CR/LF.' };
  return { ok: true, value: trimmed };
}

/** Trims each item, drops empty arg lines (post-trim), then enforces the count/length/charset limits. */
function checkArgs(value: unknown): Checked<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'args must be an array of strings.' };
  const trimmed: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, reason: 'every arg must be a string.' };
    const t = item.trim();
    if (t.length === 0) continue; // drop empty arg lines
    trimmed.push(t);
  }
  if (trimmed.length > ARGS_MAX_COUNT) return { ok: false, reason: `args must not have more than ${ARGS_MAX_COUNT} items.` };
  for (const a of trimmed) {
    if (a.length > ARG_MAX_LEN) return { ok: false, reason: `an arg exceeds ${ARG_MAX_LEN} characters.` };
    if (CONTROL_BYTES_PATTERN.test(a)) return { ok: false, reason: 'an arg contains NUL/CR/LF.' };
  }
  return { ok: true, value: trimmed };
}

function checkEnv(value: unknown, allowedKeys?: ReadonlySet<string>): Checked<Record<string, string>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, reason: 'env must be an object of string values.' };
  const entries = Object.entries(value);
  if (entries.length > ENV_MAX_COUNT) return { ok: false, reason: `env must not have more than ${ENV_MAX_COUNT} entries.` };
  const seen = new Set<string>();
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    // Unreachable via Object.entries() on a JS object (duplicate keys can't
    // coexist there) — kept as defense-in-depth for a future wire shape that
    // isn't parsed through JSON.parse (e.g. a list-of-pairs format).
    if (seen.has(key)) return { ok: false, reason: `duplicate env key "${key}".` };
    seen.add(key);
    if (allowedKeys && !allowedKeys.has(key)) return { ok: false, reason: `env key "${key}" is not accepted here.` };
    if (!ENV_NAME_PATTERN.test(key)) return { ok: false, reason: `env key "${key}" must match ^[A-Z_][A-Z0-9_]{0,63}$.` };
    if (typeof v !== 'string') return { ok: false, reason: `env value for "${key}" must be a string.` };
    if (v.length > ENV_VALUE_MAX_LEN) return { ok: false, reason: `env value for "${key}" exceeds ${ENV_VALUE_MAX_LEN} characters.` };
    if (CONTROL_BYTES_PATTERN.test(v)) return { ok: false, reason: `env value for "${key}" contains NUL/CR/LF.` };
    out[key] = v;
  }
  return { ok: true, value: out };
}

/**
 * AU-59: NAMES only, same lenience on absence as {@link checkArgs}/{@link
 * checkEnv} (an older caller that omits the field adds no secrets); same
 * charset as a plaintext env KEY ({@link ENV_NAME_PATTERN}) because each name
 * is ALSO written as a key into the server's `env` map (`env[name] =
 * "${MCP_…}"`); DISJOINT from the plaintext keys (one key, one storage);
 * capped. Hygiene: a name that fails the charset is NOT echoed in the reason
 * (a VALUE pasted into the names box would otherwise reach the output log
 * via `String(err)`) — only its 1-based position is.
 */
function checkSecretEnvNames(value: unknown, plaintextKeys: ReadonlySet<string>): Checked<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'secretEnvNames must be an array of strings.' };
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, reason: 'every secret env name must be a string.' };
    const t = item.trim();
    if (t.length === 0) continue; // drop blank lines
    names.push(t);
  }
  if (names.length > SECRET_ENV_MAX_COUNT) {
    return { ok: false, reason: `secretEnvNames must not have more than ${SECRET_ENV_MAX_COUNT} entries.` };
  }
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!ENV_NAME_PATTERN.test(name)) {
      return { ok: false, reason: `a secret env name must match ^[A-Z_][A-Z0-9_]{0,63}$ (entry ${index + 1}).` };
    }
    if (seen.has(name)) return { ok: false, reason: `duplicate secret env name "${name}".` };
    seen.add(name);
    if (plaintextKeys.has(name)) {
      return { ok: false, reason: `"${name}" is listed both as a plain-text env key and as a secret env name — choose one.` };
    }
  }
  return { ok: true, value: names };
}

/**
 * AU-59: the `.env` key a manual add's secret lands under — Hermes' OWN
 * namespacing idiom `_env_key_for_server` (`hermes_cli/mcp_config.py`:
 * `MCP_<SUFFIX>_API_KEY`, suffix = `name.upper()` with every
 * non-`[A-Za-z0-9_]` char → `_`, then stripped of leading/trailing `_`),
 * generalized to `MCP_<SUFFIX>_<KEY>`. Namespacing is deliberate and differs
 * from the catalog path, which saves a catalog entry's OWN declared var names
 * (e.g. `N8N_KEY`) un-namespaced because the entry's config references them
 * by exactly those names: a manual add has no spec, so an un-namespaced
 * `GITHUB_TOKEN` would silently clobber the user's global one in
 * `~/.hermes/.env`. By construction the result always matches Hermes'
 * `_ENV_VAR_NAME_RE` (`^[A-Za-z_][A-Za-z0-9_]*$`) and, starting with `MCP_`,
 * can never equal a `_ENV_VAR_NAME_DENYLIST` entry (`hermes_cli/config.py`).
 * (`serverName` is `NAME_PATTERN`-validated ASCII, so `toUpperCase` is safe.)
 */
export function secretEnvKeyFor(serverName: string, secretName: string): string {
  const suffix = serverName
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  return `MCP_${suffix}_${secretName}`;
}

/** AU-59: the `${KEY}` reference written into config.yaml — matches {@link ENV_REFERENCE_PATTERN} by construction (round-trip pinned in the tests). */
export function envReference(key: string): string {
  return '${' + key + '}';
}

/**
 * AU-59: the client-side gate `mcpAdd` applies to a prompted secret VALUE
 * before `PUT /api/env` ({@link SECRET_VALUE_PATTERN}, same 4096 cap as a
 * plaintext env value). The refusal says NOTHING about the value.
 */
export function checkSecretValue(value: string): Checked<string> {
  if (value.length > ENV_VALUE_MAX_LEN) return { ok: false, reason: `secret value exceeds ${ENV_VALUE_MAX_LEN} characters.` };
  if (!SECRET_VALUE_PATTERN.test(value)) {
    return {
      ok: false,
      reason:
        'secret value must be printable ASCII (Hermes silently strips anything else — re-copy the key from the provider, not from a PDF or rich-text source).',
    };
  }
  return { ok: true, value };
}

function shellRefusal(command: string): { ok: false; reason: string } {
  return { ok: false, reason: `Refusing "${command}": shell interpreters are not allowed as MCP server commands.` };
}

function validateStdio(name: string, params: Record<string, unknown>): McpValidation {
  const commandCheck = checkCommand(params.command);
  if (!commandCheck.ok) return commandCheck;
  if (isShellInterpreter(commandCheck.value)) return shellRefusal(commandCheck.value);
  const argsCheck = checkArgs(params.args);
  if (!argsCheck.ok) return argsCheck;
  const envCheck = checkEnv(params.env);
  if (!envCheck.ok) return envCheck;
  const secretCheck = checkSecretEnvNames(params.secretEnvNames, new Set(Object.keys(envCheck.value)));
  if (!secretCheck.ok) return secretCheck;
  return {
    ok: true,
    body: { name, command: commandCheck.value, args: argsCheck.value, env: envCheck.value },
    secretEnvNames: secretCheck.value,
  };
}

function validateHttp(name: string, params: Record<string, unknown>): McpValidation {
  // AU-59: a remote server has no subprocess env — anything but an absent or
  // empty `secretEnvNames` is a crafted payload; refuse rather than drop it.
  if (params.secretEnvNames !== undefined && !(Array.isArray(params.secretEnvNames) && params.secretEnvNames.length === 0)) {
    return { ok: false, reason: 'secretEnvNames is only accepted for stdio servers.' };
  }
  if (typeof params.url !== 'string') return { ok: false, reason: 'url must be a string.' };
  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    return { ok: false, reason: 'url could not be parsed.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'url scheme must be http or https.' };
  }
  if (parsed.hostname.length === 0) return { ok: false, reason: 'url must have a non-empty hostname.' };
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: 'url must not contain userinfo.' };
  }
  return { ok: true, body: { name, url: params.url }, secretEnvNames: [] };
}

export function validateMcpAdd(params: unknown): McpValidation {
  if (!isRecord(params)) return { ok: false, reason: 'MCP server params must be an object.' };
  const nameCheck = checkName(params.name);
  if (!nameCheck.ok) return nameCheck;
  if (params.transport === 'stdio') return validateStdio(nameCheck.value, params);
  if (params.transport === 'http') return validateHttp(nameCheck.value, params);
  return { ok: false, reason: 'transport must be "stdio" or "http".' };
}

// ---------------------------------------------------------------------------
// stripModalControls / MODAL_DETAIL_MAX (§3 Layer 3, §4.4 — the BLOCKER fix)
// ---------------------------------------------------------------------------

/**
 * Strip-ONLY (never length-slices) variant of `SetupController`'s modal
 * character sanitizer, derived from the SAME single-source pattern
 * ({@link MODAL_UNSAFE_TEXT_PATTERN}, `SetupController.ts:559`) per the
 * CR-003 "do NOT hand-duplicate this class" rule — `new RegExp(x.source,
 * 'g')` re-uses the exact character class, so the two can never drift
 * apart. `redactForModal`'s 200-char slice (`MODAL_TEXT_MAX_LEN`,
 * `SetupController.ts:563, :598-601`) is deliberately NOT reused here: a
 * consent-modal DETAIL (command + args, or a full bootstrap script) is
 * exactly the disclosure the user must read in full before consenting, and
 * silently truncating it would defeat the modal's purpose.
 */
const MODAL_CONTROL_PATTERN_G = new RegExp(MODAL_UNSAFE_TEXT_PATTERN.source, 'g');

export function stripModalControls(text: string): string {
  return text.replace(MODAL_CONTROL_PATTERN_G, '');
}

/** Fail-closed ceiling for a composed consent DETAIL: past this we REFUSE the action outright — never truncate. */
export const MODAL_DETAIL_MAX = 4000;

// ---------------------------------------------------------------------------
// describeAddForModal (§4.6 modal copy, pinned verbatim)
// ---------------------------------------------------------------------------

/**
 * A5-M1 (review fold-in, task A6): EXPORTED so `ControlDispatcher.ts`'s own
 * `mcp.remove`/catalog-install modal copy imports this SAME constant instead
 * of hand-duplicating it (the byte-identical `MCP_RELOAD_LINE` this used to
 * shadow there) — single-source, per the file's own CR-003 discipline.
 */
export const RELOAD_LINE =
  'Applying the change reloads MCP servers and invalidates the prompt cache (the next message re-sends full input tokens).';
const RUNS_ON_MACHINE_LINE = 'This command will run on your machine every time the agent starts.';
const PLAINTEXT_ENV_LINE = "Env values will be stored in PLAIN TEXT in Hermes' ~/.hermes/config.yaml.";

/**
 * AU-59 (D-lite): a VALUE that is exactly one `${VAR}` / `${env:VAR}`
 * reference. Hermes resolves it from `~/.hermes/.env` when the server config
 * is loaded (`tools/mcp_tool.py` `_ENV_VAR_PATTERN` = `\$\{([^}]+)\}`, walked
 * over the whole server dict by `_interpolate_env_vars` on the runtime load
 * path AND on `mcp_config.py`'s `_resolve_mcp_server_config` test-probe path),
 * so the literal in config.yaml never holds the secret. ANCHORED on purpose: a
 * partial interpolation (`Bearer ${X}`) is still stored as typed and is
 * classified plaintext here — the modal must describe what config.yaml will
 * literally contain.
 */
export const ENV_REFERENCE_PATTERN = /^\$\{[^}]+\}$/;
const REFERENCE_ENV_LINE_PREFIX =
  "Env keys resolved from Hermes' .env at runtime (${KEY} reference — config.yaml stores only the reference): ";

/** AU-59 (D-lite): env keys split by what config.yaml will literally hold — a secret-free `${KEY}` reference, or the typed value. */
function partitionEnvKeys(env: Record<string, string>): { plaintext: string[]; references: string[] } {
  const plaintext: string[] = [];
  const references: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    (ENV_REFERENCE_PATTERN.test(value) ? references : plaintext).push(key);
  }
  return { plaintext, references };
}

/**
 * AU-59 (D-lite): the plaintext disclosure, precise per category. The
 * credential hint is a WARN (not a refusal — env is legitimately mixed) folded
 * INTO the plaintext paragraph (not a paragraph of its own — the standing
 * 5-paragraph pin for a stdio+env add holds), driven by the SAME deny-list
 * core the host->webview belt redacts with ({@link CREDENTIAL_NAME_CORE},
 * CR-003 single-source; deliberately WITHOUT the belt's `env` breadth so
 * `ENVIRONMENT`-style keys don't over-warn). Keys only — never a value.
 */
function plaintextEnvLines(plaintext: readonly string[]): string[] {
  if (plaintext.length === 0) return [];
  const credentialShaped = plaintext.filter((key) => CREDENTIAL_NAME_CORE.test(key));
  const warn =
    credentialShaped.length > 0
      ? ` Looks like a credential and will be stored in plain text: ${credentialShaped.join(', ')} — keep secrets out of plain-text env; reference a ~/.hermes/.env key as ` +
        '${KEY} instead.'
      : '';
  return [`Env keys (plain text): ${plaintext.join(', ')}`, PLAINTEXT_ENV_LINE + warn];
}

function referenceEnvLines(references: readonly string[]): string[] {
  if (references.length === 0) return [];
  return [REFERENCE_ENV_LINE_PREFIX + references.join(', ')];
}

/**
 * AU-59 (CF-13 parity): FUTURE-TENSE, names only — the same binding as
 * {@link catalogCredentialLine}: nothing has been collected at describe-time
 * (the masked prompts run AFTER consent), so the line says what WILL be asked
 * and exactly where each value persists. `undefined` when there is nothing to
 * prompt for — no false disclosure.
 */
function secretEnvLine(serverName: string, names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const keys = names.map((n) => secretEnvKeyFor(serverName, n));
  return (
    `Will prompt for: ${names.join(', ')} — saved to Hermes' .env store (~/.hermes/.env) as ${keys.join(', ')}; ` +
    'config.yaml gets only the ${KEY} reference, never the value.'
  );
}

type ModalDescription = { ok: true; message: string; detail: string } | { ok: false; reason: string };

function composeModal(message: string, lines: string[]): ModalDescription {
  const strippedMessage = stripModalControls(message);
  // Strip control bytes from each line's CONTENT individually, THEN join with
  // the trusted `\n\n` paragraph separator. Stripping after the join would be
  // a bug: `stripModalControls` removes `\x00-\x1f` (which includes `\n`/`\r`)
  // and the Unicode line separators U+2028/U+2029, so joining-then-stripping
  // erases the very separators the join added, collapsing the disclosure into
  // one run-on line. Per-line stripping keeps the structural breaks (added by
  // trusted code, never passed back through the strip) while still neutralizing
  // any control byte -- including an injected paragraph break -- inside an
  // untrusted field, so no field value can forge an extra modal paragraph.
  const detail = lines.map(stripModalControls).join('\n\n');
  if (detail.length > MODAL_DETAIL_MAX) {
    return { ok: false, reason: `The details for this action are too large to review in a dialog.` };
  }
  return { ok: true, message: strippedMessage, detail };
}

export function describeAddForModal(p: McpAddParams): ModalDescription {
  const message = `Add MCP server "${p.name}"?`;
  const lines: string[] = [];
  if (p.transport === 'stdio') {
    const argsStr = p.args.length > 0 ? ` ${p.args.join(' ')}` : '';
    lines.push(`Runs: ${p.command}${argsStr}`);
    const { plaintext, references } = partitionEnvKeys(p.env);
    lines.push(...plaintextEnvLines(plaintext));
    lines.push(...referenceEnvLines(references));
    const secretLine = secretEnvLine(p.name, p.secretEnvNames);
    if (secretLine !== undefined) lines.push(secretLine);
    lines.push(RUNS_ON_MACHINE_LINE);
    lines.push(RELOAD_LINE);
  } else {
    lines.push(`Connects to: ${p.url}`);
    lines.push(RELOAD_LINE);
  }
  return composeModal(message, lines);
}

// ---------------------------------------------------------------------------
// validateCatalogInstall (§3 Layer 2, F-3)
// ---------------------------------------------------------------------------

export type McpCatalogInstallValidation =
  | { ok: true; entry: McpCatalogEntry; env: Record<string, string> }
  | { ok: false; reason: string };

export function validateCatalogInstall(params: unknown, listed: readonly McpCatalogEntry[]): McpCatalogInstallValidation {
  if (!isRecord(params)) return { ok: false, reason: 'Catalog install params must be an object.' };
  if (typeof params.name !== 'string') return { ok: false, reason: 'name must be a string.' };
  const entry = listed.find((row) => row.name === params.name);
  if (!entry) return { ok: false, reason: `"${params.name}" is not a listed catalog entry.` };

  // S-4 applies to the row's own TRANSPORT command only — never to `bootstrap`
  // (which always runs through a shell by Hermes design, §3 Layer 1 S-4 note).
  if (entry.command !== null && isShellInterpreter(entry.command)) return shellRefusal(entry.command);

  const allowedKeys = new Set(entry.required_env.map((row) => row.name));
  const envCheck = checkEnv(params.env, allowedKeys);
  if (!envCheck.ok) return envCheck;

  return { ok: true, entry, env: envCheck.value };
}

// ---------------------------------------------------------------------------
// describeCatalogForModal (§4.7 modal copy, pinned verbatim)
// ---------------------------------------------------------------------------

const CATALOG_SOURCE_LINE = 'Nous-approved catalog entry (ships with Hermes, PR-gated, pinned versions).';
const BOOTSTRAP_HEADER_LINE = 'Then runs these build commands IN A SHELL on your machine:';

/**
 * Rev-1 B4 (CF-13 parity, TH-4) — SUPERSEDES the old A3-IMP2 binding
 * ("the credential line must reflect what the user actually submitted"):
 * credential collection now happens HOST-side, masked, AFTER this modal is
 * confirmed (`ControlDispatcher.mcpCatalogInstall`'s `promptSecret` loop),
 * so nothing has been "submitted" yet at describe-time — there is no
 * `submittedEnv` to reflect. The new binding is FUTURE-TENSE and driven
 * entirely by the entry's OWN `required_env` schema (var NAMES only, never
 * a value): names what WILL be asked and where it persists. `undefined`
 * when `required_env` is empty — no false disclosure.
 */
function catalogCredentialLine(requiredEnv: McpCatalogEntry['required_env']): string | undefined {
  if (requiredEnv.length === 0) return undefined;
  const names = requiredEnv.map((v) => v.name).join(', ');
  return `Will prompt for: ${names} — saved to Hermes' .env store (~/.hermes/.env).`;
}

export function describeCatalogForModal(entry: McpCatalogEntry): ModalDescription {
  const message = `Install MCP "${entry.name}" from the Hermes catalog?`;
  const lines: string[] = [CATALOG_SOURCE_LINE];

  if (entry.transport === 'http' && entry.url !== null) {
    lines.push(`Connects to: ${entry.url}`);
  } else if (entry.command !== null) {
    const argsStr = entry.args.length > 0 ? ` ${entry.args.join(' ')}` : '';
    lines.push(`Runs: ${entry.command}${argsStr}`);
  } else {
    return {
      ok: false,
      reason: `Catalog entry "${entry.name}" has no usable transport — refusing to build a consent modal.`,
    };
  }

  const credentialLine = catalogCredentialLine(entry.required_env);
  if (credentialLine !== undefined) lines.push(credentialLine);
  lines.push(RELOAD_LINE);

  if (entry.needs_install) {
    lines.push(`Clones: ${entry.install_url} @ ${entry.install_ref} (pinned)`);
    lines.push(BOOTSTRAP_HEADER_LINE);
    for (const cmd of entry.bootstrap) lines.push(`$ ${cmd}`);
  }

  const composed = composeModal(message, lines);
  if (composed.ok) return composed;
  return {
    ok: false,
    reason: `The build script of "${entry.name}" is too large to review in a dialog — install it from a terminal instead: hermes mcp install ${entry.name}`,
  };
}

/**
 * BHF-F1-2 (WS-BG, owner-adjudicated FIRM): `mcp.setEnabled`'s `enabled`
 * payload accepts ONLY a literal boolean. Anything else — missing, `"true"`,
 * `1`, `null` — used to silently coerce to `false`, i.e. a DESTRUCTIVE
 * silent-disable default at a modal-less boundary. Now it throws an honest
 * refusal: fail-LOUD, still fail-closed (nothing is toggled). The throw
 * surfaces to the webview exactly like `requireListedMcpName`'s refusals on
 * the same `handleMcpAdminInner` path (`ControlDispatcher.ts:772` → `:778`).
 * Hygiene: the message names the offending TYPE only — never the value.
 */
export function extractMcpEnabled(params: unknown): boolean {
  const enabled = isRecord(params) ? params.enabled : undefined;
  if (enabled === true || enabled === false) return enabled;
  throw new Error(
    `'mcp.setEnabled' requires a literal boolean { enabled: true | false } — got ${
      enabled === undefined ? 'no enabled value' : `a ${typeof enabled} value`
    }. Refusing rather than guessing: a wrong guess silently disables a server.`,
  );
}
