<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Plus } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { networkTabs, type TabCounts } from '../tabs';
import { loadTabCounts, tabCounts } from '../lib/tab-counts';

// The network section's header (ADR-233): its title, the tabs registered in tabs.ts (0.17's
// Wireless and Storage only where the network has such devices), and "Add devices" for those
// who may.
const props = defineProps<{ devices?: number | null }>();
const route = useRoute();
const auth = useAuthStore();
const nav = ref<HTMLElement | null>(null);
// On a phone the tabs scroll sideways: keep the current one in view (Storage is the last).
function showActive() {
  void nextTick(() =>
    nav.value
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
  );
}
onMounted(() => {
  void loadTabCounts();
  showActive();
});
const counts = computed<TabCounts | null>(() =>
  tabCounts.value
    ? { ...tabCounts.value, devices: props.devices ?? tabCounts.value.devices }
    : props.devices != null
      ? { devices: props.devices, kinds: {}, wifiClients: 0 }
      : null,
);
const tabs = computed(() =>
  networkTabs.filter((t) => !t.shown || (counts.value ? t.shown(counts.value) : false)),
);
watch(tabs, showActive);
const active = (name: string) =>
  route.name === name || (name === 'network-devices' && route.name === 'network-device');
</script>

<template>
  <header class="flex flex-col gap-3" data-testid="network-header">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-20 font-semibold text-text">{{ $t('nav.network') }}</h1>
        <p class="text-13 text-text-muted">{{ $t('net.subtitle') }}</p>
      </div>
      <RouterLink
        v-if="auth.canManage"
        :to="{ name: 'network-add' }"
        class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 max-md:h-11 text-13 font-semibold text-on-primary hover:bg-primary-hover"
        data-testid="network-add-link"
      >
        <Plus class="size-4" aria-hidden="true" />{{ $t('net.addDevices') }}
      </RouterLink>
    </div>
    <!-- The tabs scroll sideways on a narrow window, with no scrollbar of their own: the rule
         under them is drawn inside the row, so nothing reaches past it (a tab's 1 px overlap
         made the row scroll up and down too, with a stray control at its right edge). -->
    <nav
      ref="nav"
      class="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      :aria-label="$t('nav.network')"
    >
      <RouterLink
        v-for="t in tabs"
        :key="t.route"
        :to="{ name: t.route }"
        class="inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-13 font-medium max-md:h-11"
        :class="
          active(t.route)
            ? 'border-primary text-text'
            : 'border-transparent text-text-muted hover:text-text'
        "
        :aria-current="active(t.route) ? 'page' : undefined"
        >{{ $t(t.titleKey) }}
        <span
          v-if="t.count && counts && t.count(counts) != null"
          class="rounded-full bg-surface-2 px-1.5 text-12 text-text-muted tabular"
          >{{ t.count(counts) }}</span
        >
      </RouterLink>
    </nav>
  </header>
</template>
