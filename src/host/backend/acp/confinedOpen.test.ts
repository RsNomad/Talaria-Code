import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  makeProcFdReader,
  type ConfinedOpenPort,
  type FileHandleLike,
  type FileStatLike,
} from './confinedOpen';
import { must } from '../../../testing/must';

const O_PATH = 0o10000000;

const regular: FileStatLike = { isFile: () => true, isSymbolicLink: () => false };
const symlink: FileStatLike = { isFile: () => false, isSymbolicLink: () => true };
const fifo: FileStatLike = { isFile: () => false, isSymbolicLink: () => false };

interface FakeConfig {
  platform?: string;
  openError?: (p: string, flags: number) => Error | undefined;
  pinStat?: FileStatLike;
  linkPath?: string;
  realpath?: (root: string) => string;
  bytes?: Buffer;
}

function fakePort(cfg: FakeConfig): { port: ConfinedOpenPort; opens: { p: string; flags: number }[] } {
  const opens: { p: string; flags: number }[] = [];
  let fdN = 10;
  const port: ConfinedOpenPort = {
    platform: cfg.platform ?? 'linux',
    async open(p, flags): Promise<FileHandleLike> {
      opens.push({ p, flags });
      const err = cfg.openError?.(p, flags);
      if (err) throw err;
      const fd = fdN++;
      return {
        fd,
        async stat() {
          return cfg.pinStat ?? regular;
        },
        async readFile(maxBytes?: number) {
          const full = cfg.bytes ?? Buffer.from('DATA');
          return maxBytes === undefined ? full : full.subarray(0, maxBytes);
        },
        async close() {
          /* no-op */
        },
      };
    },
    async readlink() {
      return cfg.linkPath ?? '/ws/file.ts';
    },
    async realpath(root) {
      return cfg.realpath ? cfg.realpath(root) : root;
    },
  };
  return { port, opens };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('confinedOpen — readContained (fake port, any OS)', () => {
  it('T-1 happy path: pin → fstat regular → in-tree → reopen → bytes', async () => {
    const { port, opens } = fakePort({ pinStat: regular, linkPath: '/ws/a.ts', bytes: Buffer.from('HELLO') });
    const res = await makeProcFdReader(port).readContained('/ws/a.ts', ['/ws']);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.toString()).toBe('HELLO');
    // Exactly two opens: the O_PATH pin, then the O_RDONLY reopen of the magic link.
    expect(opens).toHaveLength(2);
    expect(must(opens[0]).flags & O_PATH).not.toBe(0);
    expect(must(opens[1]).p).toMatch(/^\/proc\/self\/fd\/\d+$/);
  });

  it('T-2 escape after pin: kernel path outside every root → escape, no reopen', async () => {
    const { port, opens } = fakePort({ pinStat: regular, linkPath: '/etc/passwd' });
    const res = await makeProcFdReader(port).readContained('/ws/a.ts', ['/ws']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial).toEqual({ kind: 'escape', realPath: '/etc/passwd' });
    expect(opens).toHaveLength(1); // never reopened
  });

  it('T-3 race-flipped leaf: fstat reports symlink → not-regular, no reopen', async () => {
    const { port, opens } = fakePort({ pinStat: symlink, linkPath: '/ws/a.ts' });
    const res = await makeProcFdReader(port).readContained('/ws/a.ts', ['/ws']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial.kind).toBe('not-regular');
    expect(opens).toHaveLength(1); // the fstat gate fires before any reopen
  });

  it('T-4 device/FIFO: not-regular, and the pin open used O_PATH (naive-O_RDONLY tripwire)', async () => {
    const { port, opens } = fakePort({ pinStat: fifo, linkPath: '/ws/a.ts' });
    const res = await makeProcFdReader(port).readContained('/ws/dev', ['/ws']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial.kind).toBe('not-regular');
    expect(must(opens[0]).flags & O_PATH).not.toBe(0);
  });

  it('T-5a deleted magic link → gone', async () => {
    const { port } = fakePort({ pinStat: regular, linkPath: '/ws/a.ts (deleted)' });
    const res = await makeProcFdReader(port).readContained('/ws/a.ts', ['/ws']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.denial.kind).toBe('gone');
  });

  it('T-5b ENOENT on pin → gone; other errno → io', async () => {
    const gone = await makeProcFdReader(
      fakePort({ openError: () => errno('ENOENT') }).port,
    ).readContained('/ws/a.ts', ['/ws']);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.denial.kind).toBe('gone');

    const io = await makeProcFdReader(
      fakePort({ openError: () => errno('EACCES') }).port,
    ).readContained('/ws/a.ts', ['/ws']);
    expect(io.ok).toBe(false);
    if (!io.ok) expect(io.denial.kind).toBe('io');
  });

  it('T-5c a root whose realpath throws is skipped, not fatal', async () => {
    const { port } = fakePort({
      pinStat: regular,
      linkPath: '/real/ws/a.ts',
      realpath: (r) => {
        if (r === '/bad') throw errno('ENOENT');
        return '/real/ws';
      },
      bytes: Buffer.from('OK'),
    });
    const res = await makeProcFdReader(port).readContained('/ws/a.ts', ['/bad', '/ws']);
    expect(res.ok).toBe(true);
  });

  it('F1 (self-DoS hardening): a maxBytes cap truncates a file larger than the cap instead of returning it whole', async () => {
    const big = Buffer.from('X'.repeat(1000));
    const { port } = fakePort({ pinStat: regular, linkPath: '/ws/big.ts', bytes: big });
    const res = await makeProcFdReader(port).readContained('/ws/big.ts', ['/ws'], 10);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bytes.byteLength).toBe(10); // capped, not the full 1000 bytes
      expect(res.bytes.toString()).toBe('X'.repeat(10));
    }
  });

  it('F1: a maxBytes cap larger than the file returns the file unchanged (identical result for normal files)', async () => {
    const { port } = fakePort({ pinStat: regular, linkPath: '/ws/small.ts', bytes: Buffer.from('tiny') });
    const res = await makeProcFdReader(port).readContained('/ws/small.ts', ['/ws'], 1_000_000);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.toString()).toBe('tiny'); // cap far exceeds file size — no truncation
  });

  it('F1: omitting maxBytes still reads the whole file (unchanged default behavior)', async () => {
    const { port } = fakePort({ pinStat: regular, linkPath: '/ws/a.ts', bytes: Buffer.from('HELLO WORLD') });
    const res = await makeProcFdReader(port).readContained('/ws/a.ts', ['/ws']);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bytes.toString()).toBe('HELLO WORLD');
  });

  it('supported() is false off Linux (caller falls back to today’s read path)', async () => {
    expect(await makeProcFdReader(fakePort({ platform: 'win32' }).port).supported()).toBe(false);
    expect(await makeProcFdReader(fakePort({ platform: 'darwin' }).port).supported()).toBe(false);
  });
});

// Linux-real end-to-end (the security-relevant cases). Skipped off Linux; run on
// the Fedora ship gate. Uses the REAL port + real symlinks.
const linuxIt = it.skipIf(process.platform !== 'linux');

describe('confinedOpen — Linux real FS', () => {
  linuxIt('T-9 probe P-1/P-2 pass; supported() === true', async () => {
    expect(await makeProcFdReader().supported()).toBe(true);
  });

  linuxIt('T-6 in-tree LEAF symlink → in-tree file is ALLOWED (the preserved allowance)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-co-t6-'));
    try {
      const real = await fs.realpath(dir);
      await fs.writeFile(path.join(real, 'target.ts'), 'LEAF-OK');
      await fs.symlink(path.join(real, 'target.ts'), path.join(real, 'link.ts'));
      // Caller passes the pre-check's canonical (realpath'd) path — the leaf
      // symlink is already resolved to target.ts before readContained.
      const canonical = await fs.realpath(path.join(real, 'link.ts'));
      const res = await makeProcFdReader().readContained(canonical, [real]);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.bytes.toString()).toBe('LEAF-OK');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  linuxIt('T-8 an inode whose real path escapes the roots is DENIED', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-co-t8-'));
    try {
      const real = await fs.realpath(dir);
      const outside = path.join(real, 'outside');
      const wsRoot = path.join(real, 'ws');
      await fs.mkdir(outside);
      await fs.mkdir(wsRoot);
      await fs.writeFile(path.join(outside, 'secret'), 'SECRET');
      // Drive readContained with a canonical path that sits OUTSIDE the root —
      // the pinned-inode re-check must deny independently of the pre-check.
      const res = await makeProcFdReader().readContained(path.join(outside, 'secret'), [wsRoot]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.denial.kind).toBe('escape');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
