import * as vscode from 'vscode';
import type { CustomModeConfig, CustomModeInfo } from '../../shared/protocol';
import type { ModeFloor } from './policy/editPolicy';

/**
 * W4-T4b — the vscode-boundary read for SF-2 custom modes
 * (`docs/research/wave-4/00-architecture-and-paths.md` §4.1/§4.3). This is
 * the ONLY module that reads/validates `talaria.customModes`; the pure engine
 * (`policy/editPolicy.ts`) never imports `vscode` and only ever consumes the
 * {@link ModeFloor} snapshot {@link buildModeFloorSnapshot} produces here.
 * Mirrors `src/autocomplete/config.ts`'s read pattern.
 */

const CUSTOM_MODES_SECTION = 'talaria.customModes';

/**
 * §4.3 mitigation 3 (defense-in-depth ONLY — the primary self-widening
 * mitigations are snapshot-on-activate + require-re-select, both in
 * `AcpBackend`; see the module doc there). Always appended to `deny` for
 * BOTH deny-only and allowOnly modes — `violatesModeFloor` is deny-wins, so
 * appending here closes the seam under an allowOnly mode too (an allowOnly
 * rule that happens to also match one of these paths is still overridden by
 * this `deny` entry). Both are valid T4a grammar: an exact workspace-relative
 * path and a basename suffix.
 */
const SELF_PROTECTION_DENY: readonly string[] = ['.vscode/settings.json', '*.code-workspace'];

/**
 * B10 / §4.1: read the WORKSPACE value SPECIFICALLY via `inspect()`, never
 * the merged `.get()`. VS Code's configuration override chain is
 * `default -> global -> workspace -> workspaceFolder` and `.get()` returns
 * the EFFECTIVE (already-overridden) value — so a FOLDER-level value would
 * silently take precedence over the workspace-level one `.get()` returns.
 * `.inspect().workspaceValue` is the security-relevant choice: a per-folder
 * override in a multi-root workspace must not be able to silently WIDEN a
 * workspace-level mode's floor, so folder overrides are IGNORED entirely.
 *
 * Defensive on untrusted workspace data throughout: a malformed/non-array
 * `workspaceValue`, a non-object entry, or an entry missing `id`/`name` is
 * dropped rather than thrown — `talaria.customModes` is workspace-controlled
 * settings data, not a value this extension itself produced.
 */
export function readCustomModes(): CustomModeConfig[] {
  const inspected = vscode.workspace.getConfiguration().inspect<unknown>(CUSTOM_MODES_SECTION);
  const raw = Array.isArray(inspected?.workspaceValue) ? inspected.workspaceValue : [];

  const configs: CustomModeConfig[] = [];
  for (const entry of raw) {
    const config = normalizeConfig(entry);
    if (!config) continue;
    warnOnSuspiciousRules(config);
    configs.push(config);
  }
  return configs;
}

/** `{id,name}` catalog for `mode.state.available` — never leaks `deny`/`allowOnly` onto the wire. */
export function toCatalog(configs: readonly CustomModeConfig[]): CustomModeInfo[] {
  return configs.map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Snapshot builder (pure, unit-testable — no vscode dependency of its own):
 * `AcpBackend.setCustomMode` calls this at `mode.set` time and hands the
 * PLAIN DATA result to the `SessionController`, which enforces it from
 * memory until the next explicit `setCustomMode` call. That snapshot-on-
 * activate is the PRIMARY §4.3 self-widening mitigation; this function only
 * shapes the data, it does not itself decide when re-snapshotting happens.
 */
export function buildModeFloorSnapshot(config: CustomModeConfig): ModeFloor {
  const deny = [...(config.deny ?? []), ...SELF_PROTECTION_DENY];
  return config.allowOnly !== undefined ? { deny, allowOnly: config.allowOnly } : { deny };
}

function normalizeConfig(entry: unknown): CustomModeConfig | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const rec = entry as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id : '';
  const name = typeof rec.name === 'string' ? rec.name : '';
  if (id.length === 0 || name.length === 0) return undefined;

  const config: CustomModeConfig = { id, name };
  const deny = toStringArray(rec.deny);
  if (deny) config.deny = deny;
  const allowOnly = toStringArray(rec.allowOnly);
  if (allowOnly) config.allowOnly = allowOnly;
  return config;
}

/**
 * Coerces to a string array, dropping non-string entries; `undefined` when the
 * raw value isn't an array at all. Each rule is TRIMMED (and whitespace-only
 * rules dropped): a stray trailing space silently turns a dir-prefix rule
 * (`"config/ "`) into a dead exact-match that blocks nothing — a fail-open
 * surprise (T4b Opus review). Trimming is unambiguously the author's intent
 * for a path rule and cannot widen a floor.
 */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Rule-ingest hygiene: surface VISIBLE warnings for malformed rules that the
 * frozen `matchesModeRule` grammar (`editPolicy.ts`) silently mis-handles, so
 * a fail-open floor is never invisible. We WARN and keep the rule AS-AUTHORED
 * — auto-rewriting would silently change documented grammar semantics and
 * could mis-scope the floor in either direction. Cases (T4a review Minor,
 * broadened by the T4b Opus review):
 * - a slashless bare `deny` token (`"src"`, no `/`, no leading `*`, no `.`) →
 *   parsed as an EXACT match, blocks nothing under `src/` (fail-OPEN);
 * - ANY rule beginning with `/` (`"/config/"`) → paths are workspace-relative
 *   POSIX, so `startsWith`/`===` never match — the rule is inert (fail-OPEN
 *   for a deny rule; fail-CLOSED for allowOnly, but inert either way);
 * - an `allowOnly` rule of exactly `"*"` → basename suffix `""` matches EVERY
 *   file, silently DISABLING the allow-list (the one genuinely widening case).
 * Slashless `allowOnly` rules are fail-CLOSED/over-restrictive (the safer
 * direction), so they are warn-optional and not flagged.
 */
function warnOnSuspiciousRules(config: CustomModeConfig): void {
  const warn = (message: string): void => {
    void vscode.window.showWarningMessage(`Talaria custom mode "${config.name}": ${message}`);
  };
  for (const rule of config.deny ?? []) {
    if (rule.startsWith('/')) {
      warn(`deny rule '${rule}' starts with '/', but paths are workspace-relative — it matches nothing; remove the leading '/'`);
    } else if (isSlashlessBareToken(rule)) {
      warn(`deny rule '${rule}' matches only a file named exactly '${rule}' — add a trailing '/' to restrict the directory`);
    }
  }
  for (const rule of config.allowOnly ?? []) {
    if (rule === '*') {
      warn(`allowOnly rule '*' matches every file, which disables this mode's restriction — remove it or list specific paths`);
    } else if (rule.startsWith('/')) {
      warn(`allowOnly rule '${rule}' starts with '/', but paths are workspace-relative — it matches nothing; remove the leading '/'`);
    }
  }
}

function isSlashlessBareToken(rule: string): boolean {
  return !rule.includes('/') && !rule.startsWith('*') && !rule.includes('.');
}
