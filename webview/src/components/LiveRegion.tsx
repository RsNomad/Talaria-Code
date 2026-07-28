/**
 * WCAG 2.2 SC 4.1.3 live region. ALWAYS mounted — callers render it
 * unconditionally and swap `text` (Finding-7: a region that mounts together
 * with its content is the known-unreliable announcement pattern; MDN Live
 * regions: "Start with an empty live region, then – in a separate step –
 * change the content inside the region" —
 * https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions,
 * fetched live for this task).
 *
 * `polite` (default) → `role="status"` + explicit `aria-live="polite"` (MDN
 * recommends the redundant pair for compat). `assertive` → `role="alert"`
 * with NO extra `aria-live` — `role="alert"` is documented to announce
 * content already present at mount (unlike `role="status"`), and pairing it
 * with `aria-live="assertive"` "causes double speaking issues in VoiceOver
 * on iOS" (MDN, ibid.).
 *
 * Path doc §2.1 (`af-architecture-path.md`) — introduced in A2 (attachment
 * notice, polite), adopted by A3 (FieldRow, polite) and B1 (approval
 * announcer, assertive). Keep this signature stable — later tasks depend on
 * it unchanged.
 */
export function LiveRegion({
  text,
  assertive,
  className,
  title,
}: {
  text: string;
  assertive?: boolean;
  className?: string;
  title?: string;
}) {
  return assertive ? (
    <div role="alert" className={className} title={title}>
      {text}
    </div>
  ) : (
    <div role="status" aria-live="polite" className={className} title={title}>
      {text}
    </div>
  );
}
