import type { Logger } from '../transport/JsonRpcStdio';
import { extractInjectedDashboardToken } from './servedToken';
import { httpFailureMessage } from '../../shared/httpFailure';
import type { McpTestResult, McpCatalogData, HubPreview, HubScan } from '../../shared/protocol';

/**
 * `HermesDashboardClient` — the THIRD Hermes client channel (W1.5).
 * ------------------------------------------------------------------
 * Beyond ACP (chat/session) and tui_gateway (global-config RPC), Hermes exposes
 * a first-party **dashboard web server** (FastAPI, `hermes_cli/web_server.py`,
 * default `http://127.0.0.1:9119`) — the admin/CRUD plane the desktop app drives
 * (`apps/desktop/src/hermes.ts`). This is a thin, loopback-only REST client for
 * the exact endpoints the Skills & Tools panels need. Zero Hermes core change —
 * we are a REST client, precisely as `apps/desktop` is.
 *
 * ## Wire contracts (grounded in `hermes_cli/web_server.py`)
 * - `GET  /api/skills` → `[{name, description, category, enabled, usage,
 *   provenance, ...}]`, `enabled = name not in disabled` (`:12921-12950`).
 * - `PUT  /api/skills/toggle` body `{name, enabled, profile?}` →
 *   `{ok, name, enabled}`; RMW of the `skills.disabled` denylist in
 *   `~/.hermes/config.yaml` via `save_disabled_skills` (`:12953-12964`).
 * - `GET  /api/tools/toolsets` → `[{name, label, description, enabled,
 *   available, configured, tools[]}]` (`:13046-13079`).
 * - `PUT  /api/tools/toolsets/{name}` body `{enabled, profile?}` →
 *   `{ok, name, enabled}` (`:13087-13116`).
 * - `GET  /api/status` → 200 liveness probe, PUBLIC (no token) even non-loopback
 *   (`dashboard_auth/public_paths.py`) — used as the adopt/health probe.
 *
 * ## Auth & the loopback Host-guard (`web_server.py:389-393,455-472`)
 * A loopback bind (127.0.0.1/localhost/::1) needs **no token**: `should_require_auth`
 * returns False, and none of the skills/tools endpoints call `_require_token`.
 * The one hard requirement is the DNS-rebind Host-header guard: when the server
 * is bound to loopback it rejects any request whose `Host` header is not a
 * loopback value. We satisfy that by construction — the base URL's authority is
 * `127.0.0.1:<port>`, so the HTTP client derives `Host: 127.0.0.1:<port>`
 * automatically (undici's `fetch` FORBIDS overriding `Host` manually; the
 * URL authority is the correct, and only, way to set it). An optional
 * `X-Hermes-Session-Token` is sent when we spawned the server ourselves and
 * minted a token — harmless on loopback (ignored by these endpoints), and
 * defense-in-depth should a future bind become non-loopback.
 *
 * BUILD-BLIND: this is unit-tested against a stubbed `fetch` returning the pinned
 * response shapes (toggle round-trips; a non-2xx / network error rejects). The
 * wire correctness comes from reading Hermes source, not from a live dashboard.
 */

/** One skill row from `GET /api/skills` (grounded fields; extras tolerated). */
export interface DashboardSkill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  usage: number;
  /** `hub` | `bundled` | `agent` (`web_server.py:12945-12949`). */
  provenance: string;
}

/** One toolset row from `GET /api/tools/toolsets` (`web_server.py:13063-13078`). */
export interface DashboardToolset {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  configured: boolean;
  tools: string[];
}

/** Response of `PUT /api/skills/toggle` and `PUT /api/tools/toolsets/{name}`. */
export interface DashboardToggleResult {
  ok: boolean;
  name: string;
  enabled: boolean;
}

/**
 * The narrow surface `AcpBackend` / the dashboard panel sources depend on — kept
 * as an interface so the manager can inject a fake and tests never touch the OS.
 * The concrete {@link HermesDashboardClient} satisfies it structurally.
 */
export interface DashboardClientLike {
  /** `GET /api/status` → true iff 2xx (adopt/health probe; never throws). */
  probe(): Promise<boolean>;
  listSkills(): Promise<DashboardSkill[]>;
  toggleSkill(name: string, enabled: boolean): Promise<DashboardToggleResult>;
  listToolsets(): Promise<DashboardToolset[]>;
  toggleToolset(name: string, enabled: boolean): Promise<DashboardToggleResult>;
}

/**
 * A dashboard client that can additionally VERIFY the responder is Hermes before
 * the manager adopts it (Security M3). Kept as a superset of {@link
 * DashboardClientLike} so the interface that {@link DashboardService.ensure}
 * hands to panel sources stays unchanged (they never adopt) — only the
 * discover-or-spawn manager depends on the stronger, adopt-capable contract.
 */
export interface AdoptableDashboardClient extends DashboardClientLike {
  /**
   * The ADOPT gate: `GET /api/status` → true iff 2xx AND the body is a
   * Hermes-shaped status ({@link isHermesStatusShape}); never throws. A bare 2xx
   * is NOT enough to adopt — a rogue loopback listener squatting the (machine-
   * scoped) dashboard port could answer 2xx to `/api/status` yet be anything, and
   * adopting it would send our skill/tool toggle `PUT`s to an unverified server.
   * So the manager adopts only when THIS resolves true. (Defense-in-depth: the
   * port is loopback-only on the single-user Fedora target.)
   */
  probeAdopt(): Promise<boolean>;
  /**
   * P4c (ISP): moved off {@link DashboardClientLike} — only
   * {@link HermesDashboardManager.bringUp}'s S3 provenance check calls this,
   * never `AcpBackend`/the panel sources that depend on the narrower
   * `DashboardClientLike` surface. GET `/` and extract the served
   * `window.__HERMES_SESSION_TOKEN__` (S3, CWE-306/346 provenance check).
   * `null` on a non-2xx response, a network error, or a 2xx body without the
   * marker — never throws.
   */
  fetchServedToken(): Promise<string | null>;
}

/**
 * Admin/CRUD surface (T1 MCP admin + catalog; `actionStatus` is shared
 * polling infra pulled forward from T2 per the A2 scope note — A6's catalog
 * background-install polling needs it before B2 lands). Kept SEPARATE from
 * {@link DashboardClientLike} (P4c ISP precedent, see {@link
 * AdoptableDashboardClient}) so the panel sources and their fakes stay
 * untouched — only the consequence-bearing admin actions (dispatched via
 * `ControlDispatcher`) depend on this narrower, mutation-capable surface.
 * `HermesDashboardClient` implements it structurally (see `implements`
 * clause below); `ControlDispatcher` narrows an untyped `DashboardClientLike`
 * via {@link hasDashboardAdmin} — the `hasToggleNameCache` idiom
 * (`dashboardPanelSources.ts:39-45`).
 *
 * T2 skill-admin members (`createSkill`, `previewHubSkill`, `scanHubSkill`,
 * `installHubSkill`, `uninstallHubSkill`) added by task B2.
 */
export interface DashboardAdminClient {
  /** `POST /api/mcp/servers` (`web_server.py:10410-10452`). */
  addMcpServer(body: {
    name: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }): Promise<unknown>;
  /** `DELETE /api/mcp/servers/{name}` → `{ok:true}` | 404 (`:10474-10482`). */
  removeMcpServer(name: string): Promise<{ ok: boolean }>;
  /** `POST /api/mcp/servers/{name}/test` — 200-envelope even on failure (`:10485-10542`). */
  testMcpServer(name: string): Promise<McpTestResult>;
  /** `PUT /api/mcp/servers/{name}/enabled` body `{enabled}` (`:10660-10679`). */
  setMcpServerEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; name: string; enabled: boolean }>;
  /**
   * `POST /api/mcp/servers/{name}/auth` — may legitimately block ~5+ minutes
   * for the browser OAuth flow (server probe window >= 315s, `:10606-10614`).
   */
  authMcpServer(name: string, signal?: AbortSignal): Promise<McpTestResult>;
  /** `GET /api/mcp/catalog` (`:10682-10756`). */
  listMcpCatalog(): Promise<McpCatalogData>;
  /** `POST /api/mcp/catalog/install` (`:10759-10828`). */
  installCatalogEntry(body: {
    name: string;
    env: Record<string, string>;
    enable: boolean;
  }): Promise<{ ok: boolean; name: string; background: boolean; action?: string }>;
  /** `GET /api/actions/{name}/status?lines=N` (`:3728-3763`). */
  actionStatus(name: string, lines?: number): Promise<{ running: boolean; exit_code: number | null; lines: string[] }>;
  /** `POST /api/skills` — validated write path (`:13012-13028`). */
  createSkill(body: { name: string; content: string; category?: string }): Promise<unknown>;
  /** `GET /api/skills/hub/preview?identifier=` (`:12025-12087`). */
  previewHubSkill(identifier: string): Promise<HubPreview>;
  /** `GET /api/skills/hub/scan?identifier=` (`:12090-12169`). */
  scanHubSkill(identifier: string): Promise<HubScan>;
  /** `POST /api/skills/hub/install` body `{identifier}` (`:11762-11794`). */
  installHubSkill(identifier: string): Promise<{ ok: boolean; name: string }>;
  /** `POST /api/skills/hub/uninstall` body `{name}` (`:11802-11818`). */
  uninstallHubSkill(name: string): Promise<{ ok: boolean; name: string }>;
}

/** Structural check: does this client expose the {@link DashboardAdminClient} admin surface? */
export function hasDashboardAdmin(c: unknown): c is DashboardAdminClient {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.addMcpServer === 'function' &&
    typeof o.removeMcpServer === 'function' &&
    typeof o.testMcpServer === 'function' &&
    typeof o.setMcpServerEnabled === 'function' &&
    typeof o.authMcpServer === 'function' &&
    typeof o.listMcpCatalog === 'function' &&
    typeof o.installCatalogEntry === 'function' &&
    typeof o.actionStatus === 'function' &&
    typeof o.createSkill === 'function' &&
    typeof o.previewHubSkill === 'function' &&
    typeof o.scanHubSkill === 'function' &&
    typeof o.installHubSkill === 'function' &&
    typeof o.uninstallHubSkill === 'function'
  );
}

/**
 * `AbortSignal.any` where available (Node >= 20.3); a manual once-listener
 * bridge on older hosts so the repo's `engines.node >= 18` floor stays
 * truthful (critic IMPORTANT-5, §4.3). `anyImpl` is an injectable param so
 * the fallback branch is unit-testable without patching globals.
 */
export function anySignal(
  signals: AbortSignal[],
  anyImpl = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any,
): AbortSignal {
  if (anyImpl) return anyImpl.call(AbortSignal, signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/** The subset of `fetch` this client uses — injectable for the stub-based tests. */
export type FetchLike = typeof globalThis.fetch;

export interface HermesDashboardClientOptions {
  /** Dashboard port (default 9119, `subcommands/dashboard.py:26-28`). */
  port: number;
  /** Bind host; default `127.0.0.1` so the derived `Host` header passes the loopback guard. */
  host?: string;
  /** `X-Hermes-Session-Token`; set only when we spawned + minted it (unneeded on loopback). */
  token?: string;
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-request timeout (ms); default 10s. */
  timeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HermesDashboardClient implements AdoptableDashboardClient, DashboardAdminClient {
  private readonly base: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(opts: HermesDashboardClientOptions) {
    const host = opts.host ?? '127.0.0.1';
    this.base = `http://${host}:${opts.port}`;
    this.token = opts.token;
    // Bind so `this` is preserved when the default global `fetch` is used.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  /** The `http://127.0.0.1:<port>` base this client targets (for logs/diagnostics). */
  get baseUrl(): string {
    return this.base;
  }

  async probe(): Promise<boolean> {
    try {
      const res = await this.raw('GET', '/api/status');
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchServedToken(): Promise<string | null> {
    try {
      const res = await this.raw('GET', '/');
      if (!res.ok) return null;
      return extractInjectedDashboardToken(await res.text());
    } catch {
      // Network error / no served-token marker → null, matching the reference's
      // fetch-error fallback (caller treats a null served token as "ours" when
      // paired with a live child — see isForeignBackendToken).
      return null;
    }
  }

  async probeAdopt(): Promise<boolean> {
    try {
      const res = await this.raw('GET', '/api/status');
      if (!res.ok) return false;
      // Verify the responder is actually Hermes before adopting: a bare 2xx from
      // a squatting loopback listener must NOT earn our toggle PUTs.
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return false; // 2xx but not JSON → not Hermes
      }
      return isHermesStatusShape(body);
    } catch {
      return false;
    }
  }

  listSkills(): Promise<DashboardSkill[]> {
    return this.json<DashboardSkill[]>('GET', '/api/skills');
  }

  toggleSkill(name: string, enabled: boolean): Promise<DashboardToggleResult> {
    return this.json<DashboardToggleResult>('PUT', '/api/skills/toggle', { name, enabled });
  }

  listToolsets(): Promise<DashboardToolset[]> {
    return this.json<DashboardToolset[]>('GET', '/api/tools/toolsets');
  }

  toggleToolset(name: string, enabled: boolean): Promise<DashboardToggleResult> {
    // Path param — encode so a toolset key with URL-special chars can't break out.
    return this.json<DashboardToggleResult>(
      'PUT',
      `/api/tools/toolsets/${encodeURIComponent(name)}`,
      { enabled },
    );
  }

  // --- DashboardAdminClient (T1 MCP admin + catalog; actionStatus shared) ---

  addMcpServer(body: {
    name: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }): Promise<unknown> {
    return this.json('POST', '/api/mcp/servers', body);
  }

  removeMcpServer(name: string): Promise<{ ok: boolean }> {
    return this.json('DELETE', `/api/mcp/servers/${encodeURIComponent(name)}`);
  }

  testMcpServer(name: string): Promise<McpTestResult> {
    // The server blocks for the target server's cold start — give it room.
    return this.json('POST', `/api/mcp/servers/${encodeURIComponent(name)}/test`, undefined, { timeoutMs: 60_000 });
  }

  setMcpServerEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; name: string; enabled: boolean }> {
    return this.json('PUT', `/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { enabled });
  }

  authMcpServer(name: string, signal?: AbortSignal): Promise<McpTestResult> {
    // Server probe window is >= 315s (browser OAuth consent); 340s leaves margin.
    return this.json('POST', `/api/mcp/servers/${encodeURIComponent(name)}/auth`, undefined, {
      timeoutMs: 340_000,
      signal,
    });
  }

  listMcpCatalog(): Promise<McpCatalogData> {
    return this.json('GET', '/api/mcp/catalog');
  }

  installCatalogEntry(body: {
    name: string;
    env: Record<string, string>;
    enable: boolean;
  }): Promise<{ ok: boolean; name: string; background: boolean; action?: string }> {
    return this.json('POST', '/api/mcp/catalog/install', body);
  }

  actionStatus(name: string, lines?: number): Promise<{ running: boolean; exit_code: number | null; lines: string[] }> {
    const query = lines !== undefined ? `?lines=${encodeURIComponent(String(lines))}` : '';
    return this.json('GET', `/api/actions/${encodeURIComponent(name)}/status${query}`);
  }

  createSkill(body: { name: string; content: string; category?: string }): Promise<unknown> {
    return this.json('POST', '/api/skills', body);
  }

  previewHubSkill(identifier: string): Promise<HubPreview> {
    // Query param — encode so an identifier with URL-special chars can't break out.
    return this.json('GET', `/api/skills/hub/preview?identifier=${encodeURIComponent(identifier)}`, undefined, {
      timeoutMs: 30_000,
    });
  }

  scanHubSkill(identifier: string): Promise<HubScan> {
    return this.json('GET', `/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}`, undefined, {
      timeoutMs: 60_000,
    });
  }

  installHubSkill(identifier: string): Promise<{ ok: boolean; name: string }> {
    return this.json('POST', '/api/skills/hub/install', { identifier });
  }

  uninstallHubSkill(name: string): Promise<{ ok: boolean; name: string }> {
    return this.json('POST', '/api/skills/hub/uninstall', { name });
  }

  // --- internals -------------------------------------------------------------

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (hasBody) h['Content-Type'] = 'application/json';
    // `Host` is intentionally NOT set here — undici's fetch forbids overriding
    // it; it is derived from the 127.0.0.1 base URL authority, which already
    // satisfies the loopback Host-guard.
    if (this.token) h['X-Hermes-Session-Token'] = this.token;
    return h;
  }

  private raw(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response> {
    const hasBody = body !== undefined;
    // `AbortSignal.timeout` timers are unref'd, so they never keep the host
    // (or a test's node process) alive.
    const timeoutSignal = AbortSignal.timeout(opts?.timeoutMs ?? this.timeoutMs);
    const signal = opts?.signal ? anySignal([timeoutSignal, opts.signal]) : timeoutSignal;
    return this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: this.headers(hasBody),
      body: hasBody ? JSON.stringify(body) : undefined,
      signal,
    });
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.raw(method, path, body, opts);
    } catch (err) {
      throw new Error(`Hermes dashboard ${method} ${path} failed: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      // Invariant #3 (T6, UI I-5 BETA-BLOCKER + ARCH-2) + OWASP Error
      // Handling Cheat Sheet: "a generic response is returned … but the
      // error details are logged server side for investigation, and not
      // returned to the user." The body may carry config paths, stack
      // traces, or other server-internal detail — it goes to the output
      // channel (this.logger), NEVER into the thrown/surfaced message.
      try {
        const body = (await res.text()).slice(0, 500); // httpFailure-tripwire-allow: logged only, never thrown
        if (body) this.logger?.append(`[dashboard] ${method} ${path} → ${res.status} ${res.statusText}: ${body}`);
      } catch {
        /* body unreadable — status alone is enough */
      }
      throw new Error(httpFailureMessage(`Hermes dashboard ${method} ${path}`, res.status, res.statusText));
    }
    // DASH-3 (Invariant #3): a 2xx response whose body is not valid JSON
    // (a rogue/misconfigured responder, a proxy error page, …) used to let
    // `res.json()`'s raw `SyntaxError` propagate — its message QUOTES a
    // fragment of the actual body (a JSON.parse artifact), one branch away
    // from the exact body-in-error leak the non-2xx path above already
    // guards against. Same posture here: a generic, status-only message to
    // the caller; nothing body-derived even reaches the logger, since the
    // parse error's own message is itself body-tainted.
    try {
      return (await res.json()) as T;
    } catch {
      this.logger?.append(`[dashboard] ${method} ${path} → ${res.status} ${res.statusText}: non-JSON body`);
      throw new Error(`Hermes dashboard ${method} ${path}: invalid JSON response (status ${res.status})`);
    }
  }
}

/**
 * Structural identity check for a Hermes `GET /api/status` body — the gate that
 * lets the manager ADOPT an already-running dashboard vs. refuse a rogue loopback
 * squatter (Security M3, defense-in-depth).
 *
 * We assert on a quartet of fields the Hermes handler ALWAYS populates
 * unconditionally (`hermes_cli/web_server.py:2564-2583`), so a live Hermes always
 * passes while a generic 2xx responder (`{}`, `{"status":"ok"}`, an SPA, some
 * other dev server) does not:
 *   - `version`            non-empty string   (`__version__`,        `:2565`)
 *   - `gateway_running`    boolean            (live PID/health,      `:2570`)
 *   - `gateway_drainable`  boolean            (NAS lifecycle gate,   `:2577`;
 *                          `gateway.status.derive_gateway_drainable` always
 *                          returns `bool(...)` → never null)
 *   - `nous_session_valid` string             (defaults `"unknown"`, `:2582`)
 * These four together (Hermes gateway + Nous-auth vocabulary) are effectively
 * impossible to reproduce by accident, yet are all stable, core fields — not
 * conditional detail that a future refactor is likely to drop.
 */
export function isHermesStatusShape(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const s = body as Record<string, unknown>;
  return (
    typeof s.version === 'string' &&
    s.version.length > 0 &&
    typeof s.gateway_running === 'boolean' &&
    typeof s.gateway_drainable === 'boolean' &&
    typeof s.nous_session_valid === 'string'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
