/**
 * Minimal glob→regex compiler covering the subset of patterns useful for
 * `path_globs` filters (how-to §7.2 examples: `src/**`, `!**\/*.test.*`).
 * (Note: the slash above is escaped with `\` only to keep this literal
 * example from prematurely closing this very block comment — `**` directly
 * followed by `/` forms an end-of-comment token.)
 * Kept dependency-free rather than pulling in micromatch/minimatch for one
 * small predicate.
 *  - `**` matches across path separators (including zero segments)
 *  - `*`  matches within a single path segment
 *  - `?`  matches exactly one non-separator character
 * A pattern beginning with `!` is a negation (excludes matches) — the same
 * "later/negation wins" semantics as `.gitignore`.
 */
function globToRegExpSource(bareGlob: string): string {
  let out = '';
  for (let i = 0; i < bareGlob.length; i++) {
    const c = bareGlob[i];
    if (c === undefined) {
      // Unreachable: i < bareGlob.length keeps this in bounds.
      continue;
    }
    if (c === '*') {
      if (bareGlob[i + 1] === '*') {
        i++; // consume the second '*'
        if (bareGlob[i + 1] === '/') i++; // and an optional following '/'
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

export interface CompiledGlob {
  negated: boolean;
  regexp: RegExp;
}

export function compilePathGlobs(globs: readonly string[]): CompiledGlob[] {
  return globs.map((g) => {
    const negated = g.startsWith('!');
    const bare = negated ? g.slice(1) : g;
    return { negated, regexp: new RegExp(`^${globToRegExpSource(bare)}$`) };
  });
}

/**
 * Same predicate as {@link matchesPathGlobs}, but takes ALREADY-COMPILED
 * globs. A caller filtering many candidate paths against the SAME `globs`
 * array (e.g. `runCodebaseSearch`'s per-hit filter) should call
 * {@link compilePathGlobs} ONCE and reuse the result across every candidate
 * via this function, instead of calling {@link matchesPathGlobs} per
 * candidate — which recompiles the same regex set every time (V-21
 * pathGlob amplifier fold-in, tier2-remediation-architecture.md §8: an
 * uncapped `path_globs` array recompiled once per hit is a cheap CPU
 * amplifier).
 */
export function matchesCompiledPathGlobs(relPosixPath: string, compiled: readonly CompiledGlob[]): boolean {
  if (compiled.length === 0) return true;
  const positives = compiled.filter((c) => !c.negated);
  const negatives = compiled.filter((c) => c.negated);

  const matchesAnyPositive = positives.length === 0 || positives.some((c) => c.regexp.test(relPosixPath));
  const matchesAnyNegative = negatives.some((c) => c.regexp.test(relPosixPath));

  return matchesAnyPositive && !matchesAnyNegative;
}

/**
 * A path matches if it satisfies at least one *positive* pattern (or there
 * are no positive patterns at all) AND is not excluded by any `!`-negated
 * pattern. Convenience wrapper that compiles `globs` on every call — fine
 * for a single lookup, but a per-candidate loop over a shared glob set
 * should call {@link compilePathGlobs} once and reuse {@link
 * matchesCompiledPathGlobs} instead (see its doc comment).
 */
export function matchesPathGlobs(relPosixPath: string, globs?: readonly string[]): boolean {
  if (!globs || globs.length === 0) return true;
  return matchesCompiledPathGlobs(relPosixPath, compilePathGlobs(globs));
}
