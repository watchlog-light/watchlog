// SPDX-License-Identifier: AGPL-3.0-only
import { onBeforeUnmount, ref, watch, type Ref, type WatchSource } from 'vue';

export const SKELETON_DELAY_MS = 150;

/**
 * Follows `source`, but turns on only once it has stayed on for `delay` ms, so fast
 * responses never flash a skeleton. Turns off immediately.
 */
export function useDelayedFlag(
  source: WatchSource<boolean>,
  delay = SKELETON_DELAY_MS,
): Ref<boolean> {
  const flag = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    source,
    (on) => {
      clearTimeout(timer);
      if (!on) flag.value = false;
      else if (!flag.value) timer = setTimeout(() => (flag.value = true), delay);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => clearTimeout(timer));
  return flag;
}
