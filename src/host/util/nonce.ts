import { randomBytes } from 'node:crypto';

/**
 * Per-load CSP nonce generation for the webview.
 *
 * best-practices.md hard rule: every `<script>` served to the webview carries a
 * fresh nonce, and the CSP `script-src` allows only that nonce. A new value is
 * generated on every `resolveWebviewView` / HTML render.
 *
 * ## Why a CSPRNG (research-security-hardening.md S-M3)
 * A CSP nonce is a security token: if it is guessable, injected markup can carry
 * a matching `nonce=` and defeat `script-src 'nonce-…'`. The W3C CSP spec
 * requires nonces be generated with a cryptographically secure RNG and be
 * unguessable — so this uses Node's CSPRNG `crypto.randomBytes`, NOT
 * `Math.random()` (which is not cryptographically secure).
 *
 * 16 bytes = 128 bits of entropy, the practical floor for an unguessable nonce.
 * `base64url` (RFC 4648 §5, unpadded) is a valid CSP nonce token — its charset
 * `[A-Za-z0-9_-]` needs no HTML/attribute escaping when interpolated into the
 * CSP header and the `<script nonce="…">` attribute.
 *
 * Grounding (Context7 `/nodejs/node`, write-time): `crypto.randomBytes(size)`
 * "generates cryptographically strong pseudorandom data"; Buffer `base64url`
 * encoding follows RFC 4648 §5 and "will omit padding" when encoding.
 */

/** Returns a fresh 128-bit CSPRNG nonce (base64url) for a CSP `script-src` entry. */
export function getNonce(): string {
  return randomBytes(16).toString('base64url');
}
