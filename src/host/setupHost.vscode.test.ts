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
import { mkdtemp, writeFile as fsWriteFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecLookup } from './runtime/resolveHermes';

vi.mock('vscode', () => ({}));

import {
  createLocateLlamaServer,
  createModelStoreLstatIo,
  createModelStorePresenceIo,
  createReadOsRelease,
  createSetupControllerDeps,
  createVsCodeSetupHost,
} from './setupHost.vscode';

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

// --- T6 (beta.6): createLocateLlamaServer — the win32 gate --------------------

describe("T6: createLocateLlamaServer — win32 ⇒ probe-timeout (wire 'unknown'), NO probe ever spawns", () => {
  it('win32: resolves probe-timeout without ever calling exec', async () => {
    let execCalls = 0;
    const exec: ExecLookup = async () => {
      execCalls++;
      return '';
    };
    const locate = createLocateLlamaServer(exec, 'win32');

    const result = await locate();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('probe-timeout');
    expect(execCalls).toBe(0);
  });

  it('linux: delegates to the real locator over the injected exec (a clean miss reads not-found)', async () => {
    let execCalls = 0;
    const exec: ExecLookup = async () => {
      execCalls++;
      throw new Error('command failed with exit code 127');
    };
    const locate = createLocateLlamaServer(exec, 'linux');

    const result = await locate();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');
    expect(execCalls).toBeGreaterThan(0);
  });

  it('linux: the caller signal is threaded through (pre-aborted ⇒ AbortError before any exec)', async () => {
    let execCalls = 0;
    const exec: ExecLookup = async () => {
      execCalls++;
      return '';
    };
    const locate = createLocateLlamaServer(exec, 'linux');
    const abort = new AbortController();
    abort.abort();

    await expect(locate(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(execCalls).toBe(0);
  });
});

// --- T6 (beta.6, T4→T6 SC-A-3): the modelStore fs bindings --------------------

describe('T6: createModelStoreLstatIo — fs.promises.LSTAT with only-ENOENT→null', () => {
  it('real fs: missing → null; a real dir → non-symlink; a symlink/junction REPORTS as one (lstat, never stat)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talaria-t6-lstat-'));
    try {
      const target = join(dir, 'target');
      await mkdir(target);
      const link = join(dir, 'link');
      // 'junction' keeps this runnable on unprivileged Windows dev boxes;
      // POSIX ignores the type argument entirely.
      await symlink(target, link, 'junction');
      const io = createModelStoreLstatIo();

      await expect(io.lstat(join(dir, 'nope'))).resolves.toBeNull();
      const real = await io.lstat(target);
      expect(real?.isSymbolicLink()).toBe(false);
      // The load-bearing distinction: `stat` FOLLOWS the link and would
      // report the target directory — only `lstat` sees the link itself,
      // which is exactly what the symlink refusal needs.
      const linked = await io.lstat(link);
      expect(linked?.isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ONLY ENOENT is swallowed to null — any other rejection (EACCES) propagates, fail-closed', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const denied = createModelStoreLstatIo(() => Promise.reject(eacces));
    await expect(denied.lstat('/store/root')).rejects.toBe(eacces);

    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const missing = createModelStoreLstatIo(() => Promise.reject(enoent));
    await expect(missing.lstat('/store/root')).resolves.toBeNull();
  });
});

describe('T6: createModelStorePresenceIo — sidecar-read seams (nonexistent→null, real failures propagate)', () => {
  it('real fs: readFile utf8 text · statSize byte size · missing paths (incl. a path THROUGH a file) → null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talaria-t6-presence-'));
    try {
      const file = join(dir, 'model.gguf');
      await fsWriteFile(file, 'abc', 'utf8');
      const io = createModelStorePresenceIo();

      await expect(io.readFile(file)).resolves.toBe('abc');
      await expect(io.statSize(file)).resolves.toBe(3);
      await expect(io.readFile(join(dir, 'nope.talaria.json'))).resolves.toBeNull();
      await expect(io.statSize(join(dir, 'nope.gguf'))).resolves.toBeNull();
      // ENOTDIR shape — "doesn't exist" per the modelStore seam doc.
      await expect(io.statSize(join(file, 'x'))).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an EACCES readFile/statSize PROPAGATES (only non-existence collapses to null)', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const io = createModelStorePresenceIo({
      readFileImpl: () => Promise.reject(eacces),
      statSizeImpl: () => Promise.reject(eacces),
    });
    await expect(io.readFile('/x')).rejects.toBe(eacces);
    await expect(io.statSize('/x')).rejects.toBe(eacces);
  });

  it('env: defaults to process.env; an injected env is used as-is', () => {
    expect(createModelStorePresenceIo().env).toBe(process.env);
    const io = createModelStorePresenceIo({ env: { HOME: '/home/u' } });
    expect(io.env['HOME']).toBe('/home/u');
  });
});

// --- T6 (beta.6): the new SetupControllerDeps bindings exist ------------------

describe('T6: createSetupControllerDeps — beta.6 engine bindings', () => {
  it('exposes the five new deps as bound functions', () => {
    const deps = createSetupControllerDeps(() => undefined);
    expect(typeof deps.locateLlamaServer).toBe('function');
    expect(typeof deps.scanStorePresence).toBe('function');
    expect(typeof deps.storeDest).toBe('function');
    expect(typeof deps.checkedStoreDest).toBe('function');
    expect(typeof deps.downloadGgufToStore).toBe('function');
  });

  it('T7: exposes the resolveLfsOid binding as a bound function', () => {
    const deps = createSetupControllerDeps(() => undefined);
    expect(typeof deps.resolveLfsOid).toBe('function');
  });

  it('storeDest fails typed (never a composed path) on a poisoned repo string OR an unusable store root', () => {
    const deps = createSetupControllerDeps(() => undefined);
    // Portable assertion: on a box with a usable $HOME the charset assert
    // refuses; on one without, storeRoot refuses first — both are the same
    // typed {ok:false}, never a path.
    expect(deps.storeDest('Qwen/../evil', 'x.gguf').ok).toBe(false);
  });
});
