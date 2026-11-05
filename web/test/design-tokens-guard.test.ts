// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// Enforces "all colours come from design tokens; no hex values in components" (CLAUDE.md).
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
});
