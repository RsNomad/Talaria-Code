import type { ApprovalOption, ToolStatus } from '../protocol';

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

/** R3-SEC-01: the verdict of an approval's chosen option id. `'unresolved'` = the id is
 *  absent or names no option of THIS approval — the fail-safe input both consumers
 *  below must never read as consent. */
export type SelectedOptionVerdict = 'allow' | 'deny' | 'unresolved';

export function classifySelectedOption(options: ApprovalOption[], optionId: string | undefined): SelectedOptionVerdict {
  if (optionId === undefined) return 'unresolved';
  const chosen = options.find((option) => option.id === optionId);
  if (chosen === undefined) return 'unresolved';
  return isDenyOptionKind(chosen.kind) ? 'deny' : 'allow';
}

export type SelectedSettleToolStatus = Extract<ToolStatus, 'approved' | 'denied' | 'interrupted'>;

/** R3-SEC-01: the synthetic edit-approval tool card's status for a `selected` settle.
 *  `'approved'` ONLY for a resolved allow-kind option; an unresolvable selection lands
 *  in the same non-affirmative bucket as cancelled/superseded. */
export function selectedSettleToolStatus(options: ApprovalOption[], optionId: string | undefined): SelectedSettleToolStatus {
  switch (classifySelectedOption(options, optionId)) {
    case 'allow':
      return 'approved';
    case 'deny':
      return 'denied';
    case 'unresolved':
      return 'interrupted';
  }
}
