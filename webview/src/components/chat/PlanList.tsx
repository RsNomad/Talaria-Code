/* Live execution plan: done / active / pending steps. */
import type { PlanItemView } from '../../types';
import type { PlanItem } from '../../protocol';
import { Icon } from '../Icon';

function StepRow({ step }: { step: PlanItem }) {
  const mark =
    step.status === 'done'
      ? { icon: 'pass-filled', cls: 'text-add' }
      : step.status === 'active'
        ? { icon: 'loading', cls: 'text-run', spin: true }
        : { icon: 'circle-large-outline', cls: 'text-faint' };
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
