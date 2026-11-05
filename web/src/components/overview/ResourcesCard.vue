<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import TimeSeriesChart, { type ChartMarker } from '@/components/charts/TimeSeriesChart.vue';
import { MARKER_TOKEN, markerLabel, markerLink, type Overview } from '@/lib/overview';
import { formatValue } from '@/lib/units';
import OverviewCard from './OverviewCard.vue';
import SegmentedControl from './SegmentedControl.vue';

// Cluster resources over the range: usage, with requested and allocatable as dashed
// lines, and every change (rollout, image, scale, node, new namespace) as a marker line
// with its label on hover; a click opens what changed.
const props = defineProps<{ overview: Overview }>();
const { t } = useI18n();
type Metric = 'cpu' | 'memory' | 'network';
const metric = ref<Metric>('cpu');
const r = computed(() => props.overview.resources);
const window = computed<[number, number]>(() => {
  const end = Math.floor(Date.now() / 1000);
  return [end - props.overview.range, end];
});

const series = computed(() => {
  if (metric.value === 'network')
    return [
      {
        name: t('overview.resources.received'),
        points: r.value.network.received,
        colorToken: '--ok',
      },
      { name: t('overview.resources.sent'), points: r.value.network.sent, colorToken: '--info' },
    ];
  const m = r.value[metric.value];
  return [
    {
      name: t('overview.resources.usage'),
      points: m.usage,
      colorToken: metric.value === 'cpu' ? '--info' : '--chart-4',
    },
  ];
});
const unit = computed(() =>
  metric.value === 'cpu' ? 'cores' : metric.value === 'memory' ? 'bytes' : 'bytes_per_second',
);
const thresholds = computed(() => {
  if (metric.value === 'network') return [];
  const m = r.value[metric.value];
  const fmt = (v: number) => formatValue(v, unit.value);
  return [
    ...(m.requests !== null
      ? [
          {
            value: m.requests,
            label: t('overview.resources.requested', { v: fmt(m.requests) }),
            colorToken: '--warning',
          },
        ]
      : []),
    ...(m.allocatable !== null
      ? [
          {
            value: m.allocatable,
            label: t('overview.resources.allocatable', { v: fmt(m.allocatable) }),
            colorToken: '--text-muted',
          },
        ]
      : []),
  ];
});
const markers = computed<ChartMarker[]>(() =>
  props.overview.markers.map((m) => ({
    ts: Date.parse(m.ts) / 1000,
    label: markerLabel(m, t),
    colorToken: MARKER_TOKEN[m.kind] ?? '--text-subtle',
    link: markerLink(m),
  })),
);
</script>

<template>
  <OverviewCard :title="$t('overview.resources.title')" testid="card-resources">
    <template #meta>
      <span class="text-12 text-text-subtle">{{ $t('overview.resources.hint') }}</span>
    </template>
    <template #actions>
      <SegmentedControl
        v-model="metric"
        :label="$t('overview.resources.metric')"
        :options="[
          { value: 'cpu', label: $t('overview.kpi.cpu') },
          { value: 'memory', label: $t('overview.kpi.memory') },
          { value: 'network', label: $t('overview.resources.network') },
        ]"
      />
    </template>
    <div class="flex flex-1 flex-col px-3 pt-1 pb-2">
      <TimeSeriesChart
        plain
        :title="$t(`overview.resources.chart.${metric}`)"
        :unit="unit"
        :series="series"
        :thresholds="thresholds"
        :markers="markers"
        :window="window"
        :empty-text="$t('overview.resources.empty')"
        :error-text="$t('overview.resources.empty')"
      />
    </div>
  </OverviewCard>
</template>
