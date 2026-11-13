<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';
import { LogOut, PanelLeftClose, PanelLeftOpen, X } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navFor, type NavItem } from '@/router';
import { useApplicationsStore } from '@/stores/applications';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useUiStore } from '@/stores/ui';
import ClusterSwitcher from './ClusterSwitcher.vue';
import PlanStrip from '@/components/plan/PlanStrip.vue';

// `drawer`: below 1024 px the shell shows the sidebar as an off-canvas drawer, full width
// with 44 px rows; the cluster switcher is in the top bar there.
const props = defineProps<{ drawer?: boolean }>();
const ui = useUiStore();
const { sidebarCollapsed } = storeToRefs(ui);
const collapsed = computed(() => !props.drawer && sidebarCollapsed.value);
const auth = useAuthStore();
const clusters = useClustersStore();
// The pages of the selected cluster's kind (Hosts and Containers for a Docker fleet).
const items = computed(() =>
  navFor(clusters.selected?.kind as 'kubernetes' | 'docker' | undefined),
);
const router = useRouter();
const route = useRoute();
// Applications shows how many monitored services have a problem (SPEC §4.12).
const applications = useApplicationsStore();
const badge = (item: NavItem) => (item.name === 'applications' ? applications.problems : 0);

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
    <div class="flex h-14 items-center gap-2.5 px-4">
      <img :src="logoUrl" alt="" class="size-8 shrink-0" />
      <span v-if="!collapsed" class="text-16 font-semibold tracking-tight text-text">
        {{ $t('app.name') }}
      </span>
      <button
        v-if="drawer"
        type="button"
        data-testid="nav-close"
        :aria-label="$t('nav.close')"
        class="-mr-2 ml-auto flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text"
        @click="ui.navOpen = false"
      >
        <X class="size-5" aria-hidden="true" />
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
              :title="collapsed ? $t(item.titleKey) : undefined"
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
            </a>
          </RouterLink>
        </li>
      </ul>
    </nav>

    <!-- Cloud: the plan strip (ADR-177, Dashboard.dc.html). -->
    <div v-if="auth.isCloud && !collapsed" class="px-3 pb-3">
      <PlanStrip />
    </div>

    <div v-if="auth.user" class="border-t border-border p-3" :aria-label="$t('account.menuLabel')">
      <div class="flex items-center gap-2.5 px-1">
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-13 font-semibold text-text"
          aria-hidden="true"
        >
          {{ auth.user.name.charAt(0).toUpperCase() }}
        </span>
        <div v-if="!collapsed" class="min-w-0 flex-1">
          <p class="truncate text-13 font-medium text-text">{{ auth.user.name }}</p>
          <p class="truncate text-12 text-text-muted">{{ auth.user.email }}</p>
        </div>
      </div>
      <button
        type="button"
        data-testid="sign-out"
        :aria-label="$t('account.signOut')"
        :title="collapsed ? $t('account.signOut') : undefined"
        :class="[
          'mt-2 flex w-full items-center gap-3 rounded-control px-2.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text',
          drawer ? 'h-11' : 'h-9',
        ]"
        @click="signOut"
      >
        <LogOut class="size-4.5 shrink-0" aria-hidden="true" />
        <span v-if="!collapsed" class="text-13">{{ $t('account.signOut') }}</span>
      </button>
    </div>

    <div v-if="!drawer" class="border-t border-border p-3">
      <button
        type="button"
        data-testid="sidebar-toggle"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? $t('nav.expand') : $t('nav.collapse')"
        :title="collapsed ? $t('nav.expand') : $t('nav.collapse')"
        class="flex h-9 w-full items-center gap-3 rounded-control px-2.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        @click="ui.toggleSidebar()"
      >
        <PanelLeftOpen v-if="collapsed" class="size-4.5 shrink-0" aria-hidden="true" />
        <PanelLeftClose v-else class="size-4.5 shrink-0" aria-hidden="true" />
        <span v-if="!collapsed" class="text-13">{{ $t('nav.collapse') }}</span>
      </button>
    </div>
  </aside>
</template>
