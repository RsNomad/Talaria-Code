import { describe, it, expect } from 'vitest';
import { parseGatewayEvent, isGatewayReady } from './eventDemux';

describe('parseGatewayEvent', () => {
  it('parses the gateway.ready startup handshake (entry.py:349 shape)', () => {
    const frame = parseGatewayEvent('event', {
      type: 'gateway.ready',
      payload: { skin: 'default' },
    });
    expect(frame).toEqual({
      type: 'gateway.ready',
      sessionId: undefined,
      payload: { skin: 'default' },
    });
  });

  it('parses a session-scoped event carrying session_id', () => {
    const frame = parseGatewayEvent('event', {
      type: 'message.delta',
      session_id: 'sess-1',
      payload: { text: 'hi' },
    });
    expect(frame).toEqual({
      type: 'message.delta',
      sessionId: 'sess-1',
      payload: { text: 'hi' },
    });
  });

  it('ignores notifications whose outer method is not "event"', () => {
    expect(parseGatewayEvent('somethingElse', { type: 'x' })).toBeUndefined();
  });

  it('ignores frames with a missing type', () => {
    expect(parseGatewayEvent('event', { payload: {} })).toBeUndefined();
  });

  it('ignores frames with a non-string type', () => {
    expect(parseGatewayEvent('event', { type: 42, payload: {} })).toBeUndefined();
  });

  it('ignores non-object / nullish params', () => {
    expect(parseGatewayEvent('event', 'not-an-object')).toBeUndefined();
    expect(parseGatewayEvent('event', null)).toBeUndefined();
    expect(parseGatewayEvent('event', undefined)).toBeUndefined();
  });
});

describe('isGatewayReady', () => {
  it('is true only for a gateway.ready frame', () => {
    expect(
      isGatewayReady(parseGatewayEvent('event', { type: 'gateway.ready', payload: {} })),
    ).toBe(true);
    expect(
      isGatewayReady(parseGatewayEvent('event', { type: 'message.delta', payload: {} })),
    ).toBe(false);
    expect(isGatewayReady(undefined)).toBe(false);
  });
});
