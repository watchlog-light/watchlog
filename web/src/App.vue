<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import ToastHost from '@/components/ui/ToastHost.vue';

const route = useRoute();
const { t } = useI18n();

watchEffect(() => {
  const page = route.meta.titleKey ? t(route.meta.titleKey) : undefined;
  document.title = page ? `${page} · ${t('app.name')}` : t('app.name');
});
</script>

<template>
  <RouterView />
  <ToastHost />
</template>
