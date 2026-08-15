// Deny-list of credential-shaped KEY names (case-insensitive, whole-value
// redaction). Matches a key if the regex hits anywhere in the key name.
//
// TE-5 (AU-26): extended with `credential|bearer|cookie|passphrase|
// private[_-]?key` — the audit's named under-matches (the OLD regex missed
// all four). `env` is deliberately kept BROAD (not narrowed to e.g.
// `\benv\b`): over-redaction is the safe direction for a defense-in-depth
// belt, and the primary UX surfaces read from typed projections, not raw
// results. Where that breadth WOULD swallow a legitimate field (e.g.
// `McpCatalogEntry.required_env`, `apiKeySet`), the fix is an explicit,
// justified `REDACTION_EXEMPT` entry below — not a narrower regex that
// could just as easily miss the next credential-shaped key.
const SECRET_KEY = /authorization|token|api[_-]?key|password|secret|credential|bearer|cookie|passphrase|private[_-]?key|env/i;
const REDACTED = '[redacted]';

/**
 * TE-5 (AU-26, INV-16): the CLOSED, explicit safe-list of `ControlRequestMethod`
 * literals whose result is returned UNCHANGED. Every OTHER method's result is
 * walked and redacted by DEFAULT — the inverse of the old `REDACTED_METHODS`
 * allowlist, which fail-OPEN'd (a method not in a 3-item set crossed to the
 * webview unredacted, so any NEW credential-bearing method escaped the belt
 * entirely). Membership here is NOT prefix/substring matching (`Set.has`,
 * exact method string) and each entry carries its own justification — no
 * entry may be added without one:
 *
 *  - `'panel.data'` — every panel payload is a host-shaped PROJECTION
 *    (`reshapePanelData.ts` / `SetupController.status()`), never the raw
 *    backend config the walker exists to catch (audit lens-1C read,
 *    re-verified for TE-5: `reshapeMcpServers`/`reshapeConfigShow`/
 *    `SetupData` all emit typed, enumerated fields — no passthrough of an
 *    unknown raw object). Its correlated `control.response` copy is also,
 *    independently, never read by the webview (`panels.ts`'s `fetchPanel`:
 *    "the resolved RPC value is deliberately ignored — the reshaped
 *    snapshot only ever rides the [separate, unredacted] push"), so gating
 *    it here would be redaction theater over a value nothing consumes.
 *  - `'setup.status'` — `TalariaViewProvider.handleSetupMethod` returns
 *    `SetupController.status()` verbatim: the IDENTICAL `SetupData`
 *    projection `panel.data{panel:'setup'}` pushes (same justification as
 *    above), reached through a second method name because the Setup panel
 *    also polls it as a correlated request. Re-verified for TE-5: this is
 *    exactly where the tightened `env`/`key` breadth would otherwise
 *    over-redact real fields — `agent.options[].remote.apiKeySet: boolean`
 *    and `fim.tuning.maxPromptTokens: number` both substring-match
 *    `api[_-]?key`/`token` — corrupting the Setup panel's rendered state.
 *  - `'mcp.catalog'` — `McpCatalogEntry.required_env` is a read-only schema
 *    of credential NAMES/prompts to collect (`{name, prompt, required}[]`,
 *    `McpPanel.tsx` renders one TextField per entry), never a secret VALUE;
 *    the actual submitted values ride `mcp.catalogInstall`'s PARAMS
 *    (webview→host, never redacted — redaction only applies to results
 *    crossing host→webview) and are never echoed back in a result. Whole-
 *    value redaction here (the `env` match hits the `required_env` key)
 *    would zero out the catalog install form for every entry.
 *
 * `mcp.catalogInstall` (params-shaped, no `env`/`required_env` in its
 * result — {@link McpCatalogInstallResult}) is deliberately NOT exempt: a
 * lookalike name is not membership.
 */
const REDACTION_EXEMPT = new Set(['panel.data', 'setup.status', 'mcp.catalog']);

/**
 * SEC-4 (audit-3 B-3) / TE-5 (AU-26, INV-16): defense-in-depth redaction of
 * a control-relay result before it crosses the host->webview boundary.
 * Default-redact (INV-16): every method's result is walked EXCEPT the
 * explicit, justified {@link REDACTION_EXEMPT} set — so a future
 * credential-bearing method is covered by construction, not by remembering
 * to add it to an allowlist. Walks the value recursively and replaces the
 * VALUE of any deny-list-matching key with '[redacted]', whatever the
 * value's type (string/object/array) — whole-value redaction is the
 * fail-safe choice (don't try to partially scrub an `env` map).
 *
 * Pure: never mutates `result` (builds new objects/arrays on the redacted
 * path), never logs, never throws on non-object input — arrays, `null`,
 * and primitives simply pass through the walker untouched.
 */
export function redactControlResponse(method: string, result: unknown): unknown {
  if (REDACTION_EXEMPT.has(method)) return result;
  return redactValue(result);
}

/**
 * CF-13 C-1: the SAME deep, key-based deny-list walker `redactControlResponse`
 * uses, exported UNGATED (no method allowlist/exemption at all) for callers
 * that need to redact secret-shaped fields wherever they appear — e.g.
 * `JsonRpcStdio`'s traffic tap, which logs EVERY method's frame, not just
 * the non-exempt subset `redactControlResponse` walks. Reuses the same
 * `SECRET_KEY` deny-list on purpose: one doctrine, not two. Pure — never
 * mutates, never throws on non-object input.
 */
export function redactSecretsDeep(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => redactValue(element));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
