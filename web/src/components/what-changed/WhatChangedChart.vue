<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { WhatChanged } from '@watchlog/api-types';
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { chartGeometry, hhmm } from '@/lib/what-changed';

// The unusual-activity chart (ADR-199, the screen Main): how many series were unusual each
// step, the window marked with a dashed outline. Drawn in SVG with the tokens' colours.
const props = defineProps<{ answer: Pick<WhatChanged, 'chart' | 'window'> }>();
const { t } = useI18n();
const g = computed(() => chartGeometry(props.answer));
const id = `wc-fill-${useId()}`;
const peak = computed(() => Math.max(0, ...props.answer.chart.counts));
const label = computed(() =>
  t('whatChanged.chart.label', {
    from: hhmm(props.answer.window.from),
    to: hhmm(props.answer.window.to),
    peak: peak.value,
  }),
);
</script>

<template>
  <figure class="flex flex-col gap-2" data-testid="wc-chart">
    <svg
      class="h-40 w-full md:h-48"
      viewBox="0 0 1000 190"
      preserveAspectRatio="none"
      role="img"
      :aria-label="label"
    >
      <defs>
        <linearGradient :id="id" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="wc-stop-top" />
          <stop offset="1" class="wc-stop-bottom" />
        </linearGradient>
      </defs>
      <rect
        v-if="g.winW > 0 && g.winW < 1000"
        :x="g.winX"
        y="6"
        :width="g.winW"
        height="178"
        rx="6"
        class="fill-warning/5 stroke-warning/70"
        stroke-width="1.5"
        stroke-dasharray="5 5"
        vector-effect="non-scaling-stroke"
        data-testid="wc-window"
      />
      <path :d="g.area" :fill="`url(#${id})`" />
      <path
        :d="g.line"
        fill="none"
        class="stroke-primary"
        stroke-width="2.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <figcaption
      class="flex justify-between font-mono text-12 text-text-subtle tabular"
      aria-hidden="true"
    >
      <span v-for="(tick, i) in g.ticks" :key="i">{{ tick }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.wc-stop-top {
  stop-color: var(--primary);
  stop-opacity: 0.28;
}
.wc-stop-bottom {
  stop-color: var(--primary);
  stop-opacity: 0.03;
}
</style>
