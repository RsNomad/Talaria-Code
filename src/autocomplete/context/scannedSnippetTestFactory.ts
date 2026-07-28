// TEST-ONLY. Production ScannedSnippets are minted EXCLUSIVELY by ringBuffer.ingest
// (T3) after scanSnippetForSecrets passes — never forged. This factory exists solely
// so template/engine unit tests can build a FimContext with snippets. NEVER import
// this from production code (only *.test.ts). It performs the single sanctioned cast.
import type { CrossFileSnippet } from '../types';
import type { ScannedSnippet } from './types';

export function scannedSnippetForTest(cs: CrossFileSnippet): ScannedSnippet {
  return cs as ScannedSnippet; // sanctioned test-only mint (see file header)
}
