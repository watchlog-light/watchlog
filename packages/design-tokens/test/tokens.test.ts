// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The colour tokens from SPEC §11.1, with the neutral palette from ADR-038, in order.
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

function declaredTokens(): Map<string, string> {
  const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

describe('tokens.css', () => {
  it('declares exactly the SPEC §11.1 colour tokens with their values', () => {
    const tokens = declaredTokens();
    const colourTokens = [...tokens].filter(([name]) => !name.startsWith('--chart-'));
    expect(Object.fromEntries(colourTokens)).toEqual(SPEC_TOKENS);
  });

  it('declares the eight-colour chart palette', () => {
    const chart = [...declaredTokens().keys()].filter((name) => name.startsWith('--chart-'));
    expect(chart).toEqual(Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`));
  });
});
