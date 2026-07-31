import { describe, expect, it } from 'vitest';
import { totalLookup } from '../../lookup';
import { STEP_MARK, UNKNOWN_STEP_MARK } from './PlanList';

describe('PlanList STEP_MARK — AUDIT-5 UI I-1 (F-3 type surgery)', () => {
  it('interrupted renders a NON-spinning stop-circle — a dead turn must not spin', () => {
    expect(STEP_MARK.interrupted.icon).toBe('stop-circle');
    expect(STEP_MARK.interrupted.spin).toBeUndefined();
  });

  it('active is the only spinning mark', () => {
    const spinning = Object.entries(STEP_MARK).filter(([, m]) => m.spin === true);
    expect(spinning.map(([k]) => k)).toEqual(['active']);
  });

  it('an out-of-union status from a version-skewed host degrades to the unknown mark', () => {
    expect(totalLookup(STEP_MARK, 'weird-future-status', UNKNOWN_STEP_MARK)).toBe(UNKNOWN_STEP_MARK);
  });
});
