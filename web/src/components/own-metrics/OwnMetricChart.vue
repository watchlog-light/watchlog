<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The chart of a user's own metric (1.0.0, ADR-237), on the metric's page, a dashboard's widget
// and a pinned tile: its option comes from lib/own-chart.ts, its colours from the design
// tokens at runtime. It never fetches: the page hands it lines.
import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, use, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import { useDelayedFlag } from '@/composables/useDelayedFlag';
import { useTheme } from '@/composables/useTheme';
import {
  chartSummary,
  ownChartOption,
  type OwnBand,
  type OwnLine,
  type OwnMarker,
  type OwnShape,
} from '@/lib/own-chart';
import type { Showing } from '@/lib/own-metrics';

use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

const props = withDefaults(
  defineProps<{
    lines: OwnLine[];
    showing: Showing;
    window: [number, number];
    shape?: OwnShape;
    band?: OwnBand;
    bandName?: string;
    markers?: OwnMarker[];
    loading?: boolean;
    error?: boolean;
    emptyText: string;
    errorText: string;
    /** What the chart is of, for a screen reader. */
    label: string;
    compact?: boolean;
  }>(),
  { shape: 'line', band: undefined, bandName: undefined, markers: undefined },
);

const el = ref<HTMLDivElement>();
const chart = shallowRef<EChartsType>();
let resize: ResizeObserver | undefined;

const hasData = computed(() => props.lines.some((l) => l.points.some((p) => p[1] !== null)));
const skeleton = useDelayedFlag(() => !!props.loading && !hasData.value && !props.error);
const summary = computed(() => chartSummary(props.lines, props.showing));

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function render() {
  if (!chart.value) return;
  chart.value.setOption(
    ownChartOption(
      {
        lines: props.lines,
        showing: props.showing,
        shape: props.shape,
        window: props.window,
        band: props.band,
        bandName: props.bandName,
        markers: props.markers,
        compact: props.compact,
      },
      { palette: Array.from({ length: 8 }, (_, i) => token(`--chart-${i + 1}`)), token },
    ),
    { notMerge: true },
  );
}

onMounted(() => {
  if (!el.value) return;
  chart.value = init(el.value, undefined, { renderer: 'canvas' });
  render();
  resize = new ResizeObserver(() => chart.value?.resize());
  resize.observe(el.value);
});
onBeforeUnmount(() => {
  resize?.disconnect();
  chart.value?.dispose();
});
watch(
  () => [props.lines, props.showing, props.shape, props.window, props.band, props.markers],
  render,
  { deep: true },
);
const { resolved } = useTheme();
watch(resolved, () => void nextTick(render));
</script>

<template>
  <div class="relative h-full min-h-24 w-full" :aria-busy="loading ? 'true' : undefined">
    <div
      ref="el"
      class="absolute inset-0"
      :class="{ invisible: !hasData }"
      role="img"
      :aria-label="hasData ? `${label}. ${summary}` : label"
      data-testid="own-chart"
    />
    <template v-if="!hasData">
      <p
        v-if="error"
        role="alert"
        class="absolute inset-0 flex items-center justify-center px-3 text-center text-13 text-text-subtle"
        data-testid="own-chart-error"
      >
        {{ errorText }}
      </p>
      <div
        v-else-if="skeleton"
        role="status"
        :aria-label="$t('common.loading')"
        class="absolute inset-0"
      >
        <SkeletonChart />
      </div>
      <p
        v-else-if="!loading"
        class="absolute inset-0 flex items-center justify-center px-3 text-center text-13 text-text-subtle"
        data-testid="own-chart-empty"
      >
        {{ emptyText }}
      </p>
    </template>
  </div>
</template>
