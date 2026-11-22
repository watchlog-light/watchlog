// SPDX-License-Identifier: AGPL-3.0-only
import { ref, watch, type Ref } from 'vue';

/**
 * A choice remembered in this browser (the timelines' ranges, 0.13.0): read once, written on
 * change. Storage can be missing or refuse (private windows, blocked site data); then the
 * choice lasts for the visit and the default is used next time.
 */
export function useStoredChoice<T extends string | number>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): Ref<T> {
  let initial = fallback;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const hit = allowed.find((a) => String(a) === raw);
    if (hit !== undefined) initial = hit;
  } catch {
    // Storage unavailable: the default.
  }
  const choice = ref(initial) as Ref<T>;
  watch(choice, (v) => {
    try {
      globalThis.localStorage?.setItem(key, String(v));
    } catch {
      // Not remembered this time.
    }
  });
  return choice;
}
