/*
 * FI-14 (feeds FI-04): the shared chrome behind App.tsx's 9 side-panel render
 * sites (tools/mcp/skills/checkpoints/subagents/sessions/models/setup/
 * settings) — each used to repeat an IDENTICAL `role="tabpanel"` wrapper +
 * `ErrorBoundary` by hand (see the doc comment above the first `'tools'`
 * block in `App.tsx` for the shape's own rationale). Without a shared
 * component that role/aria/class chrome could drift one panel at a time
 * (a copy-pasted className typo, a forgotten `aria-labelledby`) with nothing
 * to catch it; single-sourcing it here makes that drift impossible. Each
 * caller keeps its OWN `state.activePanel === '<key>'` gate inline (that
 * predicate is per-call, not this component's concern) and passes `region`
 * EXPLICITLY — it is deliberately NOT derived from `panel` here, because a
 * naive capitalize of the key would turn `mcp` into "Mcp panel" instead of
 * the correct "MCP panel". BEHAVIOUR-PRESERVING extraction — the rendered
 * DOM is byte-identical to the 9 scaffolds this replaces. The `chat` panel is
 * NOT one of the 9: it is structurally different (its own outer wrapper plus
 * a nested `role="log"` scroll region, `App.tsx`'s ChatView block) and stays
 * inline.
 */
import type { ReactNode } from 'react';
import type { Panel } from '../protocol';
import { ErrorBoundary } from './ErrorBoundary';
import { panelTabDomId, panelTabpanelId } from './PriorityTabs';

interface PanelScaffoldProps {
  panel: Panel;
  /** Short region label passed straight through to `ErrorBoundary`, e.g.
   * "the Tools panel" / "the MCP panel" — always given by the caller, never
   * derived from `panel` (see this file's header comment). */
  region: string;
  children: ReactNode;
}

export function PanelScaffold({ panel, region, children }: PanelScaffoldProps) {
  return (
    <div
      id={panelTabpanelId(panel)}
      role="tabpanel"
      aria-labelledby={panelTabDomId(panel)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ErrorBoundary region={region}>{children}</ErrorBoundary>
    </div>
  );
}
