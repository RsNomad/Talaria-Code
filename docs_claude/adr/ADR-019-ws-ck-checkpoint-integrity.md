# ADR-019 — WS-CK checkpoint integrity: link-don't-rename locks; re-assert containment at the write

## Status
Accepted (WS-CK, lens-dorabotok remediation; spec §WS-CK rev-4).

Numbering note: the originating brief drafted this as "ADR-006", written
before `docs_claude/adr/` had grown to 001-018 (ADR-006 is already
`ADR-006-coexistence-fsm.md`, an unrelated decision). Verified against the
directory at write-time and filed as the next free number, ADR-019. The
in-code cross-reference this decision left behind
(`CheckpointTracker.ts`, CA-05 comment) has been corrected to point here.

## Context
- CA-04: `shadowLock.tryStealStaleLock` restored a mistakenly-stolen live lock
  via `fs.access` + `fs.rename` — `rename(2)` replaces an existing target, so a
  fresh third-party lock created in the check→rename window was silently
  clobbered (two holders on one shadow-git dir).
- CA-05: `restoreInternal` computed a symlink-safe realpath per path, then ran
  `mkdir` → awaited `git show` → write. Validation does not travel with a
  string: the OS re-resolves every component per syscall, so an ancestor dir
  swapped to an out-of-tree symlink during the subprocess was followed by the
  write (O_NOFOLLOW guards the leaf only).

## Decision
1. **Link-don't-rename for lock restore**: `fs.link(stolen, lockPath)` —
   atomic-fail-on-exist; EEXIST ⇒ drop the stolen copy, never touch the
   occupant. The initial steal stays `rename` (single-winner atomicity).
2. **Containment re-assertion immediately before the write** — after
   `removeIfSymlink`, before `writeFileNoFollow`: re-run
   `resolveWithinWorkspaceReal(dirname)` and route violations to the existing
   `skippedPaths` disclosure. NOT string substitution; placement after
   `removeIfSymlink` minimizes — does not zero — the window.
3. **Honest residual**: a sub-await ancestor swap between the re-assertion and
   the `open()` remains theoretically possible. Full closure = openat(2)
   per-component traversal inside FROZEN `safeWrite` — a 4th owner-gated frozen
   commit, deliberately not taken (same local-same-uid attacker model Wave-2
   rated 🔵 residual). No "nothing can land outside the root" claim is made.
4. **Frozen boundary**: `safeWrite.ts` / `pathConfine.ts` untouched (CA-05 only
   adds a call). `shadowLock.ts` is NOT in the branch's frozen-3 list — CA-04
   is a sanctioned WS-CK edit; after it lands, WS-CK-A6 treats
   shadowLock/safeWrite/pathConfine as instantiate-only.
5. Sub-decisions: CKP-04 rename-parse armed for R (deleted OLDPATH) but NOT C
   (copy source survives in the target tree); errno-code-only logging
   (`errCode`) everywhere in the checkpoints module; timeout/lock literals
   deduped into `constants.ts`; per-root trackers stay behind the existing
   honest refusal until WS-CK-A6's gate flip (documented in that work's own
   ADR when it lands — not "ADR-007", which is already
   `ADR-007-zeta-sampling-pinned-unsourced.md`, an unrelated decision).

## Consequences
+ Lock restore can no longer evict a live holder; the escape window at the
  restore write shrinks to a single open(2).
− The residual above is documented, not closed.

**Two further residual precisions** (surfaced by the CA-05 3-lens review,
refining §3/Consequences above — neither contradicts it, neither is a new
hole beyond what §3 already accepts):

(a) **Dangling-ancestor nuance.** A dangling (non-existent-target)
out-of-tree ancestor symlink PASSES the CA-05 re-assertion:
`resolveWithinWorkspaceReal` → `realpathOfExistingPrefix` walks *up* past any
ancestor component it cannot resolve (ENOENT — which is exactly what a
dangling symlink produces, since its target doesn't exist) until it reaches
the deepest real ancestor, then re-appends the unresolved tail *literally*
onto that real path. It therefore cannot distinguish "these path segments
don't exist yet" from "these segments exist but are a symlink chain to
somewhere outside the workspace" — both compute a candidate that looks
workspace-contained, so the check passes. This does **not** grant the
attacker an escape by itself: the actual `fs.mkdir`/`writeFileNoFollow` calls
use the raw (non-realpath'd) path, so the kernel still resolves the dangling
symlink and fails closed with `ENOENT` (the pointed-to directory doesn't
exist to write into) — *unless* the attacker additionally wins the
documented open()-window race to materialize the real target (create the
directories the dangling symlink points at) between our check and the
write. That additional race is the SAME check-to-use window §3 already
accepts as an honest residual, not a distinct hole; this paragraph exists so
the ADR is not read as claiming full ancestor-symlink coverage when the
mechanism is actually blind to the dangling case and relies on the same
residual race to stay safe.

(b) **Delete-branch not ancestor-re-asserted.** `applyRestoreChanges`'s
delete branch (`await fs.rm(absPath, { force: true })`) is intentionally
NOT given a CA-05-style ancestor re-assertion. Unlike the write branch —
which has an awaited `git show` subprocess (plus `removeIfSymlink`) between
the loop-top `safe` check and the actual write, which is exactly the gap
CA-05 narrows — the delete branch calls `fs.rm` directly, with no awaited
step in between. Its check-to-use window is therefore already the
irreducible sync-only minimum; adding a second `resolveWithinWorkspaceReal`
call immediately before `fs.rm` would narrow nothing (there is nothing
between the two calls for an attacker to race). An owner could still add one
later purely for defense-in-depth *symmetry* with the write branch — that
is a deliberate choice not taken here, not an oversight.

Won't-fix: F2-11 (append-forever index/refs) — in-code documented deliberate
Phase-3 tradeoff and frozen zone; remediation would be a product decision (GC
design), not a defect fix.
