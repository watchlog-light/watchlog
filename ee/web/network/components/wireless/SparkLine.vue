<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed } from 'vue';

// A small line of values (an access point's clients over 24 h), in the info colour.
const props = defineProps<{ values: number[]; label: string }>();
const W = 72;
const H = 20;
const d = computed(() => {
  const v = props.values;
  if (v.length < 2) return '';
  const max = Math.max(1, ...v);
  return v
    .map(
      (x, i) =>
        `${i ? 'L' : 'M'}${((i / (v.length - 1)) * W).toFixed(1)} ${(H - 1 - (x / max) * (H - 2)).toFixed(1)}`,
    )
    .join(' ');
});
</script>

<template>
  <svg
    v-if="d"
    :viewBox="`0 0 ${W} ${H}`"
    class="h-5 w-[72px] shrink-0"
    role="img"
    :aria-label="label"
  >
    <path
      :d="d"
      fill="none"
      class="stroke-info"
      stroke-width="1.5"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
