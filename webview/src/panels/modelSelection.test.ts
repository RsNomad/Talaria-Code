/*
 * RED-first: UI-I2a. ModelsPanel used to read the active model ONLY from the
 * panel's own payload (`data.currentModelId`) — but a model pick already
 * updates the composer chip OPTIMISTICALLY via `local.setModel` onto
 * `tab.currentModelId` (P7-N2N5's `useHostActions.setModel`), and nothing
 * re-pushes `panel.data:models` to correct the payload afterwards
 * (`MockBackend.ts` treats `setModel` as the unhandled `default` case). The
 * panel's own header/highlight stayed on the OLD model while the chip moved
 * on — this is the selector both now read from, so they can't disagree.
 */
import { describe, it, expect } from 'vitest';
import { resolveEffectiveModelId } from './modelSelection';

describe('resolveEffectiveModelId (UI-I2a)', () => {
  it('prefers the tab\'s optimistic pick over the stale panel payload', () => {
    expect(resolveEffectiveModelId('claude-3', 'gpt-4')).toBe('claude-3');
  });

  it('falls back to the panel payload when the tab has never picked a model (null)', () => {
    expect(resolveEffectiveModelId(null, 'gpt-4')).toBe('gpt-4');
  });

  it('is behavior-preserving when the tab and payload already agree (the confirmed case)', () => {
    expect(resolveEffectiveModelId('gpt-4', 'gpt-4')).toBe('gpt-4');
  });
});
