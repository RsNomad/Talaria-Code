import type { ChunkWithoutHeader, SyntaxNodeLike } from './types';
import { estimateTokenCount } from './tokenEstimate';
import { chunkByLines } from './lineWindowChunker';

/**
 * AST-aware chunking — a synchronous, dependency-free port of Continue.dev's
 * "smart collapsed chunk" algorithm (`core/indexing/chunk/code.ts`,
 * read-only reference per the how-to §3): keep a node whole if it fits
 * `maxChunkTokens`; else emit a **collapsed** form (function signature +
 * `{ ... }` body, class header + collapsed members) and recurse into
 * children so bodies still get indexed as their own chunks somewhere.
 *
 * Ported deliberately 1:1 (including the `isInClass` node-type check that
 * only recognizes `block`/`declaration_list` parents — which means, exactly
 * as upstream, JS/TS `class_body` wrappers do NOT get the "combined class
 * header + method" treatment and fall through to the plain function path;
 * Python `block` and Rust `declaration_list` do). This is a faithful port,
 * not a "fix", per the ground-at-write-time instruction to pin real,
 * proven behavior rather than invent new semantics.
 */

const FUNCTION_BLOCK_NODE_TYPES = ['block', 'statement_block'];
const FUNCTION_DECLARATION_NODE_TYPES = [
  'method_definition',
  'function_definition',
  'function_item',
  'function_declaration',
  'method_declaration',
];
const CLASS_BLOCK_NODE_TYPES = ['block', 'class_body', 'declaration_list'];
const CLASS_NODE_TYPES = ['class_definition', 'class_declaration', 'impl_item'];
const NAME_NODE_TYPES = ['identifier', 'property_identifier', 'field_identifier', 'type_identifier'];

function collapsedReplacement(node: SyntaxNodeLike): string {
  return node.type === 'statement_block' ? '{ ... }' : '...';
}

function firstChildOfType(node: SyntaxNodeLike, types: readonly string[]): SyntaxNodeLike | null {
  return node.children.find((c) => types.includes(c.type)) ?? null;
}

function collapseChildren(
  node: SyntaxNodeLike,
  code: string,
  blockTypes: readonly string[],
  collapseTypes: readonly string[],
  collapseBlockTypes: readonly string[],
  maxChunkTokens: number,
): string {
  let working = code.slice(0, node.endIndex);
  const block = firstChildOfType(node, blockTypes);
  const collapsedChildren: string[] = [];

  if (block) {
    const childrenToCollapse = block.children.filter((c) => collapseTypes.includes(c.type));
    for (const child of [...childrenToCollapse].reverse()) {
      const grandChild = firstChildOfType(child, collapseBlockTypes);
      if (grandChild) {
        const start = grandChild.startIndex;
        const end = grandChild.endIndex;
        const collapsedChild = working.slice(child.startIndex, start) + collapsedReplacement(grandChild);
        working = working.slice(0, start) + collapsedReplacement(grandChild) + working.slice(end);
        collapsedChildren.unshift(collapsedChild);
      }
    }
  }

  working = working.slice(node.startIndex);
  let removedChild = false;
  while (estimateTokenCount(working.trim()) > maxChunkTokens && collapsedChildren.length > 0) {
    removedChild = true;
    const childCode = collapsedChildren.pop() as string;
    const index = working.lastIndexOf(childCode);
    // AU-36:R12 — a match at offset 0 (`working.lastIndexOf` returns `0`)
    // is a legitimate find; `index > 0` silently skipped it (0 is not
    // `> 0`), leaving that collapsed child un-trimmed even though it was
    // located and needed removing. `-1` (genuinely not found) is the only
    // value that must be excluded.
    if (index >= 0) {
      working = working.slice(0, index) + working.slice(index + childCode.length);
    }
  }

  if (removedChild) {
    // Collapse consecutive blank lines left behind by removed children.
    let lines = working.split('\n');
    let firstBlankInGroup = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined) {
        // Unreachable: the loop invariant keeps i within lines' current
        // bounds even after the mid-loop reassignment below (which only
        // ever removes indices strictly greater than i, so the array is
        // always at least i + 1 long).
        continue;
      }
      if (line.trim() === '') {
        if (firstBlankInGroup < 0) firstBlankInGroup = i;
      } else {
        if (firstBlankInGroup - i > 1) {
          lines = [...lines.slice(0, i + 1), ...lines.slice(firstBlankInGroup + 1)];
        }
        firstBlankInGroup = -1;
      }
    }
    working = lines.join('\n');
  }

  return working;
}

function constructClassDefinitionChunk(node: SyntaxNodeLike, code: string, maxChunkTokens: number): string {
  return collapseChildren(
    node,
    code,
    CLASS_BLOCK_NODE_TYPES,
    FUNCTION_DECLARATION_NODE_TYPES,
    FUNCTION_BLOCK_NODE_TYPES,
    maxChunkTokens,
  );
}

function constructFunctionDefinitionChunk(node: SyntaxNodeLike, code: string, maxChunkTokens: number): string {
  const bodyNode = node.children[node.children.length - 1];
  if (!bodyNode) return node.text;

  const collapsedBody = collapsedReplacement(bodyNode);
  const signature = code.slice(node.startIndex, bodyNode.startIndex);
  const funcText = signature + collapsedBody;

  const parent = node.parent;
  const grandparent = parent?.parent ?? null;
  const isInClass =
    parent !== null &&
    ['block', 'declaration_list'].includes(parent.type) &&
    grandparent !== null &&
    ['class_definition', 'impl_item'].includes(grandparent.type);

  if (isInClass && parent && grandparent) {
    const classHeader = code.slice(grandparent.startIndex, parent.startIndex);
    const indent = ' '.repeat(node.startPosition.column);
    const combined = `${classHeader}...\n\n${indent}${funcText}`;
    if (estimateTokenCount(combined) <= maxChunkTokens) return combined;
    if (estimateTokenCount(funcText) <= maxChunkTokens) return funcText;
    const firstLine = signature.split('\n')[0] ?? '';
    const minimal = `${firstLine} ${collapsedBody}`;
    if (estimateTokenCount(minimal) <= maxChunkTokens) return minimal;
    return collapsedBody;
  }

  if (estimateTokenCount(funcText) <= maxChunkTokens) return funcText;
  const firstLine = signature.split('\n')[0] ?? '';
  const minimal = `${firstLine} ${collapsedBody}`;
  if (estimateTokenCount(minimal) <= maxChunkTokens) return minimal;
  return collapsedBody;
}

type CollapsedConstructor = (node: SyntaxNodeLike, code: string, maxChunkTokens: number) => string;

const collapsedNodeConstructors: Record<string, CollapsedConstructor> = {
  class_definition: constructClassDefinitionChunk,
  class_declaration: constructClassDefinitionChunk,
  impl_item: constructClassDefinitionChunk,
  function_definition: constructFunctionDefinitionChunk,
  function_declaration: constructFunctionDefinitionChunk,
  function_item: constructFunctionDefinitionChunk,
  method_declaration: constructFunctionDefinitionChunk,
  method_definition: constructFunctionDefinitionChunk,
};

/** Last identifier-ish child's text, mirroring Continue's
 * `getSymbolsForFile` heuristic ("the actual name is the last identifier in
 * the node — especially in languages where the return type is declared
 * before the name"). */
function extractOwnName(node: SyntaxNodeLike): string | undefined {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (child === undefined) {
      // Unreachable: i ranges over [0, node.children.length - 1] here.
      continue;
    }
    if (NAME_NODE_TYPES.includes(child.type)) {
      return child.text;
    }
  }
  return undefined;
}

/** Walks a node's ancestor chain collecting class/function names, closest
 * ancestor last — the `path › symbol` breadcrumb (how-to §3). */
export function buildSymbolPath(node: SyntaxNodeLike): string[] {
  const names: string[] = [];
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (
      FUNCTION_DECLARATION_NODE_TYPES.includes(current.type) ||
      CLASS_NODE_TYPES.includes(current.type)
    ) {
      const name = extractOwnName(current);
      if (name) names.unshift(name);
    }
    current = current.parent;
  }
  return names;
}

function maybeYieldChunk(
  node: SyntaxNodeLike,
  maxChunkTokens: number,
  root: boolean,
): ChunkWithoutHeader | undefined {
  if (root || node.type in collapsedNodeConstructors) {
    // AU-36:R15 — every other "does this fit the budget" comparison in this
    // file (`collapseChildren`'s trim-loop condition, every fallback in
    // `constructFunctionDefinitionChunk`) uses `<=` — a node whose estimate
    // lands EXACTLY on `maxChunkTokens` fits. This check used a strict `<`,
    // refusing that same boundary node a whole-node chunk for no reason
    // consistent with the rest of the module.
    if (estimateTokenCount(node.text) <= maxChunkTokens) {
      return {
        content: node.text,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      };
    }
  }
  return undefined;
}

function* smartCollapsedChunks(
  node: SyntaxNodeLike,
  code: string,
  maxChunkTokens: number,
  root: boolean,
): Generator<ChunkWithoutHeader> {
  const whole = maybeYieldChunk(node, maxChunkTokens, root);
  if (whole) {
    yield { ...whole, symbolPath: buildSymbolPath(node) };
    return;
  }

  if (node.type in collapsedNodeConstructors) {
    const constructor = collapsedNodeConstructors[node.type];
    if (constructor !== undefined) {
      // (else unreachable: the `in` check above guarantees this key exists;
      // `in` narrowing doesn't propagate through index access, so this is
      // kept for totality/type safety, not a behavior change.)
      yield {
        content: constructor(node, code, maxChunkTokens),
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        symbolPath: buildSymbolPath(node),
      };
    }
  }

  // Recurse regardless of whether a whole/collapsed chunk was just yielded
  // for `node` itself, so bodies are still indexed somewhere (how-to §3).
  for (const child of node.children) {
    yield* smartCollapsedChunks(child, code, maxChunkTokens, false);
  }
}

/**
 * Chunks one already-parsed AST (`rootNode`) into retrieval units at
 * function/class granularity, collapsing oversized nodes and recursing into
 * their children.
 *
 * AU-36:R8 — when the root doesn't fit whole and isn't itself a
 * function/class node, `smartCollapsedChunks` used to walk straight into
 * `rootNode.children` and yield only from the ones that are (or contain) a
 * captured function/class node. Every OTHER top-level child — imports,
 * module docstrings, top-level constants, and any blank/comment stretch
 * between two functions — is neither `root` (only the true root gets that
 * check) nor a `collapsedNodeConstructors` type, so nothing was ever
 * emitted for it or its descendants: that content silently vanished from
 * every chunk. Below, we walk `rootNode`'s direct children ourselves so we
 * can tell which ones produced zero chunks of their own, and back-fill
 * exactly those gaps with `chunkByLines`-derived interstitial chunks (no
 * `symbolPath` — there's no AST symbol for "the bit between two
 * functions"), merged back in line order. This keeps the T-B tail
 * invariant: every source line of a chunked file is covered by at least
 * one chunk.
 */
export function chunkAst(
  rootNode: SyntaxNodeLike,
  sourceCode: string,
  maxChunkTokens: number,
): ChunkWithoutHeader[] {
  const whole = maybeYieldChunk(rootNode, maxChunkTokens, true);
  if (whole) {
    return [{ ...whole, symbolPath: buildSymbolPath(rootNode) }];
  }

  if (rootNode.type in collapsedNodeConstructors) {
    // The root itself is a function/class node (e.g. a caller chunking a
    // single already-extracted node) — it has no top-level siblings to
    // create gaps between, and `collapseChildren`'s string-slicing already
    // retains every non-collapsed byte of its own span. The plain
    // recursive walk is correct as-is.
    return [...smartCollapsedChunks(rootNode, sourceCode, maxChunkTokens, true)];
  }

  const sourceLines = sourceCode.split('\n');
  const results: ChunkWithoutHeader[] = [];
  let coveredThroughRow = -1; // last row already covered by a captured child

  const fillGapThroughRow = (gapEndRow: number): void => {
    const gapStartRow = coveredThroughRow + 1;
    if (gapEndRow < gapStartRow) return; // no gap: children were contiguous
    const gapText = sourceLines.slice(gapStartRow, gapEndRow + 1).join('\n');
    for (const c of chunkByLines(gapText)) {
      results.push({ content: c.content, startLine: gapStartRow + c.startLine, endLine: gapStartRow + c.endLine });
    }
  };

  for (const child of rootNode.children) {
    const childChunks = [...smartCollapsedChunks(child, sourceCode, maxChunkTokens, false)];
    if (childChunks.length === 0) continue; // still an open gap; keep accumulating

    fillGapThroughRow(child.startPosition.row - 1);
    results.push(...childChunks);
    coveredThroughRow = Math.max(coveredThroughRow, child.endPosition.row);
  }
  fillGapThroughRow(rootNode.endPosition.row);

  return results;
}

export const AST_FUNCTION_NODE_TYPES = FUNCTION_DECLARATION_NODE_TYPES;
export const AST_CLASS_NODE_TYPES = CLASS_NODE_TYPES;
