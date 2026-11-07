<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight } from '@lucide/vue';
import { LINKS } from '@/lib/links';

// Read-only demo (ADR-122): on every page, says what this is and where to get your own.
</script>

<template>
  <div
    class="flex flex-wrap items-center justify-center gap-x-2 border-b border-border bg-primary-soft px-4 py-1 text-13 text-text max-lg:py-0"
    data-testid="demo-banner"
  >
    <span class="inline-flex items-center gap-2 font-semibold">
      <span class="size-2 rounded-full bg-primary" aria-hidden="true" />
      {{ $t('demo.label') }}
    </span>
    <span class="text-text-muted" aria-hidden="true">·</span>
    <span class="text-text-muted">{{ $t('demo.sample') }}</span>
    <span class="text-text-muted" aria-hidden="true">·</span>
    <a
      :href="LINKS.install"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1 font-semibold text-primary hover:text-primary-hover hover:underline max-lg:min-h-11"
      data-testid="demo-install"
    >
      {{ $t('demo.install') }}
      <ArrowRight class="size-4" aria-hidden="true" />
    </a>
  </div>
</template>
