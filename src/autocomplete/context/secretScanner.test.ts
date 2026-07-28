import { describe, it, expect } from 'vitest';
import { shannonEntropy, scanSnippetForSecrets } from './secretScanner';

/**
 * W5-T1 · the content secret scanner — entropy helper tests.
 * `shannonEntropy(s) = -Σ p_i log2 p_i` over the character-frequency
 * distribution of `s`. Tested directly per the brief (§ "Entropy helper"):
 * all-same-char → 0, uniform-random-ish → high, a known small string → a
 * pinned value.
 */
describe('shannonEntropy', () => {
  it('returns 0 for an all-same-character string', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  it('returns 0 for a single character', () => {
    expect(shannonEntropy('a')).toBe(0);
  });

  it('returns 0 for the empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns a high value for a uniform-random-ish string', () => {
    // 16 distinct hex-ish characters, each appearing once: uniform
    // distribution over 16 symbols → entropy should approach log2(16) = 4.
    expect(shannonEntropy('0123456789abcdef')).toBeCloseTo(4, 5);
  });

  it('pins a known small string to its exact computed value', () => {
    // "aabb": 2 symbols, each with p=0.5 → entropy = -2*(0.5*log2(0.5)) = 1.
    expect(shannonEntropy('aabb')).toBe(1);
  });

  it('pins a second known string with an uneven distribution', () => {
    // "aaab": 'a' p=0.75, 'b' p=0.25.
    // entropy = -(0.75*log2(0.75) + 0.25*log2(0.25))
    const expected = -(0.75 * Math.log2(0.75) + 0.25 * Math.log2(0.25));
    expect(shannonEntropy('aaab')).toBeCloseTo(expected, 10);
  });

  it('is order-independent (permutation of the same multiset yields the same entropy)', () => {
    expect(shannonEntropy('aabbcc')).toBe(shannonEntropy('abcabc'));
  });
});

/**
 * Layer 1 — path. REUSES `isSecretForCompletion` (`shared/secretPaths.ts`,
 * W6-FC); the scanner's only job is `\\` → `/` normalization (mirroring
 * `provider.ts:62`) before delegating. Content is irrelevant when the path
 * layer fires — rejection happens pre-content.
 */
describe('scanSnippetForSecrets — Layer 1 (path)', () => {
  const benignContent = 'export function add(a: number, b: number) { return a + b; }';

  it('rejects a .env path with ruleId "path"', () => {
    expect(scanSnippetForSecrets({ path: '.env', content: benignContent })).toEqual({
      allowed: false,
      ruleId: 'path',
    });
  });

  it('rejects an id_rsa path', () => {
    expect(scanSnippetForSecrets({ path: 'home/user/.ssh/id_rsa', content: benignContent })).toEqual({
      allowed: false,
      ruleId: 'path',
    });
  });

  it('rejects a foo.pem path', () => {
    expect(scanSnippetForSecrets({ path: 'certs/foo.pem', content: benignContent })).toEqual({
      allowed: false,
      ruleId: 'path',
    });
  });

  it('rejects a .aws/credentials path', () => {
    expect(scanSnippetForSecrets({ path: '.aws/credentials', content: benignContent })).toEqual({
      allowed: false,
      ruleId: 'path',
    });
  });

  it('rejects a case-variant path (.ENV)', () => {
    expect(scanSnippetForSecrets({ path: 'config/.ENV', content: benignContent })).toEqual({
      allowed: false,
      ruleId: 'path',
    });
  });

  it('rejects a case-variant path (ID_RSA)', () => {
    expect(scanSnippetForSecrets({ path: 'keys/ID_RSA', content: benignContent })).toEqual({
      allowed: false,
      ruleId: 'path',
    });
  });

  it('rejects a backslash (Windows-style) path by normalizing before classification', () => {
    expect(
      scanSnippetForSecrets({ path: 'src\\config\\.env', content: benignContent }),
    ).toEqual({ allowed: false, ruleId: 'path' });
  });

  it('rejects a backslash .aws\\credentials path', () => {
    expect(
      scanSnippetForSecrets({ path: '.aws\\credentials', content: benignContent }),
    ).toEqual({ allowed: false, ruleId: 'path' });
  });

  it('allows a benign path with benign content', () => {
    expect(scanSnippetForSecrets({ path: 'src/utils/math.ts', content: benignContent })).toEqual({
      allowed: true,
    });
  });
});

/**
 * Layer 2(a) — high-confidence provider-prefix detectors. One TDD red-green
 * cycle per detector (brief §3.5): each TP fixture is added and proven to
 * fail against the scanner BEFORE that detector's regex exists, then proven
 * to pass once it is added. Benign path throughout — only content differs.
 */
describe('scanSnippetForSecrets — Layer 2(a) provider-prefix detectors', () => {
  const p = 'src/config.ts';

  it('rejects a PEM private-key block with ruleId "pem"', () => {
    const content = [
      'const key = `',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj',
      '-----END PRIVATE KEY-----',
      '`;',
    ].join('\n');
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'pem' });
  });

  it('rejects an RSA PEM private-key block header variant', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'pem' });
  });

  it('rejects an AWS access key id with ruleId "aws-akia"', () => {
    const content = 'const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'aws-akia' });
  });

  it('rejects a GitHub personal access token (ghp_) with ruleId "github"', () => {
    const content = 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz12";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'github' });
  });

  it('rejects a GitHub fine-grained token (github_pat_) with ruleId "github"', () => {
    const content = 'const token = "github_pat_11ABCDEFG0123456789012_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'github' });
  });

  it('rejects a Stripe secret key with ruleId "stripe"', () => {
    const content = 'const STRIPE_KEY = "sk_live_4eC39HqLyjWDarjtT1zdp7dc";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'stripe' });
  });

  it('rejects a Stripe test secret key too', () => {
    const content = 'const STRIPE_KEY = "sk_test_4eC39HqLyjWDarjtT1zdp7dc";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'stripe' });
  });

  it('rejects a Slack bot token with ruleId "slack"', () => {
    const content = 'const SLACK_TOKEN = "xoxb-1234567890-abcdefghijklmnopqrst";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'slack' });
  });

  it('rejects a Google API key with ruleId "google-api"', () => {
    const content = 'const GOOGLE_KEY = "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'google-api' });
  });

  it('rejects an Anthropic-style secret key with ruleId "openai-anthropic"', () => {
    const content = 'const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'openai-anthropic' });
  });

  it('rejects an OpenAI-style secret key too', () => {
    const content = 'const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'openai-anthropic' });
  });

  it('rejects a JWT with ruleId "jwt"', () => {
    const content =
      'const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'jwt' });
  });

  it('rejects a credentialed URL with ruleId "cred-url"', () => {
    const content = 'const DB_URL = "postgres://admin:sup3rSecretPass@db.internal.example.com:5432/prod";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'cred-url' });
  });

  it('provider patterns win over the generic rule (order: providers before generic)', () => {
    // Also satisfies the generic conjunction (keyword "key" + "=" + len>=16 +
    // high entropy) but the AKIA provider pattern must fire first.
    const content = 'const api_key = "AKIAIOSFODNN7EXAMPLE";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'aws-akia' });
  });
});

/**
 * Layer 2(b) — the generic conjunction rule (`ruleId: 'generic'`). Fires ONLY
 * when a secret keyword is present on the line AND the line carries a
 * secret-value candidate (length ≥ 16 ∧ Shannon entropy > 3.5 ∧ contains a
 * digit or base64-special char). Entropy values below are pre-computed and
 * pinned (see scratch verification) so fixtures are not accidentally
 * mis-classified by construction.
 */
describe('scanSnippetForSecrets — Layer 2(b) generic conjunction rule', () => {
  const p = 'src/config.ts';
  // 32-char mixed-case-alnum, entropy ≈ 4.938 (> 3.5).
  const HIGH_ENTROPY_32 = 'aB3xQ9zM1kP7wRtY0sLf8nJc2hV5dGq1';
  // 20-char mixed-case-alnum, entropy ≈ 4.322 (> 3.5).
  const HIGH_ENTROPY_20 = 'aB3xQ9zM1kP7wRtY0sLf';

  it('rejects generic API_KEY = "<high-entropy-32>" with ruleId "generic"', () => {
    const content = `const API_KEY = "${HIGH_ENTROPY_32}";`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('rejects encryption_key = "<high-entropy>" via the `_key\\b` suffix keyword', () => {
    const content = `const encryption_key = "${HIGH_ENTROPY_20}";`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('rejects a signing_key assignment (another `_key\\b` compound)', () => {
    const content = `signing_key: "${HIGH_ENTROPY_20}"`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('rejects a master_key assignment', () => {
    const content = `master_key = '${HIGH_ENTROPY_20}'`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('fires across multiple lines when only one line satisfies the conjunction', () => {
    const content = [
      'function unrelated() { return 1; }',
      `const api_key = "${HIGH_ENTROPY_32}";`,
      'export const x = 5;',
    ].join('\n');
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  // ---- False positives: the exact corpus + conjunction-discipline required by the brief ----

  it('allows cache_key = "user:profile:v2" (brief fixture — keyword without triggering the conjunction)', () => {
    const content = 'const cache_key = "user:profile:v2";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows const TOKEN_KINDS = [\'a\',\'b\'] (keyword present, no secret value)', () => {
    const content = "const TOKEN_KINDS = ['a','b'];";
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows password = "changeme" (len 8 < 16 — explicit low-entropy-by-length test)', () => {
    const content = 'const password = "changeme";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows a high-entropy value WITHOUT a keyword (a hash assigned to checksum)', () => {
    // entropy ≈ 3.786 (> 3.5), but "checksum"/"digest" is not a secret keyword.
    const content =
      'const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows sha256/sha512 hex digests generally', () => {
    const content =
      'const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows lockfile integrity hashes', () => {
    const content = '"integrity": "sha512-oqVHZ8vaXWpLD3ZKKCZKp0KQEqZzHFbQFV+p0vP0nUgB=="';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows UUIDs', () => {
    const content = 'const id = "550e8400-e29b-41d4-a716-446655440000";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows base64-encoded JSON test fixtures', () => {
    const content = 'const FIXTURE = "eyJuYW1lIjoiQWxpY2UiLCJyb2xlIjoiYWRtaW4ifQ==";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows lorem ipsum', () => {
    const content =
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows minified JS lines', () => {
    const content =
      'function _0x4a2f(a,b,c){return a?b:c}var $a=_0x4a2f(1,2,3),$b=$a+1;if($b>10){console.log($b)}';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  // ---- Conjunction-dimension isolation: each sub-condition tested independently ----

  it('conjunction dimension: keyword ∧ length ∧ digit/base64-special, NOT entropy → allowed', () => {
    // entropy = 0 (all one char); proves entropy alone (well, its absence)
    // gates the rule even when every other predicate holds.
    const content = 'const api_key = "aaaaaaaaaaaaaaaa";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('conjunction dimension: keyword ∧ entropy, NOT length (< 16) → allowed', () => {
    // 10 chars, entropy ≈ 3.322 (irrelevant — length gate fails first).
    const content = 'const api_key = "aB3xQ9zM1k";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('conjunction dimension: length ∧ entropy ∧ digit/base64-special, NOT keyword → allowed (entropy alone never fires)', () => {
    const content = `const checksum = "${HIGH_ENTROPY_32}";`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('W5-T1 FIX (F1): keyword present, NO operator anywhere on the line → now BLOCKED', () => {
    // Superseded by the fix-brief redesign: this used to assert `allowed:
    // true` under the OLD design, which required an operator (`=>`/`->`/
    // `[:=]`) to extract a candidate value at all. That is EXACTLY the F1
    // leak mechanism — `Authorization: Bearer <token>` has a keyword but no
    // `=`-style assignment, and the old extractor silently produced no
    // usable candidate for lines shaped like this. The redesigned generic
    // rule scans the WHOLE keyword-line for secret-charset runs regardless
    // of any operator, so a keyword-line carrying a high-entropy token with
    // a digit/base64-special now blocks correctly. See the new dimension-D
    // test below (`NOT digit/base64-special → allowed`) for the isolation
    // case this scenario used to (mis)represent.
    const content = `// api_key rotation reminder ${HIGH_ENTROPY_32}`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('W5-T1 FIX PASS 2 (F2): quoted pure-alpha high-entropy value now BLOCKED (quoted-value exemption)', () => {
    // SUPERSEDED by the FIX PASS 2 quoted-value exemption: this fixture is a
    // QUOTED pure-alpha value (22 chars, entropy ≈ 4.459, no digit/base64
    // special). Under the earlier (post-F3) design this was intentionally
    // allowed to avoid over-blocking bare code identifiers, but a second
    // adversarial re-review EMPIRICALLY confirmed that same "no digit
    // required" leniency let a QUOTED pure-alpha secret evade entirely
    // (fix2-brief Finding #2, LEAK regression). The fix: a candidate INSIDE
    // quotes now rejects on length + entropy alone (no digit requirement);
    // only a BARE (unquoted) candidate still needs the digit/base64-special
    // conjunct. See the bare/unquoted sibling test directly below for the
    // digit-dimension isolation this test used to (mis)represent.
    const PURE_ALPHA_HIGH_ENTROPY_22 = 'qXzKpLmWvTsBnHgYcRfDoP';
    const content = `const api_key = "${PURE_ALPHA_HIGH_ENTROPY_22}";`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('conjunction dimension (bare/unquoted): keyword ∧ length ∧ entropy, NOT digit/base64-special, NOT quoted → allowed', () => {
    // The UNQUOTED sibling of the test above — same pure-alpha high-entropy
    // value, no surrounding quotes. This is the real digit-dimension
    // isolation case post-FIX-PASS-2: a BARE secret-charset run still
    // requires a digit/base64-special to reject — this is what prevents the
    // F3 identifier false-positive flood (`getApiKeyForTenant`-shaped bare
    // expressions must not block).
    const PURE_ALPHA_HIGH_ENTROPY_22 = 'qXzKpLmWvTsBnHgYcRfDoP';
    const content = `const api_key = ${PURE_ALPHA_HIGH_ENTROPY_22};`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('entropy-alone-never-fires: a bare high-entropy token with no keyword and no operator anywhere → allowed', () => {
    const content = HIGH_ENTROPY_32;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('keyword and high-entropy value on DIFFERENT lines never combine (per-line conjunction only)', () => {
    const content = ['const api_key = 1;', `const other = "${HIGH_ENTROPY_32}";`].join('\n');
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });
});

/**
 * W5-T1 FIX · Finding 1 (LEAK) — an independent adversarial review EMPIRICALLY
 * confirmed that `Authorization: Bearer <token>` (and shape variants) egress:
 * the OLD `ASSIGNMENT_VALUE_RE` captured the scheme word `Bearer` (len 6,
 * below `GENERIC_MIN_VALUE_LENGTH`) as "the" value and silently dropped the
 * real secret after the space, so the generic conjunction never fired. The
 * redesigned extractor scans the whole keyword-line for secret-charset runs
 * instead of "the one value after an operator", so it finds the ACTUAL token
 * regardless of where on the line it sits. All four fixtures below reuse the
 * exact 64-char hex digest already pinned elsewhere in this file (entropy ≈
 * 3.786 — see the "digest"/"checksum" fixtures above) so entropy correctness
 * is not re-litigated per fixture.
 */
describe('scanSnippetForSecrets — W5-T1 FIX F1: bearer/basic-auth leak (value-extractor redesign)', () => {
  const p = 'src/config.ts';
  const HEX_TOKEN =
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  it('blocks a plain "Authorization: Bearer <hex-token>" header line', () => {
    const content = `Authorization: Bearer ${HEX_TOKEN}`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('blocks a base64 "Authorization: Basic <token>" header line', () => {
    // Base64-encoded "admin:password1234567890abcdef" — contains digits, so
    // the digit-or-base64-special conjunct is satisfied independent of `=`
    // padding.
    const content = 'Authorization: Basic YWRtaW46cGFzc3dvcmQxMjM0NTY3ODkwYWJjZGVm';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('blocks a quoted curl -H "Authorization: Bearer <token>" invocation', () => {
    const content = `curl -H "Authorization: Bearer ${HEX_TOKEN}"`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('blocks a bare (unquoted) env-var-style header assignment', () => {
    // Unlike the quoted forms above, the OLD `ASSIGNMENT_VALUE_RE` bare-token
    // alternative `[^\s,;]+` stops at the first whitespace — this is the
    // exact shape that captured only "Bearer" (len 6) and silently dropped
    // the token, since there is no surrounding quote to make the whole
    // "Bearer <token>" span a single capture.
    const content = `AUTHORIZATION=Bearer ${HEX_TOKEN}`;
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });
});

/**
 * W5-T1 FIX · Finding 3 (OVER-BLOCK) — the SAME root cause as F1 (bare-token
 * capture via `[^\s,;]+`) also grabbed dotted/parenthesized code expressions
 * whose FULL text happened to be ≥16 chars with entropy > 3.5, starving
 * legitimate cross-file context. The redesigned extractor treats `.`, `(`,
 * `)`, and whitespace as candidate boundaries (they are not in the secret
 * charset `[A-Za-z0-9+/=_-]`), so dotted paths and call expressions split
 * into short/pure-alpha pieces that fail length or the digit/base64-special
 * conjunct.
 */
describe('scanSnippetForSecrets — W5-T1 FIX F3: code-expression over-block (value-extractor redesign)', () => {
  const p = 'src/config.ts';

  it('allows req.headers.authorization (dotted path splits below length 16)', () => {
    const content = 'const token = req.headers.authorization;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows user.credentials.hashedPassword (dotted path splits below length 16)', () => {
    const content = 'const secret = user.credentials.hashedPassword;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows HttpHeaders.AUTHORIZATION_BEARER (pure alpha/underscore — no digit/base64-special)', () => {
    const content = 'const authHeader = HttpHeaders.AUTHORIZATION_BEARER;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows process.env.MY_SECRET_VALUE_NAME (20-char pure [A-Z_] — no digit/base64-special)', () => {
    const content = 'const secretRef = process.env.MY_SECRET_VALUE_NAME;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows config.getApiKeyForTenant(tenantId) (paren-split, pure-alpha callee)', () => {
    const content = 'const apiKey = config.getApiKeyForTenant(tenantId);';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows buildCredentialObjectFromEnv() (paren-split, pure-alpha callee)', () => {
    const content = 'const credential = buildCredentialObjectFromEnv();';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('allows generateRandomIdentifier() (paren-split, pure-alpha callee)', () => {
    const content = 'const secret = generateRandomIdentifier();';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });
});

/**
 * W5-T1 FIX · Finding 2 (DoS) — a benign 200 KB single line (long number
 * literal / minified JS) froze the scanner ~2 min pre-fix: the unanchored
 * `KEY_SUFFIX_RE = /[a-z0-9_]*_key\b/i` (greedy class + zero-width `\b`,
 * with NO "_key" substring anywhere in a huge homogeneous line) triggers
 * O(n²) backtracking, and T3's fail-closed wrapper only catches THROWS, not
 * a CPU spin. `MAX_SCAN_CONTENT` bounds the guard content length BEFORE any
 * regex runs; `MAX_SCAN_LINE` is a defense-in-depth per-line bound for the
 * generic scan even under the content cap.
 */
describe('scanSnippetForSecrets — W5-T1 FIX F2: content-length guard (DoS)', () => {
  const p = 'src/config.ts';

  it('returns fail-closed with ruleId "oversized" for a 200 KB benign line, and completes fast', () => {
    // Benign: a long digit run, no secret keyword anywhere — exactly the
    // reviewer's "long number literal" repro shape.
    const content = '1234567890'.repeat(20_000); // 200,000 chars
    const start = Date.now();
    const verdict = scanSnippetForSecrets({ path: p, content });
    const elapsedMs = Date.now() - start;
    expect(verdict).toEqual({ allowed: false, ruleId: 'oversized' });
    // Pre-fix this took ~2 min (120,000ms) on the reviewer's machine and
    // ~10s at 160,000 chars in this repo's local RED-proof measurement
    // (quadratic scaling confirmed: 40k→643ms, 80k→2564ms, 160k→10297ms).
    // Post-fix it must be near-instant regardless of input size.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('also returns fail-closed fast for a 200 KB benign line that DOES carry a secret keyword', () => {
    // Guards against a design that only length-checks keyword-free content —
    // the oversized guard must fire before the keyword gate even runs.
    const content = `api_key ${'1234567890'.repeat(20_000)}`;
    const start = Date.now();
    const verdict = scanSnippetForSecrets({ path: p, content });
    const elapsedMs = Date.now() - start;
    expect(verdict).toEqual({ allowed: false, ruleId: 'oversized' });
    expect(elapsedMs).toBeLessThan(500);
  });

  it('does not apply the oversized guard to a benign snippet well under the cap', () => {
    const content = 'export function add(a: number, b: number) { return a + b; }';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });
});

/**
 * W5-T1 FIX PASS 2 · Finding #1 (LEAK regression) — the per-line guard failed
 * OPEN: `lineMatchesGenericConjunction` returned `false` (skip → allow) for
 * any line over `MAX_SCAN_LINE` (2000 chars), so a secret sharing a line with
 * >2000 chars of surrounding text evaded the ONLY detector for the
 * non-provider bearer/basic class. A second adversarial re-review EMPIRICALLY
 * confirmed `allowed: true` for a Bearer/Basic/api_key secret on a
 * >2000-char line — common in minified/bundled/vendored files. This is a
 * REGRESSION (pre-fix, with no line guard at all, these blocked) AND
 * internally inconsistent with the content guard (`MAX_SCAN_CONTENT`, which
 * already failed CLOSED at 16000 chars).
 *
 * Fix: the per-line guard now fails CLOSED — if ANY line in the content
 * exceeds `MAX_SCAN_LINE`, the WHOLE snippet is rejected with
 * `ruleId: 'oversized-line'` (checked once over the whole content, before
 * the generic per-line scan ever runs a keyword/candidate regex on any
 * line — this preserves the original DoS defense-in-depth rationale for the
 * bound: cheap `line.length` checks happen before any regex touches a long
 * line). A snippet with an oversized line is anomalous (minified/generated,
 * low-value context); dropping it starves context for that one snippet
 * (safe) and never leaks.
 */
describe('scanSnippetForSecrets — W5-T1 FIX PASS 2, Finding #1: per-line guard fails CLOSED (long-line leak)', () => {
  const p = 'src/config.ts';
  // 40-char hex-ish token, entropy ≈ 3.9464 (> 3.5) — a realistic bearer/API
  // secret shape, distinct from the 65-char HEX_TOKEN used in the F1 (fix 1)
  // describe block above so the two fixture sets don't overlap.
  const HEX_40 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  // >2100-char filler — forms a line well over MAX_SCAN_LINE (2000) once the
  // secret-bearing suffix is appended, while staying well under
  // MAX_SCAN_CONTENT (16000) so the assertion isolates ruleId
  // 'oversized-line' from the (already-tested) content-level 'oversized'.
  const LONG_PREFIX = '// ' + 'x'.repeat(2100);

  it('BLOCKS (was LEAK): a >2000-char comment line followed by "Authorization: Bearer <40-hex>"', () => {
    const content = `${LONG_PREFIX} Authorization: Bearer ${HEX_40}`;
    expect(content.length).toBeGreaterThan(2000);
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({
      allowed: false,
      ruleId: 'oversized-line',
    });
  });

  it('BLOCKS (was LEAK): a >2000-char comment line followed by "Authorization: Basic <base64>"', () => {
    const content = `${LONG_PREFIX} Authorization: Basic YWRtaW46cGFzc3dvcmQxMjM0NTY3ODkwYWJjZGVm`;
    expect(content.length).toBeGreaterThan(2000);
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({
      allowed: false,
      ruleId: 'oversized-line',
    });
  });

  it('BLOCKS (was LEAK): a >2000-char object literal line with api_key:"<40-hex>"', () => {
    const content = `const cfg = {${'x'.repeat(2100)}, api_key: "${HEX_40}"};`;
    expect(content.length).toBeGreaterThan(2000);
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({
      allowed: false,
      ruleId: 'oversized-line',
    });
  });

  it('BLOCKS (was LEAK): a >2000-char minified-style line with a trailing password assignment', () => {
    const content = `${'x'.repeat(2200)} password = "${HEX_40}"`;
    expect(content.length).toBeGreaterThan(2000);
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({
      allowed: false,
      ruleId: 'oversized-line',
    });
  });

  it('rejects (fail-closed) a >2000-char BENIGN line even with no secret keyword — starves context safely', () => {
    // Proves the guard is unconditional (does NOT skip-and-continue): a long
    // line with no keyword and no secret still rejects the whole snippet,
    // by design (anomalous input, safe to drop, never leaks).
    const content = 'x'.repeat(2500);
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({
      allowed: false,
      ruleId: 'oversized-line',
    });
  });

  it('does NOT apply the oversized-line guard when every line is within MAX_SCAN_LINE', () => {
    const content = `Authorization: Bearer ${HEX_40}`;
    expect(content.length).toBeLessThan(2000);
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('still returns ruleId "oversized" (content guard), not "oversized-line", when content also exceeds MAX_SCAN_CONTENT', () => {
    // No regression: the content-level guard (16000) is checked first and
    // wins when both bounds are exceeded — ordering unchanged from FIX 1.
    const content = '1234567890'.repeat(20_000); // 200,000 chars, one giant line
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'oversized' });
  });
});

/**
 * W5-T1 FIX PASS 2 · Finding #2 (LEAK regression) — the digit-or-base64
 * conjunct let PURE-ALPHABETIC quoted secrets evade entirely. A second
 * adversarial re-review EMPIRICALLY confirmed `api_key = "abcdefGHIJKLmnopQRSTuvwx"`
 * (24 letters, entropy ≈ 4.585) returned `allowed: true` — a REGRESSION vs.
 * the pre-fix scanner, which captured the quoted value with NO digit
 * requirement and blocked it.
 *
 * Fix — the quoted-value exemption: a secret-charset candidate (len ≥ 16,
 * entropy > 3.5) now rejects the snippet when EITHER (a) it appears inside a
 * quoted string (`"…"` / `'…'`) — no digit requirement — OR (b) it is a BARE
 * (unquoted) run that also contains a digit/base64-special. Quotes
 * distinguish a real secret literal from a bare code expression; the digit
 * requirement on the bare path is what still excludes plain camelCase
 * identifiers (`generateRandomIdentifier`, `AUTHORIZATION_BEARER`) — the F3
 * over-block fix stays closed.
 */
describe('scanSnippetForSecrets — W5-T1 FIX PASS 2, Finding #2: quoted-value exemption for pure-alpha secrets', () => {
  const p = 'src/config.ts';

  it('BLOCKS (was LEAK): api_key = "abcdefGHIJKLmnopQRSTuvwx" (quoted, pure-alpha, entropy ≈ 4.585)', () => {
    const content = 'const api_key = "abcdefGHIJKLmnopQRSTuvwx";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('BLOCKS (was LEAK): secret = "QwErTyUiOpAsDfGhJkLzXcVbNmQwErTy" (quoted, pure-alpha, entropy ≈ 4.625)', () => {
    const content = 'const secret = "QwErTyUiOpAsDfGhJkLzXcVbNmQwErTy";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('BLOCKS (was LEAK): password = "kXpQmZvWnBtRfHsLdJcYgKwP" (quoted, pure-alpha, entropy ≈ 4.585)', () => {
    const content = 'const password = "kXpQmZvWnBtRfHsLdJcYgKwP";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('also blocks the single-quoted form of a quoted pure-alpha secret', () => {
    const content = "const apiKey = 'abcdefGHIJKLmnopQRSTuvwx';";
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  // ---- Still ALLOW (F3 stays fixed — unquoted identifiers) ----

  it('still allows req.headers.authorization (unquoted, dotted → split < 16)', () => {
    const content = 'const authToken = req.headers.authorization;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('still allows generateRandomIdentifier() (unquoted, parens, pure-alpha, no digit)', () => {
    const content = 'const authToken = generateRandomIdentifier();';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('still allows process.env.MY_SECRET_VALUE_NAME (unquoted, no digit)', () => {
    const content = 'const secret = process.env.MY_SECRET_VALUE_NAME;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  // ---- Still ALLOW (existing corpus — quoted but not a secret) ----

  it('still allows password = "changeme" (quoted, len 8 < 16)', () => {
    const content = 'const password = "changeme";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('still allows cache_key = "user:profile:v2" (quoted, `:` splits runs < 16)', () => {
    const content = 'const cache_key = "user:profile:v2";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('still allows api_key = "aaaaaaaaaaaaaaaa" (quoted, entropy 0)', () => {
    const content = 'const api_key = "aaaaaaaaaaaaaaaa";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('still allows a quoted English sentence on a keyword line (secret-charset runs within are all < 16)', () => {
    const content = 'const msg = "Authentication failed: invalid token";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  // ---- Still BLOCK (F1 stays fixed) ----

  it('still blocks Authorization: Bearer <40-hex> (unquoted, has digits)', () => {
    const content = 'Authorization: Bearer a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });
});

/**
 * W5-T1 FIX · minor provider broadening — Slack `xapp-` (app-level) and
 * `xoxe-` (refresh) token prefixes, and AWS `ASIA` (temporary access-key ID,
 * same shape as `AKIA`). Existing `aws-akia`/`xox[baprs]-` coverage is
 * unchanged (see the Layer 2(a) describe block above) — these are pure
 * additions.
 */
describe('scanSnippetForSecrets — W5-T1 FIX: Slack xapp-/xoxe- and AWS ASIA provider coverage', () => {
  const p = 'src/config.ts';

  it('rejects a Slack app-level token (xapp-) with ruleId "slack"', () => {
    const content =
      'const x = "xapp-1-A012345678-1234567890123-abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'slack' });
  });

  it('rejects a Slack refresh token (xoxe-) with ruleId "slack"', () => {
    const content = 'const x = "xoxe-1-MyRefreshTokenAbcdef1234567890";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'slack' });
  });

  it('rejects an AWS temporary access key id (ASIA) with ruleId "aws-asia"', () => {
    const content = 'const x = "ASIAIOSFODNN7EXAMPLE";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'aws-asia' });
  });

  it('still rejects a permanent AWS access key id (AKIA) with the unchanged ruleId "aws-akia"', () => {
    const content = 'const x = "AKIAIOSFODNN7EXAMPLE";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'aws-akia' });
  });
});

/**
 * W5-T1 FIX · ACCEPTED RESIDUALS — documented tradeoffs the brief explicitly
 * instructs NOT to fix. Both are principled: closing them either requires
 * dictionary-based detection (out of scope for a pure char-entropy scanner)
 * or un-gating entropy scanning entirely (which would false-positive on
 * every hash/UUID/base64 asset in a codebase, per the FP corpus above).
 */
describe('scanSnippetForSecrets — W5-T1 FIX: accepted residuals (documented, intentionally NOT fixed)', () => {
  const p = 'src/config.ts';

  it('ACCEPTED RESIDUAL: a diceware passphrase egresses (entropy 3.4947 < 3.5 threshold)', () => {
    // "correct-horse-battery-staple": pure-alpha-with-hyphens (no digit/
    // base64-special either), entropy ≈ 3.4947 — just under the 3.5 gate.
    // Inherent to char-entropy detection; dictionary/wordlist detection is
    // out of scope for this scanner. See report §"Accepted residuals".
    const content = 'const password = "correct-horse-battery-staple";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('ACCEPTED RESIDUAL: a no-keyword raw secret egresses (generic rule is keyword-gated by design)', () => {
    // A real-shaped AWS secret access key (the AWS docs' own EXAMPLE value)
    // assigned to a non-keyword identifier. The generic rule requires a
    // secret keyword on the line (R8: entropy-alone-never-fires, which
    // bounds the FP rate to a usable level — see the FP corpus above). This
    // is a PRINCIPLED tradeoff, not an oversight: un-gated high-entropy
    // scanning would false-positive on every hash/UUID/base64 literal in a
    // codebase. Flagged PROMINENTLY per the brief — this is the boundary
    // T3/users must know: `const x = "<40-char-token>"` WITHOUT a secret
    // keyword nearby is NOT caught by this layer.
    const content = 'const value = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('ACCEPTED RESIDUAL (over-block, NOT a leak — fix2-brief Finding #3): "author"/"oauth" substring drops a benign comment', () => {
    // SECRET_KEYWORD_RE matches the bare substring `auth`, which also
    // appears inside `author`/`oauth`. Combined with a high-entropy
    // digit-bearing token elsewhere on the same line, a benign comment like
    // this over-blocks (the snippet is dropped, starving context) even
    // though nothing secret is present. Tightening `auth` to a word boundary
    // risks losing real `authToken`/`authorization`/`Authorization:` header
    // coverage (see the F1/F2 BLOCK fixtures throughout this file), so this
    // is accepted as a QUALITY residual (context starvation), not a leak —
    // it fails safe (over-restrictive), never open. Same accepted class as
    // the `// api_key rotation reminder <token>` fixture elsewhere in this
    // file (a keyword-substring match driving an unwanted block).
    const content = '// commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 by the author';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: false, ruleId: 'generic' });
  });

  it('ACCEPTED RESIDUAL (full breadth): a BARE (unquoted) pure-alphabetic high-entropy token evades the generic rule', () => {
    // Even after the FIX PASS 2 quoted-value exemption, a BARE (unquoted)
    // pure-alphabetic high-entropy value on a keyword line still evades —
    // the digit/base64-special conjunct is REQUIRED on the bare path
    // specifically because it is what prevents the F3 identifier
    // false-positive flood (`generateRandomIdentifier()`,
    // `HttpHeaders.AUTHORIZATION_BEARER`, `process.env.MY_SECRET_VALUE_NAME`
    // — see the F3 describe block above). This is the FULL breadth of the
    // residual (not merely the sub-3.5-entropy diceware-passphrase case
    // documented separately below): ANY bare pure-alpha secret, regardless
    // of entropy, is NOT caught unless it also carries a digit or
    // `+`/`/`/`=`. A real secret literal without quotes and without a digit
    // is rare in practice (most real tokens/base64 payloads carry digits or
    // padding), but this boundary must be stated explicitly.
    const content = 'const secret = qXzKpLmWvTsBnHgYcRfDoPqXzKpLmWvTsBnHgYcRfDoP;';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });

  it('ACCEPTED RESIDUAL (Minor): a dotted non-JWT secret whose segments are all < 16 chars evades', () => {
    // Dots are a candidate boundary (not in the secret charset), so a
    // dot-delimited "secret" whose individual segments are each short
    // (< 16) never forms a single candidate long enough to trip the length
    // gate — even though the segments are quoted and the full dotted string
    // (minus dots) would exceed 16 chars combined. Low realism (real dotted
    // secrets are typically JWTs, whose base64url segments are individually
    // ≥ 16 chars and already caught by the `jwt` provider detector), so this
    // is accepted as a Minor residual.
    const content = 'const secret = "abc123.def456.ghi789";';
    expect(scanSnippetForSecrets({ path: p, content })).toEqual({ allowed: true });
  });
});
