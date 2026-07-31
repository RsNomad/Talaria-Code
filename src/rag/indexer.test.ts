import { promises as fs, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W5-T6 — RAG index path-filter security fix. Extended by SEC-1 (audit-3):
 * a PATH-only gate stops a `.env`/`id_rsa`-class FILE from being indexed at
 * all, but says nothing about a secret living INSIDE a normally-named file
 * (e.g. an API key in `src/config.ts`) — that content used to be chunked,
 * embedded, and stored verbatim. `reindexFiles` now also runs the real
 * `scanSnippetForSecrets` content gate per chunk before it is embedded, so
 * these tests exercise BOTH layers together, not just the path layer.
 *
 * `createIndexer` is orchestration glue over `LanceDBStore`/`HttpEmbedder`
 * (native/HTTP surface), so those are mocked here exactly like the rest of
 * `src/rag` keeps native deps behind interfaces for testability. The real
 * `node:fs`, chunker, gitignore filter, and secret scanner run against a
 * throwaway temp workspace so these tests exercise the actual
 * walk/reindex/manifest/scan logic, not a re-description of it.
 */
const { upsertMock, deleteByPathMock, initMock, closeMock, embedMock } = vi.hoisted(() => ({
  // Typed with the one field the D-2 tests below read back (`path`), so
  // `upsertMock.mock.calls` carries real argument types instead of `[]` —
  // the mock's runtime behavior (ignore the argument, resolve void) is
  // unchanged.
  upsertMock: vi.fn(async (_records: Array<{ path: string }>) => {}),
  deleteByPathMock: vi.fn(async (_path: string) => {}),
  initMock: vi.fn(async () => {}),
  closeMock: vi.fn(async () => {}),
  embedMock: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
}));

vi.mock('./store/LanceDBStore', () => ({
  LanceDBStore: class {
    init = initMock;
    upsert = upsertMock;
    deleteByPath = deleteByPathMock;
    listFileHashes = vi.fn(async () => ({}));
    hybridSearch = vi.fn(async () => []);
    close = closeMock;
  },
}));

vi.mock('./embedder', () => ({
  HttpEmbedder: class {
    embed = embedMock;
  },
}));

/**
 * B-10 isolation only (see the test below that uses it): `walk()`
 * (indexer.ts:161) and the self-heal purge loop (indexer.ts:257-262) call
 * the SAME `isSecretForCompletion`, so with the real classifier a secret
 * path can never reach `current` — meaning the ordinary
 * stored-but-absent-from-current delete pass (`diffContentHashes`) already
 * purges any secret-only-in-manifest entry, independent of the purge loop.
 * This wrapper lets ONE test make walk()'s classifier call disagree with
 * the purge loop's, to exercise the purge loop's own branch. Every other
 * test in this file gets the real, unmocked classifier (the wrapped
 * default), so this changes nothing for them.
 */
const { isSecretForCompletionBox } = vi.hoisted(() => ({
  isSecretForCompletionBox: {
    actual: (_p: string): boolean => {
      throw new Error('isSecretForCompletion real implementation not captured yet');
    },
  },
}));

vi.mock('../shared/secretPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/secretPaths')>();
  isSecretForCompletionBox.actual = actual.isSecretForCompletion;
  return { ...actual, isSecretForCompletion: vi.fn(actual.isSecretForCompletion) };
});

const fsWatcherListeners = vi.hoisted(() => ({
  create: [] as Array<(uri: { fsPath: string }) => void>,
  change: [] as Array<(uri: { fsPath: string }) => void>,
  delete: [] as Array<(uri: { fsPath: string }) => void>,
}));

vi.mock('vscode', () => {
  class Disposable {
    static from(...disposables: Array<{ dispose(): void }>) {
      return { dispose: () => disposables.forEach((d) => d.dispose()) };
    }
  }
  const workspace = {
    createFileSystemWatcher: () => ({
      onDidCreate: (cb: (uri: { fsPath: string }) => void) => {
        fsWatcherListeners.create.push(cb);
        return { dispose: () => {} };
      },
      onDidChange: (cb: (uri: { fsPath: string }) => void) => {
        fsWatcherListeners.change.push(cb);
        return { dispose: () => {} };
      },
      onDidDelete: (cb: (uri: { fsPath: string }) => void) => {
        fsWatcherListeners.delete.push(cb);
        return { dispose: () => {} };
      },
      dispose: () => {},
    }),
  };
  return { Disposable, workspace };
});

// --- AUDIT-5 Task 1: symlink capability probes (duplicated from
// pathConfine.test.ts's canLinkDir pattern — module-private there). Junction
// fallback keeps the dir-link cases running on a Windows dev box without
// SeCreateSymbolicLinkPrivilege; file links have no junction form, so that
// one case skips on such a box (always runs on the Fedora target).
function linkDirSync(target: string, link: string): void {
  try {
    symlinkSync(target, link, 'dir');
  } catch {
    symlinkSync(target, link, 'junction');
  }
}
const canLinkDir = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-symcap-'));
    mkdirSync(path.join(dir, 't'));
    linkDirSync(path.join(dir, 't'), path.join(dir, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
})();
const canLinkFile = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'talaria-symcap-f-'));
    writeFileSync(path.join(dir, 't.txt'), 'x');
    symlinkSync(path.join(dir, 't.txt'), path.join(dir, 'l.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
})();

// eslint-disable-next-line import/first -- must follow the vi.mock calls above.
import { hashContent } from './contentHash';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above.
import { createIndexer } from './indexer';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above; this is the mocked (wrapped) export.
import { isSecretForCompletion } from '../shared/secretPaths';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above. NOT mocked in this
// file — the real scanner runs against real chunk content (SEC-1, audit-3).
import { scanSnippetForSecrets } from '../autocomplete/context/secretScanner';

describe('createIndexer — secret-path filtering (W5-T6)', () => {
  let workspaceRoot: string;
  let indexDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();
    fsWatcherListeners.create.length = 0;
    fsWatcherListeners.change.length = 0;
    fsWatcherListeners.delete.length = 0;
  });

  afterEach(() => {
    // undo any per-test override (see the B-10 isolation test below) so
    // later tests keep getting the real classifier.
    vi.mocked(isSecretForCompletion).mockImplementation(isSecretForCompletionBox.actual);
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeIndexer(debounceMs = 10) {
    return createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      debounceMs,
    });
  }

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function readManifest(): Promise<Record<string, string>> {
    const raw = await fs.readFile(path.join(indexDir, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  }

  it('never collects/reindexes secret-path files during a full build', async () => {
    await writeWorkspaceFile('.env', 'SECRET=shhh\n');
    await writeWorkspaceFile('config/id_rsa', 'not a real key but the name is the secret\n');
    await writeWorkspaceFile('.aws/credentials', '[default]\naws_access_key_id=AKIAEXAMPLE\n');

    const indexer = makeIndexer();
    await indexer.build();

    expect(upsertMock).not.toHaveBeenCalled();

    const manifest = await readManifest();
    expect(manifest['.env']).toBeUndefined();
    expect(manifest['config/id_rsa']).toBeUndefined();
    expect(manifest['.aws/credentials']).toBeUndefined();
  });

  it('still indexes a non-secret file normally (regression)', async () => {
    await writeWorkspaceFile('src/app.txt', 'hello world, an ordinary file with real content to chunk.\n');

    const indexer = makeIndexer();
    await indexer.build();

    expect(upsertMock).toHaveBeenCalled();
    const manifest = await readManifest();
    expect(manifest['src/app.txt']).toBeDefined();
  });

  it('B-10: purges a secret path that exists ONLY in the stored manifest (no file on disk)', async () => {
    // The previous fixture wrote a real `.env` to disk, so `walk()`'s own
    // filter already excluded it from `current` and the ORDINARY delete pass
    // satisfied both assertions — the purge loop could be deleted and the test
    // stayed green (audit B-10, equivalence by construction). With no file on
    // disk the path is absent from `current` AND absent from the delete diff,
    // so ONLY the purge loop at indexer.ts:257-262 can remove it.
    await writeWorkspaceFile('src/app.txt', 'unchanged content for the regression file.\n');
    await fs.mkdir(indexDir, { recursive: true });
    // Simulates an index built BEFORE this fix: `.env` was embedded and is
    // still sitting in the manifest. Deliberately do NOT create `.env` on
    // disk — that is the whole point of this fixture (see comment above).
    await fs.writeFile(
      path.join(indexDir, 'manifest.json'),
      JSON.stringify({ '.env': 'deadbeef', 'src/app.txt': 'stale-hash-will-be-recomputed' }),
      'utf8',
    );

    const indexer = makeIndexer();
    await indexer.build();

    const manifest = await readManifest();
    expect(Object.keys(manifest)).not.toContain('.env');
    expect(deleteByPathMock.mock.calls.map(([calledPath]) => calledPath)).toContain('.env');
    // the non-secret entry survives reconciliation (re-embedded, since the
    // stored hash was stale).
    expect(manifest['src/app.txt']).toBeDefined();
  });

  it('B-10 isolation: purges via the purge loop even when walk() itself did not exclude the path', async () => {
    // The B-10 test above (secret only in the manifest, absent from disk) is
    // ALSO satisfied by the ORDINARY delete pass alone: `diffContentHashes`
    // deletes anything present in `stored` but absent from `current`, for
    // ANY reason, not just secrecy — and walk() (indexer.ts:161) already
    // guarantees a real secret path is always absent from `current`, using
    // the exact same classifier the purge loop uses. Verified empirically:
    // deleting the purge loop and re-running the B-10 test above still
    // passes (see task-12-report.md, Plant 1 finding). So B-10 alone does
    // NOT isolate the purge loop's own branch.
    //
    // This test does. `.env` is REAL, on disk, unchanged (its manifest hash
    // matches its current content hash exactly) — the scenario the purge
    // loop's own doc comment names: "independent of whether walk()'s filter
    // above already excluded it from current." To force that exact
    // disagreement without touching indexer.ts, the mocked classifier
    // answers `false` on its first call (walk()'s check — modelling "wasn't
    // classified as secret when this file was indexed") and `true` from the
    // second call on (the purge loop's check — modelling "the classifier
    // caught up since"). With the purge loop intact, ONLY it can act here:
    // the ordinary diff sees an unchanged hash and does nothing on its own.
    await writeWorkspaceFile('.env', 'SECRET=shhh\n');
    const onDiskHash = hashContent('SECRET=shhh\n');

    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(path.join(indexDir, 'manifest.json'), JSON.stringify({ '.env': onDiskHash }), 'utf8');

    let calls = 0;
    vi.mocked(isSecretForCompletion).mockImplementation(() => {
      calls += 1;
      return calls > 1;
    });

    const indexer = makeIndexer();
    await indexer.build();

    expect(deleteByPathMock.mock.calls.map(([calledPath]) => calledPath)).toContain('.env');
  });

  it('skips a secret-path file on the incremental change path (create/change event)', async () => {
    await writeWorkspaceFile('.env', 'SECRET=shhh\n');

    const indexer = makeIndexer();
    const disposable = indexer.watch();

    expect(fsWatcherListeners.create.length).toBeGreaterThan(0);
    const onCreate = fsWatcherListeners.create[0]!;
    onCreate({ fsPath: path.join(workspaceRoot, '.env') });

    // past the 10ms debounce configured above, plus slack for the async
    // handler (fs read + manifest read/write) to complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(upsertMock).not.toHaveBeenCalled();
    expect(deleteByPathMock).toHaveBeenCalledWith('.env');

    disposable.dispose();
    indexer.dispose();
  });

  it('still indexes a non-secret file on the incremental change path (regression)', async () => {
    await writeWorkspaceFile('src/app.txt', 'hello world, an ordinary file with real content to chunk.\n');

    const indexer = makeIndexer();
    const disposable = indexer.watch();

    const onCreate = fsWatcherListeners.create[0]!;
    onCreate({ fsPath: path.join(workspaceRoot, 'src/app.txt') });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(upsertMock).toHaveBeenCalled();

    disposable.dispose();
    indexer.dispose();
  });
});

describe('SEC-1 (audit-3): RAG content secret-scan drops the CHUNK, not the file', () => {
  let workspaceRoot: string;
  let indexDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-sec1-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeIndexer() {
    return createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      maxChunkTokens: 50,
    });
  }

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const CLEAN_MARKER = 'UNIQUE_CLEAN_SIBLING_CHUNK_MARKER_TALARIA_A1';

  /**
   * Builds a 41-line `.ts` file so the line-window fallback chunker
   * (`chunkByLines`: 40-line window, 10-line overlap -> 30-line step; AST
   * chunking never engages in this test since no real tree-sitter grammar
   * directory exists under the temp workspace, exactly like the D-2 tests
   * below) splits it into EXACTLY 2 chunks:
   *  - chunk 1 = lines 0-39 (0-indexed) — carries the secret, placed at
   *    lines 0-1 so it never reaches chunk 2.
   *  - chunk 2 = lines 30-40 — a clean sibling. Lines 30-39 overlap with
   *    chunk 1, but line 40 (the unique marker) exists ONLY in chunk 2, so
   *    finding the marker in the embedded texts proves chunk 2 survived.
   */
  function buildSplitFileContent(): string {
    const lines: string[] = [];
    lines.push(`const awsAccessKeyId = "${AWS_ACCESS_KEY_ID}";`);
    lines.push(`const awsSecretAccessKey = "${AWS_SECRET_ACCESS_KEY}";`);
    for (let i = 2; i < 30; i++) lines.push(`const filler${i} = ${i};`);
    for (let i = 30; i < 41; i++) lines.push(`const cleanLine${i} = "${CLEAN_MARKER}_${i}";`);
    return lines.join('\n') + '\n';
  }

  it('drops only the secret-carrying chunk, keeps the clean sibling chunk, on a full build (MUST fail at HEAD)', async () => {
    // Scratch sanity check (brief: "CONFIRM it actually trips the real
    // scanner"): the exact secret-carrying line pair, run through the real
    // (unmocked) scanner directly, must be rejected before this test trusts
    // the indexer to have dropped it for the right reason.
    const sanity = scanSnippetForSecrets({
      path: 'src/config.ts',
      content: `const awsAccessKeyId = "${AWS_ACCESS_KEY_ID}";\nconst awsSecretAccessKey = "${AWS_SECRET_ACCESS_KEY}";\n`,
    });
    expect(sanity.allowed).toBe(false);

    const content = buildSplitFileContent();
    await writeWorkspaceFile('src/config.ts', content);

    const indexer = makeIndexer();
    await indexer.build();

    expect(embedMock).toHaveBeenCalled();
    const embeddedTexts = embedMock.mock.calls.flatMap(([texts]) => texts);

    // Exactly 1 of the 2 real chunks survived the content gate.
    expect(embeddedTexts.length).toBe(1);

    for (const text of embeddedTexts) {
      expect(text).not.toContain(AWS_ACCESS_KEY_ID);
      expect(text).not.toContain(AWS_SECRET_ACCESS_KEY);
    }
    expect(embeddedTexts.some((text) => text.includes(CLEAN_MARKER))).toBe(true);

    const upsertedRecords = upsertMock.mock.calls.flatMap(([records]) => records) as Array<{
      content?: string;
    }>;
    for (const record of upsertedRecords) {
      expect(record.content ?? '').not.toContain(AWS_ACCESS_KEY_ID);
    }
  });
});

describe('D-2: the index carries a model/dimension fingerprint', () => {
  let workspaceRoot: string;
  let indexDir: string;
  const APP_TS_CONTENT = 'export const x = 1;\n';

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-meta-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();

    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src', 'app.ts'), APP_TS_CONTENT, 'utf8');
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeMetaIndexer() {
    return createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-embed-model',
      dims: 0,
    });
  }

  async function readMetaFixture(): Promise<unknown> {
    const raw = await fs.readFile(path.join(indexDir, 'manifest.meta.json'), 'utf8');
    return JSON.parse(raw);
  }

  async function writeMetaFixture(meta: unknown): Promise<void> {
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(path.join(indexDir, 'manifest.meta.json'), JSON.stringify(meta), 'utf8');
  }

  async function writeManifestFixture(manifest: Record<string, string>): Promise<void> {
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(path.join(indexDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  }

  /**
   * Real recompute evidence, not a mock-existence check: `reindexFiles` is the
   * only path that calls `store.upsert`, and it is only reached for paths
   * `diffContentHashes` puts in `toCompute`. So "which paths were upserted"
   * is exactly "which paths got recomputed" — read from the real ChunkRecord
   * payloads the indexer built, not from a boolean flag.
   */
  function recomputedPaths(): string[] {
    return upsertMock.mock.calls.flatMap(([records]) => records.map((r) => r.path));
  }

  it('writes the fingerprint sidecar on a fresh build, including the OBSERVED vector width (Task 14b)', async () => {
    const indexer = makeMetaIndexer();
    await indexer.build();
    const meta = await readMetaFixture();
    // embedMock (this file's top-level mock) returns `[0.1, 0.2, 0.3]` per
    // text — width 3 — so a fresh build that embeds real content must record
    // that observed width alongside the existing schema/embedModel/dims
    // fingerprint fields. SEC-1/F-3b extends this fixture: `scannerVersion`
    // must be stamped too, the same way `width` already is.
    expect(meta).toEqual({ schema: 1, embedModel: 'test-embed-model', dims: 0, width: 3, scannerVersion: 1 });
  });

  it('rebuilds from scratch when the stored fingerprint names a DIFFERENT model', async () => {
    // The stored hash matches the file's ACTUAL on-disk content exactly, so
    // an ordinary content-hash diff (with no fingerprint check at all) would
    // find nothing changed and would NOT recompute this file. If this test
    // recomputed it anyway, that would prove nothing except that the fixture
    // hash was stale — this fixture is deliberately fresh so ONLY the
    // fingerprint-mismatch discard can be the reason a recompute happens.
    await writeMetaFixture({ schema: 1, embedModel: 'some-other-model', dims: 0 });
    await writeManifestFixture({ 'src/app.ts': hashContent(APP_TS_CONTENT) });

    const indexer = makeMetaIndexer();
    await indexer.build();

    // A changed embedding model makes every stored vector incomparable. Reusing
    // the manifest would silently poison every future search — the manifest
    // holds only path->contentHash, so nothing else could ever notice.
    expect(recomputedPaths()).toContain('src/app.ts');
  });

  it('SEC-1/F-3b: rebuilds from scratch when the stored fingerprint predates scannerVersion (legacy sidecar, MUST fail at HEAD)', async () => {
    // A legacy sidecar: schema/embedModel/dims all MATCH current exactly (the
    // ordinary fingerprint used to consider this a match), but it predates
    // the `scannerVersion` field entirely — modelling an index built before
    // this fix existed, which may still hold chunk content that was never
    // run through a content scan at all. The stored hash matches the file's
    // actual on-disk content exactly (same "deliberately fresh" fixture
    // shape as the sibling test above), so only the missing-scannerVersion
    // mismatch can be the reason a recompute happens here.
    await writeMetaFixture({ schema: 1, embedModel: 'test-embed-model', dims: 0 });
    await writeManifestFixture({ 'src/app.ts': hashContent(APP_TS_CONTENT) });

    const indexer = makeMetaIndexer();
    await indexer.build();

    // Content embedded before the SEC-1 content gate existed was never
    // scanned; reusing it silently would leave that gap open forever, since
    // an unchanged content hash alone gives the ordinary diff no reason to
    // ever look at this file's content again.
    expect(recomputedPaths()).toContain('src/app.ts');
  });
});

describe('D-5: manifest read-modify-write is serialized under concurrent events', () => {
  let workspaceRoot: string;
  let indexDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-d5-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();
    fsWatcherListeners.create.length = 0;
    fsWatcherListeners.change.length = 0;
    fsWatcherListeners.delete.length = 0;
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeD5Indexer(debounceMs = 5) {
    return createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      debounceMs,
    });
  }

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function readManifest(): Promise<Record<string, string>> {
    const raw = await fs.readFile(path.join(indexDir, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  }

  it('two different files changing in the same debounce window both survive in the final manifest', async () => {
    // The real hazard D-5 names: `handleFsEvent` debounces PER PATH (each
    // `uri.fsPath` gets its own timer, see indexer.ts's `timers` map), so two
    // DIFFERENT files changing close together fire two independent, overlapping
    // read-modify-write cycles over the SAME manifest.json. Without
    // serialization this is a classic lost update: whichever cycle writes
    // last wins, silently dropping the other's entry — even though neither
    // cycle did anything wrong on its own.
    await writeWorkspaceFile('a.txt', 'file a content\n');
    await writeWorkspaceFile('b.txt', 'file b content\n');

    const indexer = makeD5Indexer();
    const disposable = indexer.watch();

    // Force file a's embed call (the first one issued) to resolve well after
    // file b's entire cycle would finish on its own — this is what makes the
    // interleaving deterministic instead of a timing-dependent flake. It
    // does not touch b's embed call; the mock reverts to its normal fast
    // implementation for every call after this one.
    embedMock.mockImplementationOnce(async (texts: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    const onChange = fsWatcherListeners.change[0]!;
    onChange({ fsPath: path.join(workspaceRoot, 'a.txt') });
    // b's event fires after a's debounce timer has already started (and,
    // shortly after, a's slow embed call) — so if the two cycles were NOT
    // serialized, b's fast cycle would finish and write first, and a's slow
    // cycle would finish later and overwrite b's entry with a stale
    // manifest that never saw it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    onChange({ fsPath: path.join(workspaceRoot, 'b.txt') });

    // Comfortably past both debounces plus the artificial 80ms embed delay.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const manifest = await readManifest();
    expect(manifest['a.txt']).toBeDefined();
    expect(manifest['b.txt']).toBeDefined();

    disposable.dispose();
    indexer.dispose();
  });
});

describe('RAG-4: watch() Disposable clears pending debounce timers on dispose', () => {
  let workspaceRoot: string;
  let indexDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-rag4-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();
    fsWatcherListeners.create.length = 0;
    fsWatcherListeners.change.length = 0;
    fsWatcherListeners.delete.length = 0;
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  function makeIndexer(debounceMs = 30) {
    return createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      debounceMs,
    });
  }

  it('a debounce timer scheduled before dispose() never fires handleFsEvent afterward', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    const indexer = makeIndexer();
    const disposable = indexer.watch();

    const onChange = fsWatcherListeners.change[0]!;
    onChange({ fsPath: path.join(workspaceRoot, 'src/app.ts') });

    // Disposing the watch()-returned Disposable itself (NOT indexer.dispose()
    // — a SEPARATE lifecycle: e.g. VS Code tearing down context.subscriptions
    // on deactivate while the Indexer object survives) BEFORE the debounce
    // elapses must cancel the pending timer, not just stop future events.
    disposable.dispose();

    // Comfortably past the debounce window, with slack for the (would-be)
    // async handler to have run if the timer had fired.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // handleFsEvent's first action is ensureStoreInitialized() -> store.init()
    // — if the timer had fired despite dispose(), initMock would have been
    // called.
    expect(initMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();

    indexer.dispose();
  });

  it('regression: a debounce timer that already fired before dispose still reindexes normally', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    const indexer = makeIndexer(10);
    const disposable = indexer.watch();

    const onChange = fsWatcherListeners.change[0]!;
    onChange({ fsPath: path.join(workspaceRoot, 'src/app.ts') });

    // Past the 10ms debounce, plus slack for the async handler to complete —
    // dispose() only happens AFTER the timer has already fired.
    await new Promise((resolve) => setTimeout(resolve, 200));
    disposable.dispose();

    expect(upsertMock).toHaveBeenCalled();

    indexer.dispose();
  });
});

describe('RAG-2: the serialize chain accepts the NEXT event after a batch embed failure (e.g. an embed timeout)', () => {
  let workspaceRoot: string;
  let indexDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'hermes-indexer-rag2-test-'));
    indexDir = path.join(workspaceRoot, '.hermes-index');
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  it('a build() call that rejects (e.g. an embed timeout) does not poison later build() calls', async () => {
    await writeWorkspaceFile('src/app.ts', 'export const x = 1;\n');

    const indexer = createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
    });

    // Models what HttpEmbedder.embedBatch now does when the RAG-2 deadline
    // fires: the embed() call rejects. indexer.ts has no try/catch around
    // this call inside reindexFiles, so the rejection propagates straight up
    // through runBuild -> serialize(runBuild) -> this build() call's promise
    // — "the indexer's existing per-batch error handling" the fix brief
    // names is exactly this propagation, not a swallow.
    embedMock.mockRejectedValueOnce(new Error('embeddings request timed out'));

    await expect(indexer.build()).rejects.toThrow('embeddings request timed out');

    // The shared buildChain (indexer.ts's serialize()) must still accept and
    // run the NEXT enqueued build — one rejected link in the chain must not
    // wedge every future build behind it.
    await writeWorkspaceFile('src/other.ts', 'export const y = 2;\n');
    await expect(indexer.build()).resolves.toBeUndefined();
    expect(upsertMock).toHaveBeenCalled();
  });
});

describe('AUDIT-5 Task 1: the handleFsEvent gate (ARCH-1/2/3/5 + CR-B)', () => {
  let workspaceRoot: string;
  let indexDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'talaria-indexer-a5-'));
    indexDir = path.join(workspaceRoot, 'index'); // CUSTOM in-workspace indexDir — the documented usage ARCH-1 names
    upsertMock.mockClear();
    deleteByPathMock.mockClear();
    initMock.mockClear();
    closeMock.mockClear();
    embedMock.mockClear();
    fsWatcherListeners.create.length = 0;
    fsWatcherListeners.change.length = 0;
    fsWatcherListeners.delete.length = 0;
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeIndexer(debounceMs = 5) {
    return createIndexer({
      workspaceRoot,
      indexDir,
      embedEndpoint: 'http://127.0.0.1:11434',
      embedModel: 'test-model',
      debounceMs,
    });
  }

  async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(workspaceRoot, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function readManifest(): Promise<Record<string, string>> {
    const raw = await fs.readFile(path.join(indexDir, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  }

  function upsertedPaths(): string[] {
    return upsertMock.mock.calls.flatMap(([records]) => records.map((r) => r.path));
  }

  it('ARCH-1 (build): a second full build never indexes the index directory own files', async () => {
    await writeWorkspaceFile('src/app.txt', 'ordinary content to chunk and index.\n');
    const indexer = makeIndexer();
    await indexer.build(); // writes index/manifest.json + index/manifest.meta.json
    upsertMock.mockClear();

    await indexer.build(); // at HEAD, walk() now collects index/manifest.json into the corpus

    expect(upsertedPaths()).not.toContain('index/manifest.json');
    expect(upsertedPaths()).not.toContain('index/manifest.meta.json');
    const manifest = await readManifest();
    expect(Object.keys(manifest)).toEqual(['src/app.txt']);
    indexer.dispose();
  });

  it('ARCH-1 (watch): a change event on the index own manifest is ignored — no re-embed, no self-feeding loop', async () => {
    await writeWorkspaceFile('src/app.txt', 'ordinary content to chunk and index.\n');
    const indexer = makeIndexer();
    await indexer.build();
    const disposable = indexer.watch();
    embedMock.mockClear();
    upsertMock.mockClear();

    fsWatcherListeners.change[0]!({ fsPath: path.join(indexDir, 'manifest.json') });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(embedMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    const manifest = await readManifest();
    expect(Object.keys(manifest)).toEqual(['src/app.txt']); // no self-entry appeared
    disposable.dispose();
    indexer.dispose();
  });

  it.skipIf(!canLinkDir)(
    'ARCH-2: a change event on a file behind an in-workspace dir symlink that ESCAPES the workspace is skipped and purged, never embedded',
    async () => {
      const outside = mkdtempSync(path.join(os.tmpdir(), 'talaria-outside-'));
      try {
        await fs.writeFile(path.join(outside, 'private.txt'), 'PRIVATE out-of-workspace content that must never be embedded.\n');
        linkDirSync(outside, path.join(workspaceRoot, 'vault'));
        const indexer = makeIndexer();
        const disposable = indexer.watch();

        fsWatcherListeners.change[0]!({ fsPath: path.join(workspaceRoot, 'vault', 'private.txt') });
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(embedMock).not.toHaveBeenCalled(); // at HEAD: fs.readFile FOLLOWS the link and the content IS embedded
        expect(upsertMock).not.toHaveBeenCalled();
        expect(deleteByPathMock.mock.calls.map(([p]) => p)).toContain('vault/private.txt'); // skip-AND-PURGE
        disposable.dispose();
        indexer.dispose();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canLinkFile)(
    'ARCH-2 (leaf): a change event on a leaf file symlink is skipped and purged (walk() never indexes symlinks — build/watch symmetry)',
    async () => {
      const outside = mkdtempSync(path.join(os.tmpdir(), 'talaria-outside-f-'));
      try {
        await fs.writeFile(path.join(outside, 'target.txt'), 'content behind a leaf symlink.\n');
        symlinkSync(path.join(outside, 'target.txt'), path.join(workspaceRoot, 'link.txt'), 'file');
        const indexer = makeIndexer();
        const disposable = indexer.watch();

        fsWatcherListeners.change[0]!({ fsPath: path.join(workspaceRoot, 'link.txt') });
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(embedMock).not.toHaveBeenCalled();
        expect(deleteByPathMock.mock.calls.map(([p]) => p)).toContain('link.txt');
        disposable.dispose();
        indexer.dispose();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('ARCH-3: an event from OUTSIDE the workspace root (multi-root sibling) early-returns — no RangeError logged, no store touch', async () => {
    const sibling = mkdtempSync(path.join(os.tmpdir(), 'talaria-sibling-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const indexer = makeIndexer();
      const disposable = indexer.watch();

      fsWatcherListeners.change[0]!({ fsPath: path.join(sibling, 'b.ts') });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // At HEAD: ignore@7 throws RangeError inside the filter, caught by
      // schedule()'s catch -> console.error('hermes-codebase: incremental reindex failed', ...).
      expect(errorSpy).not.toHaveBeenCalled();
      expect(initMock).not.toHaveBeenCalled();
      disposable.dispose();
      indexer.dispose();
    } finally {
      errorSpy.mockRestore();
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('CR-B: a watcher event racing the first build() runs store.init() exactly ONCE (memoized single-flight)', async () => {
    await writeWorkspaceFile('src/app.txt', 'ordinary content to chunk and index.\n');
    initMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // first native init is slow — the cold-start race window
    });
    const indexer = makeIndexer(5);
    const disposable = indexer.watch();

    const buildPromise = indexer.build(); // enters ensureStoreInitialized, parks on the slow init
    fsWatcherListeners.change[0]!({ fsPath: path.join(workspaceRoot, 'src', 'app.txt') }); // fires ~5ms in, while init is pending
    await buildPromise;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(initMock).toHaveBeenCalledTimes(1); // at HEAD: 2 — both callers pass the un-set flag
    disposable.dispose();
    indexer.dispose();
  });

  // ARCH-5 rider (F-1 FINAL: in this task). The single dir-delete event this
  // fires is VS Code's DOCUMENTED granularity (Appendix 9): folder deletes
  // fold into ONE event for the folder; children get none.
  it('ARCH-5 rider: a delete event for a DIRECTORY sweeps every indexed row/manifest key under it', async () => {
    await writeWorkspaceFile('src/a.txt', 'file a content to index.\n');
    await writeWorkspaceFile('src/b.txt', 'file b content to index.\n');
    const indexer = makeIndexer();
    await indexer.build();
    const disposable = indexer.watch();
    deleteByPathMock.mockClear();

    fsWatcherListeners.delete[0]!({ fsPath: path.join(workspaceRoot, 'src') }); // ONE event for the dir — the granularity ARCH-5 names
    await new Promise((resolve) => setTimeout(resolve, 200));

    const deleted = deleteByPathMock.mock.calls.map(([p]) => p);
    expect(deleted).toContain('src/a.txt');
    expect(deleted).toContain('src/b.txt');
    const manifest = await readManifest();
    expect(Object.keys(manifest)).toEqual([]);
    disposable.dispose();
    indexer.dispose();
  });
});
