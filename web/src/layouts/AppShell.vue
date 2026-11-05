<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import AppTopBar from '@/components/layout/AppTopBar.vue';
import AlertingStatusBanner from '@/components/alerts/AlertingStatusBanner.vue';

const route = useRoute();
const { t } = useI18n();
const title = computed(() => (route.meta.titleKey ? t(route.meta.titleKey) : t('app.name')));
</script>

<template>
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-surface-3 focus:px-3 focus:py-2"
  >
    {{ $t('app.skipToContent') }}
  </a>
  <div class="flex h-screen overflow-hidden bg-bg">
    <AppSidebar />
    <div class="flex min-w-0 flex-1 flex-col">
      <AppTopBar :title="title" />
      <AlertingStatusBanner />
      <main id="main" class="flex-1 overflow-y-auto p-4 md:p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
