<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Router } from '@lucide/vue';
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import NetworkMapPicture from './NetworkMapPicture.vue';

// The network's teaser (ADR-233) for Cloud Free and Community without a key: a picture of the
// map, three lines, and the link each edition already uses (Cloud: Plan & billing;
// self-hosted: WatchLog Enterprise). It loads nothing.
const auth = useAuthStore();
const cloud = computed(() => auth.isCloud);
</script>

<template>
  <section
    class="mx-auto mt-8 flex max-w-3xl flex-col gap-5 px-6 pb-10 max-md:mt-4 max-md:px-4"
    data-testid="network-teaser"
  >
    <div class="flex items-center gap-3">
      <span class="flex size-10 items-center justify-center rounded-full bg-info/15 text-info-text">
        <Router class="size-5" aria-hidden="true" />
      </span>
      <h1 class="text-24 font-semibold text-text max-md:text-20">
        {{ $t('network.teaser.title') }}
      </h1>
    </div>
    <NetworkMapPicture />
    <ul class="flex flex-col gap-2 text-14 leading-relaxed text-text-muted">
      <li>{{ $t('network.teaser.line1') }}</li>
      <li>{{ $t('network.teaser.line2') }}</li>
      <li>{{ $t('network.teaser.line3') }}</li>
    </ul>
    <div class="flex flex-wrap items-center gap-3">
      <span
        class="inline-flex h-6 items-center rounded-full border border-info/50 px-2.5 text-12 font-semibold text-info-text"
        >{{ $t('network.teaser.available') }}</span
      >
      <RouterLink
        v-if="cloud"
        :to="{ name: 'settings', query: { tab: 'billing' } }"
        class="inline-flex min-h-11 items-center font-semibold text-link hover:underline"
        data-testid="network-teaser-upgrade"
        >{{ $t('network.teaser.upgrade') }}</RouterLink
      >
      <a
        v-else
        href="https://watchlog.io/enterprise"
        target="_blank"
        rel="noopener"
        class="inline-flex min-h-11 items-center font-semibold text-link hover:underline"
        data-testid="network-teaser-contact"
        >{{ $t('network.teaser.contact') }}</a
      >
    </div>
  </section>
</template>
