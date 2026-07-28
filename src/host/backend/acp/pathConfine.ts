import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Confine an agent-supplied file path to the open workspace root(s).
 *
 * ## Why (security-review.md M1)
 * The ACP client advertises `fs.readTextFile: true`, so the agent can ask the
 * extension to read arbitrary paths. Unconfined, a compromised or
 * prompt-injected agent could read `~/.ssh/id_rsa`, `~/.aws/credentials`, etc.
 * and stream them back into the conversation. We therefore resolve the request
 * and reject anything that does not sit inside one of the workspace folders.
 *
 * The check is lexical: `path.resolve` normalizes `.`/`..` and
 * `path.relative` cleanly detects escapes (an out-of-root target yields a
 * relative path that is either absolute — different drive on win32 — or begins
 * with `..`). This defeats `../` traversal and absolute out-of-tree paths.
 *
 * NOTE: this lexical check does NOT resolve symlinks; a symlink *inside* the
 * workspace that points outside still passes it. It is therefore kept only as a
 * cheap fail-fast PRE-CHECK — the symlink-escape hole is closed by the async
 * {@link resolveWithinWorkspaceReal} (S-M5), which callers touching the real FS
 * (e.g. the ACP `readTextFile` handler) MUST use instead of this one.
 *
 * @returns the normalized absolute path when contained, or `null` to signal
 *          "deny — fail closed".
 */
export function resolveWithinWorkspace(
  requestedPath: string,
  workspaceRoots: readonly string[],
): string | null {
  if (!requestedPath || workspaceRoots.length === 0) return null;

  const resolved = path.resolve(requestedPath);
  for (const root of workspaceRoots) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    if (isWithin(resolved, resolvedRoot)) return resolved;
  }
  return null;
}

/**
 * Symlink-aware ("realpath") containment — the fix for S-M5.
 *
 * ## Why (research-security-hardening.md S-M5)
 * {@link resolveWithinWorkspace} is lexical only, so a symlink that lives
 * *inside* the workspace but *points outside* (e.g. a planted `escape -> /etc`,
 * or `link -> ~/.ssh/id_rsa`) still passes it — a prompt-injected agent could
 * exfiltrate `/etc/passwd`, SSH keys, etc. through the advertised
 * `fs.readTextFile` capability. This variant resolves ALL symlinks and
 * re-asserts containment against the *canonical* paths.
 *
 * ## The predicate (this exact shape matters)
 * 1. Run the cheap lexical pre-check first; if it already denies, deny (this
 *    also fails closed on empty input / no roots and normalizes `../` before
 *    any FS touch).
 * 2. `realpath` the target's deepest EXISTING ancestor and re-append the
 *    not-yet-existing tail (the leaf may not exist — e.g. a future write, or a
 *    symlinked parent dir). `fs.realpath` throws `ENOENT` on a missing leaf,
 *    so we walk up until a real path resolves. This also canonicalizes a
 *    symlinked *parent* directory.
 * 3. `realpath` EACH workspace root too, then re-assert containment on the
 *    canonicalized pair. Realpath-ing the ROOT is critical, NOT optional: pnpm
 *    stores, Nix paths, `/tmp -> /private/tmp`, direnv/container binds and
 *    monorepos routinely put the workspace itself under a symlink. If we only
 *    canonicalized the target and compared it against a *lexical* root, every
 *    legitimate in-workspace file would be wrongly DENIED.
 * 4. Fail closed (return `null`) on any FS error or true escape.
 *
 * Net rule: ALLOW an in-workspace symlink iff its realpath resolves under a
 * realpath'd workspace root (so pnpm/monorepo in-workspace links PASS); BLOCK
 * only a symlink whose realpath escapes every root.
 *
 * Grounding (Context7 `/nodejs/node`, write-time):
 * - `fs.realpath`/`fsPromises.realpath` "computes the canonical pathname by
 *   resolving `.`, `..`, and symbolic links"; "a path that does not exist
 *   results in an ENOENT error" (Node `fs` docs).
 * - Node's own security guidance: lexical normalization alone must NOT be
 *   relied on to prevent directory traversal — "always perform explicit path
 *   validation ... to ensure it remains within expected boundaries before
 *   using it for file system operations" (Node `url`/`fileURLToPath` security
 *   note). Trail of Bits' webview-hardening framing motivates confining the
 *   `readTextFile` capability to the workspace trust boundary.
 *
 * @returns the canonical (realpath'd) absolute path when contained, or `null`
 *          to signal "deny — fail closed". Callers should read exactly the
 *          returned path so the file that was validated is the file that is read.
 */
export async function resolveWithinWorkspaceReal(
  requestedPath: string,
  workspaceRoots: readonly string[],
): Promise<string | null> {
  // 0. Cheap lexical pre-check — fail closed early on empty/no-roots/`../`.
  const lexical = resolveWithinWorkspace(requestedPath, workspaceRoots);
  if (lexical === null) return null;

  // 1. Canonicalize the target (deepest existing ancestor + non-existent tail).
  let realTarget: string;
  try {
    realTarget = await realpathOfExistingPrefix(lexical);
  } catch {
    return null; // any unexpected FS error -> fail closed
  }

  // 2. Canonicalize EACH root and re-assert containment on the real pair.
  for (const root of workspaceRoots) {
    if (!root) continue;
    let realRoot: string;
    try {
      realRoot = await fs.realpath(path.resolve(root));
    } catch {
      continue; // a root that can't be canonicalized can't contain anything
    }
    if (isWithin(realTarget, realRoot)) return realTarget;
  }
  return null; // realpath escaped every root -> deny
}

/**
 * Bucket 1 F1 (CWE-22/59/180): the canonical resolution of ONE agent-proposed
 * EDIT path, computed BEFORE the pure policy engine classifies or contains it.
 *
 * ## Why (l2-security finding 1 / arch finding A1)
 * The write-decision path used to be lexical-only (`path.posix.resolve` +
 * string containment) — textbook CWE-180 validate-before-canonicalize. An
 * in-workspace symlink `evil -> ~/.ssh/authorized_keys` was "inside" and
 * non-secret, so `normal` auto-allowed a write to the user's SSH keys; a raw
 * `~/.bashrc` resolved to `<ws>/~/.bashrc` — also lexically "inside" — while
 * Hermes `expanduser()`s it and writes to the real home dir. This helper is
 * the single home of edit-path canonicalization (same discipline as the
 * hardened read path, {@link resolveWithinWorkspaceReal}):
 *
 *  1. Expand a leading `~/` (and bare `~`) to the CALLER-INJECTED `homeDir`
 *     (`os.homedir()` lives in the fs layer, never in the pure modules). An
 *     un-expandable `~user` form is FAIL-CLOSED: `tildeUnresolved: true`,
 *     `insideWorkspace: false` (a legitimate in-workspace file is never named
 *     `~…` at the root, so this costs nothing and needs no `/etc/passwd`).
 *  2. `lstat` the leaf: if the final component is itself a live symbolic
 *     link, REFUSE (`leafIsSymlink: true` forces `insideWorkspace: false`) even
 *     when its realpath lands inside the tree — Hermes writes THROUGH the
 *     link out-of-process, and the link target can be swapped between our
 *     check and its write.
 *  3. `realpath` the deepest existing ancestor + re-append the non-existent
 *     tail ({@link realpathOfExistingPrefix} — the new-file/write case), then
 *     `realpath` EACH workspace root and re-assert containment on the
 *     canonical pair (roots under pnpm/Nix//tmp symlinks must not cause
 *     over-denial).
 *
 * ## Accepted residual (CWE-363/367 — do not pretend otherwise)
 * The actual write happens out-of-process in Hermes, so the check->write gap
 * cannot be closed from here: an attacker who can race the filesystem can
 * still swap a path component after our check. realpath narrows the window
 * and the lstat-refuse removes the "leaf is a live symlink" class; the
 * recovery backstop for the residual race is the Phase-0 after-turn
 * whole-tree snapshot. (Hardlinks-to-secrets are likewise out of scope:
 * realpath does not resolve them and git cannot ship them.)
 */
export interface CanonicalEditPath {
  /** The raw path string as extracted from the request (for audit lines). */
  raw: string;
  /** Canonical absolute path (native separators; symlinks/`..`/`~` resolved). */
  canonicalPath: string;
  /**
   * True only when the canonical path sits under a realpath'd workspace root
   * AND the leaf is not a live symlink AND no `~user` form was left
   * unresolved — i.e. "safe to treat as an in-workspace edit".
   */
  insideWorkspace: boolean;
  /** POSIX workspace-relative path when contained, else `null`. */
  relPath: string | null;
  /** The final component is itself a symbolic link (lstat-refuse mitigation). */
  leafIsSymlink: boolean;
  /** A `~user` form we cannot cheaply expand — treated fail-closed. */
  tildeUnresolved: boolean;
}

export async function canonicalizeEditPath(
  raw: string,
  base: string,
  workspaceRoots: readonly string[],
  homeDir: string,
): Promise<CanonicalEditPath> {
  const { expanded, tildeUnresolved } = expandTilde(raw, homeDir);
  const lexical = path.resolve(base, expanded);

  if (tildeUnresolved) {
    return { raw, canonicalPath: lexical, insideWorkspace: false, relPath: null, leafIsSymlink: false, tildeUnresolved };
  }

  // lstat the LEAF (never follows the link itself): a missing leaf (ENOENT) is
  // the ordinary new-file case; any other lstat error fails closed below via
  // the realpath step (which will throw the same way).
  let leafIsSymlink = false;
  try {
    leafIsSymlink = (await fs.lstat(lexical)).isSymbolicLink();
  } catch {
    leafIsSymlink = false;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpathOfExistingPrefix(lexical);
  } catch {
    // Unexpected FS error -> fail closed (deny containment, keep the lexical
    // form for display so the human still sees what was proposed).
    return { raw, canonicalPath: lexical, insideWorkspace: false, relPath: null, leafIsSymlink, tildeUnresolved: false };
  }

  let contained = false;
  let relPath: string | null = null;
  for (const root of workspaceRoots) {
    if (!root) continue;
    let realRoot: string;
    try {
      realRoot = await fs.realpath(path.resolve(root));
    } catch {
      continue; // a root that can't be canonicalized can't contain anything
    }
    if (isWithin(canonicalPath, realRoot)) {
      contained = true;
      relPath = path.relative(realRoot, canonicalPath).split(path.sep).join('/');
      break;
    }
  }

  return {
    raw,
    canonicalPath,
    insideWorkspace: contained && !leafIsSymlink,
    relPath: contained ? relPath : null,
    leafIsSymlink,
    tildeUnresolved: false,
  };
}

/**
 * Expand a leading `~`/`~/` to `homeDir` (Hermes `expanduser()`s edit paths on
 * write — contract §6/§9.10 — so the gate must judge the SAME target). A
 * `~user` form is flagged unresolved for the caller to fail closed on.
 */
function expandTilde(raw: string, homeDir: string): { expanded: string; tildeUnresolved: boolean } {
  if (raw === '~' || raw === '~/') return { expanded: homeDir, tildeUnresolved: false };
  if (raw.startsWith('~/')) return { expanded: path.join(homeDir, raw.slice(2)), tildeUnresolved: false };
  if (raw.startsWith('~')) return { expanded: raw, tildeUnresolved: true };
  return { expanded: raw, tildeUnresolved: false };
}

/**
 * `realpath` the longest existing prefix of `target`, then re-join the tail that
 * does not exist yet. Handles the write/new-file case and canonicalizes any
 * symlinked parent directory. Only `ENOENT` triggers the walk-up; every other
 * error propagates so the caller can fail closed.
 */
async function realpathOfExistingPrefix(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err; // reached the FS root without resolving
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Lexical containment predicate: is `child` at or below `parent`?
 * An out-of-parent target yields a `path.relative` result that is either
 * `..`, starts with `..${sep}`, or is absolute (different drive on win32).
 */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
