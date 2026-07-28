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

  it('still reaches a small handled descendant through an oversized, unhandled ancestor', () => {
    const filler = 'z'.repeat(3000);
    const small = 'function tiny() { return 1; }';
    const source = `// ${filler}\n${small}\n`;

    const fillerComment = mkNode(source, 'comment', 0, source.indexOf('\n'), []);
    const tinyStart = source.indexOf(small);
    const tinyFn = mkNode(source, 'function_declaration', tinyStart, tinyStart + small.length, []);
    const program = mkNode(source, 'program', 0, source.length, [fillerComment, tinyFn]);

    const chunks = chunkAst(program, source, 50);

    expect(chunks).toHaveLength(1);
    expect(must(chunks[0]).content).toBe(small);
  });

  it('buildSymbolPath returns [] for a node with no class/function ancestors', () => {
    const source = 'const x = 1;';
    const root = mkNode(source, 'program', 0, source.length, []);
    expect(buildSymbolPath(root)).toEqual([]);
  });
});
