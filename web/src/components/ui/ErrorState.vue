<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleAlert } from '@lucide/vue';
import BaseButton from './BaseButton.vue';

// Load failures, always with a Retry. `inline` is a one-line banner above content that
// is still shown (a refetch failed); the default replaces the missing content.
defineProps<{ message: string; retrying?: boolean; inline?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div
    role="alert"
    data-testid="error-state"
    :class="
      inline
        ? 'flex flex-wrap items-center gap-3 rounded-card border border-critical bg-surface-1 px-4 py-2'
        : 'mx-auto flex max-w-lg flex-col items-center rounded-card border border-border bg-surface-1 px-8 py-10 text-center'
    "
  >
    <CircleAlert
      :class="inline ? 'size-4 shrink-0 text-critical' : 'mb-3 size-6 text-critical'"
      aria-hidden="true"
    />
    <p :class="inline ? 'flex-1 text-13 text-text' : 'text-14 text-text'">{{ message }}</p>
    <BaseButton
      variant="secondary"
      :class="inline ? '' : 'mt-5'"
      :loading="retrying"
      data-testid="retry"
      @click="$emit('retry')"
    >
      {{ $t('common.retry') }}
    </BaseButton>
  </div>
</template>
