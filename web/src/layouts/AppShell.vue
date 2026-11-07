<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { storeToRefs } from 'pinia';
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AppSidebar from '@/components/layout/AppSidebar.vue';
import AppTopBar from '@/components/layout/AppTopBar.vue';
import AlertingStatusBanner from '@/components/alerts/AlertingStatusBanner.vue';
import DemoBanner from '@/components/layout/DemoBanner.vue';
import { useCompact } from '@/composables/useNarrow';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';

const route = useRoute();
const { t } = useI18n();
const title = computed(() => (route.meta.titleKey ? t(route.meta.titleKey) : t('app.name')));
// Below 1024 px the sidebar is an off-canvas drawer, closed on every navigation.
const compact = useCompact();
const { navOpen } = storeToRefs(useUiStore());
const auth = useAuthStore();
watch([() => route.fullPath, compact], () => (navOpen.value = false));
</script>

<template>
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-surface-3 focus:px-3 focus:py-2"
  >
    {{ $t('app.skipToContent') }}
  </a>
  <div class="flex h-dvh overflow-hidden bg-bg">
    <AppSidebar v-if="!compact" />
    <DialogRoot v-else v-model:open="navOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-40 bg-bg/60" />
        <DialogContent
          class="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] shadow-xl"
          data-testid="nav-drawer"
        >
          <DialogTitle class="sr-only">{{ $t('nav.label') }}</DialogTitle>
          <DialogDescription class="sr-only">{{ $t('nav.label') }}</DialogDescription>
          <AppSidebar drawer />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <div class="flex min-w-0 flex-1 flex-col">
      <DemoBanner v-if="auth.demoMode" />
      <AppTopBar :title="title" />
      <AlertingStatusBanner />
      <main id="main" class="flex-1 overflow-y-auto p-4 md:p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
