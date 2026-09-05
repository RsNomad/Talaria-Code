/**
 * CA-M17 (WS-BG): the ONE definition of "well-formed preview id" and the ONE
 * compose point for the `(sessionId, toolCallId)` compound identity that
 * `EditPreviewRegistry` keys on and `talaria-diff:` URIs carry.
 *
 * The class this kills: two independent ad-hoc compositions of the same id
 * pair — the registry's space-joined Map key and `buildDiffUriParts`'
 * slash-joined URI path — each silently ASSUMING its own delimiter never
 * occurs inside an id. ACP ids are harness-generated and satisfy that today
 * (SEC-1: CA-M17 traced-safe), but nothing enforced it: an id carrying a
 * delimiter would alias one `(sessionId, toolId)` pair onto another's key or
 * URI. Both compositions now go through this module, and an id that either
 * delimiter could mis-parse is REFUSED (fail-safe: a refused id simply never
 * registers / never opens a preview — the placeholder posture the registry
 * already mandates on any miss).
 */

declare const PreviewKeyBrand: unique symbol;

/** Branded space-joined compound key — only {@link composePreviewKey} mints one. */
export type PreviewKey = `${string} ${string}` & { readonly [PreviewKeyBrand]: true };

/**
 * Well-formed = non-empty, no `/` (the `talaria-diff:` path delimiter), no
 * whitespace (the registry Map-key delimiter, plus general URI hygiene).
 * Every harness-generated ACP session/tool-call id satisfies this.
 */
export function isSafePreviewId(id: string): boolean {
  return id.length > 0 && !/[\s/]/.test(id);
}

/** The ONLY constructor of {@link PreviewKey}. `undefined` = refused id. */
export function composePreviewKey(sessionId: string, toolId: string): PreviewKey | undefined {
  if (!isSafePreviewId(sessionId) || !isSafePreviewId(toolId)) return undefined;
  return `${sessionId} ${toolId}` as PreviewKey;
}
