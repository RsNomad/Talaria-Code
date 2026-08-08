import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_CATALOG, type CatalogModel } from './setup/modelCatalog';

/**
 * beta.6 T18 (§3.5, A/B-F8): anchor-parity lock between
 * `media/walkthrough-setup.md`'s static "Recommended local models" section
 * (Home 2 — the walkthrough is the named start screen) and `MODEL_CATALOG`
 * (the single source of truth every number ultimately comes from).
 *
 * Deliberately NOT `walkthroughParity.test.ts`'s mechanism — that file locks
 * MANIFEST ROUTING (`package.json`'s walkthrough step → `talaria.openSetup`),
 * not markdown content; this is a SEPARATE, markdown-content parser. It
 * parses ONLY the machine anchors (`<!-- rec:{catalogId}:{exactBytes} -->`)
 * — never a prose regex over the human-readable line itself, so future copy
 * edits (wording, punctuation, GPU-size parentheticals) can't spuriously
 * break this lock. Each anchor's "human line" is simply "the next non-empty
 * line after the anchor" (a structural read, not a content-sniffing one);
 * from THAT line this test extracts only the trailing `N.N GiB` token.
 *
 * What this proves: a `MODEL_CATALOG` byte edit that the walkthrough forgets
 * to mirror goes RED here — the SAME drift the recs strip's B-F1
 * self-truing property already closes on the dynamic (Setup panel) side.
 */

const WALKTHROUGH_PATH = join(__dirname, '../../media/walkthrough-setup.md');
const BYTES_PER_GIB = 2 ** 30;

/** §6 rounding rule: bytes/2^30, 1 decimal, half-up, exact-bytes only. */
function roundGiB(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GIB) * 10) / 10;
}

/** B-F5's "default-path/Ollama-tier bytes" rule, mirrored host-side (the
 *  SAME quantity `SetupController.ts` projects onto the wire as
 *  `ollamaApproxBytes`, and the SAME quantity the Setup panel's
 *  `RoleRec.bytes` carries — see `webview/src/panels/setupCards.ts`). */
function defaultPathBytes(row: CatalogModel): number {
  if (row.ollama?.tier === 'library') return row.ollama.approxBytes;
  if (row.ollama?.tier === 'hf-ingest') return row.ollama.gguf.approxBytes;
  throw new Error(`catalog row "${row.id}" has no ollama entry — defaultPathBytes() cannot resolve a size`);
}

interface ParsedAnchor {
  id: string;
  bytes: number;
  /** The line immediately following the anchor comment (skipping blank
   *  lines) — the ONLY thing this parser reads besides the anchor itself. */
  humanLine: string;
}

const ANCHOR_RE = /^<!--\s*rec:([A-Za-z0-9_.-]+):(\d+)\s*-->$/;

/** Structural anchor parser — walks the file line-by-line, matches ONLY the
 *  narrow anchor-comment pattern, and records the very next non-blank line
 *  as that anchor's "human line". Never scans free text for names/numbers. */
function parseAnchors(markdown: string): ParsedAnchor[] {
  const lines = markdown.split('\n');
  const anchors: ParsedAnchor[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = ANCHOR_RE.exec(line.trim());
    if (!m) continue;
    const id = m[1];
    const bytesText = m[2];
    if (id === undefined || bytesText === undefined) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
    anchors.push({ id, bytes: Number(bytesText), humanLine: lines[j] ?? '' });
  }
  return anchors;
}

/** The one narrow, anchor-scoped extraction this test performs on a human
 *  line: pull the trailing `N.N GiB` token. Never applied to the document
 *  at large — only to the single line an anchor already pinpointed. */
function extractPrintedGiB(humanLine: string): number {
  const m = /(\d+\.\d) GiB/.exec(humanLine);
  if (!m || m[1] === undefined) {
    throw new Error(`no "N.N GiB" token found in anchor-adjacent line: "${humanLine}"`);
  }
  return Number(m[1]);
}

const ROLE_ANCHOR_IDS = ['devstral-24b', 'qwen25-coder-1.5b', 'qwen3-embedding-0.6b', 'sweep-next'] as const;

describe('walkthrough recs — anchor parity with MODEL_CATALOG (T18, §3.5/A-B-F8)', () => {
  const markdown = readFileSync(WALKTHROUGH_PATH, 'utf-8');
  const anchors = parseAnchors(markdown);

  function mustAnchor(id: string): ParsedAnchor {
    const found = anchors.find((a) => a.id === id);
    if (!found) throw new Error(`no "<!-- rec:${id}:... -->" anchor found in the walkthrough`);
    return found;
  }

  function mustCatalogRow(id: string): CatalogModel {
    const found = MODEL_CATALOG.find((m) => m.id === id);
    if (!found) throw new Error(`fixture bug: "${id}" is not a MODEL_CATALOG id`);
    return found;
  }

  it('carries all four role anchors + the stack anchor (LIST layout — no table)', () => {
    expect(anchors.map((a) => a.id)).toEqual(expect.arrayContaining([...ROLE_ANCHOR_IDS, 'stack']));
    // LIST layout, not a table: no markdown table pipe/header-separator row
    // anywhere in the recs section.
    expect(markdown).not.toMatch(/\|\s*---/);
  });

  it.each(ROLE_ANCHOR_IDS)('%s: anchor bytes ≡ MODEL_CATALOG bytes (defaultForRole row)', (id) => {
    const row = mustCatalogRow(id);
    expect(row.defaultForRole).toBe(true);
    expect(mustAnchor(id).bytes).toBe(defaultPathBytes(row));
  });

  it.each(ROLE_ANCHOR_IDS)('%s: printed size ≡ rule-rounded anchor bytes', (id) => {
    const anchor = mustAnchor(id);
    expect(extractPrintedGiB(anchor.humanLine)).toBe(roundGiB(anchor.bytes));
  });

  it('stack anchor bytes ≡ the EXACT sum of the three non-NEXT role anchors (agent+fim+embedding)', () => {
    const sumBytes = ['devstral-24b', 'qwen25-coder-1.5b', 'qwen3-embedding-0.6b']
      .map((id) => mustAnchor(id).bytes)
      .reduce((a, b) => a + b, 0);
    expect(mustAnchor('stack').bytes).toBe(sumBytes);
  });

  it('stack-sum printed size ≡ rule-rounded exact byte sum', () => {
    const stack = mustAnchor('stack');
    expect(extractPrintedGiB(stack.humanLine)).toBe(roundGiB(stack.bytes));
  });

  it('every anchor id is a real MODEL_CATALOG id (or the literal "stack" marker) — no stray/mistyped anchors', () => {
    const catalogIds = new Set(MODEL_CATALOG.map((m) => m.id));
    for (const a of anchors) {
      expect(a.id === 'stack' || catalogIds.has(a.id)).toBe(true);
    }
  });
});
