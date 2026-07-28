import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 14 fix-wave — Important finding: the width-refusal guard on
 * `HttpEmbedder` (embedder.ts) is only meaningful if `createIndexer`'s own
 * production wiring actually arms it (passes `expectedWidth`). Unlike
 * `indexer.test.ts`'s other describe blocks, this file deliberately does
 * NOT `vi.mock('./embedder', ...)` — it drives the REAL `HttpEmbedder`
 * exactly as `createIndexer` constructs it, stubbing only the HTTP layer
 * (`fetch`) and the native LanceDB/vscode surfaces. This is what lets the
 * test prove the constructor call in indexer.ts itself wires the guard,
 * not a mocked stand-in for it.
 */

vi.mock('./store/LanceDBStore', () => ({
  LanceDBStore: class {
    async init() {}
    async upsert() {}
    async deleteByPath() {}
    async listFileHashes() {
      return {};
    }
    async hybridSearch() {
      return [];
    }
    async close() {}
  },
}));

vi.mock('vscode', () => {
  class Disposable {
    static from(...disposables: Array<{ dispose(): void }>) {
      return { dispose: () => disposables.forEach((d) => d.dispose()) };
    }
  }
  const workspace = {
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose: () => {} }),
      onDidChange: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
  };
  return { Disposable, workspace };
});

// eslint-disable-next-line import/first -- must follow the vi.mock calls above.
import { createIndexer } from './indexer';

describe('createIndexer — width-refusal guard is armed on the real HttpEmbedder wiring (Task 14 fix-wave)', () => {
  let workspaceRoot: string;
  let indexDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-arming-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  it('refuses a build when the server returns a vector whose width does not match the configured hermes.rag.dims', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    // Models the D-1 residual case: the user configured hermes.rag.dims=768
    // (declaring the width they expect), but the runner ignores `dimensions`
    // (llama.cpp) or otherwise returns a differently-shaped vector (here: 3).
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const indexer = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      dims: 768,
    });

    await expect(indexer.build()).rejects.toThrow('embedding width mismatch');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('does not refuse when hermes.rag.dims is left at 0 (no declared width to enforce)', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const indexer = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      dims: 0,
    });

    await expect(indexer.build()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('Task 14b: the D-2 sidecar records the OBSERVED vector width and enforces it on the NEXT build, even at hermes.rag.dims=0 (the default)', () => {
  let workspaceRoot: string;
  let indexDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-widthfp-ws-'));
    // Deliberately OUTSIDE workspaceRoot (unlike this file's other describe
    // block): this test calls build() TWICE, and `.hermes-index` is not
    // itself in `DEFAULT_IGNORE_PATTERNS` (only the unrelated `.hermes` is)
    // — nesting it under workspaceRoot would make build 2's walk() pick up
    // build 1's own manifest.json/manifest.meta.json as new source files to
    // embed, which is a real but unrelated pre-existing quirk this test must
    // not become entangled with.
    indexDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-widthfp-idx-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  });

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function readMetaFixture(): Promise<unknown> {
    return JSON.parse(await fs.readFile(path.join(indexDir, 'manifest.meta.json'), 'utf8'));
  }

  it('refuses build 2 when the server returns a different vector width under the SAME model name and dims=0 — the corruption this task closes', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    // Build 1: the runner returns 4-wide vectors. `dims` is left at the
    // documented default (0, "let the server decide"), so nothing was
    // DECLARED to enforce — this build's only job is to observe and record
    // the width it actually got, for the NEXT build to enforce.
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call += 1;
      // Second call: the SAME model name now returns a DIFFERENT width —
      // models a same-name registry re-tag / runner swap in place.
      const width = call === 1 ? 4 : 2;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(width).fill(0.1) }] }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const indexer = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'qwen3-embedding:0.6b',
      dims: 0,
    });

    await expect(indexer.build()).resolves.toBeUndefined();
    const meta = await readMetaFixture();
    expect(meta).toMatchObject({ schema: 1, embedModel: 'qwen3-embedding:0.6b', dims: 0, width: 4 });

    // Build 2: SAME model name, SAME dims=0 — the D-2 fingerprint (model +
    // dims) still matches, so nothing forces a full rebuild. Change the
    // file's content so it is the one path that gets re-embedded this
    // build — an UNCHANGED file is never re-sent to the embedder at all, so
    // a same-name swap can only be observed once something is re-embedded.
    await writeWorkspaceFile('src/app.ts', 'export const x = 2;\n');

    await expect(indexer.build()).rejects.toThrow('embedding width mismatch');
  });

  it('preserves the recorded width across a no-op build (nothing changed, nothing re-embedded)', async () => {
    // Guards the hole named in the task brief: `writeMeta` always overwrites
    // the WHOLE sidecar file, so a build that embeds nothing must not drop
    // the width a PRIOR build recorded — that would silently re-open the
    // dims=0 protection gap on the very next no-op build.
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const indexer = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'qwen3-embedding:0.6b',
      dims: 0,
    });

    await indexer.build();
    expect(await readMetaFixture()).toMatchObject({ width: 4 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Build 2: nothing on disk changed, so diffContentHashes finds nothing to
    // recompute and the embedder is never called again — this is the no-op
    // build the sidecar-overwrite hole would otherwise corrupt.
    await indexer.build();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await readMetaFixture()).toMatchObject({ width: 4 });
  });
});

describe('Final-review Finding 1: computeEffectiveWidth must gate on the stored width even when the D-2 fingerprint MISMATCHES (embedModel NAME change)', () => {
  let workspaceRoot: string;
  let indexDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Same layout rationale as the "Task 14b" describe block above: indexDir
    // lives outside workspaceRoot so build 2's walk() does not pick up build
    // 1's own manifest.json/manifest.meta.json as new source files.
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-namechange-ws-'));
    indexDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-namechange-idx-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  });

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  it('refuses build 2 when embedModel NAME changes (fingerprint mismatch) AND the new model returns a different vector width, at dims=0', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    // Build 1 (model-a) observes and records width 4. Build 2 uses a
    // DIFFERENT model NAME (model-b) — the D-2 fingerprint (embedModel + dims)
    // MISMATCHES, which already forces a full recompute of every file
    // (indexer.ts's `toCompute` branch), independent of width. Model-b's
    // server returns width 2 for that recompute.
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call += 1;
      const width = call === 1 ? 4 : 2;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(width).fill(0.1) }] }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const indexer1 = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'model-a',
      dims: 0,
    });
    await expect(indexer1.build()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The LanceDB table created by build 1 is FIXED at width 4 and is never
    // recreated by init() (it just opens the existing table) — so build 2
    // embedding at width 2 into that same table is the silent
    // truncate/null-pad corruption this fix closes. A NEW createIndexer
    // instance models a real-world model-name change (a fresh activation
    // with a different `hermes.embedModel` setting), which is exactly when
    // the fingerprint mismatches.
    const indexer2 = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'model-b',
      dims: 0,
    });
    await expect(indexer2.build()).rejects.toThrow('embedding width mismatch');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
