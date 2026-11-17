// SPDX-License-Identifier: AGPL-3.0-only
import type { MetricKey, RangeQueryRequest, RangeQueryResponse } from '@watchlog/api-types';
import { storeToRefs } from 'pinia';
import { getCurrentScope, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { api, isBusy } from '@/api/client';
import { busyDelay, holdBusy } from '@/lib/busy';
import { rangeWindow } from '@/lib/time';
import { useUiStore } from '@/stores/ui';

/** Runs a curated range query and re-runs it when the time range or inputs change. */
export function useRangeQuery(
  clusterId: MaybeRefOrGetter<string | undefined>,
  metric: MetricKey,
  scope: MaybeRefOrGetter<RangeQueryRequest['scope']>,
) {
  const { timeRange } = storeToRefs(useUiStore());
  const data = ref<RangeQueryResponse | null>(null);
  // Starts as loading: the first run waits for the cluster id, and "no data" must not
  // flash before it.
  const loading = ref(true);
  const error = ref(false);
  /** A busy answer (ADR-206): the chart keeps its data and tries again with backoff. */
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

  async function run() {
    const id = toValue(clusterId);
    if (!id) return;
    const mine = ++seq;
    clearTimeout(retry);
    loading.value = true;
    error.value = false;
    const [from, to] = rangeWindow(timeRange.value);
    try {
      const res = await api<RangeQueryResponse>('/query/range', {
        method: 'POST',
        body: { clusterId: id, metric, scope: toValue(scope), from, to },
      });
      if (mine !== seq) return; // ignore responses to superseded requests
      data.value = res;
      calm();
    } catch (err) {
      if (mine !== seq) return;
      if (isBusy(err) && !disposed) {
        busy.value = true;
        release ??= holdBusy();
        retry = setTimeout(() => void run(), busyDelay(attempt++, err.retryAfter));
      } else {
        calm();
        error.value = true;
      }
    } finally {
      // While a busy retry waits with nothing to show yet, the chart stays loading.
      if (mine === seq) loading.value = busy.value && !data.value;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      seq++;
      calm();
    });
  }

  watch([() => toValue(clusterId), timeRange, () => JSON.stringify(toValue(scope))], run, {
    immediate: true,
  });
  return { data, loading, error, busy, refresh: run };
}
