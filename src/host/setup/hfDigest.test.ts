import { describe, it, expect, vi } from 'vitest';
import { verifyHfDigest } from './hfDigest';

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
});
