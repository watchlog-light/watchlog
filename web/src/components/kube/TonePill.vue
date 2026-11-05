<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Circle, CircleCheck, CircleX, TriangleAlert } from '@lucide/vue';
import { computed } from 'vue';
import type { Tone } from '@/lib/kube';

// Status is never shown by colour alone: icon + label (SPEC §11.1).
const props = defineProps<{ tone: Tone; label: string }>();

const STYLES = {
  ok: { icon: CircleCheck, class: 'text-ok' },
  warning: { icon: TriangleAlert, class: 'text-warning' },
  critical: { icon: CircleX, class: 'text-critical' },
  neutral: { icon: Circle, class: 'text-text-subtle' },
} as const;
const style = computed(() => STYLES[props.tone]);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-12 font-medium whitespace-nowrap text-text"
  >
    <component :is="style.icon" :class="['size-3.5 shrink-0', style.class]" aria-hidden="true" />
    {{ label }}
  </span>
</template>
