# ADR-022 — WS-TD: DI seams replace the three test-only module-state setters (TST-02)

**Status:** Accepted (2026-09-04, "Линза доработок" Phase-5 WS-TD). **Finding:** TST-02.

## Context
Three production modules exported a test-only mutator over module-level mutable state — `gitProcess.__setSpawnForTests` (spawn slot), `WebTreeSitterParser.resetParserInitForTests` (the `Parser.init()` promise memo), `resolveHermes.resetHermesBinCache` (the R-A5 lookup cache). Each violates the purity-lock doctrine: production carries an API that exists only so tests can reach around it, and tests depend on a GLOBAL reset for isolation. The state itself is legitimate and load-bearing (process-lifetime caching, AU-35 clear-on-reject), so the fix is to give it a seam, not to remove it.

## Decision
One rule, three instances: **parameterize the dependency, default it to the real thing, keep the production default a module-level singleton where the semantics are process-wide.**
1. `gitProcess.ts` — `RunGitOptions.spawn?: GitSpawn` (per call; default Node `spawn`), threaded through `CheckpointTrackerOptions.spawn?` into every `RunGitOptions` the tracker builds (`shadowOpts()` + 3 explicit sites via one `spawnOpt()` helper). Rejected: a `createGitRunner(spawn)` factory (changes the export shape for no gain) and a narrowed spawner interface (not a mechanical reach-through for the standing tests).
2. `WebTreeSitterParser.ts` — `createParserInitMemo()` builds one closure memo (AU-35 clear-on-reject verbatim); the module-level `ensureParserInit` default is the process-wide singleton; `WebTreeSitterParserOptions.ensureParserInit?` overrides per instance. Rejected: moving the memo into the instance (one `Parser.init()` per instance = a production change; contradicts `dispose()`'s "process-wide, not owned by this instance").
3. `resolveHermes.ts` — `HermesBinCache` (`get`/`set`) built by `createHermesBinCache()`; a module-PRIVATE default singleton; trailing optional `cache` param on `resolveHermesBin` (3rd) and `resolveHermes` (5th). Rejected: making the cache the callers' concern (moves R-A5's guarantee out of the module into 4 callers) and an options-object rewrite (touches production call sites).

## Consequences
- ZERO production behavior change: every production caller omits the new parameter and therefore hits the same default it always did; the defaults are constructed once at module evaluation (same lifetime as the old `let` slots).
- Tests isolate by constructing their OWN spawner/memo/cache — no global reset, no order coupling. Each DEFAULT path stays test-proven by a characterization pin (`gitProcess.test.ts` real-git tests; `WebTreeSitterParser.initMemo.test.ts` shared-singleton pin; `resolveHermes.test.ts` fresh-module singleton pin via `vi.resetModules`).
- The existing param-injected seams in `resolveHermes.ts` (`ExecLookup`/`RealpathLookup`/`AccessCheck`) were already this pattern and are the reference idiom; nothing in this ADR changes them.
- Guard: a future test-only export (`__*ForTests`, `reset*ForTests`) in `src/` is a TST-02 regression — add the seam instead.
