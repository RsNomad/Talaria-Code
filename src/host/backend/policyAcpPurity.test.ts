import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectNonTestTsSources, VSCODE_IMPORT_BAN, FS_IMPORT_BAN } from '../purityScan';

/**
 * AH3: mechanises the "vscode-free pure core" invariant for `policy/` and
 * `acp/` as a headless vitest guard rather than an ESLint `no-restricted-imports`
 * rule (this repo has no ESLint — no config, no dependency, no `lint` script).
 * A regex-based scan over the SOURCE TEXT is deliberately crude (no AST): it
 * only needs to catch a literal `from 'vscode'` / `from 'node:fs'` specifier,
 * which is all any real import statement in this codebase ever writes.
 *
 * Scope: every `*.ts` file under `policy/` and `acp/`, excluding `*.test.ts`
 * (test files legitimately import `node:fs` for fixtures/mocks — see
 * `acp/pathConfine.test.ts` — and that's not part of the shipped pure core).
 *
 * W6-FK (I-9): the walk itself (`readdirSync`/`readFileSync`) now delegates
 * to the shared `src/host/purityScan.ts` helper instead of hand-rolling its
 * own — behavior-preserving (both `policy/` and `acp/` are flat directories
 * today, so the shared helper's RECURSIVE walk returns exactly the same file
 * set the old non-recursive walk did; see that module's doc). This file's
 * own `VSCODE_IMPORT_RE`/`FS_IMPORT_RE`/`CHILD_PROCESS_IMPORT_RE` patterns
 * (below) are kept UNCHANGED, not swapped for the shared module's canonical
 * bans — "catch exactly what they caught before" rules out even an
 * equivalent-looking regex substitution here.
 */

/**
 * T-18 (C3, mechanization — tier2-remediation-architecture.md §12.1, "worth
 * mechanizing early"): `connection/` and `control/` widen the vscode-freedom
 * scan below (the FIRST `it` in the very next `describe`, which iterates
 * `collectSourceFiles()` unconditionally over every ROOT) — they had ZERO
 * purity coverage before this task. Verified clean at widening time
 * (`ConnectionSupervisor.ts`/`ControlDispatcher.ts` import neither `vscode`
 * nor `node:fs`/`node:child_process`); the non-vacuous discovery + RED-first
 * proof below confirm the widened scan actually reaches them, not just that
 * it stays green by accident. Deliberately NOT added to the two
 * `.startsWith('policy/')`/`.startsWith('acp/')`-scoped fs/child_process
 * bans further down — those are narrower invariants specific to policy/acp's
 * own OS-seam allowlists, not part of what "extend ROOTS" asks for here.
 */
const ROOTS = ['policy', 'acp', 'connection', 'control'];

/**
 * Files allowed to import `node:fs` — the sanctioned OS-seam boundaries:
 * `pathConfine.ts` (realpath confinement) and `confinedOpen.ts` (the O_PATH
 * confined-read unit + its runtime probe). Both are the small, reviewed FS
 * boundary the rest of the pure `acp/` core routes through.
 */
const FS_ALLOW = new Set(['acp/pathConfine.ts', 'acp/confinedOpen.ts']);
/** Files allowed to import `node:child_process` — the one sanctioned ACP transport. */
const CHILD_PROCESS_ALLOW = new Set(['acp/acpClient.ts']);

// Matches both `import ... from 'vscode'` and a bare side-effect `import 'vscode'`.
const VSCODE_IMPORT_RE = /import\s+(?:.*\s+from\s+)?['"]vscode['"]/;
const FS_IMPORT_RE = /import\s+(?:.*\s+from\s+)?['"](?:node:)?fs['"]/;
const CHILD_PROCESS_IMPORT_RE = /import\s+(?:.*\s+from\s+)?['"](?:node:)?child_process['"]/;

/** Walk `policy/` + `acp/` and return `{ relKey, absPath, text }` for every
 *  non-test `*.ts` file — `relKey` is `'<root>/<basename>'` (e.g.
 *  `'acp/pathConfine.ts'`), matching the pre-unification format exactly, so
 *  every downstream `.relKey`/`FS_ALLOW`/`CHILD_PROCESS_ALLOW` check below
 *  is untouched. */
function collectSourceFiles(): Array<{ relKey: string; absPath: string; text: string }> {
  const files: Array<{ relKey: string; absPath: string; text: string }> = [];
  for (const dirName of ROOTS) {
    for (const source of collectNonTestTsSources(join(__dirname, dirName))) {
      files.push({ relKey: `${dirName}/${source.file}`, absPath: source.absPath, text: source.content });
    }
  }
  return files;
}

describe('AH3: policy/ + acp/ purity guard (pure-core mechanism, not just a comment)', () => {
  it('no module under policy/ or acp/ imports vscode', () => {
    const offenders = collectSourceFiles()
      .filter((f) => VSCODE_IMPORT_RE.test(f.text))
      .map((f) => f.relKey);

    expect(offenders).toEqual([]);
  });

  it('no module under policy/ imports node:fs or node:child_process (no allowlist there)', () => {
    const offenders = collectSourceFiles()
      .filter((f) => f.relKey.startsWith('policy/'))
      .filter((f) => FS_IMPORT_RE.test(f.text) || CHILD_PROCESS_IMPORT_RE.test(f.text))
      .map((f) => f.relKey);

    expect(offenders).toEqual([]);
  });

  it('under acp/, node:fs is imported only by the sanctioned pathConfine.ts / confinedOpen.ts', () => {
    const offenders = collectSourceFiles()
      .filter((f) => f.relKey.startsWith('acp/'))
      .filter((f) => FS_IMPORT_RE.test(f.text) && !FS_ALLOW.has(f.relKey))
      .map((f) => f.relKey);

    expect(offenders).toEqual([]);
  });

  it('under acp/, node:child_process is imported only by the sanctioned acpClient.ts', () => {
    const offenders = collectSourceFiles()
      .filter((f) => f.relKey.startsWith('acp/'))
      .filter((f) => CHILD_PROCESS_IMPORT_RE.test(f.text) && !CHILD_PROCESS_ALLOW.has(f.relKey))
      .map((f) => f.relKey);

    expect(offenders).toEqual([]);
  });

  it('T-18 (C3): discovers connection/ConnectionSupervisor.ts and control/ControlDispatcher.ts (non-vacuous — the widened ROOTS actually reaches the new files, not silently scanning zero)', () => {
    const files = collectSourceFiles();
    expect(files.some((f) => f.relKey === 'connection/ConnectionSupervisor.ts')).toBe(true);
    expect(files.some((f) => f.relKey === 'control/ControlDispatcher.ts')).toBe(true);
  });

  it('T-18 (C3): RED-first proof — the vscode-ban over ALL roots (now including connection/ and control/) would catch a hypothetical violation there (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectSourceFiles(),
      { relKey: 'connection/__hypothetical_vscode_violation__.ts', absPath: '', text: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_RE.test(f.text)).map((f) => f.relKey);
    expect(offenders).toContain('connection/__hypothetical_vscode_violation__.ts');
  });
});

// ---------------------------------------------------------------------------
// W6-FK (I-9) — coverage extension: `src/host/backend/session/` was NOT
// scanned by any purity guard before this task (a real coverage gap, not
// just a documentation one — `SessionController.ts` could have grown a
// `vscode` or `node:fs` import unnoticed). Scanned at the HEADLESS tier
// (`src/host/purityScan.ts`'s vocabulary): no `vscode`, no `fs` — but,
// UNLIKE `policy/`/`acp/` above, no claim of deterministic purity. This is
// the honest re-grade I-9 asks for: `SessionController.ts` legitimately
// calls `Date.now()` (turn timing) and `homedir()` (path canonicalization)
// — a scan that demanded "no Date.now" here would be WRONG, not stricter;
// it would contradict the module's actual, reviewed, behavior-preserving
// design (see that file's own updated class doc). `session/` is flat today
// (`SessionController.ts`, `SessionRegistry.ts`, `types.ts`), so no
// allowlist is needed for either ban — none of the three files import
// `vscode` or `fs`.
// ---------------------------------------------------------------------------

describe('W6-FK (I-9): session/ purity guard — HEADLESS tier (vscode-free + fs-free, NOT claimed deterministic-pure)', () => {
  const SESSION_ROOT = join(__dirname, 'session');

  function collectSessionSources() {
    return collectNonTestTsSources(SESSION_ROOT);
  }

  it('discovers SessionController.ts (non-vacuous file discovery)', () => {
    const files = collectSessionSources();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.file === 'SessionController.ts')).toBe(true);
  });

  it('no module under session/ imports vscode', () => {
    const offenders = collectSessionSources()
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('no module under session/ imports node:fs', () => {
    const offenders = collectSessionSources()
      .filter((f) => FS_IMPORT_BAN.test(f.content))
      .map((f) => f.file);

    expect(offenders).toEqual([]);
  });

  it('honest grading sanity: SessionController.ts genuinely calls Date.now()/homedir() — the HEADLESS (not pure) grade is not vacuous', () => {
    const controller = collectSessionSources().find((f) => f.file === 'SessionController.ts');
    expect(controller).toBeDefined();
    expect(controller?.content.includes('Date.now(')).toBe(true);
    expect(controller?.content.includes('homedir(')).toBe(true);
  });

  it('regression lock: SessionController.ts no longer describes itself as a "pure" module (I-9\'s overstated-grade fix)', () => {
    const controller = collectSessionSources().find((f) => f.file === 'SessionController.ts');
    expect(controller).toBeDefined();
    expect(controller?.content).not.toMatch(/style pure\b/i);
  });

  /**
   * RED-first non-vacuity proofs, IN-MEMORY (no disk write into `session/`)
   * — see `contextPurity.test.ts`'s identical-rationale doc comment (this
   * task discovered, empirically, that writing a real temp probe file into
   * a directory ALSO recursively walked by another concurrently-running
   * vitest test file races that file's own `readdirSync`/`statSync`
   * traversal). `session/` is not currently walked by any OTHER test file,
   * but appending a synthetic entry to the REAL, already-collected list
   * proves the same non-vacuity with zero disk race regardless — belt and
   * braces, and consistent with the fix applied in `contextPurity.test.ts`.
   */
  it('RED-first proof: the vscode-ban would catch a hypothetical session/ violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectSessionSources(),
      { file: '__hypothetical_vscode_violation__.ts', absPath: '', content: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_vscode_violation__.ts');
  });

  it('RED-first proof: the fs-ban would catch a hypothetical session/ violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectSessionSources(),
      { file: '__hypothetical_fs_violation__.ts', absPath: '', content: "import { readFileSync } from 'node:fs';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => FS_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_fs_violation__.ts');
  });
});

// ---------------------------------------------------------------------------
// T-18 (C3, mechanization — tier2-remediation-architecture.md §12.1, "worth
// mechanizing early"): `src/rag/` was NOT scanned by any purity guard before
// this task. Mirrors `contextPurity.test.ts`/`nextEditPurity.test.ts`'s
// established shape (own ROOT, own ADAPTER_ALLOW, the SAME shared
// `VSCODE_IMPORT_BAN`/`FS_IMPORT_BAN` from `purityScan.ts`), narrowed to
// rag/'s own adapter: `indexer.ts` is the one file that legitimately
// imports BOTH `vscode` (workspace root resolution / file-watcher wiring)
// AND `node:fs` (walking the workspace tree to index it) — unlike
// `context/`/`nextedit/`'s adapters, which need vscode but never fs, so
// (unlike those two files' zero-exception fs-ban) THIS guard's fs-ban
// carries the identical adapter exception as its vscode-ban. Every other
// rag/ module (chunk/, parser/, store/, chunker.ts, contentHash.ts,
// embedder.ts, gitignore.ts, header.ts, hybrid.ts) must import neither —
// verified true at widening time (empirically re-checked: `indexer.ts` is
// the ONLY vscode/fs importer anywhere under `src/rag/`).
// ---------------------------------------------------------------------------

const RAG_ROOT = join(__dirname, '..', '..', 'rag');
const RAG_ADAPTER_ALLOW = new Set(['indexer.ts']);

function collectRagSources() {
  return collectNonTestTsSources(RAG_ROOT);
}

describe('T-18 (C3): rag/ purity guard', () => {
  it('discovers indexer.ts (non-vacuous file discovery)', () => {
    const files = collectRagSources();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.file === 'indexer.ts')).toBe(true);
  });

  it('no module under rag/ imports vscode EXCEPT the sanctioned indexer.ts', () => {
    const offenders = collectRagSources()
      .filter((f) => !RAG_ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('no module under rag/ imports node:fs EXCEPT the sanctioned indexer.ts', () => {
    const offenders = collectRagSources()
      .filter((f) => !RAG_ADAPTER_ALLOW.has(f.file))
      .filter((f) => FS_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('sanity: indexer.ts genuinely imports both vscode and node:fs (the exemption is real, not vacuous)', () => {
    const source = collectRagSources().find((f) => f.file === 'indexer.ts');
    expect(source).toBeDefined();
    expect(VSCODE_IMPORT_BAN.test(source?.content ?? '')).toBe(true);
    expect(FS_IMPORT_BAN.test(source?.content ?? '')).toBe(true);
  });

  it('RED-first proof: the vscode-ban would catch a hypothetical non-adapter violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectRagSources().filter((f) => !RAG_ADAPTER_ALLOW.has(f.file)),
      { file: '__hypothetical_vscode_violation__.ts', absPath: '', content: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_vscode_violation__.ts');
  });

  it('RED-first proof: the fs-ban would catch a hypothetical non-adapter violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectRagSources().filter((f) => !RAG_ADAPTER_ALLOW.has(f.file)),
      { file: '__hypothetical_fs_violation__.ts', absPath: '', content: "import { readFileSync } from 'node:fs';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => FS_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_fs_violation__.ts');
  });

  it('negative control: indexer.ts is correctly NOT flagged despite genuinely importing vscode+fs (the predicate is not "flag everything")', () => {
    const vscodeOffenders = collectRagSources()
      .filter((f) => !RAG_ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(vscodeOffenders).not.toContain('indexer.ts');
  });
});

// ---------------------------------------------------------------------------
// T-18 (C3, mechanization): the LOOSE top-level files directly under
// `src/autocomplete/` (index.ts, provider.ts, config.ts, apiKey.ts, ...)
// were NOT scanned by any purity guard before this task — `context/` and
// `nextedit/` each already have their own dedicated guard
// (`contextPurity.test.ts`, `nextEditPurity.test.ts`); this is the guard for
// the remaining "autocomplete root" gap the audit named. Deliberately
// NON-RECURSIVE (only files directly under `src/autocomplete/`, never
// descending into `context/`/`nextedit/`/`backends/`) — a recursive walk
// from here would re-scan context/'s and nextedit/'s OWN adapters
// (`contextService.vscode.ts`, `editTrackerAdapter.ts`, `guard.ts`,
// `shell.vscode.ts`, nextedit's own `config.ts`) under a DIFFERENT
// allowlist and spuriously fail; those directories already have their own
// honest guard, and re-litigating them here would be redundant, not
// stricter. `index.ts` (the activation/registration entry), `provider.ts`
// (the `vscode.InlineCompletionItemProvider` registration) and `config.ts`
// (`vscode.workspace.getConfiguration` reads) are the three top-level
// adapter-tier files — the non-`.vscode.ts`-named outlier this repo's
// naming-convention backlog already documents (`purityScan.ts`'s module
// doc) — verified below to genuinely need `vscode`, non-vacuously.
// ---------------------------------------------------------------------------

const AUTOCOMPLETE_ROOT = join(__dirname, '..', '..', 'autocomplete');
const AUTOCOMPLETE_ADAPTER_ALLOW = new Set(['index.ts', 'provider.ts', 'config.ts']);

/**
 * Non-recursive top-level-only sibling of `collectNonTestTsSources` — used
 * ONLY by the autocomplete-root guard below, for the "why non-recursive"
 * reason in this section's module doc. `readdirSync(root)` (no
 * `{recursive:true}`) returns entries at exactly this level; filtering to
 * the `.ts` suffix alone already excludes bare subdirectory names
 * (`context`, `nextedit`, `backends` carry no `.ts` suffix), so no
 * `withFileTypes`/`statSync` distinction is needed.
 */
function collectTopLevelNonTestTsSources(root: string): Array<{ file: string; absPath: string; content: string }> {
  const files: Array<{ file: string; absPath: string; content: string }> = [];
  for (const entry of readdirSync(root, { encoding: 'utf8' })) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const absPath = join(root, entry);
    files.push({ file: entry, absPath, content: readFileSync(absPath, 'utf-8') });
  }
  return files;
}

function collectAutocompleteRootSources() {
  return collectTopLevelNonTestTsSources(AUTOCOMPLETE_ROOT);
}

describe('T-18 (C3): autocomplete/ ROOT purity guard (top-level files only — context/ and nextedit/ have their own dedicated guards)', () => {
  it('discovers the three adapters + at least one pure sibling (non-vacuous file discovery)', () => {
    const files = collectAutocompleteRootSources();
    expect(files.length).toBeGreaterThan(0);
    for (const adapter of AUTOCOMPLETE_ADAPTER_ALLOW) {
      expect(files.some((f) => f.file === adapter)).toBe(true);
    }
    expect(files.some((f) => f.file === 'apiKey.ts')).toBe(true);
  });

  it('no top-level autocomplete/ module imports node:fs (zero exceptions — not even the three adapters need it)', () => {
    const offenders = collectAutocompleteRootSources()
      .filter((f) => FS_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('no top-level autocomplete/ module imports vscode EXCEPT the three sanctioned adapters', () => {
    const offenders = collectAutocompleteRootSources()
      .filter((f) => !AUTOCOMPLETE_ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('sanity: all three sanctioned adapters DO import vscode (the exemption is real, not vacuous)', () => {
    const files = collectAutocompleteRootSources();
    for (const adapter of AUTOCOMPLETE_ADAPTER_ALLOW) {
      const source = files.find((f) => f.file === adapter);
      expect(source).toBeDefined();
      expect(VSCODE_IMPORT_BAN.test(source?.content ?? '')).toBe(true);
    }
  });

  it('RED-first proof: the vscode-ban would catch a hypothetical non-adapter violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectAutocompleteRootSources().filter((f) => !AUTOCOMPLETE_ADAPTER_ALLOW.has(f.file)),
      { file: '__hypothetical_vscode_violation__.ts', absPath: '', content: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_vscode_violation__.ts');
  });

  it('RED-first proof: the fs-ban would catch a hypothetical violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectAutocompleteRootSources(),
      { file: '__hypothetical_fs_violation__.ts', absPath: '', content: "import { readFileSync } from 'node:fs';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => FS_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_fs_violation__.ts');
  });

  it('negative control: an adapter-allowlisted file importing vscode is correctly NOT flagged (the predicate is not "flag every vscode import")', () => {
    const offenders = collectAutocompleteRootSources()
      .filter((f) => !AUTOCOMPLETE_ADAPTER_ALLOW.has(f.file))
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(offenders).not.toContain('index.ts');
    expect(offenders).not.toContain('provider.ts');
    expect(offenders).not.toContain('config.ts');
  });

  it('non-recursive by construction: never descends into context/, nextedit/, or backends/ (those are scanned by their own dedicated guards)', () => {
    const files = collectAutocompleteRootSources().map((f) => f.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => !f.includes('/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-18 (C3, mechanization): `src/shared/` is bundled into BOTH the host
// (Node) extension AND the webview (browser-sandboxed — no Node builtins,
// no `vscode` module) — the audit's own "worth mechanizing early" item.
// Nothing enforced its "safely importable from either target" contract
// before this task: a `vscode` or `node:*` import landing here would
// compile clean in isolation yet break the webview bundle the moment it's
// pulled in there. "Import-freedom": zero exceptions, no adapter allowlist
// — unlike policy/acp/rag/autocomplete, `shared/` has no legitimate reason
// to import EITHER boundary; its whole purpose is being safely importable
// from both sides of it.
// ---------------------------------------------------------------------------

const SHARED_ROOT = join(__dirname, '..', '..', 'shared');
/**
 * Broader than `FS_IMPORT_BAN`: bans EVERY `node:`-prefixed specifier (this
 * codebase always writes its own Node builtin imports with the `node:`
 * prefix — confirmed across every existing purity scan's own FS/
 * child_process regexes in this file and `purityScan.ts`), not just `fs`.
 * `shared/` must be importable from the webview's browser-sandboxed bundle
 * target, which has none of them — `fs`, `path`, `crypto`, `os`,
 * `child_process`, all banned alike.
 */
const NODE_BUILTIN_IMPORT_RE = /from\s+['"]node:/;

function collectSharedSources() {
  return collectNonTestTsSources(SHARED_ROOT);
}

describe('T-18 (C3): shared/ import-freedom scan (must be safely importable from BOTH the host and the webview bundle)', () => {
  it('discovers protocol.ts (non-vacuous file discovery)', () => {
    const files = collectSharedSources();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.file === 'protocol.ts')).toBe(true);
  });

  it('no module under shared/ imports vscode (zero exceptions)', () => {
    const offenders = collectSharedSources()
      .filter((f) => VSCODE_IMPORT_BAN.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('no module under shared/ imports any node: builtin (zero exceptions — broader than just fs)', () => {
    const offenders = collectSharedSources()
      .filter((f) => NODE_BUILTIN_IMPORT_RE.test(f.content))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('RED-first proof: the vscode-ban would catch a hypothetical violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectSharedSources(),
      { file: '__hypothetical_vscode_violation__.ts', absPath: '', content: "import * as vscode from 'vscode';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => VSCODE_IMPORT_BAN.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_vscode_violation__.ts');
  });

  it('RED-first proof: the node-builtin-ban would catch a hypothetical violation (in-memory injection into the REAL collected file list)', () => {
    const withInjectedViolation = [
      ...collectSharedSources(),
      { file: '__hypothetical_node_violation__.ts', absPath: '', content: "import { randomUUID } from 'node:crypto';\n" },
    ];
    const offenders = withInjectedViolation.filter((f) => NODE_BUILTIN_IMPORT_RE.test(f.content)).map((f) => f.file);
    expect(offenders).toContain('__hypothetical_node_violation__.ts');
  });
});
