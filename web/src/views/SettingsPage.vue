<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ChannelSettings from '@/components/alerts/ChannelSettings.vue';
import ClusterList from '@/components/clusters/ClusterList.vue';
import GeneralSettings from '@/components/settings/GeneralSettings.vue';
import SystemNamespaces from '@/components/settings/SystemNamespaces.vue';

// Settings (alerts redesign): clusters, alert channels with the email server and
// Telegram, and general settings: the public address and the system namespaces. ?tab=
// keeps the view.
const TABS = ['clusters', 'channels', 'general'] as const;
type Tab = (typeof TABS)[number];
const route = useRoute();
const router = useRouter();
const tab = computed<Tab>(() =>
  TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'clusters',
);
function setTab(t: Tab) {
  void router.replace({ query: { ...route.query, tab: t === 'clusters' ? undefined : t } });
}
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-6">
    <nav
      role="tablist"
      class="flex gap-1 overflow-x-auto border-b border-border"
      :aria-label="$t('nav.settings')"
    >
      <button
        v-for="t in TABS"
        :key="t"
        type="button"
        role="tab"
        :aria-selected="tab === t"
        :class="[
          '-mb-px border-b-2 px-3 py-2 text-13 whitespace-nowrap transition-colors max-lg:min-h-11',
          tab === t
            ? 'border-primary text-text'
            : 'border-transparent text-text-muted hover:text-text',
        ]"
        :data-testid="`settings-tab-${t}`"
        @click="setTab(t)"
      >
        {{ $t(`settings.tabs.${t}`) }}
      </button>
    </nav>
    <ClusterList v-if="tab === 'clusters'" class="max-w-3xl" />
    <ChannelSettings v-else-if="tab === 'channels'" />
    <template v-else>
      <GeneralSettings />
      <SystemNamespaces />
    </template>
  </div>
</template>
