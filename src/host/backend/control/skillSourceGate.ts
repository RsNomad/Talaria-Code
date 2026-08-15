import type { SkillCreateParams } from '../../../shared/protocol';

/**
 * Task B3 (features-add-mcp-skills-architecture.md §5.3 / §3 Layer 1 S-5) —
 * the SECURITY SPINE of T2: pure, framework-free (no `vscode` import)
 * host-side re-validation of every skill-hub identifier and skill-create
 * param, applied BEFORE any network call, modal, or log line — the webview
 * is untrusted input, so this module is the actual gate, not the wire
 * types.
 *
 * `assertSkillIdentifier` mirrors (read-only, never edited)
 * `Main Agent(harness)/hermes-agent-2026.7.7.2/tools/skills_guard.py:40-49`'s
 * `TRUSTED_REPOS` set, PLUS an `official/` builtin-tier row. Deliberately
 * does NOT mirror that file's `skills-sh/` alias stripping (`:1035-1061`) —
 * we are STRICTER than Hermes there: an alias-prefixed identifier is
 * refused, not normalized.
 *
 * `validateSkillCreate` mirrors
 * `tools/skill_manager_tool.py:475` (`VALID_NAME_RE`), `:170`
 * (`MAX_NAME_LENGTH`), `:485-496` (`_validate_name`), `:499-521`
 * (`_validate_category`), `:471` (`MAX_SKILL_CONTENT_CHARS`) EXACTLY
 * (critic IMPORTANT-4) — a stricter client-side mirror would only produce
 * false rejections of Hermes-valid names (`3d-modeling`, `v2.summary`);
 * Hermes validates authoritatively server-side, so there is no security
 * gain in diverging.
 */

// ---------------------------------------------------------------------------
// TRUSTED_SKILL_PREFIXES (§5.3) — data-diff allowlist, adding a row = OWNER decision
// ---------------------------------------------------------------------------

export const TRUSTED_SKILL_PREFIXES: readonly { prefix: string; tier: 'official' | 'trusted'; label: string }[] = [
  { prefix: 'official', tier: 'official', label: 'Nous official optional skills (repo-shipped)' },
  { prefix: 'openai/skills', tier: 'trusted', label: 'openai/skills (Hermes TRUSTED_REPOS)' },
  { prefix: 'anthropics/skills', tier: 'trusted', label: 'anthropics/skills (Hermes TRUSTED_REPOS)' },
  { prefix: 'huggingface/skills', tier: 'trusted', label: 'huggingface/skills (Hermes TRUSTED_REPOS)' },
  { prefix: 'NVIDIA/skills', tier: 'trusted', label: 'NVIDIA/skills (Hermes TRUSTED_REPOS)' },
];

// ---------------------------------------------------------------------------
// assertSkillIdentifier (§5.3, §3 Layer 1 S-5)
// ---------------------------------------------------------------------------

/**
 * Segment charset: `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` — first character MUST
 * be alphanumeric (already rejects a leading '.', so '.'/'..' never
 * matches the pattern; checked explicitly below as defense-in-depth),
 * every character ASCII-only (kills unicode homoglyphs and any
 * percent-encoded byte, since '%' is not in the charset).
 */
const SEGMENT_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isDotOrDotDot(value: string): boolean {
  return value === '.' || value === '..';
}

function isValidSegment(value: string): boolean {
  return !isDotOrDotDot(value) && SEGMENT_CHARSET.test(value);
}

/**
 * Task TE-6 (AU-27, CF-14 no-echo): the raw webview-supplied `id` is
 * UNBOUNDED and unsanitised — it must never reach the `control.response`
 * (see the two `refusal()` call sites below, which used to interpolate
 * `id` straight into `reason`) or a log line uncapped. `detail` is the
 * ONLY place the identifier survives a refusal, for host-logger
 * consumption exclusively (the caller in `ControlDispatcher` is
 * responsible for actually logging it — this module stays framework-free,
 * no `vscode`/logger import). Capped to 128 chars, then control chars
 * (`\x00`-`\x1f`, e.g. NUL/ESC/CR/LF — a log-injection vector) stripped,
 * matching `rejectCatalogInstall`'s detail-to-logger discipline.
 */
const DETAIL_MAX_LENGTH = 128;

function cappedDetail(id: string): string {
  return id.slice(0, DETAIL_MAX_LENGTH).replace(/[\x00-\x1f]/g, '');
}

export type SkillIdentifierResult =
  | { ok: true; tier: 'official' | 'trusted' }
  | { ok: false; reason: string; detail: string };

/**
 * Every '/'-separated segment must pass {@link isValidSegment}; the
 * identifier as a whole must be `<allowlisted-prefix>/<one-or-more
 * additional segments>` — a BARE prefix names a repo, not a skill, and is
 * refused. This kills path traversal, homoglyphs, %-encoding, and the
 * hub's direct-URL source class (URL schemes never match the segment
 * charset, so `https://…` fails on its very first segment). Deliberately
 * NO `skills-sh/` alias stripping (stricter than
 * `skills_guard.py:1037-1047`) — an alias-prefixed identifier such as
 * `skills-sh/anthropics/skills/pdf` does not literally start with any
 * allowlisted prefix and is refused fail-closed.
 */
export function assertSkillIdentifier(id: string): SkillIdentifierResult {
  const refusal = (reason: string): { ok: false; reason: string; detail: string } => ({
    ok: false,
    reason,
    detail: cappedDetail(id),
  });

  if (typeof id !== 'string' || id.length === 0) {
    return refusal('Skill identifier is required.');
  }

  const segments = id.split('/');
  for (const segment of segments) {
    if (!isValidSegment(segment)) {
      return refusal(
        "Skill identifier contains a segment outside the allowed charset (letters, digits, '.', '_', '-'; must not be '.' or '..').",
      );
    }
  }

  for (const row of TRUSTED_SKILL_PREFIXES) {
    const prefixSegments = row.prefix.split('/');
    if (segments.length <= prefixSegments.length) continue; // bare prefix (or shorter) — names a repo, not a skill
    const matchesPrefix = prefixSegments.every((seg, i) => segments[i] === seg);
    if (matchesPrefix) return { ok: true, tier: row.tier };
  }

  return refusal(
    'Skill identifier is not under an allowlisted publisher (official/, openai/skills, anthropics/skills, huggingface/skills, NVIDIA/skills). Community and direct-URL sources are refused.',
  );
}

// ---------------------------------------------------------------------------
// validateSkillCreate (§5.3, mirrors skill_manager_tool.py EXACTLY — IMPORTANT-4)
// ---------------------------------------------------------------------------

/** `tools/skill_manager_tool.py:475` — VALID_NAME_RE, verbatim. */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** `tools/skill_manager_tool.py:170` — MAX_NAME_LENGTH, verbatim (shared by name and category). */
const MAX_NAME_LENGTH = 64;
/** `tools/skill_manager_tool.py:471` — MAX_SKILL_CONTENT_CHARS, verbatim. */
const MAX_SKILL_CONTENT_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type SkillCreateValidation = { ok: true; body: SkillCreateParams } | { ok: false; reason: string };

/** `_validate_name` (`:485-496`): required, <= MAX_NAME_LENGTH, matches VALID_NAME_RE. */
function checkSkillName(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'Skill name is required.' };
  }
  if (value.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `Skill name exceeds ${MAX_NAME_LENGTH} characters.` };
  }
  if (!VALID_NAME_RE.test(value)) {
    return {
      ok: false,
      reason: `Invalid skill name "${value}". Use lowercase letters, numbers, hyphens, dots, and underscores. Must start with a letter or digit.`,
    };
  }
  return { ok: true, value };
}

/** `_validate_category` (`:499-521`): optional; one directory segment, same regex + max length, no '/' or '\'. */
function checkSkillCategory(value: unknown): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, reason: 'Category must be a string.' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return {
      ok: false,
      reason: `Invalid category "${trimmed}". Categories must be a single directory name (no '/' or '\\').`,
    };
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `Category exceeds ${MAX_NAME_LENGTH} characters.` };
  }
  if (!VALID_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `Invalid category "${trimmed}". Use lowercase letters, numbers, hyphens, dots, and underscores.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Size + frontmatter-fence check per §5.3's client-side contract: non-empty,
 * <= MAX_SKILL_CONTENT_CHARS, MUST start with a '---' frontmatter fence.
 * Deliberately lighter than Hermes's full `_validate_frontmatter` (which
 * also parses the YAML and requires `name`/`description` keys) — that
 * deeper validation is Hermes's authoritative server-side job; this gate's
 * only claim is "the user supplied something that looks like a skill".
 */
function checkSkillContent(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'Content cannot be empty.' };
  }
  if (value.length > MAX_SKILL_CONTENT_CHARS) {
    return { ok: false, reason: `Content exceeds ${MAX_SKILL_CONTENT_CHARS.toLocaleString()} characters.` };
  }
  if (!value.startsWith('---')) {
    return { ok: false, reason: "SKILL.md must start with YAML frontmatter ('---'). See existing skills for format." };
  }
  return { ok: true, value };
}

export function validateSkillCreate(p: unknown): SkillCreateValidation {
  if (!isRecord(p)) return { ok: false, reason: 'Skill create params must be an object.' };

  const nameCheck = checkSkillName(p.name);
  if (!nameCheck.ok) return nameCheck;

  const categoryCheck = checkSkillCategory(p.category);
  if (!categoryCheck.ok) return categoryCheck;

  const contentCheck = checkSkillContent(p.content);
  if (!contentCheck.ok) return contentCheck;

  const body: SkillCreateParams = { name: nameCheck.value, content: contentCheck.value };
  if (categoryCheck.value !== undefined) body.category = categoryCheck.value;
  return { ok: true, body };
}
