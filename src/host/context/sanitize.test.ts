import { describe, it, expect } from 'vitest';
import {
  CONTEXT_BUDGET,
  clampText,
  isSecretPath,
  splitDiffByFile,
  excludeSecretFiles,
  truncateDiffToBudget,
  extractSectionPath,
} from './sanitize';

describe('CONTEXT_BUDGET', () => {
  it('pins the exact budget constants from the architecture doc (§2d)', () => {
    expect(CONTEXT_BUDGET).toEqual({
      perItemChars: 24_000,
      totalChars: 48_000,
      diagnosticsMax: 50,
      terminalLines: 200,
      diffChars: 30_000,
    });
  });
});

describe('clampText', () => {
  it('returns the text unchanged (truncated:false) when within cap', () => {
    expect(clampText('hello world', 100)).toEqual({ text: 'hello world', truncated: false });
  });

  it('returns the text unchanged when exactly at cap', () => {
    const text = 'x'.repeat(20);
    expect(clampText(text, 20)).toEqual({ text, truncated: false });
  });

  it('elides a single very-long line with no newlines, truncated:true', () => {
    const text = 'a'.repeat(1000);
    const result = clampText(text, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
  });

  it('elides a multi-line text over cap by keeping head+tail lines with a read-more notice', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const text = lines.join('\n');
    const result = clampText(text, 200);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('line 0');
    expect(result.text).toContain('line 99');
    expect(result.text).toMatch(/Showing \d+ of 100 lines; ask to read the file for more/);
  });

  it('never grows the output far past the requested cap for multi-line input', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line number ${i} of the file`);
    const text = lines.join('\n');
    const result = clampText(text, 500);

    expect(result.truncated).toBe(true);
    // Generous slack for the notice text itself, but must not just return everything.
    expect(result.text.length).toBeLessThan(text.length / 2);
  });

  it('handles empty text as within cap', () => {
    expect(clampText('', 10)).toEqual({ text: '', truncated: false });
  });

  it('never exceeds cap even when cap is smaller than the elision notice itself (T2a M1)', () => {
    const result = clampText('x'.repeat(200), 10);
    expect(result.text.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });
});

describe('isSecretPath', () => {
  it('classifies a .env file as secret', () => {
    expect(isSecretPath('/repo/.env')).toBe(true);
  });

  it('classifies an SSH private key as secret', () => {
    expect(isSecretPath('/home/user/.ssh/id_rsa')).toBe(true);
  });

  it('classifies an ordinary source file as not secret', () => {
    expect(isSecretPath('/repo/src/index.ts')).toBe(false);
  });

  it('delegates to isSecretForCompletion (case-insensitive)', () => {
    expect(isSecretPath('/repo/CREDENTIALS')).toBe(true);
  });
});

/** Build one unified-diff file section: a `diff --git` header + one hunk
 * replacing "old" with `addedLine`, so added=1/removed=1 for every section
 * this helper produces (tests compute exact section lengths off this, never
 * hardcoded byte counts, so they stay robust to header-format tweaks). */
function makeSection(path: string, addedLine: string): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -1 +1 @@\n` +
    `-old\n` +
    `+${addedLine}\n`
  );
}

describe('extractSectionPath — unambiguous per-file path extraction (T5a fix)', () => {
  it('extracts the path from `+++ b/` even when the path itself contains a literal " b/" substring (T5a PoC)', () => {
    const body = makeSection('.ssh/known b/hosts', 'new');

    expect(extractSectionPath(body)).toBe('.ssh/known b/hosts');
  });

  it('extracts the path from `--- a/` when `+++` is `/dev/null` (deletion)', () => {
    const body =
      'diff --git a/secret.env b/secret.env\n' +
      'deleted file mode 100644\n' +
      'index 1111111..0000000\n' +
      '--- a/secret.env\n' +
      '+++ /dev/null\n' +
      '@@ -1 +0,0 @@\n' +
      '-old\n';

    expect(extractSectionPath(body)).toBe('secret.env');
  });

  it('extracts the path from `rename to`, taking priority over both the diff --git header and any +++/--- lines', () => {
    const body = 'diff --git a/old.ts b/src/new name.ts\nsimilarity index 100%\nrename from old.ts\nrename to src/new name.ts\n';

    expect(extractSectionPath(body)).toBe('src/new name.ts');
  });

  it('falls back to the equal-halves parse of the diff --git header when there is no +++/---/rename-to line (binary section)', () => {
    const body = 'diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n';

    expect(extractSectionPath(body)).toBe('logo.png');
  });

  it('the equal-halves fallback also resolves a literal " b/" inside the path for a binary section', () => {
    const body =
      'diff --git a/.ssh/known b/hosts b/.ssh/known b/hosts\n' +
      'index 1111111..2222222 100644\n' +
      'Binary files a/.ssh/known b/hosts and b/.ssh/known b/hosts differ\n';

    expect(extractSectionPath(body)).toBe('.ssh/known b/hosts');
  });

  it('falls back to the old greedy diff --git header parse when the equal-halves check does not hold (last resort)', () => {
    const body = 'diff --git a/old.ts b/new.ts\nindex 1111111..2222222 100644\nBinary files a/old.ts and b/new.ts differ\n';

    expect(extractSectionPath(body)).toBe('new.ts');
  });
});

describe('splitDiffByFile — parse a unified diff into per-file sections', () => {
  it('splits a multi-file diff into one section per file, counting +/- lines (excluding +++/---)', () => {
    const aSection =
      'diff --git a/src/a.ts b/src/a.ts\n' +
      'index 111..222 100644\n' +
      '--- a/src/a.ts\n' +
      '+++ b/src/a.ts\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' line1\n' +
      '-old line\n' +
      '+new line\n' +
      '+added line\n';
    const bSection =
      'diff --git a/src/b.ts b/src/b.ts\n' +
      'index 333..444 100644\n' +
      '--- a/src/b.ts\n' +
      '+++ b/src/b.ts\n' +
      '@@ -1 +1 @@\n' +
      '-removed only\n' +
      '+replaced\n';

    const sections = splitDiffByFile(aSection + bSection);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toEqual({ path: 'src/a.ts', body: aSection, added: 2, removed: 1 });
    expect(sections[1]).toEqual({ path: 'src/b.ts', body: bSection, added: 1, removed: 1 });
  });

  it('handles a pure rename (no +/- hunk lines) using the b/ path from the header', () => {
    const rename = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n';

    const sections = splitDiffByFile(rename);

    expect(sections).toEqual([{ path: 'new.ts', body: rename, added: 0, removed: 0 }]);
  });

  it('returns an empty array for an empty diff', () => {
    expect(splitDiffByFile('')).toEqual([]);
  });

  it('extracts the true path from `+++ b/` for a header whose greedy b/ capture mis-parses a path containing " b/" (T5a security PoC)', () => {
    const section = makeSection('.ssh/known b/hosts', 'new');

    const sections = splitDiffByFile(section);

    expect(sections).toEqual([{ path: '.ssh/known b/hosts', body: section, added: 1, removed: 1 }]);
  });

  it("parses an ordinary deletion section's path from `--- a/`, not from the header (+++ is /dev/null)", () => {
    const section =
      'diff --git a/secret.env b/secret.env\n' +
      'deleted file mode 100644\n' +
      'index 1111111..0000000\n' +
      '--- a/secret.env\n' +
      '+++ /dev/null\n' +
      '@@ -1 +0,0 @@\n' +
      '-old\n';

    const sections = splitDiffByFile(section);

    expect(sections).toEqual([{ path: 'secret.env', body: section, added: 0, removed: 1 }]);
  });

  it('parses a deletion section\'s path correctly from `--- a/` even when the path itself contains " b/" (extends the T5a fix to deletions)', () => {
    const path = '.ssh/known b/hosts';
    const section =
      `diff --git a/${path} b/${path}\n` +
      'deleted file mode 100644\n' +
      'index 1111111..0000000\n' +
      `--- a/${path}\n` +
      '+++ /dev/null\n' +
      '@@ -1 +0,0 @@\n' +
      '-old\n';

    const sections = splitDiffByFile(section);

    expect(sections).toEqual([{ path, body: section, added: 0, removed: 1 }]);
  });

  it('parses a rename section\'s path from `rename to`, preserving a space in the new path', () => {
    const rename = 'diff --git a/old.ts b/src/new name.ts\nsimilarity index 100%\nrename from old.ts\nrename to src/new name.ts\n';

    const sections = splitDiffByFile(rename);

    expect(sections).toEqual([{ path: 'src/new name.ts', body: rename, added: 0, removed: 0 }]);
  });

  it('parses a rename section\'s path from `rename to` even when the new path contains " b/" (extends the T5a fix to renames)', () => {
    const rename =
      'diff --git a/old.ts b/.config/known b/file.ts\n' +
      'similarity index 90%\n' +
      'rename from old.ts\n' +
      'rename to .config/known b/file.ts\n';

    const sections = splitDiffByFile(rename);

    expect(sections).toEqual([{ path: '.config/known b/file.ts', body: rename, added: 0, removed: 0 }]);
  });
});

describe('excludeSecretFiles — drop secret-classified file sections BEFORE budgeting', () => {
  it('drops a .env section and reports it in skippedFiles, keeping the ordinary file', () => {
    const envSection =
      'diff --git a/.env b/.env\nindex 1..2 100644\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD=1\n+NEW=1\n';
    const srcSection =
      'diff --git a/src/index.ts b/src/index.ts\nindex 3..4 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n';

    const result = excludeSecretFiles(envSection + srcSection);

    expect(result.skippedFiles).toEqual(['.env']);
    expect(result.diff).not.toContain('.env');
    expect(result.diff).toContain('src/index.ts');
    expect(result.diff).toBe(srcSection);
  });

  it('keeps the diff unchanged with an empty skippedFiles when no file is secret', () => {
    const srcSection = makeSection('src/plain.ts', 'x');
    expect(excludeSecretFiles(srcSection)).toEqual({ diff: srcSection, skippedFiles: [] });
  });

  it('handles an empty diff', () => {
    expect(excludeSecretFiles('')).toEqual({ diff: '', skippedFiles: [] });
  });

  it('drops the ".ssh/known b/hosts" secret section even though its path contains " b/" (T5a security PoC — the old greedy header parse mis-extracted "hosts" and slipped the gate)', () => {
    const secretSection = makeSection('.ssh/known b/hosts', 'new');
    const srcSection = makeSection('src/plain.ts', 'x');

    const result = excludeSecretFiles(secretSection + srcSection);

    expect(result.skippedFiles).toEqual(['.ssh/known b/hosts']);
    expect(result.diff).not.toContain('.ssh/known b/hosts');
    expect(result.diff).toBe(srcSection);
  });

  it('drops a secret file deleted via `--- a/` even when its path contains " b/" (extends the T5a fix to deletions)', () => {
    const path = '.ssh/known b/hosts';
    const secretDeletion =
      `diff --git a/${path} b/${path}\n` +
      'deleted file mode 100644\n' +
      'index 1111111..0000000\n' +
      `--- a/${path}\n` +
      '+++ /dev/null\n' +
      '@@ -1 +0,0 @@\n' +
      '-old\n';
    const srcSection = makeSection('src/plain.ts', 'x');

    const result = excludeSecretFiles(secretDeletion + srcSection);

    expect(result.skippedFiles).toEqual([path]);
    expect(result.diff).toBe(srcSection);
  });
});

describe('truncateDiffToBudget — GitLens priority-score binary-search truncation', () => {
  it('returns the diff unchanged (truncated:false) when already within the cap', () => {
    const diff = makeSection('src/small.ts', 'x');
    const result = truncateDiffToBudget(diff, 10_000);
    expect(result).toEqual({ diff, truncated: false, droppedFiles: [] });
  });

  it('over cap: drops the lower-priority (generated/dist) file first, keeps the source file', () => {
    const distSection = makeSection('dist/bundle.js', 'y'.repeat(50));
    const srcSection = makeSection('src/feature.ts', 'z'.repeat(150));
    const diff = distSection + srcSection;
    const cap = srcSection.length; // exactly enough for the source section alone

    const result = truncateDiffToBudget(diff, cap);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles).toEqual(['dist/bundle.js']);
    expect(result.diff).toBe(srcSection);
  });

  it('nothing fits under the cap: emits the "# Files changed" file-list fallback', () => {
    const section = makeSection('src/only.ts', 'z'.repeat(500));

    const result = truncateDiffToBudget(section, 5);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles).toEqual(['src/only.ts']);
    expect(result.diff).toContain('# Files changed:');
    expect(result.diff).toMatch(/src\/only\.ts \(\+1\/-1\)/);
  });

  it('deprioritizes a lockfile below a smaller source file (priority beats size)', () => {
    const lockSection = makeSection('package-lock.json', 'y'.repeat(10)); // small body
    const srcSection = makeSection('src/index.ts', 'z'.repeat(120)); // larger body
    const diff = lockSection + srcSection;
    const cap = srcSection.length; // fits the larger SOURCE file alone, not both

    expect(lockSection.length).toBeLessThan(srcSection.length);

    const result = truncateDiffToBudget(diff, cap);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles).toEqual(['package-lock.json']);
    expect(result.diff).toBe(srcSection);
  });

  it('deprioritizes a test file below an equal-priority-class source file when only one fits', () => {
    const testSection = makeSection('src/feature.test.ts', 'w'.repeat(120));
    const srcSection = makeSection('src/feature.ts', 'w'.repeat(120));
    const diff = testSection + srcSection;
    const cap = srcSection.length;

    const result = truncateDiffToBudget(diff, cap);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles).toEqual(['src/feature.test.ts']);
    expect(result.diff).toBe(srcSection);
  });

  it('defaults the cap to CONTEXT_BUDGET.diffChars', () => {
    const diff = makeSection('src/tiny.ts', 'x');
    expect(truncateDiffToBudget(diff)).toEqual({ diff, truncated: false, droppedFiles: [] });
  });
});
