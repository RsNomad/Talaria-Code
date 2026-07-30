import * as child_process from 'node:child_process';
import * as crypto from 'node:crypto';
import type { Logger } from '../transport/JsonRpcStdio';
import type { HermesRuntimeConfig } from '../runtime/resolveHermes';
import { resolveHermes, loginShellSpawn } from '../runtime/resolveHermes';
import {
  HermesDashboardClient,
  type AdoptableDashboardClient,
  type DashboardClientLike,
} from './HermesDashboardClient';
import { isForeignBackendToken } from './servedToken';

/**
 * `HermesDashboardManager` — discover-or-spawn lifecycle for the dashboard REST
 * server (W1.5). Mirrors the tui_gateway/ACP spawn the extension already owns.
 *
 * ## S3 — spawn-only default + served-token provenance (CWE-306/346)
 * `talaria.dashboardAdopt` (`opts.adopt`) selects the discovery strategy:
 *
 *  - **`'spawn-only'` (default, SECURE).** Never probes or adopts a pre-existing
 *    peer — shape alone (`probeAdopt`) is spoofable by any local squatter that
 *    serves a Hermes-shaped `/api/status`, which is authentication-by-shape, not
 *    authentication. Instead we ALWAYS mint our own
 *    `HERMES_DASHBOARD_SESSION_TOKEN`, spawn the headless Hermes backend as a
 *    lifecycle-managed child, health-probe it with backoff, and then verify
 *    PROVENANCE: fetch `/` and extract the served `window.__HERMES_SESSION_TOKEN__`
 *    (mirrors Hermes desktop's `dashboard-token.cjs`). A served token that
 *    differs from ours while our child is DEAD came from a process we did not
 *    spawn — foreign, refuse (throw). A mismatch while our child is ALIVE is
 *    benign (the backend regenerated its own token because the env pin didn't
 *    survive the spawn) — accept it, re-clienting with the served token. See
 *    {@link isForeignBackendToken} for the exact rule (NOT a plain match).
 *  - **`'shape'` (legacy, INSECURE opt-in).** Probe `GET /api/status`; if it
 *    answers 2xx AND the body is Hermes-shaped (`probeAdopt`), adopt the
 *    already-running dashboard with no further verification. Kept only for
 *    users who need to coexist with an already-running Hermes desktop holding
 *    the port; understand this trusts shape alone.
 *  - **Fail-open-visible (both modes).** If nothing yields a verified, healthy
 *    server, `ensure()` REJECTS (the memo is cleared so the next panel fetch
 *    retries), so the panels show a RETRYABLE error via the RemoteData model —
 *    NEVER a fake toggle.
 *
 * ## The launch command (VERIFIED against Hermes source, corrects the TZ)
 * There is **no `web` subcommand**. The dashboard FastAPI app is booted by two
 * subcommands sharing `web_server.start_server` (`hermes_cli/subcommands/
 * dashboard.py`): `dashboard` (opens a browser + builds the SPA) and `serve`
 * (**headless** — skips the web-UI build, never mounts the SPA). Its docstring is
 * explicit: "the desktop app spawns `serve`, never `dashboard`." We are a headless
 * REST client exactly like the desktop app, so we spawn **`serve`** — the same
 * `/api/*` routes, none of the SPA/npm-build weight. `--port` defaults to 9119 and
 * `--host` to 127.0.0.1 (`dashboard.py:26-31`).
 *
 * BUILD-BLIND: the real spawn goes through `resolveHermes`, which resolves
 * `hermes`/`python` off the login-shell `PATH` (Fedora/Linux target) — on a dev
 * box without that PATH set up, `spawnServe` rejects quickly, so spawn-only
 * `ensure()` correctly rejects (→ retryable panel error). The `adopt:'shape'`
 * legacy path can still ADOPT on a dev box with a local dashboard running. Every
 * decision path — adopt vs. spawn, health probe/backoff, and the S3 provenance
 * verification — is unit-tested with injected fakes; no real process is spawned
 * in tests.
 */

/** A lifecycle handle for the spawned dashboard child. */
export interface DashboardChild {
  kill(): void;
  /**
   * Is the child we spawned still running? Backs the S3 provenance check
   * ({@link isForeignBackendToken}) — sampled AFTER the served-token fetch, not
   * before, so a child that exits mid-fetch is correctly seen as dead.
   */
  alive(): boolean;
}

/** The service surface `AcpBackend` depends on — injected, never imported concretely. */
export interface DashboardService {
  /**
   * Resolve a READY dashboard client (adopt-or-spawn + health probe), memoized.
   * Rejects (and clears the memo, so a later call retries) when the dashboard
   * cannot be brought up — the panels then surface a retryable error.
   */
  ensure(): Promise<DashboardClientLike>;
  /** Kill any child we spawned (an adopted dashboard is left running). */
  dispose(): void;
}

/** Injectable seams — real defaults; tests override to avoid the OS entirely. */
export interface HermesDashboardManagerDeps {
  /** Build a client for `port`/`host`, optionally authed with a minted `token`. */
  makeClient: (token: string | undefined) => AdoptableDashboardClient;
  /** Spawn the headless `serve` child with `HERMES_DASHBOARD_SESSION_TOKEN=token`. */
  spawn: (token: string) => Promise<DashboardChild>;
  /** Await `ms` between health probes (injected so tests don't really sleep). */
  sleep: (ms: number) => Promise<void>;
  /** Mint the session token we inject into the spawned child. */
  mintToken: () => string;
}

export interface HermesDashboardManagerOptions {
  config: HermesRuntimeConfig;
  /** `talaria.dashboardPort` (default 9119). */
  port: number;
  host?: string;
  logger?: Logger;
  /** Health-probe backoff schedule (ms) for a freshly-spawned child. */
  probeBackoffMs?: number[];
  /**
   * `talaria.dashboardAdopt`: `'spawn-only'` (default, SECURE) never adopts a
   * foreign peer — it always spawns and provenance-verifies its own child.
   * `'shape'` is the legacy INSECURE opt-in (shape-only adoption, Security M3
   * without the S3 provenance hardening). Defaults to `'spawn-only'`.
   */
  adopt?: 'spawn-only' | 'shape';
  deps?: Partial<HermesDashboardManagerDeps>;
}

/** Default backoff for the post-spawn health probe (~9.4s total across 8 tries). */
const DEFAULT_PROBE_BACKOFF_MS = [150, 300, 500, 800, 1200, 1600, 2000, 2800];

export class HermesDashboardManager implements DashboardService {
  private readonly deps: HermesDashboardManagerDeps;
  private readonly probeBackoffMs: number[];
  private child: DashboardChild | undefined;
  private ready: Promise<DashboardClientLike> | undefined;
  private disposed = false;

  constructor(private readonly opts: HermesDashboardManagerOptions) {
    this.probeBackoffMs = opts.probeBackoffMs ?? DEFAULT_PROBE_BACKOFF_MS;
    this.deps = {
      makeClient: (token) =>
        new HermesDashboardClient({
          port: opts.port,
          host: opts.host,
          token,
          logger: opts.logger,
        }),
      spawn: (token) => this.spawnServe(token),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      mintToken: () => crypto.randomBytes(32).toString('base64url'),
      ...opts.deps,
    };
  }

  ensure(): Promise<DashboardClientLike> {
    if (this.disposed) return Promise.reject(new Error('HermesDashboardManager: disposed'));
    // CF-15: a previously memoized bring-up (`this.ready` already resolved)
    // can go stale when the child dies AFTER we started trusting it — e.g. the
    // spawned Hermes backend crashes post-ready. Without this re-check, the
    // Skills/Tools panel's "Retry" would call `ensure()` and get the SAME dead
    // client back forever (the memo only clears on a bring-up REJECTION, never
    // on a later liveness change). Detect that here, before the memo check,
    // and clear the same fields `dispose()` clears — `kill()` is idempotent
    // (a no-op on an already-dead child) so this mirrors that path exactly
    // rather than hand-rolling a partial reset.
    if (this.child && !this.child.alive()) {
      try {
        this.child.kill();
      } catch (err) {
        this.log(`failed to kill dead dashboard child: ${errorMessage(err)}`);
      }
      this.child = undefined;
      this.ready = undefined;
    }
    if (!this.ready) {
      this.ready = this.bringUp().catch((err) => {
        // Clear the memo so the NEXT panel fetch (Retry) re-attempts adopt/spawn
        // rather than caching the failure forever.
        this.ready = undefined;
        throw err;
      });
    }
    return this.ready;
  }

  dispose(): void {
    this.disposed = true;
    this.ready = undefined;
    if (this.child) {
      try {
        this.child.kill();
      } catch (err) {
        this.log(`failed to kill dashboard child: ${errorMessage(err)}`);
      }
      this.child = undefined;
    }
  }

  // --- internals -------------------------------------------------------------

  private async bringUp(): Promise<DashboardClientLike> {
    const mode = this.opts.adopt ?? 'spawn-only';

    // 'shape' is the legacy, INSECURE opt-in: adopt a dashboard already
    // listening on the port purely because its /api/status body LOOKS like
    // Hermes (Security M3) — no further verification. spawn-only NEVER takes
    // this branch, so it never even builds an adopt-mode client.
    if (mode === 'shape') {
      const adopt = this.deps.makeClient(undefined);
      if (await adopt.probeAdopt()) {
        this.log(`adopted a running dashboard at ${this.describeTarget()} (adopt:'shape' — insecure)`);
        return adopt;
      }
    }

    // spawn-only (default), or 'shape' that found nothing to adopt: own the
    // port ourselves — spawn a headless `serve` child, authed with our minted
    // token.
    this.log(`no dashboard adopted at ${this.describeTarget()} — spawning 'serve'`);
    const token = this.deps.mintToken();
    this.child = await this.deps.spawn(token);

    // P4a: dispose() only kills `this.child` if it is ALREADY assigned at the
    // time dispose() runs. `dispose()` racing this exact `await` (spawn still
    // in flight when it fires) sees no child to kill; by the time the
    // assignment above lands, `this.disposed` is already true but the child
    // was never killed. Catch that race here — the ONLY place a freshly
    // spawned child can still be unowned by dispose().
    if (this.disposed) {
      this.child.kill();
      this.child = undefined;
      throw new Error('HermesDashboardManager: disposed while starting');
    }
    const client = this.deps.makeClient(token);

    // DASH-2: capture the child handle now, before any further await —
    // `dispose()` racing one of the awaits below (most notably
    // `fetchServedToken()`) kills AND nulls `this.child` concurrently, and a
    // bare `this.child.alive()` read after that point would TypeError
    // instead of surfacing the clean "disposed" rejection every other race
    // in this class gives. `child` stays a valid reference regardless.
    const child = this.child;

    // P4a: every step below can throw (health-probe timeout, a provenance
    // refusal, `dispose()` firing mid-probe) — without this wrapper, `this.child`
    // (already spawned above) would leak: the promise rejects, `ensure()`'s
    // memo clears, and the NEXT `ensure()` (panel Retry, or a later use) spawns
    // ANOTHER child on top of the still-running orphan (spawn-only makes this
    // the common path, not an edge case).
    try {
      // Health-probe with backoff until it answers, or give up (retryable).
      await this.waitHealthy(client);

      // S3 PROVENANCE (CWE-306/346): a healthy 2xx server on our port is not
      // necessarily the child we just spawned — a squatter that already held the
      // port could satisfy the same health probe. Confirm identity via the
      // session token Hermes serves in `/` HTML. `childAlive` is sampled AFTER
      // this fetch (not before), matching the reference's liveness-thunk timing.
      const servedToken = await client.fetchServedToken();
      // DASH-2: dispose() may have fired while the fetch above was in
      // flight (it already killed `child` and cleared `this.child`) — give
      // the same clean "disposed" rejection `waitHealthy`'s own mid-probe
      // check gives, rather than pressing on with a client whose child is
      // already gone.
      if (this.disposed) {
        throw new Error('HermesDashboardManager: disposed while starting');
      }
      if (isForeignBackendToken({ servedToken, spawnToken: token, childAlive: child.alive() })) {
        throw new Error(
          `dashboard at ${this.describeTarget()} is served by a process we did not spawn — refusing (CWE-306/346)`,
        );
      }

      this.log(`spawned dashboard healthy + provenance-verified at ${this.describeTarget()}`);
      // Benign drift: the backend regenerated its own token (env pin didn't
      // survive the spawn) — adopt the served token going forward.
      return servedToken && servedToken !== token ? this.deps.makeClient(servedToken) : client;
    } catch (err) {
      child.kill(); // idempotent — a no-op if dispose() already killed it
      this.child = undefined;
      throw err;
    }
  }

  private async waitHealthy(client: DashboardClientLike): Promise<void> {
    for (const delay of this.probeBackoffMs) {
      await this.deps.sleep(delay);
      if (this.disposed) throw new Error('HermesDashboardManager: disposed while starting');
      if (await client.probe()) return;
    }
    throw new Error(
      `Hermes dashboard did not become reachable at ${this.describeTarget()} after ${this.probeBackoffMs.length} attempts`,
    );
  }

  /**
   * The REAL spawn. Resolves the same venv python + login-shell wrapping the
   * ACP/control channels use, then spawns
   * `python -m hermes_cli.main serve --port <port> --host 127.0.0.1` with the
   * minted `HERMES_DASHBOARD_SESSION_TOKEN` injected. On a dev box without a
   * Fedora-style login-shell `PATH`, `resolveHermes` rejects quickly, so this
   * never actually spawns there — unit tests inject a fake `spawn` instead.
   */
  private async spawnServe(token: string): Promise<DashboardChild> {
    const resolved = await resolveHermes(this.opts.config);
    const host = this.opts.host ?? '127.0.0.1';
    const spec = loginShellSpawn(
      resolved.python,
      ['-m', 'hermes_cli.main', 'serve', '--port', String(this.opts.port), '--host', host],
      this.opts.config,
    );
    const proc = child_process.spawn(spec.command, spec.args, {
      cwd: resolved.cwd,
      env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token },
      stdio: 'ignore',
    });
    // T-B2 (V-9): per Node's child_process docs, a spawn FAILURE emits 'error'
    // and MAY NEVER emit 'exit' — liveness keyed only on 'exit' is fail-open.
    // Both handlers mark the same `dead` flag; the idempotent boolean is the
    // double-fire guard (Node docs note 'error' and 'exit' may both fire).
    let dead = false;
    proc.on('error', (err) => {
      dead = true;
      this.log(`dashboard child error: ${errorMessage(err)}`);
    });
    proc.on('exit', (code) => {
      dead = true;
      this.log(`dashboard child exited (code ${code})`);
    });
    return { kill: () => proc.kill(), alive: () => !dead };
  }

  private describeTarget(): string {
    return `http://${this.opts.host ?? '127.0.0.1'}:${this.opts.port}`;
  }

  private log(message: string): void {
    this.opts.logger?.append(`[HermesDashboard] ${message}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
