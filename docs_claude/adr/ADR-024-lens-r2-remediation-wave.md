# ADR-024 — Lens Round-2 remediation wave: decisions + triage record

**Status:** Accepted (2026-09-07, "Линза доработок" round-2 mega-branch `fix/lens-r2-bh05-approval-diff`, task WS-Z Z1).

## Context
A Lens Round-2 Opus-only audit (6 lenses, no arch lens, staged) of the shipped `v0.2.0-beta.1` found **1🔴/30🟡/50🔵 = 81** findings (`FIND-FIXES-WAVE2.md` / `TODO-WAVE2.md`, git-excluded). The one 🔴 (BH-05, blind edit-approval) plus BH-02/BH-03/BH-04 were built and reviewed clean first (`4d0da09..e6c5027`, 13 commits, whole-branch review Ready-to-merge YES 0C/0I), leaving 77 rows. This ADR records the decisions for the remainder of that work, all landed on **ONE continuous mega-branch** — superseding the earlier two-branch shape planned in `2026-09-06-lens-r2-csb-remediation-arch.md` (ADR-R2-14) and `2026-09-06-lens-r2-fsu-remediation-arch.md` (ADR-FSU-13). The authoritative source for everything below is `.superpowers/plans/2026-09-06-lens-r2-full-remediation-program.md` §5 (ADR table) and §1/§2 (triage); this document reproduces it as the durable record.

## Decisions

| ADR | Decision | Alternatives rejected | Consequence |
|-----|----------|-----------------------|-------------|
| ADR-R2-04 (CSB) | A mutation RPC that changes panel-visible state re-pushes that panel BEFORE resolving (push-before-response). | Webview keeps `confirmed[id]` as display. | Server truth stays the single authority; ordering is the pinned invariant. |
| ADR-R2-05 (CSB) | Non-record wire results coerced to `{}` at the SOURCE ingress with one log line. | Per-reshaper guards. | One choke point per RPC; degraded panels are visible. |
| ADR-R2-07 (CSB) | Transcript cap is turn-aware and SOFT. | Hard cap + turn-scoped ids. | No orphaned folds / duplicate keys; bounded growth within one turn only. |
| ADR-R2-08 (CSB) | Open fence renders as ONE `<pre>` with a 4 KB-quantized stable body + live tail. | Two `<pre>`s; tail window cap. | O(n²/chunk); no visible seam. |
| ADR-R2-09 (CSB) | astChunker coverage = union of emitted ranges + interstitial back-fill; depth cap 64. | Fill only zero-chunk children. | Every line chunked; no `RangeError` fallback. |
| ADR-R2-10 (CSB) | Secret env keys: collisions refused at add; existing `.env` keys never overwritten; format unchanged. | Hash-suffixed keys. | No credential bleed; old installs' removal paths keep working. |
| ADR-R2-12 (CSB, halves) | GGUF sink fail-closed symmetry: create must observe terminal success; pre-rename re-check covers root+owner; sidecar `O_NOFOLLOW`. (CA-18 removal half DEFERRED.) | Keep the fail-open "quiet end". | Honesty-first + DiD parity. |
| ADR-R2-13 (CSB) | LSP locations classify only the shown set; `externalCount` over the shown set, worded as such. | Deadline-wrap full classification. | Bounded realpath work; honest partial summary. |
| **ADR-R2-16 (new)** | A courtesy re-push after a persisted mutation is failure-isolated: log + return the mutation's own result; never reject a succeeded RPC. (`reload.mcp`/`model.save_key` keep their existing shape — a follow-up may align them.) | Propagate the re-push failure (today's `reload.mcp` shape). | A toggle that persisted never shows "Not saved". |
| **ADR-R2-17 (new)** | Wave triage policy: FIX only correctness / security / a11y defects and one proven footgun (FI-02); DEFER all design debt intact to a post-release refactor wave (FSU docs = approved design); WON'T-FIX only what is not a client change. | Build the FSU wave on this branch. | 19 FIX / 56 DEFER / 2 WON'T-FIX; a reviewable branch before release. |
| **ADR-R2-18 (new)** | `ScrollRegion` is focusable ONLY while it overflows (layout-measured), named via `role="group"` + `aria-label` (not `region`). | Always-focusable containers; `role="region"` landmarks. | No dead tab stops; no landmark flood; axe rule satisfied on the surfaces that scroll. |
| **ADR-R2-19 (new)** | `lineIsRepeated` bounds: 2000-char ceiling + exact length-gap short-circuit + two-row DP. | Cap only the input; keep the full matrix. | Results identical below the ceiling (golden), O(min) memory, no OOM class. |
| **ADR-R2-20 (new)** | No `[CONC]` lens this wave: C1 and S1 are same-tick emission-order invariants with deterministic tests + reviewer-run mutation proofs; no new await/interleave is introduced. | Independent lens on every ordering task. | Proportional review cost; the mutation proof is mandatory, not optional. |

**Superseded:** ADR-R2-14 (two-branch release shape) and ADR-FSU-13 (two tree-split FSU branches) — ONE mega-branch (owner decision, 2026-09-06).

**Deferred, not rejected:** ADR-R2-06 (autocomplete liveness deadlines — headers + idle timeout design) and ADR-R2-11 (`isWithin` export from `pathConfine.ts`) are DEFERRED intact to the post-release refactor wave; they are not superseded and remain the approved design when that wave picks them up.

## Triage policy (ADR-R2-17) and totals

Of the 77 remaining rows (81 filed minus the 4 already fixed pre-wave — BH-05, BH-03, BH-04, BH-02):

- **FIX (19)** — correctness / security / a11y defects and one proven footgun: BH-01, L2-CA-01, L2-CA-02, L2-CA-03, L2-CA-04, L2-CA-06, L2-CA-08, L2-CA-09, L2-CA-10 (OD-3), L2-CA-17, L2-CA-20, L2-CA-21, L2-CA-22, L2-CA-23, SEC-01, SY-01, UX-01, UX-02, FI-02.
- **DEFER (56)** — design debt kept intact for a post-release refactor wave, its design already written in the CSB/FSU arch docs and not repeated here: L2-CA-05/07/11/12/13/14/15/16/18/19/24/25 (12) · FI-01 (owner-gated, OD-1) + FI-03…FI-42 except FI-02 (41) · SY-02/SY-03 (2) · UX-03 (1).
- **WON'T-FIX (2)** — not a client-code change: UX-04, UX-05.

Totals: 19 + 56 + 2 = 77. Nothing in the DEFER set is lost — every row keeps its already-designed fix in the CSB (`2026-09-06-lens-r2-csb-remediation-arch.md`) or FSU (`2026-09-06-lens-r2-fsu-remediation-arch.md`) arch docs; this wave chose not to spend review cycles building pure design-debt / maintainability work on a bug-fix branch immediately before a release.

## Hermes-upstream note (UX-04)

UX-04 (the 60-second edit-approval auto-deny has no way to extend the deadline from the client) is **WON'T-FIX at the client layer**: the auto-deny is enforced entirely inside the Hermes harness (`permissions.py:152-157`, `edit_approval.py:327-331`) and is fail-closed by design — an approval the client cannot answer in time must not silently grant. There is no ACP wire message that lets a client request a longer deadline or reset the harness-side timer; adding one is a **Hermes-upstream ask** (an extendable-deadline-on-the-wire capability), not something the extension can implement unilaterally. Recorded here rather than as a client TODO because no client-side code change closes it.

## Deferred design pointers

The following documents remain the **approved design** for the post-release refactor wave that picks up the 56 DEFER rows above; they are not superseded by this ADR and are not repeated here:

- `docs_claude/2026-09-06-lens-r2-csb-remediation-arch.md` — per-finding seams for the Code-Audit/Security/Bug-Hunt lens rows (CSB).
- `docs_claude/2026-09-06-lens-r2-fsu-remediation-arch.md` — god-unit decomposition playbooks for the Func-impl/Syntax/UI-UX lens rows (FSU), including the App/Composer/shell/transcript/RAG/setup DRY work and the lock-test policy (ADR-FSU-02).
- `docs_claude/…-csb-open-questions-resolved.md` — CSB open-question verdicts (Q1/Q2/Q4/Q6/Q8/Q12), reused as-is by the FIX rows above.
- `docs_claude/…-fsu-two-decisions.md` — FSU decision verdicts (1a/1b/2a/2b), kept intact with those verdicts for the follow-on branch (notably FI-01's comment-archaeology retirement, owner-gated OD-1, and FI-33's wire-field removal, verdict DO but deferred).
