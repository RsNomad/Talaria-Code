import { describe, it, expect } from 'vitest';
import { coalesceTarget } from './resultShaper';
import type { PlainDocumentSymbol, PlainSymbolInformation } from './resultShaper';
import {
  toPlainPosition,
  toPlainRange,
  mapDefinitionTargets,
  mapReferences,
  mapDocumentSymbols,
  mapWorkspaceSymbols,
  mapHover,
  mapDiagnosticsForUri,
  mapDiagnosticsDump,
} from './lspResultMap';
import type {
  UriLike,
  PositionLike,
  RangeLike,
  LocationLike,
  LocationLinkLike,
  SymbolInformationLike,
  DocumentSymbolLike,
  DiagnosticLike,
  HoverLike,
} from './lspResultMap';
import { must } from '../../testing/must';

/**
 * W3 (LIB) · T7a tests — the pure `vscode.* → plain` result mapper (the I-1
 * carry from the T6b review; research doc §5.1/§5.2, brief
 * `w3-t7a-brief.md`). Exhaustive per the brief's SIX mandatory I-1
 * extraction cases (each proves a confinement-critical uri/discriminant
 * extraction) plus totality.
 */

// ---------------------------------------------------------------------------
// Fixture builders — duck-typed stand-ins for real vscode.* objects
// ---------------------------------------------------------------------------

function uri(s: string): UriLike {
  return { toString: () => s };
}

function pos(line: number, character: number): PositionLike {
  return { line, character };
}

function range(startLine: number, startChar: number, endLine: number, endChar: number): RangeLike {
  return { start: pos(startLine, startChar), end: pos(endLine, endChar) };
}

// ---------------------------------------------------------------------------
// toPlainPosition / toPlainRange
// ---------------------------------------------------------------------------

describe('toPlainPosition', () => {
  it('converts a well-formed position 1:1', () => {
    expect(toPlainPosition(pos(3, 7))).toEqual({ line: 3, character: 7 });
  });

  it('clamps negative/non-finite coordinates to 0 (totality)', () => {
    expect(toPlainPosition(pos(-1, -5))).toEqual({ line: 0, character: 0 });
    expect(toPlainPosition(pos(NaN, Infinity))).toEqual({ line: 0, character: 0 });
  });

  it('floors a non-integer coordinate', () => {
    expect(toPlainPosition(pos(2.9, 4.1))).toEqual({ line: 2, character: 4 });
  });
});

describe('toPlainRange', () => {
  it('converts a well-formed range 1:1', () => {
    expect(toPlainRange(range(1, 2, 3, 4))).toEqual({
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    });
  });

  it('never throws for malformed coordinates (totality)', () => {
    expect(() => toPlainRange(range(-1, NaN, Infinity, -99))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// I-1(a) — Location uri extraction
// ---------------------------------------------------------------------------

describe('mapDefinitionTargets — I-1(a) Location uri extraction', () => {
  it('extracts PlainLocation.uri via uri.toString(), range copied verbatim', () => {
    const loc: LocationLike = { uri: uri('file:///a.ts'), range: range(1, 1, 1, 5) };
    const [mapped] = mapDefinitionTargets([loc]);
    expect(mapped).toEqual({ uri: 'file:///a.ts', range: { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } } });
  });
});

// ---------------------------------------------------------------------------
// I-1(b) — LocationLink targetUri + discriminant + coalesceTarget proof
// ---------------------------------------------------------------------------

describe('mapDefinitionTargets — I-1(b) LocationLink targetUri + coalesceTarget proof', () => {
  it('extracts PlainLocationLink.targetUri via targetUri.toString() (NOT a source uri)', () => {
    const link: LocationLinkLike = {
      targetUri: uri('file:///target.ts'),
      targetRange: range(2, 0, 2, 8),
    };
    const [mapped] = mapDefinitionTargets([link]);
    expect(mapped).toEqual({
      targetUri: 'file:///target.ts',
      targetRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
      targetSelectionRange: undefined,
    });
  });

  it('downstream coalesceTarget yields {uri: targetUri, range: targetRange} — the TARGET, not the origin', () => {
    const link: LocationLinkLike = {
      targetUri: uri('file:///target.ts'),
      targetRange: range(5, 0, 5, 10),
      targetSelectionRange: range(5, 2, 5, 6),
    };
    const [mapped] = mapDefinitionTargets([link]);
    expect(coalesceTarget(must(mapped))).toEqual({
      uri: 'file:///target.ts',
      range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
    });
  });

  it('carries targetSelectionRange through when present', () => {
    const link: LocationLinkLike = {
      targetUri: uri('file:///t.ts'),
      targetRange: range(0, 0, 0, 1),
      targetSelectionRange: range(0, 0, 0, 1),
    };
    const [mapped] = mapDefinitionTargets([link]);
    expect(mapped).toMatchObject({
      targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    });
  });

  it('discriminates a MIXED Location/LocationLink array item-by-item, preserving order', () => {
    const loc: LocationLike = { uri: uri('file:///source.ts'), range: range(0, 0, 0, 1) };
    const link: LocationLinkLike = { targetUri: uri('file:///target.ts'), targetRange: range(9, 0, 9, 1) };
    const mapped = mapDefinitionTargets([loc, link]);
    expect(mapped).toHaveLength(2);
    const [first, second] = mapped;
    expect(first).toEqual({ uri: 'file:///source.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
    const secondTarget = must(second);
    expect('targetUri' in secondTarget && secondTarget.targetUri).toBe('file:///target.ts');
  });
});

// ---------------------------------------------------------------------------
// mapReferences
// ---------------------------------------------------------------------------

describe('mapReferences', () => {
  it('maps every LocationLike to a PlainLocation via uri.toString()', () => {
    const refs: LocationLike[] = [
      { uri: uri('file:///a.ts'), range: range(0, 0, 0, 1) },
      { uri: uri('file:///b.ts'), range: range(1, 0, 1, 1) },
    ];
    expect(mapReferences(refs)).toEqual([
      { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      { uri: 'file:///b.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// I-1(c) — SymbolInformation.location.uri extraction + missing-range
// ---------------------------------------------------------------------------

describe('mapDocumentSymbols — I-1(c) SymbolInformation.location.uri + missing-range', () => {
  it('extracts location.uri via toString() and copies the range when present', () => {
    const sym: SymbolInformationLike = {
      name: 'foo',
      kind: 11,
      location: { uri: uri('file:///sym.ts'), range: range(3, 0, 3, 3) },
    };
    const [mapped] = mapDocumentSymbols([sym]);
    expect(mapped).toEqual({
      name: 'foo',
      kind: 11,
      containerName: undefined,
      location: { uri: 'file:///sym.ts', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } } },
    });
  });

  it('renders location.range === undefined for a missing-range SymbolInformation (never assumes it exists)', () => {
    const sym: SymbolInformationLike = {
      name: 'partial',
      kind: 12,
      location: { uri: uri('file:///partial.ts') },
    };
    const [mapped] = mapDocumentSymbols([sym]);
    const info = mapped as PlainSymbolInformation;
    expect(info.location.uri).toBe('file:///partial.ts');
    expect(info.location.range).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// I-1(d) — DocumentSymbol vs SymbolInformation discrimination + recursion
// ---------------------------------------------------------------------------

describe('mapDocumentSymbols — I-1(d) DocumentSymbol vs SymbolInformation discrimination', () => {
  it('maps a hierarchical DocumentSymbolLike (with children) to a nested PlainDocumentSymbol, recursion preserved', () => {
    const child: DocumentSymbolLike = {
      name: 'child',
      kind: 5,
      range: range(2, 0, 2, 5),
      selectionRange: range(2, 0, 2, 5),
      children: [],
    };
    const parent: DocumentSymbolLike = {
      name: 'parent',
      detail: 'class Parent',
      kind: 4,
      range: range(0, 0, 5, 0),
      selectionRange: range(0, 6, 0, 12),
      children: [child],
    };
    const [mapped] = mapDocumentSymbols([parent]);
    const docSym = mapped as PlainDocumentSymbol;
    expect(docSym.name).toBe('parent');
    expect(docSym.detail).toBe('class Parent');
    expect(docSym.children).toHaveLength(1);
    expect(docSym.children[0]).toEqual({
      name: 'child',
      detail: undefined,
      kind: 5,
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
      selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
      children: [],
    });
  });

  it('maps a flat SymbolInformationLike (no children field) to a PlainSymbolInformation', () => {
    const sym: SymbolInformationLike = {
      name: 'flatSym',
      kind: 6,
      containerName: 'Container',
      location: { uri: uri('file:///flat.ts'), range: range(1, 1, 1, 2) },
    };
    const [mapped] = mapDocumentSymbols([sym]);
    expect(mapped).not.toHaveProperty('children');
    expect(mapped).toEqual({
      name: 'flatSym',
      kind: 6,
      containerName: 'Container',
      location: { uri: 'file:///flat.ts', range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } } },
    });
  });

  it('discriminates correctly in a MIXED array (DocumentSymbol + SymbolInformation together)', () => {
    const docSym: DocumentSymbolLike = {
      name: 'hierFn',
      kind: 11,
      range: range(0, 0, 1, 0),
      selectionRange: range(0, 0, 0, 6),
      children: [],
    };
    const flatSym: SymbolInformationLike = {
      name: 'legacySym',
      kind: 12,
      location: { uri: uri('file:///legacy.ts'), range: range(2, 0, 2, 1) },
    };
    const mapped = mapDocumentSymbols([docSym, flatSym]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toHaveProperty('children');
    expect(mapped[1]).not.toHaveProperty('children');
    expect((mapped[1] as PlainSymbolInformation).location.uri).toBe('file:///legacy.ts');
  });
});

// ---------------------------------------------------------------------------
// mapWorkspaceSymbols — missing-range-safe
// ---------------------------------------------------------------------------

describe('mapWorkspaceSymbols — missing-range-safe', () => {
  it('maps SymbolInformationLike[] to PlainSymbolInformation[], preserving a present range', () => {
    const sym: SymbolInformationLike = {
      name: 'ws',
      kind: 4,
      location: { uri: uri('file:///ws.ts'), range: range(0, 0, 0, 2) },
    };
    expect(mapWorkspaceSymbols([sym])).toEqual([
      {
        name: 'ws',
        kind: 4,
        containerName: undefined,
        location: { uri: 'file:///ws.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } },
      },
    ]);
  });

  it('omits the range when a provider legitimately returns a partial location (no range)', () => {
    const sym: SymbolInformationLike = { name: 'partial', kind: 4, location: { uri: uri('file:///p.ts') } };
    const [mapped] = mapWorkspaceSymbols([sym]);
    expect(must(mapped).location.range).toBeUndefined();
    expect(must(mapped).location.uri).toBe('file:///p.ts');
  });
});

// ---------------------------------------------------------------------------
// I-1(e) — Diagnostic[] → group with the correct resource uri
// ---------------------------------------------------------------------------

describe('mapDiagnosticsForUri / mapDiagnosticsDump — I-1(e) correct resource uri + code/severity normalize', () => {
  it('mapDiagnosticsForUri attaches the given uri to the single group', () => {
    const diags: DiagnosticLike[] = [
      { range: range(0, 0, 0, 1), message: 'oops', severity: 0 },
    ];
    expect(mapDiagnosticsForUri(diags, 'file:///d.ts')).toEqual({
      uri: 'file:///d.ts',
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'oops', severity: 0, source: undefined, code: undefined },
      ],
    });
  });

  it('mapDiagnosticsDump attaches each [uri, diags] pair\'s OWN uri (via toString()) to its own group', () => {
    const dump: ReadonlyArray<readonly [UriLike, readonly DiagnosticLike[]]> = [
      [uri('file:///one.ts'), [{ range: range(0, 0, 0, 1), message: 'm1', severity: 1 }]],
      [uri('file:///two.ts'), [{ range: range(1, 0, 1, 1), message: 'm2', severity: 2 }]],
    ];
    const groups = mapDiagnosticsDump(dump);
    expect(groups).toHaveLength(2);
    const [first, second] = groups;
    expect(must(first).uri).toBe('file:///one.ts');
    expect(must(must(first).diagnostics[0]).message).toBe('m1');
    expect(must(second).uri).toBe('file:///two.ts');
    expect(must(must(second).diagnostics[0]).message).toBe('m2');
  });

  it('normalizes code: absent -> undefined, number -> String(n), {value} -> String(value)', () => {
    const diags: DiagnosticLike[] = [
      { range: range(0, 0, 0, 1), message: 'a', severity: 0 },
      { range: range(0, 0, 0, 1), message: 'b', severity: 0, code: 42 },
      { range: range(0, 0, 0, 1), message: 'c', severity: 0, code: { value: 'TS1234' } },
      { range: range(0, 0, 0, 1), message: 'd', severity: 0, code: 'literal-code' },
    ];
    const group = mapDiagnosticsForUri(diags, 'file:///c.ts');
    expect(group.diagnostics.map((d) => d.code)).toEqual([undefined, '42', 'TS1234', 'literal-code']);
  });

  it('keeps severity as the raw vscode ordinal — no label mapping performed here', () => {
    const diags: DiagnosticLike[] = [
      { range: range(0, 0, 0, 1), message: 'e', severity: 0 },
      { range: range(0, 0, 0, 1), message: 'w', severity: 1 },
      { range: range(0, 0, 0, 1), message: 'i', severity: 2 },
      { range: range(0, 0, 0, 1), message: 'h', severity: 3 },
    ];
    const group = mapDiagnosticsForUri(diags, 'file:///s.ts');
    expect(group.diagnostics.map((d) => d.severity)).toEqual([0, 1, 2, 3]);
  });

  // -------------------------------------------------------------------------
  // AU-17 — `code: null` must never reach `String(code.value)` (TypeError,
  // `typeof null === 'object'`, killing diagnostics for the WHOLE result —
  // violates INV-17 "mappers never throw"). Fuzzed against a few other
  // malformed object-shaped codes too (guard `.value` presence, not just the
  // declared structural type).
  // -------------------------------------------------------------------------

  it('AU-17: normalizes a null/malformed code to undefined instead of throwing (totality)', () => {
    const diags: DiagnosticLike[] = [
      { range: range(0, 0, 0, 1), message: 'null-code', severity: 0, code: null as unknown as DiagnosticLike['code'] },
      { range: range(0, 0, 0, 1), message: 'empty-object-code', severity: 0, code: {} as unknown as DiagnosticLike['code'] },
      { range: range(0, 0, 0, 1), message: 'null-value-code', severity: 0, code: { value: null } as unknown as DiagnosticLike['code'] },
    ];

    expect(() => mapDiagnosticsForUri(diags, 'file:///n.ts')).not.toThrow();
    const group = mapDiagnosticsForUri(diags, 'file:///n.ts');
    expect(group.diagnostics.map((d) => d.code)).toEqual([undefined, undefined, undefined]);
  });
});

// ---------------------------------------------------------------------------
// I-1(f) — Hover.contents → string[] flatten
// ---------------------------------------------------------------------------

describe('mapHover — I-1(f) contents flatten', () => {
  it('flattens a bare string content to itself', () => {
    const hover: HoverLike = { contents: ['plain text'] };
    expect(mapHover([hover])).toEqual(['plain text']);
  });

  it('flattens a MarkupContent-shaped {value} to its value', () => {
    const hover: HoverLike = { contents: [{ value: 'markup value' }] };
    expect(mapHover([hover])).toEqual(['markup value']);
  });

  it('flattens a MarkedString {language,value} to its value', () => {
    const hover: HoverLike = { contents: [{ language: 'typescript', value: 'const x: number' }] };
    expect(mapHover([hover])).toEqual(['const x: number']);
  });

  it('drops empty-string contents', () => {
    const hover: HoverLike = { contents: ['', 'kept', { value: '' }] };
    expect(mapHover([hover])).toEqual(['kept']);
  });

  it('flattens across multiple Hover entries into one list', () => {
    const hovers: HoverLike[] = [
      { contents: ['first'] },
      { contents: [{ value: 'second' }, { language: 'ts', value: 'third' }] },
    ];
    expect(mapHover(hovers)).toEqual(['first', 'second', 'third']);
  });

  // -------------------------------------------------------------------------
  // L8 — hover null-contents guard (same INV-17 class as AU-17): a `null`
  // entry inside `contents`, or a `null`/`undefined` `contents` field itself,
  // must never throw.
  // -------------------------------------------------------------------------

  it('L8: a null entry inside Hover.contents is skipped, never throws (totality)', () => {
    const hover: HoverLike = {
      contents: ['before', null as unknown as HoverLike['contents'][number], 'after'],
    };
    expect(() => mapHover([hover])).not.toThrow();
    expect(mapHover([hover])).toEqual(['before', 'after']);
  });

  it('L8: a Hover with contents: null/undefined never throws (totality)', () => {
    const nullContents = { contents: null } as unknown as HoverLike;
    const undefinedContents = { contents: undefined } as unknown as HoverLike;
    expect(() => mapHover([nullContents])).not.toThrow();
    expect(() => mapHover([undefinedContents])).not.toThrow();
    expect(mapHover([nullContents])).toEqual([]);
    expect(mapHover([undefinedContents])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Totality — never throws on partial/empty/malformed input
// ---------------------------------------------------------------------------

describe('totality — every mapper handles empty input without throwing', () => {
  it('all mappers accept empty arrays and return empty results', () => {
    expect(mapDefinitionTargets([])).toEqual([]);
    expect(mapReferences([])).toEqual([]);
    expect(mapDocumentSymbols([])).toEqual([]);
    expect(mapWorkspaceSymbols([])).toEqual([]);
    expect(mapHover([])).toEqual([]);
    expect(mapDiagnosticsDump([])).toEqual([]);
    expect(mapDiagnosticsForUri([], 'file:///empty.ts')).toEqual({ uri: 'file:///empty.ts', diagnostics: [] });
  });

  it('mapDocumentSymbols handles a DocumentSymbolLike with an empty children array', () => {
    const sym: DocumentSymbolLike = {
      name: 'leaf',
      kind: 11,
      range: range(0, 0, 0, 1),
      selectionRange: range(0, 0, 0, 1),
      children: [],
    };
    expect(() => mapDocumentSymbols([sym])).not.toThrow();
    expect((mapDocumentSymbols([sym])[0] as PlainDocumentSymbol).children).toEqual([]);
  });

  it('mapHover handles a hover with an empty contents array', () => {
    expect(mapHover([{ contents: [] }])).toEqual([]);
  });

  it('never throws across the whole surface for malformed/partial coordinates', () => {
    const weirdRange = range(NaN, -1, Infinity, -Infinity);
    expect(() =>
      mapDefinitionTargets([{ uri: uri('file:///x.ts'), range: weirdRange }]),
    ).not.toThrow();
    expect(() =>
      mapDiagnosticsForUri([{ range: weirdRange, message: '', severity: -1 }], 'file:///x.ts'),
    ).not.toThrow();
  });

  it('I-1: mapDocumentSymbols never throws on a pathologically deep DocumentSymbol tree (~10k levels), truncating at the depth cap instead of blowing the call stack', () => {
    // Build the tree ITERATIVELY (leaf-up), never recursively, so
    // constructing the fixture itself cannot exhaust the call stack.
    const DEPTH = 10_000;
    let node: DocumentSymbolLike = {
      name: 'leaf',
      kind: 11,
      range: range(0, 0, 0, 1),
      selectionRange: range(0, 0, 0, 1),
      children: [],
    };
    for (let i = 0; i < DEPTH; i++) {
      node = {
        name: `level${i}`,
        kind: 11,
        range: range(0, 0, 0, 1),
        selectionRange: range(0, 0, 0, 1),
        children: [node],
      };
    }

    expect(() => mapDocumentSymbols([node])).not.toThrow();

    // Walk the mapped result down to where truncation kicks in and confirm
    // the deepest returned node was capped (children: []) rather than
    // recursing all the way to the original ~10k-deep leaf.
    const [mapped] = mapDocumentSymbols([node]);
    let cursor = mapped as PlainDocumentSymbol;
    let depth = 0;
    while (cursor.children.length > 0) {
      cursor = must(cursor.children[0]);
      depth++;
    }
    expect(depth).toBeLessThan(DEPTH);
    expect(cursor.children).toEqual([]);
  });
});
