/**
 * WS-FIM CA-06 — the active-file FIM egress CONTENT gate.
 *
 * The provider's `isSecretForCompletion` gate is name-only: a secret
 * hard-coded in a normally-named file was POSTed to the model endpoint with
 * no content scan (cross-file snippets get `assertAllScanned`; the active
 * file got nothing). This module closes that hole for the case where it is
 * real exposure — a NON-loopback endpoint — by running the existing FROZEN
 * `secretScanner` over the exact egressing strings (the post-prune,
 * post-injection prefix and the post-prune suffix), fail-CLOSED.
 *
 * Loopback classifier (ADR-021, rev-2 pinned): the exemption applies ONLY
 * when `new URL(endpoint)` parses AND its `hostname` EXACT-matches a
 * loopback literal — `localhost` (exact string), an IPv4 in `127.0.0.0/8`,
 * or `::1`/`[::1]`. Everything else — unparseable URL, empty host,
 * `0.0.0.0`, IPv6 aliases, and crucially DNS names *containing* "localhost"
 * (`localhost.evil.com`) — SCANS. A substring/`startsWith`/`includes` host
 * check is FORBIDDEN here: it re-opens the exact exfiltration hole this
 * gate closes. WHATWG URL canonicalizes hex/octal IPv4 forms to dotted
 * quads before we see them; a runtime that did not would leave the literal
 * failing the anchored regex below, which is a SCAN — safe either way.
 *
 * Frozen-zone discipline: `scanSnippetForSecrets` is imported, never
 * edited. Its own bounds (MAX_SCAN_CONTENT / MAX_SCAN_LINE) return
 * `allowed:false` on anomalous oversize content — that is a BLOCK here,
 * which is fail-closed by design (see ADR-021 for the raised-budget
 * consequence).
 */
import { isLoopbackHost } from './backends/secureTransport';
import { scanSnippetForSecrets } from './context/secretScanner';

export type EgressVerdict = 'allow' | 'block';

/** The engine's pre-egress hook shape (`FimEngineDeps.checkEgress`). */
export type FimEgressGuard = (texts: readonly string[]) => EgressVerdict;

/**
 * Constant synthetic path handed to the frozen scanner: this call is a pure
 * CONTENT gate — the provider's name gate already ran on the real, decoded
 * document path and remains the single path authority. The constant is not
 * secret-classified, so the scanner's Layer-1 path check is inert and its
 * content layers always run.
 */
const ACTIVE_FILE_SCAN_PATH = 'fim-active-file';

/** Anchored dotted-quad in 127.0.0.0/8. Anchoring (`^…$`) is load-bearing:
 *  `127.0.0.1.evil.com` must NOT match. Octets are range-checked below. */
const IPV4_LOOPBACK_RE = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * TRUE only for a parsed, exact-match loopback host (see module doc).
 * FALSE = "the caller scans" — every failure mode lands there.
 */
export function isLoopbackFimEndpoint(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false; // unparseable ⇒ NOT loopback ⇒ scan (fail-toward-scan)
  }
  if (hostname === '') return false;
  // Exact-match Set (localhost / 127.0.0.1 / ::1 / [::1]) — reuses S4.2's
  // single source of truth rather than a second hand-rolled list.
  if (isLoopbackHost(hostname)) return true;
  const m = IPV4_LOOPBACK_RE.exec(hostname);
  if (m === null) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Scan the exact egressing strings with the frozen scanner. Any HIT — or a
 * scanner THROW — is a `'block'` (fail-closed, mirroring
 * `ringBuffer.ingest`'s throw-is-reject posture).
 */
export function scanFimEgressTexts(texts: readonly string[]): EgressVerdict {
  for (const content of texts) {
    let allowed: boolean;
    try {
      allowed = scanSnippetForSecrets({ path: ACTIVE_FILE_SCAN_PATH, content }).allowed;
    } catch {
      allowed = false;
    }
    if (!allowed) return 'block';
  }
  return 'allow';
}

/**
 * Classify ONCE per engine build (the endpoint is fixed per `buildEngine`
 * call). Loopback ⇒ a constant-allow function: zero scanner work per
 * completion, request bytes unchanged — the default path stays
 * byte-identical (Global Constraints). Non-loopback ⇒ the scanning guard.
 */
export function makeFimEgressGuard(endpoint: string): FimEgressGuard {
  if (isLoopbackFimEndpoint(endpoint)) {
    return () => 'allow';
  }
  return scanFimEgressTexts;
}
