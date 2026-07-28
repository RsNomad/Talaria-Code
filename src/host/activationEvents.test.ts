import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * V-20 (Tier-2 remediation, T-20, owner-ratified fork F-2): the extension's
 * default-on autocomplete feature (`hermes.autocomplete.*`) has no `onView`/
 * `onCommand` trigger of its own — before this fix, `activationEvents` was
 * empty (`[]`), so the extension only activated once the user opened the
 * Hermes sidebar or ran a Hermes command, leaving autocomplete silently
 * inert on a fresh window. `onStartupFinished` is the sanctioned SPECIFIC
 * activation event for this case (vscode-extension skill baseline / VS Code
 * activation-events docs) — NOT `*`, which is the discouraged eager-
 * activation anti-pattern that would defeat the whole point of deferred
 * activation for every OTHER feature this extension has.
 *
 * This lock reads the real manifest (never restates it) so a future revert
 * of the entry fails loudly here instead of silently reopening the gap.
 */
const REPO_ROOT = join(__dirname, '..', '..');

function manifestActivationEvents(): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    activationEvents: string[];
  };
  return manifest.activationEvents;
}

describe('LOCK: activationEvents includes onStartupFinished (V-20)', () => {
  it('package.json activationEvents contains "onStartupFinished"', () => {
    expect(manifestActivationEvents()).toContain('onStartupFinished');
  });

  it('does NOT use the eager "*" activation anti-pattern', () => {
    expect(manifestActivationEvents()).not.toContain('*');
  });
});
