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

/** See ollamaClient.test.ts's identical alias: `ReadableStreamReadResult` isn't a
 *  global type name under this repo's `lib: ["ES2022"]` tsconfig. */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/** A fake `ReadableStream<Uint8Array>`-shaped body backed by a fixed list of
 *  already-encoded chunks, delivered one per `read()` call in order (local
 *  copy of ollamaClient.test.ts's F2-15 idiom — this suite's fetch fakes
 *  gained streamable bodies for CA-08, WS-SU Task 15). */
function chunkedBody(chunks: Uint8Array[]): { getReader: () => ReadableStreamDefaultReader<Uint8Array> } {
  let i = 0;
  const reader = {
    read: async (): Promise<StreamReadResult> => {
      const value = chunks[i];
      if (value === undefined) {
        return { value: undefined, done: true };
      }
      i += 1;
      return { value, done: false };
    },
    cancel: async () => {},
    releaseLock: () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { getReader: () => reader };
}

// CA-08 (WS-SU Task 15): fetchHfTree now reads the BODY stream (byte-capped)
// instead of calling response.json() — every 200-fake below carries a real
// streamable body.
function fetchReturning(body: unknown, status = 200): typeof fetch {
  const chunk = new TextEncoder().encode(JSON.stringify(body));
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    body: chunkedBody([chunk]),
  })) as unknown as typeof fetch;
}

/** CA-08: a 200(-by-default) fake whose body is exactly `text`, delivered
 *  through the same `chunkedBody` reader idiom — lets tests drive
 *  `fetchHfTree`'s byte-capped body read (and its downstream `JSON.parse`)
 *  directly, including deliberately oversized or malformed text. */
function treeFetchWithBody(text: string, status = 200): typeof fetch {
  const chunk = new TextEncoder().encode(text);
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    body: chunkedBody([chunk]),
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

  it('refuses when the body is not valid JSON (malformed body — CA-08: JSON.parse now throws, not response.json())', async () => {
    const result = await verifyHfDigest(treeFetchWithBody('{not valid json'), GGUF);
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
  const chunk = new TextEncoder().encode(JSON.stringify(body));
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
    body: chunkedBody([chunk]),
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

  it('refuses when the body is not valid JSON (malformed body — CA-08: JSON.parse now throws, not response.json())', async () => {
    const result = await resolveLfsOid(treeFetchWithBody('{not valid json'), REPO, FILE);
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

/**
 * CA-08 (WS-SU Task 15, frozen zone, owner-approved): `fetchHfTree` reads
 * the tree body through a byte-capped reader — a 4th refusal arm beside
 * pagination (:116-121) / non-200 (:122-123) / shape (:132-152). A
 * compromised/MITM'd endpoint streaming an oversized body must refuse
 * BEFORE buffering past the ceiling (no OOM, no partial parse).
 */
describe('CA-08 (frozen, owner-approved): the tree read is byte-capped', () => {
  it('an oversized tree body refuses {ok:false} without a partial parse', async () => {
    const huge = `[${Array.from({ length: 200_000 }, (_, i) => `{"path":"f${i}.bin"}`).join(',')}]`; // > 4 MiB
    const fetchImpl = treeFetchWithBody(huge);
    const verdict = await verifyHfDigest(fetchImpl, GGUF);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('exceeded');
  });

  it('a 200 with no readable body refuses {ok:false}', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
    })) as unknown as typeof fetch;
    const result = await verifyHfDigest(fetchImpl, GGUF);
    expect(result.ok).toBe(false);
  });

  // 'every existing verify/resolve behavior is unchanged for in-cap bodies':
  // the pre-existing suite above, running green against the streamed
  // fixtures (`fetchReturning`/`fetchReturningPaginated`/`treeFetchWithBody`),
  // IS this assertion — no separate test body needed here.
});
