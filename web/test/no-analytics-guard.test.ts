// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// The dashboard sends nothing to third parties (ADR-119): Microsoft Clarity runs on the
// marketing site only, with consent. Fails if "clarity" appears anywhere in web/
// (sources, index.html, public/, configs, tests), except in this file.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
// Build output, dependencies and local test artefacts are not ours to scan.
const SKIP = new Set([
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  'screenshots',
  '.auth',
]);
const FORBIDDEN = /clarity/i;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(vue|ts|tsx|js|mjs|cjs|html|css|json|txt|md|svg|webmanifest)$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('no third-party analytics in the dashboard', () => {
  it('names no session-recording script anywhere in web/', () => {
    const offenders = files(WEB)
      .filter((file) => file !== SELF)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, i) => ({ file: relative(WEB, file), line: i + 1, text }))
          .filter(({ text }) => FORBIDDEN.test(text)),
      );
    expect(offenders).toEqual([]);
  });

  it('would catch it in a component', () => {
    expect(FORBIDDEN.test('<script src="https://www.Clarity.ms/tag/x">')).toBe(true);
  });
});
