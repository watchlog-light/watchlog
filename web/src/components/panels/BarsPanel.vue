<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { formatValue } from '@/lib/units';
import { SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';

// Horizontal bars, largest first (top commands, key prefixes, tables): the label left,
// the value right in text ink, a thin bar between them scaled to the largest. A bar
// with a severity takes its status colour; the others share one hue.
const props = defineProps<{ panel: PanelOf<'bars'> }>();
const max = computed(() => Math.max(0, ...props.panel.items.map((i) => i.value)) || 1);
</script>

<template>
  <ul class="flex flex-col gap-2">
    <li
      v-for="item in panel.items"
      :key="item.label"
      class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
      :title="`${item.label}: ${formatValue(item.value, panel.unit)}`"
      data-testid="bar"
    >
      <span class="truncate font-mono text-12 text-text">{{ item.label }}</span>
      <span class="text-12 text-text-muted tabular-nums">{{
        formatValue(item.value, panel.unit)
      }}</span>
      <span class="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <span
          class="block h-full rounded-full"
          :style="{
            width: `${Math.max(1, (item.value / max) * 100)}%`,
            background: `var(${item.severity && item.severity !== 'ok' ? SEVERITY_TOKEN[item.severity] : '--chart-2'})`,
          }"
        />
      </span>
    </li>
  </ul>
</template>
