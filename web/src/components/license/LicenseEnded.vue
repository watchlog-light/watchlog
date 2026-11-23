<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { KeyRound } from '@lucide/vue';
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

// A licensed feature whose Enterprise licence ended (ADR-232): its page says when, that
// nothing was deleted, and how to turn it back on (an Owner pastes a new key; others ask one).
const props = defineProps<{ feature: string }>();
const auth = useAuthStore();
const endedOn = computed(() => auth.license?.endedOn ?? '');
const owner = computed(() => auth.user?.role === 'owner');
const _feature = computed(() => props.feature);
</script>

<template>
  <section
    class="mx-auto flex max-w-xl flex-col items-start gap-3 rounded-2xl border border-border bg-surface-1 px-6 py-6 max-md:px-4"
    data-testid="license-ended"
  >
    <span
      class="flex size-10 items-center justify-center rounded-full bg-warning/15 text-warning-text"
    >
      <KeyRound class="size-5" aria-hidden="true" />
    </span>
    <h2 class="text-20 font-semibold text-text">
      {{ $t('license.ended.title', { date: endedOn }) }}
    </h2>
    <p class="text-14 leading-relaxed text-text-muted">
      {{ $t('license.ended.body', { feature: _feature }) }}
    </p>
    <RouterLink
      v-if="owner"
      :to="{ name: 'settings', query: { tab: 'license' } }"
      class="inline-flex min-h-11 items-center rounded-control bg-primary px-4 text-14 font-semibold text-on-primary hover:bg-primary-hover"
      data-testid="license-ended-renew"
    >
      {{ $t('license.ended.renew') }}
    </RouterLink>
    <p v-else class="text-14 text-text-muted">{{ $t('license.ended.askOwner') }}</p>
  </section>
</template>
