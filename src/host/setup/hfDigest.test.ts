import { describe, it, expect, vi } from 'vitest';
import { verifyHfDigest, resolveLfsOid } from './hfDigest';

/**
 * T13 (beta5-setup-hardening-architecture.md §4.4.3c / §0.3): the HF-tree
 * digest pre-flight. Canned tree JSON only — the fetch seam is a fake; the
 * REAL binding (`setupHost.vscode.ts`) is one line over `globalThis.fetch`.
 *
 * The two load-bearing security properties, each with its own test:
 *  - exact-file-set equality against `allowedRepoFiles` (S-F4 — a smuggled
 *    `system`/`template`/`params` file must refuse);
 *  - `lfs.oid` ONLY, never the git-SHA1 `oid` (S-F16b — an entry carrying
 *    `oid === pin` but NO `lfs` must refuse: a fallback reader would pass).
 */

const PIN = 'f'.repeat(64);
const GGUF = {
  hfRepo: 'SyntinalCo/sweep-next-edit-v2-7B-GGUF',
  file: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
  sha256: PIN,
  allowedRepoFiles: ['sweep-next-edit-v2-7B-Q4_K_M.gguf', 'README.md', '.gitattributes'] as const,
};

const TREE_URL = 'https://huggingface.co/api/models/SyntinalCo/sweep-next-edit-v2-7B-GGUF/tree/main?recursive=true';

interface TreeEntry {
  type?: string;
  path: string;
  oid?: string;
  size?: number;
  lfs?: { oid?: string; size?: number; pointerSize?: number };
}

function goodTree(): TreeEntry[] {
  return [
    { type: 'file', path: '.gitattributes', oid: '0b1c2d3e', size: 1519 },
    { type: 'file', path: 'README.md', oid: '4a5b6c7d', size: 812 },
    {
      type: 'file',
      path: 'sweep-next-edit-v2-7B-Q4_K_M.gguf',
      oid: '8e9f0a1b',
      size: 4_680_000_000,
      lfs: { oid: PIN, size: 4_680_000_000, pointerSize: 135 },
    },
  ];
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('verifyHfDigest', () => {
  it('passes a tree whose file set exactly equals allowedRepoFiles and whose gguf entry carries lfs.oid === pin', async () => {
    const fetchImpl = fetchReturning(goodTree());
    await expect(verifyHfDigest(fetchImpl, GGUF)).resolves.toEqual({ ok: true });
  });

  it('GETs the pinned tree API URL with an abort signal attached', async () => {
    const fetchImpl = fetchReturning(goodTree());
    await verifyHfDigest(fetchImpl, GGUF);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(url).toBe(TREE_URL);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a tree with an EXTRA file (smuggled `system` — S-F4)', async () => {
    const tree = [...goodTree(), { type: 'file', path: 'system', oid: 'ffff', size: 40 }];
    const result = await verifyHfDigest(fetchReturning(tree), GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses a tree MISSING an allowed file (set equality is two-sided)', async () => {
    const tree = goodTree().filter((e) => e.path !== 'README.md');
    const result = await verifyHfDigest(fetchReturning(tree), GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses when the gguf entry lfs.oid mismatches the pin', async () => {
    const tree = goodTree();
    tree[2]!.lfs = { oid: 'a'.repeat(64), size: 4_680_000_000 };
    const result = await verifyHfDigest(fetchReturning(tree), GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses an entry carrying git-SHA1 `oid` === pin but NO `lfs` (S-F16b — no fallback, ever)', async () => {
    const tree = goodTree();
    // The trap: a checker that falls back to `oid` would see the pin and pass.
    tree[2] = { type: 'file', path: GGUF.file, oid: PIN, size: 4_680_000_000 };
    const result = await verifyHfDigest(fetchReturning(tree), GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses on a non-2xx tree response', async () => {
    const result = await verifyHfDigest(fetchReturning(goodTree(), 500), GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses when fetch rejects (network failure)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND huggingface.co');
    }) as unknown as typeof fetch;
    const result = await verifyHfDigest(fetchImpl, GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses a non-array body (unexpected API shape)', async () => {
    const result = await verifyHfDigest(fetchReturning({ error: 'nope' }), GGUF);
    expect(result.ok).toBe(false);
  });

  it('refuses when json() rejects (malformed body)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('bad json');
      },
    })) as unknown as typeof fetch;
    const result = await verifyHfDigest(fetchImpl, GGUF);
    expect(result.ok).toBe(false);
  });

  it('normalizes an UPPERCASE pin to lowercase before comparing to lfs.oid (final-fixwave Fix 1 — a mis-cased publication pin still verifies)', async () => {
    const upperGguf = { ...GGUF, sha256: PIN.toUpperCase() };
    expect(upperGguf.sha256).not.toBe(PIN); // sanity: this really is a different string
    const result = await verifyHfDigest(fetchReturning(goodTree()), upperGguf);
    expect(result).toEqual({ ok: true });
  });

  it('aborts (and refuses) when the tree API hangs past 10 s', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch;
      const pending = verifyHfDigest(fetchImpl, GGUF);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a tree response carrying a `Link: rel="next"` pagination header (T2/SC-A-1 — never verify a possibly truncated tree, even when the page itself parses clean)', async () => {
    const fetchImpl = fetchReturningPaginated(goodTree());
    const result = await verifyHfDigest(fetchImpl, GGUF);
    expect(result.ok).toBe(false);
  });
});

/**
 * T2 (beta6-unified-local-model-onboarding-architecture.md §2.2.5 / §2.4):
 * `resolveLfsOid` — the live-oid resolver for the allowlist tier. Shares the
 * tree-fetch/shape-validation core with `verifyHfDigest` (extracted this
 * task) but makes NO exact-file-set claim — it looks up exactly one file's
 * `lfs.oid` and asserts its shape.
 *
 * Load-bearing properties, each with its own test:
 *  - oid-shape: only a 64-hex-char `lfs.oid` resolves; anything else refuses
 *    (a git-SHA1-length string smuggled into `lfs.oid` must NOT pass).
 *  - lfs-only: an entry carrying a top-level git-SHA1 `oid` but no `lfs`
 *    block refuses — never a fallback to the unauthenticated oid.
 *  - pagination-refuse: a `Link: rel="next"` marker refuses, same as
 *    `verifyHfDigest`.
 *  - HTTP-error / timeout / malformed-shape / network-failure all refuse.
 *  - never throws: every failure mode resolves to `{ok:false, reason}`.
 */
function fetchReturningPaginated(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'link'
          ? '<https://huggingface.co/api/models/x/tree/main?recursive=true&cursor=abc>; rel="next"'
          : null,
    },
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('resolveLfsOid', () => {
  const REPO = 'Qwen/Qwen2.5-Coder-1.5B-Q8_0-GGUF';
  const FILE = 'qwen2.5-coder-1.5b-q8_0.gguf';
  const VALID_OID = 'a'.repeat(64);

  function treeWithEntry(entry: TreeEntry): TreeEntry[] {
    return [{ type: 'file', path: 'README.md', oid: '4a5b6c7d', size: 100 }, entry];
  }

  it('resolves the lfs.oid of a well-formed 64-hex-char entry', async () => {
    const tree = treeWithEntry({
      type: 'file',
      path: FILE,
      oid: 'deadbeef',
      size: 123,
      lfs: { oid: VALID_OID, size: 123, pointerSize: 130 },
    });
    const result = await resolveLfsOid(fetchReturning(tree), REPO, FILE);
    expect(result).toEqual({ ok: true, oid: VALID_OID });
  });

  it('refuses an entry carrying only the top-level git-SHA1 `oid` with no `lfs` block (lfs-only)', async () => {
    const tree = treeWithEntry({ type: 'file', path: FILE, oid: 'a'.repeat(40), size: 123 });
    const result = await resolveLfsOid(fetchReturning(tree), REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('refuses an lfs.oid that is not a 64-hex-char string (a git-SHA1-length value smuggled into lfs.oid must not pass)', async () => {
    const tree = treeWithEntry({
      type: 'file',
      path: FILE,
      oid: 'deadbeef',
      size: 123,
      lfs: { oid: 'a'.repeat(40), size: 123 },
    });
    const result = await resolveLfsOid(fetchReturning(tree), REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('refuses when the target file is absent from the tree', async () => {
    const tree = [{ type: 'file', path: 'README.md', oid: '4a5b6c7d', size: 100 }];
    const result = await resolveLfsOid(fetchReturning(tree), REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('refuses a tree response carrying a `Link: rel="next"` pagination header', async () => {
    const tree = treeWithEntry({
      type: 'file',
      path: FILE,
      oid: 'deadbeef',
      size: 123,
      lfs: { oid: VALID_OID, size: 123 },
    });
    const result = await resolveLfsOid(fetchReturningPaginated(tree), REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('refuses on a non-2xx tree response', async () => {
    const result = await resolveLfsOid(fetchReturning([], 500), REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('refuses when fetch rejects (network failure) and never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND huggingface.co');
    }) as unknown as typeof fetch;
    await expect(resolveLfsOid(fetchImpl, REPO, FILE)).resolves.toMatchObject({ ok: false });
  });

  it('refuses when fetch throws synchronously and never throws out of resolveLfsOid itself', async () => {
    const fetchImpl = (() => {
      throw new Error('synchronous boom');
    }) as unknown as typeof fetch;
    await expect(resolveLfsOid(fetchImpl, REPO, FILE)).resolves.toMatchObject({ ok: false });
  });

  it('refuses a non-array body (malformed API shape)', async () => {
    const result = await resolveLfsOid(fetchReturning({ error: 'nope' }), REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('refuses when json() rejects (malformed body)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('bad json');
      },
    })) as unknown as typeof fetch;
    const result = await resolveLfsOid(fetchImpl, REPO, FILE);
    expect(result.ok).toBe(false);
  });

  it('aborts (and refuses) when the tree API hangs past 10 s', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch;
      const pending = resolveLfsOid(fetchImpl, REPO, FILE);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('GETs the tree API URL for the given repo with an abort signal attached', async () => {
    const tree = treeWithEntry({
      type: 'file',
      path: FILE,
      oid: 'deadbeef',
      size: 123,
      lfs: { oid: VALID_OID, size: 123 },
    });
    const fetchImpl = fetchReturning(tree);
    await resolveLfsOid(fetchImpl, REPO, FILE);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(url).toBe(`https://huggingface.co/api/models/${REPO}/tree/main?recursive=true`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
