/*
 * F1b (path doc §7.1/§2.5): the shared test-file narrowing helper for
 * `noUncheckedIndexedAccess` fallout on the HOST project. `!` is banned in
 * this repo's tests as much as in production — a `!` is a guard that cannot
 * fail, i.e. a lie to the compiler. `must()` gives the same one-line
 * ergonomics WITH a genuine runtime check: a wrong index (or any other
 * absent value) FAILS THE TEST loudly, right at the read site, instead of
 * surfacing later as an obscure "Cannot read properties of undefined" a few
 * lines downstream — or, worse, silently typechecking past a bug because
 * `!` told the compiler to stop looking.
 *
 * Host mirror of `webview/src/testing/must.ts` (F1a) — identical contract.
 */

/**
 * Assert `v` is present and return it narrowed to `T`. Throws if `v` is
 * `undefined` or `null`. Intended for test files ONLY — narrowing fixture/
 * index access (`must(arr[i])`, `must(state.tabs[id])`) without lying via
 * `!` and without burying the test's intent under a hand-written
 * `if (x === undefined) throw …` block at every call site.
 */
export function must<T>(v: T | undefined | null, msg?: string): T {
  if (v === undefined || v === null) {
    throw new Error(msg ?? 'must(): value was undefined or null');
  }
  return v;
}
