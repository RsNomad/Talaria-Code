/*
 * MockNotice — persistent mock-mode disclosure strip.
 *
 * Audit-3 I-2 / remediation architecture §2.3 (Task A-3): `talaria.backend`
 * defaults to `'mock'` (extension.ts) and untrusted workspaces force it
 * (trustGate.ts) — correct fail-closed engineering, but until now the only
 * disclosure was TabStrip's `text-2xs` pill, whose meaning lives in a
 * hover-only `title` attribute: unreachable to keyboard/touch scanning and
 * invisible to a tester mid-flow, who can mistake canned demo data for a
 * real agent. This strip is the primary, always-reachable disclosure; the
 * pill stays as a compact secondary marker (unchanged).
 *
 * Fork F-2(A) (owner-ratified): persistent, non-dismissible, text-only.
 * Deliberately no dismiss button (dismissal is an anti-goal — the strip
 * SHOULD keep nagging in demo mode) and no "open settings" affordance
 * (would need a new webview->host message through
 * `ALLOWED_CONTROL_METHODS` for a convenience — out of scope here).
 *
 * Mounted by App.tsx directly under `TabStrip`, gated on the SAME
 * connection-global `state.backendKind` the pill already reads
 * (`AppState.backendKind`, types.ts) — no new state, no hydration gating.
 */
export function MockNotice() {
  return (
    <div
      role="note"
      aria-label="Demo mode notice"
      className="border-b border-warn bg-warn-soft px-3 py-1.5 text-xs text-muted"
    >
      Demo mode — responses are canned. Set <code className="font-mono">talaria.backend</code> to <code className="font-mono">&quot;acp&quot;</code> and trust this workspace to use the real agent.
    </div>
  );
}
