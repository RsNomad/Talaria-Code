/**
 * The ONE stdio frame-size cap shared by both child-process transports
 * (WS-AC CA-01/CA-M01): a single newline-delimited JSON frame may not exceed
 * this many BYTES before its terminating `\n` arrives. 4 MiB matches
 * `autocomplete/backends/http.ts`'s MAX_STREAM_BYTES discipline (B-4/SEC-6).
 * Consumers: `JsonRpcStdio` (control channel — residual-buffer check) and
 * `host/backend/acp/stdoutByteCap.ts` (ACP channel — pre-SDK Transform).
 * One definition on purpose: the two channels must never drift apart.
 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
