<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import Skeleton from '@/components/ui/Skeleton.vue';

// A card of the overview: title row (with optional actions), body, and its own
// skeleton on the first load.
defineProps<{ title: string; loading?: boolean; testid?: string }>();
</script>

<template>
  <section
    class="flex min-w-0 flex-col rounded-[12px] border border-border bg-surface-1"
    :data-testid="testid"
  >
    <header class="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-3">
      <h2 class="text-14 font-semibold text-text">{{ title }}</h2>
      <slot name="meta" />
      <div class="ml-auto flex items-center gap-2"><slot name="actions" /></div>
    </header>
    <div
      v-if="loading"
      class="flex flex-col gap-2 p-3.5"
      role="status"
      :aria-label="$t('common.loading')"
    >
      <Skeleton v-for="i in 4" :key="i" class="h-5 w-full" />
    </div>
    <slot v-else />
  </section>
</template>
