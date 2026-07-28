/*
 * Entry point. Imports the codicon font (bundled from @vscode/codicons — Vite
 * emits the .ttf as a hashed asset the host serves via asWebviewUri), the theme
 * token layer, and global styles, then mounts App. When there is no VS Code
 * host, it attaches the MockBackend so the whole UI runs from canned data.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@vscode/codicons/dist/codicon.css';
import './theme.css';
import './index.css';

import { App } from './App';
import { bridge } from './bridge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MockBackend } from './mock/MockBackend';

// Standalone dev (Vite / plain browser): no acquireVsCodeApi, so drive the UI
// with the mock host. Inside the extension this branch is skipped entirely.
if (!bridge.isHosted) {
  const backend = new MockBackend((msg) => bridge.emit(msg));
  bridge.attachMock((msg) => backend.handle(msg));
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      {/* UI-I1: last-resort net — a render throw anywhere in the tree (a
          host payload layer 1 didn't anticipate, or any future bug) shows a
          recoverable "reload" fallback instead of unmounting to a blank
          webview. */}
      <ErrorBoundary region="Hermes">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
