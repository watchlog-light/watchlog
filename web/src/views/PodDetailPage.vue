<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft, CircleAlert } from '@lucide/vue';
import type { KubePodDetail, MetricKey, RangeQueryResponse } from '@watchlog/api-types';
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';
import TimeSeriesChart, { type ChartSeries } from '@/components/charts/TimeSeriesChart.vue';
import EventList from '@/components/kube/EventList.vue';
import TonePill from '@/components/kube/TonePill.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useChangeMarkers } from '@/composables/useChangeMarkers';
import { useLoader } from '@/composables/useLoader';
import { useRangeQuery } from '@/composables/useRangeQuery';
import { podTone, type Tone } from '@/lib/kube';
import { rangeWindow, since } from '@/lib/time';
import { formatValue, type Unit } from '@/lib/units';
import { useKubeStore } from '@/stores/kube';
import { useUiStore } from '@/stores/ui';

// Pod detail (SPEC §4.3): containers with the last termination reason and exit code,
// usage per container against requests (dotted, ADR-056) and limits (dashed), events,
// and the workload's change markers on every chart (§4.6).
const REFRESH_MS = 30_000;
const { t } = useI18n();
const route = useRoute();
const kube = useKubeStore();
const { timeRange } = storeToRefs(useUiStore());
const namespace = computed(() => String(route.params.namespace));
const name = computed(() => String(route.params.name));
const clusterId = computed(() => kube.cluster?.id);
let timer: ReturnType<typeof setInterval> | undefined;

const page = useLoader(async () => {
  const cluster = await kube.ensure();
  if (!cluster) return null;
  return api<KubePodDetail>(
    `/clusters/${cluster.id}/pods/${encodeURIComponent(namespace.value)}/${encodeURIComponent(name.value)}`,
  ).catch((err: { status?: number }) => {
    if (err?.status === 404) return null;
    throw err;
  });
});
const detail = computed(() => page.data.value ?? null);
const pod = computed(() => detail.value?.pod);
const notFound = computed(() => page.loaded.value && !pod.value);
const containers = computed(() => (detail.value?.containers ?? []).filter((c) => !c.init));

const scope = computed(() => ({ namespace: namespace.value, pod: name.value }));
const CHARTS: {
  metric: MetricKey;
  titleKey: string;
  zeroKey?: string;
  requests?: 'cpu' | 'memory';
}[] = [
  { metric: 'pod.container.cpu.usage', titleKey: 'kube.pod.charts.cpu', requests: 'cpu' },
  {
    metric: 'pod.container.memory.working_set',
    titleKey: 'kube.pod.charts.memory',
    requests: 'memory',
  },
  {
    metric: 'pod.container.cpu.throttled',
    titleKey: 'kube.pod.charts.throttled',
    zeroKey: 'kube.pod.charts.noThrottling',
  },
  {
    metric: 'pod.network.bytes',
    titleKey: 'kube.pod.charts.network',
    zeroKey: 'docker.charts.noNetworkTraffic',
  },
];
const charts = CHARTS.map((c) => ({ ...c, q: useRangeQuery(clusterId, c.metric, scope) }));

// Markers of the owning workload; bare pods and Jobs have none of their own.
const markerFilter = computed(() => {
  const p = pod.value;
  if (!p?.workload || !['Deployment', 'StatefulSet', 'DaemonSet'].includes(p.workloadKind ?? ''))
    return null;
  return { target: `${p.workloadKind}/${p.namespace}/${p.workload}` };
});
const markers = useChangeMarkers(clusterId, markerFilter);

/** Usage per container, plus a flat request line and a dashed limit line per container. */
function chartSeries(c: (typeof charts)[number], data: RangeQueryResponse | null): ChartSeries[] {
  const out: ChartSeries[] = (data?.series ?? []).map((s) => ({
    name: s.labels.container ?? s.labels.dir ?? name.value,
    points: s.points,
  }));
  if (!c.requests || out.length === 0) return out;
  const [from, to] = rangeWindow(timeRange.value);
  for (const ct of containers.value) {
    const req = c.requests === 'cpu' ? ct.cpuRequestCores : ct.memoryRequestBytes;
    const lim = c.requests === 'cpu' ? ct.cpuLimitCores : ct.memoryLimitBytes;
    if (req)
      out.push({
        name: t('kube.pod.charts.request', { c: ct.name }),
        points: [
          [from, req],
          [to, req],
        ],
        dotted: true,
      });
    if (lim)
      out.push({
        name: t('kube.pod.charts.limit', { c: ct.name }),
        points: [
          [from, lim],
          [to, lim],
        ],
        dashed: true,
      });
  }
  return out;
}
function chartNote(c: (typeof charts)[number]): string | undefined {
  if (c.requests !== 'memory' || containers.value.length === 0) return undefined;
  return containers.value.every((x) => !x.memoryLimitBytes)
    ? t('kube.pod.charts.noMemoryLimit')
    : undefined;
}

const stateTone = (state: string, reason: string | null): Tone =>
  state === 'running'
    ? 'ok'
    : reason
      ? podTone(reason)
      : state === 'waiting'
        ? 'warning'
        : 'neutral';

watch([namespace, name], page.load);
onMounted(() => {
  void page.load();
  timer = setInterval(page.load, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="flex flex-col gap-6">
    <RouterLink
      :to="{
        name: 'workloads',
        query: { view: 'pods', ...($route.query.ns ? { ns: $route.query.ns } : {}) },
      }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('kube.pod.back') }}
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
      {{ $t('kube.pod.notFound') }}
    </p>

    <template v-if="pod && detail">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-20 font-semibold break-all text-text">{{ pod.name }}</h2>
          <p class="mt-1 text-13 text-text-muted" data-testid="pod-meta">
            {{ pod.namespace }}
            <template v-if="pod.workload && pod.workloadKind !== 'Pod'">
              · {{ pod.workloadKind }} {{ pod.workload }}</template
            >
            ·
            <RouterLink
              v-if="pod.node"
              :to="{ name: 'node', params: { name: pod.node } }"
              class="hover:underline"
              >{{ pod.node }}</RouterLink
            >
            · {{ pod.ip ?? '–' }} · {{ pod.qosClass ?? '–' }}
            <template v-if="pod.createdAt">
              · {{ $t('kube.nodes.age', { d: since(pod.createdAt) }) }}</template
            >
          </p>
        </div>
        <div class="flex items-center gap-2">
          <TonePill :tone="podTone(pod.status)" :label="pod.status" />
          <span class="font-mono text-13 text-text-muted tabular">
            {{
              $t('kube.pod.readyRestarts', {
                ready: `${pod.readyContainers}/${pod.totalContainers}`,
                n: pod.restarts,
              })
            }}
          </span>
          <LoadingIndicator :active="page.refreshing.value" />
        </div>
      </header>

      <div
        v-if="pod.lastTermination || detail.message"
        class="flex items-start gap-3 rounded-card border border-border bg-surface-1 px-4 py-3"
        data-testid="termination"
      >
        <CircleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div class="text-13">
          <p v-if="pod.lastTermination" class="text-text">
            {{
              $t('kube.pod.terminated', {
                container: pod.lastTermination.container,
                reason: pod.lastTermination.reason,
                code: pod.lastTermination.exitCode,
              })
            }}
            <span v-if="pod.lastTermination.finishedAt" class="text-text-muted">
              · {{ $t('kube.ago', { d: since(pod.lastTermination.finishedAt) }) }}
            </span>
          </p>
          <p v-if="pod.lastTermination?.reason === 'OOMKilled'" class="text-text-muted">
            {{ $t('kube.pod.oomHint') }}
          </p>
          <p
            v-else-if="pod.lastTermination?.exitCode === 137"
            class="text-text-muted"
            data-testid="sigkill-hint"
          >
            {{ $t('kube.pod.sigkillHint') }}
          </p>
          <p v-if="detail.message" class="text-text-muted">{{ detail.message }}</p>
        </div>
      </div>

      <section>
        <h3 class="mb-3 text-16 font-semibold text-text">{{ $t('kube.pod.containers') }}</h3>
        <div class="overflow-x-auto rounded-card border border-border bg-surface-1">
          <table class="w-full min-w-[900px] text-left text-13" data-testid="container-table">
            <thead class="bg-surface-2 text-12 text-text-muted">
              <tr>
                <th class="px-4 py-2 font-medium">{{ $t('kube.pod.columns.name') }}</th>
                <th class="px-4 py-2 font-medium">{{ $t('kube.pod.columns.state') }}</th>
                <th class="px-4 py-2 font-medium">{{ $t('kube.pod.columns.restarts') }}</th>
                <th class="px-4 py-2 text-right font-medium">{{ $t('kube.pods.columns.cpu') }}</th>
                <th class="px-4 py-2 text-right font-medium">
                  {{ $t('kube.pods.columns.memory') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in detail.containers"
                :key="`${c.init}/${c.name}`"
                class="border-t border-border align-top"
                data-testid="container-row"
              >
                <td class="max-w-96 px-4 py-2.5">
                  <span class="font-medium text-text">{{ c.name }}</span>
                  <span v-if="c.init" class="ml-1.5 text-12 text-text-subtle">{{
                    $t('kube.pod.init')
                  }}</span>
                  <p class="truncate font-mono text-12 text-text-muted">{{ c.image }}</p>
                </td>
                <td class="px-4 py-2.5">
                  <TonePill
                    :tone="stateTone(c.state, c.reason)"
                    :label="c.reason ?? $t(`kube.pod.states.${c.state}`)"
                  />
                  <p v-if="c.exitCode !== null" class="mt-1 text-12 text-text-muted">
                    {{ $t('kube.pod.exitCode', { code: c.exitCode }) }}
                  </p>
                  <p v-if="c.message" class="mt-1 max-w-80 text-12 break-words text-text-muted">
                    {{ c.message }}
                  </p>
                </td>
                <td class="px-4 py-2.5">
                  <span class="font-mono tabular">{{ c.restartCount }}</span>
                  <p
                    v-if="c.lastTermination"
                    class="text-12 text-text-muted"
                    data-testid="container-last-termination"
                  >
                    {{
                      $t('kube.pods.lastTermination', {
                        reason: c.lastTermination.reason,
                        code: c.lastTermination.exitCode,
                      })
                    }}
                    <template v-if="c.lastTermination.finishedAt">
                      · {{ $t('kube.ago', { d: since(c.lastTermination.finishedAt) }) }}</template
                    >
                  </p>
                </td>
                <td class="px-4 py-2.5 text-right font-mono tabular">
                  {{ formatValue(c.cpuCores, 'cores') }}
                  <p class="text-12 text-text-subtle">
                    {{
                      $t('kube.pods.reqLimit', {
                        req: formatValue(c.cpuRequestCores, 'cores'),
                        limit: formatValue(c.cpuLimitCores, 'cores'),
                      })
                    }}
                  </p>
                </td>
                <td class="px-4 py-2.5 text-right font-mono tabular">
                  {{ formatValue(c.memoryBytes, 'bytes') }}
                  <p class="text-12 text-text-subtle">
                    {{
                      $t('kube.pods.reqLimit', {
                        req: formatValue(c.memoryRequestBytes, 'bytes'),
                        limit: formatValue(c.memoryLimitBytes, 'bytes'),
                      })
                    }}
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <div v-if="!notFound" class="grid gap-4 lg:grid-cols-2">
      <TimeSeriesChart
        v-for="c in charts"
        :key="c.metric"
        :title="$t(c.titleKey)"
        :unit="(c.q.data.value?.unit ?? 'cores') as Unit"
        :series="chartSeries(c, c.q.data.value)"
        :markers="markers"
        :note="chartNote(c)"
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
    <section v-else-if="detail">
      <h3 class="mb-3 text-16 font-semibold text-text">{{ $t('kube.events.title') }}</h3>
      <EventList v-if="detail.events.length > 0" :events="detail.events" :show-object="false" />
      <p v-else class="text-13 text-text-muted">{{ $t('kube.events.none') }}</p>
    </section>
  </div>
</template>
