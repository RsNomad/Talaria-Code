/* Live execution plan: done / active / pending / interrupted steps. */
import type { PlanItemView, PlanStepView } from '../../types';
import { totalLookup } from '../../lookup';
import { Icon } from '../Icon';

/** Exported (ToolCard's UI-I1 precedent) so `PlanList.test.ts` can exercise
 * the total lookup directly — this repo's webview tests don't use jsdom.
 * `Record<PlanStepView['status'], …>` is EXHAUSTIVE by construction: adding
 * a status member without an icon is a compile error (the F-3 type-surgery
 * payoff — no silent fall-through for a new status). */
export const STEP_MARK: Record<PlanStepView['status'], { icon: string; cls: string; spin?: boolean }> = {
  done: { icon: 'pass-filled', cls: 'text-add' },
  active: { icon: 'loading', cls: 'text-run', spin: true },
  pending: { icon: 'circle-large-outline', cls: 'text-faint' },
  // AUDIT-5 UI I-1 (F-3): webview-only — an `active` step whose turn ended
  // abnormally (settlePlanSteps). stop-circle = ToolCard's own interrupted
  // icon (one visual language for "was running, turn died"). NOT spinning.
  interrupted: { icon: 'stop-circle', cls: 'text-faint' },
};

/** UI-I1 sibling (ToolCard's UNKNOWN_TOOL_STATUS): an out-of-union status
 * from a version-skewed host degrades to a neutral glyph instead of
 * `STEP_MARK[bad]` being `undefined` and `.icon` throwing mid-render. */
export const UNKNOWN_STEP_MARK: { icon: string; cls: string; spin?: boolean } = {
  icon: 'question',
  cls: 'text-faint',
};

function StepRow({ step }: { step: PlanStepView }) {
  const mark = totalLookup(STEP_MARK, step.status, UNKNOWN_STEP_MARK);
  return (
    <li className="flex items-center gap-2 py-0.5 text-[12.5px]">
      <Icon name={mark.icon} size={13} spin={mark.spin} className={`flex-none ${mark.cls}`} />
      <span className={step.status === 'done' ? 'text-faint line-through' : 'text-muted'}>
        {step.text}
      </span>
    </li>
  );
}

export function PlanList({ item }: { item: PlanItemView }) {
  const done = item.items.filter((s) => s.status === 'done').length;
  return (
    <div className="rounded-card border border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="h-eyebrow">Execution plan</span>
        <span className="font-mono text-2xs text-faint">
          {done}/{item.items.length}
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {/* M8: `PlanItem` ({ text, status }) carries no per-step id — ACP
            replaces the whole `plan.update.items` array wholesale on every
            update, so there's no cross-update step identity to key by.
            Index is safe here (and the only option); do not invent an id. */}
        {item.items.map((s, i) => (
          <StepRow key={i} step={s} />
        ))}
      </ul>
    </div>
  );
}
