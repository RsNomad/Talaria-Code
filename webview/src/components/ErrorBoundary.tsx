/*
 * Last-resort render-error net (UI-I1). Layer 1 (`../lookup.ts`'s
 * `totalLookup`, wired into ToolCard/SubagentsPanel/McpPanel/ToolsPanel/
 * SkillsPanel) is the load-bearing fix for the KNOWN host-payload crash
 * sites — a malformed `status`/`toolKind`/`provenance` now normalizes to a
 * safe default instead of reaching a render throw. This is defense in
 * depth for anything ELSE that throws mid-render (a future bug, an edge
 * case layer 1 didn't anticipate): a React class component is the ONLY way
 * to catch a descendant's render error (function components have no
 * equivalent lifecycle yet — grounded via Context7 `/reactjs/react.dev`),
 * so this stays a plain `React.Component` — no new dependency (no
 * `react-error-boundary`).
 *
 * `main.tsx` wraps the whole `<App/>` (mandatory — the finding's literal
 * complaint is "one bad message blanks the ENTIRE webview"); `App.tsx`
 * additionally wraps each side-panel region and the chat region so a crash
 * inside ONE panel/region shows only that region's fallback — the tab
 * strip and the rest of the shell keep working. Every one of those inner
 * boundaries is already gated by a `state.activePanel === '<x>'` /
 * `binding` boolean-AND in `App.tsx`, so switching away and back naturally
 * remounts a fresh (untripped) boundary — no extra `key` needed.
 *
 * Never a silent swallow: `componentDidCatch` always logs (this file's
 * existing `Hermes: ...`-prefixed `console.error`/`console.warn`
 * convention — see `state/transcript.ts`), and `render` always shows a
 * visible fallback card, never blank/empty output.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { bridge } from '../bridge';
import { Icon } from './Icon';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short label identifying which region this boundary guards, used in
   * both the fallback copy and the log line, e.g. "chat", "the Tools panel". */
  region: string;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

/** `throw` accepts any JS value, not just `Error` (React's own type for
 * `getDerivedStateFromError`'s parameter is `any`, matching that JS
 * reality) — normalize whatever was thrown into a real `Error` so
 * `state.error` is always usable, never a bare string/`null`/`undefined`. */
function normalizeCaughtError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(thrown: unknown): ErrorBoundaryState {
    return { error: normalizeCaughtError(thrown) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Talaria: render error in ${this.props.region}`, error, info.componentStack);
  }

  /**
   * F11: `window.location.reload()` inside a VS Code webview iframe is an
   * unverified recovery path here — it is not the "just works" browser
   * affordance it would be on a real page, and this repo has no
   * test/observation confirming it actually re-navigates the iframe. The
   * documented recovery is host-driven instead: post the `reload`
   * `webviewToHost` message and let `TalariaViewProvider` re-assign
   * `webview.html` through its normal `buildHtml` path (fresh CSP nonce,
   * same policy, same script/style URIs) — that re-mounts a fresh React
   * tree the same way the initial `resolveWebviewView` does.
   */
  private readonly reload = (): void => {
    bridge.post({ type: 'reload' });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-1.5 rounded-card border border-del bg-del-soft px-3 py-4 text-center text-xs text-fg"
      >
        <Icon name="error" size={18} className="text-del" />
        <div>Something went wrong in {this.props.region}.</div>
        <div className="max-w-full truncate font-mono text-2xs text-muted">{error.message}</div>
        <button
          type="button"
          onClick={this.reload}
          className="mt-1 rounded border border-del px-2.5 py-1 text-2xs font-semibold text-del hover:bg-del-soft"
        >
          Reload
        </button>
      </div>
    );
  }
}
