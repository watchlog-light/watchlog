<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Tone } from '@/lib/certs-jobs';

// A state as a word on its tone (never by colour alone, SPEC §11.1): Expired, Failing, Working…
defineProps<{ tone: Tone; label: string }>();
const STYLE: Record<Tone, string> = {
  crit: 'bg-critical/15 text-critical-text',
  warn: 'bg-warning/15 text-warning-text',
  ok: 'bg-ok/15 text-ok-text',
  info: 'bg-info/15 text-info-text',
  muted: 'bg-surface-3 text-text-muted',
};
</script>

<template>
  <span
    :class="[
      'inline-flex h-6 items-center rounded-md px-2 text-11 font-bold tracking-wide whitespace-nowrap uppercase',
      STYLE[tone],
    ]"
    data-testid="tone-chip"
    >{{ label }}</span
  >
</template>
