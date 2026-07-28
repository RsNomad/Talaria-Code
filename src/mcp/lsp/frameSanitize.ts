/**
 * W6 (LIB) · I-8 dedup — the frame-integrity sanitizer, extracted to a
 * single canonical, pure/headless module. Prior to this file, the exact
 * same control-char-strip + `</lsp_result>`-neutralization + total-cap
 * mechanics existed as TWO verbatim copies — one private to
 * `resultShaper.ts` (T5), one duplicated as `*_Local`-suffixed siblings in
 * `codeActionSerialize.ts` (T8a), kept in sync by a COMMENT only (3-way arch
 * review finding I-8: "a future edit to one copy that misses the other
 * silently weakens the anti-injection defense in half the tools"). Both
 * files now import from here instead of holding their own copy — the
 * comment-only sync obligation is replaced by the compiler.
 *
 * ## What this defends against
 * LIB frames every tool result as `<lsp_result id="…">…</lsp_result id="…">`
 * before handing it to Hermes. This is OUR convention: Hermes has no parser
 * for it (`grep -rn "lsp_result"` over its whole tree → 0 matches — verified
 * against `hermes-agent-2026.7.7.2/`, the read-only checkout, at write-time).
 * Hermes's own `reporter.py:30-63` solves the same problem differently — it
 * `html.escape`s every `<`/`>`/`&` in every field and frames with a different
 * tag (`<diagnostics …>`, `reporter.py:112`). We deliberately do NOT do that:
 * escaping everything would mangle `Vec<T>`, `a < b` and JSX in exactly the
 * code text this tool exists to show the model. Our equivalent strength comes
 * from the per-request nonce instead (see {@link mintFrameNonce}). Several
 * fields embedded inside that frame are attacker-influenceable even though
 * they are host-computed or LS-produced (filenames, symbol names, hover
 * markdown, diagnostic messages/source/code, an untrusted repo's own
 * content) — on Linux a filename may legally contain `<`, `>`, or a
 * newline. If one of those fields could smuggle a literal `</lsp_result>`
 * (or a lenient-parser variant of it) through unmodified, an untrusted repo
 * could fabricate a frame breakout and inject fresh "instructions" the agent
 * reads as if they came from LIB itself — classic indirect prompt injection
 * via tool output.
 *
 * ## Design, grounded against current guidance (Exa, 2026-07 — OWASP LLM
 * Prompt Injection Prevention Cheat Sheet; "Defending Against Prompt
 * Injection" (R. Hart, 2026-06); Microsoft's Spotlighting research)
 * The consensus mechanism for this exact problem is: wrap untrusted content
 * in delimiter tags, and **escape a literal occurrence of the closing tag in
 * the body so it can't terminate the boundary** — grounded in OWASP's
 * structured-prompt principle, "Use structured formats that clearly separate
 * instructions from user data"
 * (https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html,
 * re-verified 2026-07-26: the cheat sheet's CURRENT revision no longer
 * carries a verbatim "escape the closing tag" sentence — an earlier pull of
 * this header quoted one that is not present in the live page today. The
 * escaping technique below is this module's own deterministic
 * implementation of OWASP's separation principle, not a verbatim OWASP
 * instruction; this note does not weaken the mechanism — the threat model
 * stands independently on the per-request nonce ({@link mintFrameNonce})
 * plus this deterministic escape, not on the retired quote) and Hart's
 * nonce-delimiter piece ("XML-escape the body, so a literal `</user_input>`
 * in the content can't terminate the boundary"). {@link
 * neutralizeFrameDelimiters} below is exactly that escape step: it
 * HTML-escapes the leading `<` of every matched tag variant, which is what
 * makes the substring stop being the literal delimiter text without
 * corrupting the surrounding content. A prior version of this comment
 * claimed a second, ACCEPTED gap here — that the tag name/format was
 * fixed rather than a per-request nonce, because "a nonce would require a
 * protocol change outside this repo's authority". That was false (Audit
 * E-1, fabrication G-2) and it is the sentence that forbade the correct fix:
 * the tag is OURS, Hermes has never parsed it, and nothing outside this
 * directory needed to change. That gap is now CLOSED — see
 * {@link mintFrameNonce} and `resultShaper.ts`'s `frameLspResult`. One
 * residual, ACCEPTED property remains, out of scope for this
 * behavior-preserving dedup: this is a regex/escaping control, not a
 * semantic classifier — deterministic, type-1 defenses like this are
 * exactly the layer research continues to validate as the one that holds
 * under adaptive pressure (arXiv 2604.23887: "the only defense that held was
 * output filtering... enforced in application code, not by the model") —
 * this module IS that deterministic, model-independent enforcement point.
 *
 * ## Regex-sharing safety (Context7-grounded, MDN `String.prototype.replace`
 * / `RegExp.prototype[Symbol.replace]`): {@link FRAME_TAG_VARIANT_PATTERN}
 * and {@link CONTROL_CHAR_PATTERN} are `g`-flagged `RegExp` objects now
 * shared (imported) across two call sites. This is safe: `g`-flagged
 * `RegExp.prototype[Symbol.replace]` (the algorithm `String.prototype
 * .replace` delegates to for a RegExp pattern) resets `lastIndex` to 0
 * before scanning and always runs to completion, so no state leaks between
 * separate `.replace()` invocations from different call sites — unlike
 * `RegExp.prototype.test`/`.exec()` in a loop, which DO carry `lastIndex`
 * across calls on a shared `g`-flagged instance (irrelevant here: this
 * module's exports are only ever driven through `.replace()`, never
 * `.test()`/`.exec()`).
 *
 * ## Purity
 * No `vscode`/`fs` import — this file lives under `src/mcp/lsp/`, so the T4
 * static invariant lock (`lspInvariant.test.ts`) auto-discovers and scans it
 * (fs-import ban, vscode-import ban, mutation-verb bans) with zero changes
 * needed to that test.
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Control-character stripping
// ---------------------------------------------------------------------------

/** Every C0 control character plus DEL, EXCLUDING `\t` (kept — tabs are
 * common in code snippets and pose no framing risk) and excluding CR/LF
 * (a call-site concern: `resultShaper.sanitizeLsString` collapses CR/LF to a
 * single space BEFORE this pattern ever runs, while
 * `codeActionSerialize.neutralizePreservingNewlines` deliberately preserves
 * real CR/LF/tab in multi-line edit/preview payloads and never collapses
 * them at all). Matches the exact class: `\x00-\x08\x0B\x0C\x0E-\x1F\x7F`. */
export const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// ---------------------------------------------------------------------------
// Frame-tag neutralization — THE security function (I-8's namesake)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive, whitespace-tolerant frame-tag matcher: a zero-width
 * lookahead that matches every `<` whose right context could open an
 * `lsp_result`-shaped tag — `<`, an optional `/`, optional whitespace around
 * each token, `lsp_result`, then a word boundary (NOT a required closing
 * `>`). Each match is exactly the one `<` character; the lookahead itself
 * (`(?=…)`) is never consumed or included in the match (MDN, "Assertions":
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions/Assertions,
 * re-verified 2026-07-26 — "matches 'x' only if 'x' is followed by 'y' …
 * neither 'y' nor anything else is part of the match results").
 *
 * D4 (path-doc §5.4) REDESIGN — why `\b` replaces the old requirement of a
 * literal terminating `>`: the prior pattern
 * (`/<\s*\/?\s*lsp_result\s*>/gi`) only matched a FULLY CLOSED tag, so it
 * let three shapes through completely unescaped: attribute-bearing
 * (`</lsp_result id="deadbeef">`), unterminated (`<lsp_result id=` with no
 * `>` at all), and — most importantly — it broke this module's own
 * single-pass completeness proof on nested input: for `<lsp_result
 * <lsp_result>`, the old pattern matched only the INNER `<lsp_result>`,
 * leaving the OUTER `<lsp_result` raw and unescaped in the output (a
 * downstream lenient reader does not require a well-formed tag to treat
 * `<lsp_result` as a delimiter). The lookahead form has no such gap: it
 * requires nothing past the `\b` after `lsp_result`, so it matches every
 * frame-opening `<` regardless of what (if anything) follows — including
 * attribute-bearing and unterminated forms — and because matches are always
 * exactly 1 char (non-overlapping, no consumed lookahead text), a single
 * `.replace()` pass over `<lsp_result <lsp_result>` escapes BOTH `<`
 * characters in one scan (see {@link neutralizeFrameDelimiters}'s updated
 * completeness proof). `\b` still excludes `lsp_resulting` (a `<` there is
 * followed by two word characters — `t`, `i` — so no boundary exists,
 * exactly as the old pattern's implicit "must be followed by `>`, not more
 * letters" rejected it).
 *
 * There is no Hermes-side parser to be lenient or strict about
 * (`grep -rn "lsp_result"` over its whole tree → 0 matches — fabrication
 * G-1, Audit E-1: a prior version of this comment claimed Hermes's frame
 * parser was merely "build-blind"; there is no parser at all). The variants
 * are neutralized for two other reasons: a MODEL reading this text may
 * honour a sloppy variant as a delimiter regardless of what any parser
 * would do, and the nonce-bearing real tags (`resultShaper.ts`'s
 * `frameLspResult`) must remain the only `lsp_result`-shaped tags present in
 * the final output.
 */
export const FRAME_TAG_VARIANT_PATTERN = /<(?=\s*\/?\s*lsp_result\b)/gi;

/**
 * Delimiter-neutralization: HTML-escape every `<` that could open an
 * `lsp_result`-shaped tag (matched by {@link FRAME_TAG_VARIANT_PATTERN}),
 * preserving everything else in the string verbatim (case, internal
 * whitespace, attributes, and unterminated forms) — so `</lsp_result>`
 * becomes `&lt;/lsp_result>`, `</lsp_result id="x">` becomes
 * `&lt;/lsp_result id="x">`, and nested `<lsp_result <lsp_result>` becomes
 * `&lt;lsp_result &lt;lsp_result>`. A single regex `replace` pass, provably
 * terminating: each match is exactly the 1-char `<` (the lookahead is
 * zero-width and consumes nothing — MDN Assertions, ibid.), so the
 * replacement text is always `&lt;` followed by whatever followed the
 * matched `<` in the original string; it introduces no NEW `<` character and
 * removes exactly the one it consumed. No fixed-point iteration is required,
 * and — unlike a pattern that requires a literal closing `>` to match — no
 * adversarial nesting can leave one matched `<` shielding another: matches
 * are non-overlapping single characters covering every qualifying `<` in the
 * string in one left-to-right scan. After this call, the ONLY `<` characters
 * that can begin an `lsp_result`-shaped sequence anywhere in a shaper's
 * final output are the ones the shaper itself adds via `frameLspResult`
 * (`resultShaper.ts`). Total: never throws for any string, including `''`.
 */
export function neutralizeFrameDelimiters(s: string): string {
  return s.replace(FRAME_TAG_VARIANT_PATTERN, (match) => `&lt;${match.slice(1)}`);
}

// ---------------------------------------------------------------------------
// Per-request nonce — closes the join-created delimiter hole (Audit E-1)
// ---------------------------------------------------------------------------

/**
 * A fresh 16-hex-character label for ONE tool result's frame.
 *
 * Audit E-1 + fabrication G-2. The old fixed `<lsp_result>` tag was guessable
 * by construction, and the previous comment here claimed a nonce "would
 * require a protocol change outside this repo's authority". That was false and
 * it is what blocked the correct fix: `grep -rn "lsp_result"` over the ENTIRE
 * Hermes tree returns ZERO matches. We invented this tag; Hermes has never
 * parsed it and has no parser for it (fabrication G-1). Changing its shape is
 * a change to `src/mcp/lsp/` and nothing else — zero Hermes-core edits.
 *
 * Why a nonce closes the hole completely: the body is assembled from
 * language-server output derived from repository files. That content is
 * produced before this value exists and cannot contain it, so no repository
 * can forge the terminator. `node:crypto` is explicitly outside the
 * directory's import bans (see `lspInvariant.test.ts`'s FS_IMPORT_PATTERN
 * comment, which names `node:crypto` as non-matching).
 */
export function mintFrameNonce(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Cap helpers — shared truncation mechanics
// ---------------------------------------------------------------------------

/**
 * Clamps `n` to a non-negative finite integer, defaulting to 0 for
 * NaN/Infinity/negative input. Shared by every cap helper below — the
 * mechanism that makes every cap-consuming function total (never throws on
 * a malformed cap). Note: a cap of `Infinity` (or `NaN`) therefore clamps to
 * 0 — meaning "empty body", NOT "unlimited". This is deliberate fail-closed
 * behavior (a malformed cap should never be able to disable capping), not a
 * bug — do not change it.
 */
export function clampNonNegativeInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Truncates `s` to at most `cap` characters, appending `marker` when
 * truncation occurs. Total: any cap (including 0, negative, NaN, Infinity)
 * yields a result of length <= max(0, floor(cap)), never throws. When `cap`
 * is smaller than the marker itself, the result is a prefix of the marker
 * (never a mix of marker + content, so no accidental broken output).
 */
export function capWithMarker(s: string, cap: number, marker: string): string {
  const safeCap = clampNonNegativeInt(cap);
  if (s.length <= safeCap) {
    return s;
  }
  if (safeCap <= marker.length) {
    return marker.slice(0, safeCap);
  }
  return s.slice(0, safeCap - marker.length) + marker;
}

/**
 * Enforces an overall total cap over an assembled (pre-frame) body. Reuses
 * {@link capWithMarker} with a marker that reports the actual shown/total
 * character counts, e.g. `...(truncated, 100 of 4213 shown)`. `caps` takes
 * only the `{ total }` shape it needs (a minimal structural type, not the
 * full `ShaperCaps` interface) so this module stays free of any dependency
 * on `resultShaper.ts`'s types — any object with a numeric `total` field
 * (including a real `ShaperCaps`) satisfies it. Total: never throws.
 */
export function capTotalBody(body: string, caps: { readonly total: number }): string {
  const safeTotal = clampNonNegativeInt(caps.total);
  if (body.length <= safeTotal) {
    return body;
  }
  const marker = `...(truncated, ${safeTotal} of ${body.length} shown)`;
  return capWithMarker(body, safeTotal, marker);
}
