# ADR-020 — A-06 per-root shadow-git checkpoint isolation (WS-CK-A6 gate flip)

## Status
Accepted and SHIPPED (WS-CK-A6, lens-dorabotok remediation; spec §WS-CK-A6 rev-4). `MULTI_ROOT_CHECKPOINTS` flipped `false` → `true` in this commit (Task 17), after the per-root suite (registry core, reconcile, isolation, INV-A6-GITDIR, dispose-durability, promotion, golden master, confinement, characterization) went green.

Numbering note: the originating brief drafted this as "ADR-007", written
before `docs_claude/adr/` had grown past that number — ADR-007 is already
`ADR-007-zeta-sampling-pinned-unsourced.md`, an unrelated decision. Verified
against the directory at write-time (ADR-001…ADR-019 all exist) and filed as
the next free number, ADR-020. Where this decision cross-references the
sibling WS-CK checkpoint-integrity decision, it cites **ADR-019** (that
brief's own "ADR-006" was corrected the same way when it landed).

## Context
Non-primary workspace roots had **zero rollback protection** from either
side: Hermes's native checkpoints are inert when driven over ACP (there is
no wire-level hook to trigger them), and the extension's own checkpoint
tracker was wired for exactly one root — the first-listed workspace folder.
Every other open folder in a multi-root workspace hit the honest
`NO_TRACKER_RESTORE_REFUSAL` on every snapshot/restore call, permanently.
The A-06 finding raised this as a coverage gap; the owner chose live
per-root coverage over a doc-only refusal (Variant B).

## Decision
1. **One standalone `git init` shadow repo + one lock domain per canonical
   workspace root.** No worktrees, no shared object store — each root gets
   its own independent shadow-git tree, exactly like today's single-root
   tracker, just minted once per root instead of once per activation.
2. **INV-A6-GITDIR is THE isolation guarantor**, not the separate-directory
   layout by itself: every shadow-git operation runs with an explicit
   `GIT_DIR` (never directory-discovered from `cwd`) plus `sanitizeGitEnv`,
   so a shadow op can never walk up past its own root and find an ancestor
   `.git` (real or planted). Separate top-level repos are the necessary
   layout; the env discipline is the load-bearing invariant that makes
   ancestor-escape structurally impossible, not merely unlikely — proven by
   the ancestor-planted-repo isolation tests (Task 16).
3. **One canonicalization rule for the whole layer.** The registry's map key
   and the tracker constructor's own root argument both run through the
   SAME `canonicalizeWorkspaceRoot` (realpath, lexical fallback on FS
   error) — `key === hash-input` by construction, so a symlinked alias of an
   open root can never mint a second, disconnected shadow history.
4. **Serialized, declarative reconcile** on `onDidChangeWorkspaceFolders`,
   single-flighted (`reconcileChain`) so overlapping folder-change events
   can't interleave two passes: each pass recomputes the FULL desired set
   from `vscode.workspace.workspaceFolders` through the runtime's own
   `findContainingWorkspaceRoot` (the identical containment rule
   `resolveRootCoordinator` uses for turn routing), construct-before-dispose
   within a pass (a root that survives a pass is never torn down and
   re-minted), and a one-shot promotion notice (dedup'd per promoted root)
   when a nested child's parent is removed and the child's history starts
   fresh under its own root.
5. **Durability-flush dispose.** Removing a root (or full shutdown) runs
   `disposeAndFlush`/`disposeAll` — best-effort, non-throwing — closing the
   same off-critical-path localization window ADR-019 already closes for
   the single-root case, now for every registered root.
6. **Promoted-child history stays visible**, not silently discarded (option
   b of the spec's req 6b): a child root promoted out from under a removed
   parent starts a fresh shadow history under its own canonical root; the
   PRIOR history is retained with the parent folder and returns automatically
   if the parent folder is re-added later (nothing is deleted).
7. **Shipped behind the refusal until green.** `MULTI_ROOT_CHECKPOINTS`
   gated construction of the registry, the `onDidChangeWorkspaceFolders`
   subscription, and the `resolveRootCoordinator` factory arm as ONE flag,
   default `false`, so the entire feature was inert (byte-identical to
   pre-A6 behavior) until this commit flips it after the per-root suite is
   green.

## Alternatives rejected
- **(a) `git worktree` off one shared shadow `.git`.** Good because: one
  object store (disk savings), one command to add a root. **Rejected**:
  worktrees share `refs/`, `config`, stash, and hooks in ONE namespace — only
  `HEAD` and the index are per-worktree — which is not an isolation boundary
  between roots (Fletch 2026; the `git-worktree` docs' own shared-vs-per-
  worktree file list; Kothari 2026 on shared `config.lock` contention across
  worktrees). A checkpoint restore in root B could still race root A over the
  same lock domain — reintroducing by design the exact cross-root interference
  this workstream exists to close.
- **(b) `GIT_NAMESPACE` on one shared repo.** Good because: ref-name
  partitioning without the worktree machinery at all. **Rejected**:
  namespaces partition ref *naming*, not the object store, gc, config, or
  hooks — all of which stay ONE shared domain across every "namespaced" root.
  git's own documentation scopes `GIT_NAMESPACE` to ref lookup, not access
  isolation. Separate repos cost nothing meaningful here (shadow repos are
  small, per-root disk already disjoint) and are the honest boundary.
- **(c) Variant B — doc-only honest refusal, ship nothing.** Good because:
  zero implementation risk. **Rejected by the owner** (rev-3 decision) in
  favor of live coverage — the whole point of this workstream.
- **(d) Serve a promoted child from its former parent's retained shadow
  repo** (the re-parenting alternative). Good because: zero history
  discontinuity for the child. **Rejected**: it would make the confinement
  root / `GIT_WORK_TREE` for that root a directory that is no longer part of
  ANY currently-open workspace folder — a restore could then write outside
  every open folder, which is a consent/confinement violation strictly worse
  than a visible, reversible fresh start under the child's own root.

## Consequences
+ Every open workspace root now gets real rollback protection; per-root
  on-disk storage is already disjoint (the existing hash-derived shadow-dir
  layout), so this needed no migration.
− N× `git init`/gc cost instead of 1× — small, per-root, amortized (shadow
  repos are minimal).
− The registry is new lifecycle surface (construct, reconcile, dispose) —
  mitigated by the declarative single-flight reconcile design, the golden
  master pinning the pre-existing factory contract, and mandatory 3-lens
  review on every load-bearing commit in this workstream.
− Overlapping-folder containment semantics must track `findContainingWorkspaceRoot`
  forever, in lock-step with the same resolver `resolveRootCoordinator` uses
  for turn routing — pinned by test so the two can't silently diverge.

**Two documented surface deviations** (both RULED, not open — see
`docs_claude/lens-dorabotok/A06-surface-decisions.md`, Context7-grounded
against the VS Code notifications/status-bar UX guidelines):
- The promotion notice ships as a non-modal `showInformationMessage` (with a
  `'Show Log'` action revealing the detail line) plus an OutputChannel entry
  — RULED best-practice-final. A checkpoints-panel-embedded row was
  considered and rejected: `CheckpointsData` is a pinned host↔webview
  snapshot of panel *state*, and a promotion notice is a transient *event* —
  embedding it would force inventing persistence semantics the protocol has
  none of, for no correctness gain (the panel already renders the promoted
  root's fresh, empty history with zero code change).
- Per-root settings are a documented seam, not a gap: no root-scoped setting
  feeds the tracker path today (`createCheckpointTracker` passes no options),
  so there is nothing to thread through the registry yet. When one is added,
  it should be read per-folder via `getConfiguration(section, folder.uri)`
  lazily at operation time, never cached at construction.

## Cross-references
- ADR-019 (`ADR-019-ws-ck-checkpoint-integrity.md`) — the sibling WS-CK
  decision this workstream builds on (lock-restore + write-time containment
  re-assertion in the single-root tracker this registry now mints per root).
- `docs_claude/lens-dorabotok/A06-surface-decisions.md` — the promotion-notice
  and per-root-settings surface rulings referenced above.
- `docs_claude/lens-dorabotok/REMEDIATION-ARCHITECTURE.md` (§ADR-A06,
  Task C) — the originating architecture this ADR formalizes on disk.
