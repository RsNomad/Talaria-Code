/**
 * W2 T5b (§2c "One-shot model-call surface") — the feature-facing port a
 * caller (T5c's commit-gen orchestrator, later any "explain quietly"
 * affordance) depends on, NEVER on `AcpBackend` directly. Shape pinned
 * verbatim (§2c).
 *
 * `AcpBackend.oneShot` (same task) is the only implementation today — it
 * rides the EXISTING ACP connection via an ephemeral `session/new`, so a
 * caller programming against this port alone gets: no new egress path for
 * credentials-grade content (the staged diff), the user's actually-configured
 * agent model (not a completion-shaped autocomplete base model), and the
 * isolation `AcpBackend` already has built (`handleSessionUpdate` drops
 * updates for any session that isn't the live one). §2c's documented fallback
 * — a direct OpenAI-compat one-shot, if the ACP seam proves unusable — swaps
 * the implementation behind this SAME port; commit-gen's pure core would not
 * change.
 */

/** The one-shot's outcome — `ok:false` covers refusal, timeout, the
 * tool-call tripwire, and lifecycle teardown alike; see `AcpBackend.oneShot`
 * for which `error` string each path resolves. */
export type OneShotResult = { ok: true; text: string } | { ok: false; error: string };

export interface UtilityModelPort {
  /**
   * Send exactly one prompt to a silent, isolated model call and resolve its
   * collected text. NEVER surfaces on the webview, NEVER touches the main
   * turn/checkpoint machinery, and NEVER concurrently runs alongside (or
   * during) a live main-session turn (§2c req 4). `opts.timeoutMs` defaults
   * to 30s (§2c req 5) — a hung call is cancelled and resolves `{ok:false}`,
   * never left pending forever.
   */
  complete(prompt: string, opts?: { timeoutMs?: number }): Promise<OneShotResult>;
}
