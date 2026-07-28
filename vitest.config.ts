/**
 * The repo's FIRST vitest config (W5.2). Everything ran on bare defaults
 * before this file existed, which makes it the single highest-blast-radius
 * file in the wave: it now governs which tests are collected AT ALL.
 *
 * Three DISJOINT projects. `*.test.ts` and `*.dom.test.tsx` can never both
 * match one file, so the boundary is structural rather than conventional — a
 * filename suffix is a lock a `git mv` cannot launder.
 *
 * The point of the split is that the 143 host test files and the 30 existing
 * webview test files keep paying EXACTLY what they paid on the defaults
 * (`environment: 'node'`), and only the new DOM files construct a jsdom.
 * That is not merely a speed argument: switching a project to jsdom installs a
 * global `window`/`document`, and any module branching on
 * `typeof window === 'undefined'` behaves differently there. The host project
 * must stay `node` for CORRECTNESS, not just for cost.
 *
 * `globals` stays OFF. All 173 pre-existing files import { describe, it,
 * expect } from 'vitest' explicitly; turning globals on would change
 * resolution semantics for 173 working files to save imports in three new
 * ones. The consequence is that RTL's auto-cleanup does NOT install itself —
 * see `webview/test/dom-setup.ts`.
 *
 * The three `include` globs were exhaustive over the pre-existing suite AT
 * THE TIME THIS FILE WAS ADDED (W5.2): all 173 collected files were
 * `*.test.ts` — 143 under `src/`, 30 under `webview/src/`, and zero with any
 * other extension, zero `*.spec.*`, and none outside those two roots.
 * Vitest's bare default include — any `.test.` or `.spec.` file in the
 * js/ts/jsx/tsx family, at any depth — therefore collected exactly the same
 * set these globs do. `typecheck.include` did NOT exist at that time (task
 * 6.2 review, M-5 — an earlier revision of this comment wrongly welded it
 * into the W5.2 exhaustiveness claim, which is scoped to a baseline that
 * predates it). It was added later, W6.2, as a FOURTH, disjoint collection
 * channel on BOTH the `host` and `webview-pure` projects: any `*.test-d.ts`
 * file under `src/` or `webview/src/` respectively (see each project's
 * `typecheck.include` below) — these count in the ordinary pass total, same
 * as every other test.
 *
 * If you add a test outside `src/` or `webview/src/`, or with any other
 * extension than `.test.ts`, `.dom.test.tsx`, or (under a project with
 * typecheck enabled) `.test-d.ts`, IT WILL NOT RUN and the suite will still
 * be green. Two DIFFERENT ways to land in that silently:
 *  1. A `.test-d.ts` file placed somewhere no project's `typecheck.include`
 *     reaches. Task 6.2 review, finding I-1: before this fix wave,
 *     `webview/src/**\/*.test-d.ts` was exactly this — inside BOTH normal
 *     `include` allow-lists' path AND extension rules on paper (under
 *     `webview/src/`, ending `.ts`), collected by NEITHER project (neither
 *     `.test.ts` nor `.dom.test.tsx`) and by no `typecheck.include` either
 *     (only the host project had one) — dead and green in both `npm test`
 *     and `npm run check-types`, with no distinct "0 collected" warning
 *     from either. `webview-pure` now carries its own `typecheck.include`
 *     below specifically to close that gap; a future `src/**\/*.test-d.ts`
 *     added under a project that never grows a `typecheck` block would
 *     reopen the identical hazard.
 *  2. A `typecheck.include` glob that matches ZERO files (a typo, or the
 *     last file under it renamed/deleted). Task 6.2 review, M-6: vitest
 *     prints no distinct warning for that either — exit is still 0, the
 *     pinned pass count is simply N smaller. The only thing that catches
 *     either failure mode is the same one this whole file's warning already
 *     relies on: comparing the run against the pinned gate numbers.
 *
 * `package.json` pins `vitest` to an exact version (`4.1.10`, not
 * `^4.1.10`) because vitest's own typecheck-mode output warns that breaking
 * changes there "might not follow SemVer". That pin is a PARTIAL
 * mitigation, not a complete one (task 6.2 review, M-3): the checker
 * `typecheck` mode actually drives is `tsc`, and `typescript` itself stays
 * on a caret range (`^5.7.2`, resolving to `5.9.3` as installed, verified
 * against `package-lock.json`) — every guard behavior this repo's `.test-d.ts`
 * plants depend on (branded-`any` widening under `toEqualTypeOf`, the
 * "Unused '@ts-expect-error' directive" message, `noUnusedLocals` REDing an
 * orphaned alias) comes from `tsc`'s own version, at least as much as from
 * vitest's. `package-lock.json` still makes BOTH deterministic across
 * `npm ci` today — `typescript` resolves to exactly one locked version
 * (`5.9.3`), the same as every other caret-range dependency here — so the
 * live exposure is a lockfile regeneration (`npm install` picking up a new
 * `typescript` minor), not everyday installs. But the exact vitest pin
 * alone does not close the gap its own stated rationale implies it does.
 * Left as an owner decision, deliberately NOT changed here: exact-pinning
 * `typescript` too would trade this asymmetry for the opposite trap —
 * `npm install` never picking up a `typescript` patch (including security
 * patches), and any future dependency that peer-requires a DIFFERENT
 * `typescript` range failing to resolve (`ERESOLVE`) against a hard pin.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: { label: 'host', color: 'blue' },
          include: ['src/**/*.test.ts'],
          environment: 'node',
          typecheck: {
            enabled: true,
            include: ['src/**/*.test-d.ts'],
            tsconfig: './tsconfig.json',
          },
        },
      },
      {
        test: {
          name: { label: 'webview-pure', color: 'green' },
          include: ['webview/src/**/*.test.ts'],
          environment: 'node',
          // Task 6.2 review, I-1: closes the "webview .test-d.ts is dead in
          // both gate commands" gap — see this file's own header doc.
          // `webview/tsconfig.json`'s own `include` (`["src", "test", ...]`)
          // already covers everything under `webview/src/`, so a
          // `.test-d.ts` file placed there needs no tsconfig change, only
          // this collection channel. No `.test-d.ts` file exists under
          // `webview/src/` yet — verified empty-but-wired: adding this block
          // when the glob matches zero files does not fail the gate (M-6's
          // own documented failure mode is silent-zero, not a hard error),
          // confirmed by running the full suite immediately after adding it.
          typecheck: {
            enabled: true,
            include: ['webview/src/**/*.test-d.ts'],
            tsconfig: './webview/tsconfig.json',
          },
        },
      },
      {
        test: {
          name: { label: 'webview-dom', color: 'magenta' },
          include: ['webview/src/**/*.dom.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./webview/test/dom-setup.ts'],
        },
      },
    ],
  },
});
