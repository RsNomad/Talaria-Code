import { describe, it, expect } from 'vitest';
import {
  storeRoot,
  ggufDest,
  lstatCheckedGgufDest,
  scanPresence,
  readSidecar,
  type ModelStoreLstatIo,
  type ModelStorePresenceIo,
} from './modelStore';
import type { CatalogModel } from './modelCatalog';
import type { GgufStoreSidecar } from './ggufIngest';

/**
 * modelStore.test.ts — T4 (beta6-unified-local-model-onboarding-architecture.md
 * §2.2.8 / §2.4 line 307). Pure, injected-fs-seam module: every disk touch in
 * these tests goes through an in-memory fake (`ModelStoreLstatIo`/
 * `ModelStorePresenceIo`), never the real filesystem — same discipline
 * `ggufIngest.test.ts` establishes one module over. `storeRoot`/`ggufDest`
 * are synchronous and take no io at all (pure functions over strings).
 */

// --- storeRoot ---------------------------------------------------------------

describe('storeRoot — fail-closed XDG/HOME resolution (SC-A-10)', () => {
  it('uses $XDG_DATA_HOME when set (non-empty)', () => {
    const result = storeRoot({ XDG_DATA_HOME: '/data/xdg', HOME: '/home/u' });
    expect(result).toEqual({ ok: true, root: '/data/xdg/talaria/models' });
  });

  it('falls back to $HOME/.local/share when $XDG_DATA_HOME is unset', () => {
    const result = storeRoot({ HOME: '/home/u' });
    expect(result).toEqual({ ok: true, root: '/home/u/.local/share/talaria/models' });
  });

  it('an EMPTY $XDG_DATA_HOME is treated as unset — falls through to $HOME', () => {
    const result = storeRoot({ XDG_DATA_HOME: '', HOME: '/home/u' });
    expect(result).toEqual({ ok: true, root: '/home/u/.local/share/talaria/models' });
  });

  it('refuses (typed failure, never a bare/relative path) when NEITHER $XDG_DATA_HOME nor $HOME is set', () => {
    const result = storeRoot({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).not.toMatch(/^\//); // the failure is a reason string, never itself a path
    }
  });

  it('refuses when both $XDG_DATA_HOME and $HOME are empty strings — NEVER a hardcoded /.local/share/… fallback (SC-A-10)', () => {
    const result = storeRoot({ XDG_DATA_HOME: '', HOME: '' });
    expect(result.ok).toBe(false);
  });

  it('a trailing slash on $XDG_DATA_HOME does not produce a double slash', () => {
    const result = storeRoot({ XDG_DATA_HOME: '/data/xdg/' });
    expect(result).toEqual({ ok: true, root: '/data/xdg/talaria/models' });
  });
});

// --- ggufDest ------------------------------------------------------------------

const ROOT = '/data/xdg/talaria/models';

describe('ggufDest — two-level layout + charset re-assert', () => {
  it('composes <root>/<owner>/<repo>/<file> (two-level, owner and repo as SEPARATE dirs)', () => {
    const result = ggufDest(ROOT, 'ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF', 'qwen2.5-coder-1.5b-q8_0.gguf');
    expect(result).toEqual({
      ok: true,
      destDir: '/data/xdg/talaria/models/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF',
      destFile: 'qwen2.5-coder-1.5b-q8_0.gguf',
      destPath: '/data/xdg/talaria/models/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF/qwen2.5-coder-1.5b-q8_0.gguf',
    });
  });

  it("collision property: 'a/b__c' and 'a__b/c' never collapse to the same destDir (the __-flattening collision, A-4)", () => {
    const first = ggufDest(ROOT, 'a/b__c', 'file.gguf');
    const second = ggufDest(ROOT, 'a__b/c', 'file.gguf');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.destDir).not.toBe(second.destDir);
      expect(first.destDir).toBe('/data/xdg/talaria/models/a/b__c');
      expect(second.destDir).toBe('/data/xdg/talaria/models/a__b/c');
    }
  });

  it('refuses an hfRepo with no "/" (not exactly owner/repo)', () => {
    const result = ggufDest(ROOT, 'no-slash-here', 'file.gguf');
    expect(result.ok).toBe(false);
  });

  it('refuses an hfRepo with more than one "/"', () => {
    const result = ggufDest(ROOT, 'owner/repo/extra', 'file.gguf');
    expect(result.ok).toBe(false);
  });

  it('refuses a bad-charset owner segment (e.g. a leading "..")', () => {
    const result = ggufDest(ROOT, '../evil-org/x', 'file.gguf');
    expect(result.ok).toBe(false);
  });

  it('refuses a bad-charset repo segment (e.g. unicode homoglyph)', () => {
    const result = ggufDest(ROOT, 'owner/rеpo', 'file.gguf'); // Cyrillic е
    expect(result.ok).toBe(false);
  });

  it('refuses a file containing "/" (the T3->T4 boundary item #2 — path-separator store escape)', () => {
    const result = ggufDest(ROOT, 'owner/repo', 'sub/dir/file.gguf');
    expect(result.ok).toBe(false);
  });

  it('refuses a file that is exactly ".."', () => {
    const result = ggufDest(ROOT, 'owner/repo', '..');
    expect(result.ok).toBe(false);
  });

  it('refuses a file that is exactly "."', () => {
    const result = ggufDest(ROOT, 'owner/repo', '.');
    expect(result.ok).toBe(false);
  });
});

// --- lstatCheckedGgufDest (symlink refusals, SC-A-3) --------------------------

function fakeLstatIo(symlinks: Set<string>, existing: Set<string>): ModelStoreLstatIo {
  return {
    lstat: async (path: string) => {
      if (!existing.has(path) && !symlinks.has(path)) return null;
      return { isSymbolicLink: () => symlinks.has(path) };
    },
  };
}

describe('lstatCheckedGgufDest — symlink lstat refusals at every level (SC-A-3, the T3->T4 boundary item #1)', () => {
  const OWNER_DIR = '/data/xdg/talaria/models/ggml-org';
  const REPO_DIR = '/data/xdg/talaria/models/ggml-org/repo';

  it('refuses when the STORE ROOT itself is a symlink', async () => {
    const io = fakeLstatIo(new Set([ROOT]), new Set([ROOT]));
    const result = await lstatCheckedGgufDest(io, ROOT, 'ggml-org/repo', 'file.gguf');
    expect(result.ok).toBe(false);
  });

  it('refuses when the <owner> level is a symlink', async () => {
    const io = fakeLstatIo(new Set([OWNER_DIR]), new Set([OWNER_DIR]));
    const result = await lstatCheckedGgufDest(io, ROOT, 'ggml-org/repo', 'file.gguf');
    expect(result.ok).toBe(false);
  });

  it('refuses when the <repo> level is a symlink', async () => {
    const io = fakeLstatIo(new Set([REPO_DIR]), new Set([REPO_DIR]));
    const result = await lstatCheckedGgufDest(io, ROOT, 'ggml-org/repo', 'file.gguf');
    expect(result.ok).toBe(false);
  });

  it('succeeds when every level exists and is a REGULAR directory (never lstat-refused)', async () => {
    const io = fakeLstatIo(new Set(), new Set([ROOT, OWNER_DIR, REPO_DIR]));
    const result = await lstatCheckedGgufDest(io, ROOT, 'ggml-org/repo', 'file.gguf');
    expect(result).toEqual({
      ok: true,
      destDir: REPO_DIR,
      destFile: 'file.gguf',
      destPath: `${REPO_DIR}/file.gguf`,
    });
  });

  it('succeeds when levels do not exist yet (lstat -> null is NOT a refusal — mkdir -p will create them)', async () => {
    const io = fakeLstatIo(new Set(), new Set());
    const result = await lstatCheckedGgufDest(io, ROOT, 'ggml-org/repo', 'file.gguf');
    expect(result.ok).toBe(true);
  });

  it('propagates a ggufDest charset refusal WITHOUT ever calling lstat (fail-closed before any fs touch)', async () => {
    let lstatCalls = 0;
    const io: ModelStoreLstatIo = {
      lstat: async () => {
        lstatCalls++;
        return null;
      },
    };
    const result = await lstatCheckedGgufDest(io, ROOT, '../repo', 'file.gguf');
    expect(result.ok).toBe(false);
    expect(lstatCalls).toBe(0);
  });
});

// --- readSidecar ---------------------------------------------------------------

describe('readSidecar — parse + shape-validate, fail-closed on malformed', () => {
  const VALID: GgufStoreSidecar = {
    catalogId: 'qwen25-coder-1.5b',
    sha256: 'a'.repeat(64),
    bytes: 1_646_573_056,
    verifiedAt: '2026-08-06T00:00:00.000Z',
  };

  it('parses a well-formed sidecar', () => {
    expect(readSidecar(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('returns null for invalid JSON (never throws)', () => {
    expect(readSidecar('{not json')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const { bytes: _bytes, ...rest } = VALID;
    expect(readSidecar(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when a field has the wrong type (bytes as a string)', () => {
    expect(readSidecar(JSON.stringify({ ...VALID, bytes: '1646573056' }))).toBeNull();
  });

  it('returns null for a bare JSON array (not an object)', () => {
    expect(readSidecar('[]')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(readSidecar('null')).toBeNull();
  });
});

// --- scanPresence (sidecar presence truth table, NO hashing) -----------------

const FIXTURE_MODEL: CatalogModel = {
  id: 'fixture-model',
  role: 'fim',
  displayName: 'Fixture Model',
  publisher: 'ggml-org',
  license: 'Apache-2.0',
  vramLine: 'n/a',
  llamacpp: {
    gguf: {
      hfRepo: 'ggml-org/Fixture-GGUF',
      file: 'fixture-q8_0.gguf',
      quant: 'Q8_0',
      approxBytes: 1000,
    },
    verify: { mode: 'live-oid' },
  },
};

const OLLAMA_ONLY_MODEL: CatalogModel = {
  id: 'ollama-only-model',
  role: 'embedding',
  displayName: 'Ollama Only',
  publisher: 'Qwen',
  license: 'Apache-2.0',
  vramLine: 'n/a',
  ollama: { tier: 'library', tag: 'ollama-only:tag', approxBytes: 1000 },
};

const FIXTURE_DEST = `${ROOT}/ggml-org/Fixture-GGUF/fixture-q8_0.gguf`;
const FIXTURE_SIDECAR_PATH = `${FIXTURE_DEST}.talaria.json`;

function fakePresenceIo(
  env: Readonly<Record<string, string | undefined>>,
  files: Record<string, string>,
  sizes: Record<string, number>,
): ModelStorePresenceIo & { readCalls: string[]; statCalls: string[] } {
  const readCalls: string[] = [];
  const statCalls: string[] = [];
  return {
    env,
    readCalls,
    statCalls,
    readFile: async (path: string) => {
      readCalls.push(path);
      return path in files ? files[path]! : null;
    },
    statSize: async (path: string) => {
      statCalls.push(path);
      return path in sizes ? sizes[path]! : null;
    },
  };
}

const XDG_ENV = { XDG_DATA_HOME: '/data/xdg' };

describe('scanPresence — sidecar presence truth table (§2.2.8, NO hashing on scan)', () => {
  it('present: sidecar well-formed AND on-disk byte-size === sidecar.bytes', async () => {
    const sidecar: GgufStoreSidecar = {
      catalogId: 'fixture-model',
      sha256: 'b'.repeat(64),
      bytes: 12345,
      verifiedAt: '2026-08-06T00:00:00.000Z',
    };
    const io = fakePresenceIo(
      XDG_ENV,
      { [FIXTURE_SIDECAR_PATH]: JSON.stringify(sidecar) },
      { [FIXTURE_DEST]: 12345 },
    );
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(true);
  });

  it('absent: a right-sized FOREIGN file with NO sidecar', async () => {
    const io = fakePresenceIo(XDG_ENV, {}, { [FIXTURE_DEST]: 12345 });
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(false);
  });

  it('absent: only a ".part" temp file exists on disk (never the final filename) — no sidecar, no final file', async () => {
    const partPath = `${ROOT}/ggml-org/Fixture-GGUF/deadbeef.part`;
    const io = fakePresenceIo(XDG_ENV, {}, { [partPath]: 12345 });
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(false);
  });

  it('absent: sidecar well-formed but on-disk size MISMATCHES sidecar.bytes', async () => {
    const sidecar: GgufStoreSidecar = {
      catalogId: 'fixture-model',
      sha256: 'c'.repeat(64),
      bytes: 12345,
      verifiedAt: '2026-08-06T00:00:00.000Z',
    };
    const io = fakePresenceIo(
      XDG_ENV,
      { [FIXTURE_SIDECAR_PATH]: JSON.stringify(sidecar) },
      { [FIXTURE_DEST]: 99 }, // wrong size
    );
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(false);
  });

  it('absent: malformed sidecar (invalid JSON) even though the file exists at the right size', async () => {
    const io = fakePresenceIo(XDG_ENV, { [FIXTURE_SIDECAR_PATH]: '{not valid json' }, { [FIXTURE_DEST]: 12345 });
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(false);
  });

  it('absent: nothing on disk at all (missing file, missing sidecar)', async () => {
    const io = fakePresenceIo(XDG_ENV, {}, {});
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(false);
  });

  it('never hashes on scan: statSize/readFile fakes never receive any hashing-shaped call — the sidecar bytes count alone decides presence', async () => {
    // Structural proof: fakePresenceIo exposes ONLY readFile/statSize (no
    // digest/hash seam exists on ModelStorePresenceIo at all) — if this test
    // compiles and passes, scanPresence cannot be hashing bytes on scan.
    const sidecar: GgufStoreSidecar = {
      catalogId: 'fixture-model',
      sha256: 'd'.repeat(64),
      bytes: 12345,
      verifiedAt: '2026-08-06T00:00:00.000Z',
    };
    const io = fakePresenceIo(
      XDG_ENV,
      { [FIXTURE_SIDECAR_PATH]: JSON.stringify(sidecar) },
      { [FIXTURE_DEST]: 12345 },
    );
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(true);
    expect(io.readCalls).toEqual([FIXTURE_SIDECAR_PATH]);
    expect(io.statCalls).toEqual([FIXTURE_DEST]);
  });

  it('a catalog model with NO llamacpp offering is excluded from the returned map entirely', async () => {
    const io = fakePresenceIo(XDG_ENV, {}, {});
    const result = await scanPresence(io, [OLLAMA_ONLY_MODEL]);
    expect(result.has('ollama-only-model')).toBe(false);
  });

  it('fail-closed: storeRoot refusal (no XDG, no HOME) marks every eligible model absent WITHOUT touching fs', async () => {
    const io = fakePresenceIo({}, {}, {});
    const result = await scanPresence(io, [FIXTURE_MODEL]);
    expect(result.get('fixture-model')).toBe(false);
    expect(io.readCalls).toEqual([]);
    expect(io.statCalls).toEqual([]);
  });

  it('scans multiple catalog rows independently', async () => {
    const other: CatalogModel = {
      ...FIXTURE_MODEL,
      id: 'fixture-model-2',
      llamacpp: {
        gguf: { hfRepo: 'ggml-org/Other-GGUF', file: 'other-q8_0.gguf', quant: 'Q8_0', approxBytes: 500 },
        verify: { mode: 'live-oid' },
      },
    };
    const otherDest = `${ROOT}/ggml-org/Other-GGUF/other-q8_0.gguf`;
    const sidecar: GgufStoreSidecar = {
      catalogId: 'fixture-model-2',
      sha256: 'e'.repeat(64),
      bytes: 500,
      verifiedAt: '2026-08-06T00:00:00.000Z',
    };
    const io = fakePresenceIo(XDG_ENV, { [`${otherDest}.talaria.json`]: JSON.stringify(sidecar) }, { [otherDest]: 500 });
    const result = await scanPresence(io, [FIXTURE_MODEL, other]);
    expect(result.get('fixture-model')).toBe(false); // nothing on disk for this one
    expect(result.get('fixture-model-2')).toBe(true);
  });
});
