import { promises as realFs, constants as fsConstants } from 'node:fs';

/**
 * safeWrite — the check-to-write TOCTOU floor for a LEAF file write (AU-14 /
 * TD-2, INV-7 / ADR-7: `docs_claude/audit-fix-architecture.md`).
 *
 * ## Why
 * A plain `fs.writeFile(p, data)` opens with the default `'w'` flag
 * (`O_TRUNC|O_CREAT|O_WRONLY` — no `O_NOFOLLOW`), so if `p` is (or has become,
 * across an awaited gap) a symlink, the write FOLLOWS it and lands wherever
 * the link points — including outside a confined root a caller already
 * checked. {@link CheckpointTracker.ts}'s restore leaf write is exactly this
 * shape: `removeIfSymlink(absPath)` → an AWAITED `git show` subprocess →
 * `fs.writeFile(absPath, content)`. A concurrent local actor who plants a
 * symlink at `absPath` DURING that awaited subprocess (after the check, before
 * the write) makes the write follow it.
 *
 * ## The fix (this module)
 * `writeFileNoFollow` opens the leaf with `O_NOFOLLOW` on platforms where the
 * flag exists (POSIX/Linux — the deployment target): if the leaf is a symlink
 * at open time, `open(2)` FAILS with `ELOOP` instead of following it — a
 * re-assertion that happens at the exact instant of the write, closing any
 * remaining gap regardless of what raced in between (the caller's own
 * `removeIfSymlink` handles the ordinary "stale symlink from a prior state"
 * cleanup case; this is the belt-and-suspenders backstop for a symlink raced
 * in AFTER that cleanup ran).
 *
 * `O_NOFOLLOW` does not exist on win32 (Node `fs` docs: "On Windows, only
 * `O_APPEND`, `O_CREAT`, `O_EXCL`, `O_RDONLY`, `O_RDWR`, `O_TRUNC`,
 * `O_WRONLY`, and `UV_FS_O_FILEMAP` are available" — confirmed against the
 * installed Node's own `fs.constants` at write-time, where `O_NOFOLLOW` reads
 * `undefined` on win32). On such a platform this falls back to an `lstat`
 * immediately before the (un-flagged) open — narrows, but does not fully
 * close, the window; documented dev-box-only residual (the deployment target
 * is Fedora/Linux, which always takes the `O_NOFOLLOW` branch).
 *
 * ## TD-1 compatibility (chmod-after-write, AU-4)
 * `CheckpointTracker.restore()` reapplies the executable bit after a restore
 * write. A NAIVE composition — `writeFileNoFollow(...)` then a separate
 * `fs.chmod(absPath, mode)` — would reopen a TOCTOU of its OWN: an attacker
 * could swap the leaf for a symlink in the gap between the write's `close()`
 * and the chmod-by-path call, and `fs.chmod` (path-based) FOLLOWS symlinks —
 * silently chmod-ing an attacker-chosen file elsewhere. `mode`, when given, is
 * therefore applied via `FileHandle#chmod` (`fchmod(2)` under the hood) on the
 * SAME open handle, before it is closed — never a second path-based call.
 *
 * ## Testability (mirrors {@link ./confinedOpen}'s `ConfinedOpenPort`)
 * The OS touch-points (`lstat`/`open`/the handle's `writeFile`/`chmod`) are
 * behind an injectable {@link SafeWriteOpenPort}, `platform` included, so
 * every branch (POSIX O_NOFOLLOW path, the win32 lstat-fallback path, an
 * `ELOOP` refusal) is fakeable and vitest-provable on ANY dev host — real
 * file-symlink creation itself needs elevated privilege on a stock Windows
 * dev box (no Developer Mode), which `confinedOpen.test.ts` worked around the
 * exact same way for the read path.
 */

/** Minimal handle shape this module needs — small and trivially fakeable. */
export interface SafeWriteFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  /** `fchmod(2)` on the handle's OWN fd — never a path-based re-open. */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/** The lstat seam's minimal result shape — `null` signals ENOENT (missing leaf: not a refusal, the open below creates it). */
export interface SafeWriteStatLike {
  isSymbolicLink(): boolean;
}

/** OS seam — injectable so every branch is fakeable without real symlink privilege. Production binds real `fs`. */
export interface SafeWriteOpenPort {
  readonly platform: NodeJS.Platform;
  lstat(path: string): Promise<SafeWriteStatLike | null>;
  open(path: string, flags: number, mode: number): Promise<SafeWriteFileHandle>;
}

export interface WriteFileNoFollowOptions {
  /** POSIX file mode to apply (via `fchmod` on the SAME handle) after the write — e.g. `0o755` to reapply the executable bit (TD-1/AU-4). Omit to leave the platform-default mode from `open`'s own `mode` argument. */
  mode?: number;
  /** Test seam — defaults to the real FS. */
  port?: SafeWriteOpenPort;
}

/**
 * Linux `O_NOFOLLOW` value (0o400000 — stable across Linux architectures,
 * asm-generic `fcntl.h`; the same "fall back to the known Linux literal"
 * precedent {@link ./confinedOpen}'s `O_PATH`/`O_NOFOLLOW` constants already
 * use). Node's own `fs.constants.O_NOFOLLOW` already resolves to this exact
 * value whenever it exists (confirmed against the installed Node's own
 * constants at write-time). The fallback only matters when this module runs
 * on a dev host where the real constant happens to be absent — decided per
 * PORT (see {@link nofollowSupported}), never by "does THIS machine happen to
 * have the constant".
 */
const O_NOFOLLOW_LINUX = 0o400000;

/** `true` iff `platform` is expected to honor `O_NOFOLLOW` (every POSIX target — confirmed absent only on win32's `fs.constants`, per Node's own docs). */
function nofollowSupported(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function realPort(): SafeWriteOpenPort {
  return {
    platform: process.platform,
    async lstat(p) {
      try {
        return await realFs.lstat(p);
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return null;
        throw err;
      }
    },
    async open(p, flags, mode) {
      const h = await realFs.open(p, flags, mode);
      return {
        writeFile: (data) => h.writeFile(data),
        chmod: (m) => h.chmod(m),
        close: () => h.close(),
      };
    },
  };
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/**
 * Write `content` to the REGULAR file at `absPath`, refusing to follow a
 * symlink at the leaf — see this module's doc for the full rationale. Throws
 * (never silently succeeds) on refusal; callers ride their existing per-path
 * error → disclosure channel (e.g. `CheckpointTracker.restore()`'s
 * `skippedPaths`), matching how every other FS call in that loop already
 * propagates. A refusal always carries `.code === 'ELOOP'` — the same code a
 * real `O_NOFOLLOW` open throws on Linux — so callers can treat both the
 * POSIX kernel-level refusal and the win32 lstat-fallback refusal identically.
 */
export async function writeFileNoFollow(
  absPath: string,
  content: Uint8Array,
  opts: WriteFileNoFollowOptions = {},
): Promise<void> {
  const port = opts.port ?? realPort();
  const nofollow = nofollowSupported(port.platform);

  if (!nofollow) {
    // Belt-and-suspenders on a platform with no O_NOFOLLOW: this narrows but
    // does not fully close the window (see module doc) — the deployment
    // target (Fedora/Linux) never reaches this branch.
    const st = await port.lstat(absPath);
    if (st?.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing to write through a symlink at ${absPath}`), { code: 'ELOOP' });
    }
  }

  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_TRUNC |
    (nofollow ? (fsConstants.O_NOFOLLOW ?? O_NOFOLLOW_LINUX) : 0);
  const handle = await port.open(absPath, flags, 0o666);
  try {
    await handle.writeFile(content);
    if (opts.mode !== undefined) await handle.chmod(opts.mode);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
