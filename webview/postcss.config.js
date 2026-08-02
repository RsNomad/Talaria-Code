// Tailwind v4: the PostCSS plugin lives in the dedicated @tailwindcss/postcss
// package (upgrade guide "Using PostCSS"). v4 handles @import inlining and
// vendor prefixing itself (Lightning CSS), so postcss-import/autoprefixer are
// no longer needed here.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
