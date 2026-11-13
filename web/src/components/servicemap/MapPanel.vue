<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight, X } from '@lucide/vue';
import type {
  ServiceMap,
  ServiceMapEdge,
  ServiceMapEdgeSeries,
  ServiceMapNode,
} from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { api } from '@/api/client';
import CausePanel from '@/components/causes/CausePanel.vue';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue';
import TonePill from '@/components/kube/TonePill.vue';
import { useLoader } from '@/composables/useLoader';
import { formatDateTime } from '@/lib/format';
import { HEALTH_TONE, edgeReason, latency, perSecond } from '@/lib/servicemap';
import { isExternal, throughput, type Summary } from '@/lib/servicemap-model';
import { RANGE_SECONDS } from '@/lib/time';
import { formatValue } from '@/lib/units';
import { useUiStore } from '@/stores/ui';
import PanelSection from './PanelSection.vue';
import type { Selection } from './ServiceMapCanvas.vue';

// The right column of the service map: with nothing selected, the traffic summary and
// what needs attention; a node, who calls it and whom it calls; an edge, its health in
// words, the related alert, its numbers and its series.
const props = defineProps<{
  clusterId: string;
  selection: Selection;
  nodes: Map<string, ServiceMapNode>;
  /** Edges in scope (filters for namespaces, WatchLog and externals applied). */
  edges: ServiceMapEdge[];
  summary: Summary;
  scope: string;
  /** Proxies with their own metrics (Traefik, ADR-165): entrypoints on their node. */
  proxies?: ServiceMap['proxies'];
}>();
const emit = defineEmits<{ select: [sel: Selection] }>();
const { t } = useI18n();
const ui = useUiStore();

const node = computed(() =>
  props.selection?.type === 'node' ? (props.nodes.get(props.selection.id) ?? null) : null,
);
const edge = computed(() =>
  props.selection?.type === 'edge'
    ? (props.edges.find((e) => e.id === props.selection!.id) ?? null)
    : null,
);
const name = (id: string) => props.nodes.get(id)?.name ?? id;
const SYMBOL: Record<string, string> = {
  critical: '✕',
  warning: '▲',
  ok: '✓',
  idle: '○',
  unknown: '○',
};

const incoming = computed(() =>
  node.value ? props.edges.filter((e) => e.target === node.value!.id) : [],
);
const outgoing = computed(() =>
  node.value ? props.edges.filter((e) => e.source === node.value!.id) : [],
);
const sum = (list: ServiceMapEdge[]) => list.reduce((s, e) => s + e.connectionsPerSecond, 0);
const nodeHealth = computed(() => {
  const all = [...incoming.value, ...outgoing.value];
  if (all.some((e) => e.health === 'critical')) return 'critical';
  if (all.some((e) => e.health === 'warning')) return 'warning';
  return all.some((e) => e.health === 'ok') ? 'ok' : 'idle';
});
// A Traefik node: requests per entrypoint, TLS included (ADR-165).
const proxy = computed(() =>
  node.value ? ((props.proxies ?? []).find((p) => p.node === node.value!.id) ?? null) : null,
);
const workloadLink = computed(() => {
  const n = node.value;
  if (!n || n.kind !== 'workload') return null;
  return {
    name: 'workloads',
    query: { view: 'pods', wkind: n.workloadKind, wname: n.name, wns: n.namespace },
  };
});

function rowText(e: ServiceMapEdge): string {
  if ((e.answeredByProxy?.perSecond ?? 0) > 0)
    return t('serviceMap.proxy.answeredShort', { rate: perSecond(e.answeredByProxy!.perSecond) });
  if (e.health === 'critical' || e.health === 'warning')
    return (e.failedRatio ?? 0) >= 0.01
      ? t('serviceMap.edge.failed', { pct: formatValue(e.failedRatio, 'ratio') })
      : (e.http?.serverErrorRatio ?? 0) >= 0.01
        ? t('serviceMap.edge.errors', { pct: formatValue(e.http!.serverErrorRatio, 'ratio') })
        : t('serviceMap.edge.slow', { p95: latency(e.latencyP95Seconds) });
  if (e.health === 'idle' || e.health === 'unknown') return t(`serviceMap.health.${e.health}`);
  return e.connectionsPerSecond > 0
    ? perSecond(e.connectionsPerSecond)
    : formatValue(throughput(e), 'bytes_per_second');
}

// The selected edge's series and context.
const series = useLoader(async () => {
  const e = edge.value;
  if (!e) return null;
  const q = new URLSearchParams({
    source: e.source,
    target: e.target,
    range: String(Math.max(300, RANGE_SECONDS[ui.timeRange])),
  });
  if (e.port !== null) q.set('port', String(e.port));
  return api<ServiceMapEdgeSeries>(`/clusters/${props.clusterId}/service-map/edge?${q.toString()}`);
});
// Reload on a different edge or range, not on every 15 s refresh of the same edge.
watch(
  () => [edge.value?.id, ui.timeRange],
  () => void series.load(),
  { immediate: true },
);
const pts = (
  k:
    | 'connections'
    | 'failed'
    | 'latencyP95'
    | 'httpRequests'
    | 'http4xx'
    | 'http5xx'
    | 'httpP50'
    | 'httpP95',
) => (series.data.value?.[k] ?? []) as (number | null)[][];
// HTTP on this edge (ADR-139): requests and errors, and latency, when any was seen.
const httpTraffic = computed(() => [
  { name: t('serviceMap.charts.requests'), points: pts('httpRequests'), colorToken: '--ok' },
  { name: t('serviceMap.charts.clientErrors'), points: pts('http4xx'), colorToken: '--warning' },
  { name: t('serviceMap.charts.serverErrors'), points: pts('http5xx'), colorToken: '--critical' },
]);
const httpLatency = computed(() => [
  { name: 'p50', points: pts('httpP50'), colorToken: '--info' },
  { name: 'p95', points: pts('httpP95'), colorToken: '--warning' },
]);
const traffic = computed(() => [
  { name: t('serviceMap.charts.connections'), points: pts('connections'), colorToken: '--ok' },
  { name: t('serviceMap.charts.failed'), points: pts('failed'), colorToken: '--critical' },
]);
const slow = computed(() => [{ name: 'p95', points: pts('latencyP95'), colorToken: '--info' }]);
const time = (iso: string) => formatDateTime(iso);
const reason = computed(() =>
  edge.value
    ? edgeReason(edge.value, name(edge.value.target), series.data.value?.context ?? null, t, time)
    : null,
);
const alert = computed(() => series.data.value?.context.alert ?? null);

// The panel's sections: open is the first with something in it (an edge's HTTP, else its
// Connections; a node's callers, else whom it calls), again for each selection. The
// 15 s refresh leaves what the user opened or closed alone.
type SectionKey = 'http' | 'connections' | 'latency' | 'calledBy' | 'calls';
const open = ref<Record<SectionKey, boolean>>({
  http: false,
  connections: false,
  latency: false,
  calledBy: false,
  calls: false,
});
watch(
  () => (props.selection ? `${props.selection.type}:${props.selection.id}` : ''),
  () => {
    // Traefik's numbers have no series on this edge: its HTTP charts are eBPF's only.
    const http = !!edge.value?.http && edge.value.httpSource !== 'traefik';
    const callers = incoming.value.length > 0;
    open.value = {
      http,
      connections: !http,
      latency: false,
      calledBy: callers || !outgoing.value.length,
      calls: !callers && outgoing.value.length > 0,
    };
  },
  { immediate: true },
);
</script>

<template>
  <aside
    class="flex min-h-[200px] flex-col gap-3.5 rounded-card border border-border bg-surface-1 p-3.5 *:shrink-0 lg:max-h-full lg:overflow-y-auto lg:overscroll-contain"
    aria-live="polite"
    data-testid="map-panel"
  >
    <!-- Nothing selected: the traffic now. -->
    <template v-if="!node && !edge">
      <div>
        <h2 class="text-15 font-semibold text-text">{{ $t('serviceMap.panel.now') }}</h2>
        <p class="text-12 text-text-muted">{{ scope }}</p>
      </div>
      <dl class="grid grid-cols-2 gap-2">
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.connections') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{ perSecond(summary.connectionsPerSecond) }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.failed') }}</dt>
          <dd
            class="font-mono text-16 tabular-nums"
            :class="(summary.failedRatio ?? 0) >= 0.01 ? 'text-critical' : 'text-text'"
          >
            {{ formatValue(summary.failedRatio, 'ratio') }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.active') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ summary.active }}</dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.externals') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ summary.externals }}</dd>
        </div>
      </dl>
      <section data-testid="panel-attention">
        <h3 class="mb-1 text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t('serviceMap.panel.attention', { n: summary.attention.length }) }}
        </h3>
        <p v-if="!summary.attention.length" class="px-1.5 text-13 text-text-muted">
          {{ $t('serviceMap.panel.allHealthy') }}
        </p>
        <button
          v-for="e in summary.attention.slice(0, 8)"
          :key="e.id"
          type="button"
          class="lrow"
          @click="emit('select', { type: 'edge', id: e.id })"
        >
          <span class="dot" :class="`bg-${e.health}`" aria-hidden="true" />
          <span class="truncate text-13 text-text"
            >{{ name(e.source) }} → {{ name(e.target) }}</span
          >
          <span class="font-mono text-12 whitespace-nowrap text-text-muted"
            >{{ SYMBOL[e.health] }} {{ rowText(e) }}</span
          >
        </button>
      </section>
      <section>
        <h3 class="mb-1 text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t('serviceMap.panel.busiest') }}
        </h3>
        <button
          v-for="e in summary.busiest"
          :key="e.id"
          type="button"
          class="lrow"
          @click="emit('select', { type: 'edge', id: e.id })"
        >
          <span class="dot" :class="`bg-${e.health}`" aria-hidden="true" />
          <span class="truncate text-13 text-text"
            >{{ name(e.source) }} → {{ name(e.target) }}</span
          >
          <span class="font-mono text-12 whitespace-nowrap text-text-muted">{{ rowText(e) }}</span>
        </button>
      </section>
    </template>

    <!-- A node: who calls it and whom it calls. -->
    <template v-else-if="node">
      <header class="flex items-start gap-2">
        <div class="min-w-0">
          <h2 class="text-15 font-semibold break-words text-text">{{ node.name }}</h2>
          <p class="text-12 text-text-muted">
            {{
              isExternal(node)
                ? $t('serviceMap.panel.externalService')
                : [node.workloadKind, node.namespace].filter(Boolean).join(' · ')
            }}
          </p>
        </div>
        <button
          type="button"
          class="close"
          :aria-label="$t('common.close')"
          @click="emit('select', null)"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </header>
      <div>
        <TonePill
          :tone="HEALTH_TONE[nodeHealth] ?? 'neutral'"
          :label="$t(`serviceMap.health.${nodeHealth}`)"
        />
      </div>
      <dl class="grid grid-cols-2 gap-2">
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.incoming') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ perSecond(sum(incoming)) }}</dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.outgoing') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ perSecond(sum(outgoing)) }}</dd>
        </div>
      </dl>
      <section v-if="proxy" class="flex flex-col gap-1" data-testid="node-entrypoints">
        <h3 class="text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t('serviceMap.proxy.entrypoints') }}
        </h3>
        <p v-if="proxy.answeredPerSecond > 0" class="text-13 text-critical">
          {{ $t('serviceMap.proxy.answered', { rate: perSecond(proxy.answeredPerSecond) }) }}
        </p>
        <p v-if="!proxy.entrypoints.length" class="px-1.5 text-13 text-text-muted">
          {{ $t('serviceMap.proxy.noEntrypoints') }}
        </p>
        <table v-else class="w-full text-13">
          <thead>
            <tr class="text-left text-12 text-text-muted">
              <th class="py-1 font-normal">{{ $t('serviceMap.proxy.entrypoint') }}</th>
              <th class="py-1 text-right font-normal">{{ $t('serviceMap.proxy.requests') }}</th>
              <th class="py-1 text-right font-normal">{{ $t('serviceMap.proxy.errors') }}</th>
              <th class="py-1 text-right font-normal">{{ $t('serviceMap.proxy.tls') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ep in proxy.entrypoints" :key="ep.name" class="border-t border-border">
              <td class="py-1 text-text">{{ ep.name }}</td>
              <td class="py-1 text-right font-mono tabular-nums text-text">
                {{ perSecond(ep.requestsPerSecond) }}
              </td>
              <td
                class="py-1 text-right font-mono tabular-nums"
                :class="ep.serverErrorsPerSecond > 0 ? 'text-critical' : 'text-text'"
              >
                {{ perSecond(ep.serverErrorsPerSecond) }}
              </td>
              <td class="py-1 text-right font-mono tabular-nums text-text">
                {{ perSecond(ep.tlsRequestsPerSecond) }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <div class="flex flex-col">
        <PanelSection
          v-for="[key, list, dir] in [
            ['calledBy', incoming, 'in'],
            ['calls', outgoing, 'out'],
          ] as const"
          :key="key"
          v-model:open="open[key]"
          :title="$t(`serviceMap.panel.${key}`, { n: list.length })"
          :testid="`panel-${key}`"
        >
          <p v-if="!list.length" class="px-1.5 text-13 text-text-muted">
            {{ $t(`serviceMap.panel.${key}None`) }}
          </p>
          <div v-else>
            <button
              v-for="e in list"
              :key="e.id"
              type="button"
              class="lrow"
              @click="emit('select', { type: 'edge', id: e.id })"
            >
              <span class="dot" :class="`bg-${e.health}`" aria-hidden="true" />
              <span class="truncate text-13 text-text"
                >{{ name(dir === 'in' ? e.source : e.target)
                }}<span v-if="e.port" class="text-text-subtle">:{{ e.port }}</span></span
              >
              <span class="font-mono text-12 whitespace-nowrap text-text-muted"
                >{{ SYMBOL[e.health] }} {{ rowText(e) }}</span
              >
            </button>
          </div>
        </PanelSection>
      </div>
      <RouterLink v-if="workloadLink" :to="workloadLink" class="link">
        {{
          $t('serviceMap.panel.openWorkload', {
            kind: node.workloadKind,
            name: `${node.namespace}/${node.name}`,
          })
        }}
        <ArrowRight class="size-3.5" aria-hidden="true" />
      </RouterLink>
    </template>

    <!-- An edge: health in words, the alert, numbers and series. -->
    <template v-else-if="edge">
      <header class="flex items-start gap-2">
        <div class="min-w-0">
          <h2 class="text-15 font-semibold break-words text-text">
            {{ name(edge.source) }} → {{ name(edge.target)
            }}<span v-if="edge.port" class="text-text-subtle">:{{ edge.port }}</span>
          </h2>
          <p class="text-12 text-text-muted">
            {{
              [
                nodes.get(edge.source)?.namespace,
                nodes.get(edge.target)?.namespace ?? $t('serviceMap.panel.external'),
              ]
                .filter(Boolean)
                .join(' → ')
            }}
            <template v-if="edge.service">
              · {{ $t('serviceMap.edge.via', { service: edge.service }) }}</template
            >
          </p>
        </div>
        <button
          type="button"
          class="close"
          :aria-label="$t('common.close')"
          @click="emit('select', null)"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </header>
      <div>
        <TonePill
          :tone="HEALTH_TONE[edge.health] ?? 'neutral'"
          :label="$t(`serviceMap.health.${edge.health}`)"
        />
      </div>
      <div
        v-if="reason"
        class="why"
        :class="edge.health === 'critical' ? 'border-critical' : 'border-warning'"
        data-testid="edge-reason"
      >
        <p class="font-semibold text-text">{{ reason.lead }}</p>
        <p v-if="edge.answeredByProxy?.shared" data-testid="edge-answered-shared">
          {{ $t('serviceMap.proxy.shared') }}
        </p>
        <p v-if="reason.detail">{{ reason.detail }}</p>
        <RouterLink
          v-if="alert"
          :to="`/alerts/${alert.id}`"
          class="link mt-1"
          data-testid="edge-alert"
        >
          {{ $t('serviceMap.reason.alert', { time: time(alert.since) }) }}
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </RouterLink>
      </div>
      <!-- The numbers, then the probable cause, then the charts in sections. -->
      <dl class="grid grid-cols-2 gap-2" data-testid="edge-numbers">
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.connections') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{ perSecond(edge.connectionsPerSecond) }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.failed') }}</dt>
          <dd
            class="font-mono text-16 tabular-nums"
            :class="(edge.failedRatio ?? 0) >= 0.01 ? 'text-critical' : 'text-text'"
          >
            {{ formatValue(edge.failedRatio, 'ratio') }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.columns.p95') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{ latency(edge.latencyP95Seconds) }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.columns.bytes') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{
              edge.bytesSentPerSecond === null
                ? '–'
                : formatValue(throughput(edge), 'bytes_per_second')
            }}
          </dd>
        </div>
      </dl>
      <div v-if="edge.http" class="flex flex-col gap-2" data-testid="edge-http">
        <h3 class="text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t('serviceMap.http.title') }}
          <span
            v-if="edge.httpSource === 'traefik'"
            class="ml-1 normal-case tracking-normal text-text-muted"
            data-testid="edge-http-source"
            >· {{ $t('serviceMap.proxy.fromTraefik') }}</span
          >
        </h3>
        <dl class="grid grid-cols-2 gap-2">
          <div class="rounded-control bg-surface-2 px-2.5 py-2">
            <dt class="text-12 text-text-muted">{{ $t('serviceMap.http.requests') }}</dt>
            <dd class="font-mono text-16 tabular-nums text-text">
              {{ formatValue(edge.http.requestsPerSecond, 'per_second') }}
            </dd>
          </div>
          <div class="rounded-control bg-surface-2 px-2.5 py-2">
            <dt class="text-12 text-text-muted">{{ $t('serviceMap.http.errors') }}</dt>
            <dd
              class="font-mono text-16 tabular-nums"
              :class="(edge.http.serverErrorRatio ?? 0) >= 0.01 ? 'text-critical' : 'text-text'"
              data-testid="edge-http-5xx"
            >
              {{ formatValue(edge.http.serverErrorRatio, 'ratio') }}
            </dd>
          </div>
          <div class="rounded-control bg-surface-2 px-2.5 py-2">
            <dt class="text-12 text-text-muted">{{ $t('serviceMap.http.clientErrors') }}</dt>
            <dd class="font-mono text-16 tabular-nums text-text">
              {{ formatValue(edge.http.clientErrorsPerSecond, 'per_second') }}
            </dd>
          </div>
          <div class="rounded-control bg-surface-2 px-2.5 py-2">
            <dt class="text-12 text-text-muted">{{ $t('serviceMap.http.latency') }}</dt>
            <dd class="font-mono text-14 tabular-nums text-text">
              {{ latency(edge.http.p50Seconds) }} · {{ latency(edge.http.p95Seconds) }} ·
              {{ latency(edge.http.p99Seconds) }}
            </dd>
          </div>
        </dl>
      </div>
      <!-- A failing or slow edge's probable cause, compact (ADR-148). -->
      <CausePanel
        v-if="edge.health === 'critical' || edge.health === 'warning' || reason"
        :key="edge.id"
        :cluster-id="clusterId"
        :subject="`edge:${edge.id}`"
        :name="`${name(edge.source)} → ${name(edge.target)}`"
        compact
      />
      <div class="flex flex-col">
        <PanelSection
          v-if="edge.http && edge.httpSource !== 'traefik'"
          v-model:open="open.http"
          :title="$t('serviceMap.sections.http')"
          testid="section-http"
        >
          <p class="text-12 text-text-subtle">{{ $t('serviceMap.http.note') }}</p>
          <TimeSeriesChart
            :title="$t('serviceMap.charts.httpRequests')"
            unit="per_second"
            :series="httpTraffic"
            :loading="series.loading.value && !series.data.value"
            :error="!!series.error.value"
            :empty-text="$t('serviceMap.charts.empty')"
            :error-text="$t('serviceMap.charts.error')"
            @retry="series.load"
          />
          <TimeSeriesChart
            :title="$t('serviceMap.charts.httpLatency')"
            unit="seconds"
            :series="httpLatency"
            :loading="series.loading.value && !series.data.value"
            :error="!!series.error.value"
            :empty-text="$t('serviceMap.charts.empty')"
            :error-text="$t('serviceMap.charts.error')"
            @retry="series.load"
          />
        </PanelSection>
        <PanelSection
          v-model:open="open.connections"
          :title="$t('serviceMap.sections.connections')"
          testid="section-connections"
        >
          <TimeSeriesChart
            :title="$t('serviceMap.charts.traffic')"
            unit="per_second"
            :series="traffic"
            :loading="series.loading.value && !series.data.value"
            :error="!!series.error.value"
            :empty-text="$t('serviceMap.charts.empty')"
            :error-text="$t('serviceMap.charts.error')"
            @retry="series.load"
          />
        </PanelSection>
        <PanelSection
          v-model:open="open.latency"
          :title="$t('serviceMap.sections.latency')"
          testid="section-latency"
        >
          <TimeSeriesChart
            :title="$t('serviceMap.charts.latency')"
            unit="seconds"
            :series="slow"
            :loading="series.loading.value && !series.data.value"
            :error="!!series.error.value"
            :empty-text="$t('serviceMap.charts.empty')"
            :error-text="$t('serviceMap.charts.error')"
            @retry="series.load"
          />
        </PanelSection>
      </div>
      <div class="flex flex-wrap gap-3">
        <button
          type="button"
          class="link"
          @click="emit('select', { type: 'node', id: edge.source })"
        >
          {{ $t('serviceMap.panel.open', { name: name(edge.source) }) }}
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="link"
          @click="emit('select', { type: 'node', id: edge.target })"
        >
          {{ $t('serviceMap.panel.open', { name: name(edge.target) }) }}
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.lrow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 6px;
  border-radius: 6px;
  text-align: left;
}
.lrow:hover {
  background: var(--surface-2);
}
.lrow:focus-visible,
.link:focus-visible,
.close:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.bg-ok {
  background: var(--ok);
}
.bg-warning {
  background: var(--warning);
}
.bg-critical {
  background: var(--critical);
}
.bg-idle,
.bg-unknown {
  background: var(--text-subtle);
}
.why {
  font-size: 13px;
  color: var(--text-muted);
  background: var(--surface-2);
  border-left-width: 2px;
  padding: 8px 10px;
  border-radius: 0 6px 6px 0;
}
.border-critical {
  border-left-color: var(--critical);
}
.border-warning {
  border-left-color: var(--warning);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--primary);
  font-size: 13px;
}
.close {
  margin-left: auto;
  color: var(--text-muted);
  border-radius: 6px;
  padding: 2px;
}
.close:hover {
  color: var(--text);
}
/* Touch screens: 44 px rows and targets. */
@media (max-width: 1023px) {
  .lrow,
  .link {
    min-height: 44px;
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
  }
}
</style>
