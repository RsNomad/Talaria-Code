import type { SessionScopedMessage } from '../../../shared/protocol';
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

  constructor(
    private readonly turnId: string,
    private readonly sessionId: string,
  ) {}

  /** Feed one ACP `session/update` payload; returns the protocol messages it produces. */
  applyUpdate(update: AcpSessionUpdate): SessionScopedMessage[] {
    const messages = mapSessionUpdate(update, this.turnId, this.sessionId, this.reasoning);
    for (const message of messages) {
      if (message.type === 'message.delta') this.messageBuffer += message.text;
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

  /** The full assistant text streamed so far this turn (used for `result.summary.text`). */
  get settledText(): string {
    return this.messageBuffer;
  }
}
