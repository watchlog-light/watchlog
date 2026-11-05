<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
import type { KubeNodeDetail, MetricKey } from '@watchlog/api-types';
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue';
import ConditionTimeline from '@/components/kube/ConditionTimeline.vue';
import EventList from '@/components/kube/EventList.vue';
import HeatLegend from '@/components/kube/HeatLegend.vue';
import KubeletTlsBadge from '@/components/kube/KubeletTlsBadge.vue';
import PodHeatmap, { type HeatPod } from '@/components/kube/PodHeatmap.vue';
import PodTable from '@/components/kube/PodTable.vue';
import StatTile from '@/components/kube/StatTile.vue';
import TonePill from '@/components/kube/TonePill.vue';
import UsageMeter from '@/components/kube/UsageMeter.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useChangeMarkers } from '@/composables/useChangeMarkers';
import { useLoader } from '@/composables/useLoader';
import { useRangeQuery } from '@/composables/useRangeQuery';
import { since } from '@/lib/time';
import { formatValue, type Unit } from '@/lib/units';
import { useKubeStore } from '@/stores/kube';

// Node detail (SPEC §4.2): usage charts, conditions timeline, pods on the node.
const { t } = useI18n();
const route = useRoute();
const name = computed(() => String(route.params.name));
const kube = useKubeStore();
const clusterId = computed(() => kube.cluster?.id);

const CHARTS: {
  metric: MetricKey;
  titleKey: string;
  series: (l: Record<string, string>) => string;
  zeroKey?: string;
}[] = [
  {
    metric: 'node.cpu.utilization',
    titleKey: 'docker.charts.cpu',
    series: () => t('docker.charts.cpu'),
  },
  {
    metric: 'node.memory.utilization',
    titleKey: 'docker.charts.memory',
    series: () => t('docker.charts.memory'),
  },
  { metric: 'node.load1', titleKey: 'docker.charts.load', series: () => 'load1' },
  {
    metric: 'node.network.bytes',
    titleKey: 'docker.charts.network',
    series: (l) => l.dir ?? '',
    zeroKey: 'docker.charts.noNetworkTraffic',
  },
  {
    metric: 'node.disk.io',
    titleKey: 'docker.charts.diskIo',
    series: (l) => l.dir ?? '',
    zeroKey: 'docker.charts.noDiskActivity',
  },
  {
    metric: 'node.filesystem.utilization',
    titleKey: 'docker.charts.filesystem',
    series: (l) => l.mount ?? '',
  },
];
const scope = computed(() => ({ node: name.value }));
const charts = CHARTS.map((c) => ({ ...c, q: useRangeQuery(clusterId, c.metric, scope) }));
// Node added or removed (SPEC §4.6).
const markers = useChangeMarkers(clusterId, () => ({ target: `Node/${name.value}` }));

const page = useLoader(async () => {
  const cluster = await kube.ensure();
  if (!cluster) return null;
  return api<KubeNodeDetail>(
    `/clusters/${cluster.id}/nodes/${encodeURIComponent(name.value)}`,
  ).catch((err: { status?: number }) => {
    if (err?.status === 404) return null;
    throw err;
  });
});
const detail = computed(() => page.data.value ?? null);
// The node's running pods as a heatmap, as on the Nodes page.
const heat = computed<HeatPod[]>(() =>
  (detail.value?.pods ?? [])
    .filter((p) => p.phase !== 'Succeeded' && p.phase !== 'Failed')
    .map((p) => ({
      namespace: p.namespace,
      name: p.name,
      cpu: p.cpuCores,
      cpuRequest: p.cpuRequestCores || null,
      cpuRatio: p.cpuCores !== null && p.cpuRequestCores ? p.cpuCores / p.cpuRequestCores : null,
      failing: p.failing,
    })),
);
const podLink = (p: HeatPod) => ({
  name: 'pod',
  params: { namespace: p.namespace ?? '', name: p.name },
});
const node = computed(() => detail.value?.node);
const notFound = computed(() => page.loaded.value && !node.value);
const tone = computed(() =>
  node.value?.status === 'Ready'
    ? 'ok'
    : node.value?.status === 'NotReady'
      ? 'critical'
      : 'warning',
);

watch(name, page.load);
onMounted(page.load);
</script>

<template>
  <div class="flex flex-col gap-6">
    <RouterLink
      :to="{ name: 'nodes', query: $route.query.ns ? { ns: $route.query.ns } : {} }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('kube.nodes.back') }}
    </RouterLink>
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('kube.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonDetailHeader
      v-else-if="page.pending.value"
      :class="{ invisible: !page.skeleton.value }"
      :label="$t('common.loading')"
    />
    <p v-if="notFound" class="text-14 text-text-muted" data-testid="not-found">
      {{ $t('kube.nodes.notFound') }}
    </p>

    <template v-if="node">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-20 font-semibold text-text">{{ node.name }}</h2>
          <p class="mt-1 text-13 text-text-muted" data-testid="node-meta">
            {{ node.roles.join(', ') || $t('kube.nodes.worker') }} ·
            {{ node.kubeletVersion ?? '–' }} · {{ node.osImage ?? '–' }} ·
            {{ $t('kube.nodes.kernel', { v: node.kernelVersion ?? '–' }) }} ·
            {{ node.containerRuntime ?? '–' }} · {{ node.internalIp ?? '–' }}
            <template v-if="node.createdAt">
              · {{ $t('kube.nodes.age', { d: since(node.createdAt) }) }}</template
            >
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <TonePill :tone="tone" :label="$t(`kube.nodes.status.${node.status}`)" />
          <TonePill v-if="node.unschedulable" tone="warning" :label="$t('kube.nodes.cordoned')" />
          <TonePill
            :tone="node.agent.status === 'active' ? 'ok' : 'neutral'"
            :label="$t(`kube.nodes.agent.${node.agent.status}`)"
          />
          <KubeletTlsBadge v-if="node.agent.kubeletTls === 'unverified'" align="end" />
          <LoadingIndicator :active="page.refreshing.value" />
        </div>
      </header>

      <dl class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div class="rounded-card border border-border bg-surface-1 px-4 py-3">
          <dt class="mb-1 text-12 text-text-subtle">{{ $t('kube.tiles.cpu') }}</dt>
          <dd>
            <UsageMeter
              :usage="node.cpu.usageCores"
              :requests="node.cpu.requestsCores"
              :allocatable="node.cpu.allocatableCores"
              unit="cores"
            />
          </dd>
        </div>
        <div class="rounded-card border border-border bg-surface-1 px-4 py-3">
          <dt class="mb-1 text-12 text-text-subtle">{{ $t('kube.tiles.memory') }}</dt>
          <dd>
            <UsageMeter
              :usage="node.memory.usageBytes"
              :requests="node.memory.requestsBytes"
              :allocatable="node.memory.allocatableBytes"
              unit="bytes"
            />
          </dd>
        </div>
        <StatTile
          :label="$t('kube.nodes.columns.disk')"
          :value="formatValue(node.diskUtilization, 'ratio')"
        />
        <StatTile
          :label="$t('kube.nodes.columns.pods')"
          :value="`${node.pods.count} / ${node.pods.capacity ?? '–'}`"
          :sub="$t('kube.nodes.podsCapacity')"
        />
      </dl>
    </template>

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
        :markers="markers"
        :loading="c.q.loading.value"
        :error="c.q.error.value"
        :empty-text="$t('docker.charts.empty')"
        :error-text="$t('docker.charts.error')"
        :zero-text="c.zeroKey ? $t(c.zeroKey) : undefined"
        @retry="c.q.refresh"
      />
    </div>
    <ConditionTimeline v-if="!notFound" :cluster-id="clusterId" :node="name" />

    <section v-if="page.skeleton.value">
      <Skeleton class="mb-3 w-28 text-16" />
      <SkeletonTable :label="$t('common.loading')" />
    </section>
    <template v-else-if="detail">
      <section>
        <h3 class="mb-3 text-16 font-semibold text-text">
          {{ $t('kube.nodes.podsOnNode', { n: detail.pods.length }, detail.pods.length) }}
        </h3>
        <div
          v-if="heat.length"
          class="mb-3 flex flex-col gap-2 rounded-[12px] border border-border bg-surface-1 p-3.5"
          data-testid="node-heatmap"
        >
          <p class="text-12 text-text-subtle">{{ $t('overview.heat.hint') }}</p>
          <PodHeatmap :pods="heat" :link="podLink" />
          <HeatLegend />
        </div>
        <PodTable v-if="detail.pods.length > 0" :pods="detail.pods" :show-node="false" />
        <p v-else class="text-13 text-text-muted">{{ $t('kube.nodes.noPods') }}</p>
      </section>
      <section>
        <h3 class="mb-3 text-16 font-semibold text-text">{{ $t('kube.events.title') }}</h3>
        <EventList v-if="detail.events.length > 0" :events="detail.events" :show-object="false" />
        <p v-else class="text-13 text-text-muted">{{ $t('kube.events.none') }}</p>
      </section>
    </template>
  </div>
</template>
