/**
 * Invariant #3 (final-review ARCH-2): the ONE constructor for user-facing HTTP
 * failure strings. Carries operation + status + statusText ONLY — never a
 * response body, never a header, never a key. Bodies go to the output channel
 * (log), not the message (UI): "a generic response is returned … but the
 * error details are logged server side for investigation, and not returned
 * to the user" — OWASP Error Handling Cheat Sheet,
 * https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
 * (fetched this task: "when an unexpected error occurs then a generic
 * response is returned by the application but the error details are logged
 * server side for investigation, and not returned to the user").
 *
 * Adopters (final-review remediation §4): {@link ../host/dashboard/HermesDashboardClient.ts}
 * (non-2xx path — body routed to the injected `Logger` instead) and
 * {@link ../autocomplete/backends/OllamaFimBackend.ts} (mid-stream `{error}`
 * chunk — body dropped entirely, no logger on that path). The other ~6
 * already-compliant `BackendHttpError(status, statusText)` call sites adopt
 * this helper for their message argument at next touch (no churn in this
 * task); `src/shared/httpFailure.invariant.test.ts` is the tripwire that
 * keeps the convention from silently drifting again.
 */
export function httpFailureMessage(op: string, status: number, statusText: string): string {
  return `${op} failed: ${status}${statusText ? ` ${statusText}` : ''}`;
}
