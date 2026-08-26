import type { SessionScopedMessage, ToolStatus } from '../../../shared/protocol';
import { createReasoningState, mapSessionUpdate } from './sessionUpdate';
import type { ReasoningState } from './sessionUpdate';
import type { AcpSessionUpdate } from './types';

/**
 * Per-turn wrapper around {@link mapSessionUpdate}: owns the reasoning-block
 * state for one turn and accumulates the settled message text so a single
 * `message.end` can be emitted once the turn's `session/prompt` call resolves
 * (see {@link finish} — "end of ACP `agent_message_chunk` stream" per
 * `protocol.ts`'s `message.end` JSDoc). Framework-free (no `vscode`, no
 * network) so it is directly unit-testable; {@link ../AcpBackend} is the only
 * caller.
 */
export class TurnTranslator {
  private readonly reasoning: ReasoningState = createReasoningState();
  private messageBuffer = '';

  /** WS-SL preemptive tool-cancel: each tool's LAST surfaced protocol status
   *  (tracked from the mapped `tool.start`/`tool.update` messages, so it is
   *  exactly what the webview has seen). Read only by
   *  {@link markInFlightToolsInterrupted}. */
  private readonly toolStatuses = new Map<string, ToolStatus>();

  constructor(
    private readonly turnId: string,
    private readonly sessionId: string,
  ) {}

  /** Feed one ACP `session/update` payload; returns the protocol messages it produces. */
  applyUpdate(update: AcpSessionUpdate): SessionScopedMessage[] {
    const messages = mapSessionUpdate(update, this.turnId, this.sessionId, this.reasoning);
    for (const message of messages) {
      if (message.type === 'message.delta') this.messageBuffer += message.text;
      else if (message.type === 'tool.start') this.toolStatuses.set(message.toolId, message.status);
      else if (message.type === 'tool.update' && message.status !== undefined) {
        this.toolStatuses.set(message.toolId, message.status);
      }
    }
    return messages;
  }

  /**
   * Call once the underlying `session/prompt` request resolves (the turn is
   * fully over). Closes any still-open reasoning block (defensive — a well
   * behaved agent should not leave one dangling) and emits the final
   * `message.end` if any assistant text was streamed.
   */
  finish(): SessionScopedMessage[] {
    const out: SessionScopedMessage[] = [];
    if (this.reasoning.blockId) {
      out.push({ type: 'reasoning.end', turnId: this.turnId, sessionId: this.sessionId, blockId: this.reasoning.blockId });
      this.reasoning.blockId = undefined;
    }
    if (this.messageBuffer) {
      out.push({ type: 'message.end', turnId: this.turnId, sessionId: this.sessionId, text: this.messageBuffer });
    }
    return out;
  }

  /**
   * WS-SL (WV1-MIN-ARCH preemptive tool-cancel, ACP SHOULD): mark every tool
   * whose last surfaced status is still in flight (`pending`/`running`) as
   * `interrupted`, returning one `tool.update` per flip for the caller to
   * emit. DISPLAY-ONLY — nothing goes on the ACP wire; a belated genuine
   * `tool_call_update` from the harness still flows through {@link
   * applyUpdate} unchanged and overwrites the marking (honest: the harness
   * kept running until it acknowledged the stop). Idempotent: flipped tools
   * are recorded as `interrupted`, so a second call returns `[]`.
   */
  markInFlightToolsInterrupted(): SessionScopedMessage[] {
    const out: SessionScopedMessage[] = [];
    for (const [toolId, status] of this.toolStatuses) {
      if (status === 'pending' || status === 'running') {
        this.toolStatuses.set(toolId, 'interrupted');
        out.push({ type: 'tool.update', turnId: this.turnId, sessionId: this.sessionId, toolId, status: 'interrupted' });
      }
    }
    return out;
  }

  /** The full assistant text streamed so far this turn (used for `result.summary.text`). */
  get settledText(): string {
    return this.messageBuffer;
  }
}
