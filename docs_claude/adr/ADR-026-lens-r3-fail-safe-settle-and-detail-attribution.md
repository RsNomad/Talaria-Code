# ADR-026 — Lens Round 3 remediation: fail-safe settle status, host emit-invariant, and consent-detail attribution

- **Status:** Accepted (pending merge)
- **Date:** 2026-09-09
- **Branch:** `fix/lens-r3-remediation` off `main` @ `7078e28`
- **Plan:** `.superpowers/plans/2026-09-09-lens-r3-remediation-arch.md` (Fable)
- **Findings closed:** the 7 Lens Round 3 findings (`FIND-FIXES-WAVE3.md`) = 5 remediation units. Top severity 🟡; zero 🔴.
- **Supersedes/relates:** BH-05 edit-approval design (ADR-R2-01/02/15); the R2 remediation this round audits.

## Context

Round 3 is the post-remediation audit of the shipped-plus-remediated codebase (it also compensates for R2's skipped final whole-branch review). Six Opus lenses surfaced 7 findings — one 🟡 consent-display fail-safe inversion (found by three lenses: L2 CHURN-01, L3 SEC-01, L5 TEST-01) and four 🔵 hygiene/a11y/perf/coupling nits. This ADR records the fix decisions; SDD wave T0–T7, implementer Sonnet / per-task Opus / independent [SEC] Opus on the consent-surface tasks / one Opus whole-wave close-review.

## Decision — Unit ① (🟡): fail-safe the unresolvable `selected` settle, at both layers

**Problem.** An `approval.settle{outcome:'selected', optionId}` whose `optionId` is not one of the approval's own options made both webview consumers (`deriveSettledToolStatus`, `deniedToolIds`) fall through `isDenyOptionKind(undefined) === false` to the AFFIRMATIVE branch — a **rejected** edit could render "Approved" on the core consent surface. Not reachable on pinned Hermes (`edit_approval.py:308-311` always ships a `deny`/`'deny'` option) and the host edit gate stays fail-CLOSED regardless (`edit_approval.py:332-336` default-denies any non-`allow_once`), so it is a display/record-integrity inversion, not an unauthorized edit — but the wrong fail direction on the consent surface.

**Webview (T1, `00d3e4d`).** One shared verdict helper in the cycle-breaker leaf `approvalOptions.ts` — `classifySelectedOption(options, optionId) → 'allow'|'deny'|'unresolved'` and `selectedSettleToolStatus(...) → 'approved'|'denied'|'interrupted'` — consumed by BOTH `deriveSettledToolStatus` (via the status helper) and `deniedToolIds` (via the verdict), so the two sites can never re-derive the decision differently again. An unresolvable selection maps to **`'interrupted'`** (OD-R3-1) and is counted in `deniedToolIds` ("not applied" pill). Rationale: `'denied'` would assert a refusal we cannot verify on the only reachable path (a non-Hermes peer with an unknown option vocabulary); `undefined` would strand the card as "Pending" forever (breaks the settle-converges-to-terminal invariant). The `deniedToolIds` unresolved route is gated on `settledOutcome === 'selected'` so a LIVE (unsettled) card — also 'unresolved' — is never counted (its own negative-control test).

**Host (T2, `335f207`), defense-in-depth = emit-invariant "an `approval.settle{selected}` never carries a non-option id".** `resolveDiff` reject with no deny-kind option → `settlePendingApprovals('cancelled', { onlyApprovalId })` (the codebase's own precedent; ACP cancelled ⇒ not applied; Hermes default-denies) instead of the literal `'deny'` fallback (OD-R3-2/D3). Accept-all-hunks with no `allow_once` option → leave pending + log (consent is never synthesised from an unknown vocabulary; the 60 s expiry bounds it) — never downgraded to a spurious deny (OD-R3-2). `respondApproval` with `optionId ∉ options` → refuse loudly, change nothing, log ids/counts only, never the webview-supplied string (OD-R3-3, BHF-F1-3 shape). Both MockBackends drop the `?? 'deny'`/`?? 'allow_once'` literals. `permission.ts` 0-diff — BH-05 anti-spoof untouched.

**[SEC] outcome:** R3-SEC-01 fully closed across T1+T2 — the host emits option-member ids exclusively, the webview fail-safes the receiving side, no residual host→webview gap; all fail-closed guards preserved (no fail-OPEN introduced).

## Decision — Unit ② (🔵, T5 `0c668e0`): `control/` imports the `modalText` leaf, not the god-façade

`control/mcpEntryValidation.ts` + `skillsAdminHandler.ts` imported modal-text symbols through the 2438-line `SetupController` re-export, and `mcpEntryValidation` rebuilt a `/g` variant from `MODAL_UNSAFE_TEXT_PATTERN.source` at **module-init** (the latent TDZ/cycle vector). Fix: `modalText.ts` exports `stripModalUnsafeText()` (strip-only) — a FUNCTION, not the `/g` regex object (a shared global `RegExp` carries `lastIndex` across importers); `redactForModal` = strip + the existing cap (byte-identical output, corpus 0-diff); `control/` imports the leaf; the module-init rebuild is deleted (the finding's actual crash vector, not just the import path). The `SetupController.ts:59` façade re-export is KEPT (five test importers, OD-R3-6). A `control/`→`SetupController` import ban was added to `policyAcpPurity.test.ts` (non-vacuous — the real pre-fix run listed both offenders).

## Decision — Unit ③ (🔵, T6 `03428ba`): `nextEditRoute` narrow deps port + injected config reader

`resolveRoute` took the shell's fat `NextEditShellDeps` (a route→shell type back-edge) and read vscode config directly via `readNextEditConfig()`. Fix (OD-R3-4 = fix now): a narrow `NextEditRouteDeps` (the 4 FIM getters) + an injected `NextEditConfigReader`; `NextEditShellDeps extends NextEditRouteDeps`; `HermesNextEditConfig` moved to the `types.ts` leaf; the edge is now shell→route only, and the module is genuinely headless (its test drops `vi.mock('./config')` — the absence IS the proof; re-adding the import fails at import time). Output-identical; goldens/`index.ts`/locks 0-edit.

## Decision — Unit ④ (🔵, T4 `10d6875`): stabilise `selectPanel`/`openSetup`

They were bare arrows re-minted every `App` render, defeating `React.memo(ChatView)` on every composer keystroke. Fix: `selectPanel = useCallback(…, [dispatch])` reaching `requestPanelRef.current` (listing `requestPanel` would re-mint every render); `openSetup = useCallback(() => selectPanel('setup'), [selectPanel])`. Behaviour-preserving (a click always reaches the latest `requestPanel`, exactly as the old inline arrow did). A prop-identity probe test locks `onOpenSetup` + the four already-stable siblings.

## Decision — Unit ⑤ (🔵, T3 `9196d7b`): attribute the agent-supplied ApprovalCard `detail`

The agent-controlled `detail` rendered as an unattributed muted subtitle directly under OUR authoritative title on the consent surface. Fix (OD-R3-5): `detail` renders inside `<div role="group" aria-labelledby={captionId}>` whose visible first child "From the agent" (`useId`) is its accessible name, with a left rule; OUR `{item.title}` stays a sibling OUTSIDE the group. a11y-correct: the caption is real text in reading order (not `aria-hidden`), and the named group is the repo's established pattern for a source boundary in the accessibility tree. Framing gap only (title dominant, buttons non-forgeable, edit gate fail-closed) — not action-integrity.

## Owner decisions (OD-R3-1..8)

All accepted at Fable's defaults (owner: "Да, всё как есть", 2026-09-09): ①=`interrupted` (OD-1); accept-without-`allow_once`→leave pending (OD-2); unknown-id `respondApproval`→refuse-only (OD-3); Unit ③ fixed now (OD-4); caption "From the agent" (OD-5); façade re-export kept (OD-6); mocks early-return (OD-7). OD-8 (version/tag at merge) deferred to merge time (fresh core `v0.2.1-beta.1` — 0.2.0 is claimed).

## Consequences

- Consent-display integrity is fail-safe end-to-end; the host never emits a non-option settle id; a11y attributes the agent claim. Behaviour on the pinned Hermes wire is byte-identical on every path (all fixtures resolve).
- Frozen zones (`secretScanner`/`secretPaths`/`scan.ts`/LSP tables/`ggufIngest`) are 0-diff across the wave. `permission.ts` is 0-diff. Two per-task-review Minors (a JSDoc fragment, an ADAPTER_ALLOW doc-count) were fixed, not deferred (`c64d969`, `aa75661`).
- Two mock `respondApproval`/`resumeParked` paths still lack the host's membership guard — demo/replay-only (no real edit gate behind them; the webview backstops), flagged for mirror-parity awareness only, no action.

## Commit map (branch `fix/lens-r3-remediation`, off `7078e28`)

`00d3e4d` T1 ① webview · `335f207` T2 ① host · `9196d7b` T3 ⑤ · `10d6875` T4 ④ · `0c668e0` T5 ② + `c64d969` T5-fix · `03428ba` T6 ③ + `aa75661` T6-fix · (this ADR) T7. Gate at each commit green (floor 7742 → 7785), byte-scan 0, subject-only 0-trailers.
