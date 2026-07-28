import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinWorkspace, resolveWithinWorkspaceReal, canonicalizeEditPath } from './pathConfine';

/**
 * Create a directory link `link` -> `target`. Uses a real symlink where the OS
 * allows it (Linux/Fedora — the CI target) and falls back to an NTFS junction
 * on a Windows dev box lacking `SeCreateSymbolicLinkPrivilege`. Both are reparse
 * points that `fs.realpath` canonicalizes, so the escape/containment property
 * under test is exercised identically on either platform.
 */
async function linkDir(target: string, link: string): Promise<void> {
  try {
    await fs.symlink(target, link, 'dir');
  } catch {
    await fs.symlink(target, link, 'junction');
  }
}
function linkDirSync(target: string, link: string): void {
  try {
    symlinkSync(target, link, 'dir');
  } catch {
    symlinkSync(target, link, 'junction');
  }
}

// Built relative to a resolved root so the assertions are portable across the
// POSIX target (Fedora) and the Windows dev box.
const root = path.resolve('/workspace/project');
const otherRoot = path.resolve('/workspace/other');

describe('resolveWithinWorkspace', () => {
  it('allows a file directly inside the workspace root', () => {
    const p = path.join(root, 'src', 'index.ts');
    expect(resolveWithinWorkspace(p, [root])).toBe(p);
  });

  it('allows the root itself', () => {
    expect(resolveWithinWorkspace(root, [root])).toBe(root);
  });

  it('normalizes a "." / redundant-segment path that stays inside', () => {
    const messy = path.join(root, 'src', '..', 'src', 'a.ts');
    expect(resolveWithinWorkspace(messy, [root])).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('denies a ../ traversal that escapes the root (M1: secret exfil)', () => {
    const escape = path.join(root, '..', 'secret.txt');
    expect(resolveWithinWorkspace(escape, [root])).toBeNull();
  });

  it('denies an absolute out-of-tree path (e.g. ~/.ssh/id_rsa)', () => {
    expect(resolveWithinWorkspace(path.resolve('/etc/passwd'), [root])).toBeNull();
  });

  it('does not treat a sibling with a shared name prefix as inside (/workspace/project vs /workspace/project-evil)', () => {
    const sibling = path.resolve('/workspace/project-evil/x.ts');
    expect(resolveWithinWorkspace(sibling, [root])).toBeNull();
  });

  it('accepts a path inside ANY of several workspace roots', () => {
    const p = path.join(otherRoot, 'lib', 'y.ts');
    expect(resolveWithinWorkspace(p, [root, otherRoot])).toBe(p);
  });

  it('fails closed with no workspace roots', () => {
    expect(resolveWithinWorkspace(path.join(root, 'a.ts'), [])).toBeNull();
  });

  it('fails closed on an empty requested path', () => {
    expect(resolveWithinWorkspace('', [root])).toBeNull();
  });
});

// --- realpath symlink-escape hardening (S-M5) --------------------------------
// Probe once, synchronously, whether this OS lets us create a directory link
// (native symlink on Linux, junction fallback on Windows). The CI target is
// Fedora/Linux where this always holds; if even the junction fallback fails,
// the link-dependent cases skip while the lexical ones still run.
const canLinkDir = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-symcap-'));
    mkdirSync(path.join(dir, 't'));
    linkDirSync(path.join(dir, 't'), path.join(dir, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

describe('resolveWithinWorkspaceReal (symlink-escape hardening)', () => {
  const tmpDirs: string[] = [];

  async function makeTmp(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.skipIf(!canLinkDir)(
    '(a) denies a read through an in-workspace symlink that points OUTSIDE (e.g. ~/.ssh, /etc)',
    async () => {
      const ws = await makeTmp('hermes-ws-');
      const outside = await makeTmp('hermes-outside-');
      await fs.writeFile(path.join(outside, 'secret.txt'), 'id_rsa contents');
      // A symlinked directory living inside the workspace whose target escapes it
      // — the classic vector: `<ws>/escape` -> `/etc` (or the user's home).
      await linkDir(outside, path.join(ws, 'escape'));

      expect(await resolveWithinWorkspaceReal(path.join(ws, 'escape', 'secret.txt'), [ws])).toBeNull();
    },
  );

  it('(b) allows a normal file that really lives inside the workspace', async () => {
    const ws = await makeTmp('hermes-ws-');
    const file = path.join(ws, 'src', 'index.ts');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'export {};');

    expect(await resolveWithinWorkspaceReal(file, [ws])).toBe(await fs.realpath(file));
  });

  it.skipIf(!canLinkDir)(
    '(c) regression guard: a root reached THROUGH a symlink still allows its in-root files',
    async () => {
      // base/real is the true workspace; base/link -> base/real is how it is opened.
      const base = await makeTmp('hermes-base-');
      const realRoot = path.join(base, 'real');
      await fs.mkdir(path.join(realRoot, 'src'), { recursive: true });
      const file = path.join(realRoot, 'src', 'a.ts');
      await fs.writeFile(file, 'export {};');
      const linkRoot = path.join(base, 'link');
      await linkDir(realRoot, linkRoot);

      // Opened as the symlinked root — the file must still be ALLOWED (proves we
      // realpath the ROOT too, not just the target).
      const requested = path.join(linkRoot, 'src', 'a.ts');
      expect(await resolveWithinWorkspaceReal(requested, [linkRoot])).toBe(await fs.realpath(file));
    },
  );

  it.skipIf(!canLinkDir)(
    '(c2) pnpm/monorepo false-positive guard: an in-workspace symlink whose target is INSIDE is allowed',
    async () => {
      const ws = await makeTmp('hermes-ws-');
      // node_modules/foo -> node_modules/.pnpm/foo@1/node_modules/foo (all inside ws)
      const realPkg = path.join(ws, 'node_modules', '.pnpm', 'foo@1', 'node_modules', 'foo');
      await fs.mkdir(realPkg, { recursive: true });
      await fs.writeFile(path.join(realPkg, 'index.js'), 'module.exports={};');
      const linkPkg = path.join(ws, 'node_modules', 'foo');
      await linkDir(realPkg, linkPkg);

      const requested = path.join(linkPkg, 'index.js');
      expect(await resolveWithinWorkspaceReal(requested, [ws])).toBe(
        await fs.realpath(path.join(realPkg, 'index.js')),
      );
    },
  );

  it('(d) a ../ traversal that escapes the root is still denied', async () => {
    const ws = await makeTmp('hermes-ws-');
    expect(await resolveWithinWorkspaceReal(path.join(ws, '..', 'secret.txt'), [ws])).toBeNull();
  });

  it('(d2) an absolute out-of-tree path is still denied', async () => {
    const ws = await makeTmp('hermes-ws-');
    const outside = await makeTmp('hermes-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
    expect(await resolveWithinWorkspaceReal(path.join(outside, 'secret.txt'), [ws])).toBeNull();
  });

  it('allows a not-yet-existing leaf under an existing in-workspace dir (write path)', async () => {
    const ws = await makeTmp('hermes-ws-');
    const requested = path.join(ws, 'newdir', 'newfile.txt'); // newdir does not exist yet
    expect(await resolveWithinWorkspaceReal(requested, [ws])).toBe(
      path.join(await fs.realpath(ws), 'newdir', 'newfile.txt'),
    );
  });

  it('fails closed with no workspace roots / empty path', async () => {
    const ws = await makeTmp('hermes-ws-');
    expect(await resolveWithinWorkspaceReal(path.join(ws, 'a.ts'), [])).toBeNull();
    expect(await resolveWithinWorkspaceReal('', [ws])).toBeNull();
  });
});

// --- canonicalizeEditPath (Bucket 1 F1: canonicalize edit paths BEFORE classify
// + containment — CWE-22/59/180). Real temp dirs, mirroring the S-M5 suite. ---

// Can this OS create a FILE symlink? (Linux/Fedora: always. Windows: needs
// SeCreateSymbolicLinkPrivilege / Developer Mode; there is no junction fallback
// for files, so the file-leaf cases skip when unavailable.)
const canLinkFile = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hermes-filesymcap-'));
    writeFileSync(path.join(dir, 't.txt'), 'x');
    symlinkSync(path.join(dir, 't.txt'), path.join(dir, 'l.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
})();

describe('canonicalizeEditPath (edit-path canonicalization for the policy gate)', () => {
  const tmpDirs: string[] = [];

  async function makeTmp(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.skipIf(!canLinkFile)(
    'symlink-leaf-escapes-root: an in-workspace file symlink to an outside secret is NOT inside (leafIsSymlink)',
    async () => {
      const ws = await makeTmp('hermes-ws-');
      const outside = await makeTmp('hermes-outside-');
      await fs.mkdir(path.join(outside, '.ssh'), { recursive: true });
      const target = path.join(outside, '.ssh', 'authorized_keys');
      await fs.writeFile(target, 'ssh-ed25519 AAAA...');
      await fs.symlink(target, path.join(ws, 'evil'), 'file');

      const result = await canonicalizeEditPath('evil', ws, [ws], os.homedir());

      expect(result.insideWorkspace).toBe(false);
      expect(result.leafIsSymlink).toBe(true);
      // The canonical path reveals the REAL target so the classifier sees `.ssh`.
      expect(result.canonicalPath).toBe(await fs.realpath(target));
    },
  );

  it.skipIf(!canLinkFile)(
    'symlink-leaf-inside-workspace: a leaf that is itself a symlink is refused even when its target stays inside (lstat-refuse, CWE-59/363)',
    async () => {
      const ws = await makeTmp('hermes-ws-');
      const target = path.join(ws, 'real.txt');
      await fs.writeFile(target, 'x');
      await fs.symlink(target, path.join(ws, 'link.txt'), 'file');

      const result = await canonicalizeEditPath('link.txt', ws, [ws], os.homedir());

      expect(result.leafIsSymlink).toBe(true);
      expect(result.insideWorkspace).toBe(false); // never auto-allow a live-symlink leaf
    },
  );

  it.skipIf(!canLinkDir)(
    'symlink-dir-escape: a target under an in-workspace dir symlink pointing outside (hooks -> ../.git) is NOT inside',
    async () => {
      const ws = await makeTmp('hermes-ws-');
      const outside = await makeTmp('hermes-outside-');
      const gitDir = path.join(outside, '.git');
      await fs.mkdir(gitDir, { recursive: true });
      await linkDir(gitDir, path.join(ws, 'hooks'));

      const result = await canonicalizeEditPath('hooks/pre-commit', ws, [ws], os.homedir());

      expect(result.insideWorkspace).toBe(false);
      // Realpath reveals the `.git` segment for the secret classifier.
      expect(result.canonicalPath).toBe(path.join(await fs.realpath(gitDir), 'pre-commit'));
    },
  );

  it('tilde-bashrc: a leading ~/ expands to the injected home dir (outside the workspace)', async () => {
    const ws = await makeTmp('hermes-ws-');
    const home = await makeTmp('hermes-home-');

    const result = await canonicalizeEditPath('~/.bashrc', ws, [ws], home);

    expect(result.canonicalPath).toBe(path.join(await fs.realpath(home), '.bashrc'));
    expect(result.insideWorkspace).toBe(false);
    expect(result.tildeUnresolved).toBe(false);
  });

  it('tilde-other-user: an un-expandable ~user path fails CLOSED (tildeUnresolved, not inside)', async () => {
    const ws = await makeTmp('hermes-ws-');
    const home = await makeTmp('hermes-home-');

    const result = await canonicalizeEditPath('~mallory/x', ws, [ws], home);

    expect(result.tildeUnresolved).toBe(true);
    expect(result.insideWorkspace).toBe(false);
    expect(result.relPath).toBeNull();
  });

  it('plain-in-workspace: an existing regular file is inside, relPath is POSIX workspace-relative', async () => {
    const ws = await makeTmp('hermes-ws-');
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'a.ts'), 'export {};');

    const result = await canonicalizeEditPath('src/a.ts', ws, [ws], os.homedir());

    expect(result.insideWorkspace).toBe(true);
    expect(result.relPath).toBe('src/a.ts');
    expect(result.leafIsSymlink).toBe(false);
  });

  it.skipIf(!canLinkDir)(
    'pnpm-style-in-workspace-symlink-still-inside: a file under an in-workspace dir symlink whose realpath stays inside is ALLOWED (over-denial guard)',
    async () => {
      const ws = await makeTmp('hermes-ws-');
      const realPkg = path.join(ws, 'node_modules', '.pnpm', 'foo@1', 'node_modules', 'foo');
      await fs.mkdir(realPkg, { recursive: true });
      await fs.writeFile(path.join(realPkg, 'index.js'), 'module.exports={};');
      await linkDir(realPkg, path.join(ws, 'node_modules', 'foo'));

      const result = await canonicalizeEditPath('node_modules/foo/index.js', ws, [ws], os.homedir());

      expect(result.insideWorkspace).toBe(true);
      expect(result.leafIsSymlink).toBe(false);
    },
  );

  it.skipIf(!canLinkDir)(
    'root-through-symlink: a plain file under a workspace root that is itself opened via a symlink is inside (root is realpathed too)',
    async () => {
      const base = await makeTmp('hermes-base-');
      const realRoot = path.join(base, 'real');
      await fs.mkdir(path.join(realRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(realRoot, 'src', 'a.ts'), 'export {};');
      const linkRoot = path.join(base, 'link');
      await linkDir(realRoot, linkRoot);

      const result = await canonicalizeEditPath('src/a.ts', linkRoot, [linkRoot], os.homedir());

      expect(result.insideWorkspace).toBe(true);
      expect(result.relPath).toBe('src/a.ts');
    },
  );

  it('new-file-nonexistent-leaf: a not-yet-existing target resolves via the ancestor walk-up and stays inside', async () => {
    const ws = await makeTmp('hermes-ws-');

    const result = await canonicalizeEditPath('src/new.ts', ws, [ws], os.homedir());

    expect(result.insideWorkspace).toBe(true);
    expect(result.relPath).toBe('src/new.ts');
    expect(result.leafIsSymlink).toBe(false);
  });

  it('absolute-outside: an absolute out-of-tree path is not inside (kept canonical-absolute)', async () => {
    const ws = await makeTmp('hermes-ws-');
    const outside = await makeTmp('hermes-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');

    const result = await canonicalizeEditPath(path.join(outside, 'secret.txt'), ws, [ws], os.homedir());

    expect(result.insideWorkspace).toBe(false);
    expect(result.relPath).toBeNull();
  });
});
