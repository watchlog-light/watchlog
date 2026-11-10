<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Info } from '@lucide/vue';
import type { AlertChart, AlertChartPanel } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import StateTimeline from '@/components/alerts/StateTimeline.vue';
import TimeSeriesChart, { type ChartMarker } from '@/components/charts/TimeSeriesChart.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import {
  chartAreas,
  chartMarkers,
  markerLegend,
  panelSeries,
  panelThresholds,
} from '@/lib/alert-chart';
import { formatValue, type Unit } from '@/lib/units';

// The chart of an alert (alert detail page) or of a rule's latest alert (rule editor
// preview): one panel per series group the rule defines (rule-charts.ts), with the
// thresholds the alert had, its markers, the firing period and earlier episodes.
const props = defineProps<{
  chart: AlertChart | null;
  severity: string;
  loading?: boolean;
  error?: boolean;
  /** More lines: the probable cause's moments (the alert detail page). */
  extraMarkers?: ChartMarker[];
}>();
defineEmits<{ retry: [] }>();
const { t, te } = useI18n();

const span = computed<[number, number]>(() =>
  props.chart ? [props.chart.window.from, props.chart.window.to] : [0, 0],
);
const own = computed(() => (props.chart ? chartMarkers(props.chart, props.severity, t) : []));
const markers = computed(() => [...own.value, ...(props.extraMarkers ?? [])]);
const legend = computed(() =>
  props.chart
    ? [
        ...markerLegend(props.chart, own.value, t),
        ...(props.extraMarkers ?? [])
          .filter((m) => m.ts >= props.chart!.window.from && m.ts <= props.chart!.window.to)
          .map((m) => m.label),
      ]
    : [],
);
const areas = computed(() => (props.chart ? chartAreas(props.chart, props.severity, t) : []));

function title(p: AlertChartPanel): string {
  const key = `metricNames.${(p.metric ?? '').replaceAll('.', '_')}`;
  if (p.id === 'metric' && p.metric && te(key)) return t(key);
  return t(`alerts.chart.panels.${p.id}`);
}

/** "Rule changed since: threshold now 90%". */
const changed = computed(() => {
  const c = props.chart?.ruleChanged;
  if (!c) return null;
  const unit = (c.unit ?? 'count') as Unit;
  if (c.condition) {
    return t('alerts.chart.ruleChanged', {
      now: [
        formatValue(c.condition.value, unit),
        c.condition.critical !== undefined ? formatValue(c.condition.critical, unit) : null,
      ]
        .filter(Boolean)
        .join(' / '),
    });
  }
  return t('alerts.chart.ruleChangedOther');
});
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="alert-chart">
    <p
      v-if="changed"
      class="flex items-center gap-1.5 text-12 text-text-muted"
      data-testid="rule-changed"
    >
      <Info class="size-3.5 shrink-0" aria-hidden="true" />{{ changed }}
    </p>

    <section
      v-if="!chart && loading"
      class="rounded-card border border-border bg-surface-1 p-4"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="alert-chart-skeleton"
    >
      <SkeletonChart />
    </section>
    <section
      v-else-if="!chart && error"
      class="flex flex-col items-center gap-3 rounded-card border border-border bg-surface-1 p-6 text-13 text-text-subtle"
      role="alert"
    >
      {{ $t('alerts.chart.error') }}
      <button
        type="button"
        class="text-13 text-text hover:underline"
        data-testid="alert-chart-retry"
        @click="$emit('retry')"
      >
        {{ $t('common.retry') }}
      </button>
    </section>
    <p
      v-else-if="chart && chart.panels.length === 0"
      class="rounded-card border border-border bg-surface-1 p-6 text-center text-13 text-text-subtle"
      data-testid="alert-chart-none"
    >
      {{ $t('alerts.chart.none') }}
    </p>

    <template v-for="p in chart?.panels ?? []" :key="p.id">
      <TimeSeriesChart
        v-if="p.kind === 'line'"
        :title="title(p)"
        :unit="(p.unit ?? 'count') as Unit"
        :series="panelSeries(p, t)"
        :window="span"
        :thresholds="panelThresholds(p, t)"
        :areas="areas"
        :markers="markers"
        :loading="loading"
        :error="error"
        :note="p.more ? $t('alerts.chart.more', { n: p.more }, p.more) : undefined"
        :empty-text="$t('alerts.chart.empty')"
        :error-text="$t('alerts.chart.error')"
        :data-testid="`alert-chart-${p.id}`"
        @retry="$emit('retry')"
      />
      <section
        v-else
        class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
        :data-testid="`alert-chart-${p.id}`"
      >
        <h3 class="text-13 font-medium text-text-muted">
          {{ title(p) }}
          <span v-if="p.more" class="ml-1.5 text-12 font-normal text-text-subtle"
            >· {{ $t('alerts.chart.more', { n: p.more }, p.more) }}</span
          >
        </h3>
        <StateTimeline
          v-if="p.rows.some((r) => r.segments.length)"
          :rows="p.rows"
          :window="chart!.window"
          :strip="p.id === 'health'"
        />
        <p v-else class="py-6 text-center text-13 text-text-subtle">
          {{ $t('alerts.chart.empty') }}
        </p>
      </section>
    </template>

    <ul
      v-if="legend.length"
      class="flex flex-wrap gap-x-4 gap-y-1 text-12 text-text-muted"
      data-testid="alert-chart-markers"
    >
      <li v-for="(m, i) in legend" :key="i">{{ m }}</li>
    </ul>
  </div>
</template>
