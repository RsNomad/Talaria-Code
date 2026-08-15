import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * TB-1 / AU-2 / ADR-2 — the build-blind-boundary guard.
 *
 * `WebTreeSitterParser.real.test.ts` proves the SOURCE loads every bundled
 * grammar correctly, but that test runs the `.ts` source straight through
 * vitest's own loader — structurally blind to defects `esbuild.js`'s
 * bundling could introduce (the project's own precedent for this class of
 * bug: `codebase-server.smoke.test.ts`'s doc comment records a real one,
 * `import.meta.url` collapsing to `{}` under esbuild's CJS output, that
 * every unit test and `tsc` stayed green on).
 *
 * `web-tree-sitter` is one of only two packages `esbuild.js` marks
 * `external` (`NATIVE_EXTERNAL`) rather than bundling — so `dist/extension.js`
 * ships a real, un-inlined `require("web-tree-sitter")`, and at runtime that
 * resolves via Node's ordinary `node_modules` walk-up from wherever
 * `dist/extension.js` itself lives. In a packaged `.vsix`, that is the
 * extension's install root: `<root>/dist/extension.js` requiring a package
 * that must exist at `<root>/node_modules/web-tree-sitter` — exactly the
 * `.vscodeignore` allow-list contract (`!node_modules/web-tree-sitter/**`,
 * `!node_modules/tree-sitter-wasms/**`).
 *
 * Deliberately does NOT rebuild `dist/` itself in a `beforeAll` (unlike
 * `codebase-server.smoke.test.ts`): vitest runs test files concurrently, and
 * `esbuild.js`'s `context.rebuild()` writes `dist/extension.js` and
 * `dist/mcp/codebase-server.js` non-atomically — a second concurrent
 * `node esbuild.js` invocation racing `codebase-server.smoke.test.ts`'s own
 * rebuild produced a genuine torn read here during development (this file's
 * first test caught an empty string mid-write). `npm test`'s `pretest` hook
 * (`npm run build`) already guarantees a fresh, stable `dist/` before vitest
 * starts for every real gate run; this file only reads `esbuild.js`'s own
 * SOURCE (stable, not concurrently mutated) for the externality check below,
 * and its second test never reads `dist/extension.js`'s content at all — it
 * only needs the `dist/` directory to exist as a location, which it creates
 * itself (idempotent, safe to race).
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('web-tree-sitter build-blind-boundary (TB-1/AU-2/ADR-2)', () => {
  it('esbuild.js still marks web-tree-sitter external (not bundled/inlined) for both entry points', () => {
    const esbuildConfigSource = readFileSync(path.join(repoRoot, 'esbuild.js'), 'utf8');
    const match = esbuildConfigSource.match(/NATIVE_EXTERNAL\s*=\s*(\[[^\]]*\])/);
    expect(match, 'expected esbuild.js to define a NATIVE_EXTERNAL array').toBeTruthy();
    // Plain text containment on the matched array literal — deliberately NOT
    // `eval`/`Function` (no reason to execute config source to read one
    // string out of a literal array).
    expect(match?.[1]).toMatch(/(['"])web-tree-sitter\1/);
  });

  it(
    'a real grammar loads via Node module resolution FROM dist/ — the exact directory shape a packaged .vsix ships',
    () => {
      const distDir = path.join(repoRoot, 'dist');
      mkdirSync(distDir, { recursive: true });

      const script = [
        'const { Parser, Language } = require("web-tree-sitter");',
        'const path = require("node:path");',
        '(async () => {',
        '  await Parser.init();',
        '  const grammarPath = path.join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out", "tree-sitter-typescript.wasm");',
        '  const language = await Language.load(grammarPath);',
        '  const parser = new Parser();',
        '  parser.setLanguage(language);',
        '  const tree = parser.parse("const x: number = 1;");',
        '  if (!tree || !tree.rootNode || tree.rootNode.hasError) {',
        '    process.stderr.write("PARSE_FAILED_OR_ERROR_NODE");',
        '    process.exitCode = 1;',
        '    return;',
        '  }',
        '  process.stdout.write("OK:" + tree.rootNode.type);',
        '})().catch((err) => {',
        '  process.stderr.write(String((err && err.stack) || err));',
        '  process.exitCode = 1;',
        '});',
      ].join('\n');

      // Unique per-run filename: this test's own concurrency safety (against
      // a second run of ITSELF, e.g. `--repeat`) — never shared with, or
      // read by, any other test file.
      const scriptPath = path.join(distDir, `__tb1_wasm_resolve_check_${process.pid}.cjs`);
      writeFileSync(scriptPath, script, 'utf8');
      try {
        const output = execFileSync(process.execPath, [scriptPath], {
          cwd: distDir,
          encoding: 'utf8',
        });
        expect(output.trim()).toBe('OK:program');
      } finally {
        rmSync(scriptPath, { force: true });
      }
    },
    30_000,
  );
});
