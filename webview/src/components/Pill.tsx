/*
 * Status pill — the telemetry read-out badge used across chat + panels.
 * Monospace, uppercase, tiny, tinted by tone.
 */
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type PillTone = 'accent' | 'add' | 'del' | 'warn' | 'run' | 'neutral';

const TONE: Record<PillTone, string> = {
  accent: 'text-accent bg-accent-soft',
  add: 'text-add bg-add-soft',
  del: 'text-del bg-del-soft',
  warn: 'text-warn bg-warn-soft',
  run: 'text-run bg-run-soft',
  neutral: 'text-muted bg-overlay',
};

interface PillProps {
  tone?: PillTone;
  icon?: string;
  spin?: boolean;
  live?: boolean;
  children: ReactNode;
}

export function Pill({ tone = 'neutral', icon, spin, live, children }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wider ${TONE[tone]}`}
    >
      {icon && <Icon name={icon} size={11} spin={spin} className={live ? 'h-live' : ''} />}
      {children}
    </span>
  );
}
