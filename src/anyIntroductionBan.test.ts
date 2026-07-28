import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectAllTsAndTsxSources, scanLines } from './host/purityScan';

/**
 * Closeout finding M-1 (CLOSEOUT-DECISIONS.md §3) — the `any`-introduction
 * BAN. `types.test-d.ts` brands `any` RED only on fields an assertion NAMES;
 * widening an UNASSERTED field to `any`, or writing `as any` in a function
 * body, moved NOTHING (verified: `AcpAvailableCommand.name: any` and an
 * `as any`-cast `update.content` access both left `check-types` at exit 0
 * and all counted locks green). This scan closes the introduction points
 * the type system cannot see, with BAN polarity (blind = spurious RED =
 * safe), raw text including comments and strings (a comment-stripping scan
 * is a hole: `/**\/ let x: any` hides code behind a leading block comment).
 *
 * WHAT IS BANNED: the token `any` in a type-introduction NEIGHBORHOOD —
 * an introducer before it (`:` `as` `=` `=>` `|` `&` `<` `,`) and a
 * code-follower after it (type-legal punctuation or end-of-line), plus the
 * double-assertion shape — `as`, then `any`, then a second `as`. English
 * prose ("any" followed by a word) and quoted prose (backtick follower)
 * never match — measured on the full pre-existing tree (before this file):
 * 415 files, 21 prose mentions of the patterns, 2 collisions total, both
 * reworded in this task's own commit (`gitPort.ts`, `SessionRegistry.ts`).
 *
 * WHAT IS NOT CAUGHT, deliberately on the record: a multi-line split
 * (`x:` newline `any`), an inline-comment split (`: /*c*\/ any`), and an
 * `any` imported from a dependency — obfuscation shapes owned by the diff
 * reader, same as every sibling scan's residual. Inside the modelled ACP
 * members, those residuals are additionally floored by the AnyKeysOf lock
 * in `types.test-d.ts` (RED if `any` LANDS in a top-level field, however
 * it was written).
 *
 * SELF-REFERENCE (found and fixed during implementation — not anticipated
 * by the spec that handed this file's content over verbatim): this file's
 * own positive battery, double-assertion example, and RED-first-proof
 * fixtures below MUST write literal examples of the exact shapes this ban
 * targets, to prove the pattern is non-vacuous. Unlike
 * `suppressionCommentBan.test.ts`'s ban (line-anchored, so its own
 * mid-line examples never qualify as a leading directive), THIS ban is
 * deliberately NOT anchored — `any` legitimately sits mid-line in real
 * code — so that sibling's "embed the example after other tokens" trick
 * does not save this file: writing the bare word `any` in those fixtures
 * self-triggered 20 offenders on this file's own on-disk text the first
 * time this test was run (pasted, with the two anticipated prose
 * collisions, in the closeout report's Step 4 section). Fix: a single
 * `ANY` constant + template-literal interpolation (`${ANY}`) below —
 * the RUNTIME STRING VALUE every assertion sees is byte-identical to the
 * literal shape (so what is tested is unchanged), while this file's own
 * SOURCE TEXT never contains the literal token adjacent to an introducer,
 * so it does not match itself. The regexes above are untouched, and any
 * OTHER `any` written into this file outside the interpolated fixtures is
 * still caught by the real lock below, same as every other file in the
 * tree.
 *
 * ZERO EXEMPTIONS. No allowlist (closed allowlists fail OPEN). If this
 * scan ever needs an exemption, the assertion below will say so by going
 * RED — never add a carve-out without an owner-approved reword (or, for
 * runtime test data, an interpolation) attempt first (all 2 historical
 * prose collisions were one-line rewords; this file's own 20 were closed
 * by interpolation, not by excluding the file from the scan).
 */

const SRC_ROOT = join(__dirname);
const WEBVIEW_SRC_ROOT = join(__dirname, '..', 'webview', 'src');

const ANY_INTRODUCTION_BAN = /(?::|\bas\b|=>?|\||&|<|,)\s*any\b\s*(?:[;,)\]}>=|&.!?:[{\/]|$)/;
const ANY_DOUBLE_ASSERTION_BAN = /\bas\s+any\s+as\b/;

/**
 * See the module doc's SELF-REFERENCE section. Interpolated into the
 * fixtures below so their RUNTIME string values stay exactly the literal
 * shape being tested, while this file's own SOURCE TEXT (what the "real
 * lock" test reads off disk) never spells the token next to an introducer.
 */
const ANY = 'any';

function collectBanScope() {
  const srcFiles = collectAllTsAndTsxSources(SRC_ROOT).map((f) => ({ ...f, file: `src/${f.file}` }));
  const webviewFiles = collectAllTsAndTsxSources(WEBVIEW_SRC_ROOT).map((f) => ({ ...f, file: `webview/src/${f.file}` }));
  return [...srcFiles, ...webviewFiles];
}

function findAnyIntroductions(files: readonly { file: string; absPath: string; content: string }[]) {
  return [...scanLines(files, ANY_INTRODUCTION_BAN), ...scanLines(files, ANY_DOUBLE_ASSERTION_BAN)];
}

describe('anyIntroductionBan — no `any` in type positions under src/ or webview/src/ (closeout M-1)', () => {
  it('reach: the walk discovers both trees INCLUDING .tsx, and the guard files themselves (non-vacuous)', () => {
    const files = collectBanScope();
    expect(files.length).toBeGreaterThan(350);
    expect(files.some((f) => f.file === 'src/anyIntroductionBan.test.ts')).toBe(true);
    expect(files.some((f) => f.file === 'src/host/backend/acp/types.test-d.ts')).toBe(true);
    expect(files.some((f) => f.file === 'webview/src/panels/SettingsPanel.tsx')).toBe(true);
  });

  it('no file introduces `any` in a type position (the real lock)', () => {
    expect(
      findAnyIntroductions(collectBanScope()),
      'An `any` type introduction was found. `any` disables checking for everything it touches and is ' +
        'invisible to every counted lock that does not NAME the widened field (closeout M-1: a widened ' +
        'unasserted field and an `as any` cast both left the whole gate green). Use `unknown` plus ' +
        'narrowing instead. If this is PROSE in a comment that collided with the pattern, reword the ' +
        'sentence (2 precedents: gitPort.ts, SessionRegistry.ts) — do NOT add an exemption.',
    ).toEqual([]);
  });

  it('the ban matches every real introduction shape (positive battery — proves the pattern is not vacuous)', () => {
    const shapes = [
      `const x: ${ANY} = 5;`,
      `function f(x: ${ANY}) {}`,
      `function g(): ${ANY} {`,
      `const y = z as ${ANY};`,
      `const w = (v as ${ANY}).prop;`,
      `const d = v as ${ANY} as SomeType;`,
      `const r: Record<string, ${ANY}> = {};`,
      `const c = <${ANY}>value;`,
      `type Loophole = ${ANY};`,
      `type Fn = (x: string) => ${ANY};`,
      `let arr: ${ANY}[] = [];`,
      `function h<T = ${ANY}>(x: T) {}`,
      `used: ${ANY};`,
      `used: number | ${ANY};`,
      `rawOutput: ${ANY},`,
      `  x: ${ANY}`,
    ];
    for (const shape of shapes) {
      expect(
        ANY_INTRODUCTION_BAN.test(shape) || ANY_DOUBLE_ASSERTION_BAN.test(shape),
        `pattern MISSED a real introduction shape (fail-open hole): ${shape}`,
      ).toBe(true);
    }
  });

  it('the ban does NOT match prose, quoted prose, or any*-identifiers (negative battery)', () => {
    const prose = [
      ' * Rule: any non-allowlisted file containing an egress call must',
      '/** Structural input: any object shaped like a snippet.',
      ' *    widened to `used: any` in `types.ts`, still reports green',
      '   * without it, same as any other backend that does not implement it).',
      "  it('does NOT treat an unrelated @handle as any kind of ref', () => {",
      'anyOf: string[]',
      'const many = 5;',
      'schema.anyOf;',
      'anywhere: true',
    ];
    for (const line of prose) {
      expect(
        ANY_INTRODUCTION_BAN.test(line) || ANY_DOUBLE_ASSERTION_BAN.test(line),
        `FALSE POSITIVE on prose: ${line}`,
      ).toBe(false);
    }
  });

  it('RED-first proof: an injected `: any` file trips the ban (in-memory, on the REAL collected list)', () => {
    const withViolation = [
      ...collectBanScope(),
      {
        file: 'src/host/backend/acp/__hypothetical_any_widening__.ts',
        absPath: '',
        content: `export type Probe = {\n  used: ${ANY};\n};\n`,
      },
    ];
    expect(findAnyIntroductions(withViolation).map((o) => o.file)).toContain(
      'src/host/backend/acp/__hypothetical_any_widening__.ts',
    );
  });

  it('RED-first proof: an injected double-assertion cast (`as` on both sides of `any`) also trips the ban', () => {
    const withViolation = [
      ...collectBanScope(),
      {
        file: 'webview/src/__hypothetical_double_assert__.tsx',
        absPath: '',
        content: `const launder = (value as ${ANY} as { verified: true });\n`,
      },
    ];
    expect(findAnyIntroductions(withViolation).map((o) => o.file)).toContain(
      'webview/src/__hypothetical_double_assert__.tsx',
    );
  });

  it('negative control: an injected file that only DISCUSSES any in prose is not flagged', () => {
    const withProse = [
      ...collectBanScope(),
      {
        file: 'src/__hypothetical_prose_only__.ts',
        absPath: '',
        content: '/**\n * Never widen a field to `any` here; any caller may break.\n */\nexport const ok = 1;\n',
      },
    ];
    expect(findAnyIntroductions(withProse).map((o) => o.file)).not.toContain('src/__hypothetical_prose_only__.ts');
  });
});
