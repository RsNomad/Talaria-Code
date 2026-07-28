/*
 * parseMentions — the PURE text -> ContextRef[] derivation (architecture doc
 * §2b "Insertion semantics deliberately differ and are NOT shared" / §7 A7:
 * a live side-array can desync from the visible prompt when the user edits a
 * token — silent-egress mismatch. Text is the single source of truth; refs
 * (and the `Pill` chips built from them) are a VIEW recomputed from the
 * draft on every change, never a tracked mutable array).
 *
 * Grammar (anchored to the six KNOWN kinds only, so an incidental `@word` in
 * prose never becomes a ref, and never silently attaches ambient workspace
 * data — git diff / terminal buffer / selection — to the outbound prompt):
 *  - LEADING BOUNDARY (security, I1): the `@` must sit at start-of-text or
 *    immediately after whitespace — `(?<=^|\s)`. This mirrors the live
 *    picker's `findTriggerStart` word-boundary rule (`useSuggest.ts`) and
 *    kills mid-word / email-local-part false positives, e.g. the `@git` in
 *    "admin@git.internal.corp" (preceded by "n", not whitespace/start).
 *  - `@problems` / `@selection` / `@terminal` / `@git` — SINGLETON refs,
 *    `{ id: <kind>, kind: <kind> }`. A singleton is a ref ONLY when followed
 *    by whitespace or end-of-text — `(?=\s|$)`. This is EXACTLY the shape
 *    the picker itself inserts (`pickMention` appends a trailing space) and
 *    is a deliberate security tightening over a bare `(?!\w)` guard: it also
 *    rejects dot-suffixed prose ("@terminal.app", "@problems.io") and
 *    Unicode-glued prose ("@gitämlich", "@terminalöffnung") that an
 *    ASCII-only `\w` boundary would miss, in one stroke. Trailing
 *    punctuation glued to a singleton ("@problems,") is therefore NO LONGER
 *    a ref — only whitespace/end terminates one now.
 *  - `@file:<path>` / `@folder:<path>` — PATH refs,
 *    `{ id: '<kind>:'+path, kind, path }`. `<path>` is either a
 *    double-quoted run (`"[^"]+"`, for space-containing paths — quotes are
 *    stripped before building `path`/`id`, I2) or, unquoted, the run of
 *    non-whitespace characters immediately after the colon. The colon is
 *    REQUIRED and the path must be non-empty (after quote-stripping):
 *    "@filename.txt" (no colon), "@file:"/"@file: " (colon, empty path), and
 *    `@file:""` (empty quoted path) are never refs.
 *  - Bare `@file` / `@folder` with no `:path` at all is NOT a ref — it only
 *    opens the composer's async submenu (see `Composer.tsx`/`useFileSearch`).
 *  - Duplicate tokens (same id) dedup to a single ref; order is deterministic
 *    — first appearance in the text.
 */
import type { ContextRef, ContextRefKind } from '../protocol';

// Leading boundary `(?<=^|\s)` (security, I1) — the `@` must sit at
// start-of-text or right after whitespace; kills mid-word/email-local-part
// false positives before either alternative below even gets a chance to run.
// Alternative 1: `@file:<path>` / `@folder:<path>` — the colon is mandatory,
// and the path is either a quoted `"[^"]+"` run (spaces allowed, I2) or a
// bare non-empty `\S+` run — so an incomplete/bare token never matches this
// branch.
// Alternative 2: `@problems` / `@selection` / `@terminal` / `@git` — must be
// followed by whitespace or end-of-text (mirrors the picker's own
// `@kind ` insertion shape; also rejects dot-suffixed/Unicode-glued prose in
// one stroke — stricter and simpler than an ASCII `\w`/Unicode `\p{L}`
// negative-lookahead guard). `file`/`folder` are deliberately absent here: a
// bare `@file`/`@folder` must produce NO ref at all, so it is only reachable
// via alternative 1.
// The `u` flag makes the lookbehind/lookahead boundary checks Unicode
// codepoint-correct. No nested quantifiers over overlapping character
// classes anywhere in the pattern — this is linear-time (no ReDoS).
const MENTION_TOKEN_RE =
  /(?<=^|\s)@(?:(?<pathKind>file|folder):(?<path>"[^"]+"|\S+)|(?<singleKind>problems|selection|terminal|git)(?=\s|$))/gu;

export function parseMentions(text: string): ContextRef[] {
  const refs = new Map<string, ContextRef>();

  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const groups = match.groups ?? {};
    if (groups.pathKind && groups.path) {
      const kind = groups.pathKind as ContextRefKind;
      const raw = groups.path;
      // Only strip quotes for a raw capture that is ACTUALLY a closed
      // quoted pair (length > 1 guards a lone `"` — e.g. an unterminated
      // `@file:"` at end-of-text — from collapsing to an empty path; that
      // lone quote is kept as a literal bare-path character instead, same
      // as the documented literal-quote residual below).
      const path =
        raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      // A quoted-empty path (`@file:""`) strips to '' — treat exactly like
      // any other empty path (never a ref), matching "@file:"/"@file: ".
      if (path) {
        const id = `${kind}:${path}`;
        if (!refs.has(id)) refs.set(id, { id, kind, path });
      }
    } else if (groups.singleKind) {
      const kind = groups.singleKind as ContextRefKind;
      if (!refs.has(kind)) refs.set(kind, { id: kind, kind });
    }
  }

  return [...refs.values()];
}

/**
 * formatMentionToken — the PURE inserter helper the composer's `@file`/
 * `@folder` pick handlers use to build an insertable token from a resolved
 * path (I2). Quotes the path (`@kind:"path with spaces" `) when it contains
 * whitespace, since the bare `\S+` grammar branch above truncates at the
 * first space; the quoted-path branch parses it back out with the quotes
 * stripped. Always appends the trailing space `pickMention`/singleton tokens
 * also use, so the inserted token is immediately a complete, re-parseable
 * ref the moment it lands in the textarea.
 *
 * Residual (documented, not fixed here): a path containing a literal `"`
 * cannot round-trip through the quoted-token grammar in v1 — the parser
 * would stop at the embedded quote. Such paths are vanishingly rare; this
 * is left as a known, narrow limitation rather than adding an escaping
 * layer now (see the parser's fallback-to-bare-path handling above).
 */
export function formatMentionToken(kind: 'file' | 'folder', path: string): string {
  return /\s/.test(path) ? `@${kind}:"${path}" ` : `@${kind}:${path} `;
}
