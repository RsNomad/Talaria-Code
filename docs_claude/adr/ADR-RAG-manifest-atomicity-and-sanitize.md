# ADR-RAG: Manifest atomicity, sanitize-at-emission, and refactor-behind-the-gate

**Status:** Accepted (2026-08-29)

## Context

This ADR records the load-bearing decisions locked in by the WS-R2-rest and
WS-RAG remediation cluster on branch `fix/lens-dorabotok-remediation`. The
cluster targets the RAG codebase indexer (`src/rag/`) and the MCP
`codebase_search` / LSP search surfaces (`src/mcp/`). Its findings span two
concerns that turned out to share a spine:

1. **Crash- and dispose-safety of the index's own bookkeeping** — the
   `manifest.json` content-hash cache and the vector store must never be left
   torn, orphaned, or mutated after the indexer is torn down.
2. **Trust boundaries on untrusted repository content** flowing out through the
   search tools to the model.

Every decision below is already implemented and reviewed on this branch. Each
carries the concrete cite so a future maintainer can find the invariant in
source, not just in prose. The closing Consequences section names what any
further refactor of this subsystem must keep true.

---

## Decision 1 — Manifest atomicity via same-directory `fs.rename`

**Decision.** `writeManifest` serializes the full manifest JSON to a
same-directory temp file `${manifestPath}.tmp`, then `fs.rename(tmp,
manifestPath)`. On the Linux target filesystem a same-directory `rename(2)` is
atomic: the manifest is replaced in one indivisible step, so a concurrent
`readManifest` ever sees either the complete old file or the complete new one,
never a half-written one. `readManifest` in turn distinguishes the two failure
modes it can meet: `ENOENT` is the ordinary "no index yet" first run and returns
`{}` **silently**; any other read failure, a JSON parse error, a non-record
root, or a non-string entry is corruption and returns `{}` only **after** a
name-only log line (`manifest ... — rebuilding`). Corruption is therefore never
a silent empty — an empty manifest on the corruption path forces the diff to
recompute every current path (a full rebuild) rather than masquerading as a
first run.

**Rationale.** The manifest is the sole record of which paths are indexed and at
what content hash; a torn manifest silently orphans stored vectors or triggers a
needless re-index. `rename(2)` is the standard atomic-replace primitive, and a
same-directory temp keeps the rename on one filesystem where atomicity holds.

**Alternative rejected.** In-place `fs.writeFile(manifestPath, ...)`. A crash or
interleaved read mid-write leaves a torn or partial JSON that a concurrent
`readManifest` could parse into a wrong or empty manifest, silently orphaning
rows or re-indexing the whole tree.

**Cite.** `src/rag/indexer.ts` — `writeManifest` (temp-write + `fs.rename`),
`readManifest` (ENOENT-vs-corruption split).

---

## Decision 2 — Sanitize-at-emission defence-in-depth for `codebase_search` snippets

**Decision.** `formatHitAsText`, the single point where a search hit is rendered
into an MCP text block, strips `CONTROL_CHAR_PATTERN` from the untrusted snippet
body before it is fenced: `hit.content.replace(CONTROL_CHAR_PATTERN, '')`. The
pattern removes the C0 control characters and DEL while deliberately preserving
tab, CR, and LF (which are legitimate inside a fenced code block and carry no
framing risk). This is the same control-character class the LSP tool outputs are
sanitized against — the two surfaces are now sanitized in parity, from one
shared pattern.

**Rationale.** The fenced snippet body is **not** covered by the nonce-frame
envelope's delimiter neutralization. That envelope guards only frame tags — it
stops an untrusted string from forging a frame boundary — it does not touch
control characters sitting inside the body the model reads. Sanitizing at the
sole emission choke closes that gap uniformly, regardless of which store or
embedder produced the hit. The Wave-2 audit rated this control sink as
defence-in-depth (blue) rather than a live exploit, and the fix is applied at
that same tier: a cheap, always-on strip at the one place every hit must pass
through.

**Alternative rejected.** Rely on the frame envelope alone. That leaves raw
control characters in the snippet body reaching the model — precisely the gap
the envelope does not cover.

**Cite.** `src/mcp/search.ts` — `formatHitAsText`; `CONTROL_CHAR_PATTERN`
defined in `src/mcp/lsp/frameSanitize.ts`
(`/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g`).

---

## Decision 3 — Asymmetric Qwen3-Embedding query instruction (A-05)

**Decision.** At the single query-embed choke `buildEmbeddingQueryText`, prefix
**only** the query embed text as `Instruct: {task}\nQuery:{query}` — with no
space after `Query:`, matching the official `get_detailed_instruct` form from
the Qwen3-Embedding card — and **only** when the configured embedder id matches
`/qwen3-embedding/i`. Documents remain bare, and the full-text-search leg keeps
the raw query untouched. No re-index is required.

**Rationale.** Qwen3-Embedding is an instruction-aware retrieval model on the
query side but not the document side; queries take the `Instruct: ...\nQuery:...`
prefix while documents stay bare. Because the usage is asymmetric, changing the
query instruction never invalidates the already-stored document vectors, so the
prefix can be introduced live with no rebuild. Applying it only for a
Qwen3-Embedding id keeps every other model (nomic / bge / e5 / ...) embedding
the raw query, since a foreign instruction prefix would corrupt their
embeddings.

**Alternative rejected.** Prefixing both sides (would force a full re-index and
gains nothing, since Qwen3 documents are meant to stay bare), or prefixing
unconditionally (corrupts non-Qwen embedders that are not instruction-aware).

**Cite.** `src/mcp/search.ts` — `buildEmbeddingQueryText`, gated on
`QWEN3_EMBEDDING_ID = /qwen3-embedding/i`.

---

## Decision 4 — Deadlock-safe bounded-parallel directory walk (RAG-02)

**Decision.** The full-build directory descent `walk` runs under a bounded
concurrency pool (`WALK_CONCURRENCY = 8`, reusing the shared
`createConcurrencyPool` from the LSP tool pipeline). A pooled task **never**
awaits a nested `pool.run` on the same pool. Instead, each directory-visit task
schedules its child directories by pushing their `pool.run(...)` promises onto a
shared `pending` list (no await at schedule time), and a single top-level driver
drains that list by re-reading its **growing** length on every pass
(`for (let i = 0; i < pending.length; i++) await pending[i];`).

**Rationale.** Awaiting a nested `pool.run` while holding the pool's last slot
deadlocks — the parent task occupies the slot the child needs and neither can
proceed; the pool utility documents exactly this re-entrancy hazard. The
schedule-then-drain shape sidesteps it entirely: no task ever waits on the pool
that scheduled it. Bounding fan-out at 8 keeps the descent from exhausting file
descriptors on a large repository while still overlapping `readdir` latency.
Discovery order becomes non-deterministic, but the resulting file **set** and
the nested-ignore (`.gitignore` / `.hermesignore`) semantics are identical to
the serial walk.

**Alternative rejected.** `await pool.run(...)` inside the recursive visit. That
serializes the descent and, worse, can deadlock at the last slot.

**Cite.** `src/rag/buildPipeline.ts` — `walk` and `WALK_CONCURRENCY`. (Note:
these symbols were relocated from `src/rag/indexer.ts` to `buildPipeline.ts` by
the FUNC-INDEXER split described in Decision 5; they are the same `walk`.)

---

## Decision 5 — The dispose/mutation gate, the refactor behind the golden master, and the dropped manifest-first reorder

**Decision.** Post-dispose mutation of the store and manifest is killed
structurally at four sink choke-point families — `store.upsert`,
`store.deleteByPath`, `writeManifest`, and `writeMeta` — every one of which is
routed through a `MutationGate`. `dispose()` flips the gate closed
**synchronously** (`gate.close` sets `closed = true` before any await, so a sink
issued in the same tick is already refused), then awaits the in-flight
`buildChain` tail bounded by `MUTATION_GATE_DRAIN_DEADLINE_MS` (10s; a rejected
or never-settling drain never rejects nor wedges the close), and only then
closes the store. While closed, a sink's operation is never invoked, resolves
`undefined`, and is counted (`refusedCount`) — the post-dispose mutation
**class** dies at the choke points regardless of body-level vigilance.

Behind that gate, the FUNC-INDEXER split of the indexer into `buildPipeline.ts`
(the `runBuild` / `reindexFiles` / `walk` pipeline) and `watchPipeline.ts` (the
`createWatch` body) is a **pure move**: the closed-over factory state becomes an
explicit `IndexerContext` deps bag, with no behavioral change. The A1-A5
dispose-race and AU-23 regression tests — made deterministic by the ISO-1
fake-timer / controllable-hung-embed hardening — stand as the golden master for
the move: it landed with **zero assertion edits**.

**Rationale.** The AU-23 class ("a suspension point whose continuation mutates
the store or manifest after dispose") had been enforced by roughly twenty-two
hand-placed `if (disposed)` re-checks, with in-code comments recording those
checks being missed repeatedly. Gating the four greppable sink families closes
the class by construction: any `store.*` / `writeManifest(` / `writeMeta(` call
not wrapped in `gate.sink` is a review-refusable defect, and no future body edit
can reopen the class without bypassing a gate the reviewer can grep for. A
refactor that keeps the golden master green then provably preserves those
dispose-race behaviors — the move cannot silently regress what the pinned tests
still assert.

**Alternative rejected (this reverses an earlier arch-doc invariant).** The
architecture document's §3.2 "manifest-invalidate-**first**" reorder (task A3)
was **dropped** after a build-time live-code trace and an independent
Opus-tier adversarial review both found it premise-false. The reorder assumed
"store-delete succeeds + manifest entry kept -> next build hash-matches ->
skips -> rows permanently missing." But that requires the path to remain in
`current` with unchanged content, whereas the three destructive `handleFsEvent`
branches fire precisely for paths that **leave** `current` (deleted /
secret-excluded / symlink-excluded), so the retained manifest entry routes to
`toDelete` and reconciles. Store-first is already crash-safe: reconciliation is
manifest-keyed — `toDelete` is `stored ∉ current` (`contentHash.ts`
`diffContentHashes`), with **no** `store.listFileHashes` store-enumeration
backstop — and `writeManifest` is the dispose-skipped last op, never
half-persisted. Reordering to manifest-first would instead delete the only
reconciliation hook, producing **permanent orphan store rows at every
destructive branch**, and at the secret-purge branch it would disarm the
self-heal purge (which iterates the stored manifest to find and drop stale
secret-path rows), leaving a **permanent security leak** of embedded secret
content. Store-first stands, unchanged.

**Cite.** `src/host/util/mutationGate.ts` (`createMutationGate`, `sink`,
`close`, `MUTATION_GATE_DRAIN_DEADLINE_MS`); `src/rag/indexer.ts` — `dispose`;
the sink routing across `src/rag/buildPipeline.ts`; the A1-A5 / F3-11 / WS-R2-A5
dispose-race tests in `src/rag/indexer.test.ts`;
`docs_claude/lens-dorabotok/REMEDIATION-ARCHITECTURE.md` §3.2 revision note
(2026-08-28) recording the drop.

---

## Decision 6 — CA-M21 glob-to-regex translation bound

**Decision.** `globToRegExpSource` caps its input at 1024 characters and 64
path segments, throwing `RangeError` **before** it assembles any regular
expression. This is a defence-in-depth backstop for direct callers of
`compilePathGlobs` / `matchesPathGlobs`; production input reaching
`codebase_search` is already schema-capped upstream at 16 globs of 256
characters each.

**Rationale.** An unbounded glob-to-regex translation is a cheap amplifier: a
pathological pattern could expand into a catastrophic regex. Bounding length and
segment count before regex assembly caps the work at the translation boundary,
independent of whatever upstream schema limits happen to be in force for a given
caller.

**Cite.** `src/mcp/pathGlob.ts` — `globToRegExpSource`
(`MAX_GLOB_LENGTH = 1024`, `MAX_GLOB_SEGMENTS = 64`).

---

## Consequences

- **The golden master is load-bearing.** Any further refactor of the RAG
  indexer must keep the A1-A5 plus ISO-1 dispose-race suite green with **zero
  assertion edits**. A change that needs to edit those assertions is a behavior
  change, not a refactor, and must be justified as one.
- **The gate invariant is the review contract.** The `MutationGate` sink
  families are exhaustive over the module's store/manifest mutations: any
  `store.*` / `writeManifest(` / `writeMeta(` call not wrapped in `gate.sink` is
  a defect a reviewer can grep for. Do not add a fifth mutation path that
  bypasses the gate.
- **Reconciliation is manifest-keyed, store-first.** The crash-safety of the
  index rests on `toDelete = stored ∉ current` with no store-enumeration
  backstop, and on store-op-then-manifest ordering at the destructive sites. Do
  not reintroduce a manifest-invalidate-first reorder — it reopens permanent
  orphan rows and disarms the secret self-heal purge (see Decision 5).
- **Manifest crash-safety depends on a same-filesystem atomic rename.** Do not
  move the manifest temp file across filesystems; `EXDEV` (cross-device rename)
  would break the atomic replace that Decision 1 relies on.
- **Sanitize at the emission choke, not per-caller.** New search or LSP output
  surfaces that render untrusted repository content must route through the same
  emission-point sanitization (`CONTROL_CHAR_PATTERN` for the body, the
  nonce-frame envelope for the frame), rather than trusting an upstream layer to
  have cleaned it.
