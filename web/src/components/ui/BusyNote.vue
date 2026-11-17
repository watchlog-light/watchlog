<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// "Busy, retrying…" (ADR-206): shown while any request waits out a 429 or a 503 that clears
// by itself. The pages keep their data and try again on their own; this only says so.
import { LoaderCircle } from '@lucide/vue';
import { anyBusy } from '@/lib/busy';
</script>

<template>
  <span role="status" aria-live="polite" class="contents">
    <span
      v-if="anyBusy"
      data-testid="busy-note"
      :title="$t('busy.hint')"
      class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2.5 text-12 whitespace-nowrap text-text-muted"
    >
      <LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {{ $t('busy.retrying') }}
      <span class="sr-only">{{ $t('busy.hint') }}</span>
    </span>
  </span>
</template>
