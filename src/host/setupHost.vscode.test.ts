/**
 * Final review wave, pre-merge defensive fix (task-9-report.md follow-up):
 * `SetupHost.secrets.has(key)`'s pinned contract (`SetupController.ts`) is
 * `Promise<boolean>` — it must NEVER reject. `SetupController.status()`
 * calls it unguarded (`await this.host.secrets.has(AUTOCOMPLETE_API_KEY_SECRET)`)
 * — the ONLY unguarded external `await` on `status()`'s cold-assert path
 * (the Ollama probe is already `safeProbeOllama`-wrapped; pipx is never
 * re-probed by `status()`; everything else there is synchronous settings/
 * globalState reads).
 *
 * Before this fix, `createVsCodeSetupHost`'s `secrets.has` was a bare
 * `(await context.secrets.get(key)) !== undefined` — a rejecting
 * `context.secrets.get` (a real failure mode on a keychain-less Linux CI
 * runner, e.g. the `@vscode/test-electron` headless host the Task 6/7
 * integration smoke runs under) propagated straight out of `has()`, through
 * `status()`, and into the panel fetch as `ok:false` — an environment
 * failure masquerading as a real regression. It is also just correct
 * defensive behaviour on its own: rendering the Setup panel must not
 * hard-fail on a keychain hiccup.
 *
 * Narrow `vi.mock('vscode', ...)`, same discipline as `apiKey.test.ts` /
 * `gitPort.test.ts` — only `secrets.has`'s own closure is exercised here, so
 * the mock factory needs no members at all (every other `createVsCodeSetupHost`
 * closure that touches `vscode.*` directly is untouched by this file).
 */
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({}));

import { createVsCodeSetupHost } from './setupHost.vscode';

function makeFakeContext(secretsGet: (key: string) => Promise<string | undefined>): vscode.ExtensionContext {
  return {
    secrets: {
      get: secretsGet,
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
    },
  } as unknown as vscode.ExtensionContext;
}

describe('createVsCodeSetupHost().secrets.has — total, never rejects', () => {
  it('resolves false (not a rejection) when context.secrets.get rejects, e.g. a keychain-less CI runner', async () => {
    const ctx = makeFakeContext(() => Promise.reject(new Error('keychain unavailable')));
    const host = createVsCodeSetupHost(ctx);

    await expect(host.secrets.has('talaria.autocomplete.apiKey')).resolves.toBe(false);
  });

  it('non-regression: still resolves true/false correctly on the happy path', async () => {
    const ctx = makeFakeContext((key) => Promise.resolve(key === 'present-key' ? 'value' : undefined));
    const host = createVsCodeSetupHost(ctx);

    await expect(host.secrets.has('present-key')).resolves.toBe(true);
    await expect(host.secrets.has('missing-key')).resolves.toBe(false);
  });
});
