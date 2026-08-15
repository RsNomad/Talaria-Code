import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * T-B2 (V-9 dashboard liveness fail-open): the two tests at the bottom of this
 * file drive the REAL `spawnServe`/real `node:child_process.spawn` — every
 * OTHER test in this file injects a fake `deps.spawn` and never touches this
 * mock. Mirrors the proven harness in `acpClient.test.ts`/`acpClient.wire.test.ts`
 * (mock the module, not the object graph, to actually exercise the production
 * 'error'/'exit' wiring instead of a reimplementation of it).
 */
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { HermesDashboardManager, type DashboardChild } from './HermesDashboardManager';
import type { AdoptableDashboardClient, DashboardToggleResult } from './HermesDashboardClient';
import { must } from '../../testing/must';

/**
 * The discover-or-spawn DECISION + probe/backoff/error paths (W1.5), with all OS
 * seams injected (BUILD-BLIND: no real `serve` spawn, no real sleep). We prove:
 * adopt (legacy `adopt:'shape'` opt-in) when a dashboard already answers; spawn
 * otherwise; reject (retryable, memo cleared) when the spawned server never
 * becomes healthy; and that `ensure` is memoized across concurrent callers.
 *
 * S3 (CWE-306/346): `talaria.dashboardAdopt` DEFAULTS to `'spawn-only'`, which
 * NEVER calls `probeAdopt` — it always spawns its own child, then verifies the
 * healthy server's served session token has the provenance of OUR spawn
 * (`isForeignBackendToken`, mirrored from Hermes desktop's
 * `dashboard-token.cjs`) before handing the client back. `adopt:'shape'` is the
 * legacy, INSECURE opt-in (shape-only adoption) — every test below that exercises
 * it passes `adopt:'shape'` EXPLICITLY, surfacing that the secure default flipped.
 */

interface FakeClientSpec {
  /** `probe()`/`probeAdopt()` share a cursor (as before): scripted sequence. */
  probeSeq?: boolean[];
  /** `fetchServedToken()` resolved value (default `null` — undetermined, never foreign). */
  servedToken?: string | null;
}

/** A fake client that also counts `probeAdopt()` invocations for the security assertion. */
interface FakeClientHandle extends AdoptableDashboardClient {
  readonly probeAdoptCallCount: number;
}

function fakeClient(spec: FakeClientSpec = {}): FakeClientHandle {
  const probeSeq = spec.probeSeq ?? [false];
  let i = 0;
  let probeAdoptCallCount = 0;
  const nextProbe = () => probeSeq[Math.min(i++, probeSeq.length - 1)] ?? false;
  const toggle = async (name: string, enabled: boolean): Promise<DashboardToggleResult> => ({
    ok: true,
    name,
    enabled,
  });
  return {
    get probeAdoptCallCount() {
      return probeAdoptCallCount;
    },
    probe: async () => nextProbe(),
    probeAdopt: async () => {
      probeAdoptCallCount++;
      return nextProbe();
    },
    fetchServedToken: async () => spec.servedToken ?? null,
    listSkills: async () => [],
    listToolsets: async () => [],
    toggleSkill: toggle,
    toggleToolset: toggle,
  };
}

/** A fake spawned-child handle with a settable liveness result. */
function fakeChild(alive = true): DashboardChild & { killed: boolean } {
  return {
    killed: false,
    kill() {
      this.killed = true;
    },
    alive: () => alive,
  };
}

interface Harness {
  manager: HermesDashboardManager;
  spawnCalls: string[];
  child: DashboardChild & { killed: boolean };
  clients: FakeClientHandle[];
}

/**
 * Build a `'shape'`-mode manager (the legacy adopt-first opt-in): the adopt
 * client and (if spawned) spawned client each get a scripted probe sequence.
 * `makeClient` hands out the adopt client first, then the spawned client.
 * `adopt` must be passed explicitly — this harness is for the OPT-IN legacy
 * path, not the secure default.
 */
function makeManager(opts: {
  adopt: 'spawn-only' | 'shape';
  adoptProbe: boolean[];
  spawnedProbe?: boolean[];
}): Harness {
  const clients: FakeClientHandle[] = [
    fakeClient({ probeSeq: opts.adoptProbe }),
    fakeClient({ probeSeq: opts.spawnedProbe ?? [false] }),
  ];
  let handed = 0;
  const spawnCalls: string[] = [];
  const child = fakeChild(true);

  const manager = new HermesDashboardManager({
    config: {},
    port: 9119,
    probeBackoffMs: [1, 1, 1], // 3 quick health-probe attempts
    adopt: opts.adopt,
    deps: {
      makeClient: () => must(clients[Math.min(handed++, clients.length - 1)]),
      spawn: async (token) => {
        spawnCalls.push(token);
        return child;
      },
      sleep: async () => {},
      mintToken: () => 'minted-token',
    },
  });

  return { manager, spawnCalls, child, clients };
}

describe('HermesDashboardManager.ensure — adopt:"shape" (legacy, insecure opt-in)', () => {
  it('ADOPTS a running dashboard (probe 200) without spawning', async () => {
    const h = makeManager({ adopt: 'shape', adoptProbe: [true] });
    const client = await h.manager.ensure();

    expect(h.spawnCalls).toEqual([]); // never spawned
    expect(client).toBe(h.clients[0]); // the adopt client
  });

  it('REFUSES to adopt a responder that is not Hermes-shaped (probeAdopt false) and spawns instead (Security M3)', async () => {
    // A rogue loopback listener answers /api/status but does NOT verify as Hermes,
    // so probeAdopt() is false: we must NOT hand it our toggle PUTs — fall through
    // to spawn our own token-authed dashboard.
    const h = makeManager({ adopt: 'shape', adoptProbe: [false], spawnedProbe: [true] });
    const client = await h.manager.ensure();

    expect(h.spawnCalls).toEqual(['minted-token']); // did not adopt; spawned instead
    expect(client).toBe(h.clients[1]); // the spawned client, never the unverified adopt one
  });

  it('SPAWNS when nothing is running, then returns the spawned (token-authed) client once healthy', async () => {
    // adopt probe false -> spawn -> health probe becomes true on the 2nd attempt.
    const h = makeManager({ adopt: 'shape', adoptProbe: [false], spawnedProbe: [false, true] });
    const client = await h.manager.ensure();

    expect(h.spawnCalls).toEqual(['minted-token']); // spawned once, with the minted token
    expect(client).toBe(h.clients[1]); // the spawned client
  });

  it('REJECTS (retryable) and clears the memo when the spawned dashboard never becomes healthy', async () => {
    const h = makeManager({ adopt: 'shape', adoptProbe: [false], spawnedProbe: [false] }); // never healthy

    await expect(h.manager.ensure()).rejects.toThrow(/did not become reachable/);

    // Memo cleared: a second ensure() RE-ATTEMPTS (adopt again, spawn again),
    // rather than caching the failure forever — this is what powers panel Retry.
    await expect(h.manager.ensure()).rejects.toThrow(/did not become reachable/);
    expect(h.spawnCalls.length).toBe(2);
  });

  it('memoizes concurrent callers to a single bring-up (adopt once, not per-call)', async () => {
    const h = makeManager({ adopt: 'shape', adoptProbe: [true] });
    const [a, b] = await Promise.all([h.manager.ensure(), h.manager.ensure()]);
    expect(a).toBe(b);
    expect(a).toBe(h.clients[0]);
  });
});

describe('HermesDashboardManager.dispose (adopt:"shape")', () => {
  it('kills a spawned child on dispose', async () => {
    const h = makeManager({ adopt: 'shape', adoptProbe: [false], spawnedProbe: [true] });
    await h.manager.ensure();
    h.manager.dispose();
    expect(h.child.killed).toBe(true);
  });

  it('does NOT spawn/kill anything when the dashboard was adopted (left running)', async () => {
    const h = makeManager({ adopt: 'shape', adoptProbe: [true] });
    await h.manager.ensure();
    h.manager.dispose();
    expect(h.child.killed).toBe(false);
    expect(h.spawnCalls).toEqual([]);
  });

  it('ensure() after dispose rejects', async () => {
    const h = makeManager({ adopt: 'shape', adoptProbe: [true] });
    h.manager.dispose();
    await expect(h.manager.ensure()).rejects.toThrow(/disposed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — spawn-only default + served-token provenance verification (CWE-306/346)
// ─────────────────────────────────────────────────────────────────────────────

const MINTED_TOKEN = 'minted-token';

interface SpawnOnlyHarness {
  manager: HermesDashboardManager;
  spawnCalls: string[];
  makeClientCalls: (string | undefined)[];
  child: DashboardChild & { killed: boolean };
  /** The client `makeClient(MINTED_TOKEN)` returns — our own freshly-spawned client. */
  spawnedClient: FakeClientHandle;
  /** The client `makeClient(<served/drifted token>)` returns, for the benign-drift re-make. */
  driftClient: FakeClientHandle;
  /**
   * The client `makeClient(undefined)` WOULD return, were the manager ever to ask
   * to adopt. Its `probeAdopt` is scripted to say "yes, Hermes-shaped" — so if
   * spawn-only genuinely never consults it, `probeAdoptCallCount` stays 0.
   */
  wouldBeAdoptClient: FakeClientHandle;
}

function makeSpawnOnlyManager(opts: {
  /** Omit to exercise the manager's actual default (no `adopt` option passed). */
  adopt?: 'spawn-only' | 'shape';
  /** `spawnedClient.probe()` sequence for the post-spawn health check. */
  healthyProbe?: boolean[];
  /** `spawnedClient.fetchServedToken()` resolved value. */
  servedToken?: string | null;
  /** `child.alive()` at provenance-check time. */
  childAlive?: boolean;
}): SpawnOnlyHarness {
  const spawnCalls: string[] = [];
  const makeClientCalls: (string | undefined)[] = [];
  const child = fakeChild(opts.childAlive ?? true);

  const spawnedClient = fakeClient({
    probeSeq: opts.healthyProbe ?? [true],
    servedToken: opts.servedToken ?? null,
  });
  const driftClient = fakeClient({ probeSeq: [true] });
  const wouldBeAdoptClient = fakeClient({ probeSeq: [true] }); // scripted "yes" if ever asked

  const managerOptions: ConstructorParameters<typeof HermesDashboardManager>[0] = {
    config: {},
    port: 9119,
    probeBackoffMs: [1, 1, 1],
    deps: {
      makeClient: (token) => {
        makeClientCalls.push(token);
        if (token === undefined) return wouldBeAdoptClient;
        if (token === MINTED_TOKEN) return spawnedClient;
        return driftClient;
      },
      spawn: async (token) => {
        spawnCalls.push(token);
        return child;
      },
      sleep: async () => {},
      mintToken: () => MINTED_TOKEN,
    },
  };
  if (opts.adopt !== undefined) managerOptions.adopt = opts.adopt;

  const manager = new HermesDashboardManager(managerOptions);

  return { manager, spawnCalls, makeClientCalls, child, spawnedClient, driftClient, wouldBeAdoptClient };
}

describe('HermesDashboardManager.ensure — spawn-only default (S3, CWE-306/346)', () => {
  it('NEVER consults probeAdopt, even when a shape-verified peer would answer — always spawns', async () => {
    // No `adopt` option passed at all: proves the manager's ACTUAL default,
    // not a test-harness default.
    const h = makeSpawnOnlyManager({ healthyProbe: [true], servedToken: null });
    const client = await h.manager.ensure();

    expect(h.wouldBeAdoptClient.probeAdoptCallCount).toBe(0); // security assertion: never consulted
    expect(h.makeClientCalls).not.toContain(undefined); // never even built an adopt-mode client
    expect(h.spawnCalls).toEqual([MINTED_TOKEN]); // spawned instead of adopting
    expect(client).toBe(h.spawnedClient);
  });

  it('served token === spawn token → accepted as ours, returns the spawned client directly', async () => {
    const h = makeSpawnOnlyManager({ healthyProbe: [true], servedToken: MINTED_TOKEN });
    const client = await h.manager.ensure();

    expect(client).toBe(h.spawnedClient);
    expect(h.makeClientCalls).toEqual([MINTED_TOKEN]); // no re-make needed
  });

  it('served token !== spawn token AND child ALIVE → benign regeneration; re-makes the client with the served token', async () => {
    const h = makeSpawnOnlyManager({
      healthyProbe: [true],
      servedToken: 'regenerated-token',
      childAlive: true,
    });
    const client = await h.manager.ensure();

    expect(client).toBe(h.driftClient); // re-made client, using the served token
    expect(h.makeClientCalls).toEqual([MINTED_TOKEN, 'regenerated-token']);
  });

  it('served token !== spawn token AND child DEAD → FOREIGN: refuses (throws), naming the recovery escapes (F9/TG-6/AU-OBS-L3)', async () => {
    const h = makeSpawnOnlyManager({
      healthyProbe: [true],
      servedToken: 'squatter-token',
      childAlive: false,
    });

    // F9: the refusal must name BOTH config escapes so the user isn't left
    // guessing — talaria.dashboardPort (move off the squatted port) and,
    // security-second (it's the riskier option), talaria.dashboardAdopt.
    let caught: unknown;
    try {
      await h.manager.ensure();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/we did not spawn/i);
    expect(message).toContain('talaria.dashboardPort');
    expect(message).toContain('talaria.dashboardAdopt');

    // Memo cleared: a second ensure() re-attempts (spawns again) rather than
    // caching the refusal forever — this is what powers panel Retry.
    await expect(h.manager.ensure()).rejects.toThrow(/we did not spawn/i);
    expect(h.spawnCalls.length).toBe(2);
  });

  it('a null served token with our child ALIVE is accepted (our own headless serve emits no marker — null is the normal value)', async () => {
    const h = makeSpawnOnlyManager({ healthyProbe: [true], servedToken: null, childAlive: true });
    await expect(h.manager.ensure()).resolves.toBe(h.spawnedClient);
  });

  it('a null served token with our child DEAD is FOREIGN: refuses (a squatter answered the probe while our child failed to bind)', async () => {
    // CWE-306/346 fail-open closed: a squatter that answers /api/status but serves
    // NO token marker, while our spawned child died on the port conflict, must NOT
    // be adopted. (Confirmed by Opus security review — headless serve makes null the
    // norm, so provenance rests on liveness.)
    const h = makeSpawnOnlyManager({ healthyProbe: [true], servedToken: null, childAlive: false });
    await expect(h.manager.ensure()).rejects.toThrow(/we did not spawn/i);
    // Memo cleared → retryable, same as the mismatched-token foreign case.
    await expect(h.manager.ensure()).rejects.toThrow(/we did not spawn/i);
    expect(h.spawnCalls.length).toBe(2);
  });

  it('explicit adopt:"spawn-only" behaves identically to the default (still never consults probeAdopt)', async () => {
    const h = makeSpawnOnlyManager({ adopt: 'spawn-only', healthyProbe: [true], servedToken: null });
    await h.manager.ensure();
    expect(h.wouldBeAdoptClient.probeAdoptCallCount).toBe(0);
  });
});

describe('HermesDashboardManager.ensure — P4a: no spawned-child leak on a post-spawn failure', () => {
  it('kills the spawned child and clears it when the post-spawn health probe never succeeds; a later ensure() re-spawns cleanly (no leak)', async () => {
    // An empty `healthyProbe` sequence -> `client.probe()` always resolves
    // false -> `waitHealthy` exhausts its backoff and throws. Before the fix,
    // `this.child` (already assigned) was never killed on this path — the
    // next `ensure()` would spawn ANOTHER child on top of the still-running
    // leaked one.
    const h = makeSpawnOnlyManager({ healthyProbe: [] });

    await expect(h.manager.ensure()).rejects.toThrow(/did not become reachable/);
    expect(h.child.killed).toBe(true);

    // second ensure() re-attempts (spawns again) rather than leaking the dead
    // child forever — this is what powers panel Retry, and it must not stack
    // up orphaned children each time.
    await expect(h.manager.ensure()).rejects.toThrow(/did not become reachable/);
    expect(h.spawnCalls.length).toBe(2);
  });

  it('kills a child spawned AFTER dispose() already ran (spawn() was still in flight when dispose() was called)', async () => {
    // dispose() only kills `this.child` if it is ALREADY assigned at the time
    // dispose() runs. If `spawn()` is still pending, dispose() sees no child
    // to kill; the child then gets assigned to `this.child` moments later,
    // orphaned, unless bringUp() itself checks `this.disposed` right after
    // the assignment.
    let resolveSpawn!: (child: ReturnType<typeof fakeChild>) => void;
    const spawnPromise = new Promise<ReturnType<typeof fakeChild>>((resolve) => {
      resolveSpawn = resolve;
    });
    const child = fakeChild(true);

    const manager = new HermesDashboardManager({
      config: {},
      port: 9119,
      probeBackoffMs: [1, 1, 1],
      deps: {
        makeClient: () => fakeClient({ probeSeq: [true] }),
        spawn: async () => spawnPromise,
        sleep: async () => {},
        mintToken: () => 'minted-token',
      },
    });

    const ensurePromise = manager.ensure();
    manager.dispose(); // disposed WHILE spawn() is still pending — no child to kill yet
    resolveSpawn(child); // spawn() now resolves — the child must still be killed

    await expect(ensurePromise).rejects.toThrow(/disposed/);
    expect(child.killed).toBe(true);
  });

  it('M3: isolates the explicit post-spawn `if (this.disposed)` check — an EMPTY probeBackoffMs means waitHealthy can never be the one that throws', async () => {
    // With `probeBackoffMs: []`, `waitHealthy`'s for-loop body (which holds
    // its OWN disposed check) never runs even once — it falls straight
    // through to its unconditional "did not become reachable" throw,
    // regardless of `this.disposed`. So if THIS test's `/disposed/` assertion
    // passes, the explicit post-spawn check (bringUp(), right after
    // `this.child = await this.deps.spawn(token)`) — and nothing else — must
    // be what caught it and killed the child.
    let resolveSpawn!: (child: ReturnType<typeof fakeChild>) => void;
    const spawnPromise = new Promise<ReturnType<typeof fakeChild>>((resolve) => {
      resolveSpawn = resolve;
    });
    const child = fakeChild(true);

    const manager = new HermesDashboardManager({
      config: {},
      port: 9119,
      probeBackoffMs: [],
      deps: {
        makeClient: () => fakeClient({ probeSeq: [true] }),
        spawn: async () => spawnPromise,
        sleep: async () => {},
        mintToken: () => 'minted-token',
      },
    });

    const ensurePromise = manager.ensure();
    manager.dispose(); // disposed WHILE spawn() is still pending — no child to kill yet
    resolveSpawn(child); // spawn() now resolves — the child must still be killed

    await expect(ensurePromise).rejects.toThrow(/disposed/);
    expect(child.killed).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // DASH-2 (Tier-2 remediation architecture §12.1, task T-13): `dispose()`
  // racing the S3 provenance fetch — `this.child.alive()` TypeErrors instead
  // of the clean "disposed" rejection every other race in this file gets.
  // ───────────────────────────────────────────────────────────────────────

  it('DASH-2: dispose() firing WHILE fetchServedToken() is in flight rejects cleanly as "disposed" — not a TypeError from a nulled this.child', async () => {
    // `dispose()` nulls `this.child` (after killing it) the instant it runs.
    // Firing it from INSIDE the fake's `fetchServedToken()` reproduces the
    // exact interleaving DASH-2 names: `this.child` is spawned and assigned,
    // health-probed, and only THEN does dispose() land mid-await, racing the
    // provenance fetch that reads `this.child.alive()` right after it.
    let manager!: HermesDashboardManager;
    const child = fakeChild(true);
    const spawnedClient: FakeClientHandle = {
      ...fakeClient({ probeSeq: [true] }),
      fetchServedToken: async () => {
        manager.dispose();
        return 'some-served-token'; // differs from the minted token — would hit isForeignBackendToken pre-fix
      },
    };

    manager = new HermesDashboardManager({
      config: {},
      port: 9119,
      probeBackoffMs: [1],
      deps: {
        makeClient: () => spawnedClient,
        spawn: async () => child,
        sleep: async () => {},
        mintToken: () => 'minted-token',
      },
    });

    let caught: unknown;
    try {
      await manager.ensure();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    // Pre-fix: `this.child` is already `undefined` (dispose() nulled it)
    // by the time `this.child.alive()` runs after the awaited fetch
    // resolves -> a bare TypeError ("Cannot read properties of undefined"),
    // not the clean disposed message every other race in this suite gets.
    expect((caught as Error).message).toMatch(/disposed/i);
    expect((caught as Error).constructor.name).not.toBe('TypeError');
    expect(child.killed).toBe(true); // dispose() already killed it
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CF-15 (L6 I-9): ensure() must invalidate its success memo after a
// POST-READY child death — otherwise the Skills/Tools panel's "Retry" hands
// back the dead client forever, with no recovery short of a window reload.
// ─────────────────────────────────────────────────────────────────────────────

describe('HermesDashboardManager.ensure — CF-15: re-checks child liveness before trusting the memo', () => {
  it('a child that dies AFTER a successful bring-up forces the next ensure() to re-bring-up a fresh client, not return the dead one', async () => {
    // A mutable-liveness fake (unlike `fakeChild`'s fixed boolean) so we can
    // simulate the child dying AFTER `ensure()` already resolved successfully.
    let firstChildAlive = true;
    const firstChild: DashboardChild & { killed: boolean } = {
      killed: false,
      kill() {
        this.killed = true;
      },
      alive: () => firstChildAlive,
    };
    const secondChild = fakeChild(true);

    const firstClient = fakeClient({ probeSeq: [true] });
    const secondClient = fakeClient({ probeSeq: [true] });

    const spawnCalls: string[] = [];
    let makeClientCallCount = 0;

    const manager = new HermesDashboardManager({
      config: {},
      port: 9119,
      probeBackoffMs: [1],
      deps: {
        makeClient: () => {
          makeClientCallCount++;
          return makeClientCallCount === 1 ? firstClient : secondClient;
        },
        spawn: async (token) => {
          spawnCalls.push(token);
          return spawnCalls.length === 1 ? firstChild : secondChild;
        },
        sleep: async () => {},
        mintToken: () => 'minted-token',
      },
    });

    const first = await manager.ensure();
    expect(first).toBe(firstClient);
    expect(spawnCalls.length).toBe(1);

    // The spawned backend crashes AFTER the successful bring-up. `ensure()` is
    // memoized on success — without the fix, the next call just returns the
    // cached (dead) `firstClient` forever; the Retry button is a no-op.
    firstChildAlive = false;

    const second = await manager.ensure();

    expect(spawnCalls.length).toBe(2); // re-brought-up a fresh child, not reused the dead memo
    expect(second).toBe(secondClient); // a FRESH client...
    expect(second).not.toBe(first); // ...never the dead one
    expect(firstChild.killed).toBe(true); // the dead child is torn down, not just abandoned
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CF-15 REVIEW: the dead-child guard (~154-162) can force a SECOND concurrent
// bringUp() while an EARLIER bringUp() is still pending. When the stale first
// attempt later settles (fails), its catch handlers must NOT unconditionally
// stomp `this.ready`/`this.child` if a newer, healthy bring-up has since
// become the current memo — that clobber leaks the healthy child (invisible
// to dispose()) and forces a redundant extra bring-up.
// ─────────────────────────────────────────────────────────────────────────────

describe('HermesDashboardManager.ensure — CF-15 review: identity-guards a stale concurrent attempt', () => {
  it('a stale FIRST bring-up that fails AFTER a concurrent SECOND bring-up already succeeded must not clobber the healthy this.ready/this.child (reviewer-reproduced overlap)', async () => {
    // child1: starts alive, then "dies" while attempt1 is still stuck probing.
    let child1Alive = true;
    const child1: DashboardChild & { killed: boolean } = {
      killed: false,
      kill() {
        this.killed = true;
      },
      alive: () => child1Alive,
    };
    const child2 = fakeChild(true);

    // client1's probe() is gated: it stays pending until the test explicitly
    // resolves it, so attempt1 (bringUp() #1) can be parked mid-flight AFTER
    // it has already assigned `this.child = child1` (pre-health-probe), which
    // is exactly the window the reviewer's finding names.
    let resolveProbe1Called!: () => void;
    const probe1CalledPromise = new Promise<void>((resolve) => {
      resolveProbe1Called = resolve;
    });
    let resolveFirstProbeGate!: (v: boolean) => void;
    const firstProbeGate = new Promise<boolean>((resolve) => {
      resolveFirstProbeGate = resolve;
    });
    const client1: FakeClientHandle = {
      get probeAdoptCallCount() {
        return 0;
      },
      probe: async () => {
        resolveProbe1Called();
        return firstProbeGate;
      },
      probeAdopt: async () => false,
      fetchServedToken: async () => null,
      listSkills: async () => [],
      listToolsets: async () => [],
      toggleSkill: async (name, enabled) => ({ ok: true, name, enabled }),
      toggleToolset: async (name, enabled) => ({ ok: true, name, enabled }),
    };
    const client2 = fakeClient({ probeSeq: [true] });

    const spawnCalls: string[] = [];
    let spawnCallCount = 0;
    let makeClientCallCount = 0;

    const manager = new HermesDashboardManager({
      config: {},
      port: 9119,
      probeBackoffMs: [1], // ONE attempt: client1's gated `false` exhausts it immediately
      deps: {
        makeClient: () => {
          makeClientCallCount++;
          if (makeClientCallCount === 1) return client1;
          if (makeClientCallCount === 2) return client2;
          // A distinct 3rd client — if a redundant 3rd bring-up happens
          // (pre-fix), it must be THIS, never client1/client2, so the
          // assertions below can tell the two apart unambiguously.
          return fakeClient({ probeSeq: [true] });
        },
        spawn: async (token) => {
          spawnCallCount++;
          spawnCalls.push(token);
          if (spawnCallCount === 1) return child1;
          if (spawnCallCount === 2) return child2;
          // A distinct 3rd child, likewise never child1/child2.
          return fakeChild(true);
        },
        sleep: async () => {},
        mintToken: () => `token-${spawnCallCount + 1}`,
      },
    });

    // Attempt 1: this.child gets assigned child1, then parks inside
    // waitHealthy() awaiting the gated probe.
    const firstEnsure = manager.ensure();
    await probe1CalledPromise;

    // child1 dies while attempt1 is still pending.
    child1Alive = false;

    // Attempt 2 (concurrent): the CF-15 dead-child guard fires (this.child
    // === child1, dead) -> clears this.child/this.ready -> starts a fresh,
    // independent bring-up that spawns + health-probes child2 successfully.
    const secondEnsure = manager.ensure();
    const client2Result = await secondEnsure;
    expect(client2Result).toBe(client2);
    expect(spawnCalls.length).toBe(2); // spawned twice so far (child1, child2) — expected, not the bug

    // Now let the STALE attempt1 settle (fail): its gated probe resolves
    // false, exhausting the single-entry backoff -> waitHealthy() throws.
    resolveFirstProbeGate(false);
    await expect(firstEnsure).rejects.toThrow(/did not become reachable/);

    // The healthy child2 must NOT have been killed by attempt1's stale catch.
    expect(child2.killed).toBe(false);

    // A subsequent ensure() must return the SAME memoized healthy client —
    // NOT trigger a 3rd redundant bring-up (this.ready must still be
    // attempt2's resolved promise, not clobbered back to undefined).
    const third = await manager.ensure();
    expect(third).toBe(client2Result);
    expect(spawnCalls.length).toBe(2); // still 2 — no redundant 3rd spawn

    // dispose() must still be able to see/kill child2 (this.child must still
    // point at it — not orphaned/leaked by attempt1's stale unconditional clear).
    manager.dispose();
    expect(child2.killed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T-B2 — dashboard liveness fail-open (closes V-9)
// ─────────────────────────────────────────────────────────────────────────────
//
// Root cause: `spawnServe` used to mark the child dead ONLY on 'exit'. Per Node
// `child_process` docs, a spawn FAILURE (ENOENT/EACCES/...) emits 'error' and
// MAY NEVER emit 'exit' — so a child that failed to spawn stayed
// `alive() === true` forever, and `isForeignBackendToken` (whose whole contract
// is "token differs while our child is DEAD => foreign => refuse") never saw
// the dead state: a squatter already on the port got adopted and received our
// authenticated PUTs. The one fail-OPEN in a named CWE-306/346 control.
//
// Both tests below exercise the REAL `spawnServe` against the REAL
// `node:child_process.spawn` mock (not the injected `deps.spawn` fake every
// other test in this file uses) so a regression in the production
// 'error'/'exit' wiring is actually caught, not just a reimplementation of it.

/** A fake `ChildProcess`: a plain EventEmitter with a spy `kill()`. */
function fakeChildProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { kill: vi.fn() });
}

describe('HermesDashboardManager — T-B2: dashboard liveness fail-open (V-9, real spawnServe)', () => {
  it("UNIT: a spawned child that ONLY emits 'error' (spawn failure, never 'exit') is dead — alive() === false", async () => {
    const proc = fakeChildProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);

    // `hermesPath` set -> resolveHermesBin short-circuits the login-shell PATH
    // lookup (no real OS access); `pythonPath` also pinned so the AU-7
    // realpath+existence-check derivation (which would fail against this
    // fake path on the real FS) never runs either — the REAL spawnServe runs
    // end to end regardless.
    const manager = new HermesDashboardManager({
      config: { hermesPath: '/fake/hermes', pythonPath: '/fake/python' },
      port: 9119,
    });
    // Reach past `private` to unit-test spawnServe's own contract in isolation
    // from the health-probe/provenance pipeline (covered by the INTEGRATION
    // test below) — same `as unknown as { ... }` seam AcpBackend.test.ts uses
    // throughout for private methods.
    const spawnServe = (
      manager as unknown as { spawnServe(token: string): Promise<DashboardChild> }
    ).spawnServe.bind(manager);

    const child = await spawnServe('minted-token');
    // spawnServe registers .on('error')/.on('exit') synchronously, strictly
    // before it returns the child handle awaited above — safe to fire now.
    proc.emit('error', new Error('spawn hermes ENOENT'));

    expect(child.alive()).toBe(false);
  });

  it('INTEGRATION: an errored (never-exited) child + a served token we did not mint is refused as foreign — not silently adopted', async () => {
    const proc = fakeChildProcess();
    vi.mocked(spawn).mockImplementation(() => {
      // Defer so spawnServe's .on('error') registration (synchronous, right
      // after this mock returns) is already attached when it fires.
      queueMicrotask(() => proc.emit('error', new Error('spawn hermes ENOENT')));
      return proc as unknown as ChildProcess;
    });

    // A responder answers the health probe (e.g. a squatter already on the
    // port) and serves a token that is NOT the one we minted — the exact S3
    // scenario `isForeignBackendToken` exists to catch, gated here on our
    // child's liveness.
    const spawnedClient = fakeClient({ probeSeq: [true], servedToken: 'squatter-token' });

    const manager = new HermesDashboardManager({
      // pythonPath pinned alongside hermesPath — see the sibling T-B2 test
      // above for why (AU-7 realpath+existence-check derivation would
      // otherwise reject this fake path against the real FS).
      config: { hermesPath: '/fake/hermes', pythonPath: '/fake/python' },
      port: 9119,
      probeBackoffMs: [1],
      deps: {
        makeClient: () => spawnedClient,
        sleep: async () => {},
        mintToken: () => 'minted-token',
      },
    });

    // Today (pre-fix): the errored child never sets `exited`, so `alive()`
    // stays true forever -> `isForeignBackendToken` sees `childAlive: true` ->
    // treats the mismatch as benign drift -> ADOPTS the squatter. Must instead
    // throw the existing "served by a process we did not spawn" refusal.
    await expect(manager.ensure()).rejects.toThrow(/we did not spawn/i);
  });
});
