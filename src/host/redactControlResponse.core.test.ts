import { describe, it, expect } from 'vitest';
import { redactSecretsDeep, CREDENTIAL_NAME_CORE } from './redactControlResponse';

/**
 * AU-59 (D-lite): `CREDENTIAL_NAME_CORE` is `SECRET_KEY` MINUS the
 * deliberately broad `env` alternative — the single source the consent-modal
 * hint ("looks like a credential and will be stored in plain text") is driven
 * by. The existing `redactControlResponse.test.ts` is left byte-UNTOUCHED and
 * proves the recomposed belt is behaviour-identical; this file pins the core
 * itself and the one property the split must preserve: the belt still
 * carries the `env` breadth the core drops.
 */
describe('AU-59 D-lite: CREDENTIAL_NAME_CORE is SECRET_KEY minus `env` (single source, behaviour-identical belt)', () => {
  it.each([
    'authorization', 'token', 'apiKey', 'api_key', 'api-key', 'password', 'secret', 'credential',
    'bearer', 'cookie', 'passphrase', 'private_key', 'privateKey', 'GITHUB_TOKEN', 'OPENAI_API_KEY',
  ])('matches the credential-shaped key %s', (key) => {
    expect(CREDENTIAL_NAME_CORE.test(key)).toBe(true);
  });

  it.each(['ENVIRONMENT', 'NODE_ENV', 'env', 'LOG_LEVEL', 'PATH', 'HOME', 'endpoint', 'model'])(
    'does NOT match the non-credential key %s (no `env` breadth in the hint core)',
    (key) => {
      expect(CREDENTIAL_NAME_CORE.test(key)).toBe(false);
    },
  );

  it('the composed belt still carries the `env` breadth the core drops: ENVIRONMENT/NODE_ENV/env values are redacted', () => {
    const out = redactSecretsDeep({ ENVIRONMENT: 'prod', NODE_ENV: 'test', env: { A: '1' }, kept: 'x' }) as Record<string, unknown>;
    expect(out.ENVIRONMENT).toBe('[redacted]');
    expect(out.NODE_ENV).toBe('[redacted]');
    expect(out.env).toBe('[redacted]');
    expect(out.kept).toBe('x');
  });

  it('the core is stateless (flags exactly `i`, no `g`): repeated .test() calls on the same key agree', () => {
    expect(CREDENTIAL_NAME_CORE.flags).toBe('i');
    expect(CREDENTIAL_NAME_CORE.test('token')).toBe(true);
    expect(CREDENTIAL_NAME_CORE.test('token')).toBe(true);
  });
});
