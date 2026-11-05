<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Clock } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import DockerScopeFilter from '@/components/docker/DockerScopeFilter.vue';
import NamespaceFilter from '@/components/kube/NamespaceFilter.vue';
import { useClustersStore } from '@/stores/clusters';
import { TIME_RANGES, useUiStore } from '@/stores/ui';

defineProps<{ title: string }>();

const { timeRange } = storeToRefs(useUiStore());
const route = useRoute();
const clusters = useClustersStore();
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
</script>

<template>
  <header
    class="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg px-4 py-2 md:px-6"
  >
    <h1 class="min-w-0 flex-1 truncate text-16 font-semibold text-text">{{ title }}</h1>

    <DockerScopeFilter v-if="onDocker" />
    <NamespaceFilter v-else-if="onKube" />

    <div
      v-if="route.meta.charts"
      role="group"
      :aria-label="$t('topBar.timeRange')"
      class="flex h-8 items-center rounded-control border border-border bg-surface-1 p-0.5"
    >
      <Clock class="mx-2 size-3.5 text-text-subtle" aria-hidden="true" />
      <button
        v-for="range in TIME_RANGES"
        :key="range"
        type="button"
        :aria-pressed="timeRange === range"
        :class="[
          'h-full rounded-[4px] px-2.5 font-mono text-12 tabular transition-colors',
          timeRange === range
            ? 'bg-surface-3 text-text'
            : 'text-text-muted hover:bg-surface-2 hover:text-text',
        ]"
        @click="timeRange = range"
      >
        {{ $t(`topBar.ranges.${range}`) }}
      </button>
    </div>
  </header>
</template>
