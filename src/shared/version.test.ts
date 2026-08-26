import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXTENSION_NAME, EXTENSION_VERSION } from './version';

/**
 * WS-AC S1-05: the ACP clientInfo identity is a shared constant so
 * acpClient.ts stays vscode-free — this pin is the anti-drift tripwire: a
 * release bump that touches package.json without src/shared/version.ts
 * fails the gate here, on purpose.
 */
describe('shared/version — pinned to package.json', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  it('EXTENSION_VERSION matches package.json "version"', () => {
    expect(EXTENSION_VERSION).toBe(pkg.version);
  });
  it('EXTENSION_NAME matches package.json "name"', () => {
    expect(EXTENSION_NAME).toBe(pkg.name);
  });
});
