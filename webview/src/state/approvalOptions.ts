import type { ApprovalOption } from '../protocol';

/**
 * T-A1 (V-7): the first option of the given kind, or undefined if the
 * approval carries none (never fabricated). Mirrors the host's own
 * `findOptionId` (`SessionController.ts`) so the webview's optimistic
 * reject-fold denies via the SAME option the host itself would pick.
 */
export function findOptionId(options: ApprovalOption[], kind: ApprovalOption['kind']): string | undefined {
  return options.find((option) => option.kind === kind)?.id;
}

/**
 * BH-05 (Q2 / ADR-R2-15): the single source of truth for "is this approval
 * option a refusal" — allow = not-deny. Shared by `deriveSettledToolStatus`
 * (`transcript.ts`) and `deniedToolIds` (ChatView.tsx), so the deny-option check is never
 * re-derived in two places.
 */
export function isDenyOptionKind(kind: ApprovalOption['kind'] | undefined): boolean {
  return kind === 'deny' || kind === 'deny_always';
}
