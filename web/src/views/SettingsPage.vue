<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import UsersSettings from '@/components/settings/UsersSettings.vue';
import { computed, nextTick, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ChannelSettings from '@/components/alerts/ChannelSettings.vue';
import ClusterList from '@/components/clusters/ClusterList.vue';
import ApiTokens from '@/components/settings/ApiTokens.vue';
import GeneralSettings from '@/components/settings/GeneralSettings.vue';
import LogsAccess from '@/components/settings/LogsAccess.vue';
import SecuritySettings from '@/components/settings/SecuritySettings.vue';
import SystemNamespaces from '@/components/settings/SystemNamespaces.vue';
import PlanBilling from '@/components/plan/PlanBilling.vue';
import { useAuthStore } from '@/stores/auth';

// Settings (alerts redesign): clusters, alert channels with the email server and
// Telegram, general settings (the public address and the system namespaces) and the
// user's API tokens (ADR-125). Cloud adds Security: 2FA, sessions, GitHub and Google
// (ADR-175) and Plan & billing (ADR-177). ?tab= keeps the view.
const ALL_TABS = [
  'clusters',
  'channels',
  'general',
  'users',
  'tokens',
  'billing',
  'security',
] as const;
type Tab = (typeof ALL_TABS)[number];
const CLOUD_TABS: readonly Tab[] = ['billing', 'security'];
const auth = useAuthStore();
const TABS = computed<readonly Tab[]>(() =>
  auth.isCloud ? ALL_TABS : ALL_TABS.filter((t) => !CLOUD_TABS.includes(t)),
);
const route = useRoute();
const router = useRouter();
const tab = computed<Tab>(() =>
  TABS.value.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'clusters',
);
// On a phone the tab list scrolls: show the open tab (a link may open any of them).
onMounted(() =>
  nextTick(() =>
    document
      .querySelector<HTMLElement>('[role="tablist"] [aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
  ),
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
    <UsersSettings v-else-if="tab === 'users'" class="max-w-6xl" />
    <ApiTokens v-else-if="tab === 'tokens'" />
    <SecuritySettings v-else-if="tab === 'security'" />
    <PlanBilling v-else-if="tab === 'billing'" />
    <template v-else>
      <GeneralSettings />
      <SystemNamespaces />
      <LogsAccess />
    </template>
  </div>
</template>
