import path from 'node:path';

// `web-tree-sitter` has no default export (it's an ambient `declare module`
// with named exports only) — a default import here type-checks under
// `esModuleInterop` as the whole module namespace (no `.init`/construct
// signature), which is the exact error this named import fixes.
import { Parser, Language } from 'web-tree-sitter';

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

  constructor(private readonly opts: WebTreeSitterParserOptions) {}

  supports(languageId: string): boolean {
    return languageId in GRAMMAR_FILE_BY_LANGUAGE;
  }

  async parse(languageId: string, contents: string): Promise<SyntaxNodeLike | undefined> {
    const language = await this.loadLanguage(languageId);
    if (!language) return undefined;

    await ensureParserInit();
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(contents);
    // `web-tree-sitter`'s real `SyntaxNode` is a structural superset of
    // `SyntaxNodeLike`; the double cast is a defensive escape hatch since
    // this file can't be type-checked against the real package here (not
    // installed in this zone) — see report "open concerns".
    return (tree?.rootNode as unknown as SyntaxNodeLike) ?? undefined;
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
