<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';
import { PanelLeftClose, PanelLeftOpen, X } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { navFor, type NavItem } from '@/router';
import { useApplicationsStore } from '@/stores/applications';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { dayOf, LEARNING_DAYS } from '@/lib/what-changed-learning';
import { useEgressStore } from '@/stores/egress';
import { usePlanStore } from '@/stores/plan';
import { useUiStore } from '@/stores/ui';
import { useWhatChangedLearningStore } from '@/stores/whatChangedLearning';
import AccountMenu from './AccountMenu.vue';
import ClusterSwitcher from './ClusterSwitcher.vue';
import PlanLine from '@/components/plan/PlanLine.vue';

// `drawer`: below 1024 px the shell shows the sidebar as an off-canvas drawer, full width
// with 44 px rows; the cluster switcher is in the top bar there.
const props = defineProps<{ drawer?: boolean }>();
const ui = useUiStore();
const { sidebarCollapsed } = storeToRefs(ui);
const collapsed = computed(() => !props.drawer && sidebarCollapsed.value);
const auth = useAuthStore();
const { t } = useI18n();
const clusters = useClustersStore();
// The pages of the selected cluster's kind (Servers for a Server fleet, Nodes for Kubernetes).
const items = computed(() =>
  navFor(clusters.selected?.kind as 'kubernetes' | 'server' | undefined),
);
const router = useRouter();
const route = useRoute();
// Applications shows how many monitored services have a problem (SPEC §4.12).
const applications = useApplicationsStore();
const badge = (item: NavItem) => (item.name === 'applications' ? applications.problems : 0);
// Egress shows how many destinations are new in 24 hours (ADR-188), in the warning tone.
const egress = useEgressStore();
const newCount = (item: NavItem) =>
  item.name === 'egress' && clusters.selected ? (egress.newCount[clusters.selected.id] ?? 0) : 0;
// What changed says which day of its learning week it is (ADR-216), for an org with Pro.
const plan = usePlanStore();
const learning = useWhatChangedLearningStore();
const learningDay = (item: NavItem) => {
  if (item.name !== 'what-changed' || !clusters.selected) return 0;
  const l = learning.state[clusters.selected.id];
  return l?.learning && l.since ? dayOf(l) : 0;
};
// Cloud marks the Pro sections, so a Free org knows before it opens one (Community has no plans).
const pro = (item: NavItem) => auth.isCloud && !!item.pro && !learningDay(item);
const linkTitle = (item: NavItem) =>
  collapsed.value
    ? pro(item)
      ? `${t(item.titleKey)} · ${t('nav.pro')}`
      : t(item.titleKey)
    : undefined;
watch(
  () => clusters.selected?.id,
  (id) => {
    if (id) void egress.load(id);
  },
  { immediate: true },
);
watch(
  () => [clusters.selected?.id, plan.info?.proFeatures] as const,
  ([id, hasPro]) => {
    if (id && auth.isCloud && hasPro) void learning.load(id);
  },
  { immediate: true },
);

/** Exact match for Overview; path prefix for sections with nested pages (e.g. Settings). */
function isCurrent(item: NavItem): boolean {
  if (item.path === '/') return route.path === '/';
  return route.path === item.path || route.path.startsWith(`${item.path}/`);
}

// The namespace filter (?ns=) follows the user across the Kubernetes pages.
const KUBE_PATHS = new Set(['/', '/nodes', '/workloads', '/events']);
function target(path: string) {
  return KUBE_PATHS.has(path) && typeof route.query.ns === 'string'
    ? { path, query: { ns: route.query.ns } }
    : path;
}

async function signOut() {
  await auth.logout();
  clusters.reset();
  applications.reset();
  egress.reset();
  learning.reset();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <aside
    data-testid="sidebar"
    :class="[
      'flex h-full shrink-0 flex-col border-r border-border bg-surface-1 transition-[width] duration-200',
      drawer ? 'w-full' : collapsed ? 'w-16' : 'w-60',
    ]"
  >
    <!-- The header: the logo and, from 1024 px, the collapse button next to it (0.10.1). The
         collapsed rail stacks them: the logo, then the expand button. -->
    <div
      :class="
        collapsed
          ? 'flex flex-col items-center gap-2 pt-3 pb-2'
          : 'flex h-14 items-center gap-2.5 pr-2 pl-4'
      "
    >
      <img :src="logoUrl" alt="" class="size-8 shrink-0" />
      <span v-if="!collapsed" class="text-16 font-semibold tracking-tight text-text">
        {{ $t('app.name') }}
      </span>
      <button
        v-if="drawer"
        type="button"
        data-testid="nav-close"
        :aria-label="$t('nav.close')"
        class="ml-auto flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text"
        @click="ui.navOpen = false"
      >
        <X class="size-5" aria-hidden="true" />
      </button>
      <button
        v-else
        type="button"
        data-testid="sidebar-toggle"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? $t('nav.expand') : $t('nav.collapse')"
        :title="collapsed ? $t('nav.expand') : $t('nav.collapse')"
        :class="[
          'flex items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-2 hover:text-text',
          collapsed ? 'size-10' : 'ml-auto size-9',
        ]"
        @click="ui.toggleSidebar()"
      >
        <PanelLeftOpen v-if="collapsed" class="size-4.5" aria-hidden="true" />
        <PanelLeftClose v-else class="size-4.5" aria-hidden="true" />
      </button>
    </div>

    <div v-if="!drawer" class="px-3 pb-3">
      <ClusterSwitcher :collapsed="collapsed" />
    </div>

    <nav :aria-label="$t('nav.label')" class="flex-1 overflow-y-auto px-3">
      <ul class="flex flex-col gap-0.5">
        <li v-for="item in items" :key="item.name">
          <RouterLink v-slot="{ href, navigate }" :to="target(item.path)" custom>
            <a
              :href="href"
              :title="linkTitle(item)"
              :aria-current="isCurrent(item) ? 'page' : undefined"
              :class="[
                'relative flex items-center gap-3 rounded-control px-2.5 text-14 transition-colors',
                drawer ? 'h-11' : 'h-9',
                isCurrent(item)
                  ? 'bg-surface-2 font-medium text-text before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
              ]"
              @click="navigate"
            >
              <component :is="item.icon" class="size-4.5 shrink-0" aria-hidden="true" />
              <span :class="collapsed ? 'sr-only' : 'truncate'">{{ $t(item.titleKey) }}</span>
              <span
                v-if="badge(item) > 0"
                data-testid="nav-badge"
                :class="[
                  'flex h-5 min-w-5 items-center justify-center rounded-full bg-critical/15 px-1.5 text-12 font-semibold text-critical',
                  collapsed ? 'absolute -top-0.5 right-0.5 h-4 min-w-4 px-1' : 'ml-auto',
                ]"
              >
                <span class="sr-only">{{ $t('nav.problems', { n: badge(item) }) }}</span>
                <span aria-hidden="true">{{ badge(item) }}</span>
              </span>
              <span
                v-else-if="newCount(item) > 0"
                data-testid="nav-new"
                :class="[
                  'flex h-5 items-center justify-center rounded-full bg-warning/15 px-1.5 text-12 font-semibold whitespace-nowrap text-warning',
                  collapsed ? 'absolute -top-0.5 right-0.5 h-4 min-w-4 px-1' : 'ml-auto',
                ]"
              >
                <span class="sr-only">{{ $t('nav.newDestinations', { n: newCount(item) }) }}</span>
                <span aria-hidden="true">{{
                  collapsed ? newCount(item) : $t('nav.newShort', { n: newCount(item) })
                }}</span>
              </span>
              <span
                v-if="learningDay(item) > 0"
                data-testid="nav-learning"
                :class="[
                  'flex items-center gap-1.5 text-12 font-medium whitespace-nowrap text-text-muted',
                  collapsed ? 'absolute top-1 right-1' : 'ml-auto',
                ]"
              >
                <span class="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                <span class="sr-only">{{
                  $t('nav.learning', { day: learningDay(item), days: LEARNING_DAYS })
                }}</span>
                <span v-if="!collapsed" aria-hidden="true">{{
                  $t('nav.learningShort', { day: learningDay(item), days: LEARNING_DAYS })
                }}</span>
              </span>
              <span
                v-if="pro(item) && !collapsed"
                data-testid="nav-pro"
                class="ml-auto inline-flex h-5 shrink-0 items-center rounded-full border border-info/50 px-2 text-12 font-semibold text-info"
                >{{ $t('nav.pro') }}</span
              >
            </a>
          </RouterLink>
        </li>
      </ul>
    </nav>

    <!-- The footer (0.10.1, design/cloud Sidebar): Cloud's plan line, then the account button
         with its menu (account, tokens, billing, docs, sign out). Community has no plan row. -->
    <div
      v-if="auth.user"
      :class="['flex flex-col gap-2 p-3', collapsed ? 'items-center' : '']"
      data-testid="sidebar-footer"
    >
      <PlanLine v-if="auth.isCloud" :collapsed="collapsed" />
      <AccountMenu :collapsed="collapsed" :drawer="drawer" @sign-out="signOut" />
    </div>
  </aside>
</template>
