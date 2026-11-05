// SPDX-License-Identifier: AGPL-3.0-only
import { onBeforeUnmount, ref } from 'vue';

/** True below 768 px (phones): the shell collapses the sidebar to icons. */
export function useNarrow(query = '(max-width: 767px)') {
  const mq = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined;
  const narrow = ref(!!mq?.matches);
  const on = (e: MediaQueryListEvent) => (narrow.value = e.matches);
  mq?.addEventListener?.('change', on);
  onBeforeUnmount(() => mq?.removeEventListener?.('change', on));
  return narrow;
}
