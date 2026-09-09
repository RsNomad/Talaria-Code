/**
 * A-03 (WS-AC): the degrade decision handed to the prompt-content builders
 * (`attachments.ts` / `mentions.ts`). One boolean, derived at ONE choke
 * point ({@link derivePromptCaps}) — the builders never read raw advertised
 * capabilities themselves.
 */
export interface PromptDegradeCaps {
  /**
   * true ⇒ embedded `{type:'resource'}` blocks are degraded to
   * `resource_link` / plain-text form. SHIPS false (inactive) — see
   * {@link derivePromptCaps}'s activation contract.
   */
  degradeEmbeddedResources: boolean;
}

/** The inactive decision — the only value {@link derivePromptCaps} returns today. */
export const PROMPT_DEGRADE_INACTIVE: PromptDegradeCaps = { degradeEmbeddedResources: false };

/**
 * A-03 (WS-AC): SHIP-INACTIVE BY DESIGN — returns
 * `{degradeEmbeddedResources: false}` for EVERY input today. The reason is a
 * verified live-behavior asymmetry, not an oversight:
 *
 * The shipped Hermes advertises `prompt_capabilities=PromptCapabilities(
 * image=True)` ONLY (`acp_adapter/server.py:889`) — `embeddedContext` is
 * never advertised — yet it ALREADY processes embedded resources: its
 * content-block ingestion dispatches `isinstance(block,
 * EmbeddedResourceContentBlock)` (`server.py:430-431`) into
 * `_embedded_resource_to_parts` (`:315`). Keying the degrade on the
 * advertised flag would therefore fire on EVERY attachment/mention turn
 * against the pinned harness, converting embedded resources Hermes handles
 * fine into `resource_link`+text of UNVERIFIED fidelity — a real wire
 * regression dressed up as conformance (compensating-violations posture,
 * documented).
 *
 * ACTIVATION CONTRACT (do not flip without one of these):
 * 1. the WS-A live-gateway step VERIFIES resource_link+text fidelity against
 *    a live harness (the `_resource_link_to_parts` leg, `server.py:216` —
 *    same content parts reach the model), or
 * 2. a target agent actually rejects embedded blocks with -32602 — the
 *    failure A-03 defends against.
 * When activated, the implementation is one line here:
 * `return { degradeEmbeddedResources: advertised?.embeddedContext !== true };`
 * The `advertised` parameter is threaded NOW so activation touches only this
 * function — callers and builders are already wired and tested.
 *
 * Upstream note (internal-notes/hermes-upstream-notes.md):
 * Hermes should advertise `embedded_context=True`, retiring the question.
 */
export function derivePromptCaps(advertised: Record<string, unknown> | undefined): PromptDegradeCaps {
  void advertised; // read at activation time — see the activation contract above
  return PROMPT_DEGRADE_INACTIVE;
}
