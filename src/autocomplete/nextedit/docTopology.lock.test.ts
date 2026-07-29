import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { isKnownFimModel } from '../templates';
import { must } from '../../testing/must';

/**
 * Task 11 — locks for the DOCUMENTED claims that would otherwise rot silently.
 *
 * Wave 5.2 caught two documentation defects of exactly this shape: `08` §10
 * pinned a locator string that was false in every case, and `docs/user/`
 * described FIM's model as one that is not the shipped default. Both were
 * prose asserting a fact about source, with nothing connecting the two. A doc
 * sentence nobody re-reads is a doc sentence that drifts.
 *
 * SCOPE, deliberately narrow. Only claims that are (a) load-bearing for a user
 * decision and (b) mechanically checkable against a single source of truth are
 * locked here. Claims that are arguments, recommendations, or honestly-hedged
 * uncertainty are NOT locked — a test cannot adjudicate them, and pretending
 * otherwise would be the same overclaiming this task exists to remove.
 *
 * NOT locked here because it is ALREADY locked behaviourally:
 *   - "Generic rides the FIM model on the FIM endpoint" is proven end-to-end by
 *     `shell.vscode.test.ts`'s "GENERIC routes to the AUTOCOMPLETE
 *     endpoint+model with the generic-instruct format". A source-scan here
 *     would be a weaker duplicate of a real behavioural test.
 *
 * Every assertion below was proven RED by planting the corresponding violation
 * (a changed literal / a removed sentence / an added key) and watching it fail
 * before being reverted.
 */

const NEXTEDIT_DIR = __dirname;
const REPO_ROOT = join(NEXTEDIT_DIR, '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

/**
 * Markdown prose is HARD-WRAPPED, so any quotation or phrase lock must be
 * whitespace-insensitive or it is testing the line width instead of the words.
 * Both `next-edit.md`'s `7b-base` recommendation and the topology page's
 * quoted setting description straddle a line break; a line-based instrument
 * called both of them violations on the first run of this file. Normalising
 * first is the fix — the same "the instrument was wrong, not the subject"
 * correction ADR-015's performance ceiling records.
 */
function flatten(markdown: string): string {
  return markdown.replace(/\s+/g, ' ');
}

const SHELL_SRC = readRepoFile('src/autocomplete/nextedit/shell.vscode.ts');
const CONFIG_SRC = readRepoFile('src/autocomplete/config.ts');
const TOPOLOGY_DOC = readRepoFile('docs/user/model-topology.md');
const NEXT_EDIT_DOC = readRepoFile('docs/user/next-edit.md');

interface RawPackageJson {
  readonly contributes: {
    readonly configuration: {
      readonly properties: Record<string, { readonly default?: unknown; readonly description?: string }>;
    };
  };
}

const PACKAGE_JSON = JSON.parse(readRepoFile('package.json')) as RawPackageJson;
const CONFIG_PROPERTIES = PACKAGE_JSON.contributes.configuration.properties;

/**
 * FINAL REVIEW — FINDING 3. Every user-facing document, DISCOVERED rather than
 * listed.
 *
 * LOCK 2's model checks used to read two hard-coded documents. The binding
 * constraint covers ANY document a user reads, so `docs/user/secret-storage-
 * linux.md` (added this wave) and `README.md` were simply unreached — a
 * violation planted in a third page passed forever. Enumerating the directory
 * means a page added NEXT wave is covered on the day it lands, with nobody
 * having to remember to extend a list here.
 */
function readUserDocs(): ReadonlyArray<readonly [string, string]> {
  const userDir = join(REPO_ROOT, 'docs', 'user');
  const pages: Array<readonly [string, string]> = [['README.md', readRepoFile('README.md')]];
  for (const entry of readdirSync(userDir).sort()) {
    if (entry.endsWith('.md')) {
      pages.push([`docs/user/${entry}`, readFileSync(join(userDir, entry), 'utf-8')]);
    }
  }
  return pages;
}

const USER_DOCS = readUserDocs();

/**
 * Any `qwen2.5-coder:<tag>`, with or without surrounding backticks.
 *
 * NON-global on purpose. A `/g` regex carries `lastIndex` across `.test()`
 * calls, so the same pattern reused in a filter silently alternates
 * true/false — a self-inflicted could-never-fail guard of exactly the kind
 * this review is about.
 */
const MODEL_TAG = /`?qwen2\.5-coder:[a-z0-9.\-]+`?/i;
/** The same family, restricted to the `-base` builds that may be recommended. */
const BASE_MODEL_TAG = /qwen2\.5-coder:[a-z0-9.\-]*-base/i;
/**
 * Verbs that turn a mention into an INSTRUCTION. Deliberately broad: the point
 * of Finding 3 is that pinning one phrasing (``set `talaria.autocomplete.model`
 * to``) let a differently-worded recommendation through.
 */
const RECOMMENDING_VERB = /\b(set|use|using|switch|write|choose|pick|prefer|recommend\w*|configure|point)\b/i;

/**
 * Sentences of `markdown`, whitespace-flattened first (prose here is
 * hard-wrapped, so a line-based instrument would measure the line width rather
 * than the words — see `flatten`).
 *
 * Splitting on sentence punctuation FOLLOWED BY WHITESPACE is what keeps
 * `qwen2.5-coder` intact: the `.` in `2.5` is followed by a digit, never a
 * space, so a version number can never be mistaken for a sentence end.
 */
function sentences(markdown: string): string[] {
  return flatten(markdown).split(/(?<=[.!?])\s+/);
}

/**
 * Sentences that name a model tag, carry a recommending verb, and name NO
 * `-base` build — i.e. sentences that read as "use this bare tag".
 *
 * Exported as a named function so the RED-first proof below can run the EXACT
 * predicate the lock runs against a synthetic document, rather than a
 * paraphrase of it that could drift from the real one.
 */
function bareTagRecommendations(markdown: string): string[] {
  return sentences(markdown).filter(
    (sentence) =>
      MODEL_TAG.test(sentence) &&
      RECOMMENDING_VERB.test(sentence) &&
      !BASE_MODEL_TAG.test(sentence),
  );
}

/** Sentences naming a model tag at all — the reach denominator. */
function modelTagSentences(markdown: string): string[] {
  return sentences(markdown).filter((sentence) => MODEL_TAG.test(sentence));
}

/** Reach proof: a scan over an empty/renamed file passes forever. */
describe('reach proof — every file these locks read really was read', () => {
  it('each source under lock is non-empty and is the file it claims to be', () => {
    expect(SHELL_SRC).toContain('registerTalariaNextEdit');
    expect(CONFIG_SRC).toContain('export function readConfig');
    expect(TOPOLOGY_DOC).toContain('three roles, two settings');
    expect(NEXT_EDIT_DOC).toContain('# Next Edit Suggestions');
    expect(Object.keys(CONFIG_PROPERTIES).length).toBeGreaterThan(20);
  });
});

/**
 * LOCK 1 — the shell renders the locator string it is expected to, and the
 * shipped page names the verb labels it flips between.
 *
 * The original of this lock ALSO pinned §10 of an internal architecture-research
 * doc (`08-jobB-final-architecture.md`) against the shell's rendered string.
 * That research doc is not part of the published repo (it lives in the private
 * `docs_claude/` tree), so a clone cannot read it — its pins were removed here.
 * What remains locks only the SHIPPED artefacts — the shell's own template and
 * the public `next-edit.md` — which is all a clone can (and should) verify. The
 * lost research-doc pin is replaced by a lock of the public page against the
 * code, so the verb labels still cannot drift silently.
 *
 * The separator between the numbers is an EN DASH (U+2013), not a hyphen —
 * asserted explicitly, because that substitution is invisible in review and
 * would otherwise silently break the render.
 */
describe('LOCK 1: the shell renders the locator string, and next-edit.md names its verb labels', () => {
  /** The single `contentText:` template literal in the shell. */
  function shippedLocatorTemplate(): string {
    const match = /contentText: `([^`]*)`/.exec(SHELL_SRC);
    expect(match, 'shell.vscode.ts must contain exactly one contentText template literal').not.toBeNull();
    return must(must(match)[1]);
  }

  it('the shell renders a span (first–last), not a distance, with an EN DASH separator', () => {
    const template = shippedLocatorTemplate();
    expect(template).toBe('⇕ lines ${firstLine}–${lastLine} · ${verb} · Esc to dismiss');
    // U+2013, not U+002D. Spelled by code point so the assertion cannot be
    // satisfied by a look-alike character pasted into the source.
    expect(template).toContain('–');
    expect(template).not.toContain('-');
  });

  it('the shell flips the verb between the two labels the page documents', () => {
    // The shipped verb logic. Kept from the original lock (its research-doc
    // half was removed with the doc); this is the half that pins real code.
    expect(SHELL_SRC).toContain("const verb = jumped ? 'Tab to accept' : 'Tab to jump';");
  });

  it('the public next-edit.md names both verb labels the shell actually renders', () => {
    // Replaces the removed research-doc pin with a lock against the SHIPPED
    // page: `next-edit.md` must name both labels the shell flips between, so
    // the page a user reads cannot drift from the code it describes.
    expect(NEXT_EDIT_DOC).toContain('Tab to jump');
    expect(NEXT_EDIT_DOC).toContain('Tab to accept');
  });
});

/**
 * LOCK 2 — the shipped FIM default, in the three places that must agree.
 *
 * This one is live: the plan records the FIM default as an owner decision that
 * was made but could be revisited. If it ever changes, two user-facing pages
 * become wrong in the same breath, and neither would fail any existing test.
 *
 * FINDING 3 (final review) — REACH. Every check in this block that makes a
 * claim about "user docs" now runs over `USER_DOCS`, the DISCOVERED corpus
 * (`docs/user/*.md` + `README.md`), not the two pages that happened to be
 * hard-coded when this lock was written. The bare-tag check additionally
 * gained a phrasing-independent sibling; see its own comment for exactly what
 * is and is not guaranteed by it.
 */
describe('LOCK 2: the shipped FIM default model agrees across code, manifest and user docs', () => {
  const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base';

  it('`package.json` and `config.ts` hold the same default', () => {
    expect(CONFIG_PROPERTIES['talaria.autocomplete.model']?.default).toBe(DEFAULT_MODEL);
    expect(CONFIG_SRC).toContain(`const DEFAULT_MODEL = '${DEFAULT_MODEL}';`);
  });

  it('both user pages name that same default', () => {
    expect(TOPOLOGY_DOC).toContain(DEFAULT_MODEL);
    expect(NEXT_EDIT_DOC).toContain(DEFAULT_MODEL);
  });

  /**
   * FINDING 3 — this check's REACH, corrected.
   *
   * What it used to do: inspect the tag following the literal phrase ``set
   * `talaria.autocomplete.model` to``, in exactly two documents. Its own comment
   * said "Reach is asserted per subject" — true of the SITES it counted, false
   * of the PHRASINGS it covered, so it read as much stronger assurance than it
   * gave. The code lens planted ``For better quality, use `qwen2.5-coder:7b` as
   * your autocomplete model.`` into `next-edit.md` and got 19/19 GREEN: a
   * different wording, in a document the check did read.
   *
   * What it does now, and what that IS and IS NOT worth:
   *
   *  1. The phrase-anchored check still runs, now across EVERY user-facing
   *     document (`docs/user/*.md` + `README.md`, discovered not listed).
   *  2. A second, PHRASING-INDEPENDENT check: any SENTENCE that names a
   *     `qwen2.5-coder:` tag and carries a recommending verb must also name a
   *     `-base` build.
   *
   * GUARANTEED: no user doc contains a sentence that recommends a model tag
   * without naming a `-base` build in that same sentence.
   *
   * NOT guaranteed, stated plainly so this comment cannot become the next
   * overclaim:
   *  - The unit is the SENTENCE. A bare-tag recommendation written into a
   *    sentence that ALSO names a `-base` build is not caught. That sentence
   *    would have to contradict itself in one breath, which is why the residual
   *    risk is accepted rather than chased.
   *  - `RECOMMENDING_VERB` is a word list, not a parser. A recommendation
   *    phrased with none of those verbs is not caught.
   *  - Prose that merely NAMES the bare tag is deliberately allowed — both
   *    pages must be able to explain why it is the wrong choice.
   */
  it('no user doc recommends the bare `:7b` tag via the phrase the setting instruction uses', () => {
    const INSTRUCTION = /set `talaria\.autocomplete\.model` to ?/gi;
    let sitesAcrossCorpus = 0;
    const sitesByPage = new Map<string, number>();

    for (const [name, doc] of USER_DOCS) {
      const flat = flatten(doc);
      let sitesChecked = 0;
      for (const match of flat.matchAll(INSTRUCTION)) {
        const recommendedTag = flat.slice(match.index + match[0].length).split(' ')[0] ?? '';
        expect(recommendedTag, `${name}: the tag recommended here must be a -base tag`).toContain(
          '-base',
        );
        sitesChecked += 1;
      }
      sitesByPage.set(name, sitesChecked);
      sitesAcrossCorpus += sitesChecked;
    }

    // Reach, in two parts. The corpus total proves the instrument fired at
    // all; the per-page floor proves it fired on the two pages that are
    // REQUIRED to carry an explicit model instruction. A page legitimately
    // carrying none (`README.md`, `secret-storage-linux.md`) must not be
    // forced to invent one, which is why this is no longer a blanket
    // per-page assertion.
    expect(sitesAcrossCorpus, 'the phrase-anchored instrument matched nothing at all').toBeGreaterThan(0);
    for (const required of ['docs/user/model-topology.md', 'docs/user/next-edit.md']) {
      expect(sitesByPage.get(required), `${required}: must carry an explicit model instruction`).toBeGreaterThan(
        0,
      );
    }
  });

  it('no user doc RECOMMENDS a bare tag in any phrasing (the check the planted violation walked past)', () => {
    for (const [name, doc] of USER_DOCS) {
      expect(
        bareTagRecommendations(doc),
        `${name}: this sentence reads as a recommendation of a model tag but names no -base build`,
      ).toEqual([]);
    }
  });

  /**
   * Reach for the phrasing-independent check. A sentence scan over documents
   * that name no model at all passes forever — so the corpus is pinned to be
   * discovered, non-trivial, and to actually CONTAIN the subject.
   */
  it('reach: the corpus really is every user page, and it really does name model tags', () => {
    const names = USER_DOCS.map(([name]) => name);
    // The two pages the old check read, PLUS the two it could not see. Named
    // explicitly: discovery silently returning fewer files is exactly how a
    // walk-based lock rots.
    expect(names).toContain('README.md');
    expect(names).toContain('docs/user/model-topology.md');
    expect(names).toContain('docs/user/next-edit.md');
    expect(names).toContain('docs/user/secret-storage-linux.md');
    for (const [name, doc] of USER_DOCS) {
      expect(doc.length, `${name}: an empty read would rubber-stamp every check above`).toBeGreaterThan(0);
    }
    const tagSentences = USER_DOCS.flatMap(([, doc]) => modelTagSentences(doc));
    expect(
      tagSentences.length,
      'no sentence in the whole corpus names a model tag — the recommendation scan would be vacuous',
    ).toBeGreaterThan(0);
  });

  /**
   * RED-first proof, IN-MEMORY. Runs the REAL predicate over a synthetic page
   * carrying the code lens's exact planted sentence — the one that got 19/19
   * green. `docs/` is read-only to this lane, so the plant cannot go on disk;
   * feeding the predicate directly is the same mechanism
   * `nextEditPurity.test.ts` uses for its own no-disk-probe RED proofs, and it
   * proves the identical thing.
   */
  it("RED-first proof: the lens's exact planted sentence IS flagged by the predicate that let it through", () => {
    const planted = 'For better quality, use `qwen2.5-coder:7b` as your autocomplete model.';
    expect(bareTagRecommendations(planted)).toEqual([planted]);

    // The old phrase-anchored instrument, run on the same sentence, finds
    // nothing — which is precisely why widening was the remedy and not a
    // tightening of the old pattern.
    expect(planted).not.toMatch(/set `talaria\.autocomplete\.model` to/i);
  });

  it('negative control: the predicate does NOT flag prose that merely explains the bare tag', () => {
    // Real shape from `model-topology.md` — names the bare tag inside a
    // caution. A predicate that flagged this would force the pages to stop
    // warning about the trap they exist to warn about.
    const caution =
      'On Ollama, `qwen2.5-coder:7b` is the instruct build — it resolves to the same digest as `:7b-instruct`.';
    expect(bareTagRecommendations(caution)).toEqual([]);
    // And a genuine recommendation naming the -base build is likewise clean.
    const good = 'If you want a bigger model, use `qwen2.5-coder:7b-base` instead.';
    expect(bareTagRecommendations(good)).toEqual([]);
  });

  // FINDING 3: both figure checks now run over the WHOLE user corpus for the
  // same reason the tag check does — "appears in no user doc" and "wherever it
  // appears" are claims about every page, and were being asserted about two.
  it('the 81.28% figure — a different, unreleased model — appears in no user doc', () => {
    for (const [name, doc] of USER_DOCS) {
      expect(doc, `${name}: 81.28% belongs to an unreleased model and may appear in no shipped page`).not.toContain(
        '81.28',
      );
    }
  });

  it("Generic's 55.62% keeps its vendor-reported/unreplicated qualifier wherever it appears", () => {
    let pagesCarryingTheFigure = 0;
    for (const [name, doc] of USER_DOCS) {
      if (!doc.includes('55.62')) continue;
      pagesCarryingTheFigure += 1;
      expect(doc, `${name}: the figure must never appear unqualified`).toContain('vendor-reported');
      expect(doc, `${name}: the figure must never appear unqualified`).toContain('unreplicated');
    }
    // Reach: a `continue`-guarded loop over a corpus where NO page carries the
    // figure would pass forever without ever running its body.
    expect(
      pagesCarryingTheFigure,
      'no user page mentions 55.62% at all — this qualifier check ran no assertions',
    ).toBeGreaterThan(0);
  });
});

/**
 * LOCK 3 — the topology page quotes a setting description verbatim.
 *
 * A quotation is the most brittle thing a doc can carry: reword the manifest
 * and the quotation becomes a fabrication attributed to the product.
 */
describe('LOCK 3: the quoted setting description is quoted correctly', () => {
  const QUOTED =
    'Generic always uses the FIM model on `#talaria.autocomplete.endpoint#`, never this setting.';

  it('the sentence the page attributes to `talaria.nextEdit.backend` is really its description', () => {
    expect(CONFIG_PROPERTIES['talaria.nextEdit.backend']?.description).toContain(QUOTED);
  });

  it('the page quotes it, and attributes it to the setting that actually carries it', () => {
    expect(flatten(TOPOLOGY_DOC)).toContain(QUOTED);
    expect(flatten(TOPOLOGY_DOC)).toContain('`talaria.nextEdit.backend` setting says so');
  });
});

/**
 * LOCK 4 — the topology table's settings exist, and the toggles are NOT among
 * them.
 *
 * The second half is the point most easily blurred by a well-meaning edit: the
 * on/off state is Guard state in `globalState`, never a configuration key
 * (R5). A doc that tells a user to set `talaria.nextEdit.enabled` sends them to
 * a key that does not exist.
 */
describe('LOCK 4: three roles, two settings — and the toggles are not settings', () => {
  it('every model/endpoint setting the page names is a real configuration key', () => {
    for (const key of [
      'talaria.autocomplete.model',
      'talaria.autocomplete.endpoint',
      'talaria.nextEdit.model',
      'talaria.nextEdit.endpoint',
    ]) {
      expect(TOPOLOGY_DOC, `the page must name ${key}`).toContain(key);
      expect(CONFIG_PROPERTIES[key], `${key} must exist in package.json`).toBeDefined();
    }
  });

  it('the on/off toggles are NOT configuration keys, exactly as the page says', () => {
    for (const key of Object.keys(CONFIG_PROPERTIES)) {
      expect(key).not.toBe('talaria.nextEdit.enabled');
      expect(key).not.toBe('talaria.nextEdit.generic');
    }
    expect(TOPOLOGY_DOC).toContain('are NOT `settings.json` settings');
  });
});

/**
 * LOCK 5 — "Talaria Code cannot warn you about the `:7b` swap."
 *
 * The sharpest claim on the page, and the only one that is a statement about
 * runtime behaviour rather than about text. It is asserted against the real
 * function, so if anyone ever ADDS a base-vs-instruct discriminator this test
 * goes red and the page must be rewritten — which is precisely the outcome
 * wanted.
 */
describe('LOCK 5: the known-model check genuinely cannot distinguish base from instruct', () => {
  it('both tags are "known", so no warning can fire for either', () => {
    expect(isKnownFimModel('qwen2.5-coder:7b')).toBe(true);
    expect(isKnownFimModel('qwen2.5-coder:7b-base')).toBe(true);
    expect(isKnownFimModel('qwen2.5-coder:7b-instruct')).toBe(true);
  });

  it('the check is not vacuous — it still rejects a genuinely unknown model', () => {
    expect(isKnownFimModel('some-unknown-model:13b')).toBe(false);
  });

  it('the page states the consequence rather than promising a warning', () => {
    expect(TOPOLOGY_DOC).toContain('Talaria Code cannot warn you');
  });
});

/**
 * LOCK 6 — no-orchestration, as promised to the user in prose.
 *
 * The page tells the user that nothing measures VRAM or decides whether a
 * model fits. That is a Global Constraint, and the prose is only trustworthy
 * while the constraint holds.
 */
describe('LOCK 6: the no-orchestration promise the page makes is true of the shell', () => {
  it('the next-edit shell contains no VRAM/hardware/model-fit probe', () => {
    const code = SHELL_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    // Comments are stripped first: `GENERIC_SETUP_NOTE`'s own doc comment
    // quotes the "no code may measure VRAM" constraint, and an unstripped
    // scan would match that prose and prove nothing.
    expect(code).not.toMatch(/totalmem|freemem|nvidia-smi|require\(['"]os['"]\)/);
    expect(code).not.toMatch(/\bdetectHardware\b|\bmeasureVram\b|\bmodelFits\b/);
  });

  it('the page promises exactly that, and promises no detection', () => {
    expect(TOPOLOGY_DOC).toContain('never measures VRAM');
    expect(TOPOLOGY_DOC).toContain('Talaria Code does not check any of this');
  });
});
