<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A split shown as bars (1.0.0, ADR-237): each value of the label with its number now, the
// highest first, "other" last.
import { computed } from 'vue';
import { ranked } from '@/lib/own-dashboard';
import type { OwnLine } from '@/lib/own-chart';
import { ratePer, writtenText, type Showing } from '@/lib/own-metrics';

const props = defineProps<{ lines: (OwnLine & { other?: boolean })[]; showing: Showing }>();
const rows = computed(() => ranked(props.lines));
// One scale for all the bars: the one the highest value now reads best in.
const per = computed(() =>
  props.showing.shown === 'rate'
    ? ratePer(Math.max(0, ...rows.value.map((r) => r.value ?? 0)))
    : undefined,
);
</script>

<template>
  <ul class="flex flex-col gap-2.5" data-testid="own-ranked">
    <li v-for="(r, i) in rows" :key="r.name" class="text-13">
      <div class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 truncate text-text">{{ r.name }}</span>
        <span class="shrink-0 tabular-nums text-text-muted">{{
          writtenText(r.value, showing, per)
        }}</span>
      </div>
      <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
        <div
          class="h-full rounded-full"
          :style="{
            width: `${Math.max(r.share * 100, r.value ? 2 : 0)}%`,
            background: r.other ? 'var(--text-subtle)' : `var(--chart-${(i % 8) + 1})`,
          }"
        />
      </div>
    </li>
  </ul>
</template>
