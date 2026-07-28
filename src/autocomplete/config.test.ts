import { describe, it, expect, vi } from 'vitest';

/**
 * `config.ts` also exports the vscode-backed `readConfig()`, so the module as
 * a whole has a top-level `import * as vscode from 'vscode'` — unresolvable
 * outside the extension host (see `provider.test.ts`'s identical note). This
 * test only exercises the pure `effectivePrefixInjection` export, so a
 * minimal stub is enough; `readConfig()` itself is exercised only inside a
 * real VS Code host, not here.
 */
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { effectivePrefixInjection } from './config';

/**
 * §4.5 / B5 — the LOOPBACK gate. `crossFile.prefixInjection` alone must
 * never silently authorize workspace-snippet egress to whatever REMOTE
 * endpoint a comment-inject backend (Ollama/Codestral/openai-compat) is
 * later pointed at.
 */
describe('effectivePrefixInjection', () => {
  it('is true when prefixInjection is on and the endpoint is loopback', () => {
    const result = effectivePrefixInjection(
      { prefixInjection: true, prefixInjectionRemote: false },
      /* endpointIsLoopback */ true,
    );
    expect(result).toBe(true);
  });

  it('is false when prefixInjection is on but the endpoint is remote and there is no override', () => {
    const result = effectivePrefixInjection(
      { prefixInjection: true, prefixInjectionRemote: false },
      /* endpointIsLoopback */ false,
    );
    expect(result).toBe(false);
  });

  it('is true when prefixInjection is on, the endpoint is remote, AND the explicit override is set', () => {
    const result = effectivePrefixInjection(
      { prefixInjection: true, prefixInjectionRemote: true },
      /* endpointIsLoopback */ false,
    );
    expect(result).toBe(true);
  });

  it('is false when prefixInjection itself is off, regardless of loopback or the override', () => {
    expect(
      effectivePrefixInjection({ prefixInjection: false, prefixInjectionRemote: true }, true),
    ).toBe(false);
    expect(
      effectivePrefixInjection({ prefixInjection: false, prefixInjectionRemote: true }, false),
    ).toBe(false);
  });

  it('the remote override alone (without prefixInjection) does not enable anything', () => {
    const result = effectivePrefixInjection(
      { prefixInjection: false, prefixInjectionRemote: false },
      false,
    );
    expect(result).toBe(false);
  });

  it('a loopback endpoint does not need the remote override', () => {
    const result = effectivePrefixInjection(
      { prefixInjection: true, prefixInjectionRemote: false },
      true,
    );
    expect(result).toBe(true);
  });
});
