/**
 * Pure Workspace-Trust gating decisions.
 *
 * Kept free of any `vscode` import so it stays unit-testable and so the policy
 * lives in one auditable place.
 *
 * ## Why (security-review.md C1)
 * The real `acp` backend spawns child processes (`hermes acp`,
 * `python -m tui_gateway.entry`) using the workspace-influenced
 * `hermes.pythonPath`/`hermes.cwd`, and the RAG indexer walks the workspace and
 * POSTs file contents to an embeddings endpoint. Both are unsafe to run against
 * a repository the user has not explicitly trusted. The default `mock` backend
 * spawns nothing and does no network/FS work, so it is safe in either mode.
 */

/**
 * D2 (A2): re-exported, not redefined — the canonical `BackendKind` now
 * lives in `../shared/protocol.ts` (the dependency-free wire-contract
 * module) so the webview's `WebviewState.backendKind`/`backend.state` push
 * can reference the SAME type without `protocol.ts` importing from
 * `src/host/*` (which would invert the shared/host dependency direction).
 * This file keeps the name so every existing `BackendKind` reference here
 * stays a one-definition reuse, not a fork.
 */
import type { BackendKind } from '../shared/protocol';
export type { BackendKind };

/**
 * Which backend to actually construct, given the configured `hermes.backend`
 * value and the current Workspace Trust state.
 *
 * The process-spawning `acp` backend is chosen ONLY in a trusted workspace;
 * `acp` while untrusted (and anything else, including the default) falls back
 * to the process-free {@link mock} backend. This is the single control that
 * closes the C1 "malicious `.vscode/settings.json` → `pythonPath` → RCE" path.
 */
export function selectBackendKind(backendSetting: string, isTrusted: boolean): BackendKind {
  return backendSetting === 'acp' && isTrusted ? 'acp' : 'mock';
}

/**
 * Whether the codebase RAG indexer (workspace file walk + embeddings POST) may
 * run: it requires the feature to be enabled, a workspace to be open, and the
 * workspace to be trusted.
 */
export function shouldActivateRag(enabled: boolean, hasWorkspace: boolean, isTrusted: boolean): boolean {
  return enabled && hasWorkspace && isTrusted;
}

/**
 * Whether the LIB LSP-over-HTTP MCP server may activate: it binds a loopback
 * listener and exposes the user's workspace symbols/definitions/snippets to the
 * agent, so it requires the feature enabled, a workspace open, and the workspace
 * trusted (untrusted ⇒ no bind, no advertisement, no tools — research §4.2).
 */
export function shouldActivateLib(enabled: boolean, hasWorkspace: boolean, isTrusted: boolean): boolean {
  return enabled && hasWorkspace && isTrusted;
}
