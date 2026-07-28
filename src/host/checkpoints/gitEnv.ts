/**
 * Sanitized child-process environment for shadow-git commands.
 *
 * Rationale (`docs/specs/research-checkpoints-cline.md` §1, §4c — Fedora
 * dev-container / direnv leakage): a shell that already exports
 * `GIT_DIR`/`GIT_WORK_TREE`/etc. (common in devcontainers, direnv-managed
 * shells, or a parent git hook) would otherwise silently redirect our
 * shadow-git commands into the wrong repository — the exact class of bug
 * Roo's `createSanitizedGit()` exists to prevent. We always start from a
 * clean slate (strip every git-repo-location var) and then apply only the
 * `GIT_DIR`/`GIT_WORK_TREE` pair our shadow repo actually needs.
 */

/** Git env vars that must never leak in from the host process's environment. */
const GIT_ENV_VARS_TO_STRIP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_TEMPLATE_DIR',
  'GIT_COMMON_DIR',
] as const;

/** Explicit `GIT_DIR`/`GIT_WORK_TREE` pair to apply after stripping inherited values. */
export interface GitEnvOverrides {
  GIT_DIR?: string;
  GIT_WORK_TREE?: string;
}

/**
 * Strip any inherited git-repo-location env vars from `base`, then apply
 * `overrides` (if given) on top of the clean result.
 *
 * Passing no `overrides` is deliberate for the one-time "does a real repo
 * exist here" discovery call — that call must let git auto-discover from
 * `cwd` and must NOT inherit our own shadow `GIT_DIR` either.
 */
export function sanitizeGitEnv(
  base: NodeJS.ProcessEnv,
  overrides: GitEnvOverrides = {},
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_ENV_VARS_TO_STRIP) {
    delete clean[key];
  }
  if (overrides.GIT_DIR !== undefined) clean.GIT_DIR = overrides.GIT_DIR;
  if (overrides.GIT_WORK_TREE !== undefined) clean.GIT_WORK_TREE = overrides.GIT_WORK_TREE;
  return clean;
}
