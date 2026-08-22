/*
 * A11Y-05 (WCAG 4.1.3): the raw `{percent}%` rows sat inside
 * `aria-live="polite"` — a multi-GB pull chattered its way up 1% at a time,
 * and (SetupPanel:806) an interactive Cancel sat INSIDE a live region,
 * violating the repo's own T-15/F7 rule. This is the ONE announcer: the
 * visual progressbar row stays (aria-valuenow updates silently), and a
 * permanently-mounted sr-only LiveRegion (Finding-7 discipline) speaks only
 * 10%-step crossings plus 100%. Deliberately NO time-based cadence: a
 * stalled pull has nothing new to say — stall visibility is the visual
 * bar's + UX-09's "Working…" line's job, not the SR channel's.
 */
import { useEffect, useState } from 'react';
import { LiveRegion } from './LiveRegion';

export function announcedPercent(
  prev: number | undefined,
  current: number | undefined,
): number | undefined {
  if (current === undefined) return prev;
  if (current >= 100) return 100;
  const step = current - (current % 10);
  if (prev === undefined) return step;
  return step > prev ? step : prev;
}

export function PullAnnouncer({ label, percent }: { label: string; percent: number | undefined }) {
  const [announced, setAnnounced] = useState<number | undefined>(undefined);
  useEffect(() => {
    setAnnounced((p) => announcedPercent(p, percent));
  }, [percent]);
  return (
    <LiveRegion
      text={announced === undefined ? '' : `${label} — ${announced}%`}
      className="sr-only"
    />
  );
}
