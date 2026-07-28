import type { ToolKind, ToolStatus, PlanItem } from '../../../shared/protocol';
import type { AcpToolKind, AcpToolStatus, AcpPlanEntry } from './types';

/**
 * ACP `ToolKind` -> protocol {@link ToolKind}. ACP has `delete`/`move`/
 * `switch_mode` that the webview's icon set (spec §3.5 table) does not model;
 * collapse them onto the closest visual treatment rather than `other`, since
 * delete/move are still file mutations (`edit`-shaped) to a user.
 */
export function mapToolKind(kind: AcpToolKind | null | undefined): ToolKind {
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
    case 'execute':
    case 'think':
      return kind;
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'switch_mode':
    case 'other':
    default:
      return 'other';
  }
}

/** ACP `ToolCallStatus` -> protocol {@link ToolStatus}. Undefined/null defaults to `pending` (ACP default). */
export function mapToolStatus(status: AcpToolStatus | null | undefined): ToolStatus {
  switch (status) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'pending':
    default:
      return 'pending';
  }
}

/** ACP plan entry status -> protocol {@link PlanItem} status. */
export function mapPlanStatus(status: AcpPlanEntry['status']): PlanItem['status'] {
  switch (status) {
    case 'in_progress':
      return 'active';
    case 'completed':
      return 'done';
    case 'pending':
    default:
      return 'pending';
  }
}

/** ACP `PlanEntry` -> protocol {@link PlanItem}. */
export function mapPlanEntry(entry: AcpPlanEntry): PlanItem {
  return { text: entry.content, status: mapPlanStatus(entry.status) };
}
