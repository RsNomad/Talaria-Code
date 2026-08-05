/**
 * T1 (beta.5 setup-hardening, §2.3 "B3 (⑧) — `[object Object]`, killed at
 * the root"): the ONE shared, webview-safe error-serialization module.
 *
 * Root cause this replaces (§0.1 row ⑧): `@agentclientprotocol/sdk`
 * (`acp.js:886`) rejects pending requests with the RAW JSON-RPC error
 * object `{code, message, data}` — a plain object, not an `Error` — and 13
 * copies of a naive `err instanceof Error ? err.message : String(err)`
 * helper across the codebase render that as the literal string
 * `"[object Object]"`. `describeError` below never does that, for any
 * object-shaped input.
 *
 * Webview-safe by construction (precedent for cross-import:
 * `webview/src/protocol.ts:26-27`): no `vscode`, no `node:*` import. Home-
 * directory detection uses the bare `process` global behind a `typeof`
 * guard — this reads `process.env.HOME`/`USERPROFILE` (the same source
 * `node:os`'s own `homedir()` consults first on POSIX/Windows respectively)
 * when running host-side under Node, and safely no-ops (no crash, no
 * value) when bundled into the browser-hosted webview runtime, where the
 * `process` global does not exist at all.
 *
 * `redactHomePath` promotes the private `SetupController.redact` (§0.4,
 * `src/host/setup/SetupController.ts:994`) to a shared function so
 * `ConnectionSupervisor`/`AcpBackend` (host-side, but outside
 * `SetupController`) can redact too — same `homedir -> '~'` replacement
 * behavior, reachable from both build targets.
 *
 * Scope note: this module ONLY defines the three exports below. Wiring it
 * into the `ConnectionSupervisor`/`AcpBackend` ⑧-path call sites (replacing
 * their local `errorMessage` helpers) is T8's job, not this task's.
 */

/** JSON-RPC error `.data` keys `describeError` is allowed to fold into the
 *  message (§2.3's locked allowlist). Anything else on `.data` (a raw
 *  `.stack`, or caller-supplied extra fields) is dropped — this is a
 *  user-facing string, not a debug dump. */
const DATA_KEY_ALLOWLIST = ['details', 'method'] as const;

/** `describeError`'s JSON.stringify fallback branch is capped at this many
 *  characters (§2.3) so a huge/unexpected object shape can't blow up a
 *  status line or log message. */
const JSON_FALLBACK_CAP = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads `.data` off any object-shaped value (an `Error` instance or a
 *  plain `{code,message,data}` object) without assuming it's typed. */
function getData(value: unknown): unknown {
  return isRecord(value) ? value.data : undefined;
}

/** Builds the ` (…)` suffix from the allowlisted string-valued `.data`
 *  keys present on `data`, in allowlist order, joined with `; `. Empty
 *  string when `data` isn't an object or carries none of the allowlisted
 *  keys as non-empty strings. */
function dataSuffix(data: unknown): string {
  if (!isRecord(data)) return '';
  const parts: string[] = [];
  for (const key of DATA_KEY_ALLOWLIST) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

/** Case (4) of the resolution order: an object with no usable `.message`.
 *  `JSON.stringify` capped at {@link JSON_FALLBACK_CAP} chars; a throwing
 *  stringify (circular references) falls back to a fixed sentinel — never
 *  `'[object Object]'`, never an uncaught exception. */
function jsonFallback(err: object): string {
  try {
    const json = JSON.stringify(err);
    if (typeof json !== 'string') return 'Unknown error.';
    return json.length > JSON_FALLBACK_CAP ? json.slice(0, JSON_FALLBACK_CAP) : json;
  } catch {
    return 'Unknown error.';
  }
}

/** The un-redacted resolution: see {@link describeError} for the full
 *  4-step order this implements (locked by `errorText.test.ts`). */
function resolveErrorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message + dataSuffix(getData(err));
  }
  if (isRecord(err) && typeof err.message === 'string') {
    return err.message + dataSuffix(err.data);
  }
  if (typeof err !== 'object' || err === null) {
    return String(err);
  }
  return jsonFallback(err);
}

/**
 * Turns any thrown/rejected value into a short, human-readable, redacted
 * string. NEVER returns the literal `'[object Object]'`.
 *
 * Resolution order (locked by test):
 *  1. `Error` -> `.message`, with the allowlisted string `.data` keys
 *     (`details`, `method`) appended as `" (…)"` when present.
 *  2. Plain object with a string `.message` -> same as (1) — this is the
 *     `acp.js:886` raw JSON-RPC-error shape `{code, message, data}`.
 *  3. String/primitive (including `null`/`undefined`) -> `String(err)`.
 *  4. Else (an object with no usable `.message`) -> `JSON.stringify`
 *     capped at 300 chars; a throwing stringify (circular refs) ->
 *     `'Unknown error.'`.
 *
 * Every branch's output is passed through {@link redactHomePath} before
 * returning.
 */
export function describeError(err: unknown): string {
  return redactHomePath(resolveErrorText(err));
}

/**
 * True ONLY for a JSON-RPC error object/Error whose `.code` is exactly the
 * numeric `-32000` (the ACP SDK's `RequestError.authRequired`, `acp.js:976`).
 * `-32603` (internal error) and every other shape -> `false`.
 *
 * Supplementary signal only (§2.3): the structural "no chat provider
 * configured" detection is T8's job (`computeProviderCard(...).phase ===
 * 'unconfigured'`), not this function — `acp_adapter/session.py` swallows
 * the underlying `AuthError` before it reliably reaches the wire, so this
 * code check alone is not sufficient detection on its own.
 */
export function isAuthRequiredError(err: unknown): boolean {
  return isRecord(err) && err.code === -32000;
}

/**
 * Replaces every occurrence of the current user's home directory in `text`
 * with `~`. Webview-safe replica of the private `SetupController.redact`
 * (`src/host/setup/SetupController.ts:994`, which uses `node:os`'s
 * `homedir()`): this reads `process.env.HOME` (POSIX) / `USERPROFILE`
 * (Windows) — the same environment variable `os.homedir()` itself consults
 * first on each platform — behind a `typeof process` guard, so it degrades
 * to a harmless no-op (no crash) wherever the `process` global doesn't
 * exist, i.e. the browser-hosted webview runtime.
 */
export function redactHomePath(text: string): string {
  const home =
    typeof process !== 'undefined' && process.env
      ? process.env.HOME || process.env.USERPROFILE || ''
      : '';
  return home ? text.split(home).join('~') : text;
}
