<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    type?: 'button' | 'submit';
    loading?: boolean;
    disabled?: boolean;
    block?: boolean;
  }>(),
  { variant: 'primary', type: 'button', loading: false, disabled: false, block: false },
);

const VARIANTS = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'border border-border-strong bg-transparent text-text hover:bg-surface-2',
  ghost: 'bg-transparent text-text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-critical text-text hover:opacity-90',
} as const;

const classes = computed(() => [
  'inline-flex h-9 shrink-0 max-lg:h-11 items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 text-14 font-semibold transition-colors',
  'disabled:cursor-not-allowed disabled:opacity-60',
  VARIANTS[props.variant],
  props.block ? 'w-full' : '',
]);
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || loading" :aria-busy="loading">
    <LoaderCircle v-if="loading" class="size-4 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
