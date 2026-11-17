/**
 * JINI design tokens — "warm paper". Shared with the mobile companion.
 *
 * One temperature for every neutral (paper → oat → sand → warm ink), a single clay accent
 * for state and links, and near-black ink for primary actions. No purple, no glass, no glow.
 *
 * Legacy names (accent / hot / steel / line) map onto the same palette through CSS
 * variables so every existing panel re-skins consistently.
 */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: 'rgb(var(--accent) / <alpha-value>)',
        hot: 'rgb(var(--hot) / <alpha-value>)',
        steel: 'rgb(var(--steel) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        paper: '#FBF8F2', // canvas
        oat: '#F3EEE4', // chrome / sidebar
        bg: '#FBF8F2',
        surface: '#FFFDF9', // cards, inputs
        'surface-2': '#F1EBE0', // pressed / selected
        hairline: '#E6DECF', // dividers
        sand: '#D8CDBB', // strong borders
        ink: '#1F1B16', // primary text + primary buttons
        text: '#1F1B16',
        body: '#3A342D',
        muted: '#6E665B',
        faint: '#9A9183',
        'accent-strong': '#97492A',
        'on-accent': '#FFFDF9',
        clay: '#B05A33',
        sage: '#4F7F55',
        ochre: '#A86E1A',
        brick: '#B4473A',
        slate: '#4E6A85',
        ok: '#4F7F55',
        warn: '#A86E1A',
        danger: '#B4473A',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['"Inter Variable"', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        serif: ['"Fraunces Variable"', 'Fraunces', 'Georgia', 'serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
