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

import { createReadOsRelease, createVsCodeSetupHost } from './setupHost.vscode';

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

// --- T5 §1.2: createReadOsRelease — the container-boundary-aware binding -----

/** In-memory fs seam: `files` maps path -> content; anything else rejects
 *  (readFile) / resolves false (fileExists) exactly like the real adapters. */
function makeSeams(files: Record<string, string>, env: Record<string, string | undefined> = {}, platform = 'linux') {
  const readCalls: string[] = [];
  const read = createReadOsRelease({
    readFile: async (path: string) => {
      readCalls.push(path);
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    fileExists: async (path: string) => files[path] !== undefined,
    platform,
    env,
  });
  return { read, readCalls };
}

const HOST_OS_RELEASE = 'ID=fedora\nVERSION_ID=44\nPRETTY_NAME="Fedora Linux 44 (Workstation Edition)"\n';
const CONTAINER_OS_RELEASE = 'ID=freedesktop-sdk\nVERSION_ID=24.08\nPRETTY_NAME="Freedesktop SDK 24.08"\n';

describe('T5: createReadOsRelease (S-F10 container/Flatpak honesty)', () => {
  it('prefers /run/host/os-release when it exists (Flatpak/toolbox host identity) — even with markers present', async () => {
    const { read } = makeSeams(
      { '/run/host/os-release': HOST_OS_RELEASE, '/etc/os-release': CONTAINER_OS_RELEASE, '/run/.containerenv': '' },
      { container: 'podman' },
    );
    await expect(read()).resolves.toEqual({ text: HOST_OS_RELEASE });
  });

  it('falls back to /etc/os-release when no host file and no container marker', async () => {
    const { read } = makeSeams({ '/etc/os-release': HOST_OS_RELEASE });
    await expect(read()).resolves.toEqual({ text: HOST_OS_RELEASE });
  });

  it('/run/.containerenv marker + NO host file -> { containerMismatch: true } — the container /etc/os-release is NEVER reported', async () => {
    const { read, readCalls } = makeSeams({ '/etc/os-release': CONTAINER_OS_RELEASE, '/run/.containerenv': '' });
    await expect(read()).resolves.toEqual({ containerMismatch: true });
    expect(readCalls).not.toContain('/etc/os-release');
  });

  it('/.dockerenv marker + NO host file -> { containerMismatch: true }', async () => {
    const { read } = makeSeams({ '/etc/os-release': CONTAINER_OS_RELEASE, '/.dockerenv': '' });
    await expect(read()).resolves.toEqual({ containerMismatch: true });
  });

  it('$container env marker + NO host file -> { containerMismatch: true }', async () => {
    const { read } = makeSeams({ '/etc/os-release': CONTAINER_OS_RELEASE }, { container: 'flatpak' });
    await expect(read()).resolves.toEqual({ containerMismatch: true });
  });

  it('an EMPTY $container is not a marker (unset-but-exported shells) -> /etc/os-release still read', async () => {
    const { read } = makeSeams({ '/etc/os-release': HOST_OS_RELEASE }, { container: '' });
    await expect(read()).resolves.toEqual({ text: HOST_OS_RELEASE });
  });

  it('win32 -> {} without touching the filesystem (the gate runs on Windows)', async () => {
    const { read, readCalls } = makeSeams({ '/etc/os-release': HOST_OS_RELEASE }, {}, 'win32');
    await expect(read()).resolves.toEqual({});
    expect(readCalls).toEqual([]);
  });

  it('nothing readable anywhere -> {} (controller degrades to unknown)', async () => {
    const { read } = makeSeams({});
    await expect(read()).resolves.toEqual({});
  });
});
