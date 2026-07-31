/*
 * Best-effort relative-age label, shared by every panel that shows a
 * relative timestamp (`SessionsPanel`'s History rows, `SubagentsPanel`'s
 * delegation rows, …). W4-T6 (UI#8, state-parity) extracted this out of
 * `SessionsPanel.tsx`, which used to carry the only copy — `SubagentsPanel.tsx`
 * had no shared source to reuse and rendered a delegation's raw ISO
 * `startedAt` verbatim instead, a state-parity gap between the two panels.
 * Exact source format is NOT contractually pinned (`src/shared/protocol.ts`'s
 * docs on `SessionSummary.updatedAt`/`SubagentNode.startedAt`) — falls back
 * to the raw string when it doesn't parse as a date.
 */
export function relativeAge(updatedAt: string | undefined): string | undefined {
  if (!updatedAt) return undefined;
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return updatedAt;

  const deltaMs = Date.now() - then;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
