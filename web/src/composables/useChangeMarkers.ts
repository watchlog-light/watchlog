// SPDX-License-Identifier: AGPL-3.0-only
import type { ChangeMarker, ChangeMarkerList } from '@watchlog/api-types';
import { storeToRefs } from 'pinia';
import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { ChartMarker } from '@/components/charts/TimeSeriesChart.vue';
import { rangeWindow } from '@/lib/time';
import { useUiStore } from '@/stores/ui';

/** Short text for a change marker, e.g. "Rollout Deployment web: 1 → 2". */
export function markerLabel(m: ChangeMarker, t: (key: string, args?: object) => string): string {
  const name = m.target.split('/').slice(1).at(-1) ?? m.target;
  const kind = m.target.split('/')[0] ?? '';
  const d = m.details as { from?: unknown; to?: unknown; action?: string };
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? '–'));
  switch (m.kind) {
    case 'node':
      return t(`kube.markers.node.${d.action === 'removed' ? 'removed' : 'added'}`, { name });
    case 'image':
      return t('kube.markers.image', { kind, name, to: list(d.to) });
    case 'scale':
      return t('kube.markers.scale', { kind, name, from: list(d.from), to: list(d.to) });
    default:
      return t('kube.markers.rollout', { kind, name, from: list(d.from), to: list(d.to) });
  }
}

/**
 * Change markers (SPEC §4.6) for the charts of one page, re-fetched with the time range.
 * `filter` gives the target (one workload or node) or the namespaces; errors only
 * leave the charts without markers.
 */
export function useChangeMarkers(
  clusterId: MaybeRefOrGetter<string | undefined>,
  filter: MaybeRefOrGetter<{ target?: string; namespaces?: string[] } | null>,
) {
  const { t } = useI18n();
  const { timeRange } = storeToRefs(useUiStore());
  const markers = ref<ChartMarker[]>([]);
  let seq = 0;

  async function run() {
    const id = toValue(clusterId);
    const f = toValue(filter);
    if (!id || !f) {
      markers.value = [];
      return;
    }
    const mine = ++seq;
    const [from, to] = rangeWindow(timeRange.value);
    const q = new URLSearchParams({ from: String(from), to: String(to) });
    if (f.target) q.set('target', f.target);
    if (f.namespaces?.length) q.set('namespaces', f.namespaces.join(','));
    try {
      const res = await api<ChangeMarkerList>(`/clusters/${id}/change-markers?${q.toString()}`);
      if (mine === seq) {
        markers.value = res.markers.map((m) => ({
          ts: Date.parse(m.ts) / 1000,
          label: markerLabel(m, t),
        }));
      }
    } catch {
      if (mine === seq) markers.value = [];
    }
  }

  watch([() => toValue(clusterId), timeRange, () => JSON.stringify(toValue(filter))], run, {
    immediate: true,
  });
  return markers;
}
