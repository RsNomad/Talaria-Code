/*
 * TG-4 (AU-54) / INV-18: shared copy constants for the webview.
 *
 * `APPLIES_NEXT_SESSION` is the ONE canonical effect-latency sentence for
 * any UI surface that persists Hermes config-plane state (MCP servers,
 * skills, tools, model defaults, ...) which the LIVE `hermes acp` chat
 * session cannot observe. The chat agent's toolset/MCP set is built once,
 * at session mint (`acp_adapter/session.py`), from a snapshot of
 * `config.mcp_servers` — the ACP wire has no reload/close RPC, so a
 * config-plane write (however successfully persisted, however immediately
 * the panel's own refetch shows it as active) only reaches a chat that
 * starts AFTER the write. See `docs_claude/audit-fix-architecture.md`,
 * ADR-4 and T-G (TG-1..TG-4) for the full two-process-topology reasoning.
 *
 * INV-18: "Every UI surface that persists config the live ACP session
 * cannot observe carries the effect-latency sentence; new config-plane
 * mutations adopt it by using this shared constant." — do not hand-write a
 * near-duplicate sentence at a new call site; import this one.
 *
 * NOT used by the Tools panel's own note (`ToolsPanel.tsx`, TG-1): that note
 * communicates SCOPE (which sessions the toggles govern AT ALL — CLI/desktop,
 * never the editor chat), a different concern from this sentence's effect
 * LATENCY, and keeps its own two-sentence copy.
 */
export const APPLIES_NEXT_SESSION =
  'Takes effect in new chats; chats already open keep their current setup.';
