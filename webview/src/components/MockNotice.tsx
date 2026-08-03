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
 * SHOULD keep nagging in demo mode).
 *
 * Task 10: `onOpenSetup`, when given, adds a "Set up backends" deep-link
 * into the Setup / Talaria Config panel — the actual remedy for the state
 * this notice describes (flip `talaria.backend` to `acp` via the Agent
 * card's install/activate flow, instead of hand-editing settings.json). A
 * SIBLING of the reason text, not nested inside it, so the informational
 * `role="note"` text itself stays exactly what it was (its own DOM test
 * checks the note's full text content, substring-matched, so appending a
 * trailing action is additive and non-breaking either way — kept as a
 * sibling anyway for a clean separation between "what's true" and "what you
 * can do about it"). Optional so this component still renders standalone
 * (e.g. any future direct usage) without a handler.
 */
export function MockNotice({ onOpenSetup }: { onOpenSetup?: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-warn bg-warn-soft px-3 py-1.5 text-xs text-muted">
      <span role="note" aria-label="Demo mode notice" className="min-w-0 flex-1">
        Demo mode — responses are canned. Set <code className="font-mono">talaria.backend</code> to <code className="font-mono">&quot;acp&quot;</code> and trust this workspace to use the real agent.
      </span>
      {onOpenSetup && (
        <button
          type="button"
          onClick={onOpenSetup}
          className="flex-none rounded border border-warn px-1.5 py-0.5 font-mono text-2xs text-fg hover:bg-overlay"
        >
          Set up backends
        </button>
      )}
    </div>
  );
}
