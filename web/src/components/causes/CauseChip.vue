<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { PanelState } from '@/lib/causes';

// How sure a cause is, in words (ADR-147): blue for likely, neutral otherwise. Red and
// amber stay for severity, so a chip never looks like an alert.
defineProps<{ state: PanelState }>();

const STYLE: Record<PanelState, string> = {
  likely: 'bg-info/15 text-info',
  possible: 'border border-dashed border-border-strong text-text',
  none: 'bg-surface-3 text-text-muted',
  was: 'border border-border bg-surface-2 text-text-muted',
};
</script>

<template>
  <span
    :class="[
      'inline-flex h-5.5 shrink-0 items-center rounded-full px-2.5 text-12 font-semibold whitespace-nowrap',
      STYLE[state],
    ]"
    :data-state="state"
    data-testid="cause-chip"
    >{{ $t(`causes.panel.chip.${state}`) }}</span
  >
</template>
