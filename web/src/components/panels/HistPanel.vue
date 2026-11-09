<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import type { PanelOf } from '@/lib/panels';

// A distribution (query or command durations): one column per bucket, its share of the
// total above it on hover and in the table for screen readers.
const props = defineProps<{ panel: PanelOf<'hist'> }>();
const max = computed(() => Math.max(0, ...props.panel.buckets.map((b) => b.share)) || 1);
const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 && v > 0 ? 1 : 0)}%`;
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex h-36 items-end gap-0.5 border-b border-border" aria-hidden="true">
      <div
        v-for="b in panel.buckets"
        :key="b.label"
        class="flex h-full flex-1 items-end"
        :title="`${b.label}: ${pct(b.share)}`"
      >
        <span
          class="block w-full rounded-t-[4px]"
          :style="{
            height: `${b.share > 0 ? Math.max(2, (b.share / max) * 100) : 0}%`,
            background: 'var(--chart-2)',
          }"
        />
      </div>
    </div>
    <div class="flex gap-0.5 text-12 text-text-muted" aria-hidden="true">
      <span v-for="b in panel.buckets" :key="b.label" class="flex-1 truncate text-center">{{
        b.label
      }}</span>
    </div>
    <table class="sr-only">
      <tr v-for="b in panel.buckets" :key="b.label">
        <th>{{ b.label }}</th>
        <td>{{ pct(b.share) }}</td>
      </tr>
    </table>
  </div>
</template>
