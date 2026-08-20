/**
 * WS-A (lens-dorabotok A-01, REMEDIATION-ARCHITECTURE §2 WS-A step 3): the ONE
 * shared record guard for untyped ingress boundaries. This is the enabling
 * point WS-BG later migrates the whole boundary-assertion class onto
 * (branch-by-abstraction: helper first, class migration later) — the three
 * module-local copies (`shared/errorText.ts:44`,
 * `host/backend/control/skillSourceGate.ts:138`,
 * `host/backend/control/mcpEntryValidation.ts:76`) stay put until then.
 *
 * Semantics: the STRICTER array-excluding form (matches the two control-plane
 * copies). An array is not a Record in intent; excluding it is fail-closed at
 * every ingress this will guard.
 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
