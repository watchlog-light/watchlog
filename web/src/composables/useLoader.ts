// SPDX-License-Identifier: AGPL-3.0-only
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { isBusy } from '@/api/client';
import { busyDelay, holdBusy } from '@/lib/busy';
import { useDelayedFlag } from './useDelayedFlag';

/**
 * Loading, error and data for one page resource, with the three states kept apart:
 * `skeleton` only on a first load slower than 150 ms; `refreshing` when data is already
 * shown (polling, refetch), so the old data stays visible; `error` until the next
 * successful load.
 *
 * A busy answer (429, or a 503 that clears by itself, ADR-206) is not an error: the data
 * stays, `busy` is true, the top bar says "Busy, retrying…", and the load is tried again
 * with backoff (2, 4, 8 … 30 s, never sooner than Retry-After) until it succeeds.
 */
export function useLoader<T>(fetcher: () => Promise<T>) {
  const data = shallowRef<T>();
  const loaded = ref(false);
  const loading = ref(false);
  const error = shallowRef<unknown>();
  const busy = ref(false);
  let seq = 0;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  let disposed = false;

  function calm() {
    busy.value = false;
    attempt = 0;
    clearTimeout(retry);
    release?.();
    release = undefined;
  }

  async function load() {
    const mine = ++seq;
    clearTimeout(retry);
    loading.value = true;
    try {
      const result = await fetcher();
      if (mine !== seq) return; // a newer load superseded this one
      data.value = result;
      loaded.value = true;
      error.value = undefined;
      calm();
    } catch (err) {
      if (mine !== seq) return;
      if (isBusy(err) && !disposed) {
        busy.value = true;
        release ??= holdBusy();
        retry = setTimeout(() => void load(), busyDelay(attempt++, err.retryAfter));
      } else {
        calm();
        error.value = err ?? new Error('load failed');
      }
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      seq++;
      calm();
    });
  }

  // `pending` lets a page reserve the skeleton's space invisibly before `skeleton` turns
  // on, where content below it (charts) is already on screen and must not move. A first
  // load waiting out a busy answer stays pending: the skeleton, never an empty state.
  const pending = computed(() => (loading.value || busy.value) && !loaded.value);
  const skeleton = useDelayedFlag(pending);
  const refreshing = computed(() => loading.value && loaded.value);
  return { data, loaded, loading, error, busy, pending, skeleton, refreshing, load };
}
