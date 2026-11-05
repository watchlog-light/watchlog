<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import Skeleton from './Skeleton.vue';

// `framed` renders a whole chart card (TimeSeriesChart's frame); without it, only
// the plot area, to sit inside an existing card.
defineProps<{ framed?: boolean; title?: string }>();
</script>

<template>
  <section v-if="framed" class="flex flex-col rounded-card border border-border bg-surface-1 p-4">
    <h3 class="text-13 font-medium text-text-muted">
      <template v-if="title">{{ title }}</template>
      <Skeleton v-else class="w-28" />
    </h3>
    <div class="relative mt-2 h-48"><SkeletonChart /></div>
  </section>
  <div v-else class="absolute inset-0 flex gap-3 pb-6" aria-hidden="true">
    <div class="flex w-8 flex-col justify-between text-12">
      <Skeleton v-for="i in 4" :key="i" class="w-full" />
    </div>
    <Skeleton shape="rect" class="flex-1" />
  </div>
</template>
