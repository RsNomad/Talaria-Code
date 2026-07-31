import path from 'node:path';

// `web-tree-sitter` has no default export (it's an ambient `declare module`
// with named exports only) — a default import here type-checks under
// `esModuleInterop` as the whole module namespace (no `.init`/construct
// signature), which is the exact error this named import fixes.
import { Parser, Language, type Tree } from 'web-tree-sitter';

import type { SyntaxNodeLike } from '../chunk/types';
import type { CodeParser } from './CodeParser';

/**
 * Maps our `languageId` (VS Code's `document.languageId`, or our own
 * extension-derived guess in `indexer.ts`) to the prebuilt grammar file
 * name shipped by the `tree-sitter-wasms` npm package — the same source
 * Continue.dev ships (read-only reference: `core/util/treeSitter.ts`,
 * `loadLanguageForFileExt`). See the report for exactly how to obtain these
 * `.wasm` files.
 */
const GRAMMAR_FILE_BY_LANGUAGE: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  typescriptreact: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  javascriptreact: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
};

export interface WebTreeSitterParserOptions {
  /** Directory containing the `tree-sitter-*.wasm` grammar files. */
  grammarsDir: string;
}

let parserInitPromise: Promise<void> | undefined;
function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init();
  }
  return parserInitPromise;
}

/**
 * `web-tree-sitter`-backed {@link CodeParser}. All native/WASM surface is
 * confined to this file; `astChunker.ts` only ever sees the structural
 * `SyntaxNodeLike` subset, so it stays unit-testable without this class or
 * its WASM grammars being present (spec: keep native deps behind an
 * interface).
 */
export class WebTreeSitterParser implements CodeParser {
  private readonly languageCache = new Map<string, Language | null>();
  // CF-18: one `Parser` per language, reused across `parse()` calls instead
  // of constructed fresh every time — an emscripten `Parser` is cheap to
  // keep around and re-`setLanguage()`, but expensive (unbounded WASM heap
  // growth over builds/watch-reindexes) to leak one per call.
  private readonly parserCache = new Map<string, Parser>();
  // The `Tree` returned by the most recent `parse()` call, not yet freed.
  private pendingTree: Tree | null = null;

  constructor(private readonly opts: WebTreeSitterParserOptions) {}

  supports(languageId: string): boolean {
    return languageId in GRAMMAR_FILE_BY_LANGUAGE;
  }

  async parse(languageId: string, contents: string): Promise<SyntaxNodeLike | undefined> {
    const language = await this.loadLanguage(languageId);
    if (!language) return undefined;

    const parser = await this.getOrCreateParser(languageId, language);

    // CF-18: free the PREVIOUS call's tree now — never before this point.
    // `chunker.ts`'s `chunkFile` is the only caller: it `await`s `parse()`
    // and then calls `chunkAst` synchronously on the returned root, with no
    // further `await` in between, so by the time *this* `parse()` call
    // starts, any previous tree's root node has already been fully handed
    // to (and consumed by) `chunkAst`. `indexer.ts`'s `reindexFiles` also
    // processes files one at a time in a sequential `for` loop (`await
    // chunkFile(...)` per file), so no `parse()` call can ever start while a
    // previous tree's chunk is still mid-consumption. Deferring the free by
    // exactly one call (rather than scheduling it from inside this same
    // call via a microtask/macrotask, which would mean guessing at the
    // caller's post-await timing) keeps the fix self-contained to this file
    // and bounds heap growth to at most one lingering tree per parser
    // instance — never "unbounded".
    this.pendingTree?.delete();
    this.pendingTree = null;

    const tree = parser.parse(contents);
    this.pendingTree = tree;
    // `web-tree-sitter`'s real `SyntaxNode` is a structural superset of
    // `SyntaxNodeLike`; the double cast is a defensive escape hatch since
    // this file can't be type-checked against the real package here (not
    // installed in this zone) — see report "open concerns".
    return (tree?.rootNode as unknown as SyntaxNodeLike) ?? undefined;
  }

  private async getOrCreateParser(languageId: string, language: Language): Promise<Parser> {
    await ensureParserInit();
    let parser = this.parserCache.get(languageId);
    if (!parser) {
      parser = new Parser();
      this.parserCache.set(languageId, parser);
    }
    // Cheap and idempotent for the common case (same language on every
    // call for this cache entry); guards against the parser losing its
    // assigned language for any reason.
    parser.setLanguage(language);
    return parser;
  }

  private async loadLanguage(languageId: string): Promise<Language | null> {
    if (this.languageCache.has(languageId)) {
      return this.languageCache.get(languageId) ?? null;
    }
    const grammarFile = GRAMMAR_FILE_BY_LANGUAGE[languageId];
    if (!grammarFile) {
      this.languageCache.set(languageId, null);
      return null;
    }
    try {
      await ensureParserInit();
      const language = await Language.load(path.join(this.opts.grammarsDir, grammarFile));
      this.languageCache.set(languageId, language);
      return language;
    } catch (err) {
      console.error(`hermes-codebase: failed to load tree-sitter grammar for ${languageId}`, err);
      this.languageCache.set(languageId, null);
      return null;
    }
  }
}
