<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatValue } from '@/lib/units';
import { heatGrid, type PanelOf } from '@/lib/panels';

// When it is busy: the last 7 days by local weekday and hour, one hue from light to
// dark (sequential), each cell's value on hover; a table for screen readers.
const props = defineProps<{ panel: PanelOf<'heat'> }>();
const { t } = useI18n();
const grid = computed(() => heatGrid(props.panel.points));
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const day = (i: number) => t(`integrations.panel.days.${DAYS[i]}`);
const opacity = (v: number | null) =>
  v === null || grid.value.max === 0 ? 0 : 0.12 + 0.88 * (v / grid.value.max);
</script>

<template>
  <div class="flex flex-col gap-1 overflow-x-auto">
    <div
      v-for="(row, d) in grid.cells"
      :key="d"
      class="grid grid-cols-[2.25rem_repeat(24,minmax(0.5rem,1fr))] items-center gap-0.5"
      aria-hidden="true"
    >
      <span class="text-12 text-text-muted">{{ day(d) }}</span>
      <span
        v-for="(v, h) in row"
        :key="h"
        class="h-3.5 rounded-[3px] bg-surface-3"
        :title="`${day(d)} ${String(h).padStart(2, '0')}:00 · ${formatValue(v, panel.unit)}`"
      >
        <span
          class="block size-full rounded-[3px]"
          :style="{ background: 'var(--chart-2)', opacity: opacity(v) }"
        />
      </span>
    </div>
    <div
      class="grid grid-cols-[2.25rem_repeat(24,minmax(0.5rem,1fr))] gap-0.5 text-12 text-text-muted"
      aria-hidden="true"
    >
      <span />
      <span v-for="h in 24" :key="h" class="text-center">{{
        (h - 1) % 6 === 0 ? String(h - 1).padStart(2, '0') : ''
      }}</span>
    </div>
    <table class="sr-only">
      <tr v-for="(row, d) in grid.cells" :key="d">
        <th>{{ day(d) }}</th>
        <td v-for="(v, h) in row" :key="h">{{ h }}:00 {{ formatValue(v, panel.unit) }}</td>
      </tr>
    </table>
  </div>
</template>
