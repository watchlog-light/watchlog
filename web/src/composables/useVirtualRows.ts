// SPDX-License-Identifier: AGPL-3.0-only
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, ref, type Ref } from 'vue';

/** Lists longer than this are virtualised: only rows near the view are drawn. */
export const VIRTUAL_AFTER = 200;

/**
 * Table rows virtualised against the page's scroll container (#main) once the list is
 * long. `shown.items` are the rows to draw (with their index for measuring) and
 * `shown.pad` the heights of the spacer rows above and below. Bind `body` to the tbody
 * and `measure` to each row's ref so rows of different heights are measured.
 */
export function useVirtualRows<T extends { key: string }>(
  items: Ref<T[]>,
  estimate: (item: T) => number,
) {
  const body = ref<HTMLElement | null>(null);
  const virtual = computed(() => items.value.length > VIRTUAL_AFTER);
  const virtualizer = useVirtualizer(
    computed(() => ({
      count: items.value.length,
      getScrollElement: () => document.getElementById('main'),
      estimateSize: (i: number) => (items.value[i] ? estimate(items.value[i]!) : 50),
      getItemKey: (i: number) => items.value[i]?.key ?? i,
      overscan: 12,
      scrollMargin: body.value?.offsetTop ?? 0,
    })),
  );
  const shown = computed(() => {
    if (!virtual.value)
      return { items: items.value.map((item) => ({ item, index: -1 })), pad: [0, 0] };
    const v = virtualizer.value.getVirtualItems();
    const margin = virtualizer.value.options.scrollMargin;
    const first = v[0]?.start ?? margin;
    const last = v.at(-1)?.end ?? margin;
    return {
      items: v.map((r) => ({ item: items.value[r.index]!, index: r.index })),
      pad: [first - margin, virtualizer.value.getTotalSize() - (last - margin)],
    };
  });
  const measure = (el: unknown) => {
    if (virtual.value && el instanceof Element) virtualizer.value.measureElement(el);
  };
  return { body, shown, measure };
}
