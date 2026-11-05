<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';

// A KPI's trend over the selected range: line, soft area, last point. Decorative: the
// number and its comparison carry the meaning.
// `row` is the small 90 × 24 version for table rows.
const props = withDefaults(
  defineProps<{ values: (number | null)[]; colorToken?: string; size?: 'kpi' | 'row' }>(),
  { colorToken: '--info', size: 'kpi' },
);
const W = 160;
const H = 30;
const path = computed(() => {
  const vs = props.values.map((v) => v ?? null);
  const nums = vs.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const max = Math.max(...nums) * 1.15 || 1;
  const min = Math.min(0, ...nums);
  const pts: [number, number][] = [];
  vs.forEach((v, i) => {
    if (v === null) return;
    pts.push([(i / (vs.length - 1)) * W, H - ((v - min) / (max - min)) * (H - 3) - 1.5]);
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return { line, area: `${line} L${pts.at(-1)![0]} ${H} L${pts[0]![0]} ${H}Z`, last: pts.at(-1)! };
});
</script>

<template>
  <svg
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    :class="size === 'row' ? 'block h-6 w-[90px]' : 'mt-1.5 block h-[30px] w-full'"
    aria-hidden="true"
  >
    <template v-if="path">
      <path :d="path.area" :style="{ fill: `var(${colorToken})` }" fill-opacity="0.12" />
      <path
        :d="path.line"
        fill="none"
        :style="{ stroke: `var(${colorToken})` }"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />
      <circle
        :cx="path.last[0]"
        :cy="path.last[1]"
        r="2.2"
        :style="{ fill: `var(${colorToken})` }"
      />
    </template>
    <line
      v-else
      x1="0"
      :y1="H - 2"
      :x2="W"
      :y2="H - 2"
      class="stroke-border"
      stroke-dasharray="3 4"
    />
  </svg>
</template>

<style scoped>
.stroke-border {
  stroke: var(--border-strong);
}
</style>
