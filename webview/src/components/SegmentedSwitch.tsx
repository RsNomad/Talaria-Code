/*
 * UX-13 (ADR-UX-P2-3, owner-decided 2026-08-22): the ONE shared segmented
 * switch strip. Collapses the three hand-rolled `inline-flex gap-1` picker
 * strips in `SetupPanel.tsx` (agent backend, FIM Connect/Install, RAG
 * embedding backend) onto one component — markup byte-copied from those
 * strips, look and behavior preserved. Row-shaped pickers (Agent/FIM) stay
 * on the existing shared `BackendOptionRow` — forcing all four pickers into
 * one visual shape is an owner-overridable option recorded in ADR-UX-P2-3,
 * NOT approved, and out of scope here. Result: every picker in SetupPanel
 * renders through exactly one of TWO shared components, zero hand-rolled
 * copies left.
 *
 * A11y net-gain over the three strips it replaces (which were anonymous,
 * unnamed `<div>` wrappers): `role="group"` named by `ariaLabel` gives each
 * strip an accessible group name, and every option button carries
 * `aria-pressed` reflecting selection.
 */
export function SegmentedSwitch<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={`inline-flex gap-1 rounded border border-border p-0.5 ${className ?? 'self-start'}`}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-wide ${
            value === o.id ? 'border border-accent bg-accent-soft font-semibold text-accent' : 'border border-transparent text-faint hover:text-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
