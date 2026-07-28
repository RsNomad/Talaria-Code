import { describe, it, expect, vi } from 'vitest';
import { EditPreviewRegistry } from './EditPreviewRegistry';

describe('EditPreviewRegistry — W2 T4 F-D: pure ask-path-scoped preview store', () => {
  it('set/getFile round-trips the raw texts for a known (sessionId, toolId, path)', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'src/a.ts', oldText: 'old', newText: 'new' }]);

    expect(registry.getFile('s1', 'tool-1', 'src/a.ts')).toEqual({ oldText: 'old', newText: 'new' });
  });

  it('getFile treats a brand-new file (oldText null/undefined) faithfully — no coercion to empty string', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'src/new.ts', oldText: null, newText: 'fresh' }]);

    expect(registry.getFile('s1', 'tool-1', 'src/new.ts')).toEqual({ oldText: null, newText: 'fresh' });
  });

  it('a miss on an unknown toolId returns undefined (SECURITY: never a file read fallback)', () => {
    const registry = new EditPreviewRegistry();
    expect(registry.getFile('s1', 'never-registered', 'src/a.ts')).toBeUndefined();
  });

  it('a miss on a known toolId but wrong path returns undefined', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'src/a.ts', oldText: 'old', newText: 'new' }]);

    expect(registry.getFile('s1', 'tool-1', 'src/other.ts')).toBeUndefined();
  });

  it('supports multiple files under one (sessionId, toolId) (multi-file edit)', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [
      { path: 'a.ts', oldText: 'a-old', newText: 'a-new' },
      { path: 'b.ts', oldText: 'b-old', newText: 'b-new' },
    ]);

    expect(registry.getFile('s1', 'tool-1', 'a.ts')).toEqual({ oldText: 'a-old', newText: 'a-new' });
    expect(registry.getFile('s1', 'tool-1', 'b.ts')).toEqual({ oldText: 'b-old', newText: 'b-new' });
  });

  it('delete removes the entry — a subsequent getFile is a miss (registry cannot outlive its approval)', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
    registry.delete('s1', 'tool-1');

    expect(registry.getFile('s1', 'tool-1', 'a.ts')).toBeUndefined();
  });

  it('delete on an unknown (sessionId, toolId) is a harmless no-op', () => {
    const registry = new EditPreviewRegistry();
    expect(() => registry.delete('s1', 'never-registered')).not.toThrow();
  });

  it('clear removes every entry', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
    registry.set('s1', 'tool-2', 'appr-2', [{ path: 'b.ts', oldText: 'old', newText: 'new' }]);
    registry.clear();

    expect(registry.getFile('s1', 'tool-1', 'a.ts')).toBeUndefined();
    expect(registry.getFile('s1', 'tool-2', 'b.ts')).toBeUndefined();
  });

  it('a later set for the same (sessionId, toolId) REPLACES the prior entry wholesale (no stale-file leakage)', () => {
    const registry = new EditPreviewRegistry();
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
    registry.set('s1', 'tool-1', 'appr-1', [{ path: 'b.ts', oldText: 'old2', newText: 'new2' }]);

    expect(registry.getFile('s1', 'tool-1', 'a.ts')).toBeUndefined();
    expect(registry.getFile('s1', 'tool-1', 'b.ts')).toEqual({ oldText: 'old2', newText: 'new2' });
  });

  describe('W4-T3b (T1b carry — Q-9/R7): keyed (sessionId, toolCallId), not toolCallId alone', () => {
    it('the SAME toolId under TWO DIFFERENT sessions never cross-wires — each resolves its own file', () => {
      const registry = new EditPreviewRegistry();
      registry.set('session-A', 'tool-1', 'appr-A', [{ path: 'a.ts', oldText: 'A-old', newText: 'A-new' }]);
      registry.set('session-B', 'tool-1', 'appr-B', [{ path: 'b.ts', oldText: 'B-old', newText: 'B-new' }]);

      expect(registry.getFile('session-A', 'tool-1', 'a.ts')).toEqual({ oldText: 'A-old', newText: 'A-new' });
      expect(registry.getFile('session-B', 'tool-1', 'b.ts')).toEqual({ oldText: 'B-old', newText: 'B-new' });
      // Cross-session lookups are honest misses, never the OTHER session's file.
      expect(registry.getFile('session-A', 'tool-1', 'b.ts')).toBeUndefined();
      expect(registry.getFile('session-B', 'tool-1', 'a.ts')).toBeUndefined();
    });

    it('deleting one session\'s (sessionId, toolId) entry leaves an identically-toolId\'d entry in another session untouched', () => {
      const registry = new EditPreviewRegistry();
      registry.set('session-A', 'tool-1', 'appr-A', [{ path: 'a.ts', oldText: 'A-old', newText: 'A-new' }]);
      registry.set('session-B', 'tool-1', 'appr-B', [{ path: 'b.ts', oldText: 'B-old', newText: 'B-new' }]);

      registry.delete('session-A', 'tool-1');

      expect(registry.getFile('session-A', 'tool-1', 'a.ts')).toBeUndefined();
      expect(registry.getFile('session-B', 'tool-1', 'b.ts')).toEqual({ oldText: 'B-old', newText: 'B-new' });
    });
  });

  describe('onChange — change-notification (vscode-free; DiffPreviewProvider bridges it)', () => {
    it('fires on set', () => {
      const registry = new EditPreviewRegistry();
      const listener = vi.fn();
      registry.onChange(listener);

      registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires on delete of an existing entry, but NOT on a no-op delete', () => {
      const registry = new EditPreviewRegistry();
      registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
      const listener = vi.fn();
      registry.onChange(listener);

      registry.delete('s1', 'never-registered');
      expect(listener).not.toHaveBeenCalled();

      registry.delete('s1', 'tool-1');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires on clear only when there was something to clear', () => {
      const registry = new EditPreviewRegistry();
      const listener = vi.fn();
      registry.onChange(listener);

      registry.clear(); // nothing registered yet
      expect(listener).not.toHaveBeenCalled();

      registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
      registry.clear();
      expect(listener).toHaveBeenCalledTimes(2); // once for set, once for clear
    });

    it('dispose() unsubscribes the listener', () => {
      const registry = new EditPreviewRegistry();
      const listener = vi.fn();
      const sub = registry.onChange(listener);
      sub.dispose();

      registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple independent listeners', () => {
      const registry = new EditPreviewRegistry();
      const a = vi.fn();
      const b = vi.fn();
      registry.onChange(a);
      registry.onChange(b);

      registry.set('s1', 'tool-1', 'appr-1', [{ path: 'a.ts', oldText: 'old', newText: 'new' }]);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });
});
