// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// Enforces "all colours come from design tokens; no hex values in components" (CLAUDE.md),
// and the 11 px type step only where SPEC §11.2 allows it (ADR-115).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(vue|ts|css)$/.test(entry.name) ? [path] : [];
  });
}

describe('design token guard', () => {
  it('finds no colour literals in web/src', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter(({ text }) => COLOUR_LITERAL.test(text)),
    );
    expect(offenders).toEqual([]);
  });

  // 11 px is for uppercase micro-labels and chart axis labels only (SPEC §11.2, ADR-115).
  it('uses 11 px only for uppercase micro-labels and chart axis labels', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        const at = `${file.slice(SRC.length + 1)}:${i + 1}`;
        // The utility class: only together with `uppercase` on the same element.
        if (/(?<![-\w])text-11\b/.test(line) && !/\buppercase\b/.test(line)) offenders.push(at);
        // No raw 11px: use the token, so the uses stay countable.
        if (/font-size:\s*11px/.test(line)) offenders.push(at);
        // ECharts options: 11 only on axis labels.
        if (/fontSize:\s*11\b/.test(line)) {
          const before = text
            .split('\n')
            .slice(Math.max(0, i - 3), i + 1)
            .join('\n');
          if (!/axisLabel/.test(before)) offenders.push(at);
        }
      });
      // The token in CSS: only in a rule that is uppercase, or the chart's tick labels.
      for (const [, selector = '', body = ''] of text.matchAll(
        /([^{}]+)\{([^{}]*var\(--text-11\)[^{}]*)\}/g,
      )) {
        if (!/text-transform:\s*uppercase/.test(body) && !/\.ticks\b/.test(selector)) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${selector.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
