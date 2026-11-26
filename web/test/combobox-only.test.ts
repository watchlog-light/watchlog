// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// One searchable Combobox everywhere (ADR-239): no native <select> and no second dropdown
// component in the app, core or ee/. A new one fails here, with where it is.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { highlight, termsOf } from '@/lib/highlight';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIRS = [join(ROOT, 'web/src'), join(ROOT, 'ee/web')].filter((d) => existsSync(d));

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? vueFiles(join(dir, e.name))
      : e.name.endsWith('.vue')
        ? [join(dir, e.name)]
        : [],
  );
}
const files = DIRS.flatMap(vueFiles);
const using = (re: RegExp) =>
  files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));

/**
 * Lists with `role="listbox"` that are not a choice among options, with why they stay:
 * a search box whose text is itself the filter, with the matches as suggestions.
 */
const SEARCH_SUGGESTIONS = [
  'web/src/components/servicemap/MapSearch.vue',
  'ee/web/network/components/NetworkMap.vue',
];

describe('one Combobox (ADR-239)', () => {
  it('no component uses a native <select>', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(using(/<select[\s>]/)).toEqual([]);
  });

  it('only the Combobox draws a list of options to choose from', () => {
    const listboxes = using(/role="listbox"/).filter((f) => !SEARCH_SUGGESTIONS.includes(f));
    expect(listboxes).toEqual([]);
    // Reka's own Select or Listbox would be a second dropdown: there is the Combobox.
    expect(using(/\b(SelectRoot|ListboxRoot)\b/)).toEqual([]);
    // The Combobox primitives are used by the Combobox and the command palette only.
    expect(using(/\bComboboxRoot\b/).sort()).toEqual([
      'web/src/components/layout/CommandPalette.vue',
      'web/src/components/ui/ComboBox.vue',
    ]);
  });
});

describe('what was typed, shown in what was found', () => {
  it('cuts a text into hits and the parts between, whatever the case', () => {
    expect(highlight('Node CPU utilization', termsOf('cpu'))).toEqual([
      { text: 'Node ', hit: false },
      { text: 'CPU', hit: true },
      { text: ' utilization', hit: false },
    ]);
    expect(highlight('payments-api', termsOf('pay api'))).toEqual([
      { text: 'pay', hit: true },
      { text: 'ments-', hit: false },
      { text: 'api', hit: true },
    ]);
  });

  it('merges overlapping hits and leaves a text without one whole', () => {
    expect(highlight('aaaa', ['aa', 'aaa'])).toEqual([{ text: 'aaaa', hit: true }]);
    expect(highlight('orders', termsOf('zz'))).toEqual([{ text: 'orders', hit: false }]);
    expect(highlight('orders', [])).toEqual([{ text: 'orders', hit: false }]);
    expect(highlight('', termsOf('a'))).toEqual([{ text: '', hit: false }]);
    expect(termsOf('  Pay   API ')).toEqual(['pay', 'api']);
  });
});
