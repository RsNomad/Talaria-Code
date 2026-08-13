// Deny-list of credential-shaped KEY names (case-insensitive, whole-value
// redaction). Matches a key if the regex hits anywhere in the key name.
const SECRET_KEY = /authorization|token|api[_-]?key|password|secret|env/i;
const REDACTED = '[redacted]';

/** The `ControlRequestMethod` literals (see `src/shared/protocol.ts`
 *  `CONTROL_METHODS`) whose result can carry configuration objects with
 *  credential-shaped fields (e.g. `mcp_servers[].env`) sourced from the
 *  semi-trusted, prompt-injectable backend. Every other method's result is
 *  returned unchanged.
 *
 *  Task A5 (§3 Layer 5, §4.5 item 8): `mcp.add` joins the set as a BELT over
 *  the host-side redaction — `ControlDispatcher`'s `mcp.add` handler never
 *  echoes `env` back today, but a future change to that handler (or to the
 *  server's own response shape) gets this net for free rather than silently
 *  losing it. */
const REDACTED_METHODS = new Set(['config.show', 'model.options', 'mcp.add']);

/**
 * SEC-4 (audit-3 B-3): defense-in-depth redaction of a control-relay
 * result before it crosses the host->webview boundary. Applies ONLY to the
 * `config.show` / `model.options` relays (the two that can carry config
 * with credential-shaped fields from the prompt-injectable backend); every
 * other method's result is returned UNCHANGED (byte-identical reference is
 * fine). For the gated methods, walks the value recursively and replaces
 * the VALUE of any deny-list-matching key with '[redacted]', whatever the
 * value's type (string/object/array) — whole-value redaction is the
 * fail-safe choice (don't try to partially scrub an `env` map).
 *
 * Pure: never mutates `result` (builds new objects/arrays on the redacted
 * path), never logs, never throws on non-object input — arrays, `null`,
 * and primitives simply pass through the walker untouched.
 */
export function redactControlResponse(method: string, result: unknown): unknown {
  if (!REDACTED_METHODS.has(method)) return result;
  return redactValue(result);
}

/**
 * CF-13 C-1: the SAME deep, key-based deny-list walker `redactControlResponse`
 * uses for `config.show`/`model.options`, exported UNGATED (no method
 * allowlist) for callers that need to redact secret-shaped fields wherever
 * they appear — e.g. `JsonRpcStdio`'s traffic tap, which logs EVERY method's
 * frame, not just the two gated here. Reuses the same `SECRET_KEY` deny-list
 * on purpose: one doctrine, not two. Pure — never mutates, never throws on
 * non-object input.
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
