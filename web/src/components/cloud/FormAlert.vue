<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A form's message, as the sign-in page shows its errors: `alert` for errors (read out at
// once), `status` for good news.
withDefaults(defineProps<{ tone?: 'error' | 'ok' | 'info' }>(), { tone: 'error' });
</script>

<template>
  <p
    :role="tone === 'error' ? 'alert' : 'status'"
    :class="[
      'rounded-control border bg-surface-2 px-3 py-2 text-13 text-text',
      tone === 'error' ? 'border-critical' : tone === 'ok' ? 'border-ok' : 'border-border',
    ]"
  >
    <slot />
  </p>
</template>
