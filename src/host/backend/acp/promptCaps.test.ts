import { describe, it, expect } from 'vitest';
import { derivePromptCaps } from './promptCaps';

/**
 * A-03 (WS-AC): the SHIP-INACTIVE pin. Every advertisement — including one
 * that omits `embeddedContext` entirely — derives to the inactive decision
 * until the activation contract in `promptCaps.ts` is met. Flipping any of
 * these rows is the activation event and requires that contract's evidence.
 */
describe('derivePromptCaps — ship-inactive pin (WS-AC A-03)', () => {
  it.each([
    [undefined],
    [{}],
    [{ image: true }], // pinned Hermes, acp_adapter/server.py:889
    [{ image: true, embeddedContext: false }],
    [{ embeddedContext: true }],
  ])('returns the inactive decision for advertised=%j', (advertised) => {
    expect(derivePromptCaps(advertised as Record<string, unknown> | undefined)).toEqual({
      degradeEmbeddedResources: false,
    });
  });
});
