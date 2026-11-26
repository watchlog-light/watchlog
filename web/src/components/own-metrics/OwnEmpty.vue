<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Nothing reports yet: the question Add a source opens with (1.0.3), each answer leading to
// its way there.
import WayChooser from '@/components/own-metrics/add/WayChooser.vue';

defineProps<{ cluster: string }>();
</script>

<template>
  <section class="rounded-card border border-border bg-surface-1 px-6 py-8" data-testid="own-empty">
    <h2 class="text-16 font-semibold text-text">{{ $t('ownMetrics.empty.title') }}</h2>
    <p class="mt-2 max-w-2xl text-14 leading-relaxed text-text-muted">
      {{ $t('ownMetrics.empty.description') }}
    </p>
    <div class="mt-6"><WayChooser :cluster="cluster" /></div>
  </section>
</template>
