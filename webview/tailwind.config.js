/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Colors resolve to CSS custom properties defined in theme.css. Those
  // properties bridge our fixed brand tokens onto the live --vscode-* theme
  // variables, so utilities stay theme-aware in light / dark / high-contrast.
  theme: {
    extend: {
      colors: {
        surface: 'var(--h-surface)',
        raised: 'var(--h-raised)',
        panel: 'var(--h-panel)',
        overlay: 'var(--h-overlay)',
        border: 'var(--h-border)',
        'border-strong': 'var(--h-border-strong)',
        fg: 'var(--h-fg)',
        muted: 'var(--h-muted)',
        faint: 'var(--h-faint)',
        accent: 'var(--h-accent)',
        'accent-fg': 'var(--h-accent-fg)',
        'accent-soft': 'var(--h-accent-soft)',
        add: 'var(--h-add)',
        'add-soft': 'var(--h-add-soft)',
        del: 'var(--h-del)',
        'del-soft': 'var(--h-del-soft)',
        warn: 'var(--h-warn)',
        'warn-soft': 'var(--h-warn-soft)',
        run: 'var(--h-run)',
        'run-soft': 'var(--h-run-soft)',
      },
      fontFamily: {
        sans: 'var(--h-font-sans)',
        mono: 'var(--h-font-mono)',
      },
      fontSize: {
        '2xs': ['10.5px', '1.4'],
      },
      borderRadius: {
        card: '10px',
      },
    },
  },
  plugins: [],
};
