/**
 * Per-extension single-line comment token used to prefix the retrieval
 * header on each chunk. Falls back to `//` for anything unrecognized.
 */
const COMMENT_TOKEN_BY_EXTENSION: Record<string, string> = {
  ts: '//',
  tsx: '//',
  mts: '//',
  cts: '//',
  js: '//',
  jsx: '//',
  mjs: '//',
  cjs: '//',
  go: '//',
  rs: '//',
  java: '//',
  kt: '//',
  c: '//',
  h: '//',
  cpp: '//',
  hpp: '//',
  cc: '//',
  cxx: '//',
  cs: '//',
  php: '//',
  swift: '//',
  scala: '//',
  py: '#',
  pyw: '#',
  pyi: '#',
  rb: '#',
  sh: '#',
  bash: '#',
  yaml: '#',
  yml: '#',
  toml: '#',
  ex: '#',
  exs: '#',
  lua: '--',
  sql: '--',
  html: '<!--',
  htm: '<!--',
  xml: '<!--',
};

export function commentTokenForExtension(extension: string): string {
  return COMMENT_TOKEN_BY_EXTENSION[extension.toLowerCase()] ?? '//';
}

/**
 * Builds the `path › symbol › symbol` breadcrumb line prepended to every
 * chunk before embedding (how-to §3): "This injects path + symbol context
 * into the vector and dramatically improves 'where is X handled' recall."
 */
export function buildHeaderLine(relPath: string, symbolPath: string[], extension: string): string {
  const token = commentTokenForExtension(extension);
  const breadcrumb = [relPath, ...symbolPath].join(' › '); // " › "
  if (token === '<!--') {
    return `<!-- file: ${breadcrumb} -->`;
  }
  return `${token} file: ${breadcrumb}`;
}

export function prependHeader(headerLine: string, content: string): string {
  return `${headerLine}\n${content}`;
}
