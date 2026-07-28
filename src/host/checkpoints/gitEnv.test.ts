import { describe, expect, it } from 'vitest';

import { sanitizeGitEnv } from './gitEnv';

describe('sanitizeGitEnv', () => {
  it('strips every inherited git-repo-location var (dev-container / direnv leakage)', () => {
    const base = {
      PATH: '/usr/bin',
      GIT_DIR: '/some/devcontainer/.git',
      GIT_WORK_TREE: '/some/devcontainer',
      GIT_INDEX_FILE: '/tmp/index',
      GIT_OBJECT_DIRECTORY: '/tmp/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/alt',
      GIT_CEILING_DIRECTORIES: '/tmp',
      GIT_TEMPLATE_DIR: '/tmp/tmpl',
      GIT_COMMON_DIR: '/tmp/common',
    };

    const result = sanitizeGitEnv(base);

    expect(result.PATH).toBe('/usr/bin');
    expect(result.GIT_DIR).toBeUndefined();
    expect(result.GIT_WORK_TREE).toBeUndefined();
    expect(result.GIT_INDEX_FILE).toBeUndefined();
    expect(result.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(result.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(result.GIT_CEILING_DIRECTORIES).toBeUndefined();
    expect(result.GIT_TEMPLATE_DIR).toBeUndefined();
    expect(result.GIT_COMMON_DIR).toBeUndefined();
  });

  it('applies explicit GIT_DIR/GIT_WORK_TREE overrides after stripping', () => {
    const base = { PATH: '/usr/bin', GIT_DIR: '/wrong/.git' };

    const result = sanitizeGitEnv(base, {
      GIT_DIR: '/shadow/.git',
      GIT_WORK_TREE: '/workspace',
    });

    expect(result.GIT_DIR).toBe('/shadow/.git');
    expect(result.GIT_WORK_TREE).toBe('/workspace');
    expect(result.PATH).toBe('/usr/bin');
  });

  it('does not mutate the base env object', () => {
    const base = { GIT_DIR: '/wrong/.git' };

    sanitizeGitEnv(base, { GIT_DIR: '/shadow/.git' });

    expect(base.GIT_DIR).toBe('/wrong/.git');
  });

  it('leaves GIT_DIR/GIT_WORK_TREE unset for plain discovery calls (no overrides given)', () => {
    const base = { GIT_DIR: '/wrong/.git', GIT_WORK_TREE: '/wrong', PATH: '/usr/bin' };

    const result = sanitizeGitEnv(base);

    expect(result.GIT_DIR).toBeUndefined();
    expect(result.GIT_WORK_TREE).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
  });
});
