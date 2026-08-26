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

/**
 * WS-BG (SYN-BOUNDARY / CA-M20 class): the uniform "guard or undefined"
 * combinator for untyped ingress values. `guard` is a tiny per-shape
 * predicate (shallow by ADR-BG — exactly the fields the consumer reads, at
 * the depth it reads them); `undefined` means the value did not have the
 * shape and the caller decides the honest failure (throw a refusal, skip
 * the frame, serve a placeholder). This is deliberately trivial — its value
 * is the CONVENTION: `as T` appears only where a guard was just applied.
 */
export function asShape<T>(raw: unknown, guard: (x: unknown) => x is T): T | undefined {
  return guard(raw) ? raw : undefined;
}
