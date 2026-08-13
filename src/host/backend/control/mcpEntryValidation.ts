import { MODAL_UNSAFE_TEXT_PATTERN } from '../../setup/SetupController';
import type { McpAddParams, McpCatalogEntry } from '../../../shared/protocol';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// validateMcpAdd (S-1..S-4)
// ---------------------------------------------------------------------------

export type McpValidation =
  | { ok: true; body: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> } }
  | { ok: false; reason: string };

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

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
  return { ok: true, body: { name, command: commandCheck.value, args: argsCheck.value, env: envCheck.value } };
}

function validateHttp(name: string, params: Record<string, unknown>): McpValidation {
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
  return { ok: true, body: { name, url: params.url } };
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

const RELOAD_LINE =
  'Applying the change reloads MCP servers and invalidates the prompt cache (the next message re-sends full input tokens).';
const RUNS_ON_MACHINE_LINE = 'This command will run on your machine every time the agent starts.';
const PLAINTEXT_ENV_LINE = "Env values will be stored in PLAIN TEXT in Hermes' ~/.hermes/config.yaml.";

type ModalDescription = { ok: true; message: string; detail: string } | { ok: false; reason: string };

function composeModal(message: string, lines: string[]): ModalDescription {
  const strippedMessage = stripModalControls(message);
  const detail = stripModalControls(lines.join('\n\n'));
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
    const envKeys = Object.keys(p.env);
    if (envKeys.length > 0) {
      lines.push(`Env keys: ${envKeys.join(', ')}`);
      lines.push(PLAINTEXT_ENV_LINE);
    }
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
const CATALOG_ENV_LINE = "Credentials are saved to Hermes' .env store (~/.hermes/.env).";
const BOOTSTRAP_HEADER_LINE = 'Then runs these build commands IN A SHELL on your machine:';

export function describeCatalogForModal(
  entry: McpCatalogEntry,
  submittedEnv: Record<string, string> = {},
): ModalDescription {
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

  if (Object.keys(submittedEnv).length > 0) lines.push(CATALOG_ENV_LINE);
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
