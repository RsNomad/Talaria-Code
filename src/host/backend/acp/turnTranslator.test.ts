import { describe, it, expect } from 'vitest';
import { TurnTranslator } from './turnTranslator';

const SESSION = 'sess-1';

describe('TurnTranslator', () => {
  it('accumulates message deltas across interleaved tool calls and settles them on finish()', () => {
    const turn = new TurnTranslator('turn-1', SESSION);
    turn.applyUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found it. ' } });
    turn.applyUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'patch: a.ts', kind: 'edit' });
    turn.applyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
    });
    turn.applyUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });

    expect(turn.settledText).toBe('Found it. Done.');
    expect(turn.finish()).toEqual([
      { type: 'message.end', turnId: 'turn-1', sessionId: SESSION, text: 'Found it. Done.' },
    ]);
  });

  it('emits nothing on finish() when no message text was streamed', () => {
    const turn = new TurnTranslator('turn-2', SESSION);
    turn.applyUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read: a.ts', kind: 'read' });
    expect(turn.finish()).toEqual([]);
  });

  it('closes a dangling reasoning block on finish() as a defensive measure', () => {
    const turn = new TurnTranslator('turn-3', SESSION);
    turn.applyUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    expect(turn.finish()).toEqual([
      { type: 'reasoning.end', turnId: 'turn-3', sessionId: SESSION, blockId: 'think-turn-3-1' },
    ]);
  });

  it('closes reasoning AND settles the message when both are open at finish()', () => {
    const turn = new TurnTranslator('turn-4', SESSION);
    turn.applyUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
    // Re-open reasoning after message text (edge case, still handled).
    turn.applyUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'still going' } });
    expect(turn.finish()).toEqual([
      { type: 'reasoning.end', turnId: 'turn-4', sessionId: SESSION, blockId: 'think-turn-4-1' },
      { type: 'message.end', turnId: 'turn-4', sessionId: SESSION, text: 'partial' },
    ]);
  });
});
