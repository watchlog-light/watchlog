<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Nothing reports yet: the three ways in, each leading to its tab of "Add a source".
import { Radio, Send, Upload } from '@lucide/vue';
import type { Way } from '@/lib/own-metrics';

defineProps<{ cluster: string }>();
const WAYS: { way: Way; icon: typeof Radio }[] = [
  { way: 'scrape', icon: Radio },
  { way: 'prometheus', icon: Send },
  { way: 'push', icon: Upload },
];
</script>

<template>
  <section class="rounded-card border border-border bg-surface-1 px-6 py-8" data-testid="own-empty">
    <h2 class="text-16 font-semibold text-text">{{ $t('ownMetrics.empty.title') }}</h2>
    <p class="mt-2 max-w-2xl text-14 leading-relaxed text-text-muted">
      {{ $t('ownMetrics.empty.description') }}
    </p>
    <ul class="mt-6 grid gap-3 md:grid-cols-3">
      <li v-for="w in WAYS" :key="w.way">
        <RouterLink
          :to="{ name: 'your-metrics-add', query: { cluster, way: w.way } }"
          class="flex h-full flex-col gap-2 rounded-card border border-border bg-surface-2 px-4 py-4 transition-colors hover:border-primary"
          :data-testid="`own-way-${w.way}`"
        >
          <component :is="w.icon" class="size-5 text-text-muted" aria-hidden="true" />
          <span class="text-14 font-semibold text-text">{{
            $t(`ownMetrics.ways.${w.way}.title`)
          }}</span>
          <span class="text-13 leading-relaxed text-text-muted">{{
            $t(`ownMetrics.ways.${w.way}.sub`)
          }}</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
