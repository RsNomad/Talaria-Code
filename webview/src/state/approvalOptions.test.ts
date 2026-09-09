import { describe, it, expect } from 'vitest';
import type { ApprovalOption } from '../protocol';
import { classifySelectedOption, selectedSettleToolStatus } from './approvalOptions';

/**
 * R3-SEC-01: `classifySelectedOption`/`selectedSettleToolStatus` are the
 * SHARED fail-safe verdict helpers both webview consumers (`transcript.ts`'s
 * `deriveSettledToolStatus` and `ChatView.tsx`'s `deniedToolIds`) must read
 * off of — an unresolvable selected id (absent, or naming no option of THIS
 * approval) must NEVER classify as an affirmative allow.
 */
describe('classifySelectedOption / selectedSettleToolStatus (R3-SEC-01 fail-safe verdict)', () => {
  const OPTIONS: ApprovalOption[] = [
    { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
    { id: 'allow_session', label: 'Allow for session', kind: 'allow_session' },
    { id: 'allow_always', label: 'Always allow', kind: 'allow_always' },
    { id: 'deny', label: 'Deny', kind: 'deny' },
    { id: 'deny_always', label: 'Always deny', kind: 'deny_always' },
  ];

  it.each([
    [undefined, 'unresolved', 'interrupted'],
    ['nope', 'unresolved', 'interrupted'],
    ['deny', 'deny', 'denied'],
    ['deny_always', 'deny', 'denied'],
    ['allow_once', 'allow', 'approved'],
    ['allow_session', 'allow', 'approved'],
    ['allow_always', 'allow', 'approved'],
  ] as const)('optionId=%s -> verdict=%s, status=%s', (optionId, verdict, status) => {
    expect(classifySelectedOption(OPTIONS, optionId)).toBe(verdict);
    expect(selectedSettleToolStatus(OPTIONS, optionId)).toBe(status);
  });

  it('empty options -> unresolved/interrupted regardless of the requested id', () => {
    expect(classifySelectedOption([], 'allow_once')).toBe('unresolved');
    expect(selectedSettleToolStatus([], 'allow_once')).toBe('interrupted');
    expect(classifySelectedOption([], undefined)).toBe('unresolved');
    expect(selectedSettleToolStatus([], undefined)).toBe('interrupted');
  });
});
