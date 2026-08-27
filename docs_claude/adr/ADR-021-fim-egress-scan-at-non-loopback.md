# ADR-021 — FIM egress: scan-at-egress conditioned on non-loopback

## Status
Accepted (WS-FIM, 2026-08; finding CA-06, SEC-1-confirmed 🟡)

## Context
The active-file FIM egress gate was name-only (`isSecretForCompletion` on the
document path): a secret hard-coded in a normally-named edited file was POSTed
to the model endpoint with no content scan, while cross-file snippets got the
full `assertAllScanned` + brand + scanner pipeline. Real exposure requires a
trusted workspace AND a remote endpoint (default is loopback; Restricted Mode
already skips remote).

## Decision
1. Before FIM egress, when the resolved endpoint is NON-loopback, run the
   existing frozen `secretScanner` over the exact egressing strings — the
   post-prune, post-injection prefix and the post-prune suffix (token-budget
   bounded, never the whole document). Scanner hit OR scanner error ⇒ return
   null (no egress): fail-closed, silent (the `ringBuffer.ingest` drop
   posture).
2. The loopback exemption is decided ONLY by exact-host match on a parsed
   URL: `new URL(endpoint).hostname` must EXACT-match `localhost`, an IPv4 in
   `127.0.0.0/8`, or `::1`/`[::1]`. Unparseable URL, empty host, `0.0.0.0`,
   IPv6 aliases, and DNS names containing "localhost" (`localhost.evil.com`)
   all SCAN. A substring/`startsWith` host check is FORBIDDEN — it re-opens
   the exact exfiltration hole (a rev-2 Opus-caught fail-OPEN). Pinned by
   MUST-SCAN tests (`localhost.evil.com`, `127.0.0.1.evil.com`, unparseable).
3. Classification happens once per engine build (`makeFimEgressGuard`); a
   loopback endpoint yields a constant-allow guard — zero scanner work, the
   default path stays byte-identical (zero added latency).
4. `secretScanner`/`secretPaths` are reused UNMODIFIED (frozen). The scan
   call passes a constant non-secret synthetic path: it is a pure content
   gate; the provider's name gate remains the path authority.
5. Next-edit is untouched: its egress already has its own fail-closed content
   gate (`mintScannedNextEditRequest` / `diffMayEgress` / ring-buffer ingest).
   The FSM is untouched; the shell is classified (WS-FIM's F3-15 and
   FUNC-NEXTEDIT items are separate decisions in the same workstream).

## Alternatives considered
- Scan on EVERY endpoint (loopback included): rejected — per-keystroke scanner
  cost on the default local path for zero exposure gain (loopback egress never
  crosses a network), against the finding's own exposure analysis.
- Reuse `secureTransport.isLoopbackHost` alone: rejected as the whole
  classifier — its exact-4-literal set misses 127/8 (e.g. 127.0.0.2), which
  the finding pins as loopback. It IS reused as the first tier; a separate
  anchored 127/8 matcher completes the set. `assertSecureAuthTransport`'s own
  stricter set is deliberately left unchanged (stricter is safe there).
- Redact-and-send instead of block: rejected — the frozen scanner is
  binary-verdict by design ("never redact"), and a redacting fork would edit
  the frozen zone.

## Consequences
+ The last unscanned egress path for workspace content is closed, fail-closed.
+ Default (loopback) users: behavior and latency byte-identical.
− A remote-endpoint user editing a file with a real secret gets NO completion;
  a per-file language-status badge + one-shot toast explain the pause
  (CA-06-face, Task 2b) without echoing the secret, the rule, or the endpoint.
  The ENGINE-side block itself stays silent (the notice is a detached
  observer that cannot affect it); the pre-existing secret-path skip (S4.1)
  carries its own Information badge from the same surface (CA-06-path-face).
− The frozen scanner's 16 KB content bound means a user-raised
  `maxPromptTokens` pushing the pruned prefix past 16 KB blocks completions
  on remote endpoints (fail-closed). Shipped budget (1024 tokens ⇒ ~1.2 KB)
  is nowhere near it.
- Scanner-bound residual: entropy/keyword heuristics can false-positive on
  high-entropy code near keyword-ish identifiers — one blocked completion per
  offending window; acceptable and consistent with the FIM snippet pipeline.
