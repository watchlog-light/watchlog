<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';

// Subtle "updating" mark for refetches of data that is still shown (no skeleton).
defineProps<{ active: boolean }>();
</script>

<template>
  <span class="inline-flex size-4 items-center justify-center" aria-live="polite">
    <template v-if="active">
      <LoaderCircle
        class="size-3.5 animate-spin text-text-subtle motion-reduce:animate-none"
        aria-hidden="true"
        data-testid="refreshing"
      />
      <span class="sr-only">{{ $t('common.refreshing') }}</span>
    </template>
  </span>
</template>
