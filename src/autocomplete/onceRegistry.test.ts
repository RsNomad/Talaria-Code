import { describe, it, expect } from 'vitest';
import { OnceRegistry } from './onceRegistry';

/**
 * FI-26 (WS-F10 task 2, FSU §5 Q4): `OnceRegistry` is the pure, vscode-free
 * dedup primitive that replaces the three module-level dedup Sets
 * (`provider.ts`, `nextedit/backend.ts`, `backendFactory.ts`) — these tests
 * pin exactly the operation set the live HEAD's three sites use: `has`/`add`
 * (every site's warn/surface-once check), `delete` (provider.ts's
 * toast-reject re-arm of a single key), and `reset` (every site's re-arm-all,
 * replacing a raw `.clear()`).
 */
describe('OnceRegistry', () => {
  it('has() is false for a key that was never added', () => {
    const registry = new OnceRegistry();
    expect(registry.has('k')).toBe(false);
  });

  it('add() then has() is true for that exact key', () => {
    const registry = new OnceRegistry();
    registry.add('k');
    expect(registry.has('k')).toBe(true);
  });

  it('add() does not affect a DIFFERENT key', () => {
    const registry = new OnceRegistry();
    registry.add('k1');
    expect(registry.has('k2')).toBe(false);
  });

  it('delete() removes exactly the named key, leaving every other recorded key untouched', () => {
    const registry = new OnceRegistry();
    registry.add('k1');
    registry.add('k2');
    registry.delete('k1');
    expect(registry.has('k1')).toBe(false);
    expect(registry.has('k2')).toBe(true);
  });

  it('delete() on a key that was never added is a harmless no-op', () => {
    const registry = new OnceRegistry();
    expect(() => registry.delete('never-added')).not.toThrow();
    expect(registry.has('never-added')).toBe(false);
  });

  it('reset() forgets every recorded key at once', () => {
    const registry = new OnceRegistry();
    registry.add('k1');
    registry.add('k2');
    registry.reset();
    expect(registry.has('k1')).toBe(false);
    expect(registry.has('k2')).toBe(false);
  });

  it('two independent instances never share state', () => {
    const a = new OnceRegistry();
    const b = new OnceRegistry();
    a.add('k');
    expect(a.has('k')).toBe(true);
    expect(b.has('k')).toBe(false);
  });
});
