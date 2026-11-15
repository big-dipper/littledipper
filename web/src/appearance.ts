/**
 * Appearance: a few low-risk personal touches (a color theme, light or dark, text size, a font pairing). Not a theme
 * builder: each theme is a curated set of seeds checked for contrast (scripts/check-themes.ts), and every other
 * color in the app is worked out from those seeds in app.css, so a new theme is one entry here.
 *
 * The choice is saved on the node (the owner's prefs), so it follows you to every device, and cached on this device
 * so pages load in your colors before you've signed in. The server keeps the ids as they are; this skin decides
 * what they mean, and an id it doesn't know falls back to the default (Commandment XI: skins are swappable).
 *
 * Later, maybe: themes that follow the time of day or the season. `schedule` is reserved for that: resolve() is the
 * one place that turns a preference plus "now" into what's shown, so a schedule only has to change resolve().
 */
import { useEffect, useState } from 'react';

export type Mode = 'light' | 'dark' | 'system';
export type TextSize = 'standard' | 'larger' | 'largest';
export type Appearance = { theme: string; mode: Mode; textSize: TextSize; font: string; schedule?: 'none' };

/** The handful of colors a theme is made of. Scales (accent-100…900, neutrals) are mixed from these in app.css. */
type Seeds = { bg: string; surface: string; paper: string; text: string; accent: string; accent2: string };
export type Theme = { id: string; label: string; note: string; light: Seeds; dark: Seeds };

export const THEMES: Theme[] = [
  {
    id: 'night-sky', label: 'Night sky', note: 'Navy on warm paper. The original.',
    light: { bg: '#f7f4ef', surface: '#ece6dc', paper: '#ffffff', text: '#1c2230', accent: '#24496e', accent2: '#2f7268' },
    dark: { bg: '#11161f', surface: '#1b2230', paper: '#222b3b', text: '#e9e6df', accent: '#8fb2dc', accent2: '#7cc4b6' },
  },
  {
    id: 'forest', label: 'Forest', note: 'Pine and moss, with ochre.',
    light: { bg: '#f4f3ec', surface: '#e5e6da', paper: '#ffffff', text: '#1d2620', accent: '#2f5d45', accent2: '#86591a' },
    dark: { bg: '#121814', surface: '#1b241e', paper: '#222d26', text: '#e6e8e0', accent: '#8cc4a4', accent2: '#e0b067' },
  },
  {
    id: 'clay', label: 'Clay', note: 'Terracotta and sage.',
    light: { bg: '#f8f1ea', surface: '#efe1d4', paper: '#ffffff', text: '#2a1f1a', accent: '#9a4a2c', accent2: '#5f7350' },
    dark: { bg: '#1a1411', surface: '#261c17', paper: '#2f241e', text: '#eee4dc', accent: '#e59a77', accent2: '#a9bf96' },
  },
  {
    id: 'deep-teal', label: 'Deep teal', note: 'Teal with cocoa brown.',
    light: { bg: '#f3f4f1', surface: '#e2e7e4', paper: '#ffffff', text: '#1b2424', accent: '#1f5c63', accent2: '#6b4a3a' },
    dark: { bg: '#0f1718', surface: '#172224', paper: '#1e2b2d', text: '#e2e9e8', accent: '#7cc5cd', accent2: '#d0a58f' },
  },
  {
    id: 'plum', label: 'Plum', note: 'Plum and dusty rose.',
    light: { bg: '#f7f3f3', surface: '#ece2e4', paper: '#ffffff', text: '#261c24', accent: '#5e2f5a', accent2: '#a3545f' },
    dark: { bg: '#171217', surface: '#221b22', paper: '#2b222b', text: '#ece3ea', accent: '#d39ccd', accent2: '#e7a1aa' },
  },
  {
    id: 'harvest', label: 'Harvest', note: 'Ochre and olive, warm and bright.',
    light: { bg: '#faf5ea', surface: '#f0e6d0', paper: '#ffffff', text: '#2a2416', accent: '#7a5612', accent2: '#5f6f2e' },
    dark: { bg: '#18150e', surface: '#241f15', paper: '#2d271b', text: '#eee8d8', accent: '#e3b866', accent2: '#b8c97f' },
  },
  {
    id: 'cloud', label: 'Cloud', note: 'Soft white and slate. Calm and quiet.',
    light: { bg: '#f6f6f3', surface: '#e9eaea', paper: '#ffffff', text: '#202429', accent: '#3d5366', accent2: '#5b6b62' },
    dark: { bg: '#141618', surface: '#1d2023', paper: '#25292d', text: '#e7e8e8', accent: '#a9bfd2', accent2: '#a7b9ae' },
  },
  {
    id: 'ink', label: 'Ink', note: 'High contrast: black on white, for bright screens and tired eyes.',
    light: { bg: '#ffffff', surface: '#efefef', paper: '#ffffff', text: '#000000', accent: '#0b3d91', accent2: '#00594f' },
    dark: { bg: '#000000', surface: '#161616', paper: '#1e1e1e', text: '#ffffff', accent: '#9cc3ff', accent2: '#6fe0cf' },
  },
];

/** Font pairings: a heading face and a body face. Self-hosted (no requests to a font service). Add one here. */
export type FontPair = { id: string; label: string; note: string; heading: string; headingWeight: number; body: string };
export const FONTS: FontPair[] = [
  { id: 'little-dipper', label: 'Little Dipper', note: 'Round, friendly headings', heading: '"Caprasimo", system-ui, sans-serif', headingWeight: 400, body: '"Figtree", system-ui, sans-serif' },
  { id: 'classic', label: 'Classic', note: 'Elegant serif headings', heading: '"Fraunces", Georgia, serif', headingWeight: 600, body: '"Figtree", system-ui, sans-serif' },
  { id: 'clean', label: 'Clean', note: 'One plain, modern face', heading: '"Figtree", system-ui, sans-serif', headingWeight: 700, body: '"Figtree", system-ui, sans-serif' },
  { id: 'easy-reading', label: 'Easy reading', note: 'Designed for low vision', heading: '"Atkinson Hyperlegible", system-ui, sans-serif', headingWeight: 700, body: '"Atkinson Hyperlegible", system-ui, sans-serif' },
  { id: 'device', label: 'My device’s font', note: 'Whatever your phone or computer uses', heading: 'system-ui, sans-serif', headingWeight: 700, body: 'system-ui, sans-serif' },
];

export const TEXT_SIZES: [TextSize, string, number][] = [['standard', 'Standard', 1], ['larger', 'Larger', 1.12], ['largest', 'Largest', 1.25]];
export const MODES: [Mode, string][] = [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match my device']];

export const DEFAULT: Appearance = { theme: 'night-sky', mode: 'light', textSize: 'standard', font: 'little-dipper' };
const CACHE = 'ld.appearance';

/** A saved preference, made safe: anything unknown falls back to the default. */
export function normalise(a: Partial<Appearance> | null | undefined): Appearance {
  const x = a ?? {};
  return {
    theme: THEMES.some((t) => t.id === x.theme) ? x.theme! : DEFAULT.theme,
    mode: MODES.some(([m]) => m === x.mode) ? x.mode! : DEFAULT.mode,
    textSize: TEXT_SIZES.some(([s]) => s === x.textSize) ? x.textSize! : DEFAULT.textSize,
    font: FONTS.some((f) => f.id === x.font) ? x.font! : DEFAULT.font,
  };
}

const prefersDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** What to show now. The one place a time-of-day or seasonal schedule would plug in. */
export function resolve(a: Appearance, _now = new Date()): { theme: Theme; dark: boolean; font: FontPair; scale: number } {
  return {
    theme: THEMES.find((t) => t.id === a.theme) ?? THEMES[0],
    dark: a.mode === 'dark' || (a.mode === 'system' && prefersDark()),
    font: FONTS.find((f) => f.id === a.font) ?? FONTS[0],
    scale: TEXT_SIZES.find(([s]) => s === a.textSize)?.[2] ?? 1,
  };
}

/** Put a preference on the page. The default theme in light leaves app.css's hand-tuned palette untouched. */
export function apply(a: Appearance) {
  const root = document.documentElement;
  const { theme, dark, font, scale } = resolve(a);
  const custom = dark || theme.id !== DEFAULT.theme;
  const s = dark ? theme.dark : theme.light;
  if (custom) {
    root.dataset.theme = theme.id;
    for (const [k, v] of Object.entries(s)) root.style.setProperty(`--seed-${k}`, v);
  } else {
    delete root.dataset.theme;
    for (const k of Object.keys(s)) root.style.removeProperty(`--seed-${k}`);
  }
  root.dataset.mode = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.setProperty('--font-heading', font.heading);
  root.style.setProperty('--font-heading-weight', String(font.headingWeight));
  root.style.setProperty('--font-body', font.body);
  // Text size scales the whole page, like the browser's own zoom, so spacing grows with the words.
  root.style.zoom = scale === 1 ? '' : String(scale);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', s.bg);
  try { localStorage.setItem(CACHE, JSON.stringify(a)); } catch { /* private mode */ }
}

/** This device's last-used preference, for the first paint. */
export function cached(): Appearance {
  try { return normalise(JSON.parse(localStorage.getItem(CACHE) || 'null')); } catch { return DEFAULT; }
}

/** Re-apply when the device switches between light and dark, for "Match my device". */
export function useFollowDevice(a: Appearance) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (a.mode !== 'system' || typeof matchMedia !== 'function') return;
    const m = matchMedia('(prefers-color-scheme: dark)');
    const on = () => { apply(a); tick((n) => n + 1); };
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [a]);
}
