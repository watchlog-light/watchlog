<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { WhatChanged } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { hhmm } from '@/lib/what-changed';
import { chartBands, chartMarkers } from '@/lib/what-changed-story';

// The chart, last (0.14.0, ADR-231): how many series were outside their usual range each step,
// on a labelled count axis; the episodes shaded (the selected one in amber); the changes as
// blue markers with short labels on the same time line; a legend. A shaded stretch selects its
// episode.
const props = defineProps<{ answer: WhatChanged; kind: 'kubernetes' | 'server' }>();
const emit = defineEmits<{ select: [fromIso: string] }>();
const { t } = useI18n();
const tr = (k: string, v?: Record<string, unknown>, n?: number) =>
  n === undefined ? t(k, v ?? {}) : t(k, v ?? {}, n);

const W = 1000;
const H = 150;
const TOP = 26;
const counts = computed(() => props.answer.chart.counts);
const max = computed(() => Math.max(1, ...counts.value));
const ticks = computed(() => {
  const m = max.value;
  const step = m <= 4 ? 1 : Math.ceil(m / 4);
  const out: number[] = [];
  for (let v = 0; v <= m; v += step) out.push(v);
  if (out[out.length - 1] !== m) out.push(m);
  return out;
});
const y = (v: number) => TOP + (H - TOP) * (1 - v / max.value);
const path = computed(() => {
  const n = counts.value.length;
  if (!n) return '';
  const x = (i: number) => (i / n) * W;
  let d = `M0 ${y(counts.value[0]!).toFixed(1)}`;
  counts.value.forEach((c, i) => {
    d += ` L${x(i).toFixed(1)} ${y(c).toFixed(1)} L${x(i + 1).toFixed(1)} ${y(c).toFixed(1)}`;
  });
  return d;
});
const area = computed(() => (path.value ? `${path.value} L${W} ${H} L0 ${H} Z` : ''));
const range = computed(() => ({ from: props.answer.chart.from, to: props.answer.chart.to }));
const bands = computed(() =>
  chartBands(props.answer.episodes ?? [], props.answer.episode ?? -1, range.value, Date.now()),
);
const markers = computed(() => chartMarkers(props.answer.changes ?? [], range.value, tr));
const times = computed(() => {
  const a = Date.parse(range.value.from);
  const b = Date.parse(range.value.to);
  return [0, 1, 2, 3].map((i) => ({
    pct: (i / 3) * 100,
    at: new Date(a + ((b - a) * i) / 3).toISOString(),
  }));
});
const aria = computed(() =>
  t('whatChanged.chart2.aria', {
    max: Math.max(0, ...counts.value),
    n: (props.answer.episodes ?? []).length,
  }),
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
    aria-labelledby="wc-chart-title"
    data-testid="wc-chart"
  >
    <h3 id="wc-chart-title" class="text-15 font-semibold text-text">
      {{ $t('whatChanged.chart2.title') }}
      <span class="font-normal text-text-muted max-md:hidden"
        >·
        {{
          kind === 'server'
            ? $t('whatChanged.chart2.withChangesFleet')
            : $t('whatChanged.chart2.withChanges')
        }}</span
      >
    </h3>
    <div class="flex gap-2">
      <!-- The count axis. -->
      <div class="relative w-6 shrink-0" :style="{ height: `${H}px` }" aria-hidden="true">
        <span
          v-for="v in ticks"
          :key="v"
          class="absolute right-0 -translate-y-1/2 font-mono text-12 text-text-subtle"
          :style="{ top: `${y(v)}px` }"
          >{{ v }}</span
        >
      </div>
      <div
        class="relative min-w-0 flex-1"
        :style="{ height: `${H + 22}px` }"
        data-testid="wc-chart-plot"
      >
        <svg
          :viewBox="`0 0 ${W} ${H}`"
          preserveAspectRatio="none"
          class="absolute inset-x-0 top-0 w-full"
          :style="{ height: `${H}px` }"
          role="img"
          :aria-label="aria"
        >
          <line
            v-for="v in ticks"
            :key="v"
            x1="0"
            :x2="W"
            :y1="y(v)"
            :y2="y(v)"
            class="stroke-border"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <path v-if="area" :d="area" class="fill-warning/15" />
          <path
            v-if="path"
            :d="path"
            fill="none"
            class="stroke-warning"
            stroke-width="1.6"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <!-- The episodes, shaded; a click selects one. -->
        <button
          v-for="b in bands"
          :key="b.index"
          type="button"
          :class="[
            'absolute top-0 rounded-[3px] border',
            b.selected
              ? 'border-warning/60 bg-warning/10'
              : 'border-text-muted/30 bg-text-muted/5 hover:bg-text-muted/10',
          ]"
          :style="{ left: `${b.left}%`, width: `${b.width}%`, height: `${H}px` }"
          :aria-label="hhmm(answer.episodes[b.index]!.from)"
          :aria-pressed="b.selected"
          data-testid="wc-chart-band"
          data-layout-exempt="touch-target"
          @click="emit('select', answer.episodes[b.index]!.from)"
        />
        <!-- The changes, as markers. -->
        <span
          v-for="(m, i) in markers"
          :key="i"
          :class="[
            'pointer-events-none absolute top-0 w-px',
            m.lane === null ? 'bg-info/30' : 'bg-info/70',
          ]"
          :style="{ left: `${m.left}%`, height: `${H}px` }"
          data-testid="wc-chart-marker"
          aria-hidden="true"
        >
          <span
            v-if="m.lane !== null"
            :class="[
              'absolute top-0 text-12 whitespace-nowrap text-info-text max-md:hidden',
              m.left > 75 ? 'right-1.5' : 'left-1.5',
            ]"
            :style="{ top: `${m.lane * 14}px` }"
            >◆ {{ m.label }}</span
          >
        </span>
        <div class="absolute inset-x-0 bottom-0 h-4.5" aria-hidden="true">
          <span
            v-for="(tk, i) in times"
            :key="i"
            class="absolute bottom-0 font-mono text-12 text-text-subtle"
            :style="{
              left: `${tk.pct}%`,
              transform: `translateX(${i === 0 ? '0' : i === times.length - 1 ? '-100%' : '-50%'})`,
            }"
            >{{ hhmm(tk.at) }}</span
          >
        </div>
      </div>
    </div>
    <p class="flex flex-wrap gap-x-4 gap-y-1 text-12 text-text-muted" data-testid="wc-chart-legend">
      <span class="inline-flex items-center gap-1.5"
        ><span class="inline-block h-2.5 w-3 rounded-[2px] bg-warning/60" aria-hidden="true" />{{
          $t('whatChanged.chart2.legendSeries')
        }}</span
      >
      <span class="inline-flex items-center gap-1.5"
        ><span class="inline-block h-2.5 w-0.5 bg-info" aria-hidden="true" />{{
          kind === 'server'
            ? $t('whatChanged.chart2.legendChangesFleet')
            : $t('whatChanged.chart2.legendChanges')
        }}</span
      >
      <span v-if="bands.length > 1">{{ $t('whatChanged.chart2.clickHint') }}</span>
    </p>
  </section>
</template>
