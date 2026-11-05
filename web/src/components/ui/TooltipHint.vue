<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useId } from 'vue';

// A short text shown on hover and keyboard focus, announced as the trigger's description.
// Hidden with display:none, not visibility: an invisible tooltip still takes layout space
// and gave pages a horizontal scrollbar when its trigger sat at the right edge (measured
// on the node page). `align="end"` opens it leftwards for triggers near the right edge.
withDefaults(defineProps<{ text: string; align?: 'start' | 'end' }>(), { align: 'start' });
const id = useId();
</script>

<template>
  <span class="group relative inline-flex" tabindex="0" :aria-describedby="id">
    <slot />
    <span
      :id="id"
      role="tooltip"
      :class="[
        'pointer-events-none absolute bottom-full z-20 mb-1.5 hidden w-max max-w-xs rounded-control border border-border bg-surface-3 px-2.5 py-1.5 text-12 text-text group-hover:block group-focus-visible:block',
        align === 'end' ? 'right-0' : 'left-0',
      ]"
    >
      {{ text }}
    </span>
  </span>
</template>
