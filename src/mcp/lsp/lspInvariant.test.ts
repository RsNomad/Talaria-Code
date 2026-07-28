import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LSP_READ_COMMANDS } from './lspCommandAllowlist';
import { collectNonTestTsSources, scanLines } from '../../host/purityScan';

/**
 * W3 (LIB) · T4 — the static invariant-lock test (research doc §5.3, last
 * paragraph is this file's spec). This is a PLAIN TEXT SCAN over every
 * non-test `.ts` file under `src/mcp/lsp/`, not an AST/semantic analysis — a
 * blunt, hard-to-fool mechanical lock, not a style linter. It reads the
 * directory at test-run time (`readdirSync`, not a hard-coded file list), so
 * it auto-covers files T5 (`resultShaper.ts`), T6 (`tools.ts`), and T8 (the
 * code-actions verb) add later, with zero changes needed here.
 *
 * Because this is a blunt substring/line scan, the SOURCE FILES THEMSELVES
 * must never mention a banned term in prose (e.g. a doc comment explaining
 * "this file never calls apply-edit") — the scanner cannot tell a comment
 * from code, by design (research doc §5.3: this is the mechanism that makes
 * "an agent can never drive LIB to write" true, and a mechanism that could be
 * talked around by comment-awareness would not be a lock).
 *
 * No `vscode` import (headless) — `node:fs`/`node:path`/`node:url` only.
 *
 * I-7 (3-way arch review, `final-3way-arch.md`) — SECOND SCAN ROOT: this file
 * used to scan `src/mcp/lsp/` ONLY, leaving `src/host/lib/libToolDeps.vscode.ts`
 * (the ONE place `vscode` is legitimately in scope for LIB, precisely because
 * it lives OUTSIDE this directory) exempt from EVERY ban, including the
 * `executeCommand`/`workspace.fs`-write bans — an arbitrary mutation call
 * could have been smuggled into that file undetected. The "LIB jurisdiction
 * extension" section near the end of this file adds `src/host/lib/*.vscode.ts`
 * as a second scan root with a TAILORED pattern set: it reuses
 * {@link EXECUTE_COMMAND_PATTERN} and {@link WORKSPACE_FS_WRITE_PATTERN}
 * as-is (DRY — same constants, same evasion-hardening, no duplicated regex),
 * but deliberately does NOT apply {@link VSCODE_IMPORT_PATTERN} (this IS the
 * legitimate `.vscode.ts` adapter) or {@link FS_IMPORT_PATTERN} (the adapter
 * legitimately needs `node:fs` — `fs.realpath()` for live workspace-root
 * canonicalization feeding `classifyUri`'s confinement verdict; see that
 * section's own doc comment for the full reasoning).
 */

interface SourceFile {
  readonly file: string;
  readonly content: string;
}

interface ScanMatch {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

const LSP_DIR = dirname(fileURLToPath(import.meta.url));

/** Every non-test `.ts` file under `src/mcp/lsp/`, RECURSIVELY (Opus review
 * Minor-1) — re-read from disk on every test run, so a future T5/T6/T8 file
 * is picked up with no edit to this test, including one added inside a
 * future subdirectory (a non-recursive scan would let such a file escape
 * every ban silently). `recursive: true` returns paths relative to
 * `LSP_DIR`; for a file directly under `LSP_DIR` (every real file today)
 * that relative path IS the bare basename, so the `.test.ts` suffix filter
 * and the `lspGateway.ts` exact-basename checks elsewhere in this file keep
 * working unchanged — only a file inside a nested subdirectory would get a
 * `subdir/name.ts`-shaped relative path, and `.endsWith('.test.ts')` still
 * correctly matches that shape too.
 *
 * W6-FK (I-9): delegates the actual `readdirSync`/`readFileSync` walk to the
 * shared `src/host/purityScan.ts` helper (identical `{ encoding: 'utf8',
 * recursive: true }` walk this function used inline before unification) —
 * behavior-preserving, same file set in, same file set out. */
function loadLspSources(): SourceFile[] {
  return collectNonTestTsSources(LSP_DIR);
}

/**
 * I-7 second scan root — `src/host/lib/`, resolved relative to {@link LSP_DIR}
 * (`src/mcp/lsp/../../host/lib`) so this test keeps working regardless of
 * where the repo checkout lives, same portability property {@link LSP_DIR}
 * already has via `import.meta.url`. Grounded via Context7
 * (`nodejs/node` fs docs, `fs.readdirSync`'s `recursive` option) at write-time
 * — the exact same `{ encoding: 'utf8', recursive: true }` shape
 * {@link loadLspSources} already uses, confirmed to return directory-relative
 * paths (bare basenames for a directly-nested file, the only shape any file
 * under `src/host/lib/` has today).
 */
const LIB_DIR = join(LSP_DIR, '..', '..', 'host', 'lib');

/**
 * Every `*.vscode.ts` LIB adapter file — matched by the SAME basename
 * pattern {@link isVscodeImportExempt} already uses for its `.vscode.ts`
 * exemption (DRY; forward-covering — a future sibling adapter, e.g. a
 * `libFooBar.vscode.ts`, is picked up automatically with zero edits here,
 * same discovery design {@link loadLspSources}/{@link loadShaperSources}
 * use). The `.test.ts` exclusion is redundant given the `.vscode.ts$` anchor
 * (no real or plausible test file is named `*.vscode.ts`) but kept for
 * defense-in-depth, matching this file's existing loader style.
 */
function loadLibVscodeSources(): SourceFile[] {
  return collectNonTestTsSources(LIB_DIR).filter((f) => /\.vscode\.ts$/.test(f.file));
}

/** Forward-covering (research doc §5.3): T5's shaper file(s) may not exist
 * yet. Matched by basename pattern, not a hard-coded name, so this activates
 * automatically the moment `resultShaper.ts` (or a `resultShaper*.ts`
 * variant) lands. At T4 this list is empty and the discovery assertion below
 * (kept as the shaper-specific non-vacuity proof) passed trivially — that
 * emptiness was fine and expected.
 *
 * NOTE (Opus review Important-1): the fs-import / `readFile` bans that used
 * to run ONLY over this narrower list have been broadened to run over
 * {@link loadLspSources} instead (every non-test lsp file, the same set the
 * mutation bans already use) — see the "fs-import / readFile ban" describe
 * block below. `loadShaperSources` is kept only for the resultShaper.ts
 * discovery non-vacuity check; it is no longer the scope of any ban. */
function loadShaperSources(): SourceFile[] {
  return collectNonTestTsSources(LSP_DIR).filter((f) => /^resultShaper.*\.ts$/.test(f.file));
}

/**
 * The shared scanner helper (required by the brief so both the real-code
 * assertions and the non-vacuous self-check exercise the SAME code path —
 * the self-check would prove nothing about the real assertions if it used a
 * different matcher). Line-by-line so a `ScanMatch` carries a useful
 * file+line+snippet for a human debugging a future RED. `pattern` must NOT
 * carry the `g`/`y` flag — `RegExp.prototype.test` retains `lastIndex`
 * across calls for those flags, which would silently skip matches on later
 * lines/files; every pattern below is flag-less by construction.
 *
 * W6-FK (I-9): delegates to the shared `src/host/purityScan.ts#scanLines` —
 * the identical line-by-line loop this function used inline before
 * unification, byte-for-byte (behavior-preserving: same matches in, same
 * matches out, for every pattern this file already exercises).
 */
function scanLspSources(files: readonly SourceFile[], pattern: RegExp): ScanMatch[] {
  return scanLines(files, pattern);
}

/** Fetch a named file's source out of an already-loaded list, throwing a
 * descriptive error (never a silent `undefined`/`!`) if it's missing — used
 * only for assertions that need to inspect ONE specific file. */
function requireFile(files: readonly SourceFile[], name: string): SourceFile {
  const found = files.find((f) => f.file === name);
  if (found === undefined) {
    throw new Error(`lspInvariant: expected to find ${name} among src/mcp/lsp/*.ts sources`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Forbidden patterns (research doc §5.3's list, transcribed one-to-one).
// Named individually (not just array entries) so the self-check section can
// reference each pattern directly without a `.find(...)!` non-null assert.
// ---------------------------------------------------------------------------

const APPLY_EDIT_PATTERN = /\bapplyEdit\b/;
const RESOLVE_CODE_ACTION_PATTERN = /\bresolveCodeAction\b/;
/**
 * Broadened (Opus review Important-1) two ways beyond a literal
 * `workspace.fs.write` substring match:
 *  1. `workspace\s*\.\s*fs\s*\.\s*(write|...)` — tolerates whitespace around
 *     the dots (`workspace . fs . writeFile`), which prettier would not
 *     collapse the way it does a call's parens.
 *  2. `=\s*(?:vscode\s*\.\s*)?workspace\s*\.\s*fs\b` — catches the ALIASING
 *     act itself (`const a = workspace.fs;`). This is required because a
 *     proven evasion splits the mutation across two statements — `const a =
 *     workspace.fs; a.writeFile(uri, data);` — so the literal substring
 *     `workspace.fs.writeFile` never appears on any single line; the write
 *     call line (`a.writeFile(...)`) no longer mentions `workspace` or `fs`
 *     at all, so the lock must fire at the point the reference is captured
 *     instead. No real lsp source currently takes a `workspace.fs` reference
 *     of any kind (verified by grep), so this branch has zero false-positive
 *     risk against shipped code; a future legitimate READ call like
 *     `vscode.workspace.fs.readFile(uri)` still does NOT match either branch
 *     (no write verb, and it's a direct call, not an assignment), so reads
 *     remain unaffected.
 */
const WORKSPACE_FS_WRITE_PATTERN =
  /workspace\s*\.\s*fs\s*\.\s*(?:write|rename|delete|copy|createDirectory)|=\s*(?:vscode\s*\.\s*)?workspace\s*\.\s*fs\b/;
const CREATE_TERMINAL_PATTERN = /\bcreateTerminal\b/;
const TASKS_EXECUTE_PATTERN = /\btasks\.execute\w*/;
/**
 * Broadened (Opus review Important-1) beyond the literal `.executeCommand(`
 * substring so non-obfuscated, prettier-legal TypeScript can't dodge it:
 *  1. `executeCommand\s*[(\[]` — tolerates whitespace before the call paren
 *     (`.executeCommand ('id')`, valid TS despite the space) and also a
 *     following `[`.
 *  2. `['"]executeCommand['"]` — the quoted-literal form used for a dynamic
 *     bracket key (`commands['executeCommand'](id)`), where the text
 *     `executeCommand` is never immediately followed by `(`.
 * Deliberately no longer requires a leading `.` — a blunt text scan is
 * fail-safe when it over-matches (see Minor-2 in the review, accepted as
 * fine), so being slightly broader here is the correct direction to err.
 *
 * Task 8 fix wave (task-8-review.md, discovered while implementing
 * Important-1's remedy below): broadened AGAIN to tolerate an explicit
 * generic type argument between `executeCommand` and its call paren —
 * `executeCommand\s*(?:<[^>]*>)?\s*[([]`. Without this, the pattern never
 * matched `lspGateway.ts`'s OWN real call site
 * (`vscode.commands.executeCommand<T>(commandId, ...args)`, `lspGateway.ts`
 * line 105) — confirmed by direct test: the un-broadened pattern returns
 * ZERO matches against the real file. That is a live blind spot in this
 * exact ban, not a hypothetical: it silently would not catch a non-gateway
 * file that copy-pasted the same generic-typed call shape (this file's own
 * `executeCommand( appears ONLY in lspGateway.ts` check, below, only ever
 * asserted zero matches in OTHER files — it never asserted the pattern
 * fires on the gateway's own legitimate call, so this gap shipped silently
 * until Important-1's single-call-site pin needed the count to be
 * accurate). Repo-wide grep at fix time: the ONLY line under `src/` matching
 * `executeCommand\s*<[^>]*>\s*\(` is `lspGateway.ts:105` itself — the
 * broadening adds zero new matches anywhere else in the tree (verified,
 * not assumed), so every existing assertion and self-check below is
 * unaffected (all of them exercise call shapes with no generic argument).
 */
const EXECUTE_COMMAND_PATTERN = /executeCommand\s*(?:<[^>]*>)?\s*[([]|['"]executeCommand['"]/;

/**
 * Write-shaped tool-name ban — SCOPED to a registration context (W3 T8a,
 * closing the T4 review's M-2 finding: the original pattern was fail-safe but
 * over-matched ANY quoted verb-root token anywhere in a file).
 *
 * The original `TOOL_NAME_PATTERN` matched any bare quoted token whose text
 * started with a write-verb root (`'edit'`, `'delete'`, …) ANYWHERE in the
 * source — including ordinary DATA string-literals that have nothing to do
 * with a tool name. That mis-fired on legitimate values the moment T8a landed
 * `codeActionSerialize.ts`, whose architecture-doc-pinned status contract
 * (§6.1) requires the exact literal union
 * `type CodeActionStatus = 'edit' | 'edit-incomplete' | 'command-only' |
 * 'unsupported-edit'` — the bare `'edit'` member is a real, mandated value,
 * not a tool name, yet the old scan flagged it.
 *
 * The fix scopes the ban to the ONE thing it was ever meant to protect: the
 * NAME a tool is registered under. A name is "declared" only in a
 * registration context — the first string-literal argument to
 * `registerTool(` (our real T6 registration form — note the name sits on the
 * line AFTER `registerTool(`, so this scan runs over whole-file content, not
 * line-by-line), or a `name:`/`id:`/`toolName:` `'<literal>'` field (the
 * schema/options forms some MCP registrations use, and the form the
 * self-checks below exercise). The write-verb check then runs on the
 * CAPTURED NAME as a WHOLE (anchored `^…$`), never on an arbitrary substring
 * elsewhere in the file. A data string like `'edit'` in a `CodeActionStatus`
 * union is not in either context, so it is never even captured — asserted
 * below as a negative control. All 6 real T4 tool names + the future
 * `lsp_code_actions` start with none of the write roots, so a
 * legitimately-registered read tool never flags; a write-shaped REGISTERED
 * name (`lsp_apply_edit`) still does (self-checked). Fail-safe direction is
 * preserved: the anchored write test still deliberately over-matches within
 * the write direction (e.g. `runner`), which is the safe way to err for a
 * security lock.
 *
 * Key alternation broadened to `name`/`id`/`toolName` (M-1, post-T8a-review
 * hardening): the original scan only recognized `registerTool(...)` and
 * `name:`, missing other registration-key spellings a future MCP
 * registration call might use. Broadening means this pattern will now also
 * flag a plain DATA field spelled `id:`/`toolName:` whose value happens to
 * start with a write verb (e.g. a hypothetical `id: 'edit'` outside any
 * registration) — accepted as fine, by the same fail-safe-over-matches
 * reasoning as the `executeCommand`/`workspace.fs` broadenings above: no
 * data object anywhere in this directory's real (non-test) source uses
 * `name:`/`id:`/`toolName:` with a bare write-verb-shaped value (verified —
 * the full suite, including every existing negative control, stays green
 * with this broadening), and a key literally spelled `id`/`name`/`toolName`
 * paired with a write-verb string is exactly the registration shape this
 * lock exists to catch.
 *
 * Documented residual (Opus review, same class as the `executeCommand`-
 * aliasing residual noted above): this is still a blunt TEXT scan, not an
 * AST/semantic analysis. A computed or aliased first argument — e.g.
 * `const NM = 'lsp_apply_edit'; registerTool(NM)` — or a name written as a
 * backtick template literal (`` `lsp_apply_edit` ``) cannot be caught by
 * this pattern, since neither shape puts a quoted string literal directly
 * after `registerTool(`/`name:`/`id:`/`toolName:`. This is one
 * defense-in-depth tripwire among several, not the sole guarantee — the real
 * never-mutate invariant is enforced at runtime by the command allowlist
 * guard (`lspCommandAllowlist.ts`) and by the architecture (LIB never holds
 * a write capability to begin with), same accepted-residual class as every
 * other static-scan ban in this file.
 */
const TOOL_NAME_DECL_PATTERN = /(?:registerTool\s*\(|\b(?:name|id|toolName)\s*:)\s*['"]([^'"]+)['"]/g;
const WRITE_SHAPED_NAME_PATTERN =
  /^(?:lsp_)?(?:write|create|apply|edit|delete|remove|rename|move|execute|run)[a-z_]*$/i;

/**
 * Scans each file's WHOLE content (not line-by-line — the tool name sits on
 * the line AFTER `registerTool(`) for a tool-name declaration in a
 * registration context ({@link TOOL_NAME_DECL_PATTERN}), and flags a
 * `ScanMatch` for every captured NAME that is itself write-shaped
 * ({@link WRITE_SHAPED_NAME_PATTERN}, anchored over the whole name). This is
 * the registration-scoped replacement for the old blunt any-quoted-token
 * `TOOL_NAME_PATTERN` (T4 review M-2). `matchAll` requires and safely handles
 * the `g` flag (fresh iterator per call — no `lastIndex` retention across
 * files, unlike the `RegExp.test` caveat documented on {@link scanLspSources});
 * the anchored write test is flag-less by construction. The line number is
 * derived from the match offset so a future RED still points a human at the
 * exact declaration. */
function scanRegisteredToolNames(files: readonly SourceFile[]): ScanMatch[] {
  const matches: ScanMatch[] = [];
  for (const source of files) {
    for (const decl of source.content.matchAll(TOOL_NAME_DECL_PATTERN)) {
      const name = decl[1];
      if (name === undefined || !WRITE_SHAPED_NAME_PATTERN.test(name)) {
        continue;
      }
      const offset = decl.index ?? 0;
      const line = source.content.slice(0, offset).split('\n').length;
      matches.push({ file: source.file, line, snippet: decl[0].trim() });
    }
  }
  return matches;
}

/**
 * fs-import ban (Opus review Important-1: broadened from `resultShaper*.ts`
 * only to EVERY non-test file under `src/mcp/lsp/` — see the "fs-import /
 * readFile ban" describe block below, which now runs this over
 * {@link loadLspSources}, the same file set the mutation bans already use).
 * No file in this directory legitimately imports node `fs`: the headless
 * transport files (`server.ts`, `libServerHost.ts`, `transportSecurity.ts`)
 * import `node:http`/`node:crypto`/`node:net` only, `lspGateway.ts` uses
 * `vscode.commands`/`vscode.languages`, and the pure files (`toolPipeline.ts`,
 * `resultShaper.ts`, `lspCommandAllowlist.ts`) import nothing from Node's fs
 * surface at all — snippet reads route through
 * `vscode.workspace.openTextDocument` (T6b) and confinement runs through the
 * injected realpath seam (`src/host/backend/acp/pathConfine.ts`), outside
 * this directory. Without this directory-wide ban, a future
 * `import { readFile } from 'node:fs'` added to ANY non-shaper lsp file
 * (e.g. `toolPipeline.ts`) would pass the lock silently, holding the
 * never-read-unconfined invariant by review only, not by mechanism.
 *
 * The pattern matches ONLY the `fs` module segment itself — the quote
 * immediately before, optional `node:` prefix, then exactly `fs` or
 * `fs/promises`, then the closing quote immediately after — so it does NOT
 * match `node:http`/`node:crypto`/`node:net`/`node:stream`/etc. (confirmed
 * by the negative-control test below against every import actually present
 * in this directory's non-test source files).
 */
const FS_IMPORT_PATTERN =
  /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"]fs['"]/;
const READFILE_CALL_PATTERN = /\breadFile\(/;

/**
 * vscode-import ban (W3 T6b): every non-test lsp file EXCEPT `lspGateway.ts`
 * — the ONE file T4's own module doc designates as "the ONE place LIB is
 * allowed to talk to VS Code's command surface" — must never import
 * `vscode`. Unlike the fs-import ban (genuinely zero legitimate callers),
 * this one has exactly one legitimate caller, so it cannot run unscoped the
 * way {@link FS_IMPORT_PATTERN} does; {@link scanNonGatewayLspSources} below
 * carries the exclusion. Also excludes any future `*.vscode.ts`-shaped
 * adapter file (T6b brief: "isolate it in `tools.vscode.ts`... that ONE file
 * may import vscode") by basename pattern, so a later T7 adapter file is
 * excluded automatically with zero edits here — the same forward-covering,
 * re-read-from-disk design {@link loadShaperSources} already uses. Matches
 * only an actual import/require of the literal `vscode` module specifier
 * (not the bare word "vscode" appearing in prose/doc comments elsewhere in
 * these files, which is common and expected).
 */
const VSCODE_IMPORT_PATTERN = /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]/;

/** `true` for `lspGateway.ts` itself and any `*.vscode.ts`-shaped adapter
 * file — the only files permitted to import `vscode`. */
function isVscodeImportExempt(fileName: string): boolean {
  return fileName === 'lspGateway.ts' || /\.vscode\.ts$/.test(fileName);
}

function scanNonGatewayLspSources(files: readonly SourceFile[], pattern: RegExp): ScanMatch[] {
  return scanLspSources(
    files.filter((f) => !isVscodeImportExempt(f.file)),
    pattern,
  );
}

const MUTATION_BAN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> =
  [
    { name: 'applyEdit', pattern: APPLY_EDIT_PATTERN },
    { name: 'resolveCodeAction', pattern: RESOLVE_CODE_ACTION_PATTERN },
    {
      name: 'workspace.fs write/rename/delete/copy/createDirectory',
      pattern: WORKSPACE_FS_WRITE_PATTERN,
    },
    { name: 'createTerminal', pattern: CREATE_TERMINAL_PATTERN },
    { name: 'tasks.execute*', pattern: TASKS_EXECUTE_PATTERN },
  ];

const ALLOWED_IDS: readonly string[] = [
  'vscode.executeDefinitionProvider',
  'vscode.executeReferenceProvider',
  'vscode.executeDocumentSymbolProvider',
  'vscode.executeWorkspaceSymbolProvider',
  'vscode.executeHoverProvider',
  'vscode.executeCodeActionProvider',
];

/**
 * I-7 LIB-jurisdiction `executeCommand` scan (`src/host/lib/*.vscode.ts`).
 *
 * UNLIKE {@link scanNonGatewayLspSources}'s companion check in the mcp/lsp
 * root — which bans `executeCommand(` OUTRIGHT everywhere except
 * `lspGateway.ts`, zero exceptions, because no lsp-root file has any
 * legitimate reason to call it — this scan runs over the ONE place `vscode`
 * IS legitimately in scope (the `.vscode.ts` adapter) and so needs a
 * genuine allowlist-shaped exemption per this task's binding constraint: a
 * line matching {@link EXECUTE_COMMAND_PATTERN} is a violation UNLESS that
 * same line also names one of the 6 {@link ALLOWED_IDS} read-verb command
 * IDs — the identical set `lspGateway.ts`'s own runtime guard
 * (`assertAllowlistedCommand`) enforces. Reuses {@link EXECUTE_COMMAND_PATTERN}
 * as-is (same evasion-hardened regex, same DRY constant — no duplicated
 * literal), so the space/bracket/alias-evasion forms already locked by the
 * mcp/lsp self-check block are covered here "for free" with zero
 * reimplementation; not re-tested in this section to avoid duplicating that
 * coverage.
 *
 * Today `libToolDeps.vscode.ts` never calls `executeCommand` at all — every
 * LSP read routes through `LspToolGateway`'s typed methods, which delegate
 * to T4's `lspGateway.ts` internally — so this scan currently passes
 * vacuously against the real file; it exists as the forward-looking
 * tripwire I-7 asks for (a future refactor that inlines a raw
 * `vscode.commands.executeCommand(...)` call directly into this adapter,
 * bypassing the gateway, is caught immediately unless it uses one of the 6
 * allowlisted IDs).
 */
function scanLibExecuteCommand(files: readonly SourceFile[]): ScanMatch[] {
  const matches: ScanMatch[] = [];
  for (const source of files) {
    const lines = source.content.split('\n');
    for (const [index, lineText] of lines.entries()) {
      if (!EXECUTE_COMMAND_PATTERN.test(lineText)) {
        continue;
      }
      const isAllowlisted = ALLOWED_IDS.some((id) => lineText.includes(id));
      if (!isAllowlisted) {
        matches.push({ file: source.file, line: index + 1, snippet: lineText.trim() });
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Real-code assertions — keep these RED for `applyEdit`, non-allowlisted
// `executeCommand(`, `resolveCodeAction`, `workspace.fs.write*`,
// `createTerminal`, `tasks.execute*`, write-shaped tool names, and
// `fs`/`readFile` imports in the shaper, across every current and future
// non-test file under src/mcp/lsp/.
// ---------------------------------------------------------------------------

describe('lspInvariant — global mutation bans (every non-test lsp file)', () => {
  const sources = loadLspSources();

  it('discovers at least the T1/T2/T4 lsp module files (non-vacuous file discovery)', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.file === 'lspGateway.ts')).toBe(true);
    expect(sources.some((s) => s.file === 'lspCommandAllowlist.ts')).toBe(true);
  });

  for (const { name, pattern } of MUTATION_BAN_PATTERNS) {
    it(`no non-test lsp file contains ${name}`, () => {
      expect(scanLspSources(sources, pattern)).toEqual([]);
    });
  }
});

describe('lspInvariant — executeCommand containment', () => {
  it('executeCommand( appears ONLY in lspGateway.ts', () => {
    const sources = loadLspSources();
    const nonGatewaySources = sources.filter((s) => s.file !== 'lspGateway.ts');
    expect(scanLspSources(nonGatewaySources, EXECUTE_COMMAND_PATTERN)).toEqual([]);
  });

  it('executeCommand( appears in lspGateway.ts itself (sanity: the containment check above is not vacuously true because the pattern matches nothing anywhere)', () => {
    const sources = loadLspSources();
    const gateway = requireFile(sources, 'lspGateway.ts');
    expect(scanLspSources([gateway], EXECUTE_COMMAND_PATTERN).length).toBeGreaterThan(0);
  });
});

/**
 * Task 8 fix wave (task-8-review.md Important-1/3/4) — `lspGateway.ts` /
 * `lspCommandAllowlist.ts` guard-call integrity. Closes three claims the
 * task-8 report made about black-box unit testing (`lspGateway.test.ts`)
 * being structurally unable to catch: a verb bypassing `run()` entirely, an
 * env-gated no-op guard, and a swallowed guard throw. Same mechanism this
 * whole file already uses for every other invariant here — a plain
 * source-TEXT ban scan, re-read from disk on every run, not a behavioural
 * assertion. Per this programme's binding polarity rule
 * (`suppressionCommentBan.test.ts`'s header): a scan that BANS a pattern
 * fails CLOSED when it is blind to a file; every check below is a ban, none
 * is a presence check.
 *
 * Scoped to the two files that jointly implement the guard —
 * `lspGateway.ts` (the call site, inside `run()`) and
 * `lspCommandAllowlist.ts` (the guard's own definition) — rather than
 * directory-wide, for two different reasons per pattern:
 *  - The try/catch ban CANNOT run directory-wide: `server.ts`,
 *    `toolPipeline.ts`, `tools.ts`, and `libServerHost.ts` all have
 *    legitimate try/catch blocks (verified by the reviewer), so an
 *    unscoped ban would be false-positive-prone on day one.
 *  - The env-branch ban has zero false positives directory-wide (reviewer
 *    verified this against the real tree), but is scoped the same way
 *    anyway: `assertAllowlistedCommand` is defined in
 *    `lspCommandAllowlist.ts` and called only from `lspGateway.ts`, so an
 *    env-gated guard can only ever be planted in one of these two files —
 *    scoping to exactly the files capable of hiding the defect is the same
 *    "scope to the real blast radius" principle the try/catch ban needs for
 *    a different reason. Verified zero occurrences in either file today.
 *
 * The single-call-site pin (Important-1) is scoped to `lspGateway.ts` only
 * — `lspCommandAllowlist.ts` never imports `vscode` (headless by design,
 * `lspCommandAllowlist.test.ts`'s own module doc), so it cannot contain an
 * `executeCommand` call at all.
 */
const ENV_BRANCH_BAN = /process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|\bNODE_ENV\b|\bVITEST\b/;
const TRY_CATCH_GUARD_BAN = /^\s*(?:\}\s*)?catch\s*[({]|^\s*try\s*\{/;

/** The two files that jointly implement the runtime guard. */
function loadGuardIntegrityScope(): SourceFile[] {
  const sources = loadLspSources();
  return [requireFile(sources, 'lspGateway.ts'), requireFile(sources, 'lspCommandAllowlist.ts')];
}

describe('lspInvariant — lspGateway.ts / lspCommandAllowlist.ts guard-call integrity (task-8-review.md Important-1/3/4)', () => {
  it('reach: discovers both guard-implementing files (non-vacuous)', () => {
    const scope = loadGuardIntegrityScope();
    expect(scope.map((f) => f.file).sort()).toEqual(['lspCommandAllowlist.ts', 'lspGateway.ts']);
  });

  it('neither file references process.env / import.meta.env / NODE_ENV / VITEST (Important-3: closes the env-gated-guard mutation — confirmed dark under lspGateway.test.ts alone, per task-8-report.md Plant 5)', () => {
    expect(scanLspSources(loadGuardIntegrityScope(), ENV_BRANCH_BAN)).toEqual([]);
  });

  it('neither file contains a try/catch (Important-4: closes the swallowed-guard-throw mutation; lspGateway.ts:99 already claims "no try/catch" in prose — this is what enforces that claim instead of leaving it unmechanized)', () => {
    expect(scanLspSources(loadGuardIntegrityScope(), TRY_CATCH_GUARD_BAN)).toEqual([]);
  });

  it('executeCommand( appears exactly ONCE inside lspGateway.ts — the sole call site lives in run() (Important-1: a verb bypassing run(), e.g. getCodeActions calling executeCommand directly, adds a second occurrence and reddens here)', () => {
    const sources = loadLspSources();
    const gateway = requireFile(sources, 'lspGateway.ts');
    expect(scanLspSources([gateway], EXECUTE_COMMAND_PATTERN)).toHaveLength(1);
  });
});

describe('lspInvariant — guard-call integrity non-vacuous self-check', () => {
  it('flags a synthetic process.env-gated branch', () => {
    const synthetic: SourceFile[] = [
      { file: 'lspGateway.ts', content: '  if (process.env.VITEST !== undefined) {\n' },
    ];
    expect(scanLspSources(synthetic, ENV_BRANCH_BAN).length).toBe(1);
  });

  it('flags each of the other three env-branch forms (import.meta.env, bare NODE_ENV, bare VITEST)', () => {
    const synthetic: SourceFile[] = [
      { file: 'a.ts', content: '  if (import.meta.env.MODE === "test") {\n' },
      { file: 'b.ts', content: "  if (NODE_ENV !== 'production') {\n" },
      { file: 'c.ts', content: '  if (typeof VITEST !== "undefined") {\n' },
    ];
    expect(scanLspSources(synthetic, ENV_BRANCH_BAN).length).toBe(3);
  });

  it('flags a synthetic try/catch wrapping the guard call (the exact Plant 3 shape from task-8-report.md)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'lspGateway.ts',
        content: 'try {\n  assertAllowlistedCommand(commandId);\n} catch {\n  // swallowed\n}\n',
      },
    ];
    expect(scanLspSources(synthetic, TRY_CATCH_GUARD_BAN).length).toBe(2);
  });

  it('does NOT flag the real lspGateway.ts prose that mentions "try/catch" in a doc comment (negative control — the exact line this ban depends on staying prose-only, currently line 99)', () => {
    const sources = loadLspSources();
    const gateway = requireFile(sources, 'lspGateway.ts');
    expect(gateway.content).toMatch(/no `try\/catch`/);
    expect(scanLspSources([gateway], TRY_CATCH_GUARD_BAN)).toEqual([]);
  });

  it('the executeCommand( single-call-site scan can count past one (non-vacuous — proves the assertion above is a real count, not incidentally true)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'lspGateway.ts',
        content:
          '  return vscode.commands.executeCommand(commandId, ...args);\n' +
          '  return vscode.commands.executeCommand(otherId, ...args);\n',
      },
    ];
    expect(scanLspSources(synthetic, EXECUTE_COMMAND_PATTERN).length).toBe(2);
  });

  it('the executeCommand( pattern matches the real generic-typed call shape lspGateway.ts actually uses (regression lock for the Task 8 broadening above)', () => {
    const synthetic: SourceFile[] = [
      { file: 'lspGateway.ts', content: '  return vscode.commands.executeCommand<T>(commandId, ...args);\n' },
    ];
    expect(scanLspSources(synthetic, EXECUTE_COMMAND_PATTERN).length).toBe(1);
  });
});

describe('lspInvariant — hard-allowlist pin', () => {
  it('LSP_READ_COMMANDS equals exactly the 6 execute*Provider IDs (T8b added executeCodeActionProvider)', () => {
    expect(LSP_READ_COMMANDS.size).toBe(6);
    for (const id of ALLOWED_IDS) {
      expect(LSP_READ_COMMANDS.has(id)).toBe(true);
    }
  });

  it('lspGateway.ts source references each of the 6 allowlisted IDs', () => {
    const sources = loadLspSources();
    const gateway = requireFile(sources, 'lspGateway.ts');
    for (const id of ALLOWED_IDS) {
      expect(gateway.content.includes(id)).toBe(true);
    }
  });
});

describe('lspInvariant — write-shaped tool-name ban (scoped to registration context, T4 review M-2)', () => {
  it('no non-test lsp file REGISTERS a write-shaped tool name', () => {
    const sources = loadLspSources();
    expect(scanRegisteredToolNames(sources)).toEqual([]);
  });

  it('does NOT mis-flag the mandated CodeActionStatus data literals (the M-2 regression this fix closes)', () => {
    // The exact §6.1-pinned union T8a's codeActionSerialize.ts declares — a
    // real DATA string-literal type, NOT a tool name. The old blunt pattern
    // flagged the bare `'edit'` member; the scoped scan must not, because it
    // is in no registration context.
    const synthetic: SourceFile[] = [
      {
        file: 'codeActionSerialize.ts',
        content:
          "export type CodeActionStatus = 'edit' | 'edit-incomplete' | 'command-only' | 'unsupported-edit';\n" +
          "  const status: CodeActionStatus = action.hasCommand ? 'edit-incomplete' : 'edit';\n",
      },
    ];
    expect(scanRegisteredToolNames(synthetic)).toEqual([]);
  });
});

describe('lspInvariant — resultShaper.ts discovery (forward-covering; landed in T5)', () => {
  const shaperSources = loadShaperSources();

  // T5 has landed `resultShaper.ts` — the forward-covering discovery
  // mechanism documented at T4 ("this activates automatically the moment
  // resultShaper.ts... lands") now fires for real, with zero changes to
  // `loadShaperSources`/`LSP_DIR` scanning above. This assertion replaces
  // the T4-era "confirms this rule is currently vacuous" placeholder (which
  // asserted `shaperSources` was empty — true only until T5 existed, by
  // that test's own documented, anticipated design). The fs-import /
  // readFile bans that used to live in this describe block now run over
  // every non-test lsp file (see below) — kept here is only the
  // shaper-specific non-vacuous discovery proof.
  it('discovers resultShaper.ts now that T5 has landed (non-vacuous file discovery)', () => {
    expect(shaperSources.length).toBeGreaterThan(0);
    expect(shaperSources.some((s) => s.file === 'resultShaper.ts')).toBe(true);
  });
});

describe('lspInvariant — fs-import / readFile ban (every non-test lsp file, Opus review Important-1)', () => {
  const sources = loadLspSources();

  it('no non-test lsp file imports fs (broadened beyond resultShaper*.ts)', () => {
    expect(scanLspSources(sources, FS_IMPORT_PATTERN)).toEqual([]);
  });

  it('no non-test lsp file calls readFile (broadened beyond resultShaper*.ts)', () => {
    expect(scanLspSources(sources, READFILE_CALL_PATTERN)).toEqual([]);
  });

  // Locks the tightening in-suite (not just verified by hand at write-time):
  // the module-boundary `fs`/`node:fs`/`fs/promises` match must NOT fire on
  // the legitimate `node:http`/`node:crypto`/`node:net` imports actually
  // used by server.ts/libServerHost.ts/transportSecurity.ts.
  it('does NOT false-positive on the legitimate node:http/node:crypto/node:net imports (negative control)', () => {
    const legit: SourceFile[] = [
      { file: 'server.ts', content: "import * as http from 'node:http';\n" },
      {
        file: 'libServerHost.ts',
        content:
          "import * as crypto from 'node:crypto';\nimport * as http from 'node:http';\nimport type { Socket } from 'node:net';\n",
      },
      { file: 'transportSecurity.ts', content: "import { timingSafeEqual } from 'node:crypto';\n" },
    ];
    expect(scanLspSources(legit, FS_IMPORT_PATTERN)).toEqual([]);
  });
});

describe('lspInvariant — vscode-import ban (every non-test lsp file except lspGateway.ts, W3 T6b)', () => {
  const sources = loadLspSources();

  it('discovers tools.ts now that T6b has landed (non-vacuous file discovery)', () => {
    expect(sources.some((s) => s.file === 'tools.ts')).toBe(true);
  });

  it('no non-gateway non-test lsp file imports vscode', () => {
    expect(scanNonGatewayLspSources(sources, VSCODE_IMPORT_PATTERN)).toEqual([]);
  });

  it('lspGateway.ts itself (the one exempt file) DOES import vscode (sanity: the exemption is real, not vacuous)', () => {
    const gateway = requireFile(sources, 'lspGateway.ts');
    expect(VSCODE_IMPORT_PATTERN.test(gateway.content)).toBe(true);
  });

  it('does NOT false-positive on mere prose mentions of "vscode" (negative control)', () => {
    const legit: SourceFile[] = [
      {
        file: 'tools.ts',
        content:
          '/** the real vscode adapter is T7\'s job; this file never imports vscode. */\n' +
          "const description = 'talks about vscode without ever importing it';\n",
      },
    ];
    expect(scanNonGatewayLspSources(legit, VSCODE_IMPORT_PATTERN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED non-vacuous self-check: proves every pattern above can actually
// flag a violation, against synthetic in-memory strings — never by editing
// real source files. Without this, the empty-array assertions above could be
// passing only because a regex typo makes them unmatchable, and the suite
// would stay green while providing zero protection.
// ---------------------------------------------------------------------------

describe('lspInvariant — non-vacuous self-check (each pattern flags a synthetic violation)', () => {
  it('flags a synthetic applyEdit violation', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: '  vscode.workspace.applyEdit(edit);\n' },
    ];
    expect(scanLspSources(synthetic, APPLY_EDIT_PATTERN).length).toBe(1);
  });

  it('flags a synthetic resolveCodeAction violation', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: '  await vscode.commands.resolveCodeAction(action);\n' },
    ];
    expect(scanLspSources(synthetic, RESOLVE_CODE_ACTION_PATTERN).length).toBe(1);
  });

  it('flags a synthetic workspace.fs.writeFile violation', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: '  await vscode.workspace.fs.writeFile(uri, data);\n' },
    ];
    expect(scanLspSources(synthetic, WORKSPACE_FS_WRITE_PATTERN).length).toBe(1);
  });

  it('flags a synthetic workspace.fs.rename/delete/copy/createDirectory violation', () => {
    const synthetic: SourceFile[] = [
      { file: 'a.ts', content: 'workspace.fs.rename(a, b);' },
      { file: 'b.ts', content: 'workspace.fs.delete(u);' },
      { file: 'c.ts', content: 'workspace.fs.copy(a, b);' },
      { file: 'd.ts', content: 'workspace.fs.createDirectory(u);' },
    ];
    expect(scanLspSources(synthetic, WORKSPACE_FS_WRITE_PATTERN).length).toBe(4);
  });

  it('flags a synthetic createTerminal violation', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: '  const term = vscode.window.createTerminal();\n' },
    ];
    expect(scanLspSources(synthetic, CREATE_TERMINAL_PATTERN).length).toBe(1);
  });

  it('flags a synthetic tasks.executeTask violation', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: '  await vscode.tasks.executeTask(task);\n' },
    ];
    expect(scanLspSources(synthetic, TASKS_EXECUTE_PATTERN).length).toBe(1);
  });

  it('flags a synthetic non-allowlisted executeCommand violation', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'synthetic.ts',
        content: "  x.executeCommand('workbench.action.files.save');\n",
      },
    ];
    expect(scanLspSources(synthetic, EXECUTE_COMMAND_PATTERN).length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Evasion-form regression lock (Opus review Important-1): a future
  // non-gateway lsp file could dodge the ORIGINAL narrow regexes with
  // non-obfuscated, prettier-legal TypeScript. Each of these three forms
  // must FLAG under the (broadened) patterns below.
  // ---------------------------------------------------------------------

  it('flags an executeCommand call with a space before the paren (evasion form)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'synthetic.ts',
        content: "  commands.executeCommand ('workbench.action.files.save');\n",
      },
    ];
    expect(scanLspSources(synthetic, EXECUTE_COMMAND_PATTERN).length).toBe(1);
  });

  it('flags a bracket/dynamic-key executeCommand call (evasion form)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'synthetic.ts',
        content: "  commands['executeCommand'](id);\n",
      },
    ];
    expect(scanLspSources(synthetic, EXECUTE_COMMAND_PATTERN).length).toBe(1);
  });

  it('flags an aliased workspace.fs write (evasion form)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'synthetic.ts',
        content: '  const a = workspace.fs;\n  a.writeFile(uri, data);\n',
      },
    ];
    // The aliasing itself (`const a = workspace.fs;`) is what a naive
    // literal-dot scan would miss; assert the ALIAS DECLARATION line is
    // caught (the write call `a.writeFile(...)` no longer mentions
    // `workspace.fs` at all, so the lock must catch the point where the
    // alias is taken, not the call site).
    expect(scanLspSources(synthetic, WORKSPACE_FS_WRITE_PATTERN).length).toBe(1);
  });

  it('flags a synthetic write-shaped tool name declared via a name: field', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: "  name: 'lsp_apply_edit',\n" },
    ];
    expect(scanRegisteredToolNames(synthetic).length).toBe(1);
  });

  it('flags a synthetic write-shaped tool name declared via registerTool(...) (incl. the real multi-line form)', () => {
    // The real T6 registration shape: `registerTool(` on one line, the
    // name string on the NEXT — the whole-content scan must span that.
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: "  server.registerTool(\n    'lsp_apply_edit',\n    { title: 'x' },\n  );\n" },
    ];
    expect(scanRegisteredToolNames(synthetic).length).toBe(1);
  });

  it('flags a synthetic write-shaped tool name declared via a toolName: field (M-1: broadened key alternation)', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: "  toolName: 'lsp_delete_file',\n" },
    ];
    expect(scanRegisteredToolNames(synthetic).length).toBe(1);
  });

  it('flags a synthetic write-shaped tool name declared via an id: field (M-1: broadened key alternation)', () => {
    const synthetic: SourceFile[] = [
      { file: 'synthetic.ts', content: "  id: 'lsp_apply_edit',\n" },
    ];
    expect(scanRegisteredToolNames(synthetic).length).toBe(1);
  });

  it('does NOT flag the real read-shaped tool names, in either declaration context (negative control)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'synthetic.ts',
        content: [
          "  name: 'lsp_diagnostics',",
          "  name: 'lsp_definition',",
          "  name: 'lsp_references',",
          "  name: 'lsp_document_symbols',",
          "  name: 'lsp_workspace_symbols',",
          "  name: 'lsp_hover',",
          "  server.registerTool('lsp_code_actions', { title: 'x' });",
        ].join('\n'),
      },
    ];
    expect(scanRegisteredToolNames(synthetic)).toEqual([]);
  });

  it('does NOT flag a write-verb-root token that is a plain data string, not a registered name (negative control, M-2)', () => {
    // The core M-2 regression: bare quoted verb-root tokens as ordinary data
    // (a status union member, a switch case) are NOT in a registration
    // context and must stay green.
    const synthetic: SourceFile[] = [
      {
        file: 'synthetic.ts',
        content:
          "export type CodeActionStatus = 'edit' | 'edit-incomplete';\n" +
          "const x = cond ? 'edit-incomplete' : 'edit';\n" +
          "case 'delete': return handleDelete();\n",
      },
    ];
    expect(scanRegisteredToolNames(synthetic)).toEqual([]);
  });

  it('flags a synthetic fs import in a shaper-shaped file', () => {
    const synthetic: SourceFile[] = [
      { file: 'resultShaper.ts', content: "import { readFile } from 'node:fs/promises';\n" },
    ];
    expect(scanLspSources(synthetic, FS_IMPORT_PATTERN).length).toBe(1);
  });

  it('flags a synthetic readFile call in a shaper-shaped file', () => {
    const synthetic: SourceFile[] = [
      { file: 'resultShaper.ts', content: "  const data = readFile(path);\n" },
    ];
    expect(scanLspSources(synthetic, READFILE_CALL_PATTERN).length).toBe(1);
  });

  it('flags a synthetic vscode import in a non-gateway file (e.g. a would-be tools.ts regression)', () => {
    const synthetic: SourceFile[] = [{ file: 'tools.ts', content: "import * as vscode from 'vscode';\n" }];
    expect(scanNonGatewayLspSources(synthetic, VSCODE_IMPORT_PATTERN).length).toBe(1);
  });

  it('does NOT flag the same vscode import when attributed to lspGateway.ts (the exempt file)', () => {
    const synthetic: SourceFile[] = [{ file: 'lspGateway.ts', content: "import * as vscode from 'vscode';\n" }];
    expect(scanNonGatewayLspSources(synthetic, VSCODE_IMPORT_PATTERN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I-7 (3-way arch review) — LIB jurisdiction extension: `src/host/lib/*.vscode.ts`
//
// A SECOND, independent scan root (`src/host/lib/`, not `src/mcp/lsp/`) with
// a TAILORED pattern set, per the brief's binding constraints:
//   APPLIED    — the executeCommand-outside-the-read-allowlist ban
//                ({@link scanLibExecuteCommand}, reusing
//                {@link EXECUTE_COMMAND_PATTERN}/{@link ALLOWED_IDS} as-is)
//                and the workspace.fs-write ban (reusing
//                {@link WORKSPACE_FS_WRITE_PATTERN} as-is, same
//                aliasing-evasion hardening, zero exceptions — same
//                treatment the mcp/lsp root gives it).
//   NOT applied — the vscode-import ban ({@link VSCODE_IMPORT_PATTERN}):
//                this IS the legitimate `.vscode.ts` adapter, by repo
//                convention (that's exactly why it lives outside
//                `mcp/lsp/` — `isVscodeImportExempt` already encodes this
//                for the mcp/lsp root's own scan).
//   EXEMPTED with a documented reason — the fs-import ban
//                ({@link FS_IMPORT_PATTERN}): `libToolDeps.vscode.ts`
//                legitimately imports `node:fs` (`promises as fs`) for
//                exactly one call, `fs.realpath(root)` in
//                `realpathLiveRoots()` — canonicalizing the LIVE workspace
//                roots that feed `classifyUri`'s confinement verdict
//                (`buildConfinementVerdict`) and `resolvePathArg`'s
//                containment check (`resolveWithinWorkspaceReal`). That fs
//                use is not incidental — it directly STRENGTHENS the
//                never-read-unconfined invariant elsewhere; banning fs here
//                would break the file's actual security-relevant job.
//                Unlike the mcp/lsp root (genuinely zero legitimate `fs`
//                callers, so an unconditional ban is free), this root has
//                exactly one legitimate caller with exactly one legitimate
//                call site, so — mirroring how the vscode-import ban cannot
//                run unscoped over its one legitimate caller either — the
//                fs-import ban is intentionally NOT applied here, pinned by
//                an explicit sanity assertion below (not left as a silent
//                omission).
// ---------------------------------------------------------------------------

describe('lspInvariant — LIB jurisdiction extension (I-7): src/host/lib/*.vscode.ts', () => {
  const libSources = loadLibVscodeSources();

  it('discovers libToolDeps.vscode.ts (non-vacuous file discovery)', () => {
    expect(libSources.length).toBeGreaterThan(0);
    expect(libSources.some((s) => s.file === 'libToolDeps.vscode.ts')).toBe(true);
  });

  it('no *.vscode.ts LIB adapter contains a non-allowlisted executeCommand call', () => {
    expect(scanLibExecuteCommand(libSources)).toEqual([]);
  });

  // B11: the FULL MUTATION_BAN_PATTERNS set (applyEdit, resolveCodeAction,
  // workspace.fs write/rename/delete/copy/createDirectory, createTerminal,
  // tasks.execute*) applied to the LIB root — mirrors the main lsp scan's
  // loop (`lspInvariant — global mutation bans`, above) verbatim, same
  // constants, same `scanLspSources` helper, zero new/duplicated regex. This
  // replaces the single standalone `workspace.fs` LIB test that used to sit
  // here (that ban's behavior is unchanged — it is pattern #3 in the array —
  // this loop just also now covers the four verbs that were previously
  // unscanned against `libSources`: applyEdit/resolveCodeAction/
  // createTerminal/tasks.execute* (backlog B11). `libToolDeps.vscode.ts` has
  // zero occurrences of any of the five verbs today (grep-confirmed at
  // write-time), so this loop is forward-hardening, not a currently-active
  // catch — non-vacuity comes from the synthetic self-checks below.
  for (const { name, pattern } of MUTATION_BAN_PATTERNS) {
    it(`no *.vscode.ts LIB adapter contains ${name}`, () => {
      expect(scanLspSources(libSources, pattern)).toEqual([]);
    });
  }

  it('libToolDeps.vscode.ts DOES import vscode (sanity: the vscode-import ban is intentionally NOT applied here — this is the legitimate .vscode.ts adapter, not a vacuous exemption)', () => {
    const adapter = requireFile(libSources, 'libToolDeps.vscode.ts');
    expect(VSCODE_IMPORT_PATTERN.test(adapter.content)).toBe(true);
  });

  it('libToolDeps.vscode.ts DOES import node:fs (sanity: the fs-import ban is intentionally EXEMPTED here, not vacuously absent — fs.realpath() is required for live workspace-root canonicalization feeding classifyUri\'s confinement verdict)', () => {
    const adapter = requireFile(libSources, 'libToolDeps.vscode.ts');
    expect(FS_IMPORT_PATTERN.test(adapter.content)).toBe(true);
  });
});

describe('lspInvariant — LIB jurisdiction non-vacuous self-check (I-7)', () => {
  it('flags a synthetic non-allowlisted executeCommand call in a *.vscode.ts LIB adapter', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'libToolDeps.vscode.ts',
        content: "  vscode.commands.executeCommand('someWriteCommand', uri);\n",
      },
    ];
    expect(scanLibExecuteCommand(synthetic).length).toBe(1);
  });

  it('does NOT flag an ALLOWLISTED executeCommand call in a *.vscode.ts LIB adapter (negative control — the read-verb exemption the brief requires)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'libToolDeps.vscode.ts',
        content:
          "  await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);\n",
      },
    ];
    expect(scanLibExecuteCommand(synthetic)).toEqual([]);
  });

  it('flags a synthetic workspace.fs.writeFile call in a *.vscode.ts LIB adapter', () => {
    const synthetic: SourceFile[] = [
      { file: 'libToolDeps.vscode.ts', content: '  await vscode.workspace.fs.writeFile(uri, data);\n' },
    ];
    expect(scanLspSources(synthetic, WORKSPACE_FS_WRITE_PATTERN).length).toBe(1);
  });

  // B11 — mirrors the four self-checks above, proving the LIB scanner path
  // (`scanLspSources` over `libSources`-shaped input) actually flags the four
  // previously-unscanned MUTATION_BAN_PATTERNS members too, not just
  // workspace.fs/executeCommand. Each uses the same constants the real-file
  // loop above uses — no new regex.

  it('flags a synthetic applyEdit call in a *.vscode.ts LIB adapter', () => {
    const synthetic: SourceFile[] = [
      { file: 'libToolDeps.vscode.ts', content: '  await vscode.workspace.applyEdit(edit);\n' },
    ];
    expect(scanLspSources(synthetic, APPLY_EDIT_PATTERN).length).toBe(1);
  });

  it('flags a synthetic resolveCodeAction call in a *.vscode.ts LIB adapter', () => {
    const synthetic: SourceFile[] = [
      { file: 'libToolDeps.vscode.ts', content: '  await vscode.commands.resolveCodeAction(action);\n' },
    ];
    expect(scanLspSources(synthetic, RESOLVE_CODE_ACTION_PATTERN).length).toBe(1);
  });

  it('flags a synthetic createTerminal call in a *.vscode.ts LIB adapter', () => {
    const synthetic: SourceFile[] = [
      { file: 'libToolDeps.vscode.ts', content: '  const term = vscode.window.createTerminal();\n' },
    ];
    expect(scanLspSources(synthetic, CREATE_TERMINAL_PATTERN).length).toBe(1);
  });

  it('flags a synthetic tasks.executeTask call in a *.vscode.ts LIB adapter', () => {
    const synthetic: SourceFile[] = [
      { file: 'libToolDeps.vscode.ts', content: '  await vscode.tasks.executeTask(task);\n' },
    ];
    expect(scanLspSources(synthetic, TASKS_EXECUTE_PATTERN).length).toBe(1);
  });

  it('does NOT flag a *.vscode.ts LIB adapter file that only imports vscode/fs and calls no banned verb (negative control)', () => {
    const synthetic: SourceFile[] = [
      {
        file: 'libToolDeps.vscode.ts',
        content:
          "import { promises as fs } from 'node:fs';\nimport * as vscode from 'vscode';\nconst doc = await vscode.workspace.openTextDocument(uri);\nconst real = await fs.realpath(root);\n",
      },
    ];
    expect(scanLibExecuteCommand(synthetic)).toEqual([]);
    // B11: the clean-source negative control now also covers the four
    // newly-applied MUTATION_BAN_PATTERNS members (not just workspace.fs) —
    // a genuinely clean LIB adapter must flag nothing under any of them.
    for (const { pattern } of MUTATION_BAN_PATTERNS) {
      expect(scanLspSources(synthetic, pattern)).toEqual([]);
    }
  });
});
