import { describe, it, expect } from 'vitest';
import { mapToolKind, mapToolStatus, mapPlanStatus, mapPlanEntry } from './toolKind';
import type { AcpToolStatus } from './types';

describe('mapToolKind', () => {
  it('passes through kinds shared with the protocol union', () => {
    expect(mapToolKind('read')).toBe('read');
    expect(mapToolKind('search')).toBe('search');
    expect(mapToolKind('fetch')).toBe('fetch');
    expect(mapToolKind('execute')).toBe('execute');
    expect(mapToolKind('think')).toBe('think');
  });

  it('collapses delete/move onto edit', () => {
    expect(mapToolKind('delete')).toBe('edit');
    expect(mapToolKind('move')).toBe('edit');
    expect(mapToolKind('edit')).toBe('edit');
  });

  it('collapses switch_mode and unknown/missing onto other', () => {
    expect(mapToolKind('switch_mode')).toBe('other');
    expect(mapToolKind('other')).toBe('other');
    expect(mapToolKind(null)).toBe('other');
    expect(mapToolKind(undefined)).toBe('other');
  });
});

describe('mapToolStatus', () => {
  it('maps in_progress to running and completed to done', () => {
    expect(mapToolStatus('in_progress')).toBe('running');
    expect(mapToolStatus('completed')).toBe('done');
    expect(mapToolStatus('failed')).toBe('failed');
  });

  it('defaults missing/pending status to pending', () => {
    expect(mapToolStatus('pending')).toBe('pending');
    expect(mapToolStatus(null)).toBe('pending');
    expect(mapToolStatus(undefined)).toBe('pending');
  });

  it('lock: never returns approved/denied for any ACP input (those are folded client-side only, from approval.settle — the host never emits them on tool.* messages)', () => {
    const acpInputs: (AcpToolStatus | null | undefined)[] = [
      'pending',
      'in_progress',
      'completed',
      'failed',
      null,
      undefined,
    ];
    for (const input of acpInputs) {
      const mapped = mapToolStatus(input);
      expect(mapped).not.toBe('approved');
      expect(mapped).not.toBe('denied');
    }
  });
});

describe('mapPlanStatus / mapPlanEntry', () => {
  it('maps in_progress to active and completed to done', () => {
    expect(mapPlanStatus('in_progress')).toBe('active');
    expect(mapPlanStatus('completed')).toBe('done');
    expect(mapPlanStatus('pending')).toBe('pending');
  });

  it('builds a protocol PlanItem from an ACP PlanEntry', () => {
    expect(mapPlanEntry({ content: 'Run tests', status: 'in_progress', priority: 'medium' })).toEqual({
      text: 'Run tests',
      status: 'active',
    });
  });
});
