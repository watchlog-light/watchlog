<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import Skeleton from './Skeleton.vue';

// Same frame, header and row metrics as the data tables (ContainerList): a two-line
// first column (13 px name over 12 px detail), single-line cells after it.
withDefaults(defineProps<{ rows?: number; columns?: number; label: string }>(), {
  rows: 5,
  columns: 6,
});
const WIDTHS = ['w-12', 'w-16', 'w-10', 'w-14', 'w-20', 'w-8'];
</script>

<template>
  <div
    class="overflow-x-auto rounded-card border border-border bg-surface-1"
    role="status"
    :aria-label="label"
    data-testid="skeleton-table"
  >
    <table class="w-full min-w-[720px] text-left text-13">
      <thead class="bg-surface-2 text-12">
        <tr>
          <th v-for="c in columns" :key="c" class="px-4 py-2 font-medium">
            <Skeleton :class="WIDTHS[(c - 1) % WIDTHS.length]" />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr class="border-t border-border">
          <th :colspan="columns" class="px-4 pt-3 pb-1 text-12 font-semibold">
            <Skeleton class="w-36" />
          </th>
        </tr>
        <tr v-for="r in rows" :key="r" class="border-t border-border">
          <td class="px-4 py-2">
            <Skeleton :class="r % 2 ? 'w-32' : 'w-24'" />
            <Skeleton class="w-40 text-12" />
          </td>
          <td v-for="c in columns - 1" :key="c" class="px-4 py-2">
            <Skeleton :class="WIDTHS[(c + r) % WIDTHS.length]" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
