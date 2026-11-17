/**
 * JINI mobile design tokens. One accent (lavender), flat solid surfaces, hairline dividers.
 * No glass, no glow, no gradients.
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0C0B10', // app background (violet-tinted near-black)
        surface: '#16151C', // raised rows, inputs, sheets
        'surface-2': '#1E1C26', // pressed / selected surface
        hairline: '#26242F', // dividers and input borders
        text: '#F3F1F7', // primary text
        muted: '#A6A2B2', // secondary text
        faint: '#6F6B7C', // tertiary / metadata
        accent: '#B4A3FF', // JINI lavender — primary actions, active state
        'accent-strong': '#9A85FF', // pressed accent
        'on-accent': '#15102A', // text on accent
        ok: '#7DD3A8',
        warn: '#E9C27B',
        danger: '#F28B8B',
      },
      fontFamily: { sans: ['"Inter Variable"', 'system-ui', 'sans-serif'] },
      fontSize: {
        title: ['28px', { lineHeight: '34px', letterSpacing: '-0.02em', fontWeight: '600' }],
        body: ['15px', { lineHeight: '22px' }],
        meta: ['12.5px', { lineHeight: '17px' }],
      },
      borderRadius: { xl: '14px', '2xl': '20px' },
    },
  },
  plugins: [],
};
