/**
 * `servedToken` — pure string logic for the S3 dashboard spawn-only provenance
 * check (CWE-306 Missing Authentication / CWE-346 Origin Validation).
 *
 * Mirror of Hermes desktop's `apps/desktop/electron/dashboard-token.cjs`
 * (`extractInjectedDashboardToken` + `isForeignBackendToken`) — READ-ONLY
 * reference, not imported. Zero vscode/fs/network here by design: this module
 * is the testable, headless core of the provenance check.
 *
 * On loopback Hermes ignores the session token for AUTH (`should_require_auth`
 * = false), so the token is not what authorizes our PUTs — it is a PROVENANCE
 * proof. `hermes serve` embeds the token it is actually using into the served
 * `/` HTML as `window.__HERMES_SESSION_TOKEN__="…"`. After we spawn our own
 * child and it becomes healthy, we fetch `/` and compare the served token
 * against the one we minted and injected, to confirm the healthy server is the
 * child we spawned — not a squatter that already held the port.
 */

/**
 * Pull the injected `window.__HERMES_SESSION_TOKEN__` assignment out of served
 * dashboard HTML. Returns `null` when the marker is absent, the captured value
 * is not valid JSON, or the decoded value is an empty/non-string.
 */
export function extractInjectedDashboardToken(html: string): string | null {
  const match = /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/.exec(html ?? '');
  if (!match) return null;
  const captured = match[1];
  if (captured === undefined) return null; // unreachable: group is non-optional
  try {
    const value: unknown = JSON.parse(captured);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Inputs to {@link isForeignBackendToken}. */
export interface ForeignBackendTokenCheck {
  /** The token extracted from the served `/` HTML, or `null` if unreadable/absent. */
  servedToken: string | null;
  /** The token we minted and injected when we spawned our child. */
  spawnToken: string;
  /** Whether the child WE spawned is still alive, sampled AFTER the served-token fetch. */
  childAlive: boolean;
}

/**
 * THE CRUX: this is NOT a plain token-mismatch check.
 *
 * A served token that differs from our spawn token WHILE OUR CHILD IS DEAD came
 * from a process we did not spawn — a squatter that already held the port and
 * satisfied the health probe. That is FOREIGN: refuse it (CWE-306/346).
 *
 * A served token that differs from our spawn token WHILE OUR CHILD IS ALIVE is
 * BENIGN: it is still our own backend — its env-pinned token just did not
 * survive the spawn, and it regenerated its own. Accept it (use the served
 * token going forward).
 *
 * A `null` served token is the NORMAL value for our own healthy child: the
 * `serve` we spawn runs HEADLESS (`HERMES_SERVE_HEADLESS=1`), so `GET /`
 * returns 404 with no `__HERMES_SESSION_TOKEN__` marker. So `null` is
 * disambiguated by LIVENESS, not by falling back to the spawn token: `null`
 * with a LIVE child is our own headless backend (accept); `null` with a DEAD
 * child means a process we did NOT spawn answered the health probe while our
 * child failed to bind the port (FOREIGN — refuse). This is a DELIBERATE
 * divergence from the reference `dashboard-token.cjs`, which coalesces
 * `null → spawnToken` BEFORE this check and therefore can never catch a
 * no-marker squatter. Do NOT re-add a `Boolean(servedToken)` guard or the
 * null-coalesce — either reintroduces the CWE-306/346 fail-open (a squatter
 * that answers /api/status but serves no marker, with our child dead, would be
 * adopted). Confirmed by adversarial security review.
 *
 * (Outer bound, documented residual: because headless `serve` never emits the
 * marker, provenance rests entirely on `childAlive` — which proves our child
 * is RUNNING, not that it BOUND the port. A squatter that keeps our child
 * alive-but-unbound (non-standard EADDRINUSE handling / SO_REUSEPORT) still
 * slips through; standard uvicorn exits on EADDRINUSE so the common case is
 * closed. A true fix needs port-ownership proof, not a shared-port probe.)
 */
export function isForeignBackendToken(check: ForeignBackendTokenCheck): boolean {
  return check.servedToken !== check.spawnToken && !check.childAlive;
}
