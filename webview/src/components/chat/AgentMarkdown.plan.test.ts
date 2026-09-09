import { describe, it, expect } from 'vitest';
import {
  planStreamingRender,
  CODE_STABLE_CHUNK,
  splitStableBoundary,
  tokenize,
} from './AgentMarkdown';

/**
 * WS-E E1 (L2-CA-03) Step 2 — pure-function RED tests for `planStreamingRender`.
 *
 * Bug: while streaming, `splitStableBoundary` only cuts at a balanced `\n\n`,
 * so INSIDE an open code fence the entire message is the unmemoized "tail"
 * and is re-tokenized/re-rendered on every delta — O(n^2) over a long
 * streamed code block. `planStreamingRender` finds the trailing OPEN fence
 * (if any) and splits its body into a memo-stable `bodyStable` (quantized to
 * `CODE_STABLE_CHUNK`-char chunks) + a small `bodyTail`, so only the tail
 * text node needs to change on each delta.
 *
 * Fixture: an open (never-closed) ```ts fence with 300 substantial code
 * lines — long enough that the body crosses several CODE_STABLE_CHUNK
 * (4096-char) windows over the course of growing from empty to full, so the
 * identity property below is exercised across multiple quantization steps,
 * not just the initial (always-empty) window.
 */
const FENCE_HEADER = 'Intro\n\n```ts\n';
const CODE_LINES = Array.from(
  { length: 300 },
  (_, i) => `  const value_${i}_squared = ${i} * ${i}; // computed line number ${i} for the fixture body`,
).join('\n');
const OPEN_FENCE_FIXTURE = FENCE_HEADER + CODE_LINES;

/** Independent (non-`planStreamingRender`-derived) check for "does
 * `tokenize(tail, true)` treat the trailing fence as OPEN (unterminated)".
 * `tokenize`'s open-fence branch (see its doc comment) only fires when
 * `streaming` is true; with `streaming` false the exact same trailing text is
 * pushed as a plain prose token instead (`code: false`). So the two calls
 * disagree in their trailing token's SHAPE if and only if there is a
 * trailing open fence in `text` — independent of `planStreamingRender`'s own
 * regex reuse, so it cannot pass by construction.
 *
 * WS-E dofix (gate flake): this used to compare `JSON.stringify(...)` of the
 * two full token arrays. `tokenize`'s non-open-fence branches (both the
 * paired-fence loop and the plain-prose fallback) run identically regardless
 * of `streaming` — the ONLY code path that can make the two calls disagree at
 * all is the open-fence branch, which is reached only when `streaming` is
 * true and only changes the shape of the array (an extra element, and/or a
 * `code: false` token flipping to `code: true`), never the *content* of a
 * token that both calls happen to produce the same way. So comparing
 * `.length`/`code`/`lang` (cheap, O(1) per token) is exactly equivalent to
 * comparing the full stringified bodies (O(tail length) per call, run twice,
 * ~27,000 times) — it detects every real divergence and can't false-positive
 * on one shape while the underlying content silently differs, because
 * matching shape only ever arises from the two calls having taken the exact
 * same slice operations. Dropping the `body` stringification is what turns
 * this property test from ~6.1s (crossing vitest's 5s default per-test
 * timeout under full-suite load, per L2-R2-BH FIND-FIXES) into low-single
 * digits; the explicit `timeout` on the `it(...)` below is the second,
 * independent guard against that same class of flake. */
function tokenizeYieldsOpenFenceToken(text: string): boolean {
  const withStreaming = tokenize(text, true);
  const withoutStreaming = tokenize(text, false);
  if (withStreaming.length !== withoutStreaming.length) return true;
  for (let i = 0; i < withStreaming.length; i++) {
    const a = withStreaming[i];
    const b = withoutStreaming[i];
    if (!a || !b) return true;
    if (a.code !== b.code || a.lang !== b.lang || a.body.length !== b.body.length) {
      return true;
    }
  }
  return false;
}

describe('WS-E E1 (L2-CA-03) Step 2: planStreamingRender pure-function properties', () => {
  it('CODE_STABLE_CHUNK is 4096', () => {
    expect(CODE_STABLE_CHUNK).toBe(4096);
  });

  it('concatenation invariant holds for every prefix of the open-fence fixture', () => {
    for (let k = 0; k <= OPEN_FENCE_FIXTURE.length; k++) {
      const text = OPEN_FENCE_FIXTURE.slice(0, k);
      const plan = planStreamingRender(text);
      const reassembled = plan.fence
        ? plan.stable + plan.fence.pre + plan.fence.opener + plan.fence.bodyStable + plan.fence.bodyTail
        : plan.stable + plan.tail;
      expect(reassembled).toBe(text);
    }
  });

  // WS-E dofix (gate flake): explicit timeout is a second, independent
  // guard on top of the cheap-comparison fix above (~3x headroom over the
  // ~7s this file takes end-to-end in isolation) — belt-and-braces against
  // vitest's 5000ms default per-test timeout under full-suite load, per
  // L2-R2-BH FIND-FIXES (observed ~6.1-6.4s under load vs. ~7s isolated).
  it(
    'fence is undefined exactly when tokenize(tail, true) yields no open-fence token, for every prefix',
    { timeout: 20000 },
    () => {
      for (let k = 0; k <= OPEN_FENCE_FIXTURE.length; k++) {
        const text = OPEN_FENCE_FIXTURE.slice(0, k);
        const { tail } = splitStableBoundary(text);
        const plan = planStreamingRender(text);
        expect(plan.tail).toBe(tail);
        expect(plan.fence !== undefined).toBe(tokenizeYieldsOpenFenceToken(tail));
      }
    },
  );

  it('bodyStable is identity-stable within one CODE_STABLE_CHUNK window and changes only when the window changes', () => {
    let prevFloor: number | undefined;
    let prevBodyStable: string | undefined;
    let sawAChange = false;
    for (let k = 0; k <= OPEN_FENCE_FIXTURE.length; k++) {
      const text = OPEN_FENCE_FIXTURE.slice(0, k);
      const plan = planStreamingRender(text);
      if (!plan.fence) continue;
      const bodyLen = plan.fence.bodyStable.length + plan.fence.bodyTail.length;
      const floor = Math.floor(bodyLen / CODE_STABLE_CHUNK);
      if (prevFloor !== undefined && floor === prevFloor) {
        expect(plan.fence.bodyStable).toBe(prevBodyStable);
      } else if (prevFloor !== undefined && floor !== prevFloor && prevBodyStable !== plan.fence.bodyStable) {
        sawAChange = true;
      }
      prevFloor = floor;
      prevBodyStable = plan.fence.bodyStable;
    }
    // Sanity: the fixture is long enough that bodyStable actually advances at
    // least once — otherwise the "same window -> same string" check above
    // would be vacuously true for the whole fixture.
    expect(sawAChange).toBe(true);
  });

  it('no open fence -> fence is undefined and tail is the whole splitStableBoundary tail (settled/no-fence path untouched)', () => {
    const text = 'Intro\n\nSettled paragraph with no fences at all.';
    const plan = planStreamingRender(text);
    const { stable, tail } = splitStableBoundary(text);
    expect(plan.stable).toBe(stable);
    expect(plan.tail).toBe(tail);
    expect(plan.fence).toBeUndefined();
  });

  it('a CLOSED fence (```lang\\nbody```) is not treated as an open fence', () => {
    const text = 'Intro\n\n```ts\nconst x = 1;\n```';
    const plan = planStreamingRender(text);
    expect(plan.fence).toBeUndefined();
  });

  it('lang is carried on the fence when present', () => {
    const text = FENCE_HEADER + 'const a = 1;';
    const plan = planStreamingRender(text);
    expect(plan.fence?.lang).toBe('ts');
  });

  it('lang is omitted (not present as a key) when the fence opener has no language tag', () => {
    const text = 'Intro\n\n```\nconst a = 1;';
    const plan = planStreamingRender(text);
    expect(plan.fence).toBeDefined();
    expect('lang' in (plan.fence ?? {})).toBe(false);
  });
});
