<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CalendarClock, CircleAlert, KeyRound } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { bannerText } from '@/lib/license';
import { useAuthStore } from '@/stores/auth';

// The licence's banners (ADR-232), self-hosted, for Owners only, over every page: over the
// units ("58 of 50 units…"), 30 days before the end, the 14 days of grace, after the end, or a
// key that doesn't work. The most pressing one, plainly, with one link to Settings › License.
const { t } = useI18n();
const auth = useAuthStore();
const banner = computed(() =>
  auth.user?.role === 'owner' ? (auth.license?.banners[0] ?? null) : null,
);
const text = computed(() => (banner.value ? bannerText(banner.value, t) : ''));
const icon = computed(() =>
  banner.value?.kind === 'expiring' || banner.value?.kind === 'grace'
    ? CalendarClock
    : banner.value?.kind === 'over'
      ? CircleAlert
      : KeyRound,
);
const LICENSE = { name: 'settings', query: { tab: 'license' } } as const;
</script>

<template>
  <div
    v-if="banner"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface-1 px-4 py-2 text-13 text-text md:px-6"
    role="region"
    :aria-label="$t('license.banner.label')"
    data-testid="license-banner"
    :data-kind="banner.kind"
  >
    <component
      :is="icon"
      :class="[
        'size-4 shrink-0',
        banner.kind === 'ended' || banner.kind === 'invalid'
          ? 'text-critical-text'
          : 'text-warning-text',
      ]"
      aria-hidden="true"
    />
    <p class="min-w-0 flex-1">{{ text }}</p>
    <RouterLink
      :to="LICENSE"
      class="inline-flex items-center font-semibold whitespace-nowrap text-link hover:text-primary-hover max-lg:min-h-11 max-sm:basis-full max-sm:pl-7"
      data-testid="license-banner-link"
    >
      {{ banner.kind === 'over' ? $t('license.banner.contact') : $t('license.banner.open') }}
    </RouterLink>
  </div>
</template>
