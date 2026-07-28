/**
 * Pure demux for tui_gateway control-plane notification frames.
 *
 * The gateway pushes JSON-RPC *notifications* (no `id`) shaped as
 * `{jsonrpc:'2.0', method:'event', params:{type, session_id?, payload}}` —
 * confirmed against `tui_gateway/entry.py:349` (`gateway.ready`, no
 * `session_id` since it isn't session-scoped):
 *
 * ```py
 * write_json({
 *     "jsonrpc": "2.0",
 *     "method": "event",
 *     "params": {"type": "gateway.ready", "payload": {"skin": resolve_skin()}},
 * })
 * ```
 *
 * and against the session-scoped `_emit(event, sid, payload)` call sites
 * cataloged in `research/harness/hermes-tui-gateway-methods.md` (the
 * `message.delta` / `tool.start` / … event stream).
 *
 * `JsonRpcStdio` already peels the outer `{jsonrpc, method, params}` envelope
 * and invokes event handlers with `(method, params)` — for every gateway
 * event that outer `method` is the literal string `'event'`; the *real*
 * event name lives inside `params.type`. This module isolates that one piece
 * of parsing so it is unit-testable without spawning a process.
 */

/** A parsed gateway `event` notification. */
export interface GatewayEventFrame {
  /** The event name, e.g. `'gateway.ready'`, `'message.delta'`. */
  type: string;
  /** Present for session-scoped events (spec §4.4); absent for gateway-wide ones. */
  sessionId?: string;
  payload: unknown;
}

/**
 * Parse a `JsonRpcStdio` notification `(method, params)` pair into a
 * {@link GatewayEventFrame}, or `undefined` if it isn't a well-formed gateway
 * `event` frame (wrong outer `method`, non-object `params`, or a missing /
 * non-string `type`). Pure — no IO, never throws.
 */
export function parseGatewayEvent(
  method: string,
  params: unknown,
): GatewayEventFrame | undefined {
  if (method !== 'event') return undefined;
  if (typeof params !== 'object' || params === null) return undefined;

  const obj = params as Record<string, unknown>;
  const { type } = obj;
  if (typeof type !== 'string' || type.length === 0) return undefined;

  const sessionId =
    typeof obj.session_id === 'string' ? obj.session_id : undefined;
  return { type, sessionId, payload: obj.payload };
}

/** Whether a parsed frame is the startup handshake (`entry.py:349`). */
export function isGatewayReady(frame: GatewayEventFrame | undefined): boolean {
  return frame?.type === 'gateway.ready';
}
