import { promises as realFs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * O_PATH confined-open unit (accepted-limits Limit-1 close). Closes the classic `realpath`→open TOCTOU on
 * `handleReadTextFile`: between the pre-check's `realpath` and the actual read,
 * a prompt-injected agent could flip a path component to a symlink and redirect
 * the read outside the workspace. Here we PIN the validated inode with `O_PATH`
 * (an inode reference that opens NO datapath — no `/dev/watchdog` arming, no
 * FIFO block, no automount trigger), re-assert containment on the pinned inode
 * via `/proc/self/fd`, then reopen THAT handle (a kernel file reference, not a
 * path) — so no component swap can redirect it.
 *
 * Additive + fail-safe: gated behind a one-time runtime probe ({@link
 * ConfinedReader.supported}); if the probe fails (non-Linux dev host, wrong
 * `O_PATH` constant, virtual FS) the caller falls back to today's exact read
 * path. Never weaker than today, never opens a device before validating.
 *
 * `readContained` touches the OS only through the injected {@link
 * ConfinedOpenPort}, so every deny branch is vitest-fakeable on any platform;
 * the `supported()` probe is Linux-real (skipped elsewhere, run on the Fedora
 * gate). Pattern: the container-runtime safe-reopen (runc/libpathrs lineage).
 */

// Linux asm-generic O_PATH (x86_64/aarch64 — the Fedora targets). NOT exported
// by `fs.constants` (verified against node_constants.cc), so it is defined here
// and GUARDED by the runtime probe: open(2) silently IGNORES unknown flag bits,
// so a wrong value would degrade to a side-effectful plain open — exactly the
// regression this unit exists to avoid. The probe proves the bit is live.
const O_PATH = 0o10000000;
const O_NOFOLLOW = realFs.constants?.O_NOFOLLOW ?? 0o400000;
const O_RDONLY = realFs.constants?.O_RDONLY ?? 0;

/** Why a file could not be confined-read. Every branch is fail-closed. */
export type ConfinedReadDenial =
  | { kind: 'unsupported' } //            probe failed / non-Linux — caller uses today's fallback
  | { kind: 'escape'; realPath: string } // pinned inode's kernel path is outside every root
  | { kind: 'not-regular' } //            device/FIFO/dir — or a race-flipped symlink leaf (S_IFLNK)
  | { kind: 'gone' } //                   unlinked between pin and check (" (deleted)") or ENOENT
  | { kind: 'io'; cause: unknown }; //    any other syscall failure

export type ConfinedReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; denial: ConfinedReadDenial };

export interface FileStatLike {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileHandleLike {
  readonly fd: number;
  stat(): Promise<FileStatLike>;
  /**
   * F1 (self-DoS hardening, Tier-2 remediation architecture §12.1, task
   * T-13): reads the whole file when `maxBytes` is omitted (unchanged
   * default). When given, reads AT MOST `maxBytes` bytes from the start
   * instead — never the whole file — so a caller that only needs a bounded
   * window (a `limit`-bounded `readTextFile`) can't be made to materialize
   * an arbitrarily large (e.g. ~1.5 GB) workspace file into memory.
   */
  readFile(maxBytes?: number): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * OS seam — injectable so every deny branch is fakeable without a real FS (the
 * existing pathConfine hard-imports `fs`, leaving its post-open branches
 * untestable).
 */
export interface ConfinedOpenPort {
  readonly platform: string;
  open(p: string, flags: number): Promise<FileHandleLike>;
  readlink(p: string): Promise<string>;
  realpath(p: string): Promise<string>;
}

export interface ConfinedReader {
  /** True once the one-time O_PATH semantic probe has passed on this host. */
  supported(): Promise<boolean>;
  /**
   * Read `canonicalPath` (MUST be `resolveWithinWorkspaceReal` output),
   * guaranteeing the bytes come from an inode verified to sit under one of
   * `roots` AFTER being pinned. Never opens a device/FIFO datapath.
   *
   * @param maxBytes F1: optional cap — read at most this many bytes from the
   * pinned inode's start rather than the whole file (self-DoS hardening on
   * a pathologically large workspace file). Omit for the original
   * whole-file behavior — a file at or under the cap reads byte-identically
   * either way.
   */
  readContained(canonicalPath: string, roots: readonly string[], maxBytes?: number): Promise<ConfinedReadResult>;
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** `child` is `parent` itself or nested under it (both already realpath'd). */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class ProcFdReader implements ConfinedReader {
  private probe: Promise<boolean> | undefined;

  constructor(private readonly port: ConfinedOpenPort) {}

  supported(): Promise<boolean> {
    // Memoize the probe promise so concurrent callers share one run.
    return (this.probe ??= this.runProbe());
  }

  async readContained(
    canonicalPath: string,
    roots: readonly string[],
    maxBytes?: number,
  ): Promise<ConfinedReadResult> {
    let fd: FileHandleLike | undefined;
    let fd2: FileHandleLike | undefined;
    try {
      // 1. Pin the inode. O_PATH opens no datapath (open(2): read/write/ioctl/
      //    mmap fail EBADF; automount not triggered); O_NOFOLLOW on a symlink
      //    LEAF returns a fd to the LINK (no ELOOP under O_PATH) — caught at (2).
      try {
        fd = await this.port.open(canonicalPath, O_PATH | O_NOFOLLOW);
      } catch (e) {
        return { ok: false, denial: isErrno(e, 'ENOENT') ? { kind: 'gone' } : { kind: 'io', cause: e } };
      }

      // 2. Kind gate FIRST (also the race-tripwire for a flipped symlink leaf:
      //    the O_PATH open succeeds on it, fstat reports S_IFLNK). Reopening a
      //    symlink-referring fd via procfs would re-follow it — so refuse here,
      //    before any reopen.
      const st = await fd.stat();
      if (!st.isFile()) return { ok: false, denial: { kind: 'not-regular' } };

      // 3. Containment re-check on the PINNED inode via its kernel dentry path
      //    (one syscall, no textual re-walk). Prefer this over realpath of the
      //    magic link (which re-resolves the text and can ENOENT spuriously).
      const linkPath = await this.port.readlink(`/proc/self/fd/${fd.fd}`);
      if (linkPath.endsWith(' (deleted)')) return { ok: false, denial: { kind: 'gone' } };
      let contained = false;
      for (const root of roots) {
        let realRoot: string;
        try {
          realRoot = await this.port.realpath(root);
        } catch {
          continue;
        }
        if (isWithin(linkPath, realRoot)) {
          contained = true;
          break;
        }
      }
      if (!contained) return { ok: false, denial: { kind: 'escape', realPath: linkPath } };

      // 4. Reopen the PINNED inode (magic link = a direct kernel file-handle
      //    reference, not path-expanded — symlink(7)), so no component swap can
      //    redirect the read. Safe: step 2 proved a regular file, and an inode's
      //    type is immutable.
      fd2 = await this.port.open(`/proc/self/fd/${fd.fd}`, O_RDONLY);

      // 5. Read. F1: `maxBytes`, when given, bounds this — see FileHandleLike.readFile's doc.
      const bytes = await fd2.readFile(maxBytes);
      return { ok: true, bytes };
    } catch (e) {
      return { ok: false, denial: { kind: 'io', cause: e } };
    } finally {
      await fd2?.close().catch(() => undefined);
      await fd?.close().catch(() => undefined);
    }
  }

  /**
   * One-time, side-effect-free probe (§2.5). P-1: `O_PATH|O_NOFOLLOW` on a
   * symlink must SUCCEED and fstat report a symlink — if the O_PATH bit is dead
   * (wrong arch/kernel) the kernel sees only O_NOFOLLOW → ELOOP → probe fails
   * (the two outcomes are disjoint, so this is decisive). P-2: reopen a target
   * via `/proc/self/fd` and read the known content back.
   */
  private async runProbe(): Promise<boolean> {
    if (this.port.platform !== 'linux') return false;
    let dir: string | undefined;
    try {
      dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'hermes-opath-'));
      const target = path.join(dir, 'probe-target');
      const link = path.join(dir, 'probe-link');
      await realFs.writeFile(target, 'probe');
      await realFs.symlink(target, link);

      // P-1
      let linkFd: FileHandleLike | undefined;
      try {
        linkFd = await this.port.open(link, O_PATH | O_NOFOLLOW);
        const st = await linkFd.stat();
        if (!st.isSymbolicLink()) return false;
      } catch {
        return false; // ELOOP ⇒ O_PATH bit not honored
      } finally {
        await linkFd?.close().catch(() => undefined);
      }

      // P-2
      const res = await this.readContained(target, [dir]);
      return res.ok && res.bytes.toString('utf8') === 'probe';
    } catch {
      return false;
    } finally {
      if (dir) await realFs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function realPort(): ConfinedOpenPort {
  return {
    platform: process.platform,
    async open(p, flags) {
      const h = await realFs.open(p, flags);
      return {
        fd: h.fd,
        stat: () => h.stat(),
        // F1: unbounded (default) delegates to the plain whole-file read,
        // byte-identical to before this parameter existed. Bounded reads go
        // through `FileHandle.read()` (a positional read) instead of
        // `readFile()`, so a pathologically large file never gets
        // materialized past `maxBytes` in the first place.
        readFile: async (maxBytes?: number) => {
          if (maxBytes === undefined) return h.readFile();
          const buf = Buffer.alloc(maxBytes);
          const { bytesRead } = await h.read(buf, 0, maxBytes, 0);
          return buf.subarray(0, bytesRead);
        },
        close: () => h.close(),
      };
    },
    readlink: (p) => realFs.readlink(p),
    realpath: (p) => realFs.realpath(p),
  };
}

/** Construct the confined reader. Pass a fake `port` in tests; production uses the real FS. */
export function makeProcFdReader(port?: ConfinedOpenPort): ConfinedReader {
  return new ProcFdReader(port ?? realPort());
}
