<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronDown, Container, Layers, Menu, Network, X } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from 'reka-ui';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import DockerScopeFilter from '@/components/docker/DockerScopeFilter.vue';
import NamespaceFilter from '@/components/kube/NamespaceFilter.vue';
import { useCompact, useNarrow } from '@/composables/useNarrow';
import { useClustersStore } from '@/stores/clusters';
import { useUiStore } from '@/stores/ui';
import ClusterSwitcher from './ClusterSwitcher.vue';
import TimeRangePicker from './TimeRangePicker.vue';

defineProps<{ title: string }>();

const ui = useUiStore();
const { timeRange, navOpen } = storeToRefs(ui);
const route = useRoute();
const clusters = useClustersStore();
const { t } = useI18n();
// Below 1024 px the sidebar is a drawer and the cluster switcher moves up here; below
// 768 px the cluster, the filters and the time range move into one sheet.
const compact = useCompact();
const narrow = useNarrow();
// A Docker fleet has hosts and Compose projects, not namespaces.
const DOCKER_PAGES = new Set([
  'overview',
  'hosts',
  'containers',
  'events',
  'docker-host',
  'docker-container',
]);
// Pages that show Kubernetes data take the namespace filter (SPEC §4.3).
const KUBE_PAGES = new Set(['overview', 'nodes', 'node', 'workloads', 'pod', 'events']);
const page = computed(() => String(route.name ?? ''));
const onDocker = computed(
  () => clusters.selected?.kind === 'docker' && DOCKER_PAGES.has(page.value),
);
const onKube = computed(() => clusters.selected?.kind !== 'docker' && KUBE_PAGES.has(page.value));

const sheetOpen = ref(false);
// Choosing a cluster or a host navigates; the sheet closes with it.
watch(
  () => route.path,
  () => (sheetOpen.value = false),
);
const KIND_ICON = { docker: Container, kubernetes: Network } as const;
const clusterIcon = computed(() =>
  clusters.selected ? KIND_ICON[clusters.selected.kind] : Layers,
);
const summary = computed(() =>
  [
    clusters.selected?.name ?? t('clusterSwitcher.none'),
    route.meta.charts ? t(`topBar.ranges.${timeRange.value}`) : null,
  ]
    .filter(Boolean)
    .join(' · '),
);
</script>

<template>
  <header
    class="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg px-4 py-2 max-md:gap-x-2 md:px-6"
  >
    <button
      v-if="compact"
      type="button"
      data-testid="nav-open"
      :aria-label="$t('nav.open')"
      :aria-expanded="navOpen"
      class="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text"
      @click="navOpen = true"
    >
      <Menu class="size-5" aria-hidden="true" />
    </button>
    <h1 class="min-w-0 flex-1 truncate text-16 font-semibold text-text">{{ title }}</h1>

    <template v-if="!narrow">
      <ClusterSwitcher v-if="compact" :collapsed="false" class="w-52" />
      <DockerScopeFilter v-if="onDocker" />
      <NamespaceFilter v-else-if="onKube" />
      <TimeRangePicker v-if="route.meta.charts" />
    </template>

    <!-- Phones: one button with the cluster and the range, opening a sheet. -->
    <DialogRoot v-else v-model:open="sheetOpen">
      <DialogTrigger
        data-testid="filters-open"
        :aria-label="$t('topBar.filtersFor', { summary })"
        class="flex h-11 max-w-[55%] min-w-0 items-center gap-1.5 rounded-control border border-border bg-surface-1 px-2.5 text-13 text-text hover:bg-surface-2"
      >
        <component
          :is="clusterIcon"
          class="size-3.5 shrink-0 text-text-subtle"
          aria-hidden="true"
        />
        <span class="truncate">{{ summary }}</span>
        <ChevronDown class="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
      </DialogTrigger>
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-40 bg-bg/60" />
        <DialogContent
          class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-card border-t border-border-strong bg-surface-1 shadow-xl"
          data-testid="filter-sheet"
        >
          <header class="flex items-center gap-2 border-b border-border py-1 pr-1 pl-4">
            <DialogTitle class="flex-1 text-16 font-semibold text-text">
              {{ $t('topBar.filters') }}
            </DialogTitle>
            <DialogClose
              class="flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text"
              :aria-label="$t('common.close')"
            >
              <X class="size-5" aria-hidden="true" />
            </DialogClose>
          </header>
          <DialogDescription class="sr-only">{{ summary }}</DialogDescription>
          <div class="flex flex-col gap-4 overflow-y-auto p-4">
            <div class="flex flex-col gap-1.5">
              <span class="text-13 font-medium text-text">{{ $t('clusterSwitcher.label') }}</span>
              <ClusterSwitcher :collapsed="false" />
            </div>
            <div v-if="onDocker || onKube" class="flex flex-col gap-1.5">
              <span class="text-13 font-medium text-text">{{
                onDocker ? $t('docker.scope.host') : $t('topBar.namespace')
              }}</span>
              <DockerScopeFilter v-if="onDocker" />
              <NamespaceFilter v-else />
            </div>
            <div v-if="route.meta.charts" class="flex flex-col gap-1.5">
              <span class="text-13 font-medium text-text">{{ $t('topBar.timeRange') }}</span>
              <TimeRangePicker sheet />
            </div>
          </div>
          <div class="border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <DialogClose
              class="flex h-11 w-full items-center justify-center rounded-control bg-primary text-14 font-semibold text-on-primary hover:bg-primary-hover"
            >
              {{ $t('topBar.done') }}
            </DialogClose>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </header>
</template>
