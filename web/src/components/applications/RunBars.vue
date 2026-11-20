<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { JobRun } from '@watchlog/api-types';
import { computed } from 'vue';
import { runBars, type RunBar } from '@/lib/certs-jobs';

// A job's last 14 runs as small bars, oldest on the left (the reference's "Last 14 runs"):
// colour and height both tell a failed, slow or running run from a good one; the label says
// it in words for screen readers.
const props = defineProps<{ runs: JobRun[]; usual: number | null; label: string }>();
const bars = computed(() => runBars(props.runs, props.usual));
const FILL: Record<RunBar['tone'], string> = {
  ok: 'fill-ok',
  crit: 'fill-critical',
  warn: 'fill-warning',
  info: 'fill-info',
  muted: 'fill-text-subtle',
};
</script>

<template>
  <svg
    width="150"
    height="18"
    viewBox="0 0 150 18"
    role="img"
    :aria-label="label"
    data-testid="run-bars"
  >
    <rect
      v-for="(b, i) in bars"
      :key="i"
      :x="b.x"
      :y="b.y"
      width="8"
      :height="b.h"
      rx="2"
      :class="FILL[b.tone]"
    />
    <rect
      v-for="i in Math.max(0, 14 - bars.length)"
      :key="`e${i}`"
      :x="(bars.length + i - 1) * 10.6"
      y="12"
      width="8"
      height="6"
      rx="2"
      class="fill-surface-3"
    />
  </svg>
</template>
