<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
import type { DockerContainerList, DockerHostList, MetricKey } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue';
import ContainerList from '@/components/docker/ContainerList.vue';
import HeatLegend from '@/components/kube/HeatLegend.vue';
import PodHeatmap, { type HeatPod } from '@/components/kube/PodHeatmap.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import StatusPill from '@/components/ui/StatusPill.vue';
import { useLoader } from '@/composables/useLoader';
import { containerRows } from '@/lib/containers';
import { useRangeQuery } from '@/composables/useRangeQuery';
import type { Unit } from '@/lib/units';
import { useDockerScopeStore } from '@/stores/dockerScope';
import { useFleetStore } from '@/stores/fleet';

const { t } = useI18n();
const route = useRoute();
const hostName = computed(() => String(route.params.host));
const fleetStore = useFleetStore();
const clusterId = computed(() => fleetStore.fleet?.id);

const CHARTS: {
  metric: MetricKey;
  titleKey: string;
  series: (l: Record<string, string>) => string;
  zeroKey?: string;
}[] = [
  {
    metric: 'host.cpu.utilization',
    titleKey: 'docker.charts.cpu',
    series: () => t('docker.charts.cpu'),
  },
  {
    metric: 'host.memory.utilization',
    titleKey: 'docker.charts.memory',
    series: () => t('docker.charts.memory'),
  },
  { metric: 'host.load1', titleKey: 'docker.charts.load', series: () => 'load1' },
  {
    metric: 'host.network.bytes',
    titleKey: 'docker.charts.network',
    series: (l) => l.dir ?? '',
    zeroKey: 'docker.charts.noNetworkTraffic',
  },
  {
    metric: 'host.disk.io',
    titleKey: 'docker.charts.diskIo',
    series: (l) => l.dir ?? '',
    zeroKey: 'docker.charts.noDiskActivity',
  },
  {
    metric: 'host.filesystem.utilization',
    titleKey: 'docker.charts.filesystem',
    series: (l) => l.mount ?? '',
  },
];
const scope = computed(() => ({ host: hostName.value }));
const charts = CHARTS.map((c) => ({ ...c, q: useRangeQuery(clusterId, c.metric, scope) }));

const dockerScope = useDockerScopeStore();
const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return { host: undefined, containers: [] };
  const [h, c] = await Promise.all([
    api<DockerHostList>(`/clusters/${f.id}/docker/hosts?heat=1`),
    api<DockerContainerList>(
      `/clusters/${f.id}/docker/containers?host=${encodeURIComponent(hostName.value)}`,
    ),
  ]);
  dockerScope.hosts = h.hosts.map((x) => x.name);
  dockerScope.projects = [
    ...new Set(c.containers.map((x) => x.composeProject).filter((p): p is string => !!p)),
  ];
  return { host: h.hosts.find((x) => x.name === hostName.value), containers: c.containers };
});
const host = computed(() => page.data.value?.host);
const allContainers = computed(() => page.data.value?.containers ?? []);
// The top bar's Compose project filter (?project=) applies to this host's containers.
const project = computed(() =>
  typeof route.query.project === 'string' ? route.query.project : '',
);
const containers = computed(() =>
  containerRows(
    project.value
      ? allContainers.value.filter((c) => c.composeProject === project.value)
      : allContainers.value,
  ),
);
// The host's containers as a heatmap, as on the Hosts page.
const heatLink = (c: HeatPod) => ({
  name: 'docker-container',
  params: { host: hostName.value, name: c.name },
});
const notFound = computed(() => page.loaded.value && !host.value);

onMounted(page.load);
</script>

<template>
  <div class="flex flex-col gap-6">
    <RouterLink
      :to="{ name: 'hosts' }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('docker.back') }}
    </RouterLink>
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('docker.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <!-- Reserved (invisible) from the first moment: the charts below are already shown. -->
    <SkeletonDetailHeader
      v-else-if="page.pending.value"
      :class="{ invisible: !page.skeleton.value }"
      :label="$t('common.loading')"
    />
    <p v-if="notFound" class="text-14 text-text-muted">{{ $t('docker.errors.hostNotFound') }}</p>
    <header v-if="host" class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-20 font-semibold text-text">{{ host.name }}</h2>
        <p class="mt-1 text-13 text-text-muted">
          {{
            $t('docker.hostMeta', {
              docker: host.dockerVersion ?? '–',
              kernel: host.kernelVersion ?? '–',
            })
          }}
          · {{ host.os }}/{{ host.arch }} ·
          {{ $t('docker.agent', { version: host.agentVersion ?? '–' }) }}
        </p>
      </div>
      <StatusPill :status="host.status" />
    </header>

    <div v-if="!notFound" class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      <TimeSeriesChart
        v-for="c in charts"
        :key="c.metric"
        :title="$t(c.titleKey)"
        :unit="(c.q.data.value?.unit ?? 'ratio') as Unit"
        :series="
          (c.q.data.value?.series ?? []).map((s) => ({
            name: c.series(s.labels),
            points: s.points,
          }))
        "
        :loading="c.q.loading.value"
        :error="c.q.error.value"
        :empty-text="$t('docker.charts.empty')"
        :error-text="$t('docker.charts.error')"
        :zero-text="c.zeroKey ? $t(c.zeroKey) : undefined"
        @retry="c.q.refresh"
      />
    </div>

    <section v-if="page.skeleton.value">
      <Skeleton class="mb-3 w-28 text-16" />
      <SkeletonTable :label="$t('common.loading')" />
    </section>
    <section v-else-if="containers.length > 0">
      <div class="mb-3 flex items-center gap-2">
        <h3 class="text-16 font-semibold text-text">{{ $t('docker.containersTitle') }}</h3>
        <LoadingIndicator :active="page.refreshing.value" />
      </div>
      <div
        v-if="host?.heat?.length"
        class="mb-3 flex flex-col gap-2 rounded-[12px] border border-border bg-surface-1 p-3.5"
        data-testid="host-heatmap"
      >
        <p class="text-12 text-text-subtle">{{ $t('docker.hosts.heatHint') }}</p>
        <PodHeatmap :pods="host.heat" :link="heatLink" docker />
        <HeatLegend docker />
      </div>
      <ContainerList :containers="containers" :range="3600" :show-host="false" />
    </section>
  </div>
</template>
