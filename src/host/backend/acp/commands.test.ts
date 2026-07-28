import { describe, it, expect } from 'vitest';
import { mapAvailableCommands } from './commands';

/**
 * W2 F-S (§2e/§3.2): `available_commands_update`'s payload shape is UNPINNED
 * until Fedora (P3) — {@link mapAvailableCommands} must read every entry
 * DEFENSIVELY: drop anything failing a shape guard, never throw.
 */
describe('mapAvailableCommands (W2 F-S defensive mapper)', () => {
  it('maps a well-formed entry straight through', () => {
    expect(
      mapAvailableCommands([{ name: 'help', description: 'Show help' }]),
    ).toEqual([{ name: 'help', description: 'Show help' }]);
  });

  it('carries input.hint as inputHint when present and a string', () => {
    expect(
      mapAvailableCommands([
        { name: 'model', description: 'Switch model', input: { hint: '<name>' } },
      ]),
    ).toEqual([{ name: 'model', description: 'Switch model', inputHint: '<name>' }]);
  });

  it('omits inputHint when input is absent, null, or has no hint', () => {
    expect(
      mapAvailableCommands([
        { name: 'a', description: 'd1' },
        { name: 'b', description: 'd2', input: null },
        { name: 'c', description: 'd3', input: {} },
      ]),
    ).toEqual([
      { name: 'a', description: 'd1' },
      { name: 'b', description: 'd2' },
      { name: 'c', description: 'd3' },
    ]);
  });

  it('drops entries missing a name', () => {
    expect(mapAvailableCommands([{ description: 'no name' }])).toEqual([]);
  });

  it('drops entries whose name is not a string', () => {
    expect(mapAvailableCommands([{ name: 42, description: 'bad name' }])).toEqual([]);
  });

  it('drops entries whose name is blank/whitespace-only', () => {
    expect(mapAvailableCommands([{ name: '   ', description: 'blank' }])).toEqual([]);
  });

  it('trims a padded name so it cannot dodge the client-template collision match', () => {
    expect(mapAvailableCommands([{ name: '  help  ', description: 'x' }])).toEqual([
      { name: 'help', description: 'x' },
    ]);
  });

  it('drops entries missing a description', () => {
    expect(mapAvailableCommands([{ name: 'help' }])).toEqual([]);
  });

  it('drops entries whose description is not a string', () => {
    expect(mapAvailableCommands([{ name: 'help', description: 123 }])).toEqual([]);
  });

  it('drops non-object entries (null, primitives, arrays) without throwing', () => {
    expect(() =>
      mapAvailableCommands([null, undefined, 42, 'x', true, [], { name: 'ok', description: 'fine' }]),
    ).not.toThrow();
    expect(
      mapAvailableCommands([null, undefined, 42, 'x', true, [], { name: 'ok', description: 'fine' }]),
    ).toEqual([{ name: 'ok', description: 'fine' }]);
  });

  it('keeps the good entries and drops only the malformed ones from a mixed array', () => {
    expect(
      mapAvailableCommands([
        { name: 'help', description: 'Show help' },
        { name: 123, description: 'bad' },
        { name: 'model', description: 'Switch model', input: { hint: '<name>' } },
        null,
        { description: 'missing name' },
      ]),
    ).toEqual([
      { name: 'help', description: 'Show help' },
      { name: 'model', description: 'Switch model', inputHint: '<name>' },
    ]);
  });

  it('returns [] for a non-array payload without throwing (never crashes handleSessionUpdate)', () => {
    expect(mapAvailableCommands(undefined)).toEqual([]);
    expect(mapAvailableCommands(null)).toEqual([]);
    expect(mapAvailableCommands('not an array')).toEqual([]);
    expect(mapAvailableCommands({ not: 'an array' })).toEqual([]);
  });

  it('returns [] for an empty array', () => {
    expect(mapAvailableCommands([])).toEqual([]);
  });
});
