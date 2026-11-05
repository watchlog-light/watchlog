<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import Skeleton from './Skeleton.vue';

// Placeholder for a detail page header. Without facts: title and meta line on the
// left, status pill on the right (host, cluster). With facts: title and pill on one
// line over a facts grid (container).
withDefaults(defineProps<{ facts?: number; label: string }>(), { facts: 0 });
</script>

<template>
  <header
    v-if="facts === 0"
    class="flex flex-wrap items-center justify-between gap-3"
    role="status"
    :aria-label="label"
    data-testid="skeleton-header"
  >
    <div>
      <Skeleton class="w-48 text-20" />
      <Skeleton class="mt-1 w-72 text-13" />
    </div>
    <span class="block rounded-full border border-transparent px-2 py-0.5 text-12">
      <Skeleton class="w-14" />
    </span>
  </header>
  <header
    v-else
    class="flex flex-col gap-3"
    role="status"
    :aria-label="label"
    data-testid="skeleton-header"
  >
    <div class="flex flex-wrap items-center gap-3">
      <Skeleton class="w-48 text-20" />
      <span class="block rounded-full border border-transparent px-2 py-0.5 text-12">
        <Skeleton class="w-16" />
      </span>
    </div>
    <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-13 md:grid-cols-4">
      <div v-for="i in facts" :key="i">
        <Skeleton class="w-16 text-12" />
        <Skeleton class="w-28" />
      </div>
    </div>
  </header>
</template>
