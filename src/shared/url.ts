/**
 * Shape-only validation that a configured endpoint is an `http(s)` URL.
 *
 * ## Why (security-review.md M3 / C1)
 * Configured endpoints (`talaria.autocomplete.endpoint`,
 * `talaria.rag.embedEndpoint`) are `POST`ed code context / embeddings. This
 * guard rejects non-http(s) schemes (`file:`, `data:`, …) and outright garbage
 * so a mistyped or hostile value can't smuggle in another scheme.
 *
 * IMPORTANT: this is deliberately SHAPE-ONLY. Any host is accepted, including
 * REMOTE ones — the Hermes inference/embeddings runner is legitimately a
 * user-configured remote node. Do NOT add loopback-only allow-listing or
 * link-local/metadata blocking here; that would break the product. The real
 * defense against a *workspace* redirecting the endpoint is `scope: "machine"`
 * on the setting (see package.json / C1), not host filtering.
 *
 * T-19 (C1+C2, boundary move): moved from `src/host/util/url.ts` to
 * `src/shared/` — `src/autocomplete/config.ts` (outside `host/`) needed it,
 * which was a zone-crossing edge (`autocomplete/` reaching into `host/util/`).
 * Byte-identical body; only the file's location changed.
 */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}
