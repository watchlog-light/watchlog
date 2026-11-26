<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// One widget of a dashboard (1.0.0, ADR-237): a metric as a number, a line, an area or bars,
// split by at most one label. It reads its own line over the selected range and again when
// `tick` changes. A metric that no longer reports, or was refused, says so in the widget's place.
import type { OwnMetricSeries, OwnWidget } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ownMetricsApi } from '@/api/own-metrics';
import OwnMetricChart from '@/components/own-metrics/OwnMetricChart.vue';
import RankedBars from '@/components/own-metrics/RankedBars.vue';
import { chartShape, problemOf } from '@/lib/own-dashboard';
import type { OwnLine } from '@/lib/own-chart';
import { ratePer, written, type OwnShown, type OwnUnit } from '@/lib/own-metrics';
import { rangeWindow } from '@/lib/time';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{
  widget: OwnWidget;
  /** Changes every 30 s while the page is visible: the widget reads again. */
  tick?: number;
  /** The cluster the page is on: a widget of another one names its own. */
  currentCluster?: string;
  /** In the editor's preview and in edit mode the title is not a link. */
  plain?: boolean;
}>();
const { t } = useI18n();
const ui = useUiStore();

const problem = computed(() => problemOf(props.widget));
const m = computed(() => props.widget.resolved);
const showing = computed(() => ({
  unit: (m.value?.unit ?? 'count') as OwnUnit,
  shown: (m.value?.shown ?? 'as_is') as OwnShown,
}));
const number = computed(() => props.widget.shape === 'number');
const now = computed(() => written(m.value?.value, showing.value));

const span = ref<[number, number]>(rangeWindow(ui.timeRange));
const data = ref<OwnMetricSeries | null>(null);
const loading = ref(false);
const failed = ref(false);
let seq = 0;
async function load() {
  if (number.value || problem.value || !m.value) {
    data.value = null;
    return;
  }
  const mine = ++seq;
  loading.value = true;
  span.value = rangeWindow(ui.timeRange);
  try {
    const res = await ownMetricsApi.series(props.widget.clusterId, m.value.id, {
      from: span.value[0],
      to: span.value[1],
      ...(props.widget.by ? { by: props.widget.by } : {}),
    });
    if (mine !== seq) return;
    data.value = res;
    failed.value = false;
  } catch {
    if (mine === seq) failed.value = true;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(
  () => [
    props.widget.clusterId,
    props.widget.metric,
    props.widget.by,
    props.widget.shape === 'number',
    m.value?.id,
    props.tick,
    ui.timeRange,
  ],
  () => void load(),
  { immediate: true },
);

const lines = computed<(OwnLine & { other?: boolean })[]>(() =>
  (data.value?.lines ?? []).map((l) => ({
    name: l.other
      ? t('ownMetrics.detail.other')
      : l.value === null
        ? ''
        : l.value || t('ownMetrics.detail.noValue'),
    points: l.points,
    other: l.other,
    ...(l.other ? { colorToken: '--text-subtle' } : {}),
  })),
);
const chartShowing = computed(() =>
  data.value ? { unit: data.value.unit, shown: data.value.shown } : showing.value,
);
const sub = computed(() => {
  if (!m.value) return '';
  // "per minute", "p95", "time since"; a gauge needs no word. Then the split, if any.
  const how =
    m.value.shown === 'rate'
      ? t(`ownMetrics.widget.per.${ratePer(m.value.value)}`)
      : m.value.shown === 'as_is'
        ? ''
        : t(`ownMetrics.widget.shown.${m.value.shown}`);
  const by = props.widget.by ? t('ownMetrics.widget.by', { label: props.widget.by }) : '';
  return [how, by].filter(Boolean).join(', ');
});
const elsewhere = computed(
  () =>
    props.widget.clusterName !== null &&
    !!props.currentCluster &&
    props.widget.clusterId !== props.currentCluster,
);
const to = computed(() =>
  m.value
    ? {
        name: 'your-metrics',
        query: { cluster: props.widget.clusterId, tab: 'metrics', metric: m.value.id },
      }
    : null,
);
</script>

<template>
  <article
    class="flex h-full min-w-0 flex-col rounded-card border border-border bg-surface-1 px-4 py-3.5"
    :data-testid="`own-widget-${widget.id}`"
  >
    <header class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <h3 class="truncate text-14 font-semibold text-text">
          <RouterLink v-if="to && !plain" :to="to" class="hover:underline">{{
            widget.title
          }}</RouterLink>
          <template v-else>{{ widget.title }}</template>
        </h3>
        <p v-if="!problem" class="mt-0.5 truncate text-12 text-text-muted">
          {{ sub }}<template v-if="elsewhere"> · {{ widget.clusterName }}</template>
        </p>
      </div>
      <slot name="controls" />
    </header>

    <p
      v-if="problem"
      class="mt-3 flex-1 text-13 leading-relaxed text-text-muted"
      role="status"
      data-testid="own-widget-problem"
    >
      {{
        $t(`ownMetrics.widget.problem.${problem}`, {
          metric: widget.metric,
          label: m?.refused?.label ?? '',
        })
      }}
    </p>
    <p
      v-else-if="number"
      class="mt-2 text-32 leading-tight font-bold tabular-nums text-text"
      data-testid="own-widget-number"
    >
      {{ now.value }}
      <span class="text-14 font-normal text-text-muted">{{
        now.ago ? $t('ownMetrics.ago') : now.unit
      }}</span>
    </p>
    <div
      v-else-if="widget.shape === 'bars' && widget.by"
      class="mt-3 min-h-24 flex-1"
      :aria-busy="loading ? 'true' : undefined"
    >
      <RankedBars v-if="lines.length" :lines="lines" :showing="chartShowing" />
      <p v-else-if="failed" class="text-13 text-text-subtle" role="alert">
        {{ $t('ownMetrics.chart.error') }}
      </p>
      <p v-else-if="!loading" class="text-13 text-text-subtle">
        {{ $t('ownMetrics.chart.empty') }}
      </p>
    </div>
    <div v-else class="mt-2 flex-1" :class="widget.w <= 4 ? 'min-h-36' : 'min-h-48'">
      <OwnMetricChart
        :lines="lines"
        :showing="chartShowing"
        :shape="chartShape(widget.shape)"
        :window="span"
        :loading="loading"
        :error="failed"
        :label="widget.title"
        :compact="widget.w <= 4"
        :empty-text="$t('ownMetrics.chart.empty')"
        :error-text="$t('ownMetrics.chart.error')"
      />
    </div>
  </article>
</template>
