<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Network } from '@lucide/vue';
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { useAuthStore } from '@/stores/auth';
import { networkApi } from '../api';
import NetworkMap from '../components/NetworkMap.vue';
import NetworkTabs from '../components/NetworkTabs.vue';

// The Map tab (ADR-233): the whole network, refreshed every 30 s like the pollers; the view,
// the layers and the picked device stay put across refreshes. `?focus=<deviceId>` (from the
// Overview's small map, or a link elsewhere) picks that device and brings it into view.
const route = useRoute();
const auth = useAuthStore();
const page = useLoader(() => networkApi.map());
const poll = usePolling(() => page.load(), 30_000);
onMounted(() => {
  void page.load();
  poll.start();
});
const focus = computed(() =>
  typeof route.query.focus === 'string' && route.query.focus ? route.query.focus : undefined,
);
const devices = computed(() => page.data.value?.devices.length ?? null);
</script>

<template>
  <div class="flex flex-col gap-4 p-6 max-md:p-4">
    <NetworkTabs :devices="devices" />
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('net.loadError')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div
      v-if="page.skeleton.value"
      class="overflow-hidden rounded-card border border-border bg-surface-1"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="map-skeleton"
    >
      <div class="flex gap-3 border-b border-border px-3 py-2.5">
        <Skeleton shape="rect" class="h-9 w-full sm:w-72" />
      </div>
      <Skeleton shape="rect" class="h-[60dvh] min-h-[360px] w-full rounded-none" />
    </div>
    <template v-else-if="page.data.value">
      <EmptyState
        v-if="!page.data.value.devices.length"
        :icon="Network"
        :title="$t('netMap.empty.title')"
        :description="$t('netMap.empty.text')"
        :action-label="auth.canManage ? $t('net.addDevices') : undefined"
        :action-to="auth.canManage ? { name: 'network-add' } : undefined"
      />
      <NetworkMap v-else :data="page.data.value" :focus="focus" />
    </template>
  </div>
</template>
