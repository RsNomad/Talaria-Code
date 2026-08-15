import { describe, expect, it } from 'vitest';

import { buildSymbolPath, chunkAst } from './astChunker';
import type { SyntaxNodeLike } from './types';
import { must } from '../../testing/must';

function positionAt(source: string, index: number): { row: number; column: number } {
  const before = source.slice(0, index);
  const lines = before.split('\n');
  return { row: lines.length - 1, column: must(lines[lines.length - 1]).length };
}

/** Builds a fake `SyntaxNodeLike`, wiring `parent` back onto every child. */
function mkNode(
  source: string,
  type: string,
  start: number,
  end: number,
  children: SyntaxNodeLike[] = [],
): SyntaxNodeLike {
  const node = {
    type,
    text: source.slice(start, end),
    startIndex: start,
    endIndex: end,
    startPosition: positionAt(source, start),
    endPosition: positionAt(source, end),
    children,
    parent: null as SyntaxNodeLike | null,
  };
  for (const child of children) {
    (child as { parent: SyntaxNodeLike | null }).parent = node;
  }
  return node;
}

describe('chunkAst', () => {
  it('yields the whole node verbatim when it fits the budget', () => {
    const source = 'const x = 1;';
    const root = mkNode(source, 'program', 0, source.length, []);

    const chunks = chunkAst(root, source, 512);

    expect(chunks).toEqual([{ content: source, startLine: 0, endLine: 0, symbolPath: [] }]);
  });

  it('collapses an oversized top-level function to its signature + "{ ... }", with no extra chunks from its body', () => {
    const filler = 'x'.repeat(3000);
    const source = `function foo() {\n  ${filler}\n}\n`;

    const bodyStart = source.indexOf('{');
    const bodyEnd = source.indexOf('}') + 1;
    const fillerStart = source.indexOf(filler);
    const fillerEnd = fillerStart + filler.length;

    const fillerNode = mkNode(source, 'expression_statement', fillerStart, fillerEnd, []);
    const bodyBlock = mkNode(source, 'statement_block', bodyStart, bodyEnd, [fillerNode]);
    const identifier = mkNode(source, 'identifier', source.indexOf('foo'), source.indexOf('foo') + 3, []);
    const fn = mkNode(source, 'function_declaration', 0, source.length, [identifier, bodyBlock]);

    const chunks = chunkAst(fn, source, 50);

    expect(chunks).toHaveLength(1);
    const chunk = must(chunks[0]);
    expect(chunk.content).toBe('function foo() { ... }');
    expect(chunk.content).not.toContain('x'.repeat(50));
    expect(chunk.symbolPath).toEqual(['foo']);
  });

  it('collapses an oversized class but still recurses into its methods (small methods yielded whole, oversized ones collapsed)', () => {
    const filler = 'A'.repeat(3000);
    const source =
      'class Foo {\n' +
      '  methodA() {\n' +
      `    ${filler}\n` +
      '  }\n' +
      '  methodB() {\n' +
      '    return 2;\n' +
      '  }\n' +
      '}\n';

    const classBodyStart = source.indexOf('{');
    const classBodyEnd = source.lastIndexOf('}') + 1;

    const methodAStart = source.indexOf('methodA()');
    const methodABodyStart = source.indexOf('{', methodAStart);
    const methodABodyEnd = source.indexOf('}', methodABodyStart) + 1;
    const fillerStart = source.indexOf(filler);
    const fillerEnd = fillerStart + filler.length;

    const methodBStart = source.indexOf('methodB()');
    const methodBBodyStart = source.indexOf('{', methodBStart);
    const methodBBodyEnd = source.indexOf('}', methodBBodyStart) + 1;
    const returnStart = source.indexOf('return 2;', methodBStart);
    const returnEnd = returnStart + 'return 2;'.length;

    const fillerNode = mkNode(source, 'expression_statement', fillerStart, fillerEnd, []);
    const bodyBlockA = mkNode(source, 'statement_block', methodABodyStart, methodABodyEnd, [fillerNode]);
    const propIdA = mkNode(source, 'property_identifier', methodAStart, methodAStart + 'methodA'.length, []);
    const methodA = mkNode(source, 'method_definition', methodAStart, methodABodyEnd, [propIdA, bodyBlockA]);

    const returnNode = mkNode(source, 'return_statement', returnStart, returnEnd, []);
    const bodyBlockB = mkNode(source, 'statement_block', methodBBodyStart, methodBBodyEnd, [returnNode]);
    const propIdB = mkNode(source, 'property_identifier', methodBStart, methodBStart + 'methodB'.length, []);
    const methodB = mkNode(source, 'method_definition', methodBStart, methodBBodyEnd, [propIdB, bodyBlockB]);

    const classBody = mkNode(source, 'class_body', classBodyStart, classBodyEnd, [methodA, methodB]);
    const fooStart = source.indexOf('Foo');
    const classIdent = mkNode(source, 'identifier', fooStart, fooStart + 3, []);
    const classNode = mkNode(source, 'class_declaration', 0, source.length, [classIdent, classBody]);

    const maxChunkTokens = 50;
    const chunks = chunkAst(classNode, source, maxChunkTokens);

    expect(chunks).toHaveLength(3);

    // 1) The class itself, collapsed — both methods show as "{ ... }", filler is gone.
    const classChunk = must(chunks[0]);
    expect(classChunk.content).toContain('methodA() { ... }');
    expect(classChunk.content).toContain('methodB() { ... }');
    expect(classChunk.content).not.toContain(filler);
    expect(classChunk.symbolPath).toEqual(['Foo']);

    // 2) methodA, collapsed on its own (still oversized on its own merits).
    const expectedMethodASignature = source.slice(methodAStart, methodABodyStart);
    const methodAChunk = must(chunks[1]);
    expect(methodAChunk.content).toBe(`${expectedMethodASignature}{ ... }`);
    expect(methodAChunk.symbolPath).toEqual(['Foo', 'methodA']);

    // 3) methodB, yielded whole (small enough to fit as-is).
    const methodBChunk = must(chunks[2]);
    expect(methodBChunk.content).toBe(source.slice(methodBStart, methodBBodyEnd));
    expect(methodBChunk.content).not.toContain('...');
    expect(methodBChunk.symbolPath).toEqual(['Foo', 'methodB']);
  });

  it('still reaches a small handled descendant through an oversized, unhandled ancestor, AND keeps the unhandled sibling (AU-36:R8)', () => {
    const filler = 'z'.repeat(3000);
    const small = 'function tiny() { return 1; }';
    const source = `// ${filler}\n${small}\n`;

    const fillerComment = mkNode(source, 'comment', 0, source.indexOf('\n'), []);
    const tinyStart = source.indexOf(small);
    const tinyFn = mkNode(source, 'function_declaration', tinyStart, tinyStart + small.length, []);
    const program = mkNode(source, 'program', 0, source.length, [fillerComment, tinyFn]);

    const chunks = chunkAst(program, source, 50);

    // Pre-R8, the oversized `comment` sibling was silently dropped (only
    // the small function ever got a chunk). Post-R8, its content survives
    // as a line-window interstitial chunk ahead of the function's own.
    expect(chunks).toHaveLength(2);
    const commentChunk = must(chunks[0]);
    expect(commentChunk.content).toBe(`// ${filler}`);
    expect(commentChunk.symbolPath).toBeUndefined();
    const fnChunk = must(chunks[1]);
    expect(fnChunk.content).toBe(small);
  });

  it('buildSymbolPath returns [] for a node with no class/function ancestors', () => {
    const source = 'const x = 1;';
    const root = mkNode(source, 'program', 0, source.length, []);
    expect(buildSymbolPath(root)).toEqual([]);
  });

  // AU-36:R8 — the AST chunker dropped top-level content that sits before,
  // between, or after captured (function/class) nodes: `program`'s
  // non-capturable direct children (imports, module docs, top-level
  // constants) never fit `maybeYieldChunk`'s `root ||`-gated check and are
  // never a `collapsedNodeConstructors` type, so the recursive walk emitted
  // nothing for them at all. Fix: back-fill any run of uncaptured top-level
  // children with `chunkByLines`-derived interstitial chunks (no
  // symbolPath), so every source line survives into some chunk (T-B tail
  // invariant).
  it('R8: preserves leading and trailing top-level content around a captured function', () => {
    const leadingLine1 = '// leading top-level comment';
    const leadingLine2 = 'const A = 1;';
    const fnLine = 'function mid() { return 2; }';
    const trailingLine1 = 'const B = 2;';
    const trailingLine2 = '// trailing note';
    const source = [leadingLine1, leadingLine2, fnLine, trailingLine1, trailingLine2, ''].join('\n');

    const fnStart = source.indexOf(fnLine);
    const fnEnd = fnStart + fnLine.length; // excludes the following newline
    const trailingStart = source.indexOf(trailingLine1);

    const leadingNode = mkNode(source, 'comment', 0, fnStart, []);
    const fnNode = mkNode(source, 'function_declaration', fnStart, fnEnd, []);
    const trailingNode = mkNode(source, 'comment', fnEnd, source.length, []);
    const program = mkNode(source, 'program', 0, source.length, [leadingNode, fnNode, trailingNode]);
    // Sanity-check the fixture: trailingNode really does start where the
    // function node ends (no gap introduced by fixture construction itself).
    expect(trailingStart).toBeGreaterThanOrEqual(fnEnd);

    const chunks = chunkAst(program, source, 10);

    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('leading top-level comment');
    expect(allContent).toContain('const A = 1;');
    expect(allContent).toContain('function mid()');
    expect(allContent).toContain('const B = 2;');
    expect(allContent).toContain('trailing note');

    // Every real source line (0..4; line 5 is the trailing phantom '') is
    // covered by at least one chunk's [startLine, endLine] range.
    for (let line = 0; line <= 4; line++) {
      const covered = chunks.some((c) => c.startLine <= line && line <= c.endLine);
      expect(covered).toBe(true);
    }
  });

  // AU-36:R12 — `collapseChildren`'s trim loop used `working.lastIndexOf(childCode)
  // > 0` to decide whether a match was "found"; `String.lastIndexOf` returns
  // `0` for a match at the very start of the string, and `0 > 0` is false —
  // so a collapsed child whose text sits at offset 0 of `working` was never
  // actually removed, even though it was found and needed trimming.
  it('R12: collapseChildren removes a collapsed child whose match sits at offset 0', () => {
    const filler = 'z'.repeat(3000);
    const source = `method() {\n  ${filler}\n}`;

    const bodyStart = source.indexOf('{');
    const bodyEnd = source.lastIndexOf('}') + 1;
    // The method — and therefore its class — both start at index 0: after
    // the body is collapsed to "{ ... }", the resulting `working` string
    // (the class's own rendered text) is now IDENTICAL to the collapsed
    // child's text, so `lastIndexOf` finds it at offset 0 exactly.
    const bodyBlock = mkNode(source, 'statement_block', bodyStart, bodyEnd, []);
    const method = mkNode(source, 'method_definition', 0, bodyEnd, [bodyBlock]);
    const classBody = mkNode(source, 'class_body', 0, bodyEnd, [method]);
    const classNode = mkNode(source, 'class_declaration', 0, bodyEnd, [classBody]);

    // maxChunkTokens=2 is smaller than even the collapsed "method() { ... }"
    // form (~4 tokens), so the trim loop must fire and remove it.
    const chunks = chunkAst(classNode, source, 2);

    const classChunk = must(chunks[0]);
    expect(classChunk.content).toBe('');
  });

  // AU-36:R15 — `maybeYieldChunk` used a strict `<` while every other
  // fits-the-budget check in this file (`collapseChildren`'s trim-loop
  // condition, `constructFunctionDefinitionChunk`'s fallbacks) uses `<=`. A
  // node whose estimated token count lands EXACTLY on `maxChunkTokens` was
  // therefore refused a whole-node chunk even though it "fits" by every
  // other comparison in the module.
  it('R15: yields a node whole when its token estimate exactly equals maxChunkTokens', () => {
    const source = 'x'.repeat(40); // ceil(40 / 4) = 10 tokens, exactly.
    const root = mkNode(source, 'program', 0, source.length, []);

    const chunks = chunkAst(root, source, 10);

    expect(chunks).toEqual([{ content: source, startLine: 0, endLine: 0, symbolPath: [] }]);
  });
});
