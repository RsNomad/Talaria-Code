/**
 * W4 S0 scaffolding (§2b/§2c) — the per-session actor's port + pure view
 * types. TYPES/SIGNATURES ONLY: no `SessionController` implementation lands
 * here yet (T1's job — it moves `sendPrompt`/`cancel`/`respondApproval`/
 * `resolveDiff`/`applyUpdate`/`handlePermission`/`setPreset`/`setMode`/
 * `setModel`/`dispose()` off `AcpBackend` verbatim, per §2c's port sketch).
 * S0 keeps runtime behavior UNCHANGED (`AcpBackend` still owns everything
 * directly) — this file exists only so the WIRE TYPES that shape that move
 * are pinned now, compiler-checked, ahead of the actual refactor.
 *
 * NO vscode IMPORTS (headless-testable, mirrors every other `acp/*`-style
 * pure module in this codebase) — `AcpClientLike`/`Logger` are themselves
 * vscode-free (Node + the ACP SDK only); `HostToWebviewMessage` is a plain
 * data shape.
 */
import type { AcpClientLike } from '../acp/acpClient';
import type { ContextRef, SessionScopedMessage } from '../../../shared/protocol';
import type { Logger } from '../../transport/JsonRpcStdio';
import type { RootCoordinatorLike } from '../../checkpoints/RootCoordinator';
import type { ResolvedContext } from '../../context/types';
import type { EditPreviewRegistry } from '../../preview/EditPreviewRegistry';

/**
 * The dependencies a `SessionController` needs from its host, injected so
 * the controller itself never imports `vscode` and stays unit-testable in
 * isolation (mirrors `PanelSourceContext`'s accessor posture,
 * `PanelSourceRegistry.ts`).
 */
export interface SessionHostPort {
  /** The live ACP client, read at call time (accessor — the PanelSourceContext pattern). */
  getClient(): AcpClientLike | undefined;
  /**
   * Fires a HostToWebview message. The controller stamps ITS sessionId
   * before calling.
   *
   * W6-FE Part 3 (3-way ARCH I-3b): constrained to {@link SessionScopedMessage}
   * (every {@link HostToWebviewMessage} variant carrying a REQUIRED
   * `sessionId`) — a compile-time guarantee that a `SessionController` can
   * NEVER emit an unscoped/global message that would bleed across tabs (P-1),
   * instead of a convention. A genuinely connection-global signal (no
   * session to tag it to) goes through {@link emitSystemError} instead.
   */
  emit(msg: SessionScopedMessage): void;
  /**
   * W6-FE Part 3: the ONE sanctioned connection-global emit a session actor
   * still needs (3-way arch review Minor #4 — `sendPrompt`'s "no client
   * started yet" case: genuinely no session is live, so a per-tab `error`
   * would misrepresent a connection-wide fact as session-scoped). Routes to
   * `HostToWebview`'s `system.error` — a banner across every tab, never
   * folded into (or dropped alongside) any one tab's transcript. Typed with
   * NO sessionId parameter so there is nothing to spuriously stamp.
   */
  emitSystemError(message: string, detail?: string): void;
  /** The root coordinator for this session's cwd (lease, ordinals, tracker) — §3.2. */
  root: RootCoordinatorLike;
  /**
   * §7 sync-2: the FULL workspace-root list (multi-root containment) — the
   * vscode-backed dependency `canonicalizeToolCallPaths` needs
   * (`AcpBackend.ts`'s `workspaceRoots()`/`canonicalizeToolCallPaths`). An
   * accessor-at-call-time (like `getClient`), NOT `root`'s single per-session
   * root — so the controller compiles pure and the policy-signal build moves
   * onto it cleanly.
   */
  workspaceRoots(): string[];
  logger?: Logger;

  /**
   * W4-T1a addition (beyond the S0 sketch — the S0 file header itself
   * anticipates this: "T1/T2 may need to widen it once SessionController
   * construction makes its real field set concrete"). Best-effort,
   * fire-and-forget trigger of a checkpoints panel re-push after a snapshot
   * moved the baseline — a thin passthrough to the host's existing
   * panel-fetch machinery (`AcpBackend.fetchPanelData`). Failures are
   * swallowed + logged host-side; never throws/rejects back to the
   * controller (mirrors every other checkpoints-refresh call site).
   */
  refreshCheckpointsPanel(): void;

  /**
   * W4-T1a addition: the host's read-only diff-preview registry
   * (extension.ts-owned, keyed by `toolCallId` — see
   * `src/host/preview/EditPreviewRegistry.ts`). `undefined` when not wired
   * (tests, or before T4 lands) — every controller call site already
   * treats an absent registry as a no-op via optional chaining.
   */
  editPreviewRegistry?: EditPreviewRegistry;

  /**
   * W4-T1a addition: TOTAL (never rejects/throws) `@`-mention resolution —
   * a thin passthrough to `AcpBackend`'s own `resolveMentionsSafe`, kept
   * host-side because the injected `MentionResolverLike` is a connection-
   * level dependency (T2c), not a per-session one. No mentions / no resolver
   * injected resolves to `[]`, exactly like today.
   */
  resolveMentions(mentions?: ContextRef[]): Promise<ResolvedContext[]>;
}

/**
 * A pure, read-only snapshot of one session's identity — the explicit scope
 * key a session-coupled `PanelSource` fetch carries (§2f/§7 B6: "session
 * identity is an EXPLICIT request parameter, not an ambient accessor"),
 * never an ambient `getActiveSessionView()`-style accessor (§7 B6 — that
 * pattern was rejected: a fetch resolving after the user activates a
 * DIFFERENT tab must not silently read the wrong session).
 *
 * S0 NOTE: the architecture doc's file-tree comment names this type but
 * does not pin its exact fields elsewhere — this is a conservative,
 * intentionally minimal first cut (the two identity fields every session-
 * scoped consumer in this doc actually reads: the routing key and the
 * cwd-scoped fetches use). T1/T2 may need to widen it once
 * `SessionController` construction makes its real field set concrete.
 */
export interface SessionView {
  readonly sessionId: string;
  readonly cwd: string;
}
