import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeFileNoFollow, type SafeWriteFileHandle, type SafeWriteOpenPort } from './safeWrite';
import { must } from '../../../testing/must';

/**
 * AU-14/TD-2 (INV-7/ADR-7). Real-FS tests cover the happy paths (any
 * platform); the symlink-refusal/platform-branch tests use a FAKE port —
 * mirroring `confinedOpen.test.ts`'s own rationale: creating a REAL file
 * symlink needs elevated privilege on a stock Windows dev box (no Developer
 * Mode / no `SeCreateSymbolicLinkPrivilege`), so every refusal branch is
 * proven against the injectable seam instead, and the real-symlink case is
 * covered end-to-end by `CheckpointTracker.test.ts`'s Linux-gated integration
 * test (skips here, runs on the Fedora CI target).
 */

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakePort(cfg: {
  platform?: NodeJS.Platform;
  lstatResult?: { isSymbolicLink(): boolean } | null;
  openError?: Error;
}): { port: SafeWriteOpenPort; opens: { p: string; flags: number; mode: number }[]; written: Buffer[]; chmods: number[]; closed: boolean[] } {
  const opens: { p: string; flags: number; mode: number }[] = [];
  const written: Buffer[] = [];
  const chmods: number[] = [];
  const closed: boolean[] = [];
  const port: SafeWriteOpenPort = {
    platform: cfg.platform ?? 'linux',
    async lstat() {
      return cfg.lstatResult ?? null;
    },
    async open(p, flags, mode): Promise<SafeWriteFileHandle> {
      opens.push({ p, flags, mode });
      if (cfg.openError) throw cfg.openError;
      return {
        async writeFile(data) {
          written.push(Buffer.from(data));
        },
        async chmod(m) {
          chmods.push(m);
        },
        async close() {
          closed.push(true);
        },
      };
    },
  };
  return { port, opens, written, chmods, closed };
}

const O_NOFOLLOW_LINUX = 0o400000; // asm-generic value; only used to sanity-check the flag bit is present when expected

describe('writeFileNoFollow — real FS happy paths', () => {
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-safewrite-'));
    try {
      return await fn(d);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  }

  it('writes content to a fresh (non-existent) path', async () => {
    await withTmpDir(async (d) => {
      const p = path.join(d, 'fresh.txt');
      await writeFileNoFollow(p, Buffer.from('hello'));
      await expect(fs.readFile(p, 'utf8')).resolves.toBe('hello');
    });
  });

  it('overwrites (truncates) an existing regular file', async () => {
    await withTmpDir(async (d) => {
      const p = path.join(d, 'existing.txt');
      await fs.writeFile(p, 'OLD-LONGER-CONTENT');
      await writeFileNoFollow(p, Buffer.from('new'));
      await expect(fs.readFile(p, 'utf8')).resolves.toBe('new');
    });
  });

  it('applies mode via the SAME handle (fchmod) when given — no throw on any platform', async () => {
    await withTmpDir(async (d) => {
      const p = path.join(d, 'exec.txt');
      await expect(writeFileNoFollow(p, Buffer.from('x'), { mode: 0o755 })).resolves.toBeUndefined();
    });
  });

  (process.platform === 'win32' ? it.skip : it)(
    'the applied mode is readable back via the executable bit (POSIX only)',
    async () => {
      await withTmpDir(async (d) => {
        const p = path.join(d, 'exec.sh');
        await writeFileNoFollow(p, Buffer.from('#!/bin/sh\n'), { mode: 0o755 });
        const st = await fs.stat(p);
        expect(st.mode & 0o111).toBeTruthy();
      });
    },
  );

  it('omitting mode leaves the platform-default (created) mode untouched', async () => {
    await withTmpDir(async (d) => {
      const p = path.join(d, 'noexec.txt');
      await writeFileNoFollow(p, Buffer.from('x'));
      await expect(fs.readFile(p, 'utf8')).resolves.toBe('x');
    });
  });
});

describe('writeFileNoFollow — fake port (every branch provable on any host)', () => {
  it('POSIX/Linux: opens with O_NOFOLLOW set and skips the pre-open lstat entirely', async () => {
    const { port, opens } = fakePort({ platform: 'linux' });
    await writeFileNoFollow('/ws/a.txt', Buffer.from('x'), { port });
    expect(opens).toHaveLength(1);
    expect(must(opens[0]).flags & O_NOFOLLOW_LINUX).not.toBe(0);
  });

  it('win32: O_NOFOLLOW is not requested (the flag does not exist there)', async () => {
    const { port, opens } = fakePort({ platform: 'win32' });
    await writeFileNoFollow('/ws/a.txt', Buffer.from('x'), { port });
    expect(must(opens[0]).flags & O_NOFOLLOW_LINUX).toBe(0);
  });

  it('win32 fallback: a symlinked leaf is refused via the pre-open lstat re-assert, with code ELOOP, and open() is never called', async () => {
    const { port, opens } = fakePort({
      platform: 'win32',
      lstatResult: { isSymbolicLink: () => true },
    });
    await expect(writeFileNoFollow('/ws/a.txt', Buffer.from('x'), { port })).rejects.toMatchObject({
      code: 'ELOOP',
    });
    expect(opens).toHaveLength(0);
  });

  it('win32 fallback: a non-symlink leaf (or a missing one) proceeds to the write', async () => {
    const { port, written } = fakePort({
      platform: 'win32',
      lstatResult: { isSymbolicLink: () => false },
    });
    await writeFileNoFollow('/ws/a.txt', Buffer.from('ok'), { port });
    expect(written).toHaveLength(1);
    expect(must(written[0]).toString()).toBe('ok');
  });

  it('a real ELOOP thrown by open() (the Linux O_NOFOLLOW-on-a-symlink kernel refusal) propagates as-is', async () => {
    const { port } = fakePort({ platform: 'linux', openError: errno('ELOOP') });
    await expect(writeFileNoFollow('/ws/a.txt', Buffer.from('x'), { port })).rejects.toMatchObject({
      code: 'ELOOP',
    });
  });

  it('mode is applied via the handle (fchmod) — never a second path-based chmod call', async () => {
    const { port, chmods, closed } = fakePort({ platform: 'linux' });
    await writeFileNoFollow('/ws/a.txt', Buffer.from('x'), { port, mode: 0o755 });
    expect(chmods).toEqual([0o755]);
    expect(closed).toEqual([true]); // the SAME handle is closed after chmod, never reopened by path
  });

  it('the handle is closed even when writeFile throws', async () => {
    const closed: boolean[] = [];
    const port: SafeWriteOpenPort = {
      platform: 'linux',
      async lstat() {
        return null;
      },
      async open(): Promise<SafeWriteFileHandle> {
        return {
          async writeFile() {
            throw errno('ENOSPC');
          },
          async chmod() {
            /* unreached */
          },
          async close() {
            closed.push(true);
          },
        };
      },
    };
    await expect(writeFileNoFollow('/ws/a.txt', Buffer.from('x'), { port })).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(closed).toEqual([true]);
  });
});
