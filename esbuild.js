// Host bundle: src/extension.ts -> dist/extension.js
// CommonJS, node platform, `vscode` kept external (provided by the runtime).
// Flags: --production (minify, no sourcemap), --watch (rebuild on change).
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Prints VS Code-friendly build markers so the tasks.json background
 * problem matcher can detect start/end and surface errors in the editor.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

// Native/WASM modules can't be bundled by esbuild — they ship their own
// loader (`.node` binary for LanceDB, `.wasm` loader for web-tree-sitter) that
// must be resolved from `node_modules` at runtime. Shared by both bundles
// below; `.vscodeignore` allow-lists these packages so they still ship in the
// `.vsix` (integration checklist #3).
const NATIVE_EXTERNAL = ['@lancedb/lancedb', 'web-tree-sitter'];

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode', ...NATIVE_EXTERNAL],
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });

  // Second entry point (integration checklist #2, load-bearing): the
  // standalone stdio MCP server Hermes spawns directly
  // (`node dist/mcp/codebase-server.js`). Same native/wasm externals as the
  // extension bundle; no `vscode` dependency (this process never touches the
  // VS Code API — spec: "the MCP process only queries").
  const mcpCtx = await esbuild.context({
    entryPoints: ['src/mcp/codebase-server.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/mcp/codebase-server.js',
    external: [...NATIVE_EXTERNAL],
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), mcpCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), mcpCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), mcpCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
