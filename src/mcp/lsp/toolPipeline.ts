/**
 * W3 (LIB) · T6a — `toolPipeline`: the pure, headless pipeline primitives the
 * 6 LSP tool handlers (T6b) compose (research doc §5.1/§5.2, brief
 * `w3-t6a-brief.md`). Every export here is either total (never throws on
 * malformed input — clamps/refuses instead) or, for the two async seams
 * (`withDeadline`, `buildConfinementVerdict`), propagates real failures
 * rather than swallowing them.
 *
 * ## Headless (T4 invariant-lock covers this directory)
 * NO `vscode` import, NO `fs`/`node:fs` import. `resolveWithinWorkspaceReal`
 * (the real realpath primitive, `src/host/backend/acp/pathConfine.ts`) is
 * consumed only through the injected {@link RealpathConfiner} function type —
 * this file never touches the filesystem or the network itself. T6b injects
 * the real confiner later; this module stays testable with a fake.
 *
 * ## The 7 primitives
 * 1. {@link toZeroBasedPosition} — R7.2/R7.3 validate + 1-based wire → 0-based.
 * 2. {@link withDeadline} — `Promise.race` wall-clock deadline, no timer leak,
 *    propagates a real `work()` rejection.
 * 3. {@link createIndexingTracker} — first-empty "maybe-indexing" policy.
 * 4. {@link LruCache} — bounded, recency-ordered cache.
 * 5. {@link createConcurrencyPool} — bounded in-flight pool, FIFO queue,
 *    finally-release (a rejecting/throwing task can never wedge the pool).
 * 6. {@link extractSnippet} — pure line-range slice, raw output (the T5
 *    shaper sanitizes — this function does NOT).
 * 7. {@link buildConfinementVerdict} — fail-closed confinement verdict over
 *    an injected {@link RealpathConfiner}: a `null` result AND a thrown
 *    error both collapse to the identical `{inRoot:false}` shape. The
 *    `catch` that does this is explicit and documented (not a silent
 *    swallow) — see {@link buildConfinementVerdict}'s own doc comment.
 */

import type { ConfinementVerdict, PlainPosition, PlainRange } from './resultShaper';

// ---------------------------------------------------------------------------
// 1. toZeroBasedPosition — R7.2/R7.3
// ---------------------------------------------------------------------------

/** The wire shape: 1-based `line`/`character`, exactly as the MCP tool call
 * arguments arrive (before any validation). */
export type PositionInput = { line: number; character: number };

const MIN_WIRE_COORDINATE = 1;

/** Validates one 1-based wire coordinate. Returns a human-readable refusal
 * reason, or `null` when the value is a valid 1-based coordinate. Order
 * matters for a clear message: finite → integer → in-range, each check
 * assuming the previous one already passed. */
function validateWireCoordinate(value: number, fieldName: 'line' | 'character'): string | null {
  if (!Number.isFinite(value)) {
    return `${fieldName} must be a finite number (got ${String(value)})`;
  }
  if (!Number.isInteger(value)) {
    return `${fieldName} must be an integer (got ${value})`;
  }
  if (value < MIN_WIRE_COORDINATE) {
    return `${fieldName} must be >= 1 on the 1-based wire (got ${value})`;
  }
  return null;
}

/**
 * Validates a 1-based wire `PositionInput` (R7.2: finite/integer/in-range)
 * and, when valid, converts it to a 0-based {@link PlainPosition} (R7.3) —
 * the exact inverse of the T5 shaper's 0-based→1-based render. Total: never
 * throws; bad input yields a typed `{ok:false, reason}` refusal the handler
 * surfaces to the caller instead of a 500/crash.
 */
export function toZeroBasedPosition(
  input: PositionInput,
): { ok: true; position: PlainPosition } | { ok: false; reason: string } {
  const lineError = validateWireCoordinate(input.line, 'line');
  if (lineError !== null) {
    return { ok: false, reason: lineError };
  }
  const characterError = validateWireCoordinate(input.character, 'character');
  if (characterError !== null) {
    return { ok: false, reason: characterError };
  }
  return {
    ok: true,
    position: { line: input.line - 1, character: input.character - 1 },
  };
}

// ---------------------------------------------------------------------------
// 2. withDeadline — Promise.race wall-clock deadline
// ---------------------------------------------------------------------------

/**
 * Races `work()` against a `ms`-millisecond timer (the LSP provider commands
 * take no `CancellationToken`, so a losing `work()` keeps running in the
 * background — this function abandons it, it does not cancel it).
 *
 * - `work()` settles first → `{status:'ok', value}`.
 * - The timer fires first → `{status:'timeout'}`; `work()` is abandoned, not
 *   cancelled (no crash if it later resolves or rejects — nothing awaits it
 *   further beyond this function's own internal `Promise.race` wiring).
 * - `work()` REJECTS (before or via a synchronous throw) → the rejection
 *   PROPAGATES out of this function; it is never reinterpreted as a timeout.
 *
 * The deadline timer is cleared via `clearTimeout` in a `finally` — on BOTH
 * outcomes (ok or timeout) and even when `work()` rejects — so this function
 * never leaks a timer handle.
 *
 * Edge note (Opus review Minor-4): `ms` extremes are out of contract — Node's
 * `setTimeout` clamps a non-finite `ms` like `Infinity` to ~1ms, and coerces
 * `NaN` to `0`, so either would fire the deadline almost immediately rather
 * than "never". Not reachable in practice: every T6b call site passes a
 * fixed 3–10s deadline, never a caller-supplied or derived `ms`.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  ms: number,
): Promise<{ status: 'ok'; value: T } | { status: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeoutPromise = new Promise<{ status: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
  });
  try {
    // `work()` is called inside this `try` (not before it) specifically so
    // that even a synchronous throw from a non-conforming `work` still hits
    // the `finally` below and clears the timer — never a leak, regardless
    // of how badly `work` misbehaves.
    let workPromise: Promise<T>;
    try {
      workPromise = work();
    } catch (syncError) {
      workPromise = Promise.reject(syncError);
    }
    const okPromise = workPromise.then((value) => ({ status: 'ok' as const, value }));
    return await Promise.race([okPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 3. createIndexingTracker — first-empty "maybe-indexing" policy
// ---------------------------------------------------------------------------

export interface IndexingTracker {
  /**
   * Classifies one result for `languageKey`. Returns `'first-empty'` only
   * the very first time `isEmpty===true` is observed for that key AND no
   * non-empty result has ever been recorded for it — the handler (T6b) uses
   * that signal to trigger exactly one 500-1000ms retry with
   * `status:"maybe-indexing"`. Every other case (a non-empty result; a
   * repeat empty; an empty after a non-empty) is `'normal'`. Records state
   * internally — never throws.
   */
  classify(languageKey: string, isEmpty: boolean): 'normal' | 'first-empty';
}

export function createIndexingTracker(): IndexingTracker {
  const seenNonEmpty = new Set<string>();
  const firstEmptyFired = new Set<string>();
  return {
    classify(languageKey, isEmpty) {
      if (!isEmpty) {
        seenNonEmpty.add(languageKey);
        return 'normal';
      }
      if (seenNonEmpty.has(languageKey) || firstEmptyFired.has(languageKey)) {
        return 'normal';
      }
      firstEmptyFired.add(languageKey);
      return 'first-empty';
    },
  };
}

// ---------------------------------------------------------------------------
// 4. LruCache — bounded, recency-ordered
// ---------------------------------------------------------------------------

/**
 * A bounded, recency-ordered cache. Backed by a `Map` (which iterates in
 * insertion order) — `get`/`set` on an existing key delete-then-reinsert to
 * move that key to the most-recently-used (last) position; eviction always
 * removes the first (least-recently-used) key. `maxEntries<=0` (including
 * negative/non-finite input) is guarded to a capacity of 0 — the cache never
 * throws and never retains anything, it just stops being useful, which is
 * the safe failure mode for a malformed capacity.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly capacity: number;

  constructor(maxEntries: number) {
    this.capacity = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) {
      return undefined;
    }
    // `has` just confirmed the key is present, so this `get` cannot be the
    // "key absent" undefined case; narrowing after that runtime check is the
    // one documented, acceptable use of `as` here (Map's own typings cannot
    // express "present because I just checked").
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evictOverCapacity();
  }

  private evictOverCapacity(): void {
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. createConcurrencyPool — bounded in-flight, FIFO queue, finally-release
// ---------------------------------------------------------------------------

/**
 * A bounded-concurrency task runner. At most `maxInFlight` tasks run at
 * once; excess `run()` calls queue FIFO and start as slots free.
 *
 * The reviewed crux: slot release happens in a `finally` attached to the
 * task's outcome — whether the task resolves, rejects, or throws
 * synchronously (normalized into a rejection before that `finally` is
 * attached) — so a failing task can NEVER wedge the pool by holding its slot
 * forever. `run()`'s returned promise resolves/rejects with exactly the
 * task's own outcome.
 *
 * `maxInFlight<=0` (or non-finite) is guarded to 1 — a malformed bound still
 * makes forward progress (serialized) rather than deadlocking every task.
 *
 * Re-entrancy caveat (Opus review Minor-5): a task that itself calls back
 * into `run()` on this SAME pool while holding the pool's last free slot can
 * deadlock — its inner `run()` call queues behind itself, which never gets a
 * slot back until the outer task returns, which it can't until the inner
 * call resolves. Not applicable here: T6b's gateway tasks never recurse into
 * the pool that scheduled them.
 */
export function createConcurrencyPool(maxInFlight: number): { run<T>(task: () => Promise<T>): Promise<T> } {
  const limit = Number.isFinite(maxInFlight) && maxInFlight > 0 ? Math.floor(maxInFlight) : 1;
  let active = 0;
  const queue: Array<() => void> = [];

  function dequeueNext(): void {
    if (active >= limit) {
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    active++;
    next();
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = (): void => {
          // A task that throws synchronously (instead of returning a
          // rejected Promise) is normalized into one here — otherwise the
          // `.then(resolve, reject).finally(...)` below would never be
          // reached and the slot would leak forever.
          let taskPromise: Promise<T>;
          try {
            taskPromise = task();
          } catch (syncError) {
            taskPromise = Promise.reject(syncError);
          }
          taskPromise.then(resolve, reject).finally(() => {
            // finally-release: runs on EVERY outcome (resolve or reject),
            // so a rejecting task always frees its slot for the next
            // queued task.
            active--;
            dequeueNext();
          });
        };
        queue.push(attempt);
        dequeueNext();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 6. extractSnippet — pure, raw, total
// ---------------------------------------------------------------------------

/** Clamps a (possibly negative/non-finite/out-of-range) 0-based line index
 * into `[0, lineCount)` — or `0` when `lineCount` is `0`. Never throws. */
function clampLineIndex(line: number, lineCount: number): number {
  if (!Number.isFinite(line)) {
    return 0;
  }
  const floored = Math.floor(line);
  if (floored < 0) {
    return 0;
  }
  const lastIndex = Math.max(0, lineCount - 1);
  return Math.min(floored, lastIndex);
}

/**
 * Extracts up to `maxLines` lines of `docText` starting at `range.start.line`
 * (0-based, clamped into range), joined with `\n`. Pure and total: never
 * throws on an out-of-range line index (clamps), an empty document (returns
 * `''`), or `maxLines<=0`/non-finite (returns `''`). Returns the RAW slice —
 * the T5 shaper (`sanitizeLsString`) sanitizes it; this function must not.
 */
export function extractSnippet(docText: string, range: PlainRange, maxLines: number): string {
  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    return '';
  }
  const lines = docText.split('\n');
  const startLine = clampLineIndex(range.start.line, lines.length);
  const endExclusive = Math.min(lines.length, startLine + Math.floor(maxLines));
  return lines.slice(startLine, endExclusive).join('\n');
}

// ---------------------------------------------------------------------------
// 7. buildConfinementVerdict — fail-closed over an injected RealpathConfiner
// ---------------------------------------------------------------------------

/**
 * The exact shape of `resolveWithinWorkspaceReal`
 * (`src/host/backend/acp/pathConfine.ts`), injected so this module never
 * touches the filesystem itself. Resolves the canonical (realpath'd)
 * absolute path when `target` is contained in one of `roots`, else `null`.
 */
export type RealpathConfiner = (target: string, roots: string[]) => Promise<string | null>;

/**
 * Minimal, documented root-selection: T6a is headless and cannot realpath
 * `roots` itself (that FS work happens inside the injected `confine`), so
 * this picks the containing root by a plain string-prefix match of the
 * confiner's already-canonical result against the (as-given) `roots` array.
 * T6b's real `confine`/`toRelative` are expected to operate over
 * consistently realpath'd roots, so this lexical match lines up with
 * `canonical` in practice.
 *
 * S7 fix: among every root that lexically contains `canonicalPath`, picks
 * the LONGEST match — i.e. the most specific/nested containing root — never
 * just the first one array order happens to list. Overlapping/nested
 * workspace roots (e.g. `/workspace` and `/workspace/nested-project` both
 * open) used to let the array-order-first root win even when a more
 * specific one also matched, rendering a `relPath` with a spurious extra
 * leading segment. Returns `undefined` when NO root lexically matches (a
 * caller/test artifact — `buildConfinementVerdict` only reaches this helper
 * after `confine` already proved containment in ONE of `roots`) — the
 * caller refuses to fabricate a relPath against an unrelated root rather
 * than falling back to `roots[0]` (S7's "refuse cross-root fallback").
 */
function findContainingRoot(canonicalPath: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (isRootPrefixOf(root, canonicalPath) && (best === undefined || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

/** `root` is a path-boundary-respecting prefix of `canonicalPath`: either an
 * exact match, or followed immediately by a `/` or `\` separator (so
 * `/workspace` does not falsely match `/workspace-other`). */
function isRootPrefixOf(root: string, canonicalPath: string): boolean {
  if (root === '') {
    return false;
  }
  if (canonicalPath === root) {
    return true;
  }
  if (!canonicalPath.startsWith(root)) {
    return false;
  }
  const boundaryChar = canonicalPath.charAt(root.length);
  return boundaryChar === '/' || boundaryChar === '\\';
}

/**
 * Builds the pre-computed {@link ConfinementVerdict} the T5 shaper consumes,
 * over an injected {@link RealpathConfiner} (never `fs` directly).
 *
 * - `confine` resolves `null` (target is genuinely out-of-root) ⇒
 *   `{inRoot:false, externalUri: rawFsPath}` — NOT a throw; the CALLER
 *   decides refuse-vs-external for its own tool semantics (research doc
 *   §5.2).
 * - `confine` resolves a canonical path ⇒ `{inRoot:true, relPath}`, where
 *   `relPath = toRelative(<containing root>, canonical)` — or, when
 *   {@link findContainingRoot} finds no lexically-containing root at all
 *   (S7: "refuse cross-root fallback"), `relPath = canonical` (the raw
 *   absolute path) rather than a `path.relative` computed against an
 *   unrelated root, which could render a confusing/misleading value.
 * - `confine` THROWS ⇒ fail-closed: treated identically to a `null`
 *   resolution, `{inRoot:false, externalUri: rawFsPath}` — **never**
 *   `inRoot:true`. This `catch` is an explicit, documented fail-closed
 *   mapping (not a silent swallow): the thrown error is not the caller's
 *   problem to inspect, because "confiner errored" and "confiner said no"
 *   must be indistinguishable from the confinement decision's point of view
 *   — anything else would let a broken/compromised confiner accidentally
 *   grant access by throwing instead of returning `null`.
 */
export async function buildConfinementVerdict(
  rawFsPath: string,
  roots: string[],
  confine: RealpathConfiner,
  toRelative: (root: string, canonical: string) => string,
): Promise<ConfinementVerdict> {
  let canonical: string | null;
  try {
    canonical = await confine(rawFsPath, roots);
  } catch {
    return { inRoot: false, externalUri: rawFsPath };
  }
  if (canonical === null) {
    return { inRoot: false, externalUri: rawFsPath };
  }
  const containingRoot = findContainingRoot(canonical, roots);
  // S7: refuse a cross-root fallback — when no given root lexically
  // contains `canonical`, fall back to the absolute canonical path itself
  // (an honest value) instead of computing `toRelative` against an
  // unrelated root (which could render a confusing/misleading relPath).
  const relPath = containingRoot !== undefined ? toRelative(containingRoot, canonical) : canonical;
  return { inRoot: true, relPath };
}
