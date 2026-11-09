// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// Keys the backend sends for the web to translate must exist in en.json: a default
// alert's key (the connect drawer), a service page's tab and panel titles, an
// integration's reason codes and the metric catalog's names. The backend's sources are
// read here, so a new key without its words fails this test, not a person's screen.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';

const BACKEND = fileURLToPath(new URL('../../backend/src/modules/', import.meta.url));
const read = (path: string) => readFileSync(BACKEND + path, 'utf8');

function hasKey(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}
const missing = (keys: string[]) => [...new Set(keys)].filter((k) => !hasKey(k));

describe('keys the backend sends', () => {
  it('every default alert has its line in the connect drawer', () => {
    const keys = [...read('integrations/alert-defaults.ts').matchAll(/\bkey: '([a-z0-9_]+)'/g)].map(
      (m) => `applications.monitor.alert.${m[1]}`,
    );
    expect(keys.length).toBeGreaterThan(10);
    expect(missing(keys)).toEqual([]);
  });

  it("every service page's titles, notes and reasons have their words", () => {
    const keys: string[] = [];
    const pages = readdirSync(BACKEND + 'integrations/pages').filter((f) => f.endsWith('.ts'));
    for (const file of pages) {
      const src = read(`integrations/pages/${file}`);
      const P = /const P = '([a-zA-Z.]+)'/.exec(src)?.[1];
      if (P) {
        // `${P}.memory`, `${P}.cols.query`; a key built further (`${P}.series.${x}`) ends
        // in a dot and is checked by its own test.
        for (const m of src.matchAll(/\$\{P\}\.([a-zA-Z0-9_.]+)/g)) {
          if (!m[1]!.endsWith('.')) keys.push(`${P}.${m[1]}`);
        }
      }
      for (const m of src.matchAll(/'(integrations\.[a-zA-Z0-9_.]+)'/g)) {
        if (!m[1]!.endsWith('.') && m[1] !== P) keys.push(m[1]!);
      }
      // An integration's own reasons; the health and member reasons have their own words.
      if (!['reasons.ts', 'generic.ts', 'types.ts'].includes(file)) {
        for (const m of src.matchAll(/\bcode: '([a-z_]+)'/g))
          keys.push(`integrations.reasons.${m[1]}`);
      }
    }
    expect(keys.length).toBeGreaterThan(100);
    expect(missing(keys)).toEqual([]);
  });

  it('every service metric in the catalog has a name for the rule editor', () => {
    const src = read('query/catalog.ts');
    const keys = [...src.matchAll(/^ {2}'((?:service|redis|postgres)\.[a-z0-9_.]+)': \{/gm)].map(
      (m) => `metricNames.${m[1]!.replaceAll('.', '_')}`,
    );
    expect(keys.length).toBeGreaterThan(20);
    expect(missing(keys)).toEqual([]);
  });
});
