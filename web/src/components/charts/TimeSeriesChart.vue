<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Thin ECharts wrapper (ADR-036): modular imports, colours read from the design
// tokens at runtime so a light theme needs no change here.
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import BaseButton from '@/components/ui/BaseButton.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import { useDelayedFlag } from '@/composables/useDelayedFlag';
import { rangeWindow } from '@/lib/time';
import { byteAxisStep, formatValue, niceStep, type Unit } from '@/lib/units';
import { useUiStore } from '@/stores/ui';

use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export interface ChartSeries {
  name: string;
  points: (number | null)[][];
  /** Drawn as a dashed line (limits). */
  dashed?: boolean;
  /** Drawn as a dotted reference line (requests, ADR-056); not data on its own. */
  dotted?: boolean;
  /** A design token for this series' colour (e.g. `--warning`), instead of the palette. */
  colorToken?: string;
  /** Drawn as steps (counts, replicas). */
  step?: boolean;
}

/** A horizontal threshold line with its label ("Warning 85%"). */
export interface ChartThreshold {
  value: number;
  label: string;
  colorToken: string;
}

/** A shaded time range (a firing period, an earlier episode, a silent gap). */
export interface ChartArea {
  from: number;
  to: number;
  label: string;
  colorToken: string;
  opacity: number;
}

/** A change marker (SPEC §4.6): a vertical line at `ts` (unix seconds). */
export interface ChartMarker {
  ts: number;
  label: string;
  /** The line's colour; neutral when not set. */
  colorToken?: string;
  /** Opened when the line is clicked (and linked in the screen-reader list). */
  link?: RouteLocationRaw;
}

const props = defineProps<{
  title: string;
  unit: Unit;
  series: ChartSeries[];
  loading?: boolean;
  error?: boolean;
  emptyText: string;
  errorText: string;
  /** Shown instead of a flat line at zero when every value is 0 (e.g. an idle disk). */
  zeroText?: string;
  /** Short note beside the title, e.g. "No memory limit". */
  note?: string;
  markers?: ChartMarker[];
  /** Unix seconds [from, to]; the top bar's time range when not set. */
  window?: [number, number];
  thresholds?: ChartThreshold[];
  areas?: ChartArea[];
  /** Inside another card: no border or background of its own, and a taller plot. */
  plain?: boolean;
}>();
defineEmits<{ retry: [] }>();

const ui = useUiStore();
const router = useRouter();
const el = ref<HTMLDivElement>();
const chart = shallowRef<EChartsType>();
let resize: ResizeObserver | undefined;

const hasData = computed(() =>
  props.series.some((s) => !s.dotted && s.points.some((p) => p[1] !== null)),
);
const span = computed(() => props.window ?? rangeWindow(ui.timeRange));
const shownMarkers = computed(() => {
  const [from, to] = span.value;
  return (props.markers ?? []).filter((m) => m.ts >= from && m.ts <= to);
});
const allZero = computed(
  () =>
    !!props.zeroText &&
    hasData.value &&
    props.series.every((s) => s.points.every((p) => p[1] === null || p[1] === 0)),
);
// First load: a skeleton after 150 ms. Refetch with data shown: keep the chart and show
// a small indicator. Loading, empty and error never share the plot area.
const skeleton = useDelayedFlag(() => !!props.loading && !hasData.value && !props.error);

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Byte axes get binary-round ticks. With threshold lines, other units get round
// decimal ticks with the top one above the highest line, so no odd label ("13.20")
// is printed over a round one ("12.00").
function yAxisTicks(): { interval: number; max: number } | undefined {
  const bytes = props.unit === 'bytes' || props.unit === 'bytes_per_second';
  if (!bytes && !props.thresholds?.length) return undefined;
  const lines = (props.thresholds ?? []).map((t) => t.value);
  const max = Math.max(
    0,
    ...props.series.flatMap((s) => s.points.map((p) => p[1] ?? 0)),
    // Room above a line for its label.
    ...lines.map((v) => v * 1.05),
  );
  // All-zero series (an idle disk) get 0–1 B rather than ECharts' 0.2 steps, which
  // round to repeated "0 B" / "1 B" labels.
  const interval = bytes ? byteAxisStep(max) : niceStep(max);
  return { interval, max: Math.max(interval, Math.ceil(max / interval) * interval) };
}

function decorations() {
  const muted = token('--text-muted');
  const lines = [
    ...shownMarkers.value.map((m) => ({
      xAxis: m.ts * 1000,
      name: m.label,
      lineStyle: { color: token(m.colorToken ?? '--text-subtle'), type: 'dashed', width: 1 },
      label: { show: false },
      emphasis: { label: { show: true, formatter: '{b}', color: muted, fontSize: 11 } },
    })),
    ...(props.thresholds ?? []).map((t) => ({
      yAxis: t.value,
      name: t.label,
      lineStyle: { color: token(t.colorToken), type: 'dashed', width: 1 },
      label: {
        show: true,
        formatter: '{b}',
        position: 'insideEndTop',
        color: token(t.colorToken),
        fontSize: 11,
      },
    })),
  ];
  const [from, to] = span.value;
  const areas = (props.areas ?? [])
    .filter((a) => a.to > from && a.from < to)
    .map((a) => [
      {
        xAxis: Math.max(a.from, from) * 1000,
        name: a.label,
        itemStyle: { color: token(a.colorToken), opacity: a.opacity },
      },
      { xAxis: Math.min(a.to, to) * 1000 },
    ]);
  return {
    ...(lines.length
      ? { markLine: { symbol: 'none', silent: false, animation: false, data: lines } }
      : {}),
    ...(areas.length
      ? {
          markArea: {
            silent: true,
            animation: false,
            label: { show: false },
            data: areas,
          },
        }
      : {}),
  };
}

function render() {
  if (!chart.value) return;
  const palette = Array.from({ length: 8 }, (_, i) => token(`--chart-${i + 1}`));
  const muted = token('--text-muted');
  const border = token('--border');
  chart.value.setOption(
    {
      color: palette,
      animation: false,
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      legend: {
        show: props.series.length > 1,
        top: 0,
        right: 0,
        textStyle: { color: muted, fontSize: 12 },
        itemWidth: 12,
        itemHeight: 2,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: token('--surface-2'),
        borderColor: border,
        textStyle: { color: token('--text'), fontSize: 12 },
        valueFormatter: (v: unknown) => formatValue(typeof v === 'number' ? v : null, props.unit),
      },
      // The axis always spans the selected range, so a container that started two
      // minutes ago shows two minutes of data, not a range stretched around one point.
      xAxis: {
        type: 'time',
        min: span.value[0] * 1000,
        max: span.value[1] * 1000,
        axisLine: { lineStyle: { color: border } },
        axisLabel: { color: muted, fontSize: 11, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        // Threshold lines above the data stay on the chart.
        ...yAxisTicks(),
        axisLabel: {
          color: muted,
          fontSize: 11,
          formatter: (v: number) => formatValue(v, props.unit),
        },
        splitLine: { lineStyle: { color: border } },
      },
      series: props.series.map((s, i) => ({
        name: s.name,
        type: 'line',
        showSymbol: !s.dotted && s.points.filter((p) => p[1] !== null).length <= 2,
        connectNulls: false,
        ...(s.step ? { step: 'end' } : {}),
        ...(s.colorToken ? { color: token(s.colorToken) } : {}),
        lineStyle: {
          width: s.dashed || s.dotted ? 1 : 1.5,
          type: s.dashed ? 'dashed' : s.dotted ? 'dotted' : 'solid',
        },
        data: s.points.map(([t, v]) => [(t ?? 0) * 1000, v]),
        // Markers, thresholds and shaded ranges hang on the first series; a marker's
        // name shows on hover, a threshold's label always.
        ...(i === 0 ? decorations() : {}),
      })),
    },
    { notMerge: true },
  );
}

onMounted(() => {
  if (!el.value) return;
  chart.value = init(el.value, undefined, { renderer: 'canvas' });
  // A marker line with a link opens it (the markers come first in the markLine data).
  chart.value.on?.('click', (p) => {
    if (p.componentType !== 'markLine') return;
    const m = shownMarkers.value[p.dataIndex];
    if (m?.link) void router.push(m.link);
  });
  render();
  resize = new ResizeObserver(() => chart.value?.resize());
  resize.observe(el.value);
});

onBeforeUnmount(() => {
  resize?.disconnect();
  chart.value?.dispose();
});

watch(
  () => [
    props.series,
    props.unit,
    props.markers,
    props.window,
    props.thresholds,
    props.areas,
    ui.timeRange,
  ],
  render,
  { deep: true },
);
</script>

<template>
  <section
    class="flex flex-col"
    :class="plain ? 'flex-1' : 'rounded-card border border-border bg-surface-1 p-4'"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-13 font-medium text-text-muted">
        {{ title }}
        <span
          v-if="note"
          class="ml-1.5 text-12 font-normal text-text-subtle"
          data-testid="chart-note"
          >· {{ note }}</span
        >
      </h3>
      <span class="flex items-center gap-2">
        <button
          v-if="error && hasData"
          type="button"
          class="text-12 text-critical hover:underline"
          :title="errorText"
          data-testid="chart-retry"
          @click="$emit('retry')"
        >
          {{ $t('common.retry') }}
        </button>
        <LoadingIndicator :active="!!loading && hasData" />
      </span>
    </div>
    <ul v-if="shownMarkers.length > 0" class="sr-only" data-testid="chart-markers">
      <li v-for="m in shownMarkers" :key="`${m.ts}-${m.label}`">
        <RouterLink v-if="m.link" :to="m.link">{{ m.label }}</RouterLink>
        <template v-else>{{ m.label }}</template>
      </li>
    </ul>
    <div
      class="relative mt-2"
      :class="plain ? 'min-h-64 flex-1' : 'h-48'"
      :aria-busy="loading ? 'true' : undefined"
    >
      <div
        ref="el"
        class="absolute inset-0"
        :class="{ invisible: !hasData || allZero }"
        data-testid="chart"
      />
      <p
        v-if="allZero"
        class="absolute inset-0 flex items-center justify-center text-13 text-text-subtle"
        data-testid="chart-zero"
      >
        {{ zeroText }}
      </p>
      <template v-if="!hasData">
        <div
          v-if="error"
          role="alert"
          class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-13 text-text-subtle"
        >
          {{ errorText }}
          <BaseButton variant="secondary" data-testid="chart-retry" @click="$emit('retry')">
            {{ $t('common.retry') }}
          </BaseButton>
        </div>
        <div
          v-else-if="skeleton"
          role="status"
          :aria-label="$t('common.loading')"
          data-testid="chart-skeleton"
        >
          <SkeletonChart />
        </div>
        <p
          v-else-if="!loading"
          class="absolute inset-0 flex items-center justify-center text-13 text-text-subtle"
        >
          {{ emptyText }}
        </p>
      </template>
    </div>
  </section>
</template>
