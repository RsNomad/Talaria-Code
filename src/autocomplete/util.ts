/**
 * Joins a runner base URL (e.g. `http://127.0.0.1:11434`) to a relative endpoint path
 * (e.g. `api/generate`) without losing an existing subpath on the base and without
 * doubling slashes. Plain `new URL(path, base)` silently drops the base's last path
 * segment unless it ends with `/`, which is an easy way to accidentally strip a
 * reverse-proxy prefix — so we normalize that here instead of at every call site.
 */
export function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}
