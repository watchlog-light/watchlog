<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleCheck, Hourglass, TriangleAlert } from '@lucide/vue';
import { computed } from 'vue';

// Status is never shown by colour alone: icon + label (SPEC §11.1).
const props = defineProps<{ status: 'pending' | 'active' | 'inactive' }>();

const STYLES = {
  active: { icon: CircleCheck, tone: 'text-ok', key: 'clusters.status.active' },
  pending: { icon: Hourglass, tone: 'text-info', key: 'clusters.status.pending' },
  inactive: { icon: TriangleAlert, tone: 'text-warning', key: 'clusters.status.inactive' },
} as const;

const style = computed(() => STYLES[props.status]);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-12 font-medium text-text"
  >
    <component :is="style.icon" :class="['size-3.5', style.tone]" aria-hidden="true" />
    {{ $t(style.key) }}
  </span>
</template>
