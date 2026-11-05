// SPDX-License-Identifier: AGPL-3.0-only
import type { MetricKey, RangeQueryRequest, RangeQueryResponse } from '@watchlog/api-types';
import { storeToRefs } from 'pinia';
import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { api } from '@/api/client';
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
  let seq = 0;

  async function run() {
    const id = toValue(clusterId);
    if (!id) return;
    const mine = ++seq;
    loading.value = true;
    error.value = false;
    const [from, to] = rangeWindow(timeRange.value);
    try {
      const res = await api<RangeQueryResponse>('/query/range', {
        method: 'POST',
        body: { clusterId: id, metric, scope: toValue(scope), from, to },
      });
      if (mine === seq) data.value = res; // ignore responses to superseded requests
    } catch {
      if (mine === seq) error.value = true;
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  watch([() => toValue(clusterId), timeRange, () => JSON.stringify(toValue(scope))], run, {
    immediate: true,
  });
  return { data, loading, error, refresh: run };
}
