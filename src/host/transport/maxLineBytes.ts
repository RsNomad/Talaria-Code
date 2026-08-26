/**
 * Stdio frame-size caps (WS-AC CA-01/CA-M01): a single newline-delimited
 * JSON frame may not exceed its channel's cap in BYTES before its
 * terminating `\n` arrives. Per-channel caps, each sized to its own traffic
 * profile — control stays tight (small envelopes), ACP is higher (frames
 * scale with file/tool-output size, see `MAX_ACP_LINE_BYTES`).
 */

/**
 * Control-RPC channel cap. 4 MiB matches `autocomplete/backends/http.ts`'s
 * MAX_STREAM_BYTES discipline (B-4/SEC-6). Consumer: `JsonRpcStdio`
 * (control channel — residual-buffer check). See `MAX_ACP_LINE_BYTES` for
 * why the ACP channel does NOT share this constant.
 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * ACP stdout gets its OWN, higher ceiling (M-3 follow-up to CA-01): unlike the
 * control channel's small fixed envelopes, legitimate ACP frames scale with
 * FILE SIZE and TOOL OUTPUT — a `session/request_permission` edit proposal
 * carries old_text + new_text + the duplicated content arg (~3× file size on
 * ONE line; hermes acp_adapter/edit_approval.py), and a non-polished (MCP)
 * tool's untruncated `raw_output` (tools.py build_tool_complete) is unbounded,
 * live AND on session/load history replay. Under 32 MiB: edits of files up to
 * ~9.7 MiB and 4K-screenshot-scale image blocks pass; a deterministic trip on
 * replayed history would otherwise respawn-loop forever (respawnBackoff has no
 * attempt limit). Still a hard bound: a runaway child wastes at most 32 MiB of
 * buffer (~160 MB transient worst case incl. parse — trivial for the ext-host)
 * before cap-then-teardown+respawn. Consumer:
 * `host/backend/acp/stdoutByteCap.ts` (ACP channel — pre-SDK Transform), used
 * by `acpClient.ts`'s `wireAcpConnection`. Full derivation:
 * docs_claude/lens-dorabotok/m3-acp-cap-analysis.md.
 */
export const MAX_ACP_LINE_BYTES = 32 * 1024 * 1024;
