<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Tone } from '@/lib/certs-jobs';

// One of a tab's four tiles: a label, a big value on its tone, a line under it.
defineProps<{ label: string; value: string; sub?: string; tone?: Tone }>();
const TEXT: Record<Tone, string> = {
  crit: 'text-critical-text',
  warn: 'text-warning-text',
  ok: 'text-text',
  info: 'text-info-text',
  muted: 'text-text',
};
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-1.5 rounded-card border border-border bg-surface-1 px-4 py-3.5"
  >
    <span class="font-mono text-11 tracking-widest text-text-muted uppercase">{{ label }}</span>
    <span
      :class="['text-24 font-semibold tabular-nums', TEXT[tone ?? 'ok']]"
      data-testid="tile-value"
      >{{ value }}</span
    >
    <span v-if="sub" class="truncate text-13 text-text-muted">{{ sub }}</span>
  </div>
</template>
