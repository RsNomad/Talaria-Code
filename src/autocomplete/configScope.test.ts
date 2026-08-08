import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Audit C-4 / fabrication G-8 / review I-1, I-2, I-3.
 *
 * ORIGINAL SHAPE (fa57fbc, Task 2's first pass): a hand-picked, CLOSED list
 * of 8 key names (`EGRESS_STEERING_KEYS`), asserted machine-scoped.
 *
 * I-2 (Important): a closed list is blind to any FUTURE egress-steering key
 * nobody remembers to add to it. Proven by the reviewer: adding an unscoped
 * `talaria.autocomplete.endpointFallback` ("Secondary base URL used when the
 * primary endpoint fails.") to `package.json` left the old list-based test
 * green. This file now scans EVERY key in the manifest by NAME PATTERN
 * instead of by a fixed list — the same open-ended shape
 * `provider.test.ts:705-719` already uses for `talaria.nextEdit.*` (loop over
 * every key matching a namespace prefix, not a fixed list), generalised
 * here from "matches a namespace" to "matches a name pattern", since
 * egress-steering keys are not confined to one namespace
 * (`talaria.autocomplete.*`, `talaria.rag.*`, `talaria.nextEdit.*` all have
 * some).
 *
 * I-1 (Important): the original comment/list called `talaria.autocomplete.
 * model` an "egress-steering key" in the SAME breath `provider.test.ts`'s
 * own `restrictedConfigurations` comment says "a model NAME picks no
 * destination". Both were true for what each was actually claiming
 * (`restrictedConfigurations` = trust gate; `scope` = override gate), but
 * calling them the same thing read as a contradiction. This file now keeps
 * two SEPARATE, separately-named locks: `EGRESS_DESTINATION_PATTERN`
 * (`endpoint`/`apiKey`/`backend`/...) and `MODEL_INTEGRITY_PATTERN`
 * (`model`), with different, honestly-stated rationales — see each
 * pattern's own doc comment.
 *
 * I-3 (Important): `talaria.rag.embedModel` met the package.json's own
 * stated criterion for machine-scoping `model` ("a workspace cannot
 * silently repoint completions/embeddings at a different model") but was
 * unscoped. Fixed in `package.json`; `MODEL_INTEGRITY_PATTERN` below now
 * catches it (and would catch a REGRESSION — see the non-vacuous tests).
 *
 * POLARITY (review's explicit ask). This is a PRESENCE scan over
 * `JSON.parse`d manifest DATA, not a text/regex scan of `.ts` SOURCE the way
 * `host/purityScan.ts`'s guards work (`assertAllScannedLock.test.ts`,
 * `authGuardLock.test.ts`, `context/contextPurity.test.ts`, ...) — so a
 * `description`/`markdownDescription` STRING that happens to mention
 * "endpoint" in prose can never fool it: the patterns below are only ever
 * tested against the property KEY (a JSON object key, structurally
 * distinct from free text), never against any description field.
 * Comment-blindness, the specific failure mode those other guards document
 * and accept, does NOT apply here.
 *
 * But list-completeness still fails OPEN, the same DIRECTION every guard in
 * this repo's mechanised-lock family fails: a key whose NAME does not
 * match either pattern below (an unanticipated word — "relay", "mirror",
 * "proxy", "credential", ...) is invisible to this scan and silently
 * PASSES, exactly like a purity guard that is blind to a banned import
 * mentioned only in a comment defaults to treating the file as clean. The
 * patterns are reviewed and widened by a human when a new kind of key is
 * added — this file does not claim to make that review unnecessary, only
 * to make the DEFAULT (no review happened, or a reviewer forgot) fail
 * CLOSED for the common cases the patterns already name, instead of
 * failing open on literally every unlisted key the way the original fixed
 * list did.
 */
const REPO_ROOT = join(__dirname, '..', '..');

interface ConfigProperty {
  scope?: string;
}

interface ConfigCategory {
  properties?: Record<string, ConfigProperty>;
}

function configurationProperties(): Record<string, ConfigProperty> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { configuration: ConfigCategory | ConfigCategory[] };
  };
  // `contributes.configuration` is an array of titled categories
  // (configurationSections.test.ts locks the shape); the scope locks here
  // operate on the UNION of all categories' properties.
  const sections = Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration];
  const union: Record<string, ConfigProperty> = {};
  for (const section of sections) {
    Object.assign(union, section.properties ?? {});
  }
  return union;
}

/**
 * I-2's open-ended pattern: any manifest key whose NAME contains one of
 * these words (case-insensitive) can plausibly select/redirect a network
 * destination or carry credentials onto the wire — `endpoint`/`url`/`host`
 * (destination), `apikey`/`token` (credential), `backend` (a transport
 * SELECTOR — this task's own root cause: `talaria.autocomplete.backend`
 * SELECTS the endpoint via `config.ts`'s `DEFAULT_ENDPOINTS`).
 */
const EGRESS_DESTINATION_PATTERN = /endpoint|apikey|url|token|host|backend/i;

/**
 * Reviewed by hand, NOT auto-exempted: every key `EGRESS_DESTINATION_PATTERN`
 * currently matches that is NOT actually egress-steering, with the reason
 * it is a false positive of the (deliberately blunt) word list above.
 * Verified by reading both call sites (`config.ts`, `backendFactory.ts`):
 * neither is ever read as a URL or a header — both are plain numbers.
 *
 *   - `talaria.autocomplete.maxPromptTokens` — matches on the substring
 *     "Token" (from "...Tokens"). A NUMERIC prompt-size budget, never an
 *     auth token.
 *   - `talaria.rag.maxChunkTokens` — same word, same reason: a numeric
 *     chunk-size budget.
 */
const EGRESS_DESTINATION_EXCEPTIONS = new Set<string>([
  'talaria.autocomplete.maxPromptTokens',
  'talaria.rag.maxChunkTokens',
]);

/**
 * I-1/I-3's separate pattern and separate rationale: a model NAME does not
 * select a network destination the way `backend`/`endpoint` do
 * (`provider.test.ts`'s `restrictedConfigurations` comment makes exactly
 * this point about the trust-gate list) — so model keys are NOT folded into
 * `EGRESS_DESTINATION_PATTERN` above. They are still machine-scoped, for a
 * different, honestly-separate reason: a workspace that could override a
 * model key could silently swap WHICH model serves completions/embeddings
 * (an integrity concern — a different or compromised model — not a
 * "where do the bytes go" concern).
 */
const MODEL_INTEGRITY_PATTERN = /model/i;

/**
 * beta.6 T8: `talaria.agent.localModel.backend`/`.endpoint` match
 * `MODEL_INTEGRITY_PATTERN` only because they live under the `localModel`
 * NAMESPACE segment (architecture-pinned key shape,
 * `beta6-unified-local-model-onboarding-architecture.md` §2.5) — neither is
 * itself a model-IDENTIFIER key the way `autocomplete.model`/`nextEdit.
 * model`/`rag.embedModel` are (their OWN leaf concept is "which backend" /
 * "which URL"). Both are already required machine-scoped by
 * `EGRESS_DESTINATION_PATTERN` (they match on `backend`/`endpoint`) — this
 * exception only removes the REDUNDANT model-integrity classification so
 * the two-pattern disjointness check below stays meaningful; it does not
 * relax either key's actual machine-scope requirement.
 * `talaria.agent.localModel.modelId` is NOT excepted — it IS a genuine
 * model-identifier key, same as its `autocomplete.model`/`nextEdit.model`/
 * `rag.embedModel` siblings.
 */
const MODEL_INTEGRITY_EXCEPTIONS = new Set<string>([
  'talaria.agent.localModel.backend',
  'talaria.agent.localModel.endpoint',
]);

function eligibleFor(pattern: RegExp, exceptions: ReadonlySet<string>) {
  return (props: Record<string, ConfigProperty>): string[] =>
    Object.keys(props)
      .filter((key) => pattern.test(key))
      .filter((key) => !exceptions.has(key));
}

describe('LOCK: every egress-DESTINATION-steering setting is machine-scoped (I-2: open-ended pattern, not a fixed list)', () => {
  const eligibleKeys = eligibleFor(EGRESS_DESTINATION_PATTERN, EGRESS_DESTINATION_EXCEPTIONS);

  it('every matched, non-excepted key is scope: "machine"', () => {
    const props = configurationProperties();
    const notMachine = eligibleKeys(props).filter((key) => props[key]?.scope !== 'machine');
    expect(notMachine).toEqual([]);
  });

  it('non-vacuous: the pattern matches real keys today (an emptied/broken pattern cannot rubber-stamp the assertion above)', () => {
    const props = configurationProperties();
    const eligible = eligibleKeys(props);
    expect(eligible.length).toBeGreaterThan(0);
    for (const expected of [
      'talaria.backend',
      'talaria.autocomplete.backend',
      'talaria.autocomplete.endpoint',
      'talaria.autocomplete.apiKey',
      'talaria.rag.embedEndpoint',
      'talaria.nextEdit.backend',
      'talaria.nextEdit.endpoint',
    ]) {
      expect(
        eligible,
        `${expected} must be in scope for this lock — if it is missing, the pattern itself regressed`,
      ).toContain(expected);
    }
  });

  it('the exception list is non-vacuous: both excepted keys really do match the pattern and really are NOT machine-scoped today (an unused/stale exception would hide nothing)', () => {
    const props = configurationProperties();
    for (const excepted of EGRESS_DESTINATION_EXCEPTIONS) {
      expect(
        EGRESS_DESTINATION_PATTERN.test(excepted),
        `${excepted} must actually match the pattern — an exception for a key the pattern never catches is dead weight`,
      ).toBe(true);
      expect(props[excepted], `${excepted} must exist in the manifest`).toBeDefined();
    }
  });

  /**
   * RED-first non-vacuity proof, IN-MEMORY (mirrors this repo's established
   * idiom for proving a mechanised lock's mechanism actually works —
   * `contextPurity.test.ts`, `assertAllScannedLock.test.ts`,
   * `ringBuffer.test.ts`'s SPREAD_RE/CAST_RE probes — rather than a
   * permanent edit to `package.json`). This is the reviewer's EXACT
   * defeating mutation from the review report: an unscoped
   * `talaria.autocomplete.endpointFallback` ("Secondary base URL used when
   * the primary endpoint fails."), which defeated the OLD fixed-list test
   * outright (it was simply never in the list, so the list-based assertion
   * never even looked at it). The open-ended pattern catches it by NAME
   * alone, with zero list maintenance required.
   */
  it('RED-first proof: an unscoped key added anywhere in the manifest whose name matches the pattern is caught (in-memory injection — no permanent package.json edit)', () => {
    const props: Record<string, ConfigProperty> = {
      ...configurationProperties(),
      'talaria.autocomplete.endpointFallback': {},
    };
    const notMachine = eligibleKeys(props).filter((key) => props[key]?.scope !== 'machine');
    expect(notMachine).toContain('talaria.autocomplete.endpointFallback');
  });

  it('sanity: the guard is not vacuously true — a key with scope machine explicitly REMOVED would be caught too', () => {
    const real = configurationProperties();
    const mutated: Record<string, ConfigProperty> = {
      ...real,
      'talaria.autocomplete.endpoint': { scope: undefined },
    };
    const notMachine = eligibleKeys(mutated).filter((key) => mutated[key]?.scope !== 'machine');
    expect(notMachine).toContain('talaria.autocomplete.endpoint');
  });
});

describe('LOCK: every model-integrity setting is machine-scoped (I-1/I-3: a separate rationale from egress-destination)', () => {
  const eligibleKeys = eligibleFor(MODEL_INTEGRITY_PATTERN, MODEL_INTEGRITY_EXCEPTIONS);

  it('every model-named key is scope: "machine"', () => {
    const props = configurationProperties();
    const notMachine = eligibleKeys(props).filter((key) => props[key]?.scope !== 'machine');
    expect(notMachine).toEqual([]);
  });

  it("non-vacuous: matches all three known model keys, including I-3's talaria.rag.embedModel", () => {
    const props = configurationProperties();
    const eligible = eligibleKeys(props);
    expect(eligible.length).toBeGreaterThan(0);
    for (const expected of ['talaria.autocomplete.model', 'talaria.nextEdit.model', 'talaria.rag.embedModel']) {
      expect(eligible, `${expected} must be in scope for this lock`).toContain(expected);
    }
  });

  it('RED-first proof: an unscoped model key is caught (in-memory injection)', () => {
    const props: Record<string, ConfigProperty> = {
      ...configurationProperties(),
      'talaria.rag.embedModel': { scope: undefined },
    };
    const notMachine = eligibleKeys(props).filter((key) => props[key]?.scope !== 'machine');
    expect(notMachine).toContain('talaria.rag.embedModel');
  });

  it('sanity: the two patterns are genuinely disjoint — no key matches both (a key double-counted in both lists would mask a gap in either)', () => {
    const props = configurationProperties();
    const destinationKeys = new Set(
      eligibleFor(EGRESS_DESTINATION_PATTERN, EGRESS_DESTINATION_EXCEPTIONS)(props),
    );
    const modelKeys = new Set(eligibleKeys(props));
    const overlap = [...destinationKeys].filter((key) => modelKeys.has(key));
    expect(overlap).toEqual([]);
  });
});
