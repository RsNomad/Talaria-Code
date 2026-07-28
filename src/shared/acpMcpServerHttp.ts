/**
 * T-19 (Tier-2 remediation architecture §12.1, C1+C2 — boundary moves):
 * `AcpHttpHeader`/`AcpMcpServerHttp` used to live in
 * `src/host/backend/acp/acpClient.ts`, next to {@link AcpMcpServerStdio}
 * (still there) and the {@link AcpMcpServer} union (still there — it imports
 * `AcpMcpServerHttp` from here to build `AcpMcpServerStdio | AcpMcpServerHttp`).
 * That put a real edge from `src/mcp/lsp/libServerHost.ts` back into
 * `src/host/backend/acp/`, while `src/host/lib/*` already imports FROM
 * `src/mcp/lsp/*` (`codeActionSerialize`, `lspToolContract`, `lspGateway`,
 * `toolPipeline`, `resultShaper`, `lspResultMap`) — together a
 * `host` ⇄ `mcp/lsp` directory-level dependency cycle the architecture
 * audit flagged. Moving these two types to `src/shared/` — which neither
 * `host/` nor `mcp/lsp/` needs to import THE OTHER for — removes the
 * `mcp/lsp → host` arm of that cycle: `libServerHost.ts` now imports this
 * file instead of `acpClient.ts`, and `mcp/lsp/` no longer imports anything
 * from `host/` in production code.
 *
 * Pure import-churn move: the two interfaces below are byte-identical to
 * their prior home (only the doc comments' cross-file framing changed, since
 * they no longer sit next to `AcpMcpServerStdio`).
 */

/**
 * One HTTP header entry of an {@link AcpMcpServerHttp}'s `headers` array —
 * the SDK's `HttpHeader` (`schema.d.ts` of `@zed-industries/agent-client-protocol`:
 * `{name, value}`, plus an optional `_meta` extension point we never populate
 * — confirmed against that package before Audit C-1 replaced it with
 * `@agentclientprotocol/sdk`; it is no longer installed, so this is a
 * historical citation, not one re-checkable from this checkout). Mirrors the
 * `{name,value}` list convention `AcpEnvVariable` (`host/backend/acp/acpClient.ts`)
 * already uses.
 */
export interface AcpHttpHeader {
  name: string;
  value: string;
}

/**
 * ACP `McpServer`'s http-transport variant — the SDK's `McpServer` union's
 * `type: "http"` member (`schema.d.ts` of `@zed-industries/agent-client-protocol`:
 * `{headers: HttpHeader[], name, type: "http", url}` — confirmed against that
 * package before Audit C-1 replaced it with `@agentclientprotocol/sdk`; it is
 * no longer installed, so this is a historical citation, not one re-checkable
 * from this checkout), discriminated from `AcpMcpServerStdio`
 * (`host/backend/acp/acpClient.ts`) by the PRESENCE of `type` (stdio carries
 * no `type` field at all — see that interface's doc). W3 (LIB)'s
 * `vscode_lsp` loopback HTTP MCP server (`src/mcp/lsp/libServerHost.ts`)
 * produces this shape; `AcpBackend` advertises it alongside the stdio
 * `codebase_search` server via the `mcpServers` Map (see `AcpBackend.ts`'s
 * `setMcpServer`).
 */
export interface AcpMcpServerHttp {
  type: 'http';
  name: string;
  url: string;
  headers: AcpHttpHeader[];
}
