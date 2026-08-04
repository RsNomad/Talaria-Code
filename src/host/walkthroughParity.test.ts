import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Manifest drift lock: the onboarding walkthrough step, the `view/title`
 * panel icon, and the command declaration must all keep routing through the
 * single state-aware Setup entry point, `talaria.openSetup`. A future
 * manifest edit that renames/duplicates/orphans one of these three
 * `contributes` entries should fail THIS test rather than silently drift.
 */
describe('LOCK: walkthrough + view/title entries route through talaria.openSetup', () => {
  it('walkthrough + view/title entries all route through talaria.openSetup', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    const step = pkg.contributes.walkthroughs[0].steps.find((s: { id: string }) => s.id === 'openBackendSetup');
    expect(step.description).toContain('(command:talaria.openSetup)');
    expect(step.completionEvents).toContain('onCommand:talaria.openSetup');
    const titleEntries = pkg.contributes.menus['view/title'].map((m: { command: string }) => m.command);
    expect(titleEntries).toContain('talaria.openSetup');
    expect(pkg.contributes.commands.map((c: { command: string }) => c.command)).toContain('talaria.openSetup');
  });
});
