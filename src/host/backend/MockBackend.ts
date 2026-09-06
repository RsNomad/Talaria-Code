import * as vscode from 'vscode';
import type {
  HostToWebview,
  HostToWebviewMessage,
  AgentMode,
  Attachment,
  ApprovalOption,
  ContextRef,
  ControlMethod,
  DiffAction,
  DataPanel,
  GlobalPanel,
  PanelDataMap,
} from '../../shared/protocol';
import { CONTROL_METHODS, makePanelData } from '../../shared/protocol';
import { mockScenario } from '../../shared/mockScenario';
import type { MockScenario, MockStep } from '../../shared/mockScenario';
import type { AgentBackend } from './AgentBackend';
import type { ApprovalRequestMessage } from './acp/permission';

/**
 * W4 §2d/§7 B12: the host `MockBackend` auto-binds ONE session at startup so
 * every existing single-session host test keeps passing with a one-line
 * fixture (a `tab.bound` in the collected stream) instead of a behavior
 * change. `mock-session-1` is a SEPARATE id from `mockScenario`'s own
 * `SESSION_ID` ('sess-8a4c', baked into the scripted `mockTurn` messages) —
 * both are inert placeholders in S0 (nothing keys off either yet); T3's
 * standalone webview mock (`webview/src/mock/MockBackend.ts`) is the one
 * that mints a session PER TAB and is actually driveable multi-session.
 */
const MOCK_SESSION_ID = 'mock-session-1';
const MOCK_TAB_ID = 'mock-tab-1';

/**
 * WS-A T5c (BH-05): the same one-line rule as `SessionController.ts`'s
 * module-private `findOptionId` (kept private there — the mock must not
 * reach into the controller, and importing it would drag the controller's
 * whole import graph under this file's `vscode` shim in tests).
 */
function optionIdOfKind(options: ApprovalOption[], kind: ApprovalOption['kind']): string | undefined {
  return options.find((option) => option.kind === kind)?.id;
}

/**
 * The DEFAULT backend. Replays a canned coding turn so the whole extension runs
 * on any OS with **no Hermes process and no network** (pinned decision #4).
 *
 * It consumes `mockScenario` (authored by Agent D in `src/shared/mockScenario`)
 * and streams the timeline out through {@link onMessage} on realistic
 * `setTimeout` delays, producing the exact sequence the real backend will:
 *
 *   turn.start → user → reasoning.start/delta/end → tool.start/update (read) →
 *   message.delta → tool.start (real tc-… patch, pending) →
 *   tool.start/tool.diff/approval.request (synthetic edit-approval-1, gate) →
 *   approval.settle (echoed by this mock) → tool.update (tc-… done) →
 *   plan.update → tool.start/approval.request (npm test, gate) →
 *   approval.settle → … → result.summary → turn.end
 *
 * ### Assumed scenario shape (contract with Agent D — see docs/arch-host.md)
 * ```ts
 * interface MockScenario {
 *   timeline: MockStep[];                 // ordered playback
 *   panels: Record<string, unknown>;      // tab id → payload for panel.data
 * }
 * interface MockStep {
 *   delayMs: number;                      // wait before emitting `message`
 *   message: HostToWebviewMessage;        // already a protocol message
 *   gate?: 'approval' | 'diff';           // pause AFTER emitting until the user
 *                                         // responds (respondApproval/resolveDiff)
 * }
 * ```
 * The player is tolerant: a step with no `gate` streams straight through; a
 * gated step parks the player until the matching response advances it. No step
 * ever spawns a process.
 */
export class MockBackend implements AgentBackend {
  /** D2 (A2): this is the mock — see `AgentBackend.kind`'s doc. */
  readonly kind = 'mock' as const;

  /**
   * TE-4 (AU-11, INV-15) belt: mirrors `ControlDispatcher.
   * ALLOWED_CONTROL_METHODS` exactly — same construction, same source array
   * — so the mock backend's runtime gate can never drift against the real
   * backend's. Before this fix, ANY method reaching {@link invokeControl}
   * other than `'panel.data'` fell through to a "courtesy" `ok:true` ack —
   * including a name that was never a real control method at all, which is
   * the exact "unknown method silently accepted" gap this closes. A method
   * genuinely IN this set but with no scripted mock behavior still gets the
   * courtesy ack (that part is unchanged and correct); only a name OUTSIDE
   * it is now refused.
   */
  private static readonly KNOWN_CONTROL_METHODS: ReadonlySet<string> = new Set<ControlMethod | 'panel.data'>([
    ...CONTROL_METHODS,
    'panel.data',
  ]);

  private readonly emitter = new vscode.EventEmitter<HostToWebviewMessage>();
  readonly onMessage = this.emitter.event;

  private readonly scenario: MockScenario = mockScenario;

  /** Playback cursor into `scenario.timeline`. */
  private cursor = 0;
  /** Timer for the next scheduled step (so `cancel`/`dispose` can clear it). */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** What kind of user response the parked player is waiting for, if any. */
  private gate: 'approval' | 'diff' | undefined;
  /** WS-A T5c (BH-05): per-hunk ACCEPT decisions for the PARKED edit
   * approval — the host's `hunkState.decisions` stand-in. Cleared on every
   * settle and on `reset()`. Connection-level, like `gate`/`cursor` (this
   * host mock stays single-scenario-at-a-time — see `openTab`'s doc). */
  private readonly hunkDecisions = new Set<number>();
  private playing = false;
  /** Last turn id seen in the stream — used for `cancel`'s `turn.end`. */
  private currentTurnId: string | undefined;
  /** Last sessionId seen in the stream — used for `cancel`'s `turn.end` (W4 §2d). */
  private currentSessionId: string | undefined;

  /** W4-T3b: per-tab-open mock session counter — `mock-tab-session-N`. */
  private nextTabSessionSeq = 0;

  start(): void {
    // Nothing to spin up — a mock is always "connected". A fresh start rewinds
    // so `talaria.newSession` gives a clean replay.
    this.reset();
    // T-1 (V-12 RESTART-STATE) mock parity: `MOCK_SESSION_ID`/`MOCK_TAB_ID`
    // never change across a restart, so the `tab.bound` re-emit below alone
    // would NOT clear a prior transcript (`tab.bound`'s fold only touches
    // sessionId/binding/rootId/title, never the transcript array) — the
    // exact zombie-tab/concatenated-conversation bug this task closes for
    // the real backend. An honest, session-scoped `clear` first gives the
    // mock the SAME restart honesty the ACP backend's restart fan-out now
    // provides.
    this.emit({ type: 'clear', sessionId: MOCK_SESSION_ID });
    // W4 §2d/§7 B8: auto-bind the one mock session so the composer's
    // per-tab `tab.bound` latch (T1) has something to unlock against even
    // under the mock backend. Routed through `emit()` (not a raw `.fire`) so
    // `currentSessionId` is seeded immediately, before any turn runs.
    // W4-T3b (D1): `rootId` mirrors the mock session id — the mock has no
    // real per-root scoping (S0 placeholder, unchanged by T3b).
    this.emit({ type: 'tab.bound', tabId: MOCK_TAB_ID, sessionId: MOCK_SESSION_ID, rootId: MOCK_SESSION_ID });
  }

  /**
   * W4-T3b (Deliverable 5): interface compliance + basic correctness for the
   * tab strip's "+" — mints a fresh mock session per tab and binds it. This
   * host-side mock DELIBERATELY stays single-scenario-at-a-time (the shared
   * `cursor`/`timer`/`gate` player fields are connection-level, not
   * per-session) — the standalone WEBVIEW mock
   * (`webview/src/mock/MockBackend.ts`) is the one that mints a session PER
   * TAB and is actually driveable multi-session (§7 B12); this host mock's
   * job is only to keep the extension's own dev/test surface interface-
   * compliant and non-throwing under a real tab-open.
   */
  async openTab(tabId: string): Promise<void> {
    this.nextTabSessionSeq += 1;
    const sessionId = `mock-tab-session-${this.nextTabSessionSeq}`;
    this.emit({ type: 'tab.bound', tabId, sessionId, rootId: sessionId });
  }

  /** W4-T3b: the mock holds no per-session resources beyond `currentSessionId`
   * bookkeeping — a no-op unless it happens to be the one currently "active". */
  closeTab(sessionId: string): void {
    if (this.currentSessionId === sessionId) this.currentSessionId = undefined;
  }

  /**
   * W3-T6 (CF-11/D2): the composer's per-tab "New Session" — a simple mock
   * counterpart to the real `AcpBackend.newSessionInTab`. This host mock has
   * no per-tab registry (§ `openTab`'s own doc — it stays single-scenario-
   * at-a-time): `sessionId` is accepted for interface/wire parity only and
   * never branched on — MIN-B (3-lens review) closed the two divergences
   * from the real backend that used to follow from that: (1) the shared
   * connection-level scripted player kept running after a rebind (nothing
   * stopped it — a mid-stream step could still land, stamped with the OLD
   * session, after the tab had moved on); (2) the clear was keyed off the
   * wire's `sessionId` hint. `reset()` (the SAME stop {@link start}/{@link
   * sendPrompt} already use) now stops the player first, and the clear is
   * `tab.clear{tabId}` — tabId-keyed, unconditional, parity with the real
   * backend + the webview mock. There is still no real turn-lease/root
   * machinery to preserve, so no wire-level cancel is needed here (unlike
   * the real backend's IMP-1 fix). Mints a fresh `mock-tab-session-N` and
   * binds it to the SAME tab, same as `openTab`.
   */
  async newSessionInTab(tabId: string, sessionId?: string): Promise<void> {
    void sessionId; // interface/wire parity only — see this method's own doc
    this.reset();
    this.emit({ type: 'tab.clear', tabId });
    this.nextTabSessionSeq += 1;
    const freshSessionId = `mock-tab-session-${this.nextTabSessionSeq}`;
    this.emit({ type: 'tab.bound', tabId, sessionId: freshSessionId, rootId: freshSessionId });
  }

  /**
   * W4 §2d: `sessionId`-first per {@link AgentBackend}. The mock has exactly
   * ONE auto-bound session (`MOCK_SESSION_ID`), so the incoming value is
   * accepted for interface parity but not branched on — the scripted
   * `mockTurn` messages carry their own baked-in sessionId already.
   */
  sendPrompt(
    _sessionId: string,
    _text: string,
    _mode: AgentMode,
    _attachments?: Attachment[],
    _mentions?: ContextRef[],
  ): void {
    // The mock ignores the prompt text/mode/attachments/mentions and replays
    // the canned turn from the top. (The scenario itself carries the
    // `user`/`turn.start` echo, so we don't synthesize one here — it stays a
    // single source of truth.) Real backends map `_attachments` to ACP
    // image/pdf/file attach and (W2 F-M, a later task) `_mentions` through the
    // host-side context resolution seam.
    // e.g. console.log(`[mock] ignoring ${_attachments?.length ?? 0} attachment(s), ${_mentions?.length ?? 0} mention(s)`);
    this.reset();
    this.playing = true;
    this.scheduleNext();
  }

  cancel(_sessionId: string): void {
    this.clearTimer();
    this.playing = false;
    this.gate = undefined;
    this.emit({
      type: 'turn.end',
      turnId: this.currentTurnId ?? 'turn',
      sessionId: this.currentSessionId ?? MOCK_SESSION_ID,
      status: 'cancelled',
    });
  }

  /**
   * WS-A T5c (BH-05): resumes ONLY when `id` is the approval the player is
   * parked on (read off the parked step — so the script's second gate, the
   * npm-test command approval, resumes on its own id), and — as the real
   * host does in `SessionController.respondApproval` — echoes the
   * authoritative `approval.settle{selected, optionId}` FIRST, carrying the
   * option the user ACTUALLY chose. A deny is echoed honestly (the webview
   * folds the synthetic edit-approval card to Denied); the scripted
   * continuation is linear and still plays — the same skeleton posture as
   * denying the npm-test gate.
   */
  respondApproval(_sessionId: string, id: string, optionId: string): void {
    const parked = this.parkedApproval();
    if (!parked || parked.id !== id) return;
    this.settleAndAdvance(parked, optionId);
  }

  /**
   * WS-A T5c (BH-05): the host-mock mirror of `SessionController.resolveDiff`
   * for the PARKED edit approval — any reject settles the whole edit to its
   * deny option; accepts accumulate and settle to the allow option once every
   * hunk is accepted; an out-of-range index is ignored (BHF-F1-3). The legacy
   * `'diff'` gate (unused by the current script) keeps its old advance.
   *
   * Faithfulness note: the REAL `SessionController.resolveDiff` only has
   * `hunkState` for a toolId when `totalHunks > 0` (emitApprovalCard sets it
   * only then) — a diff-less approval has no hunk-aggregation state at all,
   * so its `resolveDiff` is an unconditional no-op regardless of `action`.
   * Mirror that here (unlike the webview mock's own deferred Minor on this
   * point) so this host mock stays fully host-accurate.
   */
  resolveDiff(_sessionId: string, toolId: string, hunkIndex: number, action: DiffAction): void {
    if (this.gate === 'diff') {
      this.gate = undefined;
      this.advance();
      return;
    }
    const parked = this.parkedApproval();
    if (!parked || parked.toolId !== toolId) return;
    const total = this.totalHunksFor(toolId);
    if (total === 0) return;
    if (action === 'reject') {
      this.settleAndAdvance(parked, optionIdOfKind(parked.options, 'deny') ?? 'deny');
      return;
    }
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= total) return;
    this.hunkDecisions.add(hunkIndex);
    if (this.hunkDecisions.size >= total) {
      this.settleAndAdvance(parked, optionIdOfKind(parked.options, 'allow_once') ?? 'allow_once');
    }
  }

  setModel(_sessionId: string, id: string): void {
    void id;
    // No-op for the mock; the webview reflects its own selection optimistically.
  }

  // P7-N10: `setMode` was YAGNI-deleted off `AgentBackend` (a sessionId-less
  // fan-out footgun with no meaningful caller) — this no-op implementation
  // went with it.

  /**
   * Side-panel data + any other control-plane reads. The provider maps the
   * `switchPanel` webview message to `invokeControl('panel.data', …)` (A#8:
   * the vestigial `'switchTab'`/`'switchPanel'` method-name branch was
   * removed), and routes `control.invoke`/`control.request` here too. For a
   * panel request we emit a `panel.data` message from `scenario.panels`
   * (push-driven, backend-identical) and resolve with the same payload for
   * callers that prefer a return value.
   */
  async invokeControl(method: string, params?: unknown): Promise<unknown> {
    if (method === 'panel.data') {
      const panel = (params as { panel?: DataPanel } | undefined)?.panel;
      const data = panel ? this.scenario.panels[panel] : undefined;
      if (panel && data !== undefined) {
        this.emit(this.buildPanelDataMessage(panel, data));
      }
      return data ?? null;
    }
    // TE-4 (AU-11, INV-15): a method outside the known control-method set is
    // refused, not courtesy-acked — see KNOWN_CONTROL_METHODS's doc.
    if (!MockBackend.KNOWN_CONTROL_METHODS.has(method)) {
      return { ok: false, error: 'unknown method' };
    }
    // Known control method with no scripted mock behavior: ack so the UI
    // doesn't hang awaiting a reply.
    return { ok: true, mock: true, method };
  }

  /**
   * W4 §7 B2: mirrors `ControlDispatcher.buildPanelDataMessage` (moved there
   * off `AcpBackend` in the W6-FI split) — the mock has no real per-root/
   * per-cwd scoping either, so `rootId`/`cwd` both fall back to the fixed
   * mock session/tab (S0 placeholder; T2's RootCoordinator and T1's real
   * per-session cwd replace these).
   */
  private buildPanelDataMessage<P extends DataPanel>(panel: P, data: PanelDataMap[P]): HostToWebview {
    const sessionId = this.currentSessionId ?? MOCK_SESSION_ID;
    if (panel === 'subagents') {
      return makePanelData(panel, data as PanelDataMap['subagents'], { sessionId });
    }
    if (panel === 'checkpoints') {
      return makePanelData(panel, data as PanelDataMap['checkpoints'], { rootId: MOCK_SESSION_ID });
    }
    if (panel === 'sessions') {
      return makePanelData(panel, data as PanelDataMap['sessions'], { cwd: MOCK_SESSION_ID });
    }
    if (
      panel === 'tools' ||
      panel === 'mcp' ||
      panel === 'skills' ||
      panel === 'models' ||
      panel === 'settings' ||
      panel === 'setup'
    ) {
      return makePanelData(panel, data as PanelDataMap[GlobalPanel]);
    }
    const exhaustive: never = panel;
    throw new Error(`unhandled panel: ${String(exhaustive)}`);
  }

  dispose(): void {
    this.clearTimer();
    this.emitter.dispose();
  }

  // --- player internals -----------------------------------------------------

  private reset(): void {
    this.clearTimer();
    this.cursor = 0;
    this.gate = undefined;
    this.hunkDecisions.clear();
    this.playing = false;
  }

  private advance(): void {
    this.cursor++;
    this.scheduleNext();
  }

  /** The scripted `approval.request` the player is parked on right now, or
   * undefined when not parked on an approval gate. */
  private parkedApproval(): ApprovalRequestMessage | undefined {
    if (this.gate !== 'approval') return undefined;
    const message = this.scenario.timeline[this.cursor]?.message;
    return message !== undefined && message.type === 'approval.request' ? message : undefined;
  }

  /** Total hunks the scenario attaches to `toolId` via `tool.diff` steps —
   * the stand-in for the host's `hunkState.totalHunks`. */
  private totalHunksFor(toolId: string): number {
    let total = 0;
    for (const step of this.scenario.timeline) {
      const message = step.message;
      if (message.type === 'tool.diff' && message.toolId === toolId) total += message.hunks.length;
    }
    return total;
  }

  /** Settle echo first (the real host's `respondApproval`/`finishApproval`
   * order), then un-park and advance. */
  private settleAndAdvance(parked: ApprovalRequestMessage, optionId: string): void {
    this.gate = undefined;
    this.hunkDecisions.clear();
    this.emit({
      type: 'approval.settle',
      sessionId: parked.sessionId,
      turnId: parked.turnId,
      id: parked.id,
      ...(parked.toolId !== undefined ? { toolId: parked.toolId } : {}),
      outcome: 'selected',
      optionId,
    });
    this.advance();
  }

  private scheduleNext(): void {
    if (!this.playing) this.playing = true;
    const step: MockStep | undefined = this.scenario.timeline?.[this.cursor];
    if (!step) {
      this.playing = false;
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => this.runStep(step), Math.max(0, step.delayMs));
  }

  private runStep(step: MockStep): void {
    this.emit(step.message);
    if (step.gate) {
      // Park until respondApproval/resolveDiff advances us.
      this.gate = step.gate;
      return;
    }
    this.advance();
  }

  private emit(message: HostToWebviewMessage): void {
    if (
      'turnId' in message &&
      typeof (message as { turnId?: unknown }).turnId === 'string'
    ) {
      this.currentTurnId = (message as { turnId: string }).turnId;
    }
    if (
      'sessionId' in message &&
      typeof (message as { sessionId?: unknown }).sessionId === 'string'
    ) {
      this.currentSessionId = (message as { sessionId: string }).sessionId;
    }
    this.emitter.fire(message);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
