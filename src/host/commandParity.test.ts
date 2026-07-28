import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectNonTestTsSources, type PuritySourceFile } from './purityScan';

/**
 * Manifest↔code parity lock (audit H-1). Every `contributes.commands` entry
 * must have a matching `registerCommand('<id>'` somewhere under `src/`.
 *
 * This is a PLAIN TEXT SCAN, not an AST analysis — deliberately blunt, the
 * same posture `lspInvariant.test.ts` uses for its own scans. BUT the two
 * locks are opposite KINDS of scan, and that difference means they must be
 * comment-blind in OPPOSITE directions:
 *
 *  - `lspInvariant.test.ts` is a BAN scan (`this string must never appear`).
 *    Reading comments there fails CLOSED: a comment that happens to mention
 *    a banned term produces a spurious RED — noisy, but safe, because nobody
 *    ships an unnoticed violation. That file's own doc comment explains this
 *    at length, and it is correct for a ban.
 *
 *  - THIS file is a PRESENCE scan (`this string must appear somewhere`).
 *    Reading comments here fails OPEN: prose ANYWHERE under `src/` that
 *    happens to contain the substring `registerCommand('hermes.x'` makes the
 *    scan pass with zero real registrations existing. A 3-lens review (C-1)
 *    proved this concretely: deleting the real `hermes.showLogs` call in
 *    `extension.ts` and adding one sentence containing that exact substring
 *    to an unrelated file's doc comment (`diffDecision.vscode.ts`) left the
 *    lock green. `lspInvariant`'s "same blunt mechanism" justification does
 *    NOT transfer to a presence scan — the earlier version of this file
 *    copied that justification without noticing the polarity flip.
 *
 * So, unlike `lspInvariant`, this scan strips comments (block AND line)
 * before matching. For a presence check this is the conservative direction:
 * a real registration that only "existed" inside a comment was never a real
 * registration, so stripping can only turn a false GREEN into a true RED —
 * never the reverse.
 *
 * A second false-GREEN channel (I-2, same review): a bare
 * `const FOO = 'hermes.x'` declaration is not proof that `FOO` was ever
 * passed to `registerCommand` — a refactor that deletes the registerCommand
 * call but leaves the const sitting nearby (or replaces the call with an
 * inert `{ dispose() {} }`, the reviewer's exact repro against
 * `shell.vscode.ts:1392`'s `FIM_ACCEPT_COMMAND`) left the old single-pass
 * "any SCREAMING_SNAKE const whose value starts with `hermes.`" shortcut
 * unable to fail — it added the id from the const regardless of whether
 * anything still registered it. `registeredCommandIds()` below instead
 * resolves identifiers in two steps: collect the identifiers that actually
 * appear as the first argument to a real `registerCommand(...)` call, THEN
 * resolve only THOSE identifiers through a `const IDENT = '<id>'`
 * declaration. Deleting the call removes the identifier from step one, so
 * the id it used to stand for correctly drops out of the registered set.
 *
 * RED/GREEN verification for C-1, I-2, and the manifest-vacuity guard (M-1,
 * below) — the reviewer's exact mutations replayed against this
 * implementation, plus the reverts — is recorded with real command output in
 * `.superpowers/sdd/task-1-report.md`.
 */
const REPO_ROOT = join(__dirname, '..', '..');

function declaredCommandIds(): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { commands: { command: string }[] };
  };
  return manifest.contributes.commands.map((c) => c.command);
}

/**
 * Strips block comments (`/* … *\/`, including `/** … *\/` doc comments)
 * then line comments (`// …`) from `source`. The line-comment pattern
 * requires the char immediately before `//` to be either the start of the
 * line or NOT a colon, so it does not eat the `//` inside a `'http://…'`-
 * style string literal that a `//` comment would never legitimately follow
 * a colon in real TS source. Order matters: block comments are stripped
 * FIRST so a `//` that happens to sit inside a block comment's own text
 * isn't independently matched by the line-comment pass afterward.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * M-3 (3-lens review): the file walk itself (`collectNonTestTsSources`) is
 * the expensive part (~170 file reads under `src/`). It is memoized here so
 * that however many tests/call sites below need the comment-stripped source
 * set, the walk + strip happens ONCE per test-run, not once per call.
 */
let cachedStrippedSources: PuritySourceFile[] | undefined;
function strippedSources(): PuritySourceFile[] {
  if (!cachedStrippedSources) {
    cachedStrippedSources = collectNonTestTsSources(join(REPO_ROOT, 'src')).map((file) => ({
      ...file,
      content: stripComments(file.content),
    }));
  }
  return cachedStrippedSources;
}

function registeredCommandIds(): Set<string> {
  const files = strippedSources();
  const ids = new Set<string>();

  // Step 1: direct string-literal registrations — `registerCommand('hermes.x', ...)`.
  const literalPattern = /registerCommand\(\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    for (const match of file.content.matchAll(literalPattern)) {
      if (match[1]) ids.add(match[1]);
    }
  }

  // Step 2 (I-2 fix): identifiers actually passed to a real `registerCommand(...)`
  // call — e.g. `registerCommand(FIM_ACCEPT_COMMAND, ...)`.
  const identifierArgPattern = /registerCommand\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g;
  const referencedIdentifiers = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(identifierArgPattern)) {
      if (match[1]) referencedIdentifiers.add(match[1]);
    }
  }

  // Resolve ONLY those referenced identifiers through their `const` declaration —
  // a const that is never passed to registerCommand contributes nothing.
  const constDeclPattern = /(?:export )?const ([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    for (const match of file.content.matchAll(constDeclPattern)) {
      const name = match[1];
      const value = match[2];
      if (name && value && referencedIdentifiers.has(name) && value.startsWith('talaria.')) {
        ids.add(value);
      }
    }
  }

  return ids;
}

describe('LOCK: every declared command is registered somewhere under src/', () => {
  it('no contributes.commands entry lacks a registerCommand call', () => {
    const registered = registeredCommandIds();
    const missing = declaredCommandIds().filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });

  // M-1 (3-lens review): folded into this existing test rather than added as
  // a new `it` — a `contributes.commands: []` manifest would otherwise leave
  // the lock above vacuously green (zero entries to check, zero missing).
  // Combined with the non-vacuous scan check below, this also covers the
  // registered.has(...) sanity M-2 used to (badly) reprove separately.
  it('sanity: the scan is non-vacuous — manifest has commands, scan finds real registrations', () => {
    expect(declaredCommandIds().length).toBeGreaterThanOrEqual(15);

    const registered = registeredCommandIds();
    expect(registered.has('talaria.newSession')).toBe(true);
    expect(registered.has('talaria.acceptDiff')).toBe(true);
    expect(registered.has('talaria.generateCommitMessage')).toBe(true);
  });

  // M-2 (3-lens review): this file used to carry a third test here,
  // "RED-first proof: an id that is declared but absent from the scan set is
  // reported" — it built its own literal Set/array and asserted
  // `Array.prototype.filter` works, touching neither the manifest nor the
  // scan. It passed in every one of the reviewer's RED-producing mutations
  // (C-1, I-2, M-1) despite being named "RED-first proof" — a test that
  // cannot fail is worse than no test, because it stops anyone else from
  // looking. Deleted; the real RED-first plant is the reviewer's mutations
  // above, replayed against THIS implementation and recorded with actual
  // command output in `.superpowers/sdd/task-1-report.md`.
});
