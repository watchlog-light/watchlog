<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Lock } from '@lucide/vue';
import { computed, type Component } from 'vue';
import { useAuthStore } from '@/stores/auth';

// An Enterprise module's page (ADR-232): the module while the licence lists its feature (in
// Cloud and the demo the backend decides, so the page asks it), the core's teaser otherwise.
const props = defineProps<{ feature: string; page: Component }>();
const auth = useAuthStore();
const on = computed(
  () => auth.isCloud || auth.demoMode || !!auth.license?.features.includes(props.feature),
);
</script>

<template>
  <component :is="page" v-if="on" />
  <section
    v-else
    class="mx-auto mt-10 flex max-w-xl flex-col items-start gap-3 rounded-2xl border border-border bg-surface-1 px-6 py-6 max-md:px-4"
    data-testid="ee-teaser"
  >
    <span class="flex size-10 items-center justify-center rounded-full bg-info/15 text-info-text">
      <Lock class="size-5" aria-hidden="true" />
    </span>
    <h2 class="text-20 font-semibold text-text">{{ $t('ee.teaser.title') }}</h2>
    <p class="text-14 leading-relaxed text-text-muted">{{ $t('ee.teaser.body') }}</p>
    <a
      href="https://watchlog.io/enterprise"
      target="_blank"
      rel="noopener"
      class="font-semibold text-link hover:underline"
      >{{ $t('ee.teaser.link') }}</a
    >
  </section>
</template>
