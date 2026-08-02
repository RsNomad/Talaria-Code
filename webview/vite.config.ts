import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The webview is served from disk by the extension host via asWebviewUri,
// so all asset URLs must be relative (base: './'). Output goes to
// ../dist/webview (Agent C's npm scripts ship dist/). Single JS + single CSS
// bundle: no code-splitting, so the host only has to inject one <script>.
export default defineConfig({
  plugins: [react()],
  base: './',
  // The protocol contract is the single source of truth at
  // `../src/shared/protocol.ts` (host side); `src/protocol.ts` re-exports it.
  // `vite build` (Rolldown) resolves that out-of-root path with no extra config,
  // but the dev server's fs guard (server.fs.strict, default on) would 403 it —
  // so allow serving one level up to the repo root for `vite dev`.
  server: {
    fs: {
      allow: ['..'],
    },
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 0, // keep codicon font as a real file so font-src/CSP is predictable
    rollupOptions: {
      output: {
        // Flat, deterministic filenames so the extension host can hardcode
        // dist/webview/index.js + index.css in its <script>/<link> (no hashes).
        // Single bundle: Rolldown (Vite 8) deprecated `inlineDynamicImports: true`
        // in favor of `codeSplitting: false` (same behavior — no chunks).
        codeSplitting: false,
        entryFileNames: 'index.js',
        chunkFileNames: 'index.js',
        assetFileNames: (info) =>
          info.name && info.name.endsWith('.css') ? 'index.css' : '[name][extname]',
      },
    },
  },
});
