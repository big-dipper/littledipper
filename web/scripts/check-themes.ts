/**
 * Every theme, light and dark, checked for readable contrast (WCAG AA: 4.5 for text) on the pairs the app uses most.
 * Mixes colors the way app.css does (color-mix in sRGB). Run: npx tsx web/scripts/check-themes.ts
 */
import { THEMES } from '../src/appearance';

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, pct: number, b: RGB): RGB => a.map((x, i) => x * pct / 100 + b[i] * (1 - pct / 100)) as RGB;
const lum = (c: RGB) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let failed = 0;
for (const t of THEMES) for (const mode of ['light', 'dark'] as const) {
  const s = t[mode];
  const [bg, surface, text, accent, accent2] = [s.bg, s.surface, s.text, s.accent, s.accent2].map(hex);
  const pairs: [string, RGB, RGB][] = [
    ['text on page', text, bg], ['text on card', text, surface], ['muted text', mix(text, 65, bg), bg],
    ['links on page', accent, bg], ['links on card', accent, surface], ['button label', bg, accent],
    ['tag', mix(accent, 75, text), mix(accent, 8, bg)], ['second tag', mix(accent2, 75, text), mix(accent2, 8, bg)],
    ['second color on page', accent2, bg],
  ];
  const bad = pairs.map(([n, a, b]) => [n, ratio(a, b)] as const).filter(([, r]) => r < 4.5);
  failed += bad.length;
  console.log(`${bad.length ? '✗' : '✓'} ${t.label} (${mode})${bad.map(([n, r]) => `  ${n} ${r.toFixed(2)}`).join('')}`);
}
if (failed) { console.log(`\n${failed} pairs below 4.5`); process.exit(1); }
console.log('\nAll themes readable.');
