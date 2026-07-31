#!/usr/bin/env node
/**
 * FIM inject-budget salvage-fraction bench -- layer 1 (deterministic, no server).
 *
 * §5 MEASUREMENT for the proposed `break` -> `continue` change in
 * `injectSnippetsAsComments` (src/autocomplete/context/mode.ts:83-112):
 * that function fills a 512-char inject budget walking the snippet array
 * TAIL-TO-HEAD (most-relevant-LAST in, so most-relevant-FIRST considered),
 * and today `break`s on the first snippet that would overflow the budget --
 * discarding every less-relevant snippet still queued behind it, even ones
 * that would individually have fit. This script measures, on a corpus of
 * REAL code-window snippets sampled from this repo's own `src/` tree, how
 * often a `continue` (skip the oversized one, keep trying the rest) would
 * actually salvage at least one extra snippet.
 *
 * This is a MEASUREMENT ONLY. It does not import, patch, or change
 * `mode.ts` or any other production file. It replicates the `break`/
 * `continue` fill logic locally and self-checks the `break` replica against
 * the REAL compiled `injectSnippetsAsComments`, extracted verbatim (as
 * source text, not retyped) from the built `dist/extension.js` bundle --
 * per the project's build-blind lesson, tsc/vitest never exercise the
 * esbuild-transformed artifact, so this bench validates against the actual
 * shipped code, not against `src/` a second time.
 *
 * Usage:
 *   npm run build                       # rebuild dist/ first -- required
 *   node scripts/fim-latency-bench.mjs
 *
 * Layer 2 (live server / real time-to-first-token) is explicitly NOT built
 * here -- see the Step-3a brief.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const DIST_EXTENSION = path.join(REPO_ROOT, 'dist', 'extension.js');

// Source of truth for these constants: src/autocomplete/context/mode.ts:45-112.
const DEFAULT_INJECT_BUDGET_CHARS = 512;
const LANGUAGE_ID = 'typescript'; // -> getSingleLineComment returns '//' (typical TS/JS, per brief)
const N_SCENARIOS = 1000; // >= 500 required by the brief

// ─────────────────────────────────────────────────────────────────────────
// Seeded PRNG (mulberry32) -- deterministic/reproducible, NOT bare Math.random.
// ─────────────────────────────────────────────────────────────────────────
const SEED = 0xc0ffee42;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, minInclusive, maxInclusive) {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

/** weights: [[value, weight], ...] -- weight need not sum to 100. */
function weightedPick(rng, weights) {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [value, w] of weights) {
    if (r < w) return value;
    r -= w;
  }
  return weights[weights.length - 1][0];
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Real corpus: enumerate .ts/.tsx files under src/, load their lines once.
// ─────────────────────────────────────────────────────────────────────────
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const allFiles = listSourceFiles(SRC_ROOT).sort(); // deterministic order across platforms
if (allFiles.length === 0) {
  console.error(`FATAL: no .ts/.tsx files found under ${SRC_ROOT} -- cannot build a real corpus.`);
  process.exit(1);
}

const fileRecords = allFiles
  .map((absPath) => {
    const text = readFileSync(absPath, 'utf8');
    return {
      relPath: path.relative(REPO_ROOT, absPath).split(path.sep).join('/'),
      lines: text.split('\n'),
    };
  })
  .filter((f) => f.lines.length >= 3); // need at least a 3-line window

if (fileRecords.length === 0) {
  console.error('FATAL: no source file under src/ has >= 3 lines -- corpus would be empty.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Sampling: window length (3-40 lines), snippet kind, M per scenario.
// ─────────────────────────────────────────────────────────────────────────
const WINDOW_LEN_BUCKETS = [
  [[3, 8], 35],
  [[9, 15], 30],
  [[16, 25], 20],
  [[26, 40], 15],
];
const SNIPPET_KINDS = ['recently-edited', 'recently-opened', 'import-def', 'lsp-def', 'diff', 'rag'];
const M_WEIGHTS = [
  [1, 8],
  [2, 18],
  [3, 22],
  [4, 20],
  [5, 14],
  [6, 10],
  [7, 5],
  [8, 3],
];

function sampleWindowLength(rng) {
  const [lo, hi] = weightedPick(rng, WINDOW_LEN_BUCKETS);
  return randInt(rng, lo, hi);
}

function sampleSnippet(rng, windowLenCollector) {
  const file = fileRecords[randInt(rng, 0, fileRecords.length - 1)];
  const desiredLen = sampleWindowLength(rng);
  const len = Math.min(desiredLen, file.lines.length);
  const maxStart = file.lines.length - len; // inclusive
  const start = randInt(rng, 0, maxStart);
  const content = file.lines.slice(start, start + len).join('\n');
  if (windowLenCollector) windowLenCollector.push(len);
  return {
    uri: `file:///${file.relPath}`,
    filepath: file.relPath,
    content,
    kind: SNIPPET_KINDS[randInt(rng, 0, SNIPPET_KINDS.length - 1)],
    startLine: start,
    endLine: start + len - 1,
  };
}

function sampleM(rng) {
  return weightedPick(rng, M_WEIGHTS);
}

/** Fixed order as generated (deterministic given the seed); last = most relevant (prod contract). */
function buildScenario(rng, mCollector, windowLenCollector) {
  const m = sampleM(rng);
  if (mCollector) mCollector.push(m);
  const snippets = [];
  for (let k = 0; k < m; k++) snippets.push(sampleSnippet(rng, windowLenCollector));
  return snippets;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Fill-logic replica of mode.ts:83-112 -- both `break` (current prod) and
//    `continue` (proposed) variants share one loop, differing only in what
//    happens on overflow.
// ─────────────────────────────────────────────────────────────────────────
function formatSnippetAsComment(snippet, commentToken) {
  const header = `${commentToken} Path: ${snippet.filepath}`;
  const bodyLines = snippet.content.split('\n').map((line) => `${commentToken} ${line}`);
  return [header, ...bodyLines].join('\n');
}

/** stopMode: 'break' (current prod) | 'continue' (proposed). Returns survivor indices
 *  into `snippets`, restored to ORIGINAL array order (mirrors mode.ts's `.reverse()`). */
function fill(snippets, commentToken, budgetChars, stopMode) {
  const survivorIdx = [];
  let usedChars = 0;
  for (let i = snippets.length - 1; i >= 0; i--) {
    const block = formatSnippetAsComment(snippets[i], commentToken);
    const addedChars = block.length + 1; // +1 for the trailing newline separator
    if (usedChars + addedChars > budgetChars) {
      if (stopMode === 'break') break;
      continue; // proposed: skip this one whole, keep trying less-relevant ones
    }
    survivorIdx.push(i);
    usedChars += addedChars;
  }
  survivorIdx.reverse();
  return { survivorIdx, usedChars };
}

function assembleOutput(snippets, survivorIdx, commentToken, prunedPrefix) {
  if (survivorIdx.length === 0) return prunedPrefix;
  const blocks = survivorIdx.map((i) => formatSnippetAsComment(snippets[i], commentToken));
  return blocks.join('\n') + '\n' + prunedPrefix;
}

/**
 * Local replica of `takeWholeLinesWithinBudget` from
 * src/autocomplete/context/snippetBudgeter.ts:64-83 -- the UPSTREAM
 * per-snippet cap (500 raw chars, `PER_SNIPPET_CAP_CHARS`) every
 * `CrossFileSnippet` is already put through, via `buildSnapshot`, BEFORE it
 * can ever reach `injectSnippetsAsComments`. Self-checked below against the
 * real function extracted from dist, same discipline as the primary model.
 */
function takeWholeLinesWithinBudget(content, maxChars) {
  if (content.length <= maxChars) {
    return content;
  }
  const lines = content.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const addedChars = kept.length === 0 ? line.length : line.length + 1; // +1 for the '\n' joiner
    if (used + addedChars > maxChars) {
      break;
    }
    kept.push(line);
    used += addedChars;
  }
  return kept.length === 0 ? null : kept.join('\n');
}

/**
 * Pipeline-realism correction (NOT part of the brief's literal corpus spec,
 * added because reading snippetBudgeter.ts revealed the literal-brief corpus
 * below is not representative of what `injectSnippetsAsComments` actually
 * receives in production -- see the ЗА ГРАНИЦЕЙ note in the report). Applies
 * ONLY the per-snippet 500-char cap (`takeWholeLinesWithinBudget`); it does
 * NOT replicate `buildSnapshot`'s ladder/kind-quota/dedup machinery or its
 * own cross-snippet running-total budget check -- those are second-order
 * relative to the per-snippet cap (which is what makes the literal-brief
 * corpus's up-to-3000-char raw snippets unrepresentative in the first
 * place) and would require modeling `ScannedSnippet` ingestion order this
 * bench's corpus does not have. Snippets that don't fit even one whole line
 * within the cap are dropped, matching `buildSnapshot`'s skip-not-crop.
 */
function preTrimToUpstreamPerSnippetCap(snippets, perSnippetCapChars) {
  const trimmed = [];
  for (const s of snippets) {
    const trimmedContent = takeWholeLinesWithinBudget(s.content, perSnippetCapChars);
    if (trimmedContent === null) continue;
    trimmed.push(trimmedContent === s.content ? s : { ...s, content: trimmedContent });
  }
  return trimmed;
}

function analyzeScenario(snippets, commentToken, budgetChars) {
  const brk = fill(snippets, commentToken, budgetChars, 'break');
  const cont = fill(snippets, commentToken, budgetChars, 'continue');

  const breakSet = new Set(brk.survivorIdx);
  const contSet = new Set(cont.survivorIdx);
  for (const idx of breakSet) {
    if (!contSet.has(idx)) {
      // Both variants apply the identical greedy cumulative-budget test per item in
      // the same tail-to-head order; `continue` can only add to what `break` kept,
      // never remove. If this fires, the local model is wrong -- do not trust output.
      throw new Error(
        'INVARIANT VIOLATED: continue-fill dropped a snippet break-fill kept. The local fill model is inconsistent with itself -- refusing to report numbers.',
      );
    }
  }

  const salvagedCount = cont.survivorIdx.length - brk.survivorIdx.length;
  const salvagedChars = cont.usedChars - brk.usedChars;
  return {
    salvaged: salvagedCount > 0,
    salvagedCount,
    salvagedChars,
    breakCount: brk.survivorIdx.length,
    contCount: cont.survivorIdx.length,
    breakChars: brk.usedChars,
    contChars: cont.usedChars,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Edge scenarios (explicitly constructed, not sampled): an oversized
//    snippet placed LAST (highest priority -- checked first by the
//    tail-to-head walk) that alone blows the budget, preceded by smaller
//    lower-priority snippet(s) that individually fit. This is the exact
//    shape mode.ts's own docstring names (CF-23 / L6 I-14): a forward-break
//    keeps the least-relevant head and drops the most-relevant tail;
//    equivalently here, the tail-to-head break drops everything behind an
//    oversized high-priority item. Content is real code (same sampling
//    machinery, just with fixed window sizes/positions instead of random).
// ─────────────────────────────────────────────────────────────────────────
function realSnippetFromFile(file, len, kind) {
  const clamped = Math.min(len, file.lines.length);
  return {
    uri: `file:///${file.relPath}`,
    filepath: file.relPath,
    content: file.lines.slice(0, clamped).join('\n'),
    kind,
    startLine: 0,
    endLine: clamped - 1,
  };
}

function findOversizedSnippet(commentToken, budgetChars) {
  for (const file of fileRecords) {
    const snippet = realSnippetFromFile(file, 40, 'import-def');
    if (formatSnippetAsComment(snippet, commentToken).length + 1 > budgetChars) {
      return snippet;
    }
  }
  return null;
}

function findFittingSmallSnippet(commentToken, budgetChars, excludeRelPath) {
  for (const file of fileRecords) {
    if (file.relPath === excludeRelPath) continue;
    const snippet = realSnippetFromFile(file, 3, 'recently-opened');
    if (formatSnippetAsComment(snippet, commentToken).length + 1 <= budgetChars) {
      return snippet;
    }
  }
  return null;
}

function buildEdgeScenarios(commentToken, budgetChars) {
  const oversized = findOversizedSnippet(commentToken, budgetChars);
  if (!oversized) {
    console.error(
      `FATAL: could not find a real 40-line window under src/ whose comment-block exceeds the ${budgetChars}-char budget -- cannot construct the edge scenario. Corpus/assumptions need review.`,
    );
    process.exit(1);
  }
  const small1 = findFittingSmallSnippet(commentToken, budgetChars, oversized.filepath);
  if (!small1) {
    console.error('FATAL: could not find a real small (3-line) snippet that fits the budget -- cannot construct the edge scenario.');
    process.exit(1);
  }
  const small2 = findFittingSmallSnippet(commentToken, budgetChars, small1.filepath) ?? small1;

  // edge-A: minimal -- one small snippet, then the oversized one as most-relevant.
  const edgeA = [small1, oversized];
  // edge-B: multi-salvage -- two small snippets, then the oversized one as most-relevant.
  const edgeB = [small1, small2, oversized];
  return { edgeA, edgeB };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Self-check: extract the REAL injectSnippetsAsComments verbatim (as
//    source text) from the BUILT dist/extension.js bundle and compare its
//    output, char-for-char, against this script's local `break` replica.
//    The function is not re-exported by the extension's CJS entry point
//    (only activate/deactivate/buildRagMcpServer are), and the bundle's
//    module-scope code requires the external `vscode` module (unavailable
//    outside the editor host) -- so this extracts the exact compiled
//    function text (esbuild-transformed, target node18, unminified dev
//    build) between its stable `// src/<path>.ts` bundler markers and
//    evaluates ONLY that self-contained span. No logic is retyped.
// ─────────────────────────────────────────────────────────────────────────
function extractMarkedBlock(source, startMarker) {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`SELF-CHECK SETUP FAILED: marker "${startMarker}" not found in built dist. Bundle layout changed -- extraction is stale, do not trust this bench.`);
  }
  const bodyStart = startIdx + startMarker.length;
  const nextMarkerIdx = source.indexOf('\n// src/', bodyStart);
  if (nextMarkerIdx === -1) {
    throw new Error(`SELF-CHECK SETUP FAILED: no end-of-block marker found after "${startMarker}".`);
  }
  return source.slice(bodyStart, nextMarkerIdx);
}

function loadRealFunctionsFromDist() {
  let distSource;
  try {
    distSource = readFileSync(DIST_EXTENSION, 'utf8');
  } catch (e) {
    console.error(`FATAL: could not read built bundle at ${DIST_EXTENSION}.`);
    console.error('Run "npm run build" first -- this bench validates against the ACTUAL bundled');
    console.error('artifact (build-blind lesson: tsc/vitest never exercise the esbuild transform).');
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  }

  const languageInfoBlock = extractMarkedBlock(distSource, '// src/autocomplete/languageInfo.ts');
  const modeBlock = extractMarkedBlock(distSource, '// src/autocomplete/context/mode.ts');
  const snippetBudgeterBlock = extractMarkedBlock(distSource, '// src/autocomplete/context/snippetBudgeter.ts');

  if (!/function\s+getSingleLineComment\s*\(/.test(languageInfoBlock)) {
    throw new Error('SELF-CHECK SETUP FAILED: getSingleLineComment not found in the extracted dist languageInfo block.');
  }
  if (!/function\s+injectSnippetsAsComments\s*\(/.test(modeBlock)) {
    throw new Error('SELF-CHECK SETUP FAILED: injectSnippetsAsComments not found in the extracted dist mode block.');
  }
  if (!/function\s+takeWholeLinesWithinBudget\s*\(/.test(snippetBudgeterBlock)) {
    throw new Error('SELF-CHECK SETUP FAILED: takeWholeLinesWithinBudget not found in the extracted dist snippetBudgeter block.');
  }

  // Compile and run the extracted text with `vm.Script` in its own fresh
  // context (not `new Function`/`eval` in this script's own scope). SECURITY
  // NOTE on why this is safe here: the executed text comes from
  // dist/extension.js, THIS repo's own build artifact, produced
  // deterministically by `npm run build` from THIS repo's own src/ tree
  // moments before this script runs -- not user input, not network input,
  // nothing an external attacker controls. Anyone able to alter
  // dist/extension.js already has write access to this repository's source
  // and could run arbitrary code via `npm test`/`npm run build` regardless.
  // The sandbox context has no access to this script's own closures, ambient
  // `require`, or Node globals beyond what `vm` seeds by default.
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(
    `${languageInfoBlock}\n${modeBlock}\n${snippetBudgeterBlock}\n` +
      'var __real__ = { injectSnippetsAsComments, getSingleLineComment, takeWholeLinesWithinBudget, PER_SNIPPET_CAP_CHARS };',
    { filename: 'fim-latency-bench-dist-extraction-sandbox.js' },
  ).runInContext(sandbox);
  return sandbox.__real__;
}

function runSelfCheck(real, commentToken, budgetChars, scenarios) {
  console.log('\n=== SELF-CHECK vs the REAL (built dist) injectSnippetsAsComments ===');
  let allPass = true;
  scenarios.forEach(({ label, snippets }, idx) => {
    const prunedPrefix = `/* prunedPrefix-placeholder-${idx} */\n`;
    const realOut = real.injectSnippetsAsComments(prunedPrefix, snippets, LANGUAGE_ID, budgetChars);

    const brk = fill(snippets, commentToken, budgetChars, 'break');
    const myOut = assembleOutput(snippets, brk.survivorIdx, commentToken, prunedPrefix);

    const match = myOut === realOut;
    console.log(`  [${match ? 'OK' : 'MISMATCH'}] ${label} (M=${snippets.length}, break-survivors=${brk.survivorIdx.length})`);
    if (!match) {
      allPass = false;
      console.error(`    MODEL (first 300 chars): ${JSON.stringify(myOut.slice(0, 300))}`);
      console.error(`    REAL  (first 300 chars): ${JSON.stringify(realOut.slice(0, 300))}`);
    }
  });
  if (!allPass) {
    console.error('\nFATAL: self-check against the REAL built injectSnippetsAsComments FAILED.');
    console.error('The local break-model diverges from the compiled artifact -- the salvage numbers');
    console.error('this bench would print cannot be trusted. Not printing them.');
    process.exit(1);
  }
  console.log('  All scenarios match the built dist function byte-for-byte -- model is trustworthy.');
}

/** Same discipline as `runSelfCheck`, for the upstream per-snippet-cap replica. */
function runTrimSelfCheck(real, perSnippetCapChars, sampleContents) {
  console.log('\n=== SELF-CHECK vs the REAL (built dist) takeWholeLinesWithinBudget ===');
  let allPass = true;
  sampleContents.forEach((content, idx) => {
    const mine = takeWholeLinesWithinBudget(content, perSnippetCapChars);
    const realResult = real.takeWholeLinesWithinBudget(content, perSnippetCapChars);
    const match = mine === realResult;
    console.log(`  [${match ? 'OK' : 'MISMATCH'}] sample #${idx} (${content.length} raw chars) -> trimmed=${mine === null ? 'null' : mine.length + ' chars'}`);
    if (!match) allPass = false;
  });
  if (!allPass) {
    console.error('\nFATAL: self-check against the REAL built takeWholeLinesWithinBudget FAILED.');
    console.error('The pipeline-realistic pre-trim pass cannot be trusted. Not printing it.');
    process.exit(1);
  }
  console.log('  All samples match the built dist function byte-for-byte -- pre-trim model is trustworthy.');
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Stats helpers.
// ─────────────────────────────────────────────────────────────────────────
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function fmt(n, decimals = 2) {
  return Number(n).toFixed(decimals);
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────
function main() {
  console.log('FIM inject-budget salvage-fraction bench (layer 1, deterministic) -- Step 3a / Sec 5 measurement');
  console.log(`repo root:   ${REPO_ROOT}`);
  console.log(`seed:        0x${SEED.toString(16)}`);
  console.log(`scenarios:   ${N_SCENARIOS}`);
  console.log(`budget:      ${DEFAULT_INJECT_BUDGET_CHARS} chars (DEFAULT_INJECT_BUDGET_CHARS)`);
  console.log(`languageId:  ${LANGUAGE_ID}`);
  console.log(`corpus:      ${fileRecords.length} real .ts/.tsx files under src/ (>= 3 lines each)`);

  const real = loadRealFunctionsFromDist();
  const commentToken = real.getSingleLineComment(LANGUAGE_ID);
  if (commentToken !== '//') {
    throw new Error(`SELF-CHECK SETUP FAILED: expected '//' for languageId '${LANGUAGE_ID}', got ${JSON.stringify(commentToken)}.`);
  }

  const { edgeA, edgeB } = buildEdgeScenarios(commentToken, DEFAULT_INJECT_BUDGET_CHARS);

  const rng = mulberry32(SEED);
  const mValues = [];
  const windowLenValues = [];
  const scenarios = [];
  for (let s = 0; s < N_SCENARIOS; s++) {
    scenarios.push(buildScenario(rng, mValues, windowLenValues));
  }

  // Self-check BEFORE reporting anything else: edge scenarios + first 3 random ones.
  runSelfCheck(real, commentToken, DEFAULT_INJECT_BUDGET_CHARS, [
    { label: 'edge-A (1 fitting small + 1 oversized-priority)', snippets: edgeA },
    { label: 'edge-B (2 fitting small + 1 oversized-priority)', snippets: edgeB },
    { label: 'random scenario #1', snippets: scenarios[0] },
    { label: 'random scenario #2', snippets: scenarios[1] },
    { label: 'random scenario #3', snippets: scenarios[2] },
  ]);

  // Edge-scenario sanity: the metric MUST detect salvage where it provably exists.
  const edgeAResult = analyzeScenario(edgeA, commentToken, DEFAULT_INJECT_BUDGET_CHARS);
  const edgeBResult = analyzeScenario(edgeB, commentToken, DEFAULT_INJECT_BUDGET_CHARS);
  console.log('\n=== EDGE-SCENARIO SANITY (metric must catch salvage when it exists) ===');
  console.log(`  edge-A: salvaged=${edgeAResult.salvaged}  (+${edgeAResult.salvagedCount} snippets, +${edgeAResult.salvagedChars} chars)`);
  console.log(`  edge-B: salvaged=${edgeBResult.salvaged}  (+${edgeBResult.salvagedCount} snippets, +${edgeBResult.salvagedChars} chars)`);
  if (!edgeAResult.salvaged || !edgeBResult.salvaged) {
    console.error('\nFATAL: the constructed edge scenario(s) did NOT show salvage. Either the metric is not');
    console.error('sensitive or the fixtures are wrong -- the numbers below cannot be trusted.');
    process.exit(1);
  }

  if (real.PER_SNIPPET_CAP_CHARS !== 500) {
    throw new Error(`SELF-CHECK SETUP FAILED: expected PER_SNIPPET_CAP_CHARS=500, got ${real.PER_SNIPPET_CAP_CHARS}.`);
  }
  runTrimSelfCheck(real, real.PER_SNIPPET_CAP_CHARS, [
    scenarios[0][0].content,
    scenarios[1][0].content,
    edgeA[0].content, // small -- exercises the "fits unchanged" branch
    edgeA[1].content, // oversized -- exercises the "trim to whole lines" branch
  ]);

  // Main measurement over the random real-code corpus.
  const results = scenarios.map((sc) => analyzeScenario(sc, commentToken, DEFAULT_INJECT_BUDGET_CHARS));
  const salvagedScenarios = results.filter((r) => r.salvaged);
  const salvageFractionPct = (salvagedScenarios.length / N_SCENARIOS) * 100;

  const extraSnippetsAll = results.map((r) => r.salvagedCount);
  const extraCharsAll = results.map((r) => r.salvagedChars);
  const extraSnippetsWhenSalvaged = salvagedScenarios.map((r) => r.salvagedCount);
  const extraCharsWhenSalvaged = salvagedScenarios.map((r) => r.salvagedChars);
  const breakCounts = results.map((r) => r.breakCount);
  const contCounts = results.map((r) => r.contCount);
  const breakChars = results.map((r) => r.breakChars);
  const contChars = results.map((r) => r.contChars);

  const mCounts = {};
  for (const m of mValues) mCounts[m] = (mCounts[m] ?? 0) + 1;

  console.log('\n=== CORPUS (realized sampling) ===');
  console.log(`  M (snippets/scenario) counts: ${JSON.stringify(mCounts)}`);
  console.log(`  M mean=${fmt(mean(mValues))}  median=${median(mValues)}`);
  console.log(
    `  window length (lines) mean=${fmt(mean(windowLenValues))}  median=${median(windowLenValues)}  min=${Math.min(...windowLenValues)}  max=${Math.max(...windowLenValues)}`,
  );

  console.log('\n=== SALVAGE FRACTION (main metric) ===');
  console.log(`  scenarios where continue salvaged >= 1 extra snippet that break dropped: ${salvagedScenarios.length} / ${N_SCENARIOS}`);
  console.log(`  SALVAGE FRACTION: ${fmt(salvageFractionPct)}%`);

  console.log('\n=== SIZE / COUNT STATS ===');
  console.log(
    `  extra snippets salvaged -- mean over ALL scenarios: ${fmt(mean(extraSnippetsAll))}   mean over SALVAGED-ONLY: ${fmt(mean(extraSnippetsWhenSalvaged))}`,
  );
  console.log(
    `  extra chars    salvaged -- mean over ALL scenarios: ${fmt(mean(extraCharsAll))}   mean over SALVAGED-ONLY: ${fmt(mean(extraCharsWhenSalvaged))}`,
  );
  console.log(
    `  block count -- break: mean=${fmt(mean(breakCounts))} median=${median(breakCounts)}   continue: mean=${fmt(mean(contCounts))} median=${median(contCounts)}`,
  );
  console.log(
    `  block chars -- break: mean=${fmt(mean(breakChars))} median=${median(breakChars)}   continue: mean=${fmt(mean(contChars))} median=${median(contChars)}`,
  );

  function verdictLine(pct) {
    if (pct < 1) return `${fmt(pct)}% -- effectively 0. Hygiene without measurable value on this corpus.`;
    if (pct < 5) return `${fmt(pct)}% -- small but non-zero. Marginal value; weigh against the diff/review cost.`;
    return `${fmt(pct)}% -- significant. break->continue would measurably help on this corpus.`;
  }

  console.log('\n=== VERDICT (LITERAL-BRIEF corpus: raw 3-40-line windows, no upstream cap) ===');
  console.log(`  Salvage fraction is ${verdictLine(salvageFractionPct)}`);

  // ── ЗА ГРАНИЦЕЙ finding, addressed within this one allowed file: reading
  // mode.ts's own docstring ("Snippets are already mode-budgeted by the
  // host-side budgeter") led to src/autocomplete/context/snippetBudgeter.ts,
  // which caps every real CrossFileSnippet.content at PER_SNIPPET_CAP_CHARS
  // (500 raw chars) BEFORE it can ever reach injectSnippetsAsComments. The
  // literal-brief corpus above samples raw 3-40-line windows with NO such
  // cap (up to ~3000 raw chars), so individual snippets there are often
  // already bigger than the entire 512 budget by themselves -- not
  // representative of production input. This second pass pre-trims the
  // SAME corpus/scenarios through the REAL upstream cap function (self-
  // checked above) to show how much that changes the picture.
  const pipelineResults = scenarios.map((sc) =>
    analyzeScenario(preTrimToUpstreamPerSnippetCap(sc, real.PER_SNIPPET_CAP_CHARS), commentToken, DEFAULT_INJECT_BUDGET_CHARS),
  );
  const pipelineSalvaged = pipelineResults.filter((r) => r.salvaged);
  const pipelineSalvageFractionPct = (pipelineSalvaged.length / N_SCENARIOS) * 100;
  const pipelineExtraSnippetsAll = pipelineResults.map((r) => r.salvagedCount);
  const pipelineExtraCharsAll = pipelineResults.map((r) => r.salvagedChars);
  const pipelineExtraSnippetsWhenSalvaged = pipelineSalvaged.map((r) => r.salvagedCount);
  const pipelineExtraCharsWhenSalvaged = pipelineSalvaged.map((r) => r.salvagedChars);

  console.log('\n=== SUPPLEMENTARY: PIPELINE-REALISTIC PASS (same corpus, pre-trimmed to the REAL ===');
  console.log('=== upstream 500-char-per-snippet cap from snippetBudgeter.ts -- see caveat below) ===');
  console.log(`  scenarios where continue salvaged >= 1 extra snippet that break dropped: ${pipelineSalvaged.length} / ${N_SCENARIOS}`);
  console.log(`  SALVAGE FRACTION (pipeline-realistic): ${fmt(pipelineSalvageFractionPct)}%`);
  console.log(
    `  extra snippets salvaged -- mean over ALL scenarios: ${fmt(mean(pipelineExtraSnippetsAll))}   mean over SALVAGED-ONLY: ${fmt(mean(pipelineExtraSnippetsWhenSalvaged))}`,
  );
  console.log(
    `  extra chars    salvaged -- mean over ALL scenarios: ${fmt(mean(pipelineExtraCharsAll))}   mean over SALVAGED-ONLY: ${fmt(mean(pipelineExtraCharsWhenSalvaged))}`,
  );
  console.log(`  VERDICT (pipeline-realistic): ${verdictLine(pipelineSalvageFractionPct)}`);

  console.log('\n=== CAVEAT ===');
  console.log('  This corpus is REAL code windows sampled from this repo\'s own src/ tree, but the');
  console.log('  SAMPLING POLICY (window-length buckets, M-per-scenario distribution, scenario');
  console.log('  order) is synthetic, not live editor telemetry.');
  console.log('  The LITERAL-BRIEF number (raw windows, no upstream cap) likely OVERSTATES real-world');
  console.log('  salvage frequency: every real CrossFileSnippet is already capped at 500 raw chars by');
  console.log('  snippetBudgeter.ts before it can reach injectSnippetsAsComments, so in production an');
  console.log('  overflow at THIS formatter is normally a narrow-margin event driven by comment-prefix');
  console.log('  formatting overhead, not raw content size. The PIPELINE-REALISTIC number above corrects');
  console.log('  for the dominant factor (the per-snippet cap) but does NOT replicate buildSnapshot\'s');
  console.log('  ladder/kind-quota/dedup/cross-snippet-running-total logic -- treat it as a closer, still');
  console.log('  imperfect, bound, not a production-traffic guarantee. Neither number is a universal claim');
  console.log('  about live traffic. Layer 2 (live time-to-first-token) is not built.');
}

main();
