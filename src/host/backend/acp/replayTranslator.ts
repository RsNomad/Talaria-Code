import type { SessionScopedMessage } from '../../../shared/protocol';
import { extractSingleBlockText } from './contentBlocks';
import { TurnTranslator } from './turnTranslator';
import type { AcpSessionUpdate } from './types';

/**
 * R-C2: the `session/load` replay window. Hermes re-streams the FULL history
 * as ordinary `session/update`s (server.py:1023-1111) — including one
 * `user_message_chunk` per historical user prompt (:1056-1062). This wrapper
 * renders those via its OWN interception (below, BEFORE delegating to the
 * live mapper), so replay rendering is independent of whatever the live
 * mapper does with `user_message_chunk`. (Since T-2/V-18 the live mapper
 * renders it too — the queued-prompt drain echo, `sessionUpdate.ts` ~:90-93 —
 * but that is a separate path; nothing here depends on it.) A replay MUST
 * render them, or the History panel shows zero user messages and adjacent
 * agent turns coalesce into one blob under a single TurnTranslator.
 *
 * This wrapper owns the replay window only (installed/uninstalled by
 * `AcpBackend.loadSession`; live turns never route through it, so its
 * replay-specific rendering never affects a live turn):
 *  - `user_message_chunk` → a `user` transcript item (`mode: 'default'` — the
 *    historical wire mode is not replayed and every preset pins default);
 *  - a user chunk arriving after this turn produced agent output closes the
 *    current synthetic turn (inner `finish()` + `turn.end{complete}`) and
 *    opens the next (`turn.start` + fresh TurnTranslator) — per-turn
 *    boundaries. Consecutive user chunks (queued prompts, server.py:1383)
 *    stack in one turn; a leading user chunk reuses the first turn.
 *  - everything else delegates to the current inner TurnTranslator unchanged.
 *
 * The caller fires the FINAL `turn.end` itself (directly, never via
 * `emitTurnEnd` — a replay must never take an after-turn snapshot, see
 * AcpBackend.loadSession) using {@link currentTurnId}; the intermediate
 * `turn.end`s emitted here are equally checkpoint-free because they bypass
 * `emitTurnEnd` entirely.
 *
 * Pure (no vscode/fs/network) per the acp/* module rule.
 */
export class ReplayTranslator {
  private translator: TurnTranslator;
  private turnId: string;
  private sawAgentContent = false;

  constructor(
    private readonly sessionId: string,
    firstTurnId: string,
    private readonly nextTurnId: () => string,
  ) {
    this.turnId = firstTurnId;
    this.translator = new TurnTranslator(firstTurnId, sessionId);
  }

  /** The id of the synthetic turn currently open — the caller's final `turn.end` carries it. */
  get currentTurnId(): string {
    return this.turnId;
  }

  apply(update: AcpSessionUpdate): SessionScopedMessage[] {
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = extractSingleBlockText(update.content);
      if (!text) return [];
      const out: SessionScopedMessage[] = [];
      if (this.sawAgentContent) {
        out.push(...this.translator.finish());
        out.push({ type: 'turn.end', turnId: this.turnId, sessionId: this.sessionId, status: 'complete' });
        this.turnId = this.nextTurnId();
        this.translator = new TurnTranslator(this.turnId, this.sessionId);
        this.sawAgentContent = false;
        out.push({ type: 'turn.start', turnId: this.turnId, sessionId: this.sessionId });
      }
      out.push({ type: 'user', turnId: this.turnId, sessionId: this.sessionId, text, mode: 'default' });
      return out;
    }

    const messages = this.translator.applyUpdate(update);
    if (messages.length > 0) this.sawAgentContent = true;
    return messages;
  }

  /** Tail of the FINAL synthetic turn (open reasoning block / message.end). */
  finish(): SessionScopedMessage[] {
    return this.translator.finish();
  }
}
