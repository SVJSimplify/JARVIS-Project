module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: 'rgb(var(--accent) / <alpha-value>)',
        hot: 'rgb(var(--hot) / <alpha-value>)',
        steel: 'rgb(var(--steel) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Futura', 'Futura PT', 'Jost', 'Century Gothic', 'Segoe UI', 'sans-serif'],
        display: ['Futura', 'Futura PT', 'Jost', 'Century Gothic', 'Segoe UI', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
