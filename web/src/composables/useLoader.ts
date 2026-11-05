// SPDX-License-Identifier: AGPL-3.0-only
import { computed, ref, shallowRef } from 'vue';
import { useDelayedFlag } from './useDelayedFlag';

/**
 * Loading, error and data for one page resource, with the three states kept apart:
 * `skeleton` only on a first load slower than 150 ms; `refreshing` when data is already
 * shown (polling, refetch), so the old data stays visible; `error` until the next
 * successful load.
 */
export function useLoader<T>(fetcher: () => Promise<T>) {
  const data = shallowRef<T>();
  const loaded = ref(false);
  const loading = ref(false);
  const error = shallowRef<unknown>();
  let seq = 0;

  async function load() {
    const mine = ++seq;
    loading.value = true;
    try {
      const result = await fetcher();
      if (mine !== seq) return; // a newer load superseded this one
      data.value = result;
      loaded.value = true;
      error.value = undefined;
    } catch (err) {
      if (mine === seq) error.value = err ?? new Error('load failed');
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  // `pending` lets a page reserve the skeleton's space invisibly before `skeleton` turns
  // on, where content below it (charts) is already on screen and must not move.
  const pending = computed(() => loading.value && !loaded.value);
  const skeleton = useDelayedFlag(pending);
  const refreshing = computed(() => loading.value && loaded.value);
  return { data, loaded, loading, error, pending, skeleton, refreshing, load };
}
