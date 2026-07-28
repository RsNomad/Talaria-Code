/*
 * Codicon wrapper. Uses @vscode/codicons (bundled locally, imported in
 * main.tsx). `name` is a codicon id without the `codicon-` prefix, e.g.
 * <Icon name="git-commit" />. NOT Material Symbols / external fonts.
 */
interface IconProps {
  name: string;
  className?: string;
  /** px size; defaults to inherit (16px from CSS). */
  size?: number;
  spin?: boolean;
  title?: string;
}

export function Icon({ name, className = '', size, spin, title }: IconProps) {
  return (
    <span
      className={`codicon codicon-${name} ${spin ? 'codicon-modifier-spin' : ''} ${className}`}
      style={size ? { fontSize: size } : undefined}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      title={title}
    />
  );
}
