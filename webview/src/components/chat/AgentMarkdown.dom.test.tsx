import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentMarkdown, splitStableBoundary, renderMarkdown } from './AgentMarkdown';

/**
 * Audit G-5. Lists were unsupported (raw dashes in a paragraph), `#` headings
 * rendered as bold <p> (no heading structure for assistive technology), and an
 * unterminated fence during streaming showed raw ``` in the transcript.
 *
 * The no-dangerouslySetInnerHTML design is DELIBERATE (CSP) and stays.
 */
describe('G-5: AgentMarkdown renders the structures agents actually emit', () => {
  it('renders a bullet list as a real list', () => {
    render(<AgentMarkdown text={'Steps:\n\n- first\n- second\n- third'} />);
    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('renders a numbered list as a real ordered list', () => {
    render(<AgentMarkdown text={'1. alpha\n2. beta'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders a heading as a real heading, not a bold paragraph', () => {
    render(<AgentMarkdown text={'## What changed\n\nbody text'} />);
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeInTheDocument();
  });

  it('an UNTERMINATED fence mid-stream renders as code, not as raw backticks', () => {
    render(<AgentMarkdown text={'Here you go:\n\n```ts\nconst x = 1;'} streaming />);
    expect(screen.queryByText(/```/)).not.toBeInTheDocument();
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
  });

  it('a closed fence still renders as code (non-vacuous)', () => {
    render(<AgentMarkdown text={'```ts\nconst y = 2;\n```'} />);
    expect(screen.getByText(/const y = 2;/)).toBeInTheDocument();
  });

  it('still escapes markup rather than injecting it (the CSP-safe design is preserved)', () => {
    render(<AgentMarkdown text={'<img src=x onerror=alert(1)>'} />);
    expect(document.querySelector('img')).toBeNull();
  });
});

/**
 * C2: fence gate divergence, markdown links (scheme-restricted), deep headings.
 */
describe('C2: fence gate diverges from CommonMark when settled; links; #{4,6} headings', () => {
  it('a SETTLED message that merely mentions ``` does not permanently code-block its tail (deliberate CommonMark divergence)', () => {
    render(<AgentMarkdown text={'type ``` to open'} />);
    expect(document.querySelector('pre')).toBeNull();
    expect(screen.getByText(/type ``` to open/)).toBeInTheDocument();
  });

  it('a STREAMING trailing unterminated fence still renders as code (G-5 behavior preserved)', () => {
    render(<AgentMarkdown text={'Here you go:\n\n```ts\nconst z = 3;'} streaming />);
    expect(screen.queryByText(/```/)).not.toBeInTheDocument();
    expect(screen.getByText(/const z = 3;/)).toBeInTheDocument();
  });

  it('renders a markdown http(s) link as a real anchor', () => {
    render(<AgentMarkdown text={'See [docs](https://example.com) for more.'} />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('title', 'https://example.com');
    expect(link).not.toHaveAttribute('target');
  });

  it('does NOT render an anchor for a javascript: scheme link (scheme gate is the regex itself)', () => {
    render(<AgentMarkdown text={'[x](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });

  it('does NOT render an anchor for a data: scheme link either', () => {
    render(<AgentMarkdown text={'[x](data:text/html,<script>alert(1)</script>)'} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders #### (4 hashes) as h6', () => {
    render(<AgentMarkdown text={'#### deep'} />);
    const heading = screen.getByRole('heading', { name: 'deep' });
    expect(heading.tagName).toBe('H6');
  });

  it('renders ###### (6 hashes) as h6 too (the 4+ branch generalizes)', () => {
    render(<AgentMarkdown text={'###### deepest'} />);
    const heading = screen.getByRole('heading', { name: 'deepest' });
    expect(heading.tagName).toBe('H6');
  });
});

/**
 * W2 T9 (UI#2): markdown v2 — italic, nested lists, blockquote, pipe tables.
 * The renderer previously stopped at bold/code/link/heading, so `*italic*`
 * showed literal asterisks, nested lists rendered flat (indentation
 * stripped), and `>` quotes / `|` tables rendered as raw source text. Same
 * CSP-safe parse-to-React-elements posture as the rest of this file — no
 * dangerouslySetInnerHTML, no markdown library.
 */
describe('W2 T9: markdown v2 — italic, nested lists, blockquote, tables', () => {
  it('renders *star* italics as a real <em>, not literal asterisks', () => {
    render(<AgentMarkdown text={'this is *important* text'} />);
    const em = screen.getByText('important');
    expect(em.tagName).toBe('EM');
    expect(screen.queryByText(/\*important\*/)).not.toBeInTheDocument();
  });

  it('renders _underscore_ italics as a real <em>, not literal underscores', () => {
    render(<AgentMarkdown text={'this is _important_ text'} />);
    const em = screen.getByText('important');
    expect(em.tagName).toBe('EM');
    expect(screen.queryByText(/_important_/)).not.toBeInTheDocument();
  });

  it('still renders **bold** as <strong>, not <em>, alongside italics (no regression)', () => {
    render(<AgentMarkdown text={'*italic* and **bold** together'} />);
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('renders an indented nested list as a nested <ul> inside the parent <li>', () => {
    render(
      <AgentMarkdown
        text={'- item one\n  - nested a\n  - nested b\n- item two'}
      />,
    );
    const lists = screen.getAllByRole('list');
    // Outer list + one nested list.
    expect(lists).toHaveLength(2);
    const outer = lists[0]!;
    const nested = outer.querySelector('ul');
    expect(nested).not.toBeNull();
    expect(nested?.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('nested a')).toBeInTheDocument();
    expect(screen.getByText('nested b')).toBeInTheDocument();
    // No raw leading-dash/indentation markers leaked into rendered text.
    expect(screen.queryByText(/^- nested a/)).not.toBeInTheDocument();
  });

  it('renders a nested ordered list inside a bullet list correctly', () => {
    render(<AgentMarkdown text={'- outer\n  1. inner one\n  2. inner two'} />);
    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(2);
    const outer = lists.find((l) => l.tagName === 'UL');
    expect(outer).toBeDefined();
    const nested = outer?.querySelector('ol');
    expect(nested).not.toBeNull();
    expect(nested?.querySelectorAll('li')).toHaveLength(2);
  });

  it('a flat (non-nested) bullet list still renders exactly as before (no regression)', () => {
    render(<AgentMarkdown text={'Steps:\n\n- first\n- second\n- third'} />);
    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('renders a `>` line as a real <blockquote>', () => {
    render(<AgentMarkdown text={'> a quoted remark'} />);
    const quote = document.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toBe('a quoted remark');
    expect(screen.queryByText(/^> a quoted remark/)).not.toBeInTheDocument();
  });

  it('a multi-line blockquote strips the `>` marker from every line', () => {
    render(<AgentMarkdown text={'> line one\n> line two'} />);
    const quote = document.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toContain('line one');
    expect(quote?.textContent).toContain('line two');
    expect(quote?.textContent).not.toMatch(/>/);
  });

  it('renders a pipe table as a real <table> inside a horizontally-scrollable container', () => {
    render(
      <AgentMarkdown
        text={'| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |'}
      />,
    );
    const table = screen.getByRole('table');
    expect(table.tagName).toBe('TABLE');
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    // Wide-table safety: the table's own ancestor scrolls, not the page body.
    const scrollAncestor = table.closest('.overflow-x-auto');
    expect(scrollAncestor).not.toBeNull();
    // No raw pipe/dash separator source leaked into the rendered text.
    expect(screen.queryByText(/---/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\| Name \| Value \|/)).not.toBeInTheDocument();
  });
});

/**
 * UI#2 review (security Important, reproduced): `renderBlock` <-> `renderBlocks`
 * (the mutually-recursive blockquote cycle) and `buildList` (per-indentation-
 * level recursion) both recursed with NO depth cap. `AgentMarkdown` renders
 * UNTRUSTED agent/MCP-tool output, and a few thousand leading `>` characters
 * — or a staircase-indented list — are trivial for that output to contain
 * (including via prompt injection in echoed tool output), so an attacker
 * could crash the render with `RangeError: Maximum call stack size
 * exceeded`. The chat-view ErrorBoundary contains the crash to that region,
 * but the region becomes unusable, which contradicts the renderer's own
 * threat model. Both recursions are now bounded (`MAX_BLOCK_DEPTH` /
 * `MAX_LIST_DEPTH`) and degrade to plain/flat rendering past the cap instead
 * of continuing to recurse.
 */
describe('UI#2 review: markdown block/list recursion depth is capped against untrusted input', () => {
  it('a pathologically deep blockquote renders without throwing (degrades past the depth cap)', () => {
    const deep = '>'.repeat(2000) + ' x';
    expect(() => render(<AgentMarkdown text={deep} />)).not.toThrow();
  });

  it('a pathologically staircased nested list renders without throwing (degrades past the depth cap)', () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `${' '.repeat(i)}- level ${i}`);
    const deep = lines.join('\n');
    expect(() => render(<AgentMarkdown text={deep} />)).not.toThrow();
  });

  /*
   * CR-A (re-review, reproduced): the crash is fixed, but the capped
   * fallback dedents only ONE leading `>` per recursion level while
   * recursion itself stops at MAX_BLOCK_DEPTH — so the fallback paragraph
   * still contained every UN-stripped `>` past the cap (~1983 of them for a
   * 2000-`>` input). The degrade must show the user's actual text, not a
   * wall of raw quote markers.
   */
  it('CR-A: the capped blockquote fallback shows clean text, not a wall of raw `>` markers', () => {
    const deep = '>'.repeat(2000) + ' PAYLOAD_TEXT';
    const { container } = render(<AgentMarkdown text={deep} />);
    const rendered = container.textContent ?? '';
    const gtCount = (rendered.match(/>/g) ?? []).length;
    expect(gtCount).toBeLessThanOrEqual(2);
    expect(screen.getByText(/PAYLOAD_TEXT/)).toBeInTheDocument();
  });

  /*
   * CR-B (re-review, reproduced): while capped, `buildList`'s flatten loop
   * still broke on a marker-type switch (bullet <-> ordered), so a
   * MIXED-marker deep staircase left `cursor.i` short of `lines.length`;
   * `parseListBlock`'s all-or-nothing check then nulled the ENTIRE block
   * (even the legitimate shallow levels 0-15) to the raw-paragraph
   * fallback, showing every `-`/`1.` marker as literal source text.
   */
  it('CR-B: a mixed bullet/ordered deep staircase still renders as a list, not a raw-source dump', () => {
    const lines = Array.from(
      { length: 6000 },
      (_, i) => `${' '.repeat(i)}${i % 2 === 0 ? '-' : '1.'} level ${i}`,
    );
    const deep = lines.join('\n');
    const { container } = render(<AgentMarkdown text={deep} />);
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
  });
});

/**
 * A11Y-03 lock (WCAG 1.3.1 / 2.4.6): pins the G-5/C2 heading-demotion
 * behavior above (`renderBlock`'s `# `-`######` -> `h3`-`h6` clamp) as a
 * regression guard for the panel-chrome heading work — the transcript's own
 * headings must stay BELOW the panel's `h2` (`PanelShell`) / the chat
 * surface's sr-only `h2` (`ChatView`), never colliding with or outranking
 * them. No renderer change: this locks already-implemented behavior.
 */
describe('A11Y-03 lock: markdown heading clamp stays below the panel/chat h2', () => {
  it('markdown # maps to h3 and #### collapses to h6 (transcript headings stay below the panel h2)', () => {
    render(<AgentMarkdown text={'# a\n\n#### b'} />);
    expect(screen.getByRole('heading', { level: 3, name: 'a' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'b' })).toBeInTheDocument();
  });
});

/**
 * M-1 (review-verified-by-hand, now locked as regression coverage): the C2
 * link-scheme gate lives in `inline()`'s regex, and every leaf block
 * (paragraph, table cell, list item, blockquote content) routes its content
 * through `inline()`. These tests lock that uniformity so a future refactor
 * that special-cases one of those call sites can't silently reintroduce a
 * `javascript:`/`data:` anchor bypass in just that one spot.
 */
describe('M-1: the C2 link-scheme gate applies uniformly inside table cells, list items, and blockquotes', () => {
  it('does NOT render a javascript: link as an anchor inside a table cell', () => {
    render(
      <AgentMarkdown
        text={'| Name | Link |\n| --- | --- |\n| a | [x](javascript:alert(1)) |'}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });

  it('does NOT render a javascript: link as an anchor inside a list item', () => {
    render(<AgentMarkdown text={'- [x](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });

  it('does NOT render a javascript: link as an anchor inside a blockquote', () => {
    render(<AgentMarkdown text={'> [x](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });
});

const MULTI_BLOCK = [
  '# Title',
  '',
  'A paragraph with **bold** and `code`.',
  '',
  '- item one',
  '- item two',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  'Closing paragraph in progress',
].join('\n');

describe('CA-11: splitStableBoundary is block-aligned and fence-safe', () => {
  it('never cuts inside an open fenced-code block', () => {
    const openFence = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;'; // blank line INSIDE the fence
    const { stable, tail } = splitStableBoundary(openFence);
    expect(stable).toBe('intro'); // the in-fence blank line is not a valid boundary
    expect(tail.startsWith('\n\n```ts')).toBe(true);
  });

  it('[perf genuine-RED] the stable prefix is byte-invariant across tail-only growth', () => {
    const base = '# H\n\npara one\n\nopen tail';
    const grown = base + ' more text';
    expect(splitStableBoundary(base).stable).toBe(splitStableBoundary(grown).stable);
    // ^ so the useMemo key (stable) does not change → the completed prefix is
    //   not re-parsed on a delta that only extends the open block. On the
    //   pre-CA-11 code this function does not exist; a naive re-implementation
    //   that recomputed the boundary from the whole text each call would fail
    //   this invariance check.
  });

  it('returns no stable prefix when there is no completed block yet', () => {
    expect(splitStableBoundary('just an open line')).toEqual({ stable: '', tail: 'just an open line' });
  });
});

describe('CA-11: memoized streaming render is transparent (warm === cold for every prefix)', () => {
  it('an incrementally-grown instance renders identically to a fresh mount at every prefix', () => {
    const { rerender, container } = render(<AgentMarkdown text={MULTI_BLOCK.slice(0, 1)} streaming />);
    for (let k = 2; k <= MULTI_BLOCK.length; k++) {
      const prefix = MULTI_BLOCK.slice(0, k);
      rerender(<AgentMarkdown text={prefix} streaming />);
      const warm = container.innerHTML;
      const fresh = render(<AgentMarkdown text={prefix} streaming />);
      const cold = fresh.container.innerHTML;
      fresh.unmount();
      expect(warm).toBe(cold);
    }
  });

  /**
   * CA-11 M1: the test above only proves split==split (the memoized instance
   * agrees with a fresh mount that ALSO goes through the same stable/tail
   * split). It never checks the split against a genuinely UNSPLIT whole-text
   * render — so a bug that made splitting itself non-transparent (e.g. the
   * stable/tail boundary subtly changing block structure vs. parsing the
   * whole string in one pass) could slip past it. `renderMarkdown` is called
   * directly here with the FULL `MULTI_BLOCK` text and no `splitStableBoundary`
   * call at all — reproducing exactly what `AgentMarkdown` would render if it
   * never split (single `tokenize`/`renderBlocks` pass over the whole text,
   * `keyPrefix: 'tail'` to mirror the tail segment's own prefix). `key` props
   * never surface in `innerHTML`, so the differing 'stable'/'tail' key
   * namespaces the real component uses cannot cause a spurious mismatch here
   * — only an actual structural divergence would.
   */
  it('CA-11 M1: the memoized split render is byte-identical to a whole, unsplit render of the same text', () => {
    const { container: splitContainer } = render(<AgentMarkdown text={MULTI_BLOCK} streaming />);

    function ReferenceWhole() {
      return (
        <div className="text-[13px] leading-relaxed text-fg">
          {renderMarkdown(MULTI_BLOCK, true, 'tail')}
          <span className="h-live text-accent">▍</span>
        </div>
      );
    }
    const { container: wholeContainer } = render(<ReferenceWhole />);

    expect(splitContainer.innerHTML).toBe(wholeContainer.innerHTML);
  });
});

/**
 * CA-11 M2: `MULTI_BLOCK` above never exercises a mid-prose triple-backtick
 * mention (the `type ``` to open` case from the C2 describe block, above)
 * alongside a REAL fenced block, nor a 4-backtick fence run — both are
 * corners where `splitStableBoundary`'s fence-parity counting could disagree
 * with `tokenize`'s own fence regex about where a block boundary actually is.
 * `FENCE_EDGE` grows both into one fixture so the warm===cold loop below
 * locks fence-parity ≡ tokenizer agreement on exactly the corners `MULTI_BLOCK`
 * omits.
 */
const FENCE_EDGE = [
  'Text with ``` inline mention.',
  '',
  'Then a real block:',
  '',
  '````ts',
  'const x = 1;',
  '````',
  '',
  'Tail in progress',
].join('\n');

describe('CA-11: memoized streaming render is transparent on fence-edge corners (warm === cold for every prefix)', () => {
  it('an incrementally-grown instance renders identically to a fresh mount at every prefix (FENCE_EDGE)', () => {
    const { rerender, container } = render(<AgentMarkdown text={FENCE_EDGE.slice(0, 1)} streaming />);
    for (let k = 2; k <= FENCE_EDGE.length; k++) {
      const prefix = FENCE_EDGE.slice(0, k);
      rerender(<AgentMarkdown text={prefix} streaming />);
      const warm = container.innerHTML;
      const fresh = render(<AgentMarkdown text={prefix} streaming />);
      const cold = fresh.container.innerHTML;
      fresh.unmount();
      expect(warm).toBe(cold);
    }
  });
});
