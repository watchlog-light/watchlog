<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Component } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

defineProps<{
  icon: Component;
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: RouteLocationRaw;
}>();
</script>

<template>
  <section
    class="mx-auto flex max-w-lg flex-col items-center rounded-card border border-border bg-surface-1 px-8 py-12 text-center"
  >
    <div
      class="mb-4 flex size-12 items-center justify-center rounded-card bg-surface-2 text-text-muted"
      aria-hidden="true"
    >
      <component :is="icon" class="size-6" />
    </div>
    <h2 class="text-16 font-semibold text-text">{{ title }}</h2>
    <p class="mt-2 text-14 leading-relaxed text-text-muted">{{ description }}</p>
    <div v-if="$slots.action" class="mt-6"><slot name="action" /></div>
    <RouterLink
      v-else-if="actionLabel && actionTo"
      :to="actionTo"
      class="mt-6 inline-flex h-9 items-center rounded-control bg-primary px-4 text-14 font-semibold text-on-primary transition-colors hover:bg-primary-hover"
    >
      {{ actionLabel }}
    </RouterLink>
  </section>
</template>
