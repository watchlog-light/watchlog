<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Clock } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { DEMO_TIME_RANGES, TIME_RANGES, useUiStore } from '@/stores/ui';

// The time range of the charts: a compact segmented control in the top bar, or a
// full-width one with 44 px buttons in the filter sheet (phones).
defineProps<{ sheet?: boolean }>();
const { timeRange } = storeToRefs(useUiStore());
const auth = useAuthStore();
const ranges = computed(() => (auth.demoMode ? DEMO_TIME_RANGES : TIME_RANGES));
</script>

<template>
  <div
    role="group"
    :aria-label="$t('topBar.timeRange')"
    :class="[
      'flex items-center rounded-control border border-border bg-surface-1',
      // Touch: 48 px with no inner padding, so each button is 46 px.
      sheet ? 'h-12 w-full' : 'h-8 p-0.5 max-lg:h-12 max-lg:p-0',
    ]"
  >
    <Clock v-if="!sheet" class="mx-2 size-3.5 text-text-subtle" aria-hidden="true" />
    <button
      v-for="range in ranges"
      :key="range"
      type="button"
      :aria-pressed="timeRange === range"
      :class="[
        'h-full rounded-[4px] font-mono text-12 tabular transition-colors',
        sheet ? 'flex-1 text-14' : 'px-2.5 max-lg:min-w-11',
        timeRange === range
          ? 'bg-surface-3 text-text'
          : 'text-text-muted hover:bg-surface-2 hover:text-text',
      ]"
      @click="timeRange = range"
    >
      {{ $t(`topBar.ranges.${range}`) }}
    </button>
  </div>
</template>
