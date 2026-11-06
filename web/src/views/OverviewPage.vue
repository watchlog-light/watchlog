<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Hourglass, LayoutDashboard } from '@lucide/vue';
import type { Cluster, KubeOverview } from '@watchlog/api-types';
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useClustersStore } from '@/stores/clusters';
import IngestFailureBanner from '@/components/clusters/IngestFailureBanner.vue';
import AttentionCard from '@/components/overview/AttentionCard.vue';
import KpiRow from '@/components/overview/KpiRow.vue';
import OverviewCard from '@/components/overview/OverviewCard.vue';
import PodsByNode from '@/components/overview/PodsByNode.vue';
import RecentChanges from '@/components/overview/RecentChanges.vue';
import StatusStrip from '@/components/overview/StatusStrip.vue';
import TopWorkloads from '@/components/overview/TopWorkloads.vue';
import WarningEvents from '@/components/overview/WarningEvents.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonStatTile from '@/components/ui/SkeletonStatTile.vue';
import { useLoader } from '@/composables/useLoader';
import { useNamespaceFilter, withQuery } from '@/composables/useNamespaceFilter';
import { RANGE_SECONDS } from '@/lib/time';
import { useUiStore } from '@/stores/ui';

// The overview (SPEC §4.1, ADR-110): "is anything wrong
// right now?" in five seconds. One API call for the page, refreshed every 15 s without
// skeletons.
const clusters = useClustersStore();
const REFRESH_MS = 15_000;
// ECharts loads with the resources card, after the rest of the page is shown.
const ResourcesCard = defineAsyncComponent(() => import('@/components/overview/ResourcesCard.vue'));
const ns = useNamespaceFilter();
const ui = useUiStore();
let timer: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

// null: no cluster or fleet exists yet. A Kubernetes cluster first, else a Docker fleet.
const page = useLoader(async () => {
  // The selected cluster or fleet (the switcher's; it never changes by itself).
  const cluster: Cluster | null = await clusters.ensure();
  if (!cluster) return null;
  const range = Math.max(300, RANGE_SECONDS[ui.timeRange]);
  const overview = await api<KubeOverview>(
    withQuery(
      `/clusters/${cluster.id}/overview?range=${range}`,
      cluster.kind === 'kubernetes' ? ns.query.value : '',
    ),
  );
  return { cluster, overview, at: Date.now() };
});
const o = computed(() => page.data.value?.overview ?? null);
const loading = computed(() => page.skeleton.value);
// Created but nothing has reported yet: point to the install command.
const waiting = computed(
  () =>
    !!o.value &&
    o.value.facts.nodes === 0 &&
    o.value.kpis.pods.total === 0 &&
    o.value.facts.agents.reporting === 0,
);

const now = ref(Date.now());
const ago = computed(() => {
  const at = page.data.value?.at;
  return at ? Math.max(0, Math.round((now.value - at) / 1000)) : null;
});
watch([ns.query, () => ui.timeRange], () => void page.load());
// Another cluster chosen in the switcher (not the first selection while loading).
watch(
  () => clusters.selectedId,
  (id, old) => {
    if (old && id !== old) void page.load();
  },
);
onMounted(() => {
  void page.load();
  timer = setInterval(() => {
    void page.load();
  }, REFRESH_MS);
  clock = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  clearInterval(clock);
});
</script>

<template>
  <div class="overview flex flex-col gap-4">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('kube.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />

    <!-- First load: a skeleton per card, in the page's layout. -->
    <div
      v-if="loading"
      class="flex flex-col gap-4"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="overview-skeleton"
    >
      <Skeleton class="h-8 w-80" />
      <Skeleton class="h-14 w-full rounded-[12px]" />
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div
          v-for="i in 6"
          :key="i"
          class="rounded-[12px] border border-border bg-surface-1 px-4 py-3"
        >
          <SkeletonStatTile />
        </div>
      </div>
      <div class="g1">
        <OverviewCard :title="$t('overview.resources.title')" loading />
        <OverviewCard :title="$t('overview.attention.title')" loading />
      </div>
    </div>

    <EmptyState
      v-else-if="page.loaded.value && !page.data.value"
      :icon="LayoutDashboard"
      :title="$t('empty.overview.title')"
      :description="$t('empty.overview.description')"
      :action-label="$t('empty.connectCluster')"
      action-to="/settings"
    />
    <EmptyState
      v-else-if="waiting"
      :icon="Hourglass"
      :title="$t('kube.waiting.title')"
      :description="$t('kube.waiting.description')"
      :action-label="$t('kube.waiting.action')"
      :action-to="`/settings/clusters/${page.data.value?.cluster.id}`"
    />

    <template v-else-if="o && page.data.value">
      <IngestFailureBanner v-if="o.cluster.ingestFailure" :failure="o.cluster.ingestFailure" />
      <!-- Header: cluster name, facts, live -->
      <div class="flex flex-wrap items-center gap-x-3.5 gap-y-2" data-testid="overview-header">
        <h2 class="text-22 font-semibold text-text">{{ page.data.value.cluster.name }}</h2>
        <ul class="flex flex-wrap gap-x-3.5 gap-y-1 text-13 text-text-muted" data-testid="facts">
          <li v-if="o.facts.dockerVersions.length" data-testid="docker-versions">
            {{ $t('overview.facts.docker', { v: o.facts.dockerVersions.join(', ') }) }}
          </li>
          <li v-if="o.facts.kubernetesVersion">
            {{
              $t('overview.facts.kubernetes', { v: o.facts.kubernetesVersion.replace(/^v/, '') })
            }}
          </li>
          <li>
            {{
              $t(
                o.kind === 'docker' ? 'overview.facts.hosts' : 'overview.facts.nodes',
                { n: o.facts.nodes },
                o.facts.nodes,
              )
            }}
          </li>
          <li
            class="fact"
            :class="o.facts.agents.reporting === o.facts.agents.expected ? 'on' : 'off'"
          >
            {{
              $t('overview.facts.agents', {
                n: o.facts.agents.reporting,
                of: o.facts.agents.expected,
              })
            }}
          </li>
          <li
            class="fact"
            :class="o.facts.ebpf === 'on' ? 'on' : o.facts.ebpf === 'partial' ? 'part' : 'off'"
          >
            {{ $t(`overview.facts.ebpf.${o.facts.ebpf}`) }}
          </li>
          <li class="fact" :class="o.facts.alertingRunning ? 'on' : 'off'">
            {{
              $t(o.facts.alertingRunning ? 'overview.facts.alerting' : 'overview.facts.noAlerting')
            }}
          </li>
        </ul>
        <span class="flex-1" />
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2.5 py-0.5 text-12 text-text-muted"
          role="status"
          data-testid="live"
        >
          <i class="live-dot" aria-hidden="true" />
          {{
            ago === null || ago < 2 ? $t('overview.live.now') : $t('overview.live.ago', { s: ago })
          }}
        </span>
      </div>

      <StatusStrip :overview="o" />
      <KpiRow :overview="o" />

      <div class="g1">
        <ResourcesCard :overview="o" />
        <AttentionCard :overview="o" />
      </div>

      <div class="g2">
        <TopWorkloads :overview="o" />
        <RecentChanges :overview="o" />
      </div>

      <div class="g1">
        <WarningEvents :overview="o" />
        <PodsByNode :overview="o" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Rows follow the page's own width (container queries), not the window's. */
.overview {
  container-type: inline-size;
}
.g1 {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
}
.g2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: stretch;
}
@container (max-width: 1080px) {
  .g1 {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container (max-width: 640px) {
  .g2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
.text-22 {
  font-size: 22px;
}
.fact {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.fact::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.fact.on::before {
  background: var(--ok);
}
.fact.part::before {
  background: var(--warning);
}
.fact.off::before {
  background: var(--text-subtle);
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent);
  }
  70% {
    box-shadow: 0 0 0 7px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .live-dot {
    animation: none;
  }
}
</style>
