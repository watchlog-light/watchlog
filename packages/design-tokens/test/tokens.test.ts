// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The colour tokens from SPEC §11.1, with the neutral palette from ADR-038, in order: dark,
// the default `:root`, exactly as before the light theme (ADR-228).
const SPEC_TOKENS: Record<string, string> = {
  '--bg': '#0e0f11',
  '--surface-1': '#15171a',
  '--surface-2': '#1b1e22',
  '--surface-3': '#22252a',
  '--border': '#2a2e34',
  '--border-strong': '#3a3f46',
  '--text': '#e8eaed',
  '--text-muted': '#9ba1a9',
  '--text-subtle': '#6b7179',
  '--primary': '#22c55e',
  '--primary-hover': '#16a34a',
  '--primary-soft': 'rgba(34, 197, 94, 0.12)',
  '--primary-glow': 'rgba(34, 197, 94, 0.35)',
  '--on-primary': '#04140a',
  '--ok': '#22c55e',
  '--warning': '#f5a524',
  '--critical': '#f04438',
  '--info': '#3b9eff',
};

// ADR-228's tokens for text in the status and primary colours, in dark equal to the colours
// used for that text before, so dark looks exactly as it did.
const TEXT_TOKENS_DARK: Record<string, string> = {
  '--ok-text': '#22c55e',
  '--warning-text': '#f5a524',
  '--critical-text': '#f04438',
  '--info-text': '#3b9eff',
  '--link': '#22c55e',
  '--primary-border': 'rgba(34, 197, 94, 0.4)',
  // The danger button's text: the old `text-text` in dark.
  '--on-critical': '#e8eaed',
};

const CHART_DARK = [
  '#22c55e',
  '#3b9eff',
  '#f5a524',
  '#a78bfa',
  '#2dd4bf',
  '#f472b6',
  '#fb923c',
  '#94a3b8',
];

const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');

/** The declarations of one rule, by its exact selector. */
function block(selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(at, css.indexOf('}', at));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    tokens.set(match[1]!, match[2]!.trim());
  return tokens;
}
const dark = block(':root');
const light = block(":root[data-theme='light']");
const colours = (m: Map<string, string>) => [...m.keys()].filter((k) => !k.startsWith('--shadow'));

describe('tokens.css', () => {
  it('keeps dark, the default, exactly as before', () => {
    const colourTokens = [...dark].filter(
      ([name]) =>
        !name.startsWith('--chart-') && !name.startsWith('--shadow') && !(name in TEXT_TOKENS_DARK),
    );
    expect(Object.fromEntries(colourTokens)).toEqual(SPEC_TOKENS);
    expect(Object.fromEntries([...dark].filter(([n]) => n in TEXT_TOKENS_DARK))).toEqual(
      TEXT_TOKENS_DARK,
    );
    expect(Array.from({ length: 8 }, (_, i) => dark.get(`--chart-${i + 1}`))).toEqual(CHART_DARK);
    expect(css).toMatch(/:root \{\s*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme='dark'\] \{\s*color-scheme: dark;\s*\}/);
  });

  it('declares the eight-colour chart palette', () => {
    const chart = [...dark.keys()].filter((name) => name.startsWith('--chart-'));
    expect(chart).toEqual(Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`));
  });

  it('light overrides every colour token, and only those', () => {
    expect(css).toMatch(/:root\[data-theme='light'\] \{\s*color-scheme: light;/);
    expect(colours(light).sort()).toEqual(colours(dark).sort());
    expect(light.has('--shadow')).toBe(true);
    expect(light.has('--shadow-lg')).toBe(true);
  });

  it('every token Tailwind maps exists', () => {
    const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
    for (const m of theme.matchAll(/--(?:color|shadow)-[\w-]+:\s*var\((--[\w-]+)\)/g))
      expect(dark.has(m[1]!), m[1]).toBe(true);
  });
});

// WCAG 2.1 contrast (relative luminance of sRGB hex colours).
function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe.each([
  ['dark', dark],
  ['light', light],
])('contrast in %s', (theme, t) => {
  const get = (k: string) => t.get(k) ?? dark.get(k)!;
  const TEXT = [
    '--text',
    '--text-muted',
    '--ok-text',
    '--warning-text',
    '--critical-text',
    '--info-text',
    '--link',
  ];
  it.each(TEXT)('%s is at least 4.5 on bg and surface-1', (token) => {
    expect(contrast(get(token), get('--bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get(token), get('--surface-1'))).toBeGreaterThanOrEqual(4.5);
  });
  it('on-primary is at least 4.5 on primary', () => {
    expect(contrast(get('--on-primary'), get('--primary'))).toBeGreaterThanOrEqual(4.5);
  });
  // Dark keeps its look (3.0, bold text on a button); light's danger button reads at AA.
  it('on-critical is at least 3 on critical, and 4.5 in light', () => {
    expect(contrast(get('--on-critical'), get('--critical'))).toBeGreaterThanOrEqual(
      theme === 'light' ? 4.5 : 3,
    );
  });
  const LARGE = [
    '--text-subtle',
    '--ok',
    '--warning',
    '--critical',
    '--info',
    ...Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`),
  ];
  it.each(LARGE)('%s is at least 3 on surface-1', (token) => {
    expect(contrast(get(token), get('--surface-1'))).toBeGreaterThanOrEqual(3);
  });
});
