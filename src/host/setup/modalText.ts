/** T1 (beta.6 panel-fix PT1, CR-001 fix): the modal-forging character
 *  class — covers exactly: C0 controls (U+0000-U+001F), DEL (U+007F), C1
 *  controls incl. NEL (U+0080-U+009F), the ARABIC LETTER MARK (U+061C),
 *  zero-width characters + directional marks (U+200B-U+200F), the Unicode
 *  LINE/PARAGRAPH SEPARATORs (U+2028/U+2029), bidi embedding/override
 *  (U+202A-U+202E), the WORD JOINER (U+2060), isolate (U+2066-U+2069)
 *  controls, and ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF). Any of these can
 *  forge extra lines or visually reorder a single-line native `showModal`
 *  prompt.
 *
 *  T4 (beta.6 fix-wave L1-M2): U+061C/U+2060/U+FEFF added as
 *  defense-in-depth for modal free-text (model/dir names) — endpoints
 *  already neutralize them via T1's canonicalization chokepoint.
 *
 *  T2 (beta.6 panel-fix CR-003): factored into ONE source string so the
 *  REFUSE regex ({@link MODAL_UNSAFE_TEXT_PATTERN}) and the REDACT regex
 *  (used by {@link redactForModal}) are built from the exact same class and
 *  can never silently drift apart. Do NOT hand-duplicate this class as a
 *  second regex literal anywhere else in this file. */
const MODAL_UNSAFE_CHARS = '\\x00-\\x1f\\x7f\\u0080-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff';
export const MODAL_UNSAFE_TEXT_PATTERN = new RegExp(`[${MODAL_UNSAFE_CHARS}]`);
/** T2 (CR-003): the global (strip-all-occurrences) variant of {@link MODAL_UNSAFE_TEXT_PATTERN} — see {@link redactForModal}. */
const MODAL_UNSAFE_TEXT_PATTERN_G = new RegExp(`[${MODAL_UNSAFE_CHARS}]`, 'g');
/** §7/§6 T1: the shared length cap for any free-text value that reaches a modal. */
const MODAL_TEXT_MAX_LEN = 200;

/**
 * T1 (beta.6 panel-fix PT1): the shared modal-forging SANITATION SWEEP —
 * applied to EVERY free-text param that reaches {@link SetupHost.showModal}
 * BEFORE its modal renders (`applyFim.model`, `setRag.embedModel`,
 * `setRag.indexDir`, `setNextEdit.model`, `pullModel.model`). `label` names
 * the offending param in the refusal reason so each call site's failure is
 * traceable to its own field. Purely additive — never touches endpoint/URL
 * validation ({@link validateEndpointUrl}) or the download-integrity gates.
 */
export function refuseUnsafeModalText(value: string, label: string): { ok: true } | { ok: false; reason: string } {
  if (value.length > MODAL_TEXT_MAX_LEN) {
    return { ok: false, reason: `${label} is too long (max ${MODAL_TEXT_MAX_LEN} characters).` };
  }
  if (MODAL_UNSAFE_TEXT_PATTERN.test(value)) {
    return { ok: false, reason: `${label} contains characters that are not allowed in a confirmation prompt.` };
  }
  return { ok: true };
}

/**
 * R3-ARCH-01: the one shared STRIP primitive (never length-slices) — the
 * single owner `control/mcpEntryValidation.ts`'s `stripModalControls` now
 * delegates to, instead of rebuilding its own module-init `.source`-derived
 * `/g` regex (the TDZ/latent-cycle vector this replaces). Exported as a
 * FUNCTION, not the `/g` regex object itself: a shared global `RegExp`
 * carries `lastIndex` state across every importer (this codebase already
 * resets `lastIndex` in `secretScanner.ts` for exactly this hazard) —
 * `String.replace` happens to reset it, but exporting the object would
 * invite a future `.test()`/`.exec()` caller to leak state across modules.
 */
export function stripModalUnsafeText(value: string): string {
  return value.replace(MODAL_UNSAFE_TEXT_PATTERN_G, '');
}

/**
 * T2 (beta.6 panel-fix CR-003): NEUTRALIZE (never refuse) a value the user
 * already has SAVED, before it is interpolated into a Tier-1 confirmation
 * modal as an 'old' value (e.g. the current `talaria.autocomplete.endpoint`
 * / `talaria.nextEdit.endpoint`, shown in the 'from X to Y' Apply prompt).
 * Unlike {@link refuseUnsafeModalText} — which REFUSES a freshly-submitted
 * param — refusing the whole Apply because a hand-edited settings.json has
 * an odd character in the OLD value would trap the user out of fixing it.
 * {@link stripModalUnsafeText} (built from the same {@link MODAL_UNSAFE_CHARS}
 * source as {@link MODAL_UNSAFE_TEXT_PATTERN}, so the two can never drift
 * apart), then caps to {@link MODAL_TEXT_MAX_LEN}.
 * DISPLAY-ONLY: never touches what gets WRITTEN to a setting — callers
 * still write the validated/raw value, never this redacted copy.
 */
export function redactForModal(value: string): string {
  const stripped = stripModalUnsafeText(value);
  return stripped.length > MODAL_TEXT_MAX_LEN ? stripped.slice(0, MODAL_TEXT_MAX_LEN) : stripped;
}
