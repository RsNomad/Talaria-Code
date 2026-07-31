/*
 * Minimal, dependency-free markdown renderer for the agent's answer.
 * ------------------------------------------------------------------
 * Deliberately NOT using a markdown lib: keeps the bundle small and, more
 * importantly, avoids dangerouslySetInnerHTML so nothing the agent emits can
 * inject markup under the webview CSP. Supported: paragraphs, ``` fenced code,
 * `inline code`, **bold**, italics (star or underscore form), http(s) links,
 * `#`-`######` headings, (nested) bullet/ordered lists, `>` blockquotes, and
 * pipe tables —
 * enough for agent replies (W2 T9, UI#2: markdown v2).
 *
 * Link safety (C2): the inline regex only ever matches `[text](https?://…)` —
 * the `https?://` is baked into the pattern itself, so a `javascript:` or
 * `data:` URL cannot match the link alternative at all (it falls through to
 * plain escaped text, same as any other unmatched substring). The scheme
 * restriction is therefore a property of the regex's construction, not a
 * post-hoc filter on an already-parsed URL — there is no parsed-but-rejected
 * href to accidentally leak into an `href` attribute.
 */
import { Fragment, type ReactNode } from 'react';

interface Props {
  text: string;
  streaming?: boolean;
}

/** Split into fenced-code blocks vs prose, preserving order.
 *
 * Audit G-5: the pattern used to require a CLOSING fence, so during streaming
 * the opening ``` and everything after it fell into the prose branch and the
 * user watched raw backticks accumulate. The second pass below takes a
 * trailing unterminated fence as code while `streaming` — which is what it
 * will become.
 *
 * DOCUMENTED DIVERGENCE FROM COMMONMARK (C2): CommonMark's fenced-code-block
 * rule runs an unclosed fence to the end of the document — "If the end of the
 * containing block (or document) is reached and no closing code fence has
 * been found, the code block contains all of the lines after the opening
 * code fence until the end of the containing block (or document)"
 * (https://spec.commonmark.org/0.31.2/#fenced-code-blocks). We deliberately
 * diverge for SETTLED chat text: a message that merely *mentions* one ```
 * (with no intent to open a code block) must not permanently code-block the
 * rest of that transcript turn. STREAMING keeps the CommonMark-like
 * open-fence treatment — the trailing-open-fence branch below only runs
 * while `streaming` is true, preserving the G-5 fix above. Corollary: a turn
 * that ends mid-fence re-renders its tail as prose once it settles.
 */
function tokenize(
  src: string,
  streaming: boolean,
): { code: boolean; lang?: string; body: string }[] {
  const out: { code: boolean; lang?: string; body: string }[] = [];
  const re = /```([\w-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ code: false, body: src.slice(last, m.index) });
    out.push({ code: true, lang: m[1] || undefined, body: m[2] ?? '' });
    last = re.lastIndex;
  }
  const rest = src.slice(last);
  const open = streaming ? /```([\w-]*)\n?([\s\S]*)$/.exec(rest) : null;
  if (open) {
    if (open.index > 0) out.push({ code: false, body: rest.slice(0, open.index) });
    out.push({ code: true, lang: open[1] || undefined, body: open[2] ?? '' });
  } else if (rest.length > 0) {
    out.push({ code: false, body: rest });
  }
  return out;
}

/** Inline formatting: `code`, **bold**, italics (star or underscore form),
 * and [text](https?://…) links.
 *
 * The link branch's URL group only matches `https?://` — by construction, a
 * `javascript:` or `data:` (or any other scheme) URL can never satisfy it, so
 * the whole link alternative fails to match and the source text falls
 * through as plain escaped text instead of becoming a clickable anchor. This
 * is the C2 XSS gate: it lives in the regex, not in a post-match filter on
 * the parsed href.
 *
 * W2 T9: italic is two alternatives (`*..*` / `_.._`), each guarded by a
 * word-boundary lookaround so an underscore inside an ordinary identifier
 * (`my_var_name`, not fenced in backticks) doesn't get misread as emphasis.
 * The bold alternative is listed BEFORE the star-italic one so a leading
 * `**` is always claimed by bold first — italic's content class excludes
 * `*` entirely, so it could never match a `**…**` run on its own, but the
 * ordering is kept explicit for the same reason the original three
 * alternatives were ordered: no nested quantifiers, linear scan, no ReDoS.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|(?<!\w)\*[^*\n]+\*(?!\w)|(?<!\w)_[^_\n]+_(?!\w))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-surface px-1 py-0.5 font-mono text-[0.85em] text-accent"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-fg">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith('[')) {
      // Link: `[label](https?://url)` — url is capture group 2; only ever
      // set when the http(s)-scheme alternative matched (see doc comment).
      const url = m[2] ?? '';
      const label = tok.slice(1, tok.indexOf(']'));
      nodes.push(
        <a key={key} href={url} className="text-accent underline" title={url}>
          {label}
        </a>,
      );
    } else {
      // Italic: either `*…*` or `_…_` — both strip exactly one marker char
      // from each end.
      nodes.push(
        <em key={key} className="italic">
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** One parsed list-item line: how far it's indented, whether its marker was
 * ordered (`1.`/`1)`) or a bullet (`-`/`*`/`+`), and its content past the
 * marker. `null` means the line isn't a list line at all. */
interface ListLine {
  indent: number;
  ordered: boolean;
  content: string;
}

const LIST_LINE_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

function parseListLine(line: string): ListLine | null {
  const m = LIST_LINE_RE.exec(line);
  if (!m) return null;
  return {
    indent: (m[1] ?? '').length,
    ordered: m[3] !== undefined,
    content: m[4] ?? '',
  };
}

interface ListNode {
  ordered: boolean;
  items: { content: string; children: ListNode[] }[];
}

/** Indentation-tree builder (W2 T9): consumes `lines` from `cursor.i`
 * forward, grouping every consecutive line at exactly `indent` into one
 * list, and recursing into a nested list wherever the following line is
 * MORE indented than the current item. A marker-type switch (bullet <->
 * ordered) at the SAME indent ends the current list — the caller decides
 * what, if anything, follows.
 */
/** UI#2 review (security Important): `buildList` recurses once per
 * indentation level with no bound, so a staircase-indented list (each line
 * indented one step deeper than the last) in UNTRUSTED agent/tool output —
 * a few thousand lines is trivial to produce — recursed thousands of levels
 * deep and overflowed the JS call stack (`RangeError`), crashing the whole
 * chat-view render. 16 is far beyond any indentation depth a human or a
 * well-behaved agent would ever produce (3-4 levels is already unusually
 * deep) and far below typical JS engine stack limits, so legitimate content
 * never gets near it while adversarial staircase input is stopped cold. */
const MAX_LIST_DEPTH = 16;

function buildList(
  lines: ListLine[],
  cursor: { i: number },
  indent: number,
  depth = 0,
): ListNode {
  const items: { content: string; children: ListNode[] }[] = [];
  const first = lines[cursor.i];
  const ordered = first?.ordered ?? false;
  // Past MAX_LIST_DEPTH: stop recursing into children entirely. Instead of
  // breaking on `line.indent > indent` (which would hand the deeper lines to
  // a recursive call), fold them into THIS list's own flat items — degrading
  // gracefully to a flatter (but still fully rendered, never-crashing) list
  // rather than continuing to recurse toward the stack limit.
  const capped = depth >= MAX_LIST_DEPTH;
  while (cursor.i < lines.length) {
    const line = lines[cursor.i];
    if (!line || line.indent < indent) break;
    if (!capped && line.indent > indent) break; // handled by the recursive call below
    if (line.ordered !== ordered) break; // marker-type switch ends this list
    cursor.i++;
    const children: ListNode[] = [];
    const next = lines[cursor.i];
    if (!capped && next && next.indent > indent) {
      children.push(buildList(lines, cursor, next.indent, depth + 1));
    }
    items.push({ content: line.content, children });
  }
  return { ordered, items };
}

/** `null` unless EVERY line in the block is a list line — a block that's
 * only partly list syntax falls through to the paragraph renderer instead,
 * same as the pre-W2-T9 flat-list check did. */
function parseListBlock(lines: string[]): ListNode | null {
  const parsed = lines.map(parseListLine);
  if (parsed.some((p) => p === null)) return null;
  const nonNull = parsed as ListLine[];
  const cursor = { i: 0 };
  const node = buildList(nonNull, cursor, nonNull[0]?.indent ?? 0);
  return cursor.i === nonNull.length ? node : null;
}

function renderList(list: ListNode, key: string): ReactNode {
  const Tag = list.ordered ? 'ol' : 'ul';
  const className = list.ordered
    ? 'mb-2 list-decimal pl-5 last:mb-0'
    : 'mb-2 list-disc pl-5 last:mb-0';
  return (
    <Tag key={key} className={className}>
      {list.items.map((item, ii) => (
        <li key={ii}>
          {inline(item.content, `${key}-${ii}`)}
          {item.children.map((child, ci) => renderList(child, `${key}-${ii}-${ci}`))}
        </li>
      ))}
    </Tag>
  );
}

interface ParsedTable {
  header: string[];
  rows: string[][];
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const TABLE_SEPARATOR_CELL_RE = /^:?-+:?$/;

function isTableSeparatorLine(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_SEPARATOR_CELL_RE.test(c));
}

/** GFM-style pipe table (W2 T9): a header row, a delimiter row of dashes
 * (the thing that actually distinguishes a table from prose that merely
 * contains a `|`), and zero or more body rows. `null` for anything short of
 * that — plain text with a stray `|` in it must never be mistaken for a
 * table. */
function parseTableBlock(lines: string[]): ParsedTable | null {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null;
  const [headerLine, sepLine, ...rest] = nonEmpty;
  if (headerLine === undefined || sepLine === undefined) return null;
  if (!headerLine.includes('|') || !isTableSeparatorLine(sepLine)) return null;
  const header = splitTableRow(headerLine);
  if (header.length < 1) return null;
  return { header, rows: rest.map(splitTableRow) };
}

function renderTable(table: ParsedTable, key: string): ReactNode {
  return (
    <div key={key} className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {table.header.map((cell, ci) => (
              <th key={ci} className="border-b border-border px-2 py-1 font-semibold text-fg">
                {inline(cell, `${key}-h-${ci}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border-b border-border px-2 py-1 align-top">
                  {inline(cell, `${key}-${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** UI#2 review (security Important): `renderBlock` and `renderBlocks` are
 * mutually recursive through the blockquote branch below with no depth
 * bound, so UNTRUSTED agent/tool output containing a run of leading `>`
 * characters (trivial to produce, including via prompt injection in echoed
 * tool output — e.g. `'>'.repeat(2000)`) recursed once per `>` and
 * overflowed the JS call stack, crashing the whole chat-view render. 16 is
 * far beyond any blockquote nesting a human or well-behaved agent would ever
 * produce (2-3 levels is already unusual) and far below typical JS engine
 * stack limits, so legitimate content never gets near it while a
 * few-thousand-deep adversarial input is stopped cold. */
const MAX_BLOCK_DEPTH = 16;

/** Renders one blank-line-delimited block: heading, table, (nested) list,
 * blockquote, or — the fallback — a paragraph. Recursed into from the
 * blockquote branch below so quoted text still gets the same inline
 * formatting (and, for free, the same block-level structure) as top-level
 * text. `depth` counts how many blockquote levels this call is already
 * nested inside — see MAX_BLOCK_DEPTH above. */
function renderBlock(block: string, key: string, depth = 0): ReactNode {
  const heading = /^(#{1,6})\s+(.*)$/.exec(block.trim());
  if (heading) {
    // Audit G-5: this used to be a bold <p>. Visually similar, but
    // assistive technology got no document structure at all and heading
    // navigation found nothing. `h3`-`h6` keeps the transcript's own
    // heading level below the panel's; levels 4-6 all collapse to `h6`
    // (there is no further HTML level to map to) — C2.
    const level = (heading[1] ?? '#').length;
    const Tag = (
      level === 1 ? 'h3' : level === 2 ? 'h4' : level === 3 ? 'h5' : 'h6'
    ) as 'h3' | 'h4' | 'h5' | 'h6';
    return (
      <Tag key={key} className="mb-1 mt-2 font-semibold text-fg">
        {inline(heading[2] ?? '', key)}
      </Tag>
    );
  }

  const lines = block.split('\n');

  const table = parseTableBlock(lines);
  if (table) return renderTable(table, key);

  // Audit G-5: lists had NO handling — `- a\n- b` rendered as one paragraph
  // with literal dashes, which is what agents emit most. W2 T9: the flat
  // check has been replaced by the indentation-tree builder above, which
  // subsumes the flat case (every item at indent 0, no children) and adds
  // nested `<ul>`/`<ol>` on top.
  const list = parseListBlock(lines);
  if (list) return renderList(list, key);

  // W2 T9: `>` blockquote. Every non-blank line must be quoted for the
  // block to count as one — a stray `>` inside ordinary prose stays prose.
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length > 0 && nonBlank.every((l) => /^\s*>/.test(l))) {
    const dedented = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n');
    if (depth >= MAX_BLOCK_DEPTH) {
      // At/past the cap: stop descending through the renderBlock <->
      // renderBlocks cycle entirely. Render the remaining (already-dedented)
      // content as one plain paragraph with inline formatting only — no
      // further block-level recursion, no further blockquote descent — so
      // arbitrarily deep adversarial `>` nesting can never grow the call
      // stack past MAX_BLOCK_DEPTH levels.
      return (
        <p key={key} className="mb-2 last:mb-0">
          {inline(dedented, key)}
        </p>
      );
    }
    return (
      <blockquote key={key} className="mb-2 border-l-2 border-border pl-3 text-muted last:mb-0">
        {renderBlocks(dedented, `${key}-bq`, depth + 1)}
      </blockquote>
    );
  }

  return (
    <p key={key} className="mb-2 last:mb-0">
      {inline(block, key)}
    </p>
  );
}

/** Splits `text` on blank lines into blocks and renders each. Shared by the
 * top-level call (per fenced-code-split token) and the blockquote branch
 * above (recursing into its own dedented text). `depth` is passed straight
 * through to `renderBlock` — see MAX_BLOCK_DEPTH above. */
function renderBlocks(text: string, keyPrefix: string, depth = 0): ReactNode {
  const blocks = text.split(/\n{2,}/).filter((p) => p.trim().length);
  return (
    <Fragment key={keyPrefix}>
      {blocks.map((block, pi) => renderBlock(block, `${keyPrefix}-${pi}`, depth))}
    </Fragment>
  );
}

export function AgentMarkdown({ text, streaming }: Props) {
  const tokens = tokenize(text, streaming === true);
  return (
    <div className="text-[13px] leading-relaxed text-fg">
      {tokens.map((tok, ti) => {
        if (tok.code) {
          return (
            <pre
              key={ti}
              className="my-2 overflow-x-auto rounded-card border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-muted"
            >
              {tok.lang && <div className="mb-1 text-2xs uppercase text-faint">{tok.lang}</div>}
              <code>{tok.body.replace(/\n$/, '')}</code>
            </pre>
          );
        }
        return renderBlocks(tok.body, String(ti));
      })}
      {streaming && <span className="h-live text-accent">▍</span>}
    </div>
  );
}
