import * as vscode from 'vscode';
import type {
  HostToWebview,
  HostToWebviewMessage,
  AgentMode,
  Attachment,
  ContextRef,
  DiffAction,
  DataPanel,
  GlobalPanel,
  PanelDataMap,
} from '../../shared/protocol';
import { makePanelData } from '../../shared/protocol';
import { mockScenario } from '../../shared/mockScenario';
import type { MockScenario, MockStep } from '../../shared/mockScenario';
import { AgentBackend } from './AgentBackend';

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
 * The DEFAULT backend. Replays a canned coding turn so the whole extension runs
 * on any OS with **no Hermes process and no network** (pinned decision #4).
 *
 * It consumes `mockScenario` (authored by Agent D in `src/shared/mockScenario`)
 * and streams the timeline out through {@link onMessage} on realistic
 * `setTimeout` delays, producing the exact sequence the real backend will:
 *
 *   turn.start → user → reasoning.start/delta/end → message.delta/end →
 *   tool.start/update → tool.diff → approval.request → plan.update →
 *   result.summary → turn.end
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

  private readonly emitter = new vscode.EventEmitter<HostToWebviewMessage>();
  readonly onMessage = this.emitter.event;

  private readonly scenario: MockScenario = mockScenario;

  /** Playback cursor into `scenario.timeline`. */
  private cursor = 0;
  /** Timer for the next scheduled step (so `cancel`/`dispose` can clear it). */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** What kind of user response the parked player is waiting for, if any. */
  private gate: 'approval' | 'diff' | undefined;
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

  respondApproval(_sessionId: string, id: string, optionId: string): void {
    void id;
    void optionId;
    // A `deny` could branch the mock; for the skeleton any response resumes.
    if (this.gate === 'approval') {
      this.gate = undefined;
      this.advance();
    }
  }

  resolveDiff(_sessionId: string, toolId: string, hunkIndex: number, action: DiffAction): void {
    void toolId;
    void hunkIndex;
    void action;
    if (this.gate === 'diff') {
      this.gate = undefined;
      this.advance();
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
    // Unknown control method: ack so the UI doesn't hang awaiting a reply.
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
    if (panel === 'tools' || panel === 'mcp' || panel === 'skills' || panel === 'models' || panel === 'settings') {
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
    this.playing = false;
  }

  private advance(): void {
    this.cursor++;
    this.scheduleNext();
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
