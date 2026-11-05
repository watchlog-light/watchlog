// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// Every literal i18n key used in web/src must exist in en.json (UI strings rule, CLAUDE.md).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
// $t('a.b'), t('a.b'), titleKey: 'a.b'
const KEY_USE = /(?:\$t|\bt)\(\s*'([a-zA-Z0-9_.]+)'|titleKey:\s*'([a-zA-Z0-9_.]+)'/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(vue|ts)$/.test(entry.name) ? [path] : [];
  });
}

function hasKey(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

describe('i18n keys', () => {
  it('finds every key used in the source in en.json', () => {
    const used = sourceFiles(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(KEY_USE)].map((m) => ({
        file: file.slice(SRC.length + 1),
        key: (m[1] ?? m[2])!,
      })),
    );
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter(({ key }) => !hasKey(key))).toEqual([]);
  });

  it('compiles every message (an unescaped @ or | breaks rendering at runtime)', async () => {
    const { createAppI18n } = await import('../src/i18n');
    const i18n = createAppI18n();
    const errors: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        try {
          i18n.global.t(path, { n: 1 });
        } catch (err) {
          errors.push(`${path}: ${(err as Error).message}`);
        }
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(en, '');
    expect(errors).toEqual([]);
  });
});
