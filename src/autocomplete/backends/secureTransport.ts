/**
 * S4.2 (CWE-319, Cleartext Transmission of Sensitive Information). Pure —
 * no `vscode`/`fetch`; called at the top of a backend's `streamFim`, before
 * `fetch`, so a Bearer key can never leave the process over an insecure
 * transport.
 *
 * Controller decision: KEEP the loopback carve-out (do not require https
 * always). `http:` to a REMOTE host with an apiKey is refused — the key would
 * cross a real network in cleartext. `http:` to loopback is allowed — a local
 * authed server (e.g. a hand-rolled openai-compat shim on 127.0.0.1) never
 * puts the key on a network. `https:` is allowed everywhere. No apiKey means
 * nothing secret is in the request, so the default Ollama (no-auth, http,
 * loopback-or-remote-runner) path is entirely unaffected.
 *
 * `LOOPBACK` here is the single source of truth for "is this host loopback" —
 * `isLoopbackHost` is exported so S4.3 (Restricted Mode transport gating)
 * reuses it instead of hand-rolling a second list.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when `hostname` (as returned by `URL#hostname`) is the local loopback interface. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/**
 * Thrown by `assertSecureAuthTransport` when it refuses a request. Lets a
 * catch site (A5) narrow on this specific security refusal instead of
 * treating it like any other network failure.
 */
export class InsecureTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureTransportError';
  }
}

/**
 * Throws when `hasApiKey` is true and `rawUrl` resolves to `http:` on a
 * non-loopback host. Returns (no-op) for `https:` anywhere, for `http:` to
 * loopback, and whenever no apiKey is set.
 */
export function assertSecureAuthTransport(rawUrl: string, hasApiKey: boolean): void {
  if (!hasApiKey) return;
  const u = new URL(rawUrl);
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return;
  // SAFETY CONTRACT (security M-3 / F-C item 4): this exact message reaches
  // the Hermes OUTPUT CHANNEL verbatim via provider.ts:405 (the toast is
  // rebuilt; the channel line is not). NEVER interpolate rawUrl, a
  // hostname, or any other caller-supplied value here — rawUrl can carry
  // userinfo credentials (https://user:pass@host). Locked by the
  // no-fragment-of-input property test in secureTransport.test.ts and the
  // byte-pin test above it.
  throw new InsecureTransportError(
    'Refusing to send the autocomplete API key over cleartext http to a remote host (CWE-319). Use https, or a loopback endpoint.',
  );
}
