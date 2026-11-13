<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue';
import type { DockerContainerList, RangeQueryResponse } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';
import TimeSeriesChart, { type ChartSeries } from '@/components/charts/TimeSeriesChart.vue';
import CausePanel from '@/components/causes/CausePanel.vue';
import ContainerDiagnosis from '@/components/docker/ContainerDiagnosis.vue';
import ContainerStatePill from '@/components/docker/ContainerStatePill.vue';
import LogsPanel from '@/components/logs/LogsPanel.vue';
import RightSizingPanel from '@/components/rightsizing/RightSizingPanel.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { useLoader } from '@/composables/useLoader';
import { useRangeQuery } from '@/composables/useRangeQuery';
import { cpuShare, reasonLine } from '@/lib/diagnosis';
import { since } from '@/lib/time';
import { formatValue } from '@/lib/units';
import { useFleetStore } from '@/stores/fleet';

const { t } = useI18n();
const route = useRoute();
const hostName = computed(() => String(route.params.host));
const name = computed(() => String(route.params.name));
const fleetStore = useFleetStore();
const clusterId = computed(() => fleetStore.fleet?.id);

const scope = computed(() => ({ host: hostName.value, container: name.value }));
const cpu = useRangeQuery(clusterId, 'container.cpu.usage', scope);
const cpuLimit = useRangeQuery(clusterId, 'container.cpu.limit', scope);
const memory = useRangeQuery(clusterId, 'container.memory.working_set', scope);
const memoryLimit = useRangeQuery(clusterId, 'container.memory.limit', scope);
const network = useRangeQuery(clusterId, 'container.network.bytes', scope);
const io = useRangeQuery(clusterId, 'container.fs.io', scope);

function named(
  data: RangeQueryResponse | null,
  label: (l: Record<string, string>) => string,
): ChartSeries[] {
  return (data?.series ?? []).map((s) => ({ name: label(s.labels), points: s.points }));
}
// CPU as % of the limit when one is set, otherwise % of one core; the limit is 100%.
const cpuChart = computed(() => {
  const usage = cpu.data.value?.series[0]?.points ?? [];
  const share = cpuShare(usage, cpuLimit.data.value?.series[0]?.points);
  const series: ChartSeries[] = usage.length
    ? [{ name: t('docker.charts.usage'), points: share.points }]
    : [];
  if (share.limitCores !== null && usage.length)
    series.push({
      name: t('docker.charts.limit'),
      points: usage.map(([ts]) => [ts!, 1]),
      dashed: true,
    });
  return {
    series,
    title:
      share.limitCores !== null
        ? t('docker.charts.cpuOfLimit', { limit: Number(share.limitCores.toFixed(2)) })
        : t('docker.charts.cpuOfCore'),
  };
});
const memorySeries = computed(() => [
  ...named(memory.data.value, () => t('docker.charts.workingSet')),
  ...named(memoryLimit.data.value, () => t('docker.charts.limit')).map((s) => ({
    ...s,
    dashed: true,
  })),
]);
// Only a container with memory data can be said to have no limit (an exited one has neither).
const memoryNote = computed(() =>
  (memory.data.value?.series.length ?? 0) > 0 && memoryLimit.data.value?.series.length === 0
    ? t('docker.charts.noMemoryLimit')
    : undefined,
);
const reason = computed(() => (container.value ? reasonLine(container.value, t) : null));

const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return undefined;
  const res = await api<DockerContainerList>(
    `/clusters/${f.id}/docker/containers?host=${encodeURIComponent(hostName.value)}`,
  );
  return res.containers.find((c) => c.name === name.value);
});
const container = computed(() => page.data.value);
const notFound = computed(() => page.loaded.value && !container.value);

onMounted(page.load);
</script>

<template>
  <div class="flex flex-col gap-6">
    <RouterLink
      :to="{ name: 'docker-host', params: { host: hostName } }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ hostName }}
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
      :facts="6"
      :class="{ invisible: !page.skeleton.value }"
      :label="$t('common.loading')"
    />
    <p v-if="notFound" class="text-14 text-text-muted">
      {{ $t('docker.errors.containerNotFound') }}
    </p>

    <header v-if="container" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-20 font-semibold text-text">{{ container.name }}</h2>
        <ContainerStatePill :state="container.state" :health="container.health" :reason="reason" />
      </div>
      <dl
        class="grid grid-cols-2 gap-x-6 gap-y-2 text-13 md:grid-cols-4"
        data-testid="container-facts"
      >
        <div>
          <dt class="text-12 text-text-subtle">{{ $t('docker.facts.image') }}</dt>
          <dd class="truncate font-mono text-text">{{ container.image }}</dd>
        </div>
        <div>
          <dt class="text-12 text-text-subtle">{{ $t('docker.facts.uptime') }}</dt>
          <dd class="text-text">{{ container.startedAt ? since(container.startedAt) : '–' }}</dd>
        </div>
        <div>
          <dt class="text-12 text-text-subtle">{{ $t('docker.columns.restarts') }}</dt>
          <dd class="font-mono text-text tabular">
            {{ container.restartCount }}
            <span v-if="container.oomKilled" class="ml-1 text-critical">{{
              $t('docker.facts.oom')
            }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-12 text-text-subtle">{{ $t('docker.facts.compose') }}</dt>
          <dd class="text-text">
            <RouterLink
              v-if="container.composeProject && container.composeService"
              :to="{
                name: 'containers',
                query: { project: container.composeProject, service: container.composeService },
              }"
              class="hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
              data-testid="compose-service-link"
              >{{ container.composeProject }} / {{ container.composeService }}</RouterLink
            >
            <template v-else>{{ container.composeProject ?? '–' }}</template>
          </dd>
        </div>
        <div v-if="container.ports.length > 0">
          <dt class="text-12 text-text-subtle">{{ $t('docker.columns.ports') }}</dt>
          <dd class="font-mono text-text">
            <span v-for="p in container.ports" :key="p.publicPort" class="mr-2">
              {{ p.publicPort }}→{{ p.privatePort }}/{{ p.protocol }}
            </span>
          </dd>
        </div>
        <div v-if="container.sizeRw !== null">
          <dt class="text-12 text-text-subtle">{{ $t('docker.facts.writableLayer') }}</dt>
          <dd class="font-mono text-text">{{ formatValue(container.sizeRw, 'bytes') }}</dd>
        </div>
      </dl>
    </header>
    <ContainerDiagnosis v-if="container" :container="container" />
    <!-- The probable cause (ADR-148, ADR-149); nothing on a healthy container. -->
    <CausePanel
      v-if="container && clusterId"
      :cluster-id="clusterId"
      :subject="`container:${hostName}/${name}`"
      :name="name"
      quiet
    />
    <!-- Its limits and reservation against 7 days of use (ADR-168). -->
    <RightSizingPanel
      v-if="container && clusterId"
      :key="`rs-${hostName}/${name}`"
      :cluster-id="clusterId"
      :query="{ host: hostName, container: name, system: 'true' }"
      :name="name"
    />

    <div v-if="!notFound" class="grid gap-4 lg:grid-cols-2">
      <TimeSeriesChart
        :title="cpuChart.title"
        unit="ratio"
        :series="cpuChart.series"
        :loading="cpu.loading.value"
        :error="cpu.error.value"
        :empty-text="$t('docker.charts.empty')"
        :error-text="$t('docker.charts.error')"
        @retry="
          cpu.refresh();
          cpuLimit.refresh();
        "
      />
      <TimeSeriesChart
        :title="$t('docker.charts.memory')"
        unit="bytes"
        :series="memorySeries"
        :note="memoryNote"
        :loading="memory.loading.value"
        :error="memory.error.value"
        :empty-text="$t('docker.charts.empty')"
        :error-text="$t('docker.charts.error')"
        @retry="
          memory.refresh();
          memoryLimit.refresh();
        "
      />
      <TimeSeriesChart
        :title="$t('docker.charts.network')"
        unit="bytes_per_second"
        :series="named(network.data.value, (l) => l.dir ?? '')"
        :zero-text="$t('docker.charts.noNetworkTraffic')"
        :loading="network.loading.value"
        :error="network.error.value"
        :empty-text="$t('docker.charts.empty')"
        :error-text="$t('docker.charts.error')"
        @retry="network.refresh"
      />
      <TimeSeriesChart
        :title="$t('docker.charts.diskIo')"
        unit="bytes_per_second"
        :series="named(io.data.value, (l) => l.dir ?? '')"
        :zero-text="$t('docker.charts.noDiskActivity')"
        :loading="io.loading.value"
        :error="io.error.value"
        :empty-text="$t('docker.charts.empty')"
        :error-text="$t('docker.charts.error')"
        @retry="io.refresh"
      />
    </div>

    <!-- Logs on demand (ADR-167): read only when asked, never stored. -->
    <LogsPanel
      v-if="container && clusterId"
      :key="`${hostName}/${name}`"
      kind="container"
      :cluster-id="clusterId"
      :host="hostName"
      :name="name"
    />
  </div>
</template>
