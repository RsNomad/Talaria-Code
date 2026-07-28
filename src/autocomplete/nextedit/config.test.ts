import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = new Map<string, unknown>();
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, dflt: T): T =>
        (settings.has(`${section}.${key}`) ? (settings.get(`${section}.${key}`) as T) : dflt),
    }),
  },
}));
import { readNextEditConfig } from './config';

describe('readNextEditConfig', () => {
  beforeEach(() => settings.clear());

  it('defaults: ollama transport, empty endpoint/model — DATA ONLY, no toggle keys exist here', () => {
    expect(readNextEditConfig()).toEqual({ backend: 'ollama', endpoint: '', model: '' });
  });

  it('an unknown backend id falls back to ollama (mirrors readConfig backend validation)', () => {
    settings.set('talaria.nextEdit.backend', 'grpc');
    expect(readNextEditConfig().backend).toBe('ollama');
  });

  it('a stray talaria.nextEdit.enabled/generic in settings.json is IGNORED — shape pin; the load-bearing R5 lock is provider.test.ts (package.json scope/absence)', () => {
    settings.set('talaria.nextEdit.enabled', true);
    settings.set('talaria.nextEdit.generic', true);
    // Honesty note (T1 review minor, assessment R-4): this assertion is
    // tautological BY CONSTRUCTION — readNextEditConfig builds exactly
    // {backend, endpoint, model}, so `enabled`/`generic` can never appear
    // regardless of what settings hold. It stays as a cheap shape-drift
    // tripwire only. The ENFORCEMENT that toggles are not settings is
    // provider.test.ts's "R5: the toggles are NOT settings" test against
    // the real package.json.
    const cfg = readNextEditConfig() as unknown as Record<string, unknown>;
    expect(cfg.enabled).toBeUndefined();
    expect(cfg.generic).toBeUndefined();
  });
});
