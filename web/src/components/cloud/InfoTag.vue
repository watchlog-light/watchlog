<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A small label next to a heading or a row ("On", "This device"). Words, never colour alone.
withDefaults(defineProps<{ label: string; tone?: 'ok' | 'neutral' }>(), { tone: 'neutral' });
</script>

<template>
  <span
    :class="[
      'inline-flex items-center rounded-full border px-2 py-0.5 text-12 font-medium',
      tone === 'ok'
        ? 'border-ok/40 bg-ok/10 text-ok'
        : 'border-border bg-surface-2 text-text-muted',
    ]"
    >{{ label }}</span
  >
</template>
