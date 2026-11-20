<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import CertsJobsCard from '@/components/applications/CertsJobsCard.vue';
import { ArrowLeft, CornerDownRight } from '@lucide/vue';
import type { MetricKey, ServerDetail, ServerWorkloadList } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue';
import TonePill from '@/components/kube/TonePill.vue';
import SourceChip from '@/components/servers/SourceChip.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { useRangeQuery } from '@/composables/useRangeQuery';
import { formatCores } from '@/lib/resources';
import {
  groupByUnit,
  portsText,
  shortKernel,
  shortOs,
  upDays,
  workloadLink,
  type Source,
} from '@/lib/servers';
import { formatBytes, type Unit } from '@/lib/units';
import { useFleetStore } from '@/stores/fleet';

// One server (ADR-207; the canvas "Server"): its facts, resources, every workload of the
// three sources grouped by unit, what happened and who it talks to.
const REFRESH_MS = 30_000;
const { t } = useI18n();
const route = useRoute();
const name = computed(() => String(route.params.server));
const fleetStore = useFleetStore();
const clusterId = computed(() => fleetStore.fleet?.id);

const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return undefined;
  const base = `/clusters/${f.id}/servers/${encodeURIComponent(name.value)}`;
  const [detail, w] = await Promise.all([
    api<ServerDetail>(base),
    api<ServerWorkloadList>(`${base}/workloads`),
  ]);
  return { detail, workloads: w.workloads };
});
const detail = computed(() => page.data.value?.detail);
const server = computed(() => detail.value?.server);
const workloads = computed(() => page.data.value?.workloads ?? []);
const notFound = computed(() => page.loaded.value && !page.data.value && !!page.error.value);

const filter = ref<'all' | Source>('all');
const showSystem = ref(false);
const systemCount = computed(() => workloads.value.filter((w) => w.system).length);
const rows = computed(() =>
  groupByUnit(
    filter.value === 'all'
      ? workloads.value
      : workloads.value.filter((w) => w.source === filter.value),
    showSystem.value,
  ),
);
const FILTERS = ['all', 'service', 'process', 'container'] as const;

const usage = computed(() => {
  const s = server.value;
  const u = detail.value?.usage;
  if (!s || !u) return [];
  const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)} %`);
  const bytes = (v: number | null) => (v == null ? '–' : formatBytes(v));
  return [
    {
      label: t('servers.usage.cpu'),
      value: pct(s.cpuUtilization),
      sub: t('servers.usage.cpuSub', {
        used: u.cpuCores == null ? '–' : formatCores(u.cpuCores),
        cores: s.cores ?? '–',
      }),
    },
    {
      label: t('servers.usage.memory'),
      value: pct(s.memoryUtilization),
      sub: t('servers.usage.ofSub', {
        used: bytes(u.memoryUsedBytes),
        total: bytes(s.memoryBytes),
      }),
    },
    {
      label: t('servers.usage.disk'),
      value: pct(s.diskUtilization),
      sub: t('servers.usage.ofSub', {
        used: bytes(u.diskUsedBytes),
        total: bytes(u.diskSizeBytes),
      }),
    },
    {
      label: t('servers.usage.network'),
      value:
        u.networkInBytes == null && u.networkOutBytes == null
          ? '–'
          : `${formatBytes((u.networkInBytes ?? 0) + (u.networkOutBytes ?? 0))}/s`,
      sub: t('servers.usage.netSub', {
        in: `${bytes(u.networkInBytes)}/s`,
        out: `${bytes(u.networkOutBytes)}/s`,
      }),
    },
  ];
});

const chips = computed(() => {
  const s = server.value;
  if (!s) return [];
  const up = upDays(s.bootTime);
  return [
    shortOs(s.os),
    s.kernel ? t('servers.chip.kernel', { v: shortKernel(s.kernel) }) : null,
    s.systemd ? t('servers.chip.systemd', { v: s.systemd }) : null,
    s.docker ? t('servers.chip.docker', { v: s.docker }) : null,
    s.cores
      ? t('servers.chip.cpus', {
          n: s.cores,
          mem: s.memoryBytes ? formatBytes(s.memoryBytes) : '–',
        })
      : null,
    up != null ? t('servers.chip.up', { n: up }) : null,
  ].filter((c): c is string => !!c);
});

const eventText = (e: ServerDetail['events'][number]) =>
  e.kind === 'event'
    ? t('servers.events.event', { name: e.text, reason: e.reason ?? '' })
    : t(`servers.events.${e.kind}`, { name: e.text, n: e.count }, e.count);
const eventClock = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const eventLink = (e: ServerDetail['events'][number]) =>
  e.alertId
    ? { name: 'alert', params: { id: e.alertId } }
    : e.workloadId
      ? { name: 'server-workload', params: { server: name.value, workload: e.workloadId } }
      : undefined;
const rate = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(v >= 1 ? 1 : 2));

// The host's charts over the selected range, as the 0.8 host page had them.
const CHARTS: {
  metric: MetricKey;
  titleKey: string;
  series: (l: Record<string, string>) => string;
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
  { metric: 'host.network.bytes', titleKey: 'docker.charts.network', series: (l) => l.dir ?? '' },
  {
    metric: 'host.filesystem.utilization',
    titleKey: 'docker.charts.filesystem',
    series: (l) => l.mount ?? '',
  },
];
const scope = computed(() => ({ host: name.value }));
const charts = CHARTS.map((c) => ({ ...c, q: useRangeQuery(clusterId, c.metric, scope) }));

const poll = usePolling(() => page.load(), REFRESH_MS);
onMounted(() => {
  void page.load();
  poll.start();
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <RouterLink
      :to="{ name: 'servers' }"
      class="inline-flex items-center gap-1.5 self-start text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('servers.back') }}
    </RouterLink>
    <ErrorState
      v-if="page.error.value && !notFound"
      :inline="page.loaded.value"
      :message="$t('servers.errors.load1')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonDetailHeader v-else-if="page.skeleton.value" :label="$t('common.loading')" />
    <p v-if="notFound" class="text-14 text-text-muted">{{ $t('servers.errors.notFound') }}</p>

    <header v-if="server" class="flex flex-col gap-3" data-testid="server-header">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-24 font-semibold text-text">{{ server.name }}</h2>
        <TonePill
          v-if="server.problemCount"
          :tone="server.problems[0]?.severity === 'critical' ? 'critical' : 'warning'"
          :label="$t('servers.attention', { n: server.problemCount }, server.problemCount)"
        />
        <LoadingIndicator :active="page.refreshing.value" />
      </div>
      <ul class="flex flex-wrap gap-2 font-mono text-12" data-testid="server-chips">
        <li
          v-for="c in chips"
          :key="c"
          class="rounded-control border border-border bg-surface-2 px-2 py-1 text-text"
        >
          {{ c }}
        </li>
        <li
          v-if="server.agentVersion"
          class="rounded-control border border-primary/40 bg-primary-soft px-2 py-1 text-primary"
        >
          {{ $t('servers.chip.agent', { v: server.agentVersion }) }}
        </li>
      </ul>
      <p
        v-if="!server.servicesAvailable"
        class="rounded-card border border-warning/40 bg-surface-1 px-4 py-3 text-13 text-text-muted"
        data-testid="old-agent"
      >
        {{ $t('servers.oldAgent') }}
      </p>
    </header>

    <dl v-if="usage.length" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div
        v-for="u in usage"
        :key="u.label"
        class="flex flex-col gap-1 rounded-card border border-border bg-surface-1 px-4 py-3"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-x-2">
          <dt class="text-11 tracking-[0.08em] text-text-muted uppercase">{{ u.label }}</dt>
          <dd class="text-20 font-semibold whitespace-nowrap text-text tabular max-lg:text-16">
            {{ u.value }}
          </dd>
        </div>
        <dd class="text-12 text-text-subtle">{{ u.sub }}</dd>
      </div>
    </dl>

    <SkeletonTable v-if="page.skeleton.value" :label="$t('common.loading')" />
    <section
      v-else-if="server"
      class="overflow-hidden rounded-card border border-border bg-surface-1"
      data-testid="server-workloads"
    >
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"
      >
        <h3 class="text-16 font-semibold text-text">
          {{ $t('servers.workloadsOn', { server: server.name }) }}
        </h3>
        <div class="flex flex-wrap gap-1" role="group">
          <button
            v-for="f in FILTERS"
            :key="f"
            type="button"
            class="rounded-control px-2.5 py-1 text-12 max-lg:min-h-11"
            :class="filter === f ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'"
            :aria-pressed="filter === f"
            @click="filter = f"
          >
            {{ $t(`servers.filter.${f}`) }}
          </button>
        </div>
      </div>
      <div class="overflow-x-auto max-lg:hidden">
        <table class="w-full min-w-[760px] text-left text-13">
          <thead class="text-11 tracking-[0.08em] text-text-muted uppercase">
            <tr>
              <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.workload') }}</th>
              <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.kind') }}</th>
              <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.state') }}</th>
              <th class="px-4 py-2.5 text-right font-normal">{{ $t('servers.columns.cpu') }}</th>
              <th class="px-4 py-2.5 text-right font-normal">{{ $t('servers.columns.memory') }}</th>
              <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.listens') }}</th>
              <th class="px-4 py-2.5 text-right font-normal">
                {{ $t('servers.columns.restarts') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.w.id"
              class="border-t border-border"
              :class="r.w.problem ? 'bg-critical/5' : ''"
              data-testid="workload-row"
            >
              <td class="px-4 py-2.5">
                <span class="inline-flex items-center gap-1.5" :class="r.child ? 'pl-4' : ''">
                  <CornerDownRight
                    v-if="r.child"
                    class="size-3.5 text-text-subtle"
                    aria-hidden="true"
                  />
                  <RouterLink
                    :to="workloadLink(server.name, r.w)"
                    class="font-mono text-text hover:underline"
                    >{{ r.w.name }}</RouterLink
                  >
                  <span v-if="r.w.note" class="text-12 text-text-subtle">
                    {{
                      r.w.note.startsWith('compose:')
                        ? r.w.note.replace('compose:', 'compose: ')
                        : $t(`servers.by.${r.w.note}`)
                    }}
                  </span>
                </span>
              </td>
              <td class="px-4 py-2.5">
                <SourceChip :source="r.w.source" :label="$t(`servers.source.${r.w.source}`)" />
              </td>
              <td class="px-4 py-2.5">
                <TonePill
                  v-if="r.w.problem"
                  :tone="r.w.problem.severity"
                  :label="
                    $t(`servers.problem.${r.w.problem.kind}`) +
                    (r.w.problem.code != null
                      ? ` · ${$t('servers.exitCode', { code: r.w.problem.code })}`
                      : '')
                  "
                />
                <span v-else class="text-text-muted">{{
                  r.w.source === 'process'
                    ? $t('servers.instances', { n: r.w.instances ?? 0 }, r.w.instances ?? 0)
                    : r.w.state
                }}</span>
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
                {{ r.w.cpuCores == null ? '–' : formatCores(r.w.cpuCores) }}
              </td>
              <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
                {{ r.w.memoryBytes == null ? '–' : formatBytes(r.w.memoryBytes) }}
              </td>
              <td class="px-4 py-2.5 font-mono text-12 text-text-muted">
                {{ portsText(r.w.ports) }}
              </td>
              <td
                class="px-4 py-2.5 text-right font-mono text-12 tabular"
                :class="(r.w.restarts24h ?? 0) >= 3 ? 'text-warning' : 'text-text-muted'"
              >
                {{ r.w.restarts24h == null ? '–' : Math.round(r.w.restarts24h) }}
              </td>
            </tr>
            <tr v-if="rows.length === 0">
              <td colspan="7" class="px-4 py-4 text-13 text-text-muted">
                {{ $t('servers.noWorkloads') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- Phones: one line a workload, its unit's groups indented under it. -->
      <ul class="divide-y divide-border lg:hidden" data-testid="workload-cards">
        <li
          v-for="r in rows"
          :key="r.w.id"
          class="flex flex-col gap-1.5 px-4 py-3"
          :class="[r.child ? 'pl-8' : '', r.w.problem ? 'bg-critical/5' : '']"
        >
          <div class="flex items-center justify-between gap-2">
            <RouterLink
              :to="workloadLink(server.name, r.w)"
              class="min-h-11 content-center truncate font-mono text-13 text-text hover:underline"
              >{{ r.w.name }}</RouterLink
            >
            <SourceChip :source="r.w.source" :label="$t(`servers.source.${r.w.source}`)" />
          </div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-text-muted">
            <TonePill
              v-if="r.w.problem"
              :tone="r.w.problem.severity"
              :label="$t(`servers.problem.${r.w.problem.kind}`)"
            />
            <span v-else>{{
              r.w.source === 'process'
                ? $t('servers.instances', { n: r.w.instances ?? 0 }, r.w.instances ?? 0)
                : r.w.state
            }}</span>
            <span class="font-mono tabular">{{
              r.w.cpuCores == null ? '–' : formatCores(r.w.cpuCores)
            }}</span>
            <span class="font-mono tabular">{{
              r.w.memoryBytes == null ? '–' : formatBytes(r.w.memoryBytes)
            }}</span>
            <span v-if="r.w.ports.length" class="font-mono">{{ portsText(r.w.ports) }}</span>
          </div>
        </li>
      </ul>
      <div v-if="systemCount" class="border-t border-border px-4 py-3">
        <button
          type="button"
          class="rounded-control border border-border px-3 py-1.5 text-12 text-text-muted hover:text-text max-lg:min-h-11"
          data-testid="toggle-system"
          @click="showSystem = !showSystem"
        >
          {{ showSystem ? $t('servers.hideSystem') : $t('servers.system', { n: systemCount }) }}
        </button>
      </div>
    </section>

    <!-- This server's certificates and scheduled jobs (0.10). -->
    <CertsJobsCard v-if="detail && clusterId" :cluster-id="clusterId" :node="name" />

    <div v-if="detail" class="grid gap-4 lg:grid-cols-2">
      <section
        class="rounded-card border border-border bg-surface-1 px-5 py-4"
        data-testid="server-events"
      >
        <h3 class="mb-3 text-16 font-semibold text-text">{{ $t('servers.events.title') }}</h3>
        <ul v-if="detail.events.length" class="flex flex-col gap-2 text-13">
          <li
            v-for="(e, i) in detail.events"
            :key="i"
            class="flex min-w-0 flex-wrap items-baseline gap-x-2"
            data-testid="server-event"
          >
            <span v-if="e.at" class="font-mono text-12 text-text-subtle">{{
              eventClock(e.at)
            }}</span>
            <RouterLink
              v-if="eventLink(e)"
              :to="eventLink(e)!"
              class="hover:underline"
              :class="e.type === 'Warning' ? 'text-warning' : 'text-text'"
            >
              {{ eventText(e) }}
            </RouterLink>
            <span v-else class="text-text">{{ eventText(e) }}</span>
            <span v-if="e.message" class="min-w-0 text-text-muted">{{ e.message }}</span>
            <span
              v-if="e.kind === 'event' && e.count > 1"
              class="font-mono text-12 text-text-subtle"
              >×{{ e.count }}</span
            >
          </li>
        </ul>
        <p v-else class="text-13 text-text-muted">
          {{ $t(detail.eventsStored ? 'servers.events.emptyStored' : 'servers.events.empty') }}
        </p>
        <p
          v-if="!detail.eventsStored"
          class="mt-3 text-12 text-text-subtle"
          data-testid="server-events-old-agent"
        >
          {{ $t('servers.events.oldAgent') }}
        </p>
        <RouterLink
          v-else
          :to="{ name: 'events', query: { host: name, type: 'all' } }"
          class="mt-3 inline-block text-12 text-primary hover:underline max-lg:min-h-11"
          data-testid="server-events-link"
          >{{ $t('servers.events.all') }}</RouterLink
        >
      </section>
      <section
        class="rounded-card border border-border bg-surface-1 px-5 py-4"
        data-testid="server-talks"
      >
        <h3 class="text-16 font-semibold text-text">{{ $t('servers.talksTo.title') }}</h3>
        <p class="mb-3 text-12 text-text-muted">{{ $t('servers.talksTo.hint') }}</p>
        <ul v-if="detail.talksTo.length" class="flex flex-col gap-1.5">
          <li
            v-for="(e, i) in detail.talksTo"
            :key="i"
            class="flex items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2 font-mono text-12"
          >
            <span class="truncate text-text"
              >{{ e.from }} → {{ e.to }}{{ e.port ? `:${e.port}` : '' }}</span
            >
            <span class="flex shrink-0 gap-2 tabular">
              <span class="text-text-muted">{{
                $t('servers.talksTo.rate', { v: rate(e.rate) })
              }}</span>
              <span :class="e.failed > 0 ? 'text-critical' : 'text-ok'">{{
                e.failed > 0
                  ? $t('servers.talksTo.failed', { v: rate(e.failed) })
                  : $t('servers.talksTo.ok')
              }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-13 text-text-muted">{{ $t('servers.talksTo.empty') }}</p>
      </section>
    </div>

    <div v-if="server" class="grid gap-4 lg:grid-cols-2">
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
        @retry="c.q.refresh"
      />
    </div>
  </div>
</template>
