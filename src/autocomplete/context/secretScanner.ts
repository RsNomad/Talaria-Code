/**
 * W5-T1 · the content secret scanner — the security spine of Wave 5 cross-file
 * autocomplete. Pure, zero-dependency, no `vscode`/`fs`/network. See
 * `docs/research/wave-5/00-architecture-and-paths.md` §3.3 for the design.
 *
 * `scanSnippetForSecrets` gates every cross-file snippet BEFORE it can enter
 * the ring buffer (T3 wires the choke point; this module is the pure unit it
 * calls). Verdict is binary reject-whole-snippet, never redact. `ruleId`
 * names the detector ONLY — the matched secret text must NEVER appear in the
 * verdict, a log, or a thrown message.
 */
// W6-FC (final-3way-arch.md I-6): import the pure classifier directly from
// `shared/secretPaths.ts` — this leaf was reaching up into `host/backend/
// policy` for no reason (the classifier itself has no host dependency).
import { isSecretForCompletion } from '../../shared/secretPaths';

export interface SecretScanInput {
  path: string;
  content: string;
}

export interface SecretScanVerdict {
  allowed: boolean;
  /** Which detector fired. For tests/telemetry ONLY — the matched TEXT is
   *  NEVER included anywhere. */
  ruleId?: string;
}

/**
 * Layer 2(a) — high-confidence provider-prefix patterns (gitleaks-grounded).
 * Precompiled at module load (no per-call `new RegExp`). Each has its OWN
 * `ruleId`; scanned in this fixed order over the WHOLE content (provider
 * prefixes are unambiguous, so no line-by-line scoping is needed here). First
 * match wins. `ruleId` names the detector only — never the matched text.
 */
interface ProviderDetector {
  readonly ruleId: string;
  readonly pattern: RegExp;
}

const PROVIDER_DETECTORS: readonly ProviderDetector[] = [
  { ruleId: 'pem', pattern: /-----BEGIN( [A-Z]+)? PRIVATE KEY-----/ },
  { ruleId: 'aws-akia', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  // W5-T1 FIX: AWS temporary access-key IDs (same shape as AKIA, distinct
  // ruleId — kept as a separate detector so the existing `aws-akia` fixtures
  // and ruleId are untouched).
  { ruleId: 'aws-asia', pattern: /\bASIA[0-9A-Z]{16}\b/ },
  { ruleId: 'github', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { ruleId: 'github', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { ruleId: 'stripe', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // W5-T1 FIX: broadened beyond xox[baprs]- to also cover xapp- (app-level)
  // and xoxe- (refresh) tokens. `x` factored out: x + (ox[baprs]|app|oxe) + "-".
  { ruleId: 'slack', pattern: /\bx(?:ox[baprs]|app|oxe)-[A-Za-z0-9-]{10,}\b/ },
  { ruleId: 'google-api', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { ruleId: 'openai-anthropic', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { ruleId: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { ruleId: 'cred-url', pattern: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]{1,64}:[^@\s]{6,}@/ },
];

/**
 * Shannon entropy of a string's character-frequency distribution:
 * `-Σ p_i log2 p_i`. Pure, module-local (exported for direct unit testing per
 * the brief). The empty string is defined as entropy 0 (no information).
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Layer 2(b) — the generic rule (gitleaks-grounded). Fires when, on a SINGLE
 * line:
 *  1. a secret keyword (`SECRET_KEYWORD_RE`) OR a suffix-anchored `_key\b`
 *     compound (`KEY_SUFFIX_RE`, closes access_key/signing_key/
 *     encryption_key/master_key/raw-hex private_key) is present — the
 *     line-level precondition (R8: entropy-alone-never-fires, FP-bounding);
 *  2. the line contains a secret-VALUE CANDIDATE — a maximal run of the
 *     secret charset `[A-Za-z0-9+/=_-]` (deliberately excludes `.` `(` `)`
 *     space `:` `;` `,` `"` `'` — these act as candidate boundaries) — that
 *     satisfies length + entropy, PLUS one of two mutually-exclusive
 *     conjuncts depending on whether the candidate sits inside a quoted
 *     string (see the "quoted-value exemption" doc block below).
 *
 * W5-T1 FIX (redesign, replaces the old "value right after an operator"
 * extractor): an independent adversarial review EMPIRICALLY confirmed two
 * defects sharing this one root cause —
 *  - F1 (LEAK): the old `ASSIGNMENT_VALUE_RE` captured only the ONE value
 *    immediately after the first operator, bare-token stopping at
 *    whitespace. `Authorization: Bearer <token>` captured the SCHEME WORD
 *    `Bearer` (len 6, below the length gate) and silently dropped the real
 *    secret after the space — never fired.
 *  - F3 (OVER-BLOCK): the same bare-token capture (`[^\s,;]+`, which does
 *    NOT stop at `.`/`(`/`)`) grabbed whole dotted/call-expression code
 *    (`req.headers.authorization`, `generateRandomIdentifier()`) whenever
 *    the FULL expression text happened to be ≥16 chars with entropy > 3.5.
 *
 * Scanning the WHOLE keyword-line for secret-charset runs — rather than
 * "the one value after an operator" — finds the real token regardless of
 * where it sits (closes F1) and naturally splits dotted/parenthesized code
 * expressions at their non-charset punctuation into short/pure-alpha pieces
 * that fail the length or digit/base64-special conjunct (closes F3). The
 * operator is no longer separately required: a keyword-line carrying a
 * high-entropy digit/base64 token IS the signal, with or without a literal
 * `=`/`:` — see `secretScanner.test.ts` for the RED/GREEN proof of both.
 *
 * W5-T1 FIX PASS 2 (Finding #2 — LEAK regression, the quoted-value
 * exemption): a second adversarial re-review EMPIRICALLY confirmed the
 * digit-or-base64-special conjunct (c) let ANY PURE-ALPHABETIC candidate
 * through regardless of entropy — `api_key = "abcdefGHIJKLmnopQRSTuvwx"`
 * (24 letters, entropy ≈ 4.585) returned `allowed: true`. This is a
 * REGRESSION vs. the pre-fix scanner, which captured quoted assignment
 * values with NO digit requirement and blocked it; conjunct (c) was added
 * (correctly) to exclude BARE unquoted code identifiers
 * (`req.headers.authorization`, `generateRandomIdentifier()`), but it
 * over-reached to quoted secret literals.
 *
 * The fix: a candidate now rejects the line when EITHER
 *  (a) it appears inside a quoted string (`"…"` / `'…'`) and satisfies
 *      length + entropy alone (no digit/base64-special requirement) — a
 *      quote is the signal that this is a literal VALUE, not a bare code
 *      expression, so entropy alone is enough to flag it; OR
 *  (b) it is a BARE (unquoted) run that satisfies length + entropy AND
 *      still contains a digit or base64-special char — unchanged from FIX
 *      PASS 1, and still what keeps plain camelCase/dotted identifiers from
 *      over-blocking (the F3 fix stays closed).
 * Extraction: quoted spans are found first (`QUOTED_VALUE_RE`); each
 * quoted value's secret-charset runs are checked under (a). The quoted
 * spans (including their quote marks) are then masked out of the line with
 * spaces before scanning the remainder for bare candidates under (b) — this
 * guarantees a candidate is evaluated under exactly ONE of the two
 * conjuncts, never both, and that quoted content never leaks into the bare
 * scan. See `secretScanner.test.ts` ("FIX PASS 2, Finding #2") for the
 * RED/GREEN proof and the full block/allow separation matrix.
 */
const SECRET_KEYWORD_RE = /(api[_-]?key|apikey|secret|token|passwd|password|pwd|credential|auth)/i;
const KEY_SUFFIX_RE = /[a-z0-9_]*_key\b/i;

const GENERIC_MIN_VALUE_LENGTH = 16;
const GENERIC_ENTROPY_THRESHOLD = 3.5;

/** Maximal runs of the secret charset, length >= GENERIC_MIN_VALUE_LENGTH
 *  (the `{n,}` quantifier already enforces the length conjunct at match
 *  time — a shorter run simply never matches). Global — a string may carry
 *  more than one candidate. Precompiled once at module load; every call
 *  site resets `.lastIndex = 0` before use (see below) so reuse across the
 *  quoted-value and bare-line scans below is safe. */
const SECRET_CANDIDATE_RE = new RegExp(`[A-Za-z0-9+/=_-]{${GENERIC_MIN_VALUE_LENGTH},}`, 'g');

/** Condition (c) — bare-path only: at least one digit or base64-special
 *  character. */
const DIGIT_OR_BASE64_SPECIAL_RE = /[0-9+/=]/;

/** W5-T1 FIX PASS 2 — matches quoted string literals (`"…"` or `'…'`) on a
 *  line. Used to (a) extract quoted VALUES for the quote exemption and
 *  (b) mask quoted spans out of the line before the bare-candidate scan.
 *  Linear-time (no nested quantifiers) — safe under the per-line length
 *  bound. Precompiled once at module load. */
const QUOTED_VALUE_RE = /"([^"]*)"|'([^']*)'/g;

function lineHasSecretKeyword(line: string): boolean {
  return SECRET_KEYWORD_RE.test(line) || KEY_SUFFIX_RE.test(line);
}

/** (a) quoted-value candidate check: length + entropy only, NO digit/
 *  base64-special requirement — a quote is what marks this as a literal
 *  value rather than a bare code expression. */
function quotedValueHasCandidate(quotedValue: string): boolean {
  SECRET_CANDIDATE_RE.lastIndex = 0; // stateful global regex — reset before each scan
  let match: RegExpExecArray | null;
  while ((match = SECRET_CANDIDATE_RE.exec(quotedValue)) !== null) {
    if (shannonEntropy(match[0]) > GENERIC_ENTROPY_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/** (b) bare (unquoted) candidate check: length + entropy + digit/base64-
 *  special, unchanged from FIX PASS 1 — this is what excludes plain
 *  camelCase/dotted code identifiers. */
function bareLineHasCandidate(bareLine: string): boolean {
  SECRET_CANDIDATE_RE.lastIndex = 0; // stateful global regex — reset before each scan
  let match: RegExpExecArray | null;
  while ((match = SECRET_CANDIDATE_RE.exec(bareLine)) !== null) {
    const candidate = match[0];
    if (
      shannonEntropy(candidate) > GENERIC_ENTROPY_THRESHOLD &&
      DIGIT_OR_BASE64_SPECIAL_RE.test(candidate)
    ) {
      return true;
    }
  }
  return false;
}

/** True if `line` contains at least one secret-value candidate satisfying
 *  EITHER the quoted-value conjunct (a) or the bare conjunct (b) — see the
 *  "quoted-value exemption" doc block above `SECRET_KEYWORD_RE`. */
function lineHasSecretCandidate(line: string): boolean {
  QUOTED_VALUE_RE.lastIndex = 0; // stateful global regex — reset before each scan
  const quotedSpans: Array<{ start: number; end: number; value: string }> = [];
  let quotedMatch: RegExpExecArray | null;
  while ((quotedMatch = QUOTED_VALUE_RE.exec(line)) !== null) {
    const value = quotedMatch[1] ?? quotedMatch[2] ?? '';
    quotedSpans.push({
      start: quotedMatch.index,
      end: quotedMatch.index + quotedMatch[0].length,
      value,
    });
  }

  // (a) — check each quoted value's contents first.
  for (const span of quotedSpans) {
    if (quotedValueHasCandidate(span.value)) {
      return true;
    }
  }

  // (b) — mask every quoted span (quote marks included) out of the line
  // with spaces (space is not in the secret charset, so it acts as a
  // boundary) before scanning the remainder. Masking preserves string
  // length, so every span's precomputed [start, end) offset stays valid
  // regardless of how many spans have already been masked.
  let bareLine = line;
  for (const span of quotedSpans) {
    bareLine = bareLine.slice(0, span.start) + ' '.repeat(span.end - span.start) + bareLine.slice(span.end);
  }
  return bareLineHasCandidate(bareLine);
}

function lineMatchesGenericConjunction(line: string): boolean {
  // W5-T1 FIX PASS 2 (Finding #1): the oversized-line bound is now enforced
  // once, fail-CLOSED, over the WHOLE content in `scanSnippetForSecrets`
  // (`contentHasOversizedLine`) BEFORE this function is ever called — so by
  // the time a line reaches here it is already guaranteed <= MAX_SCAN_LINE.
  // This preserves the original DoS defense-in-depth rationale for the
  // bound (no regex touches a line before its cheap `.length` is checked)
  // while fixing the fail-OPEN leak: a line that WOULD have exceeded the
  // bound no longer reaches this function at all — the whole snippet is
  // rejected instead of the line being silently skipped.
  if (!lineHasSecretKeyword(line)) {
    return false;
  }
  return lineHasSecretCandidate(line);
}

/** (b) is evaluated line-by-line (per the brief) — a keyword on one line and a
 *  high-entropy assignment on another must NOT combine. */
function contentMatchesGenericConjunction(content: string): boolean {
  return content.split(/\r?\n/).some(lineMatchesGenericConjunction);
}

/**
 * W5-T1 FIX (Finding 2 — DoS): a benign 200 KB single line (long number
 * literal / minified JS, no keyword) froze the scanner ~2 min pre-fix. Root
 * cause: unanchored regexes with a greedy class + zero-width `\b` (e.g.
 * `KEY_SUFFIX_RE = /[a-z0-9_]*_key\b/i`) exhibit O(n²) backtracking on a huge
 * homogeneous run that never contains the literal suffix being searched for
 * — confirmed empirically (local RED-proof measurement, same regex shape:
 * 40k chars → 643ms, 80k → 2564ms, 160k → 10297ms; clean quadratic scaling,
 * ~4x time per 2x size). T3's fail-closed wrapper only catches THROWS, not a
 * CPU spin, so the guard must live in the scanner itself. Production
 * snippets are ≤500 chars (T3's budgeter caps them) — content over
 * `MAX_SCAN_CONTENT` is anomalous; dropping it is safe (fail-closed, never
 * leaks) even though it starves context for that one (anomalous) snippet.
 */
const MAX_SCAN_CONTENT = 16_000;
/**
 * Defense-in-depth per-line bound for the generic scan — keeps total work
 * O(n) with a small constant even for a single very long line still under
 * MAX_SCAN_CONTENT.
 *
 * W5-T1 FIX PASS 2 (Finding #1 — LEAK regression): this bound used to be
 * enforced by SKIPPING (fail-OPEN) any line over the limit inside
 * `lineMatchesGenericConjunction`, i.e. the generic scan silently continued
 * without that line — so a secret sharing a line with >2000 chars of
 * surrounding text (common in minified/bundled/vendored files) evaded the
 * ONLY detector for the non-provider bearer/basic class. A second
 * adversarial re-review EMPIRICALLY confirmed this leak. The bound is now
 * enforced fail-CLOSED, once, over the WHOLE content — see
 * `contentHasOversizedLine` and its use in `scanSnippetForSecrets`
 * (`ruleId: 'oversized-line'`) — consistent with `MAX_SCAN_CONTENT` above,
 * which already failed closed. Checking `line.length` is O(1) per line and
 * happens BEFORE any regex runs, so the original DoS defense-in-depth
 * rationale for the bound is preserved.
 */
const MAX_SCAN_LINE = 2_000;

/** W5-T1 FIX PASS 2 — true if ANY line in `content` (split by `/\r?\n/`)
 *  exceeds `MAX_SCAN_LINE`. Checked once, before the generic scan runs, so
 *  the whole snippet can be rejected fail-CLOSED instead of silently
 *  skipping the offending line. */
function contentHasOversizedLine(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.length > MAX_SCAN_LINE);
}

/**
 * Layer 1 (path) + Layer 2 (content) secret gate for a cross-file snippet.
 * Layer 1 REUSES `isSecretForCompletion` from `shared/secretPaths.ts` (no
 * re-implemented path classification). Layer 2(a) provider patterns are
 * checked before Layer 2(b)'s generic conjunction rule — the first detector
 * to fire wins.
 */
export function scanSnippetForSecrets(input: SecretScanInput): SecretScanVerdict {
  // F2 guard (DoS) — checked FIRST, before ANY regex runs, so it bounds every
  // downstream code path (path/providers/generic) uniformly.
  if (input.content.length > MAX_SCAN_CONTENT) {
    return { allowed: false, ruleId: 'oversized' };
  }

  // Layer 1 — path. Normalize `\\` → `/` exactly as `provider.ts:62`, then
  // reuse the single path classifier (no drift between the two call sites).
  const normalizedPath = input.path.replace(/\\/g, '/');
  if (isSecretForCompletion(normalizedPath)) {
    return { allowed: false, ruleId: 'path' };
  }

  // Layer 2(a) — provider-prefix patterns, whole content, first match wins.
  // Providers scan the WHOLE content regardless of line length — they are
  // already bounded by MAX_SCAN_CONTENT above and catch prefixed secrets on
  // long lines regardless of the per-line bound below.
  for (const detector of PROVIDER_DETECTORS) {
    if (detector.pattern.test(input.content)) {
      return { allowed: false, ruleId: detector.ruleId };
    }
  }

  // W5-T1 FIX PASS 2 (Finding #1) — fail-CLOSED per-line guard: the generic
  // scan (Layer 2(b), below) is the ONLY detector for the non-provider
  // bearer/basic class, so an over-long line must reject the whole snippet
  // rather than be silently skipped. See `contentHasOversizedLine` and
  // `MAX_SCAN_LINE` above for the full rationale.
  if (contentHasOversizedLine(input.content)) {
    return { allowed: false, ruleId: 'oversized-line' };
  }

  // Layer 2(b) — generic conjunction rule.
  if (contentMatchesGenericConjunction(input.content)) {
    return { allowed: false, ruleId: 'generic' };
  }

  return { allowed: true };
}
