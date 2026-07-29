import type { Logger } from '../../transport/JsonRpcStdio';
import type { RootCoordinatorLike } from '../../checkpoints/RootCoordinator';
import type { AcpClientLike } from '../acp/acpClient';
import type { AcpSessionUpdate, AcpToolKind } from '../acp/types';
import { extractSingleBlockText } from '../acp/contentBlocks';
import type { OneShotResult } from '../../scm/utilityModel';

/**
 * W6-FI-a (3-way ARCH I-4, part 1 of 3) — the ephemeral one-shot subsystem,
 * EXTRACTED VERBATIM off `AcpBackend` (behavior-preserving MOVE + dependency
 * injection, not a rewrite — see `AcpBackend`'s one remaining reference to
 * this class for the delegation seam). Every `await` ordering, closure
 * capture, the deadline-races-the-entire-body semantics (T5b C1), the
 * `finally`-releases-the-lease guarantee, the refuse-2nd-concurrent
 * mutual-exclusion, the identity-guarded ephemeral deletes, and
 * `settleAllEphemeral` are preserved exactly — only WHERE this code lives
 * changed, never WHAT it does.
 *
 * HEADLESS: no `vscode`/`fs`/`Date.now`/`Math.random` coupling (mirrors every
 * other `acp/*`/`session/*`-style pure module in this codebase, e.g.
 * `SessionController`) — every host dependency (the live ACP client, the
 * connection's "has start() completed" readiness signal, the per-root
 * `RootCoordinator` resolution, the logger) is reached through the injected
 * {@link OneShotHostPort}.
 *
 * §2c — "One-shot model-call surface": a silent, isolated single model call
 * on the EXISTING ACP connection via an ephemeral `session/new`. See §2c for
 * the six pinned requirements; each is tagged `§2c req N` at its implementation site below,
 * same as before the extraction.
 */
export class OneShotRunner {
  /**
   * §2c (req 1, req 6): in-flight ephemeral one-shot sessions, keyed by their
   * ACP `sessionId`. See the original field doc (preserved verbatim in the
   * module's git history, `AcpBackend.ts` pre-W6-FI-a) for the full lifecycle
   * contract — unchanged by this extraction.
   */
  private readonly ephemeral = new Map<string, OneShotCollector>();

  /**
   * W4-T2 (F1 — critic pin): a per-invocation counter minting a UNIQUE
   * synthetic lease-holder id for each {@link oneShot} call. The real ACP
   * ephemeral sessionId isn't known until `client.newSession()` resolves
   * (async), but the root lease must be acquired SYNCHRONOUSLY (§2c req 4) —
   * so a one-shot acquires under `one-shot-<n>` instead, consistently used
   * for both the acquire and the matching release. Must be UNIQUE per
   * invocation (not a fixed sentinel): `RootCoordinator.tryAcquireTurnLease`
   * treats the SAME holder id re-acquiring as idempotent-true, so a fixed
   * sentinel would let a SECOND concurrent one-shot silently "acquire" a
   * lease its sibling already holds.
   */
  private leaseCounter = 0;

  constructor(private readonly port: OneShotHostPort) {}

  /**
   * True iff `sessionId` currently belongs to an in-flight ephemeral
   * one-shot — the ACP client-callback dispatch's FIRST-branch check
   * (`AcpBackend.handleSessionUpdate`'s "the one-shot's stream must be
   * caught BEFORE the registry lookup" / `handleRequestPermission`'s
   * ephemeral-vs-unrecognized log split). Injected at those two call sites
   * per the 3-way arch review's I-4 recommendation ("inject a `has`/`collect`
   * collector registry at the 2 lookup sites").
   */
  has(sessionId: string): boolean {
    return this.ephemeral.has(sessionId);
  }

  /**
   * Forward an ACP `session/update` to the matching ephemeral collector — a
   * no-op if `sessionId` doesn't (or no longer does) belong to one. Paired
   * with {@link has} at `AcpBackend.handleSessionUpdate`'s call site (a
   * `has` check gates whether the caller takes the ephemeral-first branch at
   * all, mirroring the original single `Map.get` + truthy-branch shape).
   */
  collect(sessionId: string, update: AcpSessionUpdate): void {
    this.ephemeral.get(sessionId)?.collect(update);
  }

  /**
   * §2c req 4 (bidirectional SYNCHRONOUS mutual exclusion): every check
   * below, and the lease-acquire, happen BEFORE this method's first `await`
   * — nothing yields to the event loop in between, so there is no window in
   * which a concurrent `sendPrompt`/`oneShot` could observe a stale flag.
   *
   * W4-T2 (F1 — critic pin, subsumes W2 §2c.4): the one-shot acquires the
   * SAME root turn-lease `SessionController.sendPrompt` uses, for its cwd's
   * root, under a UNIQUE synthetic holder id (see {@link leaseCounter}'s
   * doc — a fixed sentinel would wrongly let a second concurrent one-shot
   * idempotently "join" the first's lease). This is ONE mechanism:
   * `tryAcquireTurnLease` itself expresses BOTH "a main turn is live" and
   * "another one-shot is live" as a single refusal. Released in the
   * `finally` below — the ONE choke-point every exit path (success, error,
   * tripwire, deadline, teardown/crash settling the ephemeral collector)
   * converges through, since {@link runOneShotBody} always resolves via
   * `collector.result`.
   *
   * W6-FG (3-way ARCH I-2 fix): `opts.cwd` is a REQUIRED, EXPLICIT parameter
   * — the F1 lease above is derived from THAT, never from the connection's
   * ambient cwd. `port.getConnectionCwd()` below is used ONLY as the "has
   * this connection completed at least one successful start()" readiness
   * gate (the original `!this.client || !this.cwd` check) — never as a
   * root-resolution input.
   *
   * `client` is captured into a local ONCE (both for the readiness check and
   * the later call) rather than re-read off the port twice — a provably
   * equivalent simplification: nothing between the two original reads could
   * observe/mutate it (fully synchronous, no `await` yet), and capturing
   * once also lets a plain accessor function narrow cleanly for the
   * (synchronous) rest of this method.
   */
  async oneShot(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<OneShotResult> {
    const client = this.port.getClient();
    if (!client || !this.port.getConnectionCwd()) {
      return { ok: false, error: 'The agent session is not started yet.' };
    }
    const cwd = opts.cwd;
    const root = this.port.resolveRoot(cwd);
    this.leaseCounter += 1;
    const leaseHolder = `one-shot-${this.leaseCounter}`;
    if (!root.tryAcquireTurnLease(leaseHolder)) {
      return { ok: false, error: 'a turn is already running' };
    }
    try {
      return await this.runOneShot(client, cwd, root, prompt, opts.timeoutMs ?? 30_000);
    } finally {
      root.releaseTurnLease(leaseHolder);
    }
  }

  /**
   * The async body of {@link oneShot}, split out so the SYNCHRONOUS
   * mutual-exclusion checks/lease-acquire in `oneShot` itself stay trivially
   * auditable. `client`/`cwd` are captured as local params (not re-read off
   * a mutable field) so a crash/teardown racing this call can never
   * retarget it mid-flight onto a different (or absent) client.
   *
   * C1 (Critical, fixed): the wall-clock deadline is armed HERE, before the
   * FIRST `await` of the whole flow — it races the ENTIRE
   * {@link runOneShotBody} (`newSession` → `setSessionMode` → the
   * before-snapshot → `prompt()`), not just the prompt phase.
   */
  private async runOneShot(
    client: AcpClientLike,
    cwd: string,
    root: RootCoordinatorLike,
    prompt: string,
    timeoutMs: number,
  ): Promise<OneShotResult> {
    let ephemeralId: string | undefined;

    // V-10 (ONESHOT-ORPHAN fix): set as the FIRST line of the deadline
    // handler below — closes the pre-registration gap where the deadline
    // fires before `ephemeralId` is known (the handler itself cancels
    // nothing in that case). Threaded into `runOneShotBody` as a `timedOut`
    // accessor so it can re-check "did the deadline already fire?" after
    // EVERY suspension point of its own — the same "re-validate liveness
    // right after the suspension point" discipline BF-B already applies
    // (`SessionController.ts:612-617`) — even after THIS method's own
    // `Promise.race` has already resolved and returned to `oneShot`'s
    // caller (a zombie continuation can still observe this closure var).
    let hasTimedOut = false;

    let resolveDeadline!: (result: OneShotResult) => void;
    const deadline = new Promise<OneShotResult>((res) => {
      resolveDeadline = res;
    });
    const timeoutHandle = setTimeout(() => {
      hasTimedOut = true;
      this.port.logger?.append(`[AcpBackend] one-shot deadline (${timeoutMs}ms) exceeded — cancelling`);
      const result: OneShotResult = { ok: false, error: 'timed out' };
      if (ephemeralId) {
        const id = ephemeralId;
        void client.cancel(id).catch((err) => {
          this.port.logger?.append(`[AcpBackend] one-shot deadline cancel failed: ${errorMessage(err)}`);
        });
        const collector = this.ephemeral.get(id);
        collector?.settle(result);
        if (collector && this.ephemeral.get(id) === collector) this.ephemeral.delete(id); // M4: identity-guarded
      }
      resolveDeadline(result);
    }, timeoutMs);
    timeoutHandle.unref?.();

    const body = this.runOneShotBody(
      client,
      cwd,
      root,
      prompt,
      (id) => {
        ephemeralId = id;
      },
      () => hasTimedOut,
    );

    try {
      return await Promise.race([body, deadline]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * The actual `newSession` → `setSessionMode` → before-snapshot → `prompt()`
   * sequence, split out of {@link runOneShot} so that method can race it
   * against the wall-clock deadline (C1) without the timer nesting inside it.
   *
   * V-10 (ONESHOT-ORPHAN fix): `timedOut` is re-checked after EVERY `await`
   * in this method (`newSession`, the conditional `setSessionMode`,
   * `snapshotBeforeOneShot`) and again immediately before the `client.prompt`
   * dispatch — the post-`newSession` check is the LOAD-BEARING one (the only
   * gap where the deadline can fire before this method has registered
   * anything with the outer {@link runOneShot}); the later checks are
   * defense-in-depth for the same race at every subsequent suspension point.
   * A positive check cancels the (by-then-known) ephemeral session,
   * identity-guard-deletes any collector already registered for it, and
   * returns the timeout result WITHOUT ever reaching `client.prompt` —
   * fail-closed: a timeout aborts MORE, never less.
   */
  private async runOneShotBody(
    client: AcpClientLike,
    cwd: string,
    root: RootCoordinatorLike,
    prompt: string,
    onSessionCreated: (id: string) => void,
    timedOut: () => boolean,
  ): Promise<OneShotResult> {
    let ephemeralId: string | undefined;
    let createdCollector: OneShotCollector | undefined;
    try {
      const session = await client.newSession(cwd, []);
      const id = session.sessionId;
      ephemeralId = id;
      onSessionCreated(id);

      const abortedAfterNewSession = this.abortOneShotIfTimedOut(timedOut, client, id, undefined);
      if (abortedAfterNewSession) return abortedAfterNewSession;

      const collector = new OneShotCollector(
        id,
        () => {
          void client.cancel(id).catch((err) => {
            this.port.logger?.append(`[AcpBackend] one-shot cancel failed: ${errorMessage(err)}`);
          });
        },
        this.port.logger,
      );
      createdCollector = collector;
      this.ephemeral.set(id, collector);

      if (session.currentModeId !== 'default') {
        await client.setSessionMode(id, 'default');
        const abortedAfterMode = this.abortOneShotIfTimedOut(timedOut, client, id, collector);
        if (abortedAfterMode) return abortedAfterMode;
      }

      await this.snapshotBeforeOneShot(root);
      // Immediately before the `client.prompt` dispatch — no suspension
      // point exists between `snapshotBeforeOneShot` returning and here, so
      // this ONE check also covers "right after the snapshot await".
      const abortedBeforePrompt = this.abortOneShotIfTimedOut(timedOut, client, id, collector);
      if (abortedBeforePrompt) return abortedBeforePrompt;

      const content = [{ type: 'text' as const, text: prompt }];
      const promptPromise = client.prompt(id, content);
      void promptPromise
        .then(() => collector.settle({ ok: true, text: collector.collectedText }))
        .catch((err) => collector.settle({ ok: false, error: errorMessage(err) }))
        .finally(() => {
          if (this.ephemeral.get(id) === collector) this.ephemeral.delete(id);
        });

      return await collector.result;
    } catch (err) {
      if (ephemeralId && this.ephemeral.get(ephemeralId) === createdCollector) this.ephemeral.delete(ephemeralId);
      return { ok: false, error: errorMessage(err) };
    }
  }

  /**
   * V-10: the shared "check cancellation after every suspension point"
   * guard {@link runOneShotBody} re-invokes at each of its checkpoints.
   * `undefined` when the deadline has not (yet) fired — the caller proceeds
   * normally. When it HAS fired, best-effort cancels the now-known ephemeral
   * `id` (same fire-and-forget `.catch(log)` posture as the deadline
   * handler's own cancel in {@link runOneShot}) and identity-guard-deletes
   * `collector` from the registry (the SAME `:167` idiom — a no-op when
   * `collector` is `undefined`, i.e. the post-`newSession` checkpoint, where
   * nothing has been registered yet: the pre-registration gap is closed by
   * never registering, not by un-registering).
   */
  private abortOneShotIfTimedOut(
    timedOut: () => boolean,
    client: AcpClientLike,
    id: string,
    collector: OneShotCollector | undefined,
  ): OneShotResult | undefined {
    if (!timedOut()) return undefined;
    void client.cancel(id).catch((err) => {
      this.port.logger?.append(`[AcpBackend] one-shot deadline cancel failed: ${errorMessage(err)}`);
    });
    if (collector && this.ephemeral.get(id) === collector) this.ephemeral.delete(id); // M4: identity-guarded
    return { ok: false, error: 'timed out' };
  }

  /**
   * §2c req 3: fail-open before-snapshot for the one-shot flow, calling the
   * OWNING root's tracker DIRECTLY — never touches any controller's
   * `currentTurnProtected` or panel push. W4-T2 (F3): draws a NEGATIVE
   * non-turn ordinal from the OWNING coordinator's ROOT-SCOPED
   * `nextBaselineOrdinal()` (two tabs' one-shots on the SAME root must mint
   * DISTINCT negatives). NEVER rejects.
   */
  private async snapshotBeforeOneShot(root: RootCoordinatorLike): Promise<void> {
    const tracker = root.tracker;
    if (!tracker) return;
    const ordinal = root.nextBaselineOrdinal();
    try {
      await tracker.snapshot(ordinal, 'One-shot utility call');
    } catch (err) {
      this.port.logger?.append(
        `[AcpBackend] one-shot before-snapshot failed (proceeding unprotected): ${errorMessage(err)}`,
      );
    }
  }

  /**
   * §2c req 5: settle every still-in-flight ephemeral one-shot as failed —
   * the SAME choke-points that settle `pendingApprovals` (`AcpBackend
   * .teardownSession`/`handleAcpCrash`). Unchanged by this extraction.
   */
  settleAll(reason: string): void {
    for (const collector of this.ephemeral.values()) {
      collector.settle({ ok: false, error: reason });
    }
    this.ephemeral.clear();
  }
}

/**
 * The dependencies a `OneShotRunner` needs from its host, injected so the
 * runner itself never imports `vscode` and stays unit-testable in isolation
 * (mirrors `SessionHostPort`'s accessor posture, `session/types.ts`).
 */
export interface OneShotHostPort {
  /** The live ACP client, read at call time — `undefined` before/between connections. */
  getClient(): AcpClientLike | undefined;
  /**
   * The connection's ambient resolved cwd — used ONLY as the "has this
   * connection completed at least one successful start()" readiness gate
   * (the original `!this.client || !this.cwd` guard), NEVER as the
   * one-shot's root-resolution input (that is always the caller's explicit
   * `opts.cwd`, W6-FG / 3-way ARCH I-2).
   */
  getConnectionCwd(): string | undefined;
  /**
   * Resolve (or mint) the `RootCoordinator` owning `cwd`'s workspace root —
   * the SAME resolution every session-level caller shares
   * (`AcpBackend.resolveRootCoordinator`), so a one-shot and a main turn on
   * the same root always contend for the same lease (F1).
   */
  resolveRoot(cwd: string): RootCoordinatorLike;
  logger?: Logger;
}

/**
 * §2c: one instance per in-flight ephemeral one-shot session — the value
 * type of {@link OneShotRunner}'s ephemeral registry. Unchanged by the
 * W6-FI-a extraction (moved verbatim off `AcpBackend.ts`). Accumulates
 * `agent_message_chunk` text off the isolated stream (req 6) and enforces
 * the tool-call tripwire (req 3).
 */
class OneShotCollector {
  private text = '';
  private settled = false;
  private readonly resolveResult: (result: OneShotResult) => void;
  readonly result: Promise<OneShotResult>;
  private readonly kindByToolCallId = new Map<string, AcpToolKind>();

  constructor(
    private readonly sessionId: string,
    private readonly cancelSession: () => void,
    private readonly logger?: Logger,
  ) {
    let resolve!: (result: OneShotResult) => void;
    this.result = new Promise<OneShotResult>((res) => {
      resolve = res;
    });
    this.resolveResult = resolve;
  }

  get collectedText(): string {
    return this.text;
  }

  collect(update: AcpSessionUpdate): void {
    if (this.settled) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.text += extractSingleBlockText(update.content);
      return;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const isFreshCall = update.sessionUpdate === 'tool_call';
      let kind: AcpToolKind | undefined;
      if (update.kind != null) {
        kind = update.kind;
        this.kindByToolCallId.set(update.toolCallId, kind);
      } else if (!isFreshCall) {
        kind = this.kindByToolCallId.get(update.toolCallId);
      }
      if (kind === 'read' || kind === 'think') return;
      if (kind === undefined && !isFreshCall) return;
      this.logger?.append(
        `[AcpBackend] one-shot tripwire: ephemeral session '${this.sessionId}' produced a '${String(kind)}' tool_call — cancelling`,
      );
      this.cancelSession();
      this.settle({ ok: false, error: 'unexpected tool call' });
    }
  }

  settle(result: OneShotResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(result);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
