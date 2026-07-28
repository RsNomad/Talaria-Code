import type { SessionScopedMessage } from '../../../shared/protocol';
import { extractDiffs, extractSingleBlockText, extractToolCallOutputText, previewRawInput } from './contentBlocks';
import { mapPlanEntry, mapToolKind, mapToolStatus } from './toolKind';
import type { AcpSessionUpdate, AcpToolCallFields } from './types';

/**
 * Mutable per-turn reasoning-block bookkeeping. `agent_thought_chunk` does not
 * carry a block id on the wire (confirmed against the current TS SDK's
 * `SessionNotification` type — no `messageId`/blockId field on the thought
 * variant), so start/end boundaries are DERIVED, exactly as spec'd in
 * `protocol.ts`'s `reasoning.end` JSDoc: "derived from the first non-thought
 * chunk after thoughts". Owned by {@link ../TurnTranslator}.
 */
export interface ReasoningState {
  blockId: string | undefined;
  counter: number;
}

export function createReasoningState(): ReasoningState {
  return { blockId: undefined, counter: 0 };
}

/**
 * Translate one ACP `session/update` payload into zero or more protocol
 * messages for a single turn. Pure: given the same `update` and the same
 * `reasoning` state going in, it always emits the same messages and leaves
 * `reasoning` in the same resulting state — the only "state" is the bit the
 * caller explicitly owns and passes in.
 *
 * Message-run boundaries (`message.end`) are intentionally NOT derived here —
 * unlike reasoning, Hermes' assistant prose legitimately interleaves with tool
 * calls within one logical turn answer (mirrors the mock scenario: message
 * deltas both before AND after the patch/test tool calls, one `message.end` at
 * the very end). That accumulation is the caller's job
 * ({@link ../TurnTranslator}); this function only ever emits `message.delta`.
 */
export function mapSessionUpdate(
  update: AcpSessionUpdate,
  turnId: string,
  sessionId: string,
  reasoning: ReasoningState,
): SessionScopedMessage[] {
  if (update.sessionUpdate === 'agent_thought_chunk') {
    const text = extractSingleBlockText(update.content);
    if (!text) return [];
    const messages: SessionScopedMessage[] = [];
    if (!reasoning.blockId) {
      reasoning.counter += 1;
      reasoning.blockId = `think-${turnId}-${reasoning.counter}`;
      messages.push({ type: 'reasoning.start', turnId, sessionId, blockId: reasoning.blockId });
    }
    messages.push({ type: 'reasoning.delta', turnId, sessionId, blockId: reasoning.blockId, text });
    return messages;
  }

  // Any non-thought update closes an in-flight reasoning block.
  const closeMessages = closeReasoning(turnId, sessionId, reasoning);

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractSingleBlockText(update.content);
      return text ? [...closeMessages, { type: 'message.delta', turnId, sessionId, text }] : closeMessages;
    }
    case 'tool_call':
      return [...closeMessages, ...buildToolStartMessages(update, turnId, sessionId)];
    case 'tool_call_update':
      return [...closeMessages, ...buildToolUpdateMessages(update, turnId, sessionId)];
    case 'plan':
      return [
        ...closeMessages,
        { type: 'plan.update', turnId, sessionId, items: update.entries.map(mapPlanEntry) },
      ];
    // V-18 (Tier-2 remediation architecture §2.2 — drain rendering): a LIVE
    // `user_message_chunk` has exactly ONE emitter left in the whole harness
    // once `/steer`/`/queue` are admitted mid-turn — `server.py`'s queued-
    // prompt DRAIN (`prompt()` recursively running `state.queued_prompts`
    // once the live turn's body finishes, emitting `update_user_message_text`
    // before each drained prompt, :1656-1659 — the SAME outstanding
    // `session/prompt` the client is still awaiting). The previous belief
    // here ("it's just an echo of what `sendPrompt` already emitted") was
    // only ever true for the FIRST prompt of a turn chain, which never
    // reaches the wire as a `user_message_chunk` at all — only a DRAINED
    // continuation does. Rendering it as a `user` item stops a drained turn
    // from streaming headless (no user bubble at all). `SessionController`'s
    // `runControlUtterance` is the ONLY other source of a live `user` item
    // during a live turn, and it emits directly (never through this mapper),
    // so there is no double-render: the utterance's own admission echo and
    // this drain echo are two DIFFERENT prompts (the utterance text vs. the
    // NEXT queued prompt the harness starts running).
    case 'user_message_chunk': {
      const text = extractSingleBlockText(update.content);
      return text ? [...closeMessages, { type: 'user', turnId, sessionId, text, mode: 'default' }] : closeMessages;
    }
    // `available_commands_update` / `current_mode_update` / `usage_update` /
    // `session_info_update` have no row in the wave-1 mapping table, so they
    // map to no UI message.
    //
    // `usage_update` and `session_info_update` DO now arrive for real (SDK
    // 0.17.1, audit A-1 — see `types.ts`'s `AcpSessionUpdate`). Under the
    // predecessor SDK a prior audit's executed probe found neither was ever
    // accepted onto the wire, so the previous wording here ("received and
    // ignored") was false — nothing was ever received to ignore. Still
    // deliberately unmapped here: a context-window/session-title indicator
    // is a UI decision nobody has taken. The types now include every field
    // both SDK members declare, including `_meta` — session_info_update's
    // carries Hermes' `_meta.hermes.sessionProvenance` (see `types.ts`), the
    // signal tracked open item R9 needs — so a future consumer can read the
    // real field names directly off `AcpSessionUpdate` instead of
    // reverse-engineering them from the wire.
    default:
      return closeMessages;
  }
}

function closeReasoning(turnId: string, sessionId: string, reasoning: ReasoningState): SessionScopedMessage[] {
  if (!reasoning.blockId) return [];
  const blockId = reasoning.blockId;
  reasoning.blockId = undefined;
  return [{ type: 'reasoning.end', turnId, sessionId, blockId }];
}

function buildToolStartMessages(
  update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>,
  turnId: string,
  sessionId: string,
): SessionScopedMessage[] {
  const start: SessionScopedMessage = {
    type: 'tool.start',
    turnId,
    sessionId,
    toolId: update.toolCallId,
    kind: mapToolKind(update.kind),
    title: update.title,
    status: mapToolStatus(update.status),
    rawInput: previewRawInput(update.rawInput),
  };
  return [start, ...buildDiffMessages(update, turnId, sessionId)];
}

function buildToolUpdateMessages(
  update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  turnId: string,
  sessionId: string,
): SessionScopedMessage[] {
  const output = extractToolCallOutputText(update.content) || undefined;
  const updateMessage: SessionScopedMessage = {
    type: 'tool.update',
    turnId,
    sessionId,
    toolId: update.toolCallId,
    status: update.status ? mapToolStatus(update.status) : undefined,
    output,
  };
  return [updateMessage, ...buildDiffMessages(update, turnId, sessionId)];
}

function buildDiffMessages(update: AcpToolCallFields, turnId: string, sessionId: string): SessionScopedMessage[] {
  return extractDiffs(update.content).map((diff) => ({
    type: 'tool.diff' as const,
    turnId,
    sessionId,
    toolId: update.toolCallId,
    path: diff.path,
    hunks: diff.hunks,
  }));
}
