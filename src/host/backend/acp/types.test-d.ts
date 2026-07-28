import { describe, it, expectTypeOf } from 'vitest';
import type { UsageUpdate, SessionInfoUpdate, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AcpSessionUpdate } from './types';

/**
 * Counted type locks for `types.ts`'s SDK-mirroring members (audit A-1/A-2,
 * review findings I-2, N-1, N-3, M-1) — GUARD-INTEGRITY.md §9. Task 6.2 fix
 * wave (independent review) closed C-1 (Critical), added the I-2 member-set
 * lock, and closed M-1/M-2 on the completeness locks below.
 *
 * HOW THIS FILE IS ENFORCED — and exactly how it can and cannot fail:
 *  - It runs under the host project's `typecheck` mode (vitest.config.ts), so
 *    every `it()` below is a REAL test in the gate's pass count: deleting or
 *    `.skip`ping one MOVES the pinned numbers, and disabling typecheck mode
 *    removes them all at once — the loudest possible drop.
 *  - tsconfig's `include` also matches this file, so every assertion here is
 *    ALSO a plain `npm run check-types` error when violated. Two nets.
 *  - A violated `expectTypeOf` fails RED with the type printed; a stale
 *    `@ts-expect-error` fails RED as "Unused directive".
 *  - C-1 (task 6.2 review, Critical — corrects this paragraph's prior claim
 *    that no assertion here "can be simultaneously present and false"): a
 *    file-level `// @ts-nocheck`, or a per-line `// @ts-ignore`, silences
 *    tsc BEFORE any assertion below is evaluated — present, false, and with
 *    ZERO movement in either gate command. Verified directly: inserting
 *    `// @ts-nocheck` as this file's line 1, alongside `used: number`
 *    widened to `used: any` in `types.ts`, still reports `Tests 10 passed
 *    (10)` / `Type Errors no errors` / `check-types` exit 0. That channel is
 *    NOT closed by anything in this file — it is closed by a separate,
 *    right-polarity BAN scan, `src/suppressionCommentBan.test.ts`, which
 *    reads every `.ts` file's raw comment text (this one included) for
 *    those two directives and fails the gate loudly if either appears,
 *    independent of what it would have suppressed.
 *  - The one channel that scan does NOT close, and nothing in this repo
 *    does: SUBSTITUTING an assertion for a weaker lookalike — a
 *    syntactically legitimate `it()` whose only defect is its MEANING. No
 *    mechanism catches that; the task-review diff reader does. If you are
 *    editing this file, say so in your report and expect the diff to be
 *    read line by line.
 */

type OursUsage = Extract<AcpSessionUpdate, { sessionUpdate: 'usage_update' }>;
type OursInfo = Extract<AcpSessionUpdate, { sessionUpdate: 'session_info_update' }>;

/**
 * Closeout M-1 floor: names every TOP-LEVEL key of every modelled member
 * whose type is `any` — however the `any` got there (written, laundered
 * across lines, imported). `0 extends 1 & T[K]` is true only for `any`
 * (`unknown` stays false — verified against installed tsc 5.9.3 before
 * this was spec'd). Distributes over the union. SHALLOW on purpose: it
 * does not recurse into element types (e.g. `AcpAvailableCommand[]`) —
 * nested introductions are the text ban's job (`anyIntroductionBan.
 * test.ts`); recursing into SDK-derived trees would inherit any upstream
 * SDK `any` as our permanent false RED and is depth-fragile.
 */
type AnyKeysOf<T> = T extends unknown
  ? { [K in keyof T]-?: 0 extends 1 & T[K] ? K : never }[keyof T]
  : never;

describe('AcpSessionUpdate — counted locks against @agentclientprotocol/sdk@0.17.1', () => {
  // I-2 (task 6.2 review, Important). Before this lock existed, every other
  // assertion in this file covered two of the SDK's eleven `session/update`
  // members plus `rawOutput`; nothing asserted the *set* of members was
  // complete — the SDK adding a twelfth member (precisely how
  // `usage_update`/`session_info_update` appeared, and exactly what audit
  // A-1 was opened for) was invisible to all of them. Pins the one
  // deliberate omission (`types.ts`'s header names it:
  // `config_option_update`, never sent by the Hermes ACP adapter) BY NAME,
  // so removing it from the exclusion set is equally RED, not just an SDK
  // addition.
  it('the only SDK session/update member we do not model is config_option_update', () => {
    expectTypeOf<Exclude<SessionUpdate['sessionUpdate'], AcpSessionUpdate['sessionUpdate']>>().toEqualTypeOf<'config_option_update'>();
  });

  it('SDK UsageUpdate is assignable to our usage_update member', () => {
    expectTypeOf<UsageUpdate & { sessionUpdate: 'usage_update' }>().toExtend<OursUsage>();
  });

  it('SDK SessionInfoUpdate is assignable to our session_info_update member', () => {
    expectTypeOf<SessionInfoUpdate & { sessionUpdate: 'session_info_update' }>().toExtend<OursInfo>();
  });

  // M-2 (task 6.2 review, Minor): `.toBeNever()` names the drifted key in
  // its failure (`Type '"archived"' has no call signatures`-shaped error);
  // the previous `.toEqualTypeOf<never>()` form failed with only
  // `Expected 1 arguments, but got 0` — same RED, worse diagnosability.
  it('completeness: usage_update models every key the SDK declares', () => {
    expectTypeOf<Exclude<keyof UsageUpdate, keyof OursUsage>>().toBeNever();
  });

  it('completeness: session_info_update models every key the SDK declares', () => {
    expectTypeOf<Exclude<keyof SessionInfoUpdate, keyof OursInfo>>().toBeNever();
  });

  // M-1 (task 6.2 review, Minor): the two completeness locks above are
  // UNCONDITIONALLY vacuous the moment `keyof Ours` picks up a `string`
  // index signature — `Exclude<keyof SDK, keyof Ours>` collapses to `never`
  // for ANY SDK type once `Ours` is `{ ...; [key: string]: unknown }`
  // (verified: `keyof { a: string; [key: string]: unknown }` is exactly
  // `string | number`, not a subset — a completeness lock against that
  // shape passes green while modelling NO key the SDK declares). This is
  // the floor under both locks above: it stays true today (neither member
  // has an index signature) and goes RED the day either regresses to one —
  // e.g. back to the opaque `{ sessionUpdate: 'usage_update'; [key: string]:
  // unknown }` placeholder this task's predecessor replaced.
  it('anti-vacuity: usage_update/session_info_update keys are not an opaque index signature (the floor under the two completeness locks above)', () => {
    expectTypeOf<keyof OursUsage>().not.toEqualTypeOf<string | number>();
    expectTypeOf<keyof OursInfo>().not.toEqualTypeOf<string | number>();
  });

  it('usage_update.used and .size are exactly number — widening to any goes RED', () => {
    expectTypeOf<OursUsage['used']>().toEqualTypeOf<number>();
    expectTypeOf<OursUsage['size']>().toEqualTypeOf<number>();
  });

  it('session_info_update.title and .updatedAt are exactly string | null | undefined', () => {
    expectTypeOf<OursInfo['title']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<OursInfo['updatedAt']>().toEqualTypeOf<string | null | undefined>();
  });

  it('_meta on both members is exactly Record<string, unknown> | null | undefined', () => {
    expectTypeOf<OursUsage['_meta']>().toEqualTypeOf<Record<string, unknown> | null | undefined>();
    expectTypeOf<OursInfo['_meta']>().toEqualTypeOf<Record<string, unknown> | null | undefined>();
  });

  it('usage_update.cost is exactly { amount: number; currency: string } | null | undefined', () => {
    expectTypeOf<OursUsage['cost']>().toEqualTypeOf<{ amount: number; currency: string } | null | undefined>();
  });

  it('no top-level field of ANY modelled member is `any` — the M-1 floor under every unpinned field', () => {
    expectTypeOf<AnyKeysOf<AcpSessionUpdate>>().toBeNever();
  });
});

describe('AcpToolCallFields.rawOutput — A-2 pin', () => {
  type RawOutput = Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call_update' }>['rawOutput'];

  it('rawOutput is exactly unknown — RED if re-narrowed to Record, RED if widened to any', () => {
    expectTypeOf<RawOutput>().toEqualTypeOf<unknown>();
  });

  it('negative twin: unknown must NOT extend Record — a stale directive here is RED by itself', () => {
    // @ts-expect-error — `rawOutput` is `unknown`. If a future edit re-narrows
    // it to `Record<string, unknown> | null`, this line starts COMPILING and
    // tsc reports "Unused '@ts-expect-error' directive" — this test goes RED.
    // Redundant with the pin above on purpose: deleting either alone leaves
    // the other standing.
    expectTypeOf<RawOutput>().toExtend<Record<string, unknown> | null | undefined>();
  });
});
