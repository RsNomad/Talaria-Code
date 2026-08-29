import { settleRace, type RaceOutcome } from '../connection/settleRace';
import type { ConfigWriteTail } from './configWriteTail';
import type { DashboardService } from '../../dashboard/HermesDashboardManager';
import type { DashboardAdminClient, DashboardClientLike } from '../../dashboard/HermesDashboardClient';
import { hasDashboardAdmin } from '../../dashboard/HermesDashboardClient';

/**
 * Task A5 (features-add-mcp-skills-architecture.md §3 Layer 5, §4.5 item 1):
 * the FULL trust-gated method set for T1 (MCP admin) + T2 (skills admin) —
 * checked FIRST, before any network call or modal, for every method in this
 * set. Mirrors `SetupController.MUTATING_METHODS` + its `handle()` check
 * (`SetupController.ts:612-634, :1146-1148`) as a SECOND, independent gate
 * on the control-method surface (defense-in-depth over `trustGate.ts`'s
 * "no ACP backend in an untrusted workspace" gate).
 *
 * Pinned as the FULL 9-method set: A5 routes `mcp.add`/`mcp.remove`/
 * `mcp.setEnabled`/`mcp.test`/`mcp.auth`'s trust+fail-closed-cache guard;
 * A6 routes `mcp.auth`'s body + `mcp.catalogInstall`; the three
 * `skills.*` admin methods are routed by B4/B5 — but the trust-gate SET
 * itself is defined here, once, so no later task can silently add a
 * mutating method without also classifying it here (the
 * `SetupController.test.ts:1675-1712` partition-lock idiom, mirrored in
 * `AcpBackend.test.ts`'s `PINNED_TRUST_GATED_METHODS` lock test).
 * `mcp.catalog` (listing) is deliberately ABSENT — §4.7 pins it read-only,
 * same class as `tools.list`, not trust-gated.
 *
 * WS-GD.2a A5: moved verbatim off `ControlDispatcher.ts` onto this shared
 * admin-op module; re-exported from `ControlDispatcher.ts` so
 * `AcpBackend.test.ts`'s partition-lock import path stays stable.
 */
export const TRUST_GATED_METHODS: ReadonlySet<string> = new Set([
  'mcp.add',
  'mcp.remove',
  'mcp.setEnabled',
  'mcp.test',
  'mcp.auth',
  'mcp.catalogInstall',
  'skills.create',
  'skills.hubInstall',
  'skills.hubUninstall',
]);

/**
 * F2-09: reported when a poll/verify TRANSPORT call rejects — the action was
 * already DISPATCHED server-side; we merely lost visibility (distinct from the
 * ground-truth "did not complete" refusals).
 */
export const POLL_UNCONFIRMED_MESSAGE =
  'The action was dispatched, but its status could not be confirmed — refresh the panel to check whether it completed.';

/** CA-M05: the raw `actionStatus` envelope shape. */
export type ActionStatus = { running: boolean; exit_code: number | null; lines: string[] };
/** CA-M05: either the fetched status, or a wall-clock timeout that the caller maps to its own "did not complete" refusal. */
export type PolledOutcome = { status: ActionStatus } | { timedOut: true };

/**
 * Task A6 (§4.7 item 2), widened by Task B4: the shared background-poll
 * cadence — the FIRST wait is 1s, every wait after that is 2s — reused by
 * BOTH `pollCatalogInstall` (cap `CATALOG_POLL_CAP_MS`, 180s: clone + build
 * headroom) and `pollSkillInstall` (cap `SKILLS_INSTALL_POLL_CAP_MS`, 120s
 * per §5.4 — NOT the catalog's 180s; skill installs never clone/build, they
 * only copy files). WS-GD.2a A5: the two poll-cap consts themselves stay
 * domain-side (passed in as `capMs`) — only the shared cadence moved here.
 */
export const BACKGROUND_POLL_FIRST_DELAY_MS = 1_000;
export const BACKGROUND_POLL_STEP_DELAY_MS = 2_000;

/**
 * AH5/F3/WS-GD.2a A5: the single-flight acquire-then-tail-or-direct-then-
 * release choreography shared by `handleMcpAdmin`/`handleSkillsAdmin` — see
 * each call site's own doc for why `acquire` MUST run synchronously, before
 * this ever joins the tail (a duplicate call gated INSIDE the queued handler
 * would simply queue silently behind the in-flight one instead of refusing
 * immediately).
 */
export function runAdminOp<T>(opts: {
  /** Synchronous test-and-set; throws the pinned busy refusal; undefined = no lock to hold. */
  acquire: () => (() => void) | undefined;
  tailExempt: boolean;
  tail: ConfigWriteTail;
  run: () => Promise<T>;
}): Promise<T> {
  const release = opts.acquire(); // throws the pinned busy refusal synchronously (F3/IMPORTANT-3 posture)
  const result = opts.tailExempt ? opts.run() : opts.tail.join(opts.run);
  if (release) {
    // Release regardless of outcome — decline, validation refusal, or failure
    // must free the name exactly like success (moved rationale, verbatim).
    result.then(release, release);
  }
  return result;
}

/**
 * Task A5+A6 (§4.5 item 2), widened by Task B4: `dashboard.ensure()` then the
 * `hasDashboardAdmin` structural narrowing (the `hasToggleNameCache`
 * idiom) — a dashboard client without the full T1+T2 admin surface (or no
 * dashboard at all) fails closed rather than silently no-op-ing. The
 * return type is intersected with `DashboardClientLike` (NOT re-declared
 * on `DashboardAdminClient` itself — `HermesDashboardClient.ts` is
 * B2-owned, untouched here): `client` above is typed `DashboardClientLike`
 * BEFORE the `hasDashboardAdmin` guard, so TypeScript's own type-predicate
 * narrowing already widens it to `DashboardClientLike & DashboardAdminClient`
 * inside this function — this signature just carries that same width to
 * every caller, so Task B4's `skills.hubInstall` ground-truth `listSkills()`
 * re-check (a `DashboardClientLike` member) is reachable off the SAME
 * resolved client the T1 MCP methods use.
 */
export async function resolveDashboardAdminClient(
  getDashboard: () => DashboardService | undefined,
  method: string,
): Promise<DashboardAdminClient & DashboardClientLike> {
  const dashboard = getDashboard();
  if (!dashboard) {
    throw new Error(`Refusing '${method}': the Hermes dashboard channel is not configured.`);
  }
  const client = await dashboard.ensure();
  if (!hasDashboardAdmin(client)) {
    throw new Error(`Refusing '${method}': the dashboard client does not support admin actions.`);
  }
  return client;
}

/**
 * CA-M05: run ONE `actionStatus` bounded by the poll deadline. A long-hanging
 * call can otherwise blow past the deadline undetected (the loop's between-
 * calls check is only reached AFTER the await returns). A settle-once race:
 * a wall-clock timeout resolves `{ timedOut: true }`; a real status resolves
 * `{ status }`; a TRANSPORT rejection passes through as a rejection. The
 * timer is `unref()`d and cleared on the fast path.
 *
 * WS-GD.2a A5: now built on WS-R1's `settleRace` primitive (see
 * `connection/settleRace.ts`) rather than a hand-rolled race — same
 * settle-once / unref / clear-on-fast-path contract, ported onto its
 * `{ kind: 'value' | 'exit' | 'deadline' }` outcome shape (no `exit` source
 * is raced here, so that arm is unreachable).
 */
export async function actionStatusWithinDeadline(
  client: Pick<DashboardAdminClient, 'actionStatus'>,
  action: string,
  deadline: number,
): Promise<PolledOutcome> {
  const remaining = Math.max(0, deadline - Date.now());
  let outcome: RaceOutcome<ActionStatus>;
  try {
    outcome = await settleRace<ActionStatus>(client.actionStatus(action), { deadline: remaining });
  } catch (err) {
    // Preserve the original wrapper's contract: a transport rejection passes
    // through, non-Errors wrapped (CA-M05, moved).
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (outcome.kind === 'deadline') return { timedOut: true };
  if (outcome.kind === 'value') return { status: outcome.value };
  // 'exit' is unreachable — no exit source is raced here.
  throw new Error('unreachable: actionStatusWithinDeadline raced no exit source');
}

/**
 * The generic poll loop shared by catalog-install / skill-install / skill-
 * uninstall — lifted verbatim from `pollCatalogInstall` (which
 * `pollSkillInstall`/`pollSkillUninstall` mirrored line-for-line). Resolves
 * once `running:false` AND `verify()` returns true. `rejectUnverified`/
 * `throwUnconfirmed` are `never`-returning so the pinned domain messages stay
 * with the callers.
 */
export async function pollActionUntilVerified(opts: {
  client: Pick<DashboardAdminClient, 'actionStatus'>;
  action: string;
  capMs: number;
  verify: () => Promise<boolean>;
  rejectUnverified: (tailLines: string[]) => never;
  throwUnconfirmed: (err: unknown) => never;
}): Promise<void> {
  const deadline = Date.now() + opts.capMs;
  let delay = BACKGROUND_POLL_FIRST_DELAY_MS;
  let lastLines: string[] = [];
  for (;;) {
    let polled: PolledOutcome;
    try {
      polled = await actionStatusWithinDeadline(opts.client, opts.action, deadline);
    } catch (err) {
      opts.throwUnconfirmed(err);
    }
    if ('timedOut' in polled) {
      opts.rejectUnverified(lastLines);
    }
    const status = polled.status;
    lastLines = status.lines;
    if (!status.running) break;
    if (Date.now() >= deadline) {
      opts.rejectUnverified(lastLines); // cheap fast-path exit; redundant with the bound but harmless (moved comment)
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = BACKGROUND_POLL_STEP_DELAY_MS;
  }
  let ok: boolean;
  try {
    ok = await opts.verify();
  } catch (err) {
    opts.throwUnconfirmed(err);
  }
  if (!ok) {
    opts.rejectUnverified(lastLines);
  }
}

/** Task A6: a plain `setTimeout` wait — `pollActionUntilVerified`'s backoff step. Real timers in production; `vi.useFakeTimers()` in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
