// SPDX-License-Identifier: AGPL-3.0-only
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import { createAppI18n } from '@/i18n';

const OPTIONS: ComboboxOption[] = [
  {
    value: 'node.cpu',
    label: 'Node CPU utilization',
    group: 'Nodes',
    description: 'busy share of all cores',
  },
  { value: 'node.disk', label: 'Node disk usage', group: 'Nodes' },
  { value: 'pod.mem', label: 'Pod memory', group: 'Pods' },
  { value: 'pod.off', label: 'Pod restarts', group: 'Pods', disabled: true },
];

function host(props: Record<string, unknown>, initial: string | string[] | null) {
  const value = ref(initial);
  const Host = defineComponent({
    setup: () => () =>
      h(ComboBox, {
        options: OPTIONS,
        label: 'Metric',
        ...props,
        modelValue: value.value,
        'onUpdate:modelValue': (v: string | string[] | null) => (value.value = v),
      }),
  });
  const w = mount(Host, { attachTo: document.body, global: { plugins: [createAppI18n()] } });
  return { w, value };
}
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const key = async (k: string) => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  await flushPromises();
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Combobox (ADR-092)', () => {
  it('uses the ARIA combobox and listbox roles with groups and descriptions', async () => {
    const { w } = host({}, null);
    expect(input().getAttribute('aria-label')).toBe('Metric');
    await key('ArrowDown');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options().map((o) => o.textContent?.trim())).toEqual([
      'Node CPU utilizationbusy share of all cores',
      'Node disk usage',
      'Pod memory',
      'Pod restarts',
    ]);
    expect(document.body.textContent).toContain('Nodes');
    expect(options()[3]!.hasAttribute('data-disabled')).toBe(true);
    w.unmount();
  });

  it('filters as you type and says when nothing matches', async () => {
    const { w } = host({}, null);
    input().focus();
    await w.find('input').setValue('disk');
    await flushPromises();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Node disk usage']);
    await w.find('input').setValue('zzz');
    await flushPromises();
    expect(options()).toEqual([]);
    expect(document.querySelector('[data-testid="combobox-empty"]')?.textContent).toContain(
      'No matches',
    );
    w.unmount();
  });

  it('shows the chosen value in the text colour, the placeholder muted', async () => {
    const chosen = host({ placeholder: 'Any' }, 'pod.mem');
    expect(input().placeholder).toBe('Pod memory');
    expect(input().classList).toContain('placeholder:text-text');
    expect(input().classList).not.toContain('placeholder:text-text-subtle');
    chosen.w.unmount();
    document.body.innerHTML = '';
    const empty = host({ placeholder: 'Any' }, null);
    expect(input().placeholder).toBe('Any');
    expect(input().classList).toContain('placeholder:text-text-subtle');
    empty.w.unmount();
  });

  it('selects with the keyboard and clears', async () => {
    const { w, value } = host({ clearable: true }, null);
    input().focus();
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    expect(value.value).toBe('node.disk');
    expect(input().getAttribute('aria-label')).toBe('Metric: Node disk usage');
    await w.get('[data-testid="combobox-clear"]').trigger('click');
    expect(value.value).toBeNull();
    w.unmount();
  });

  it('selects several values as removable chips', async () => {
    const { w, value } = host({ multiple: true }, ['node.cpu']);
    expect(w.findAll('[data-testid="combobox-chip"]').map((c) => c.text())).toEqual([
      'Node CPU utilization',
    ]);
    input().focus();
    await key('ArrowDown');
    const pod = options().find((o) => o.textContent?.includes('Pod memory'))!;
    pod.click();
    await flushPromises();
    expect(value.value).toEqual(['node.cpu', 'pod.mem']);
    await w.get('[aria-label="Remove Node CPU utilization"]').trigger('click');
    expect(value.value).toEqual(['pod.mem']);
    w.unmount();
  });

  it('virtualises long lists (namespaces, workloads, nodes)', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      value: `ns-${i}`,
      label: `namespace-${i}`,
    }));
    const { w } = host({ options: many }, null);
    input().focus();
    await key('ArrowDown');
    expect(options().length).toBeLessThan(200);
    w.unmount();
  });
});
