/**
 * JINI mobile design tokens — "warm paper", shared with desktop. One warm temperature for
 * every neutral, a single clay accent, ink primary buttons. No purple, no glass, no glow.
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FBF8F2', // paper — app canvas
        oat: '#F3EEE4', // bars, grouped backgrounds
        surface: '#FFFDF9', // rows, inputs, sheets
        'surface-2': '#F1EBE0', // pressed / selected
        hairline: '#E6DECF', // dividers and borders
        sand: '#D8CDBB', // strong borders
        text: '#1F1B16', // warm ink
        body: '#3A342D',
        muted: '#6E665B',
        faint: '#9A9183',
        accent: '#B05A33', // clay — active state, links, progress
        'accent-strong': '#97492A',
        'on-accent': '#FFFDF9',
        ink: '#1F1B16', // primary buttons
        paper: '#FBF8F2',
        clay: '#B05A33',
        sage: '#4F7F55',
        ochre: '#A86E1A',
        slate: '#4E6A85',
        ok: '#4F7F55',
        warn: '#A86E1A',
        danger: '#B4473A',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
        serif: ['"Fraunces Variable"', 'Georgia', 'serif'],
      },
      fontSize: {
        title: ['30px', { lineHeight: '36px', letterSpacing: '-0.015em', fontWeight: '450' }],
        body: ['15px', { lineHeight: '22px' }],
        meta: ['12.5px', { lineHeight: '17px' }],
      },
      borderRadius: { xl: '14px', '2xl': '20px' },
    },
  },
  plugins: [],
};
