/*
 * Minimal, dependency-free markdown renderer for the agent's answer.
 * ------------------------------------------------------------------
 * Deliberately NOT using a markdown lib: keeps the bundle small and, more
 * importantly, avoids dangerouslySetInnerHTML so nothing the agent emits can
 * inject markup under the webview CSP. Supported: paragraphs, ``` fenced code,
 * `inline code`, **bold**, http(s) links, and `#`-`######` headings — enough
 * for agent replies.
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

/** Inline formatting: `code`, **bold**, and [text](https?://…) links.
 *
 * The link branch's URL group only matches `https?://` — by construction, a
 * `javascript:` or `data:` (or any other scheme) URL can never satisfy it, so
 * the whole link alternative fails to match and the source text falls
 * through as plain escaped text instead of becoming a clickable anchor. This
 * is the C2 XSS gate: it lives in the regex, not in a post-match filter on
 * the parsed href. Three bounded alternation branches, no nested
 * quantifiers — linear scan, no ReDoS.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
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
    } else {
      // Link: `[label](https?://url)` — url is capture group 2; only ever
      // set when the http(s)-scheme alternative matched (see doc comment).
      const url = m[2] ?? '';
      const label = tok.slice(1, tok.indexOf(']'));
      nodes.push(
        <a key={key} href={url} className="text-accent underline" title={url}>
          {label}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
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
        const blocks = tok.body.split(/\n{2,}/).filter((p) => p.trim().length);
        return (
          <Fragment key={ti}>
            {blocks.map((block, pi) => {
              const heading = /^(#{1,6})\s+(.*)$/.exec(block.trim());
              if (heading) {
                // Audit G-5: this used to be a bold <p>. Visually similar, but
                // assistive technology got no document structure at all and
                // heading navigation found nothing. `h3`-`h6` keeps the
                // transcript's own heading level below the panel's; levels 4-6
                // all collapse to `h6` (there is no further HTML level to map
                // to) — C2.
                const level = (heading[1] ?? '#').length;
                const Tag = (
                  level === 1 ? 'h3' : level === 2 ? 'h4' : level === 3 ? 'h5' : 'h6'
                ) as 'h3' | 'h4' | 'h5' | 'h6';
                return (
                  <Tag key={pi} className="mb-1 mt-2 font-semibold text-fg">
                    {inline(heading[2] ?? '', `${ti}-${pi}`)}
                  </Tag>
                );
              }

              // Audit G-5: lists had NO handling — `- a\n- b` rendered as one
              // paragraph with literal dashes, which is what agents emit most.
              const lines = block.split('\n');
              const bulletRe = /^\s*[-*+]\s+(.*)$/;
              const orderedRe = /^\s*\d+[.)]\s+(.*)$/;
              if (lines.every((l) => bulletRe.test(l))) {
                return (
                  <ul key={pi} className="mb-2 list-disc pl-5 last:mb-0">
                    {lines.map((l, li) => (
                      <li key={li}>{inline(bulletRe.exec(l)?.[1] ?? '', `${ti}-${pi}-${li}`)}</li>
                    ))}
                  </ul>
                );
              }
              if (lines.every((l) => orderedRe.test(l))) {
                return (
                  <ol key={pi} className="mb-2 list-decimal pl-5 last:mb-0">
                    {lines.map((l, li) => (
                      <li key={li}>{inline(orderedRe.exec(l)?.[1] ?? '', `${ti}-${pi}-${li}`)}</li>
                    ))}
                  </ol>
                );
              }

              return (
                <p key={pi} className="mb-2 last:mb-0">
                  {inline(block, `${ti}-${pi}`)}
                </p>
              );
            })}
          </Fragment>
        );
      })}
      {streaming && <span className="h-live text-accent">▍</span>}
    </div>
  );
}
